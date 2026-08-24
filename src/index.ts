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
 * Environment variables are only read, never written: mutating
 * process.env.HTTP_PROXY in an already-started process has no effect on
 * undici/Node internals and is deliberately avoided.
 *
 * @module @aiwayds/dsh-llm-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as undici from 'undici'
import { createProxyRouterDispatcher, withUndiciErrorListener, type LlmProxyEntry } from './router.ts'

export { matchOrigin } from './match.ts'
export { createProxyRouterDispatcher, resolveRoute, type LlmProxyEntry, type RouteDecision } from './router.ts'

export const name = 'dsh-llm-proxy'

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

// Node 26's bundled fetch can consume compressed responses through npm
// undici's dispatcher without decompressing them when the two implementations
// skew. install() keeps fetch on the same undici copy as the dispatcher; the
// guards ensure we only replace fetch that is still pristine (or still ours).
const originalGlobalFetch = globalThis.fetch
let installedGlobalFetch: typeof globalThis.fetch | undefined

function validateProxyUrl(proxy: string, index: number): void {
  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    throw new Error(`dsh-llm-proxy: config.llmProxy[${index}].proxy is not a valid URL: "${proxy}"`)
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

/**
 * Install the global routing dispatcher and register its teardown.
 * @param ctx - plugin context owning the dispose effect.
 * @param config - plugin configuration; omission selects defaults.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const policy = resolveConfig(config)
  if (!policy.enabled) return

  const originalGlobalDispatcher = undici.getGlobalDispatcher()

  // The shared fallback: EnvHttpProxyAgent reads the startup environment
  // (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY, upper or lower case)
  // itself; "off" means everything unmatched connects directly.
  const systemDispatcher =
    policy.systemMode === 'env'
      ? withUndiciErrorListener(new undici.EnvHttpProxyAgent())
      : withUndiciErrorListener(new undici.Agent())

  const router = createProxyRouterDispatcher(policy.llmProxy, {
    systemDispatcher,
    proxyFactory: (proxyUrl) => withUndiciErrorListener(new undici.ProxyAgent(proxyUrl)),
  })

  undici.setGlobalDispatcher(router)
  // Only replace fetch if it is untouched (or still our own earlier install);
  // a deliberate override by someone else must survive.
  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch
  if (shouldInstallGlobals) {
    undici.install?.()
    installedGlobalFetch = globalThis.fetch
  }

  ctx.effect(() => async () => {
    // Restore only layers this instance still owns: after HMR reload another
    // router may already sit on top, and clobbering it would break that one.
    if (undici.getGlobalDispatcher() === router) {
      undici.setGlobalDispatcher(originalGlobalDispatcher)
    }
    if (
      installedGlobalFetch !== undefined
      && globalThis.fetch === installedGlobalFetch
      && installedGlobalFetch !== originalGlobalFetch
    ) {
      globalThis.fetch = originalGlobalFetch
      installedGlobalFetch = undefined
    }
    // The router owns the fallback and every lazily created ProxyAgent;
    // closing it tears down all of them.
    await Promise.allSettled([router.close()])
  }, 'dsh-llm-proxy: restore global dispatcher/fetch and close proxies')
}
