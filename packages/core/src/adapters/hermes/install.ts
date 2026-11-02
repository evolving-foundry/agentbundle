import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { HERMES_BUNDLE_KIND, harnessNameForKind, type AgentConfig } from '../../manifest.ts'
import { verifyBundle } from '../../verify.ts'
import { BundleError } from '../../errors.ts'
import { defaultRegistryPath, installationId, upsertRecord, type InstallationRecord, type InstallMode } from '../../registry.ts'
import { parseMappingText, pathExists } from '../../yaml-file.ts'
import { resolveModelValue } from '../dsh/install.ts'
import { uninstallInstallation } from '../uninstall.ts'
import { ADAPTER_VERSION, checkStampActivation, installHome, nativeHome, readInstallStamp, shouldReuseInstall, withDirLock, writeInstallStamp } from '../install-core.ts'
import type { HarnessAdapter, InstallOptions, InstallResult } from '../types.ts'

export const hermesAdapter: HarnessAdapter = {
  kind: HERMES_BUNDLE_KIND,
  install: installHermesBundle,
  uninstall: uninstallInstallation,
  runtimeCheck: ({ record, log }) => checkStampActivation(record, stampPath(record.home, record.mode, record.name), log),
  describeLaunch: ({ record }) => {
    const native = record.mode === 'native'
    const launchEnv: Readonly<Record<string, string>> = native ? {} : { HERMES_HOME: record.home }
    return {
      launchCommand: native ? 'hermes "<task>"' : `HERMES_HOME=${record.home} hermes "<task>"`,
      launchEnv,
    }
  },
}

/**
 * Reuse/conflict stamp location. The native home is the user's shared
 * ~/.hermes, so the stamp must be scoped per bundle (a `.bundle/<name>/`
 * metadata dir) instead of living at the home root like an owned home.
 */
function stampPath(home: string, mode: InstallMode, name: string): string {
  return mode === 'native' ? join(home, '.bundle', name, '.bundle-install.json') : join(home, '.bundle-install.json')
}

export async function installHermesBundle(options: InstallOptions): Promise<InstallResult> {
  const bundleDir = resolve(options.bundleDir)
  const verified = await verifyBundle(bundleDir)
  const manifest = verified.manifest
  if (manifest.kind !== HERMES_BUNDLE_KIND) {
    throw new BundleError(`hermes adapter received a ${JSON.stringify(manifest.kind)} bundle`, 'MANIFEST_INVALID')
  }
  const pluginNames = manifest.pluginNames
  if (pluginNames === undefined) {
    throw new BundleError('hermes bundle manifest is missing plugin names', 'MANIFEST_INVALID')
  }
  const runHermes = options.runHermes
  if (runHermes === undefined) {
    throw new BundleError('hermes install requires a runHermes seam (the agent-bundle CLI provides one)')
  }
  const profile = options.profileName ?? manifest.name
  const mode: InstallMode = options.mode ?? 'ephemeral'
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const home = installHome({ kind: manifest.kind, name: manifest.name, digest: verified.digest, home: options.home, mode, registryPath, env: options.env })
  const recordPath = stampPath(home, mode, manifest.name)
  // native owns a set of home-relative subtrees (its plugins + metadata dir),
  // removed on uninstall while the shared home is kept.
  const nativeSubtree = mode === 'native'
    ? [...pluginNames.map(name => join('plugins', name)), join('.bundle', manifest.name)]
    : undefined
  const registryRecord: InstallationRecord = {
    id: installationId(manifest.name, verified.digest),
    name: manifest.name,
    kind: manifest.kind,
    digest: verified.digest,
    home,
    profile,
    bundleDir,
    installedAt: new Date().toISOString(),
    mode,
    harnessVersion: manifest.harnessVersion,
    adapterVersion: ADAPTER_VERSION,
    status: 'installed',
    ...(nativeSubtree === undefined ? {} : { nativeSubtree }),
  }

  return await withDirLock(home, async () => {
    const existing = await readInstallStamp(recordPath)
    if (shouldReuseInstall(existing, verified.digest, options.force)) {
      options.log?.(`reusing installation: home ${home}`)
      await upsertRecord(registryPath, registryRecord)
      return assemble(registryRecord, manifest.declaredPlugins, true)
    }
    if (mode === 'native') {
      if (existing !== undefined && options.force !== true) {
        throw new BundleError(`install stamp at ${recordPath} does not match this bundle; pass --force to replace the existing installation`, 'INSTALL_CONFLICT')
      }
      if (existing === undefined) {
        // H6 conflict protection: a plugin dir without our stamp is foreign —
        // never take it over (mirrors dsh's foreign-profile refusal).
        const foreign: string[] = []
        for (const name of pluginNames) {
          if (await pathExists(join(home, 'plugins', name))) foreign.push(name)
        }
        if (foreign.length > 0) {
          throw new BundleError(
            `native install refuses to take over existing plugin(s) in ${join(home, 'plugins')}: ${foreign.join(', ')} have no agent-bundle reuse stamp; uninstall them first or pass --home to install into an isolated home`,
            'INSTALL_CONFLICT',
          )
        }
      }
    }

    options.log?.(`materializing hermes home ${home}${mode === 'native' ? ' (native)' : ''}`)
    await mkdir(join(home, 'plugins'), { recursive: true })
    if (mode !== 'native') await borrowProvisionedInstalls(home, options.env ?? process.env)
    for (let i = 0; i < manifest.plugins.length; i++) {
      const pluginDir = manifest.plugins[i]!
      const pluginName = pluginNames[i]!
      options.log?.(`copying plugin ${pluginName}`)
      await cp(pluginDir, join(home, 'plugins', pluginName), { recursive: true })
    }
    for (const pluginName of pluginNames) {
      options.log?.(`enabling plugin ${pluginName}`)
      await runHermes(['plugins', 'enable', pluginName], { HERMES_HOME: home })
    }
    await writeHermesModelSelection(home, verified.agent, options.env ?? process.env, mode)
    await writeInstallStamp(recordPath, verified.digest, bundleDir)
    await upsertRecord(registryPath, registryRecord)
    options.log?.(`installed bundle ${manifest.name} into ${home}`)
    return assemble(registryRecord, manifest.declaredPlugins, false)
  })
}

