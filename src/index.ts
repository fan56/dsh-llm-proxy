/**
 * dsh-llm-proxy — SYSTEM proxy + LLM traffic-splitting proxy for dsh.
 *
 * Installs a single process-global undici routing dispatcher:
 * - requests whose origin hits an `llmProxy` list entry go through that
 *   entry's proxy (undici ProxyAgent);
 * - everything else goes through a shared EnvHttpProxyAgent, which applies
 *   the startup environment's HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY
 *   semantics (upper- and lowercase);
 * - with no env proxy configured the fallback is a direct connection.
 *
 * Priority: llmProxy hit > SYSTEM (env) > direct.
 *
 * apply() also registers a bundled skill (skills/dsh-llm-proxy/SKILL.md) that
 * carries the plugin's configuration and troubleshooting guide.
 *
 * User configuration arrives exclusively through the `dsh-llm-proxy`
 * settings.yaml namespace (registered via the settings provider's
 * installSection, the same seam harness core plugins use); the bundle entry
 * config is the base layer.
 * Edits to the settings section hot-publish: the router is rebuilt in place,
 * unless the resolved values are unchanged, in which case the rebuild is
 * skipped (the settings attach itself fires one redundant onChange).
 *
 * Environment variables are only read, never written: mutating
 * process.env.HTTP_PROXY in an already-started process has no effect on
 * undici/Node internals and is deliberately avoided.
 *
 * @module @aiwayds/dsh-llm-proxy
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Type-only side-effect import: loads dsh-settings' `declare module
// '@deepseek-ai/cordis'` augmentation, which is what puts `ctx.settings` on
// the Context type. There is no runtime import — the host provides the
// settings service; alpha.3 removed the module-level settingsNamespace(),
// installSettingsSection(), and deepEqualJson() helpers this plugin used to
// import (see SETTINGS_NAMESPACE below, the installSection call in apply(),
// and ./deep-equal.ts for their replacements).
import type {} from '@deepseek-ai/dsh-settings'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import * as undici from 'undici'
import { deepEqualJson } from './deep-equal.ts'
import { createProxyRouterDispatcher, withUndiciErrorListener, type LlmProxyEntry } from './router.ts'

export { matchOrigin } from './match.ts'
export { createProxyRouterDispatcher, resolveRoute, type LlmProxyEntry, type RouteDecision } from './router.ts'

export const name = 'dsh-llm-proxy'

/** Service required by the bundled skill provider. */
export const inject = ['skills']

/**
 * The settings.yaml namespace this plugin owns. dsh feeds user configuration
 * to plugins only through registered settings namespaces; the document
 * section key that reaches this plugin is exactly this string.
 *
 * A plain literal is the supported spelling since dsh-settings
 * 0.1.2-alpha.3: `register`/`installSection` brand-check the namespace at the
 * type level (`SettingsNamespaceInput`) and validate the same pattern at
 * runtime (`parseSettingsNamespace`), replacing the removed
 * `settingsNamespace()` helper.
 */
const SETTINGS_NAMESPACE = 'dsh-llm-proxy'

/** Plugin configuration. */
export interface Config {
  /** Master switch; `false` leaves globals untouched (default `true`). */
  enabled?: boolean
  /**
   * Fallback mode for requests no llmProxy entry matches (default `env`):
   * `env` applies HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY from the
   * startup environment; `off` connects directly.
   */
  systemMode?: 'env' | 'off'
  /** Ordered LLM proxy list; the first entry whose match hits wins. */
  llmProxy?: Array<{ match: string; proxy: string }>
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  systemMode: z.union([z.const('env'), z.const('off')]).default('env'),
  llmProxy: z.array(z.object({
    match: z.string(),
    proxy: z.string(),
  })),
}) as unknown as z<Config>

const CONFIG_KEYS: ReadonlySet<string> = new Set(['enabled', 'systemMode', 'llmProxy'])

/**
 * Mask the userinfo part of a proxy URL ("user:pass@host") so log lines and
 * error messages never carry credentials.
 */
export function redactProxyUrl(proxyUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(proxyUrl)
  } catch {
    // Unparsable input: best-effort masking of a credential-shaped token.
    return proxyUrl.replace(/(^|\/\/|\s)[^\s@/]+@/, '$1***@')
  }
  if (!parsed.username && !parsed.password) return proxyUrl
  const auth = parsed.password ? '***:***@' : '***@'
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return `${parsed.protocol}//${auth}${parsed.host}${path}${parsed.search}${parsed.hash}`
}

