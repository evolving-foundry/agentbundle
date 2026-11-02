import { resolve } from 'node:path'
import { BundleError } from '../errors.ts'
import { parseBundleKind } from '../manifest.ts'
import { dshAdapter } from './dsh/install.ts'
import { difyAdapter } from './dify/install.ts'
import { piAdapter } from './pi/install.ts'
import { hermesAdapter } from './hermes/install.ts'
import { deepagentsAdapter } from './deepagents/install.ts'
import { jiuwenswarmAdapter } from './jiuwenswarm/install.ts'
import { activateInstallation } from './activate.ts'
import { loadInstallation } from './load.ts'
import type { ActivationResult, ActivateOptions, HarnessAdapter, InstallOptions, InstallResult, LoadedAgent, LoadOptions, UninstallOptions, UninstallResult } from './types.ts'
import { defaultRegistryPath, loadRegistry } from '../registry.ts'

const adapters = new Map<string, HarnessAdapter>()

export function registerAdapter(adapter: HarnessAdapter): void {
  adapters.set(adapter.kind, adapter)
}

export function getAdapter(kind: string): HarnessAdapter | undefined {
  return adapters.get(kind)
}

export function listAdapterKinds(): string[] {
  return [...adapters.keys()].sort()
}

export async function dispatchInstall(options: InstallOptions): Promise<InstallResult> {
  const kind = await parseBundleKind(resolve(options.bundleDir))
  const adapter = adapters.get(kind)
  if (adapter === undefined) {
    throw new BundleError(`no adapter registered for bundle kind ${JSON.stringify(kind)}; supported kinds: ${listAdapterKinds().join(', ')}`, 'BUNDLE_KIND_UNKNOWN')
  }
  return await adapter.install(options)
}

export async function dispatchUninstall(options: UninstallOptions): Promise<UninstallResult> {
  const records = await loadRegistry(options.registryPath ?? defaultRegistryPath(options.env))
  const match = records.find(entry => entry.id === options.id)
  const kind = match?.kind ?? 'dsh-agent-bundle'
  const adapter = adapters.get(kind)
  if (adapter === undefined) {
    throw new BundleError(`no adapter registered for bundle kind ${JSON.stringify(kind)}; supported kinds: ${listAdapterKinds().join(', ')}`)
  }
  return await adapter.uninstall(options)
}

export function dispatchActivate(options: ActivateOptions): Promise<ActivationResult> {
  return activateInstallation(options, kind => adapters.get(kind))
}

export function dispatchLoad(options: LoadOptions): Promise<LoadedAgent> {
  return loadInstallation(options, kind => adapters.get(kind))
}

registerAdapter(dshAdapter)
registerAdapter(difyAdapter)
registerAdapter(piAdapter)
registerAdapter(hermesAdapter)
registerAdapter(deepagentsAdapter)
registerAdapter(jiuwenswarmAdapter)
