import { BundleError } from '../../errors.ts'

/**
 * `harness.version` grammar check, owned by the Pi adapter.
 *
 * A pi bundle declares a harness compat range (`">=0.1 <0.2"`). Pi does not
 * report the Pi profile version, so nothing here decides
 * compatibility: this only answers "is this declaration readable at all?" — a
 * range nobody can parse can never be answered later. Unreadable input is
 * reported with the offending token instead of being accepted silently.
 *
 * Supported shape: whitespace-separated comparators (`>=`, `>`, `<=`, `<`, `=`),
 * bare versions, `^`, `~`, and `x`/`X`/`*` wildcards, optionally `||`-grouped.
 */
const RANGE_PATTERN = /^(?:(?:>=|<=|>|<|=|\^|~)?[vV]?\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|\d+\.(?:[xX*])(?:\.(?:[xX*]|\d+))?)$/
const WILDCARD_TOKEN_PATTERN = /^(?:>=|<=|>|<|=|\^|~)?\d+(?:\.(?:\d+|[xX*])){0,2}$/

export function assertVersionRange(range: string): void {
  const tokens = range.split('||').flatMap(group => group.trim().split(/\s+/)).filter(token => token !== '')
  if (tokens.length === 0) {
    throw new BundleError(`harness.version range is empty: ${JSON.stringify(range)} (expected a range such as ">=0.1 <0.2")`, 'MANIFEST_INVALID')
  }
  for (const token of tokens) {
    if (RANGE_PATTERN.test(token)) continue
    // A wildcard needs a numeric major (`1.x` is a range; `*.x` is not).
    if (/[xX*]/.test(token) && !WILDCARD_TOKEN_PATTERN.test(token)) {
      throw new BundleError(`harness.version range is not supported: ${JSON.stringify(token)} (a wildcard needs at least a major version, e.g. "1.x")`, 'MANIFEST_INVALID')
    }
    throw new BundleError(`harness.version range is not supported: ${JSON.stringify(token)} (expected comparators such as ">=1.0 <2.0", "^1.2.3", or "1.x")`, 'MANIFEST_INVALID')
  }
}
