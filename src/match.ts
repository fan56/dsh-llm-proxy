/**
 * Origin matcher for the LLM proxy routing list.
 *
 * A match pattern is one of:
 * - a full origin ("https://api.deepseek.org") — case-insensitive exact match
 *   against the request origin;
 * - a host authority ("api.deepseek.org", "api.deepseek.org:8443") — matches
 *   the host exactly, or with a leading `*.` wildcard also any subdomain and
 *   the bare domain itself ("*.volces.com" matches "volces.com" and
 *   "a.volces.com"). An explicit port in the pattern must equal the request
 *   origin's port (scheme defaults count: https=443, http=80).
 *
 * All comparisons are lowercase; matching is purely lexical — no DNS, no I/O.
 */

const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ['https:', '443'],
  ['http:', '80'],
])

interface AuthorityParts {
  readonly host: string
  readonly port: string | undefined
}

/** Split "host[:port]" into host and an optional numeric port. */
function splitAuthority(authority: string): AuthorityParts {
  const colon = authority.lastIndexOf(':')
  if (colon === -1) return { host: authority, port: undefined }
  const port = authority.slice(colon + 1)
  if (/^\d+$/.test(port)) return { host: authority.slice(0, colon), port }
  // Not a numeric suffix (e.g. IPv6 literals); treat the whole token as host.
  return { host: authority, port: undefined }
}

/** Wildcard-aware host comparison: "*.base" matches base and subdomains. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return base.length > 0 && (host === base || host.endsWith(`.${base}`))
  }
  return host === pattern
}

/**
 * Whether a request origin hits a routing-list match pattern.
 * @param match - pattern from the llmProxy list entry.
 * @param origin - request origin, e.g. "https://api.example.com" or
 *   "https://api.example.com:8443"; a bare host[:port] is tolerated.
 */
export function matchOrigin(match: string, origin: string): boolean {
  const normalizedMatch = match.trim().toLowerCase()
  if (!normalizedMatch) return false

  if (normalizedMatch.includes('://')) {
    const normalizedOrigin = origin.trim().toLowerCase()
    return normalizedOrigin === normalizedMatch
  }

  let parsed: URL
  try {
    parsed = new URL(origin.includes('://') ? origin.trim() : `http://${origin.trim()}`)
  } catch {
    return false
  }
  const { host: patternHost, port: patternPort } = splitAuthority(normalizedMatch)
  if (!patternHost) return false
  if (patternPort !== undefined) {
    const actualPort = parsed.port || DEFAULT_PORTS.get(parsed.protocol) || ''
    if (patternPort !== actualPort) return false
  }
  return hostMatches(patternHost, parsed.hostname)
}
