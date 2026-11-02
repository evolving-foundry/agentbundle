import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { DSH_BUNDLE_KIND, harnessNameForKind, isBundleName } from '../../manifest.ts'
import { verifyBundle } from '../../verify.ts'
import { BundleError } from '../../errors.ts'
import { defaultRegistryPath, installationId, upsertRecord, type InstallationRecord } from '../../registry.ts'
import { parseMappingText, pathExists } from '../../yaml-file.ts'
import type { AgentConfig } from '../../manifest.ts'
import { uninstallInstallation } from '../uninstall.ts'
import { ADAPTER_VERSION, checkStampActivation, installHome, readInstallStamp, shouldReuseInstall, withDirLock, writeInstallStamp } from '../install-core.ts'
import type { HarnessAdapter, InstallMode, InstallOptions, InstallResult } from '../types.ts'

export const dshAdapter: HarnessAdapter = {
  kind: DSH_BUNDLE_KIND,
  install: installBundle,
  uninstall: uninstallInstallation,
  runtimeCheck: ({ record, log }) => checkStampActivation(record, join(record.home, 'profiles', record.profile, '.bundle-install.json'), log),
  describeLaunch: ({ record }) => {
    const launchEnv: Readonly<Record<string, string>> = record.mode === 'native' ? {} : { DSH_HOME: record.home }
    return { launchCommand: `dsh --profile ${record.profile} "<task>"`, launchEnv }
  },
}

export async function installBundle(options: InstallOptions): Promise<InstallResult> {
  const bundleDir = resolve(options.bundleDir)
  const verified = await verifyBundle<typeof DSH_BUNDLE_KIND>(bundleDir)
  const manifest = verified.manifest
  if (manifest.kind !== DSH_BUNDLE_KIND) {
    throw new BundleError(`dsh adapter received a ${JSON.stringify(manifest.kind)} bundle`, 'MANIFEST_INVALID')
  }
  if (options.runDsh === undefined) {
    throw new BundleError('installBundle requires the runDsh seam: the dsh adapter never spawns on its own')
  }
  const runDsh = options.runDsh
  const profile = options.profileName ?? `bundle-${manifest.name}`
  if (!isBundleName(profile)) {
    throw new BundleError(`profile name must match /^[a-z0-9][a-z0-9-]*$/, got ${JSON.stringify(profile)}`)
  }
  const mode = options.mode ?? 'ephemeral'
  const home = installHome({ kind: manifest.kind, name: manifest.name, digest: verified.digest, home: options.home, mode, registryPath: options.registryPath ?? defaultRegistryPath(options.env), env: options.env })
  const recordPath = join(home, 'profiles', profile, '.bundle-install.json')
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
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
  }

  return await withDirLock(home, async () => {
    const existing = await readInstallStamp(recordPath)
    if (shouldReuseInstall(existing, verified.digest, options.force)) {
      options.log?.(`reusing installation: profile ${profile} home ${home}`)
      await upsertRecord(registryPath, registryRecord)
      return assemble(registryRecord.id, verified.digest, home, profile, manifest.declaredPlugins, true, registryRecord.id, manifest.harnessVersion, mode)
    }
    if (existing !== undefined && options.force !== true) {
      const nativeHint = mode === 'native'
        ? ` To install into the native home instead remove ${join(home, 'profiles', profile)} or pass --profile to install under another name.`
        : ''
      throw new BundleError(
        `install stamp at ${recordPath} does not match this bundle; pass --force to replace the existing installation.${nativeHint}`,
        'INSTALL_CONFLICT',
      )
    }
    if (mode === 'native' && existing === undefined && await pathExists(join(home, 'profiles', profile))) {
      throw new BundleError(
        `native install refuses to take over the existing profile ${profile} in ${home}: it has no agent-bundle reuse stamp; remove ${join(home, 'profiles', profile)} or pass --profile to install under another name`,
        'INSTALL_CONFLICT',
      )
    }

    const profileDir = join(home, 'profiles', profile)
    if (options.force === true && await pathExists(profileDir)) {
      for (const pluginDir of manifest.plugins) {
        const name = await pluginPackageName(pluginDir)
        options.log?.(`removing previous plugin link ${name} from profile ${profile}`)
        await runDsh(
          ['plugin', '--profile', profile, 'remove', name],
          { DSH_HOME: home },
          { allowFailure: true, quiet: true },
        ).catch(() => undefined)
      }
    }

    options.log?.(`initializing profile ${profile} in ${home}`)
    await mkdir(home, { recursive: true })
    await runDsh(
      ['--profile', profile, '--from-default-profile', 'headless'],
      { DSH_HOME: home },
      { allowFailure: true, quiet: true },
    ).catch(() => undefined)

    for (const pluginDir of manifest.plugins) {
      // Materialize a physical copy inside the profile subtree before `plugin
      // add`: dsh installs plugins via pnpm `link:`, which would otherwise
      // point back at the bundle source directory — breaking the immutable
      // snapshot semantics (mutating the bundle mutates the installed agent
      // without a digest change) and making the home depend on bundleDir.
      // A copy inside `profiles/<profile>/` keeps the home self-contained and
      // rides the existing uninstall lifecycle (owned: whole home; native:
      // profile subtree).
      options.log?.(`materializing plugin ${basename(pluginDir)} into profile ${profile}`)
      const stagedDir = await materializePluginCopy(home, profile, pluginDir)
      options.log?.(`installing plugin ${basename(pluginDir)} into profile ${profile}`)
      await runDsh(['plugin', '--profile', profile, 'add', stagedDir], { DSH_HOME: home })
    }
    await writeAgentModelSelection(home, verified.agent, options.env ?? process.env)
    await writeInstallStamp(recordPath, verified.digest, bundleDir)
    await warnRegistrySourcedHarnessPackages(manifest.plugins, options.log)
    await upsertRecord(registryPath, registryRecord)
    options.log?.(`installed bundle ${manifest.name} into ${home}`)
    return assemble(registryRecord.id, verified.digest, home, profile, manifest.declaredPlugins, false, registryRecord.id, manifest.harnessVersion, mode)
  })
}

