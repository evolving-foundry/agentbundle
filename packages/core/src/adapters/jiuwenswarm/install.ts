import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { JIUWENSWARM_BUNDLE_KIND, harnessNameForKind } from '../../manifest.ts'
import { BundleError } from '../../errors.ts'
import { defaultRegistryPath, installationId, upsertRecord, type InstallationRecord } from '../../registry.ts'
import { verifyBundle } from '../../verify.ts'
import { resolveModelValue } from '../dsh/install.ts'
import { uninstallInstallation } from '../uninstall.ts'
import { ADAPTER_VERSION, checkStampActivation, installHome, readInstallStamp, shouldReuseInstall, withDirLock, writeInstallStamp } from '../install-core.ts'
import { isDirectory, pathExists } from '../../bundle-paths.ts'
import { parseMappingText } from '../../yaml-file.ts'
import { resolveJiuwenswarmCommand } from './jiuwenswarm-bin.ts'
import type { JiuwenswarmBundleManifest, JiuwenswarmPackage, JiuwenswarmPackageKind } from './manifest.ts'
import type { HarnessAdapter, InstallOptions, InstallResult } from '../types.ts'

/** Reuse stamp inside the materialized data dir, shared with hermes/deepagents convention. */
const STAMP_FILE = '.bundle-install.json'

/** `.env` keys the adapter owns for the model selection; everything else stays with the caller. */
const MODEL_ENV_KEYS = ['MODEL_NAME', 'MODEL_PROVIDER', 'ENDPOINT_PROFILE'] as const

export const jiuwenswarmAdapter: HarnessAdapter = {
  kind: JIUWENSWARM_BUNDLE_KIND,
  install: installJiuwenswarmBundle,
  uninstall: uninstallInstallation,
  runtimeCheck: ({ record, log }) => checkStampActivation(record, join(record.home, STAMP_FILE), log),
  describeLaunch: ({ record }) => ({
    launchCommand: 'jiuwenswarm-process "<task>" --output json',
    launchEnv: { JIUWENSWARM_DATA_DIR: record.home },
  }),
}

export async function installJiuwenswarmBundle(options: InstallOptions): Promise<InstallResult> {
  const bundleDir = resolve(options.bundleDir)
  const verified = await verifyBundle(bundleDir)
  const manifest = verified.manifest
  if (manifest.kind !== JIUWENSWARM_BUNDLE_KIND) {
    throw new BundleError(`jiuwenswarm adapter received a ${JSON.stringify(manifest.kind)} bundle`, 'MANIFEST_INVALID')
  }
  const log = options.log
  const env = options.env ?? process.env

  // Host-runtime resolution is advisory: the install materializes a data dir and
  // never spawns, so a missing runtime only weakens the launch hint (like pi).
  const command = await resolveJiuwenswarmCommand(env)
  if (command === undefined) {
    log?.('warning: cannot resolve jiuwenswarm-process (set JIUWENSWARM_BIN or JIUWENSWARM_CHECKOUT); the installation is complete and the launch hint assumes jiuwenswarm-process on PATH')
  } else {
    log?.(`using jiuwenswarm from ${command.source}: ${command.command}`)
  }

  const registryPath = options.registryPath ?? defaultRegistryPath(env)
  const home = installHome({ kind: manifest.kind, name: manifest.name, digest: verified.digest, home: options.home, mode: options.mode ?? 'ephemeral', registryPath })
  const record: InstallationRecord = {
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
    if (shouldReuseInstall(await readInstallStamp(join(home, STAMP_FILE)), verified.digest, options.force)) {
      log?.(`reusing installation: jiuwenswarm data dir ${home}`)
      await upsertRecord(registryPath, record)
      return assemble(verified.digest, home, manifest, true, record.id)
    }

    await rm(home, { recursive: true, force: true })
    log?.(`materializing jiuwenswarm data dir ${home}`)
    if (manifest.templates !== undefined) {
      await cp(manifest.templates, home, { recursive: true })
    }
    await mkdir(join(home, 'config'), { recursive: true })
    if (manifest.skills !== undefined) {
      await materializeSkills(manifest.skills, join(home, 'agent', 'workspace', 'skills'), log)
    }
    if (manifest.packages !== undefined) {
      for (const entry of manifest.packages) {
        await materializePackage(entry, home, log)
      }
    }
    if (manifest.config !== undefined) {
      await mergeConfig(join(home, 'config', 'config.yaml'), manifest.config)
    }
    await writeModelEnv(join(home, 'config', '.env'), verified.agent, env)

    await writeInstallStamp(join(home, STAMP_FILE), verified.digest, bundleDir)
    await upsertRecord(registryPath, record)
    log?.(`installed bundle ${manifest.name} into ${home}`)
    return assemble(verified.digest, home, manifest, false, record.id)
  })
}

