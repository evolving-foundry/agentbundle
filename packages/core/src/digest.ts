import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { BundleError } from './errors.ts'

const DIGEST_EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', '__pycache__'])

export interface DigestOptions {
  /**
   * Extra directory names excluded on top of `node_modules` and `.git`. Used for
   * harness-specific build output that is not part of the candidate snapshot
   * (for example Pi bundles exclude `dist`).
   */
  readonly excludeDirectories?: readonly string[]
  /**
   * Directory-name suffixes excluded the same way — for runtime-state
   * directories whose exact name varies (deepagents editable installs write
   * `<package>.egg-info/` into the bundle root).
   */
  readonly excludeDirectorySuffixes?: readonly string[]
}

export async function computeBundleDigest(bundleDir: string, options: DigestOptions = {}): Promise<string> {
  let root: string
  try {
    root = await realpath(bundleDir)
  } catch {
    throw new BundleError(`bundle directory does not exist: ${bundleDir}`, 'POINTER_MISSING')
  }
  const excluded = mergeExcluded(options)
  const hash = createHash('sha256')
  for (const rel of await walk(root, '', excluded)) {
    hash.update(rel)
    hash.update('\0')
    hash.update(await readFile(join(root, rel)))
  }
  return `sha256:${hash.digest('hex')}`
}

/** Directory-relative paths a digest covers, in digest order. */
export async function listBundleDigestPaths(bundleDir: string, options: DigestOptions = {}): Promise<string[]> {
  return await walk(bundleDir, '', mergeExcluded(options))
}

function mergeExcluded(options: DigestOptions): {
  directories: ReadonlySet<string>
  suffixes: readonly string[]
} {
  return {
    directories: new Set([...DIGEST_EXCLUDED_DIRECTORIES, ...(options.excludeDirectories ?? [])]),
    suffixes: options.excludeDirectorySuffixes ?? [],
  }
}

async function walk(root: string, prefix: string, excluded: { directories: ReadonlySet<string>; suffixes: readonly string[] }): Promise<string[]> {
  const entries = [...(await readdir(join(root, prefix), { withFileTypes: true }))]
    .sort((left, right) => left.name.localeCompare(right.name))
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (excluded.directories.has(entry.name) || excluded.suffixes.some(suffix => entry.name.endsWith(suffix))) continue
      files.push(...await walk(root, rel, excluded))
      continue
    }
    if ((await lstat(join(root, rel))).isSymbolicLink()) {
      throw new BundleError(`bundle contains a symbolic link, which an immutable snapshot forbids: ${rel}`, 'SYMLINK_REJECTED')
    }
    if (entry.isFile()) files.push(rel)
    else throw new BundleError(`bundle contains a special file (fifo/socket/device), which an immutable snapshot forbids: ${rel}`, 'SPECIAL_FILE_REJECTED')
  }
  return files
}