function assemble(
  id: string,
  digest: string,
  home: string,
  profile: string,
  plugins: readonly string[],
  reused: boolean,
  installationId: string,
  versionRange: string,
  mode: InstallMode,
): InstallResult {
  return {
    id,
    digest,
    home,
    installationId,
    harness: { name: harnessNameForKind(DSH_BUNDLE_KIND), versionRange },
    profile,
    plugins,
    reused,
    launchCommand: `dsh --profile ${profile} "<task>"`,
    ...(mode === 'native' ? {} : { launchEnv: { DSH_HOME: home } }),
  }
}

/**
 * Copy a plugin's source tree into the profile subtree (`.bundle-plugins/`),
 * excluding any `node_modules` (dependencies are installed fresh by pnpm in
 * the profile workspace; stale/polluted plugin node_modules must not leak in).
 * The copy — not the bundle source — is what `plugin add` links, so the home
 * is self-contained and immune to later bundle mutations.
 */
async function materializePluginCopy(home: string, profile: string, pluginDir: string): Promise<string> {
  const stagedDir = join(home, 'profiles', profile, '.bundle-plugins', basename(pluginDir))
  await rm(stagedDir, { recursive: true, force: true })
  await mkdir(dirname(stagedDir), { recursive: true })
  await cp(pluginDir, stagedDir, {
    recursive: true,
    filter: src => !relative(pluginDir, src).split(sep).includes('node_modules'),
  })
  return stagedDir
}

async function pluginPackageName(pluginDir: string): Promise<string> {
  const manifestPath = join(pluginDir, 'package.json')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  } catch {
    throw new BundleError(`plugin package.json is missing or unreadable: ${manifestPath}`, 'MANIFEST_INVALID')
  }
  const name = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { name?: unknown }).name : undefined
  if (typeof name !== 'string' || name === '') {
    throw new BundleError(`plugin package.json name is missing: ${manifestPath}`, 'MANIFEST_INVALID')
  }
  return name
}

const MODEL_PLACEHOLDER_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export function resolveModelValue(value: string, env: NodeJS.ProcessEnv): string | undefined {
  const placeholder = MODEL_PLACEHOLDER_PATTERN.exec(value)
  if (placeholder === null) return value
  const name = placeholder[1]!
  const resolved = env[name]
  return resolved === undefined || resolved === '' ? undefined : resolved
}

async function writeAgentModelSelection(home: string, agent: AgentConfig, env: NodeJS.ProcessEnv): Promise<void> {
  if (agent.model === undefined) return
  const provider = resolveModelValue(agent.model.provider, env)
  const model = resolveModelValue(agent.model.model, env)
  if (provider === undefined || model === undefined) {
    return
  }
  const settingsPath = join(home, 'settings.yaml')
  let text: string
  try {
    text = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(settingsPath, stringifyYaml({ 'agent-default-model': { provider, model } }), 'utf8')
      return
    }
    throw new BundleError(`required settings file is missing or unreadable: ${settingsPath}`, 'POINTER_MISSING')
  }
  const settings = parseMappingText(text, settingsPath)
  settings['agent-default-model'] = { provider, model }
  await writeFile(settingsPath, stringifyYaml(settings), 'utf8')
}

async function warnRegistrySourcedHarnessPackages(pluginDirs: readonly string[], log: ((line: string) => void) | undefined): Promise<void> {
  for (const pluginDir of pluginDirs) {
    const pnpmDir = join(pluginDir, 'node_modules', '.pnpm')
    const entries = await readdir(pnpmDir).catch(() => [] as string[])
    const polluted = entries.filter(entry => entry.startsWith('@deepseek-ai+'))
    if (polluted.length > 0 && log !== undefined) {
      log(`warning: plugin ${basename(pluginDir)} node_modules contains registry-sourced @deepseek-ai packages (${polluted.join(', ')}); plugins must have zero harness runtime dependencies`)
    }
  }
}
