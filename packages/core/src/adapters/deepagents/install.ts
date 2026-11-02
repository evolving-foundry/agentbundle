import { access, constants, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEEPAGENTS_BUNDLE_KIND } from './manifest.ts'
import { harnessNameForKind } from '../../manifest.ts'
import { detectUv, resolvePythonRuntime } from './runtime.ts'
import { verifyBundle } from '../../verify.ts'
import { BundleError } from '../../errors.ts'
import { defaultRegistryPath, installationId, upsertRecord, type InstallationRecord } from '../../registry.ts'
import { uninstallInstallation } from '../uninstall.ts'
import { ADAPTER_VERSION, checkStampActivation, installHome, readInstallStamp, shouldReuseInstall, withDirLock, writeInstallStamp } from '../install-core.ts'
import type { HarnessAdapter, InstallOptions, InstallResult, RunPython } from '../types.ts'

/** The deepagents pin (`pyproject.toml` requires-python) — enforced before venv creation. */
const PY_VERSION_CHECK = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'

export const deepagentsAdapter: HarnessAdapter = {
  kind: DEEPAGENTS_BUNDLE_KIND,
  install: installDeepagentsBundle,
  uninstall: uninstallInstallation,
  runtimeCheck: ({ record, log }) => checkStampActivation(record, join(record.home, '.bundle-install.json'), log),
  describeLaunch: ({ record }) => ({
    launchCommand: `cd ${record.bundleDir} && ${join(record.home, 'bin', 'python')} -c "import agent"`,
    launchEnv: {},
  }),
}

export async function installDeepagentsBundle(options: InstallOptions): Promise<InstallResult> {
  const bundleDir = resolve(options.bundleDir)
  const verified = await verifyBundle(bundleDir)
  const manifest = verified.manifest
  if (manifest.kind !== DEEPAGENTS_BUNDLE_KIND) {
    throw new BundleError(`deepagents adapter received a ${JSON.stringify(manifest.kind)} bundle`, 'MANIFEST_INVALID')
  }
  const runPython = options.runPython
  if (runPython === undefined) {
    throw new BundleError('deepagents install requires a runPython seam (the agent-bundle CLI provides one)')
  }
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const home = installHome({ kind: manifest.kind, name: manifest.name, digest: verified.digest, home: options.home, mode: options.mode ?? 'ephemeral', registryPath })
  const recordPath = join(home, '.bundle-install.json')
  const registryRecord: InstallationRecord = {
    id: installationId(manifest.name, verified.digest),
    name: manifest.name,
    kind: manifest.kind,
    digest: verified.digest,
    home,
    profile: manifest.name,
    bundleDir,
    installedAt: new Date().toISOString(),
    mode: options.mode ?? 'ephemeral',
    harnessVersion: manifest.harnessVersion,
    adapterVersion: ADAPTER_VERSION,
    status: 'installed',
  }

  return await withDirLock(home, async () => {
    if (shouldReuseInstall(await readInstallStamp(recordPath), verified.digest, options.force)) {
      options.log?.(`reusing installation: venv ${home}`)
      await upsertRecord(registryPath, registryRecord)
      return assemble(verified, bundleDir, home, manifest.declaredPlugins, true, registryRecord.id)
    }

    const env = options.env ?? process.env
    // uv owns interpreter acquisition (`uv venv --python 3.12` may fetch a
    // managed CPython), so it takes priority over the system python exactly like
    // the reference scripts (Example-LangGraph scripts/setup.sh).
    const uv = await detectUv(env)

    const venvPython = join(home, 'bin', 'python')
    if (await isExecutableFile(venvPython)) {
      options.log?.(`venv already exists at ${home} (stale install record); reinstalling into it`)
    } else if (uv !== undefined) {
      options.log?.(`creating venv with uv: ${uv} (python 3.12)`)
      await runPython(uv, ['venv', '--python', '3.12', home], {})
    } else {
      const runtime = await resolvePythonRuntime(env)
      options.log?.(`using python from ${runtime.source}: ${runtime.command}`)
      await assertPythonVersion(runPython, runtime)
      options.log?.(`creating venv ${home}`)
      await runPython(runtime.command, ['-m', 'venv', home], {})
    }

    options.log?.(`installing bundle (editable): ${bundleDir}`)
    if (uv !== undefined) {
      await runPython(uv, ['pip', 'install', '--python', venvPython, '-e', bundleDir], {})
    } else {
      await runPython(venvPython, ['-m', 'pip', 'install', '-e', bundleDir], {})
    }

    // No model write: agent.py resolves the agent.yaml `${ENV}` placeholders at
    // import time (runtime binding); unset variables fall back to the deepagents
    // default model. Credentials stay with the caller.

    await mkdir(home, { recursive: true })
    await writeInstallStamp(recordPath, verified.digest, bundleDir)
    await upsertRecord(registryPath, registryRecord)
    options.log?.(`installed bundle ${manifest.name} into ${home}`)
    return assemble(verified, bundleDir, home, manifest.declaredPlugins, false, registryRecord.id)
  })
}

/** Launch = the composition-entry smoke import: installed ⟺ the graph imports. */
function assemble(
  verified: { digest: string; manifest: { name: string; harnessVersion: string } },
  bundleDir: string,
  home: string,
  plugins: readonly string[],
  reused: boolean,
  installationId: string,
): InstallResult {
  return {
    id: installationId,
    digest: verified.digest,
    home,
    installationId,
    harness: { name: harnessNameForKind(DEEPAGENTS_BUNDLE_KIND), versionRange: verified.manifest.harnessVersion },
    profile: verified.manifest.name,
    plugins,
    reused,
    launchCommand: `cd ${bundleDir} && ${join(home, 'bin', 'python')} -c "import agent"`,
  }
}

async function assertPythonVersion(runPython: RunPython, runtime: { command: string; source: string }): Promise<void> {
  try {
    await runPython(runtime.command, ['-c', PY_VERSION_CHECK], {})
  } catch (error) {
    throw new BundleError(`python >= 3.11 is required (the deepagents pin); ${runtime.command} from ${runtime.source} failed the check: ${error instanceof Error ? error.message : String(error)}`, 'RUNTIME_UNRESOLVED')
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(() => true, () => false)
}
