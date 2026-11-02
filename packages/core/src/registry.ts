import { readdir, readFile, readlink, rename, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import process from 'node:process'
import { BundleError } from './errors.ts'

export type InstallMode = 'ephemeral' | 'persistent' | 'native'
export type InstallationStatus = 'installed' | 'active'

export interface InstallationRecord {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly digest: string
  readonly home: string
  readonly profile: string
  readonly bundleDir: string
  readonly installedAt: string
  /** v1 records are all ephemeral; the field was a literal before SDK phase 2. */
  readonly mode: InstallMode
  readonly harnessVersion?: string
  /** Written at install time (see install-core ADAPTER_VERSION); missing on v1 records. */
  readonly adapterVersion?: string
  /** Single source of truth for activation; missing means 'installed' (v1 records never activated). */
  readonly status?: InstallationStatus
  /** pi: config directory holding the isolated home (PI_CODING_AGENT_DIR). */
  readonly piConfigDir?: string
  /** dify: created application id (dify adapter only). */
  readonly appId?: string
  /** dify: created Service API key (dify adapter only). */
  readonly apiKey?: string
  /** dify: console base URL used at install time (dify adapter only). */
  readonly baseUrl?: string
  /** native installs: home-relative paths owned by this bundle, removed on uninstall while the shared home is kept (hermes: its plugins + metadata dir; dsh legacy falls back to `profiles/<profile>`). */
  readonly nativeSubtree?: readonly string[]
}

export function defaultRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENT_BUNDLE_REGISTRY']
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.agent-bundle', 'installations.json')
}

export async function loadRegistry(registryPath: string): Promise<InstallationRecord[]> {
  let text: string
  try {
    text = await readFile(registryPath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new BundleError(`installation registry ${registryPath} is corrupt (${String(error)}); delete the file to rebuild it`, 'REGISTRY_CORRUPT')
  }
  if (!Array.isArray(parsed)) {
    throw new BundleError(`installation registry ${registryPath} must contain a JSON array of installation records`, 'REGISTRY_CORRUPT')
  }
  return parsed as InstallationRecord[]
}

export async function saveRegistry(registryPath: string, records: readonly InstallationRecord[]): Promise<void> {
  const directory = dirname(registryPath)
  await mkdir(directory, { recursive: true })
  const tempPath = join(directory, `.installations.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  await rename(tempPath, registryPath)
}

export async function upsertRecord(registryPath: string, record: InstallationRecord): Promise<void> {
  const records = await loadRegistry(registryPath)
  const index = records.findIndex(entry => entry.id === record.id && entry.digest === record.digest)
  if (index >= 0) records[index] = record
  else records.push(record)
  await saveRegistry(registryPath, records)
}

function selectRecord(
  records: readonly InstallationRecord[],
  id: string,
  filter: { readonly digest?: string; readonly home?: string },
): InstallationRecord {
  const matches = records.filter(entry => entry.id === id)
  if (matches.length === 0) {
    throw new BundleError(`no installation record with id ${JSON.stringify(id)}; known ids: ${records.map(entry => entry.id).join(', ') || '(none)'}`, 'RECORD_MISSING')
  }
  let filtered = matches
  if (filter.digest !== undefined) filtered = filtered.filter(entry => entry.digest === filter.digest)
  if (filter.home !== undefined) filtered = filtered.filter(entry => entry.home === filter.home)
  if (filtered.length === 0) {
    throw new BundleError(`installation ${JSON.stringify(id)} has no record matching the given digest/home filter`, 'RECORD_MISSING')
  }
  if (filtered.length > 1) {
    throw new BundleError(`installation id ${JSON.stringify(id)} is ambiguous (${filtered.length} records); pass the full digest or the home path to disambiguate`, 'RECORD_MISSING')
  }
  return filtered[0]!
}

export async function findRecord(
  registryPath: string,
  id: string,
  filter: { readonly digest?: string; readonly home?: string } = {},
): Promise<InstallationRecord> {
  return selectRecord(await loadRegistry(registryPath), id, filter)
}

export async function removeRecord(
  registryPath: string,
  id: string,
  filter: { readonly digest?: string; readonly home?: string } = {},
): Promise<InstallationRecord> {
  const records = await loadRegistry(registryPath)
  const record = selectRecord(records, id, filter)
  await saveRegistry(registryPath, records.filter(entry => entry !== record))
  return record
}

export function installationId(name: string, digest: string): string {
  return `${name}-${digest.slice(7, 15)}`
}

export async function findHomeOccupants(home: string): Promise<string[]> {
  if (process.platform !== 'linux') return []
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter(entry => /^\d+$/.test(entry))
  const occupants: string[] = []
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    const links = [join('/proc', pid, 'cwd')]
    const fds = await readdir(join('/proc', pid, 'fd')).catch(() => [] as string[])
    links.push(...fds.map(fd => join('/proc', pid, 'fd', fd)))
    for (const link of links) {
      const target = await readlink(link).catch(() => undefined)
      if (target !== undefined && (target === home || target.startsWith(home + sep))) {
        occupants.push(pid)
        break
      }
    }
  }
  return occupants
}
