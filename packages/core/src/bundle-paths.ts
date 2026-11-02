import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { BundleError } from './errors.ts'

/**
 * Bundle-resource primitives used by more than one kind: relative-path
 * confinement, "is there a file here?" checks, JSON reads, and package.json entry
 * resolution. Deliberately not under an adapter because the callers span kinds —
 * `manifest.ts` uses the path/JSON/entry helpers to validate dsh plugin packages
 * and `adapters/pi` uses the same helpers for its whole resource set, with an
 * explicit export-condition priority as the only difference between them
 * (`packageEntryTarget`).
 *
 * Anything single-kind belongs with that adapter instead (for example
 * `piExtensionEntries`, which lives in `adapters/pi/manifest.ts`).
 */

export async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

/**
 * `stat`-based: follows symlinks, so a symlink to a missing target counts as
 * absent. Use `yaml-file.ts` `pathExists` (lstat) when the question is whether a
 * path is *taken* rather than whether content is readable.
 */
export async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(info => info.isFile(), () => false)
}

export async function isDirectory(path: string): Promise<boolean> {
  return await stat(path).then(info => info.isDirectory(), () => false)
}

/**
 * A declared bundle path must be relative and stay inside the bundle. Returns the
 * absolute target so callers can continue validating it.
 */
export function resolveInBundle(bundleDir: string, declared: string, label: string): string {
  if (declared === '' || isAbsolute(declared) || declared.includes('..')) {
    throw new BundleError(`${label} must be a relative path inside the bundle, got ${JSON.stringify(declared)}`, 'PATH_ESCAPE')
  }
  return resolve(bundleDir, declared)
}

export async function readJsonFile(path: string, label: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new BundleError(`required ${label} is missing or unreadable: ${path}`, 'POINTER_MISSING')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new BundleError(`${label} is not valid JSON: ${String(error)}`, 'MANIFEST_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BundleError(`${label} must contain a JSON object`, 'MANIFEST_INVALID')
  }
  return parsed as Record<string, unknown>
}

export async function readOptionalJsonFile(path: string, label: string): Promise<Record<string, unknown> | undefined> {
  if (!await pathExists(path)) return undefined
  return await readJsonFile(path, label)
}

const RELATIVE_ENTRY = (value: string): boolean => value !== '' && !isAbsolute(value) && !value.includes('..')

/**
 * The build output a package.json points at: `main`, or `exports["."]`.
 *
 * `conditions` lists the export conditions to accept, in priority order. Both
 * conventions in this repo need a different one:
 * - dsh plugins ship CJS-ish entries and declare `exports["."].default`
 *   (`['default']`, the historical dsh behavior);
 * - Pi packages ship ESM entries and declare `exports["."].import`
 *   (`['import', 'default']`; the real Pi package has no `main` and
 *   no `default`, so a `default`-only lookup finds nothing there).
 */
export function packageEntryTarget(manifest: Record<string, unknown>, conditions: readonly string[] = ['default']): string | undefined {
  const main = manifest['main']
  if (typeof main === 'string' && RELATIVE_ENTRY(main)) return main
  const exportsField = manifest['exports']
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const dot = (exportsField as Record<string, unknown>)['.']
  if (typeof dot === 'string' && RELATIVE_ENTRY(dot)) return dot
  if (typeof dot !== 'object' || dot === null) return undefined
  const shaped = dot as Record<string, unknown>
  for (const condition of conditions) {
    const value = shaped[condition]
    if (typeof value === 'string' && RELATIVE_ENTRY(value)) return value
  }
  return undefined
}