function validateProxyUrl(proxy: string, index: number): void {
  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    throw new Error(`dsh-llm-proxy: config.llmProxy[${index}].proxy is not a valid URL: "${redactProxyUrl(proxy)}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `dsh-llm-proxy: config.llmProxy[${index}].proxy must use http:// or https:// `
      + `(undici ProxyAgent does not support ${parsed.protocol}//; SOCKS is not supported)`,
    )
  }
}

/** Fully resolved plugin policy captured at apply time. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly systemMode: 'env' | 'off'
  readonly llmProxy: readonly LlmProxyEntry[]
}

/**
 * Validate, default, and freeze the plugin configuration.
 * @param config - optional plugin configuration; omission selects defaults.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-llm-proxy: config: unknown key "${key}"`)
    }
  }
  const enabled = config?.enabled ?? true
  const systemMode = config?.systemMode ?? 'env'
  if (systemMode !== 'env' && systemMode !== 'off') {
    throw new Error('dsh-llm-proxy: config.systemMode must be "env" or "off"')
  }
  const entries = (config?.llmProxy ?? []).map((entry, index): LlmProxyEntry => {
    if (typeof entry?.match !== 'string' || !entry.match.trim()) {
      throw new Error(`dsh-llm-proxy: config.llmProxy[${index}].match must be a non-empty string`)
    }
    if (typeof entry?.proxy !== 'string' || !entry.proxy.trim()) {
      throw new Error(`dsh-llm-proxy: config.llmProxy[${index}].proxy must be a non-empty string`)
    }
    validateProxyUrl(entry.proxy, index)
    return { match: entry.match.trim(), proxy: entry.proxy.trim() }
  })
  return Object.freeze({ enabled, systemMode, llmProxy: Object.freeze(entries) })
}

// Node 26's bundled fetch can consume compressed responses through npm
// undici's dispatcher without decompressing them when the two implementations
// skew. Takeover keeps fetch on the same undici copy as the dispatcher; a
// deliberate override by someone else must survive.
//
// Reload windows are the hazard. Cordis Group.update creates the new plugin
// instance BEFORE removing the old one, and vendor HMR re-imports the module
// before disposing it — so "new apply" can interleave with "old dispose", and
// fresh module copies lose module-level bookkeeping. All ownership state
// therefore lives in a Symbol.for-keyed slot shared across every module copy:
// each live install records one layer; dispose pops its own layer and hands
// the globals back to the nearest remaining layer (or the pristine values).
interface GlobalsState {
  /** Pristine dispatcher/fetch, captured once before the first-ever install. */
  originalDispatcher: undici.Dispatcher | undefined
  originalFetch: (typeof globalThis.fetch) | undefined
  /** Live layers, bottom-first; each records what it put on the globals. */
  layers: Array<{ router: undici.Dispatcher; fetch?: typeof globalThis.fetch }>
}

const GLOBALS_KEY = Symbol.for('dsh-llm-proxy.global-state')

function globalsState(): GlobalsState {
  const host = globalThis as Record<symbol, unknown>
  return (host[GLOBALS_KEY] ??= {
    originalDispatcher: undefined,
    originalFetch: undefined,
    layers: [],
  }) as GlobalsState
}

/** Undo handle for one {@link takeoverGlobals} call. */
interface GlobalLayer {
  restore(): void
}

/**
 * Put `router` — and, when fetch is still pristine or still ours, npm
 * undici's fetch — on top of the process globals, recording the layer so
 * dispose can unwind exactly one level even under interleaved reloads.
 */
