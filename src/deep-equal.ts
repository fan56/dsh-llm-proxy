/**
 * Deep equality over JSON-compatible data (objects, arrays, primitives).
 *
 * Localized copy of `deepEqualJson` from `@deepseek-ai/dsh-settings@0.1.1-rc.2`
 * (`lib/index.js`): dsh-settings 0.1.2-alpha.3 removed the module-level export,
 * relocating the identical implementation into `@deepseek-ai/dsh-util-values`,
 * which is not a declared dependency of this plugin. The relation is unchanged
 * between the two host versions — structural equality over JSON data, arrays
 * compared element-wise, objects compared as key sets with recursively equal
 * values, everything else by `Object.is`-style identity — so this copy is a
 * drop-in replacement, not a behavioral fork.
 *
 * Used to skip a router rebuild when a settings update resolves to the same
 * policy as the live one.
 *
 * @module @aiwayds/dsh-llm-proxy/deep-equal
 */

/**
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether the two values are structurally equal.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}
