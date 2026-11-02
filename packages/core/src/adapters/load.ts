import { stat } from 'node:fs/promises'
import { resolveBindings, type RunBindings } from '../bindings.ts'
import { BundleError } from '../errors.ts'
import { defaultRegistryPath, findRecord } from '../registry.ts'
import { uninstallInstallation } from './uninstall.ts'
import type { HarnessAdapter, LoadedAgent, LoadOptions } from './types.ts'

/**
 * Turn an installed, verified installation into a launchable handle. Loads do
 * not activate (that is an explicit operation) and never start anything — the
 * caller owns launch, invocation, and cancellation.
 */
export async function loadInstallation(
  options: LoadOptions,
  findAdapter: (kind: string) => HarnessAdapter | undefined,
): Promise<LoadedAgent> {
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const env = options.env ?? process.env
  const filter = {
    ...(options.digest === undefined ? {} : { digest: options.digest }),
    ...(options.home === undefined ? {} : { home: options.home }),
  }
  const record = await findRecord(registryPath, options.id, filter)
  const adapter = findAdapter(record.kind)
  if (adapter === undefined) {
    throw new BundleError(
      `no adapter registered for bundle kind ${JSON.stringify(record.kind)}; reinstall with a supported agent-bundle version`,
      'BUNDLE_KIND_UNKNOWN',
    )
  }

  // Virtual homes (dify `dify-app:<id>`) have no directory; their adapter
  // runtimeCheck guards the recorded application instead.
  if (!record.home.startsWith('dify-app:')) {
    const homeStat = await stat(record.home).catch(() => undefined)
    if (homeStat === undefined || !homeStat.isDirectory()) {
      throw new BundleError(`installation ${record.id} home is missing on disk: ${record.home}; reinstall before loading`, 'INSTALL_CONFLICT')
    }
  }
  if (adapter.runtimeCheck !== undefined) {
    await adapter.runtimeCheck({ record, ...(options.log === undefined ? {} : { log: options.log }) })
  }

  const bindings = resolveBindings(options.bindings ?? {}, {
    env,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  })
  const launch = adapter.describeLaunch({ record, bindings })
  const launchEnv = { ...launch.launchEnv, ...bindings }

  let cleanedUp = false
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    digest: record.digest,
    home: record.home,
    mode: record.mode,
    launchCommand: launch.launchCommand,
    launchEnv,
    bindings,
    cleanup: async () => {
      if (cleanedUp) return
      cleanedUp = true
      if (record.mode === 'persistent' || record.mode === 'native') {
        options.log?.(`${record.mode} installation ${record.id} is kept; load cleanup is a no-op`)
        return
      }
      await uninstallInstallation({
        id: record.id,
        home: record.home,
        ...(options.registryPath === undefined ? {} : { registryPath: options.registryPath }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.log === undefined ? {} : { log: options.log }),
      })
    },
  }
}