function assemble(digest: string, home: string, manifest: JiuwenswarmBundleManifest, reused: boolean, installationId: string): InstallResult {
  return {
    id: installationId,
    digest,
    home,
    installationId,
    harness: { name: harnessNameForKind(JIUWENSWARM_BUNDLE_KIND), versionRange: manifest.harnessVersion },
    profile: manifest.name,
    plugins: [],
    reused,
    launchCommand: 'jiuwenswarm-process "<task>" --output json',
    launchEnv: { JIUWENSWARM_DATA_DIR: home },
    ...(manifest.skills === undefined ? {} : { skills: join(home, 'agent', 'workspace', 'skills') }),
    ...(manifest.packages === undefined ? {} : { packages: manifest.packages.map(entry => `${entry.declared}:${entry.kind}`) }),
    ...(manifest.connectors === undefined ? {} : { connectors: manifest.connectors }),
    ...(manifest.config === undefined ? {} : { config: join(home, 'config', 'config.yaml') }),
  }
}

/**
 * Materialize skills into the single physical skill library
 * (`<home>/agent/workspace/skills/`) and merge `skills_state.json` the same way
 * jiuwenswarm records builtin installs (dedupe by name, marketplace "builtin").
 */
async function materializeSkills(source: string, target: string, log?: (line: string) => void): Promise<void> {
  await mkdir(target, { recursive: true })
  const names: string[] = []
  if (await isDirectory(source)) {
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      const from = join(source, entry.name)
      log?.(`materializing skill ${entry.name}`)
      await cp(from, join(target, entry.name), { recursive: true })
      names.push(entry.name)
    }
  } else {
    const name = basename(dirname(source))
    log?.(`materializing skill ${name}`)
    await mkdir(join(target, name), { recursive: true })
    await cp(source, join(target, name, 'SKILL.md'))
    names.push(name)
  }
  await mergeSkillsState(target, names)
}

