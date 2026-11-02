import { lstat, readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { BundleError } from './errors.ts'

/**
 * "Is this path taken?" — deliberately `lstat`-based, so a symlink counts even
 * when its target is missing. Bundle verification uses it to decide whether a
 * required artifact (bundle.yaml, agent.yaml, dependencies.lock, declared
 * pointers) is present, so a dangling symlink must be seen as present for the
 * digest walk to report it as a forbidden link rather than as a missing file.
 * For "is there a readable file here?" (following links), use `bundle-paths.ts`.
 */
export async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, () => false)
}

export async function readMappingFile(path: string, label: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new BundleError(`required ${label} is missing or unreadable: ${path}`, 'POINTER_MISSING')
  }
  return parseMappingText(text, path)
}

export function parseMappingText(text: string, path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    throw new BundleError(`${path} is not valid YAML: ${String(error)}`, 'MANIFEST_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BundleError(`${path} must contain a YAML mapping`, 'MANIFEST_INVALID')
  }
  return parsed as Record<string, unknown>
}
