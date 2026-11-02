import { rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BundleError } from '../errors.ts'
import { defaultRegistryPath, findHomeOccupants, findRecord, removeRecord } from '../registry.ts'
import { pathExists } from '../yaml-file.ts'
import { PI_BUNDLE_KIND } from '../manifest.ts'
import { removePiNativeProfile } from './pi/native.ts'
import { assertUninstallable, withDirLock } from './install-core.ts'
import type { UninstallOptions, UninstallResult } from './types.ts'

export async function uninstallInstallation(options: UninstallOptions): Promise<UninstallResult> {
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const filter = {
    ...(options.digest === undefined ? {} : { digest: options.digest }),
    ...(options.home === undefined ? {} : { home: resolve(options.home) }),
  }
  const record = await findRecord(registryPath, options.id, filter)
  assertUninstallable(record, options.force)
  if (record.kind === PI_BUNDLE_KIND && record.mode === 'native') {
    const profileExisted = await removePiNativeProfile(record, options.log)
    const removed = await removeRecord(registryPath, options.id, filter)
    options.log?.(`removed installation ${record.id}; kept harness home ${record.home}`)
    return {
      removed: true,
      homeExisted: false,
      occupied: false,
      bundleDir: removed.bundleDir,
      profileRemoved: profileExisted ? record.profile : undefined,
      homeKept: record.home,
    }
  }

  // Native installs share the harness default home with the user's own
  // configuration: only the bundle-owned subtree(s) go, and the whole-home
  // occupancy scan does not apply (host processes live there). dsh legacy
  // records fall back to `profiles/<profile>`; hermes records carry an
  // explicit `nativeSubtree` list (plugins + metadata dir).
  if (record.mode === 'native') {
    const removed = await removeRecord(registryPath, options.id, filter)
    let removedLabel = ''
    await withDirLock(record.home, async () => {
      const subtrees = record.nativeSubtree ?? [join('profiles', record.profile)]
      const removedRel: string[] = []
      for (const rel of subtrees) {
        const target = join(record.home, rel)
        if (await pathExists(target)) {
          await rm(target, { recursive: true, force: true })
          removedRel.push(rel)
        }
      }
      removedLabel = record.nativeSubtree === undefined && removedRel.length > 0 ? record.profile : removedRel.join(', ')
    })
    options.log?.(`removed from native home ${record.home}: ${removedLabel || '(already gone)'}`)
    return { removed: true, homeExisted: false, occupied: false, bundleDir: removed.bundleDir, profileRemoved: removedLabel || undefined, homeKept: record.home }
  }

  const occupants = await findHomeOccupants(record.home)
  if (occupants.length > 0 && options.force !== true) {
    throw new BundleError(`installation ${record.id} home is in use by process(es) ${occupants.join(', ')}; pass --force to uninstall anyway`, 'INSTALL_CONFLICT')
  }
  // Virtual homes (dify `dify-app:<id>`) and already-deleted homes have no
  // directory to lock or remove; the registry entry is the whole state there.
  const homeIsDir = (await stat(record.home).catch(() => undefined))?.isDirectory() === true
  const removed = await removeRecord(registryPath, options.id, filter)
  let homeExisted = false
  if (homeIsDir) {
    await withDirLock(record.home, async () => {
      homeExisted = await pathExists(record.home)
      if (homeExisted) {
        await rm(record.home, { recursive: true, force: true })
      }
    })
  }
  options.log?.(`removed installation ${record.id}${homeExisted ? '' : ' (home was already gone)'}`)
  return { removed: true, homeExisted, occupied: occupants.length > 0, bundleDir: removed.bundleDir }
}
