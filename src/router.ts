/**
 * The routing dispatcher: forwards every request to the first llmProxy entry
 * whose match pattern hits the request origin, or to a shared fallback
 * (system) dispatcher otherwise. Priority is decided here; the fallback
 * itself — an EnvHttpProxyAgent for env semantics, or a direct Agent — is
 * supplied by the caller.
 */

import { EventEmitter } from 'node:events'
import * as undici from 'undici'
import { matchOrigin } from './match.ts'

/** One configured routing entry: origin pattern plus its proxy URL. */
export interface LlmProxyEntry {
  readonly match: string
  readonly proxy: string
}

/**
 * Route decision for an origin: either the first matching llmProxy entry, or
 * the shared system fallback.
 */
export type RouteDecision =
  | { readonly kind: 'llm'; readonly index: number; readonly proxyUrl: string }
  | { readonly kind: 'system' }

const ignoreUndiciDispatcherError = (_error: unknown): void => {}

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this
// listener only prevents EventEmitter's unhandled "error" special case from
// crashing the host process. Applied to every dispatcher this plugin creates.
export function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, 'error', ignoreUndiciDispatcherError)
  }
  return dispatcher
}

/**
 * Which route an origin takes under the given entry list.
 * @param entries - ordered llmProxy list; first hit wins.
 * @param origin - request origin string.
 */
export function resolveRoute(
  entries: readonly LlmProxyEntry[],
  origin: string,
): RouteDecision {
  const index = entries.findIndex((entry) => matchOrigin(entry.match, origin))
  if (index === -1) return { kind: 'system' }
  return { kind: 'llm', index, proxyUrl: entries[index].proxy }
}

function originToString(origin: unknown): string {
  if (origin instanceof URL) return origin.origin
  if (typeof origin === 'string') return origin
  return ''
}

/** Injectable seams for tests and custom construction. */
export interface RouterDeps {
  /** Fallback for requests no llmProxy entry matches. Defaults to a direct Agent. */
  systemDispatcher?: undici.Dispatcher
  /** Creates the per-proxy dispatcher; defaults to ProxyAgent. Overridable in tests. */
  proxyFactory?: (proxyUrl: string) => undici.Dispatcher
}

class ProxyRouterDispatcher extends undici.Dispatcher {
  readonly #entries: readonly LlmProxyEntry[]
  readonly #systemDispatcher: undici.Dispatcher
  readonly #proxyFactory: (proxyUrl: string) => undici.Dispatcher
  readonly #proxies = new Map<string, undici.Dispatcher>()

  constructor(entries: readonly LlmProxyEntry[], deps: RouterDeps) {
    super()
    this.#entries = entries
    this.#systemDispatcher = deps.systemDispatcher ?? withUndiciErrorListener(new undici.Agent())
    this.#proxyFactory = deps.proxyFactory ?? ((proxyUrl) =>
      withUndiciErrorListener(new undici.ProxyAgent(proxyUrl)))
  }

  dispatch(options: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
    const decision = resolveRoute(this.#entries, originToString(options.origin))
    const target =
      decision.kind === 'llm'
        ? this.#proxyFor(decision.proxyUrl)
        : this.#systemDispatcher
    return target.dispatch(options, handler)
  }

  #proxyFor(proxyUrl: string): undici.Dispatcher {
    let proxy = this.#proxies.get(proxyUrl)
    if (!proxy) {
      proxy = this.#proxyFactory(proxyUrl)
      this.#proxies.set(proxyUrl, proxy)
    }
    return proxy
  }

  /** All dispatchers owned by this router, including the system fallback. */
  #owned(): undici.Dispatcher[] {
    return [this.#systemDispatcher, ...this.#proxies.values()]
  }

  async close(): Promise<void> {
    await Promise.all(this.#owned().map((dispatcher) => dispatcher.close()))
  }

  async destroy(): Promise<void> {
    await Promise.all(this.#owned().map((dispatcher) => dispatcher.destroy()))
  }
}

/**
 * Create the process-global routing dispatcher.
 * @param entries - ordered llmProxy list; first hit wins.
 * @param deps - optional injectable system dispatcher / proxy factory.
 */
export function createProxyRouterDispatcher(
  entries: readonly LlmProxyEntry[],
  deps: RouterDeps = {},
): undici.Dispatcher {
  return new ProxyRouterDispatcher(entries, deps)
}