function takeoverGlobals(router: undici.Dispatcher): GlobalLayer {
  const state = globalsState()
  state.originalDispatcher ??= undici.getGlobalDispatcher()
  state.originalFetch ??= globalThis.fetch

  // Take over fetch only when it is still pristine or still owned by the top
  // layer; a deliberate override by someone else must survive untouched.
  const under = state.layers[state.layers.length - 1]
  let fetch: (typeof globalThis.fetch) | undefined
  if (globalThis.fetch === (under?.fetch ?? state.originalFetch)) {
    undici.install?.()
    fetch = globalThis.fetch
  }

  const layer = { router, fetch }
  state.layers.push(layer)
  undici.setGlobalDispatcher(router)

  return {
    restore(): void {
      const index = state.layers.lastIndexOf(layer)
      if (index !== -1) state.layers.splice(index, 1)
      // Restore only what this instance still owns: after an interleaved
      // reload a newer router may sit on top, and clobbering it would break
      // that one. Unwind hands control to the nearest live layer below, or
      // back to the pristine values once no layer remains.
      if (undici.getGlobalDispatcher() === router) {
        const above = state.layers[state.layers.length - 1]
        undici.setGlobalDispatcher(above?.router ?? state.originalDispatcher!)
      }
      if (fetch !== undefined && globalThis.fetch === fetch) {
        const above = [...state.layers].reverse().find((candidate) => candidate.fetch !== undefined)
        globalThis.fetch = above?.fetch ?? state.originalFetch!
      }
    },
  }
}

/** Injectable seams for tests; production defaults build real undici agents. */
export interface ApplyInternals {
  /**
   * Creates the shared system fallback; the default builds an
   * EnvHttpProxyAgent for `env`, a direct Agent for `off`.
   */
  createSystemDispatcher?: (systemMode: 'env' | 'off') => undici.Dispatcher
  /** Creates the per-proxy dispatcher; defaults to ProxyAgent. Overridable in tests. */
  createProxyDispatcher?: (proxyUrl: string) => undici.Dispatcher
}

/** One live router installation owned by the plugin context. */
interface ActiveLayer {
  readonly router: undici.Dispatcher
  readonly globals: GlobalLayer
}

// --- Bundled skill -----------------------------------------------------------

/** Provider name under `ctx.skills`; doubles as the skill name. */
const SKILL_PROVIDER_NAME = 'dsh-llm-proxy'

/** Packaged skill body; `../skills/` resolves to the package root from both lib/ and src/. */
const SKILL_BODY_URL = new URL('../skills/dsh-llm-proxy/SKILL.md', import.meta.url)

/** Resource base served with the skill so its relative links resolve. */
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/dsh-llm-proxy/', import.meta.url)),
} as const

const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** Routing description; must stay identical to the SKILL.md frontmatter (asserted in tests). */
const SKILL_DESCRIPTION = 'dsh 出站代理 / LLM 分流插件（@aiwayds/dsh-llm-proxy）使用指南。凡给 dsh 插件配置 HTTP 代理、LLM 出站分流，或排查代理网络问题时先读本指南：settings.yaml 顶层 `dsh-llm-proxy:` 段（enabled/systemMode/llmProxy）、llmProxy match 规则、代理 407、CONNECT 挂起、socks5 报错（SOCKS 不支持）、NODE_USE_ENV_PROXY 等价替代。触发词：dsh 代理、HTTP 代理、LLM 分流、llmProxy、llm-proxy、407、CONNECT 挂起、SOCKS、HTTPS_PROXY、NO_PROXY、出站代理、NODE_USE_ENV_PROXY。'

const SKILL_CANDIDATE: SkillCandidate = {
  name: SKILL_PROVIDER_NAME,
  description: SKILL_DESCRIPTION,
  invocation: SKILL_INVOCATION,
  provider: SKILL_PROVIDER_NAME,
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const skillProvider: SkillProvider = {
  name: SKILL_PROVIDER_NAME,
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: stripFrontmatter(await readFile(SKILL_BODY_URL, 'utf8')),
    }
  },
}

/**
 * Strip a leading YAML frontmatter block (`---` / body / `---`) from a skill
 * markdown file. `SkillDefinition.content` must be the instruction body after
 * metadata removal — the same shape the filesystem provider serves — so the
 * bundled SKILL.md, which keeps its frontmatter for the GitHub/manual install
 * paths, has the block removed when served through {@link skillProvider.get}.
 * Tolerant by design: input that does not open with a `---` line, or whose
 * frontmatter block is never closed, is returned unchanged. Mirrors the
 * delimiter semantics of the upstream skill-filesystem provider.
 */
export function stripFrontmatter(raw: string): string {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return raw
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1).trim()
    }
    if (nextNewline < 0) return raw
    lineStart = nextNewline + 1
  }
  return raw
}