async function mergeSkillsState(skillsDir: string, skillNames: readonly string[]): Promise<void> {
  if (skillNames.length === 0) return
  const statePath = join(skillsDir, 'skills_state.json')
  let state: { installed_plugins?: Array<Record<string, unknown>> }
  if (await pathExists(statePath)) {
    try {
      state = JSON.parse(await readFile(statePath, 'utf8')) as { installed_plugins?: Array<Record<string, unknown>> }
    } catch {
      state = {}
    }
  } else {
    state = {}
  }
  const plugins = state.installed_plugins ?? []
  const existing = new Set(plugins.map(entry => typeof entry['name'] === 'string' ? entry['name'] : undefined))
  for (const name of skillNames) {
    if (!existing.has(name)) {
      plugins.push({ name, marketplace: 'builtin', version: '', installed_at: new Date().toISOString() })
    }
  }
  const next: Record<string, unknown> = { marketplaces: [], local_skills: [], ...state, installed_plugins: plugins }
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/** Catalog roots mirror `extension_package_manager`: plugins/expert packages under the workspace, agent groups under `.agent_teams`. */
function packageKindRoot(kind: JiuwenswarmPackageKind, home: string): string {
  if (kind === 'agent_group') return join(home, '.agent_teams', 'agent_groups')
  const catalog = kind === 'plugin' ? 'plugin_packages' : 'agent_templates'
  return join(home, 'agent', 'workspace', 'plugins', catalog)
}

async function materializePackage(entry: JiuwenswarmPackage, home: string, log?: (line: string) => void): Promise<void> {
  const root = packageKindRoot(entry.kind, home)
  const target = join(root, 'built_in', entry.packageId)
  log?.(`materializing ${entry.kind} package ${entry.packageId}`)
  await mkdir(target, { recursive: true })
  await cp(entry.path, target, { recursive: true })
  await upsertMarketplace(root, entry.packageId)
}

/**
 * Host marketplace shape per `extension_package_manager`: the file is
 * `{"plugins": [entries]}` and each entry is slimmed to `{id, source,
 * installed}`. A bare-array file (older adapter output) is not readable by the
 * host, so reads tolerate both shapes and always write the wrapped one.
 */
async function upsertMarketplace(root: string, packageId: string): Promise<void> {
  const marketplacePath = join(root, 'marketplace.json')
  let entries: Array<Record<string, unknown>> = []
  if (await pathExists(marketplacePath)) {
    try {
      const parsed = JSON.parse(await readFile(marketplacePath, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        entries = parsed
      } else if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['plugins'])) {
        entries = (parsed as Record<string, unknown>)['plugins'] as Array<Record<string, unknown>>
      }
    } catch {
      entries = []
    }
  }
  const record: Record<string, unknown> = { id: packageId, installed: true, source: 'builtin' }
  const index = entries.findIndex(entry => entry['id'] === packageId)
  if (index >= 0) {
    entries[index] = { ...entries[index], ...record }
  } else {
    entries.push(record)
  }
  await writeFile(marketplacePath, `${JSON.stringify({ plugins: entries }, null, 2)}\n`, 'utf8')
}

/** Deep-merge the bundle's config overlay into the materialized `config/config.yaml` (plain mappings only). */
async function mergeConfig(targetPath: string, overlayPath: string): Promise<void> {
  const overlay = parseMappingText(await readFile(overlayPath, 'utf8'), overlayPath)
  const existing = await readOptionalMapping(targetPath)
  const merged = deepMerge(existing, overlay)
  await writeFile(targetPath, `${stringifyYaml(merged)}\n`, 'utf8')
}

async function readOptionalMapping(path: string): Promise<Record<string, unknown>> {
  if (!await pathExists(path)) return {}
  return parseMappingText(await readFile(path, 'utf8'), path)
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  const isMapping = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isMapping(base) || !isMapping(overlay)) return overlay
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value
  }
  return merged
}

/**
 * Model selection binds at install time into `<home>/config/.env`, mirroring the
 * template's protocol/dialect pair: `OpenAI`/`Anthropic` are protocol names,
 * anything else is an endpoint dialect under the OpenAI protocol. Missing
 * placeholder variables skip the whole section (host defaults apply); the
 * adapter never writes credentials (`API_KEY` / `API_BASE`).
 */
async function writeModelEnv(
  envPath: string,
  agent: { model?: { provider: string; model: string } },
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (agent.model === undefined) return
  const provider = resolveModelValue(agent.model.provider, env)
  const model = resolveModelValue(agent.model.model, env)
  if (provider === undefined || model === undefined) return

  const isProtocol = provider === 'OpenAI' || provider === 'Anthropic'
  const values: Readonly<Record<string, string>> = {
    MODEL_NAME: model,
    MODEL_PROVIDER: isProtocol ? provider : 'OpenAI',
    ENDPOINT_PROFILE: isProtocol ? 'openai' : provider,
  }
  const lines = await readOptionalEnvLines(envPath)
  const present = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Z0-9_]+)=/.exec(lines[i]!)
    if (match === null) continue
    const key = match[1]!
    if (key in values) {
      lines[i] = `${key}=${values[key]}`
      present.add(key)
    }
  }
  for (const key of MODEL_ENV_KEYS) {
    if (!present.has(key)) lines.push(`${key}=${values[key]}`)
  }
  await writeFile(envPath, `${lines.join('\n')}\n`, 'utf8')
}

async function readOptionalEnvLines(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text === '' ? [] : text.split(/\r?\n/)
  } catch {
    return []
  }
}