function assemble(record: InstallationRecord, plugins: readonly string[], reused: boolean): InstallResult {
  const native = record.mode === 'native'
  return {
    id: record.id,
    digest: record.digest,
    home: record.home,
    installationId: record.id,
    harness: { name: harnessNameForKind(HERMES_BUNDLE_KIND), versionRange: record.harnessVersion ?? '' },
    profile: record.profile,
    plugins,
    reused,
    launchCommand: native ? 'hermes "<task>"' : `HERMES_HOME=${record.home} hermes "<task>"`,
    ...(native ? {} : { launchEnv: { HERMES_HOME: record.home } }),
  }
}

/**
 * v0.21.6 (R10): `hermes plugins enable` locates the pm-runtime at
 * `installs_root()` = `<HERMES_HOME>/installs`. An isolated install home has
 * none, so enable aborts with "ModuleNotFoundError: ruamel". Borrow the
 * provisioned (native) home's installs read-only via a symlink; the plugin
 * deps then resolve into that home's shared install-key environments. Native
 * installs already live in the provisioned home, so they need no link.
 */
async function borrowProvisionedInstalls(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const provisionInstalls = join(nativeHome(HERMES_BUNDLE_KIND, env), 'installs')
  const linkPath = join(home, 'installs')
  if (!(await pathExists(provisionInstalls)) || await pathExists(linkPath)) return
  await symlink(provisionInstalls, linkPath, 'dir')
}

async function writeHermesModelSelection(home: string, agent: AgentConfig, env: NodeJS.ProcessEnv, mode: InstallMode): Promise<void> {
  if (agent.model === undefined) return
  const provider = resolveModelValue(agent.model.provider, env)
  const model = resolveModelValue(agent.model.model, env)
  if (provider === undefined || model === undefined) {
    if (mode !== 'native') {
      throw new BundleError(
        'agent.yaml declares a model via environment placeholders but AGENT_MODEL_PROVIDER / AGENT_MODEL_NAME are not set; set both, or install natively (the default) to reuse your hermes home model config',
        'MODEL_UNRESOLVED',
      )
    }
    // native: leave the host config.yaml untouched — its own default model applies.
    return
  }
  const configPath = join(home, 'config.yaml')
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(configPath, stringifyYaml({ model: { default: model, provider } }), 'utf8')
      return
    }
    throw new BundleError(`required config file is missing or unreadable: ${configPath}`, 'POINTER_MISSING')
  }
  const config = parseMappingText(text, configPath)
  const existingModel = typeof config['model'] === 'object' && config['model'] !== null
    ? (config['model'] as Record<string, unknown>)
    : {}
  existingModel['default'] = model
  existingModel['provider'] = provider
  config['model'] = existingModel
  await writeFile(configPath, stringifyYaml(config), 'utf8')
}
