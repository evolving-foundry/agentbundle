import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchInstall, dispatchUninstall } from './adapters/index.ts'
import type { RunDsh, RunHermes, RunPython } from './adapters/types.ts'
import { BundleError } from './errors.ts'
import { HERMES_BUNDLE_KIND, parseBundleKind } from './manifest.ts'
import { verifyBundle, type VerifyOptions, type VerifyResult } from './verify.ts'

/** Static verify options plus the seams a trial install needs. The trial never uses the caller's registry. */
export interface VerifyInstallOptions extends VerifyOptions {
  readonly runDsh?: RunDsh
  readonly runHermes?: RunHermes
  readonly runPython?: RunPython
  readonly log?: (line: string) => void
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Prove a bundle can be installed: standard format checks, then one fresh
 * install into a private home and registry, then uninstall. The scratch
 * directory is removed on success and on failure. `verifyBundle` stays static
 * because install already calls it.
 */
export async function verifyInstallable(bundleDir: string, options: VerifyInstallOptions = {}): Promise<VerifyResult> {
  const verified = await verifyBundle(bundleDir, {
    ...(options.expectDigest === undefined ? {} : { expectDigest: options.expectDigest }),
    level: 'standard',
  })
  const scratch = await mkdtemp(join(tmpdir(), 'agent-bundle-verify-'))
  const registryPath = join(scratch, 'installations.json')
  const home = join(scratch, 'home')
  try {
    // A hermes bundle declares its model via env placeholders and the adapter
    // fail-louds when they are unresolved; a trial install must still prove the
    // config-write path, so inject harmless sentinel values (the scratch home is
    // deleted right after). Other kinds are untouched.
    const kind = await parseBundleKind(bundleDir)
    const trialEnv = kind === HERMES_BUNDLE_KIND
      ? { ...options.env, AGENT_MODEL_PROVIDER: options.env?.AGENT_MODEL_PROVIDER ?? 'verify-provider', AGENT_MODEL_NAME: options.env?.AGENT_MODEL_NAME ?? 'verify-model' }
      : options.env
    const installed = await dispatchInstall({
      bundleDir,
      home,
      registryPath,
      mode: 'ephemeral',
      ...(options.runDsh === undefined ? {} : { runDsh: options.runDsh }),
      ...(options.runHermes === undefined ? {} : { runHermes: options.runHermes }),
      ...(options.runPython === undefined ? {} : { runPython: options.runPython }),
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(trialEnv === undefined ? {} : { env: trialEnv }),
    })
    if (installed.reused) {
      throw new BundleError(`verify install reused an existing home ${installed.home}; a trial install must materialize a fresh home`, 'INSTALL_CONFLICT')
    }
    await dispatchUninstall({
      id: installed.id,
      digest: installed.digest,
      home: installed.home,
      registryPath,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    return verified
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