/**
 * Install the global routing dispatcher, wire the `dsh-llm-proxy` settings
 * namespace, register the bundled skill provider, and register teardown.
 * @param ctx - plugin context owning the dispose effect.
 * @param config - composition entry config; the base layer under the
 *   settings.yaml `dsh-llm-proxy` section.
 * @param internals - injectable dispatcher factories for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: ApplyInternals = {}): void {
  // `inject = ['skills']` guarantees the service exists on every real host;
  // register unconditionally so a missing service fails loud instead of
  // silently dropping the bundled skill.
  ctx.skills.registerProvider(() => skillProvider)
  // Current authoritative config source: the entry until a settings scope
  // layers the user's settings.yaml section on top (and back to the entry if
  // the settings provider detaches). The seam hands over a thunk so every
  // rejudge reads the live layered value instead of a stale snapshot.
  let getSource: () => Config = () => config
  let active: ActiveLayer | undefined
  let activePolicy: ResolvedConfig | undefined
  let effectRegistered = false

  function installLayer(policy: ResolvedConfig): ActiveLayer {
    const systemDispatcher =
      internals.createSystemDispatcher?.(policy.systemMode)
      ?? withUndiciErrorListener(
        policy.systemMode === 'env' ? new undici.EnvHttpProxyAgent() : new undici.Agent(),
      )
    const router = createProxyRouterDispatcher(policy.llmProxy, {
      systemDispatcher,
      proxyFactory: internals.createProxyDispatcher
        ?? ((proxyUrl) => withUndiciErrorListener(new undici.ProxyAgent(proxyUrl))),
    })
    return { router, globals: takeoverGlobals(router) }
  }

  function teardownLayer(layer: ActiveLayer): void {
    layer.globals.restore()
    // Non-blocking teardown: close() waits for in-flight requests to drain,
    // which would stall hot reloads behind long LLM streams. The globals are
    // already handed back above, so no new request reaches this router; let
    // it finish draining and closing in the background instead of awaiting.
    void layer.router.close().catch(() => {})
  }

  const ensureDisposeEffect = (): void => {
    if (effectRegistered) return
    effectRegistered = true
    ctx.effect(() => async () => {
      const current = active
      active = undefined
      if (current) teardownLayer(current)
    }, 'dsh-llm-proxy: restore global dispatcher/fetch and close proxies')
  }

  const rejudge = (failFast: boolean): void => {
    let policy: ResolvedConfig
    try {
      policy = resolveConfig(getSource())
    } catch (error) {
      if (failFast) throw error
      ctx.logger?.error(
        'dsh-llm-proxy: ignoring invalid settings update, keeping current routing: %s',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    // Attaching the settings scope fires onChange unconditionally, even when
    // the layered section resolves to the same values as the entry base
    // layer; rebuilding then would tear down and reinstall an identical
    // router for nothing. Skip when no resolved value changed.
    if (activePolicy !== undefined && deepEqualJson(policy, activePolicy)) return
    if (!policy.enabled) {
      const current = active
      active = undefined
      activePolicy = policy
      if (current) teardownLayer(current)
      return
    }
    let next: ActiveLayer
    try {
      next = installLayer(policy)
    } catch (error) {
      if (failFast) throw error
      ctx.logger?.error(
        'dsh-llm-proxy: failed to rebuild routing, keeping current routing: %o',
        error,
      )
      return
    }
    const previous = active
    active = next
    activePolicy = policy
    ensureDisposeEffect()
    if (previous) teardownLayer(previous)
  }

  // Start immediately with the entry config so the plugin works even on hosts
  // that never mount a settings service; when the service appears, the
  // layered section takes over and subsequent edits hot-publish here.
  rejudge(true)
  // Optional-settings consumer wiring. The rc.2 module-level
  // installSettingsSection() helper was removed in dsh-settings
  // 0.1.2-alpha.3; the attach / detach-fallback / watch body moved behind the
  // provider as SettingsProvider.installSection (identical semantics — the
  // entry config stays the fallback source when the provider detaches).
  // ctx.inject keeps the whole wiring dormant on hosts that never mount a
  // settings service.
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => {
        getSource = current
      },
      onChange: () => rejudge(false),
    })
  })
}
