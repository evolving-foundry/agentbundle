import type { BundleErrorCode } from './errors.ts'

export type { BundleErrorCode }

/** Reference shape shared by the TS SDK, the CLI `--json` output, and the future Python bridge. */
export interface BundleRef {
  /** bundle.yaml kind (for example `dsh-agent-bundle`). */
  readonly kind: string
  /** Bundle source or artifact directory, as accessible to the receiver. */
  readonly uri: string
  /** `sha256:<hex>` content digest; optional because a ref may defer digest checks. */
  readonly digest?: string
}

/**
 * Check depth. `minimal` covers the manifest (including plugin package shape)
 * plus the digest; `standard` additionally parses agent.yaml and requires the
 * root dependencies.lock. `install` runs the standard checks, then a fresh
 * isolated install and uninstall. `verifyBundle` itself only implements
 * `minimal` and `standard`.
 */
export type VerifyLevel = 'minimal' | 'standard' | 'install'

/** Consumer-facing description of a bundle (inspect output; no side effects). */
export interface BundleInfo {
  readonly ref: BundleRef
  readonly name: string
  readonly schemaVersion: number
  readonly harnessVersion: string
  /** Declared native entry pointer (dify workflow DSL, deepagents langgraph.json). */
  readonly entry?: string
  /** Declared plugin paths in declared order (dsh / hermes / deepagents). */
  readonly declaredPlugins: readonly string[]
  readonly model?: { readonly provider: string; readonly model: string }
  /** Whether the root dependencies.lock exists (required for non-pi kinds). */
  readonly lockfile: boolean
  /** pi only: global instruction file. */
  readonly instructions?: string
  /** pi only: skills root. */
  readonly skills?: string
  /** pi only: declared extension paths in declared order. */
  readonly extensions?: readonly string[]
}

/** Immutable artifact produced by pack, verifiable with `verify --expect-digest`. */
export interface PackResult {
  readonly ref: BundleRef
  readonly artifactDir: string
  readonly fileCount: number
  /** True when an artifact with the same digest already existed and was reused. */
  readonly reused: boolean
}
