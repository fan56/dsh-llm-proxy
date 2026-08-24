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
 * Hostnames are normalized the way WHATWG URL parsing normalizes request
 * origins: lowercase ASCII with IDN labels converted to punycode, so a
 * pattern and an origin written in either the unicode or the xn-- form of
 * the same domain compare equal.
 */

const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ['https:', '443'],
  ['http:', '80'],
])

/**
 * Canonical origin of a full-origin URL: lowercase scheme/host with IDN
 * labels punycoded; `undefined` when the value does not parse.
 */
function canonicalOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * Normalize a bare hostname (no port, no scheme) the way WHATWG URL parsing
 * would for a request origin: lowercase ASCII, IDN labels to punycode.
 * Falls back to plain lowercasing when the value cannot be parsed.
 */
function normalizeHost(host: string): string {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return host.toLowerCase()
  }
}

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
  const trimmedOrigin = origin.trim()

  if (normalizedMatch.includes('://')) {
    // Full-origin form: compare canonical origins, so scheme/host casing and
    // punycode vs unicode IDN spellings do not affect the outcome.
    const patternOrigin = canonicalOrigin(normalizedMatch)
    return patternOrigin !== undefined && patternOrigin === canonicalOrigin(trimmedOrigin)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmedOrigin.includes('://') ? trimmedOrigin : `http://${trimmedOrigin}`)
  } catch {
    return false
  }
  const { host: patternHost, port: patternPort } = splitAuthority(normalizedMatch)
  if (!patternHost) return false
  if (patternPort !== undefined) {
    const actualPort = parsed.port || DEFAULT_PORTS.get(parsed.protocol) || ''
    if (patternPort !== actualPort) return false
  }
  // parsed.hostname is already punycode-normalized by URL parsing; normalize
  // the pattern host the same way so both sides compare symmetrically.
  return hostMatches(normalizeHost(patternHost), parsed.hostname)
}
