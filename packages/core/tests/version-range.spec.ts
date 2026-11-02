import { describe, expect, it } from 'vitest'
import { parseVersionBound, parseVersionTriplet, versionGateFailure } from '../src/version-range.ts'

describe('version range parsing and gating', () => {
  it('parses a runtime version triple from a version banner', () => {
    expect(parseVersionTriplet('Hermes Agent v0.21.3 (2026.9.14) · Python: 3.11.15')).toEqual({ major: 0, minor: 21, patch: 3 })
    expect(parseVersionTriplet('0.22.0')).toEqual({ major: 0, minor: 22, patch: 0 })
    expect(parseVersionTriplet('no version here')).toBeUndefined()
  })

  it('parses two-component range bounds with a padded patch', () => {
    expect(parseVersionBound('0.22')).toEqual({ major: 0, minor: 22, patch: 0 })
    expect(parseVersionBound('0.22.5')).toEqual({ major: 0, minor: 22, patch: 5 })
    expect(parseVersionBound('1')).toEqual({ major: 1, minor: 0, patch: 0 })
  })

  it('accepts in-range versions for the canonical ">=0.21.0 <0.22" range', () => {
    const range = '>=0.21.0 <0.22'
    expect(versionGateFailure({ major: 0, minor: 21, patch: 0 }, range)).toBeUndefined()
    expect(versionGateFailure({ major: 0, minor: 21, patch: 3 }, range)).toBeUndefined()
    expect(versionGateFailure({ major: 0, minor: 21, patch: 9 }, range)).toBeUndefined()
  })

  it('rejects versions below the lower bound', () => {
    expect(versionGateFailure({ major: 0, minor: 20, patch: 9 }, '>=0.21.0 <0.22')).toBe('older')
  })

  it('rejects versions at or above the two-component upper bound', () => {
    // "<0.22" means "<0.22.0": 0.22.0 and later must be rejected.
    expect(versionGateFailure({ major: 0, minor: 22, patch: 0 }, '>=0.21.0 <0.22')).toBe('newer')
    expect(versionGateFailure({ major: 0, minor: 22, patch: 5 }, '>=0.21.0 <0.22')).toBe('newer')
  })

  it('also honours a three-component upper bound', () => {
    expect(versionGateFailure({ major: 0, minor: 21, patch: 9 }, '>=0.21.0 <0.22.0')).toBeUndefined()
    expect(versionGateFailure({ major: 0, minor: 22, patch: 0 }, '>=0.21.0 <0.22.0')).toBe('newer')
  })
})
