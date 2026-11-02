import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { PI_BUNDLE_KIND, harnessNameForKind } from '../../manifest.ts'
import { BundleError } from '../../errors.ts'
import { defaultRegistryPath, installationId, upsertRecord, type InstallationRecord, type InstallMode } from '../../registry.ts'
import { resolvePiCommand, type PiCommand } from '../../pi-bin.ts'
import { verifyBundle } from '../../verify.ts'
import { resolveModelValue } from '../dsh/install.ts'
import { uninstallInstallation } from '../uninstall.ts'
import { ADAPTER_VERSION, checkStampActivation, installHome, readInstallStamp, shouldReuseInstall, withDirLock, writeInstallStamp } from '../install-core.ts'
import { isDirectory, pathExists, readJsonFile } from '../../bundle-paths.ts'
import { readPiSettingsIfPresent, expandExtensionEntry, type PiBundleManifest, type PiExtensionResource } from './manifest.ts'
import { installPiNative, piLaunchDescription, piStampPath } from './native.ts'
import type { HarnessAdapter, InstallOptions, InstallResult } from '../types.ts'

export const piAdapter: HarnessAdapter = {
  kind: PI_BUNDLE_KIND,
  install: installPiBundle,
  uninstall: uninstallInstallation,
  runtimeCheck: ({ record, log }) => checkStampActivation(record, piStampPath(record), log),
  describeLaunch: ({ record }) => piLaunchDescription(record.mode, record.piConfigDir ?? join(record.home, AGENT_DIR)),
}

/** Marker written inside the ephemeral Pi config directory to detect reuse. */
const STAMP_FILE = '.pi-bundle-install.json'
/** Harness config directory inside the materialized home, exported as PI_CODING_AGENT_DIR. */
const AGENT_DIR = 'agent'
/** Resource directories the adapter materializes; never taken from bundle settings. */
const ADAPTER_OWNED_SETTINGS = ['packages', 'extensions', 'skills'] as const

export async function installPiBundle(options: InstallOptions): Promise<InstallResult> {
  const bundleDir = resolve(options.bundleDir)
  const verified = await verifyBundle(bundleDir)
  const manifest = verified.manifest
  if (manifest.kind !== PI_BUNDLE_KIND) {
    throw new BundleError(`pi adapter received a ${JSON.stringify(manifest.kind)} bundle`, 'MANIFEST_INVALID')
  }
  const log = options.log
  const env = options.env ?? process.env
  // An explicit --home stays an owned isolation directory. Native is only the
  // no-home default, matching the harness directory bare `pi` already uses.
  const mode: InstallMode = options.home !== undefined && options.mode === 'native'
    ? 'ephemeral'
    : (options.mode ?? 'ephemeral')
  if (mode === 'native') {
    await resolvePiRuntime(env, log)
    return installPiNative(options, { digest: verified.digest, manifest }, resolvePiModelSelection(verified.agent, env, log))
  }

  const pi = await resolvePiRuntime(env, log)
  const registryPath = options.registryPath ?? defaultRegistryPath(env)
  const home = installHome({ kind: manifest.kind, name: manifest.name, digest: verified.digest, home: options.home, mode, registryPath })
  const agentDir = join(home, AGENT_DIR)
  const profile = options.profileName ?? manifest.name

  const record: InstallationRecord = {
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
    piConfigDir: agentDir,
  }

  return await withDirLock(home, async () => {
    if (shouldReuseInstall(await readInstallStamp(join(agentDir, STAMP_FILE)), verified.digest, options.force)) {
      log?.(`reusing installation: pi home ${home}`)
      await upsertRecord(registryPath, record)
      return assemble(verified.digest, home, agentDir, profile, manifest, true, record.id, mode)
    }

    await rm(home, { recursive: true, force: true })
    log?.(`materializing pi home ${home}`)
    await mkdir(agentDir, { recursive: true })

    const instructions = join(agentDir, 'AGENTS.md')
    await cp(manifest.instructions, instructions)
    const skills = join(agentDir, 'skills')
    await materializeSkills(manifest.skills, skills)

    const staged: Array<{ declared: string; from: string; to: string }> = []
    const stagedExtensions: string[] = []
    for (const extension of manifest.extensions) {
      const target = join(agentDir, 'extensions', await stagedName(extension, staged))
      log?.(`materializing extension ${extension.declared} as ${target}`)
      await cp(extension.path, target, { recursive: true, filter: source => !SKIPPED_DIRECTORIES.has(basename(source)) })
      staged.push({ declared: extension.declared, from: extension.path, to: target })
      stagedExtensions.push(target)
    }
    await assertStagedEntries(staged)

    const model = resolvePiModelSelection(verified.agent, env, log)
    const settingsPath = join(agentDir, 'settings.json')
    const settings = await mergePiSettings(settingsPath, manifest, stagedExtensions, model)
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

    await writeInstallStamp(join(agentDir, STAMP_FILE), verified.digest, bundleDir)
    await upsertRecord(registryPath, record)
    log?.(`installed pi bundle ${manifest.name} into ${home}`)
    return assemble(verified.digest, home, agentDir, profile, manifest, false, record.id, mode)
  })
}

interface PiModelSelection {
  readonly provider: string
  readonly model: string
}

