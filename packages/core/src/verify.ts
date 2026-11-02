import { join } from 'node:path'
import { computeBundleDigest, type DigestOptions } from './digest.ts'
import { BundleError } from './errors.ts'
import type { VerifyLevel } from './protocol.ts'
import {
  DIFY_BUNDLE_KIND,
  PI_BUNDLE_KIND,
  parseAgentConfig,
  parseDifyAgentConfig,
  parseManifestText,
  type AgentConfig,
  type AnyBundleManifest,
  type BundleKind,
  type DifyAgentConfig,
  type DifyBundleManifest,
  type ManifestOf,
} from './manifest.ts'
import { parsePiAgentConfig, parsePiSettings, PI_DIGEST_EXCLUDED_DIRECTORIES, type PiAgentConfig, type PiBundleManifest } from './adapters/pi/manifest.ts'
import {
  DEEPAGENTS_BUNDLE_KIND,
  DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORIES,
  DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORY_SUFFIXES,
  type DeepagentsBundleManifest,
} from './adapters/deepagents/manifest.ts'
import { JIUWENSWARM_BUNDLE_KIND, parseJiuwenswarmAgentConfig, type JiuwenswarmAgentConfig, type JiuwenswarmBundleManifest } from './adapters/jiuwenswarm/manifest.ts'
import { pathExists, readMappingFile } from './yaml-file.ts'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export type VerifyAgentConfig = AgentConfig | DifyAgentConfig | PiAgentConfig | JiuwenswarmAgentConfig

export interface VerifyOptions {
  readonly expectDigest?: string
  readonly level?: VerifyLevel
}

export interface VerifyResult<K extends BundleKind = BundleKind, L extends VerifyLevel = 'standard'> {
  readonly manifest: ManifestOf<K>
  /** Present at the standard level; `minimal` skips agent parsing, so it is undefined there. */
  readonly agent: L extends 'minimal' ? VerifyAgentConfig | undefined : VerifyAgentConfig
  readonly digest: string
}

export async function verifyBundle<K extends BundleKind = BundleKind, L extends VerifyLevel = 'standard'>(
  bundleDir: string,
  options: VerifyOptions & { readonly level?: L } = {},
): Promise<VerifyResult<K, L>> {
  const raw = await readMappingFile(join(bundleDir, 'bundle.yaml'), 'bundle file')
  const manifest = await parseManifestText<K>(raw, bundleDir)
  const digest = await computeBundleDigest(bundleDir, digestOptions(manifest as AnyBundleManifest))
  if (options.expectDigest !== undefined) {
    if (!DIGEST_PATTERN.test(options.expectDigest)) {
      throw new BundleError(`expected digest must match sha256:<64 hex chars>, got ${JSON.stringify(options.expectDigest)}`, 'DIGEST_FORMAT_INVALID')
    }
    if (options.expectDigest !== digest) {
      throw new BundleError(`digest mismatch: expected ${options.expectDigest}, got ${digest}`, 'DIGEST_MISMATCH')
    }
  }
  if (options.level === 'minimal') {
    // The runtime level mirrors the type parameter L; the narrow cast keeps the
    // standard-level shape required for existing consumers.
    return { manifest, agent: undefined, digest } as VerifyResult<K, L>
  }
  const agent = await verifyAgentConfig(bundleDir, manifest as AnyBundleManifest)
  if (manifest.kind !== PI_BUNDLE_KIND && manifest.kind !== JIUWENSWARM_BUNDLE_KIND) {
    const lockPath = join(bundleDir, 'dependencies.lock')
    if (!await pathExists(lockPath)) {
      throw new BundleError(`required dependencies.lock is missing: ${lockPath}`, 'POINTER_MISSING')
    }
  }
  return { manifest, agent, digest }
}

/** Per-kind digest scope: Pi bundles exclude `dist/` build output and install-created `.venv`; deepagents bundles exclude langgraph dev state and editable-install metadata. */
export function digestOptions(manifest: AnyBundleManifest): DigestOptions {
  if (manifest.kind === PI_BUNDLE_KIND) return { excludeDirectories: PI_DIGEST_EXCLUDED_DIRECTORIES }
  if (manifest.kind === DEEPAGENTS_BUNDLE_KIND) {
    return {
      excludeDirectories: DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORIES,
      excludeDirectorySuffixes: DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORY_SUFFIXES,
    }
  }
  return {}
}

export function isPiManifest(manifest: AnyBundleManifest): manifest is PiBundleManifest {
  return manifest.kind === PI_BUNDLE_KIND
}

export function isDeepagentsManifest(manifest: AnyBundleManifest): manifest is DeepagentsBundleManifest {
  return manifest.kind === DEEPAGENTS_BUNDLE_KIND
}

export function isDifyManifest(manifest: AnyBundleManifest): manifest is DifyBundleManifest {
  return manifest.kind === DIFY_BUNDLE_KIND
}

export function isJiuwenswarmManifest(manifest: AnyBundleManifest): manifest is JiuwenswarmBundleManifest {
  return manifest.kind === JIUWENSWARM_BUNDLE_KIND
}

async function verifyAgentConfig(
  bundleDir: string,
  manifest: AnyBundleManifest,
): Promise<AgentConfig | DifyAgentConfig | PiAgentConfig | JiuwenswarmAgentConfig> {
  if (manifest.kind === DIFY_BUNDLE_KIND) return await parseDifyAgentConfig(bundleDir)
  if (manifest.kind === JIUWENSWARM_BUNDLE_KIND) return await parseJiuwenswarmAgentConfig(bundleDir)
  if (manifest.kind === PI_BUNDLE_KIND) {
    // The native settings file is part of the contract even when agent.yaml is absent.
    await parsePiSettings(manifest.settings)
    return await parsePiAgentConfig(bundleDir)
  }
  return await parseAgentConfig(bundleDir)
}
