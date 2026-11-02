import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { computeBundleDigest, listBundleDigestPaths, type DigestOptions } from './digest.ts'
import { BundleError } from './errors.ts'
import type { BundleRef, PackResult } from './protocol.ts'
import { digestOptions, verifyBundle } from './verify.ts'

export interface PackOptions {
  /** Bundle source directory (verified at the standard level before packing). */
  readonly sourceDir: string
  /** Directory receiving the immutable `bundle-<name>-<digest8>` artifact (created if missing). */
  readonly outputDir: string
}

/**
 * Materialize an immutable, transportable copy of a verified bundle. The
 * artifact mirrors exactly the files the digest covers (excluded directories
 * and empty directories stay out), so `verify --expect-digest` on the artifact
 * yields the source digest. Placement is atomic: files land in a dot-prefixed
 * staging directory that is renamed into place; any failure removes the staging
 * directory, so a half-packed artifact can never appear under the final name.
 */
export async function packBundle(options: PackOptions): Promise<PackResult> {
  const sourceDir = resolve(options.sourceDir)
  const verified = await verifyBundle(sourceDir)
  const manifest = verified.manifest
  const digest = verified.digest
  const exclusions = digestOptions(manifest)
  const files = await listBundleDigestPaths(sourceDir, exclusions)
  const outputDir = resolve(options.outputDir)
  const artifactDir = join(outputDir, `bundle-${manifest.name}-${digest.slice(DIGEST_PREFIX_LENGTH, DIGEST_PREFIX_LENGTH + 8)}`)

  const existingDigest = await digestOf(artifactDir, exclusions)
  if (existingDigest === digest) {
    return { ref: bundleRef(manifest.kind, artifactDir, digest), artifactDir, fileCount: files.length, reused: true }
  }
  if (existingDigest !== undefined) {
    throw new BundleError(
      `pack artifact ${artifactDir} already exists with a different digest (${existingDigest}); immutable artifacts are never overwritten, remove it to pack a new snapshot`,
      'INSTALL_CONFLICT',
    )
  }

  const stagingDir = join(outputDir, `.pack-${manifest.name}-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(stagingDir, { recursive: true })
    for (const rel of files) {
      const target = join(stagingDir, rel)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(sourceDir, rel), target)
    }
    const stagedDigest = await computeBundleDigest(stagingDir, exclusions)
    if (stagedDigest !== digest) {
      throw new BundleError(
        `packed staging digest ${stagedDigest} does not match the source digest ${digest}; the source changed while packing`,
        'DIGEST_MISMATCH',
      )
    }
    try {
      await rename(stagingDir, artifactDir)
    } catch {
      // Lost a concurrent rename race: the winner is either identical (reuse) or a conflict.
      const winnerDigest = await digestOf(artifactDir, exclusions)
      if (winnerDigest === digest) {
        return { ref: bundleRef(manifest.kind, artifactDir, digest), artifactDir, fileCount: files.length, reused: true }
      }
      throw new BundleError(
        `pack artifact ${artifactDir} was created concurrently with a different digest (${winnerDigest ?? 'unreadable'})`,
        'INSTALL_CONFLICT',
      )
    }
  } finally {
    // After a successful rename the staging path no longer exists; force makes this a no-op.
    await rm(stagingDir, { recursive: true, force: true })
  }
  return { ref: bundleRef(manifest.kind, artifactDir, digest), artifactDir, fileCount: files.length, reused: false }
}

const DIGEST_PREFIX_LENGTH = 'sha256:'.length

function bundleRef(kind: string, uri: string, digest: string): BundleRef {
  return { kind, uri, digest }
}

async function digestOf(dir: string, exclusions: DigestOptions): Promise<string | undefined> {
  return await computeBundleDigest(dir, exclusions).catch(() => undefined)
}
