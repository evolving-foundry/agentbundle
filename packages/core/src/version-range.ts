/** Ordered numeric version triple used for compatibility-gate comparisons. */
export interface VersionTriplet {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** Extract the first `major.minor.patch` triple found anywhere in the text (e.g. a runtime `--version` banner). */
export function parseVersionTriplet(text: string): VersionTriplet | undefined {
  const match = /([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(text)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Parse a range bound such as `"0.22"` or `"0.22.0"`. A missing patch is padded
 * to 0, matching the manifest's canonical two-component upper bound (`"<0.22"`
 * means `"<0.22.0"`).
 */
export function parseVersionBound(text: string): VersionTriplet | undefined {
  const match = /([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/.exec(text)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) }
}

export function compareVersion(a: VersionTriplet, b: VersionTriplet): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/** Why a runtime version is rejected by a `">=x.y[.z] <a.b[.c]"` range. */
export type VersionGateFailure = 'older' | 'newer'

/** Decide whether `actual` falls inside `"&gt;=x.y.z &lt;a.b.c"`; `undefined` means in-range. */
export function versionGateFailure(actual: VersionTriplet, range: string): VersionGateFailure | undefined {
  // Bounds accept two- or three-component versions: the manifest's canonical upper
  // bound is "<0.22" (= "<0.22.0") rather than a fully-qualified "<0.22.0".
  const lower = /(?:^|\s)>=([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(range)
  const upper = /(?:^|\s)<([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(range)
  if (lower !== null) {
    const bound = parseVersionBound(lower[1]!)
    if (bound !== undefined && compareVersion(actual, bound) < 0) return 'older'
  }
  if (upper !== null) {
    const bound = parseVersionBound(upper[1]!)
    if (bound !== undefined && compareVersion(actual, bound) >= 0) return 'newer'
  }
  return undefined
}
