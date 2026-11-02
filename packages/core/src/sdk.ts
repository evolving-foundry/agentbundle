import { resolve } from 'node:path'
import { dispatchActivate, dispatchInstall, dispatchLoad, dispatchUninstall } from './adapters/index.ts'
import type { ActivationResult, ActivateOptions, InstallOptions, InstallResult, LoadedAgent, LoadOptions, RunDsh, RunHermes, RunPython, UninstallOptions, UninstallResult } from './adapters/types.ts'
import type { DifyFetch } from './adapters/dify/console.ts'
import type { BundleKind } from './manifest.ts'
import { inspectBundle } from './inspect.ts'
import { packBundle, type PackOptions } from './pack.ts'
import type { BundleInfo, PackResult, VerifyLevel } from './protocol.ts'
import { verifyBundle, type VerifyOptions, type VerifyResult } from './verify.ts'
import { verifyInstallable } from './verify-install.ts'

/**
 * Process-pure SDK entry point: wires the spawn seams, ambient env, and
 * registry path once, then exposes the stateless operations (inspect / pack /
 * verify) and the install lifecycle (install / activate / load / uninstall).
 * The CLI `--json` output is the cross-process form of the same semantics.
 */
export interface BundleSdkOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly registryPath?: string
  readonly runDsh?: RunDsh
  readonly runHermes?: RunHermes
  readonly runPython?: RunPython
  readonly log?: (line: string) => void
  /** Dify-only test seam: inject a fetch implementation instead of real HTTP. */
  readonly fetchFn?: DifyFetch
}

export interface BundleSdk {
  inspect(bundleDir: string): Promise<BundleInfo>
  pack(options: PackOptions): Promise<PackResult>
  verify<K extends BundleKind = BundleKind, L extends VerifyLevel = 'standard'>(
    bundleDir: string,
    options?: VerifyOptions & { readonly level?: L },
  ): Promise<VerifyResult<K, L>>
  install(bundleDir: string, options?: Pick<InstallOptions, 'home' | 'profileName' | 'mode' | 'force'>): Promise<InstallResult>
  activate(options: Pick<ActivateOptions, 'id' | 'digest' | 'home'>): Promise<ActivationResult>
  load(options: Pick<LoadOptions, 'id' | 'digest' | 'home' | 'bindings' | 'credentials'>): Promise<LoadedAgent>
  uninstall(options: Pick<UninstallOptions, 'id' | 'digest' | 'home' | 'force'>): Promise<UninstallResult>
}

export function createBundleSdk(options: BundleSdkOptions = {}): BundleSdk {
  const inherited = {
    ...(options.runDsh === undefined ? {} : { runDsh: options.runDsh }),
    ...(options.runHermes === undefined ? {} : { runHermes: options.runHermes }),
    ...(options.runPython === undefined ? {} : { runPython: options.runPython }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.registryPath === undefined ? {} : { registryPath: options.registryPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  }
  return {
    inspect: bundleDir => inspectBundle(bundleDir),
    pack: packOptions => packBundle(packOptions),
    verify: <K extends BundleKind = BundleKind, L extends VerifyLevel = 'standard'>(
      bundleDir: string,
      verifyOptions?: VerifyOptions & { readonly level?: L },
    ): Promise<VerifyResult<K, L>> => {
      if (verifyOptions?.level === 'install') {
        return verifyInstallable(bundleDir, {
          ...(verifyOptions.expectDigest === undefined ? {} : { expectDigest: verifyOptions.expectDigest }),
          ...(options.runDsh === undefined ? {} : { runDsh: options.runDsh }),
          ...(options.runHermes === undefined ? {} : { runHermes: options.runHermes }),
          ...(options.runPython === undefined ? {} : { runPython: options.runPython }),
          ...(options.log === undefined ? {} : { log: options.log }),
          ...(options.env === undefined ? {} : { env: options.env }),
        }) as Promise<VerifyResult<K, L>>
      }
      return verifyBundle(bundleDir, verifyOptions)
    },
    install: (bundleDir, installOptions = {}) => dispatchInstall({ bundleDir: resolve(bundleDir), ...inherited, ...installOptions }),
    activate: activateOptions => dispatchActivate({ ...activateOptions, ...inherited }),
    load: loadOptions => dispatchLoad({ ...loadOptions, ...inherited }),
    uninstall: uninstallOptions => dispatchUninstall({ ...uninstallOptions, ...inherited }),
  }
}
