import { stat } from 'node:fs/promises'
import { BundleError } from '../errors.ts'
import { defaultRegistryPath, findRecord, loadRegistry, saveRegistry, type InstallationRecord } from '../registry.ts'
import type { ActivationResult, ActivateOptions, HarnessAdapter } from './types.ts'

/**
 * Activate an installation: runtime-validate it (before any write), then
 * atomically flip the active status — the previous active of the same bundle
 * name is demoted in the same single-file write. Any failure leaves the
 * registry untouched, so the previously active installation stays active.
 */
export async function activateInstallation(
  options: ActivateOptions,
  findAdapter: (kind: string) => HarnessAdapter | undefined,
): Promise<ActivationResult> {
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const filter = {
    ...(options.digest === undefined ? {} : { digest: options.digest }),
    ...(options.home === undefined ? {} : { home: options.home }),
  }
  const record = await findRecord(registryPath, options.id, filter)

  // Virtual homes (dify `dify-app:<id>`) have no directory to validate; their
  // adapter runtimeCheck guards the recorded application instead.
  if (!isVirtualHome(record)) {
    const homeStat = await stat(record.home).catch(() => undefined)
    if (homeStat === undefined || !homeStat.isDirectory()) {
      throw new BundleError(`installation ${record.id} home is missing on disk: ${record.home}; reinstall before activating`, 'INSTALL_CONFLICT')
    }
  }

  const adapter = findAdapter(record.kind)
  if (adapter === undefined) {
    throw new BundleError(
      `no adapter registered for bundle kind ${JSON.stringify(record.kind)}; reinstall with a supported agent-bundle version`,
      'BUNDLE_KIND_UNKNOWN',
    )
  }
  if (adapter.runtimeCheck !== undefined) {
    await adapter.runtimeCheck({ record, ...(options.log === undefined ? {} : { log: options.log }) })
  }

  const records = await loadRegistry(registryPath)
  const targetIndex = records.findIndex(entry => entry.id === record.id && entry.digest === record.digest)
  if (targetIndex < 0) {
    throw new BundleError(`installation ${record.id} disappeared from the registry during activation`, 'RECORD_MISSING')
  }
  const previous = records.find(entry => entry.name === record.name && entry.status === 'active' && entry.id !== record.id)
  const activatedAt = new Date().toISOString()
  const updated = records.map((entry, index) => {
    if (index === targetIndex) return { ...entry, status: 'active' as const }
    if (entry.name === record.name && entry.status === 'active') return { ...entry, status: 'installed' as const }
    return entry
  })
  await saveRegistry(registryPath, updated)
  options.log?.(`activated ${record.id} (${record.name})${previous === undefined ? '' : `; demoted ${previous.id}`}`)
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    digest: record.digest,
    home: record.home,
    mode: record.mode,
    activatedAt,
    ...(previous === undefined ? {} : { previous: { id: previous.id, digest: previous.digest } }),
  }
}

/** dify records point at a Console application, not a directory. */
function isVirtualHome(record: InstallationRecord): boolean {
  return record.home.startsWith('dify-app:')
}