/**
 * Model selection follows the dsh adapter: `agent.yaml` values may be `${ENV}`
 * placeholders resolved at install time; a missing variable means the selection
 * is left to the host Pi configuration instead of being written partially.
 */
export function resolvePiModelSelection(
  agent: { readonly model?: { readonly provider: string; readonly model: string } },
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): PiModelSelection | undefined {
  if (agent.model === undefined) return undefined
  const provider = resolveModelValue(agent.model.provider, env)
  const model = resolveModelValue(agent.model.model, env)
  if (provider === undefined || model === undefined) {
    log?.('agent.yaml model placeholders could not be resolved from the environment; leaving the Pi model selection to the host configuration')
    return undefined
  }
  return { provider, model }
}

async function mergePiSettings(
  settingsPath: string,
  manifest: PiBundleManifest,
  stagedExtensions: readonly string[],
  model: PiModelSelection | undefined,
): Promise<Record<string, unknown>> {
  const bundleSettings = await readPiSettingsIfPresent(manifest.settings)
  const existing = await readPiSettingsIfPresent(settingsPath)
  const settings: Record<string, unknown> = { ...(existing ?? {}), ...(bundleSettings ?? {}) }
  // Resource mapping is owned by the adapter; a bundle settings file cannot
  // redirect which extensions or skills this installation loads.
  for (const key of ADAPTER_OWNED_SETTINGS) delete settings[key]
  settings['extensions'] = stagedExtensions.map(extension => extension.replaceAll('\\', '/'))
  settings['skills'] = ['skills']
  if (model !== undefined) {
    settings['defaultProvider'] = model.provider
    settings['defaultModel'] = model.model
  }
  return settings
}

async function materializeSkills(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  if (await isDirectory(source)) {
    await cp(source, target, { recursive: true, filter: path => !SKIPPED_DIRECTORIES.has(basename(path)) })
    return
  }
  // A single skill file: Pi discovers `<dir>/SKILL.md`.
  const name = basename(source) === 'SKILL.md' ? basename(dirname(source)) : basename(source, '.md')
  const directory = join(target, name === '' ? 'skill' : name)
  await mkdir(directory, { recursive: true })
  await cp(source, join(directory, 'SKILL.md'))
}

function stagedName(extension: PiExtensionResource, staged: readonly { declared: string }[]): string {
  const base = extension.kind === 'package' ? basename(extension.path) : basename(extension.path).replace(/\.[^.]+$/, '')
  const taken = new Set(staged.map(entry => basename(entry.declared.replace(/[/\\]+$/, ''))))
  if (!taken.has(base)) return base
  return `${base}-${staged.length + 1}`
}

/**
 * Confirm the materialized copies still declare loadable entries. Copying is not
 * a build step: a package whose declared entry is absent fails here with a cause
 * the caller can act on instead of failing later inside Pi.
 */
async function assertStagedEntries(staged: readonly { declared: string; from: string; to: string }[]): Promise<void> {
  for (const entry of staged) {
    const manifestPath = join(entry.to, 'package.json')
    if (!await pathExists(manifestPath)) {
      if (!await pathExists(entry.to)) {
        throw new BundleError(`materialized extension ${entry.declared} is missing at ${entry.to}`, 'POINTER_MISSING')
      }
      continue
    }
    const manifest = await readJsonFile(manifestPath, `materialized Pi package ${entry.declared} package.json`)
    const declaredEntries = (manifest['pi'] as { extensions?: unknown } | undefined)?.extensions
    if (!Array.isArray(declaredEntries)) continue
    for (const declaredEntry of declaredEntries) {
      if (typeof declaredEntry !== 'string' || declaredEntry === '') continue
      const matches = await expandExtensionEntry(entry.declared, entry.to, declaredEntry)
      if (matches.length === 0) {
        throw new BundleError(`materialized Pi package ${entry.declared} declares pi.extensions ${JSON.stringify(declaredEntry)} which was not materialized from ${entry.from}`, 'POINTER_MISSING')
      }
    }
  }
}

function assemble(
  digest: string,
  home: string,
  agentDir: string,
  profile: string,
  manifest: PiBundleManifest,
  reused: boolean,
  installationId: string,
  mode: InstallMode,
): InstallResult {
  return {
    id: installationId,
    digest,
    home,
    installationId,
    harness: { name: harnessNameForKind(PI_BUNDLE_KIND), versionRange: manifest.harnessVersion },
    profile,
    plugins: [],
    reused,
    ...piLaunchDescription(mode, agentDir),
    codingAgentDir: agentDir,
    instructions: join(agentDir, 'AGENTS.md'),
    skills: join(agentDir, 'skills'),
    extensions: manifest.extensions.map(extension => extension.declared),
  }
}

/**
 * Resolve the pi runtime that the returned launch hint assumes. A missing
 * runtime is reported, not fatal: installing a bundle does not require pi to be
 * on PATH, and the caller may launch it later.
 */
async function resolvePiRuntime(
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): Promise<PiCommand | undefined> {
  try {
    const command = await resolvePiCommand(env)
    log?.(`using pi from ${command.source}: ${[command.command, ...command.args].join(' ')}`)
    return command
  } catch (error) {
    log?.(`warning: ${error instanceof Error ? error.message : String(error)}; the installation is complete and the launch hint assumes pi on PATH`)
    return undefined
  }
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])
