import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathExists } from '../../bundle-paths.ts'
import { BundleError } from '../../errors.ts'
import { PI_BUNDLE_KIND, harnessNameForKind, isBundleName } from '../../manifest.ts'
import { defaultRegistryPath, installationId, removeRecord, upsertRecord, type InstallationRecord, type InstallMode } from '../../registry.ts'
import { verifyBundle } from '../../verify.ts'
import { ADAPTER_VERSION, installHome, readInstallStamp, stampMatches, withDirLock, writeInstallStamp } from '../install-core.ts'
import type { InstallOptions, InstallResult, LaunchDescription, RunPython } from '../types.ts'
import { assertVendoredOfficeCli, type PiBundleManifest } from './manifest.ts'

/** Marker written inside a native profile subtree. Owned installs keep theirs under `<home>/agent`. */
export const PI_STAMP_FILE = '.pi-bundle-install.json'
const ADDED_PATHS_FILE = '.pi-bundle-added-paths.json'
const SCALAR_SNAPSHOT_FILE = '.pi-bundle-scalars.json'
const PYTHON_LOCK_FILE = '.pi-python-lock.json'
const SOURCE_SETTINGS_FILE = '.pi-bundle-source-settings.json'
const RESOURCE_KEYS = ['packages', 'extensions', 'skills'] as const
const PROFILE_META_FILES = new Set([PI_STAMP_FILE, ADDED_PATHS_FILE, SCALAR_SNAPSHOT_FILE, PYTHON_LOCK_FILE, SOURCE_SETTINGS_FILE])
const PY_VERSION_CHECK = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'

type ResourceKey = (typeof RESOURCE_KEYS)[number]

interface AddedPathsFile {
  readonly packages: readonly string[]
  readonly extensions: readonly string[]
  readonly skills: readonly string[]
  readonly createdKeys: readonly string[]
  readonly createdSettingsFile: boolean
}

interface ScalarSnapshot {
  readonly defaultProvider: string | null
  readonly defaultModel: string | null
}

interface PythonPackage {
  readonly spec: string
  readonly kind: 'required' | 'optional'
}

/**
 * Where a native Pi install lives: the directory bare `pi` already uses.
 * `PI_CODING_AGENT_DIR` wins, otherwise `~/.pi/agent`.
 */
export function piNativeHome(env: NodeJS.ProcessEnv): string {
  const override = env['PI_CODING_AGENT_DIR']
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.pi', 'agent')
}

export function piStampPath(record: Pick<InstallationRecord, 'mode' | 'home' | 'profile' | 'piConfigDir'>): string {
  if (record.mode === 'native') return join(record.home, 'agent-bundle', record.profile, PI_STAMP_FILE)
  return join(record.piConfigDir ?? join(record.home, 'agent'), PI_STAMP_FILE)
}

export function piLaunchDescription(mode: InstallMode, agentDir: string): LaunchDescription {
  if (mode === 'native') return { launchCommand: 'pi --print "<task>"', launchEnv: {} }
  return { launchCommand: 'pi "<task>"', launchEnv: { PI_CODING_AGENT_DIR: agentDir } }
}

export function piProfileSubtree(home: string, profile: string): string {
  return join(home, 'agent-bundle', profile)
}

/**
 * Register the source bundle with the harness agent directory. Pi loads that
 * directory directly (the same shape as `dsh plugin add` linking a checkout).
 * `<home>/agent-bundle/<profile>/` keeps only the reuse stamp and settings
 * snapshots. `.venv` is created in the source bundle, where the plugin looks
 * for it. Host `auth.json` / `models.json` are not read or written.
 */
export async function installPiNative(
  options: InstallOptions,
  verified: { readonly digest: string; readonly manifest: PiBundleManifest },
  model: { readonly provider: string; readonly model: string } | undefined,
): Promise<InstallResult> {
  const manifest = verified.manifest
  const env = options.env ?? process.env
  const log = options.log
  const registryPath = options.registryPath ?? defaultRegistryPath(env)
  const home = installHome({
    kind: manifest.kind,
    name: manifest.name,
    digest: verified.digest,
    mode: 'native',
    registryPath,
    env,
  })
  const profile = options.profileName ?? `bundle-${manifest.name}`
  if (!isBundleName(profile)) {
    throw new BundleError(`profile name must match /^[a-z0-9][a-z0-9-]*$/, got ${JSON.stringify(profile)}`)
  }
  const subtree = piProfileSubtree(home, profile)
  const bundleDir = resolve(options.bundleDir)
  const record: InstallationRecord = {
    id: installationId(manifest.name, verified.digest),
    name: manifest.name,
    kind: manifest.kind,
    digest: verified.digest,
    home,
    profile,
    bundleDir,
    installedAt: new Date().toISOString(),
    mode: 'native',
    harnessVersion: manifest.harnessVersion,
    adapterVersion: ADAPTER_VERSION,
    status: 'installed',
    piConfigDir: home,
  }

  return await withDirLock(home, async () => {
    const stamp = await readInstallStamp(join(subtree, PI_STAMP_FILE))
    if (stamp === undefined && await pathExists(subtree)) {
      throw new BundleError(
        `native install refuses to take over ${subtree}: it has no agent-bundle reuse stamp; remove that directory or pass --profile to install under another name`,
        'INSTALL_CONFLICT',
      )
    }

    const createdSubtree = !await pathExists(subtree)
    await mkdir(subtree, { recursive: true })
    let settingsApplied = false
    const venvExisted = await pathExists(join(bundleDir, '.venv'))
    try {
      const office = await enableBundleOffice(manifest.settings, subtree, log)
      let digest = verified.digest
      if (office.changed) digest = (await verifyBundle(bundleDir)).digest
      const sameInstall = stampMatches(stamp, digest) || (office.changed && stampMatches(stamp, verified.digest))
      if (stamp !== undefined && !sameInstall) {
        throw new BundleError(
          `install stamp at ${join(subtree, PI_STAMP_FILE)} does not match this bundle; remove ${subtree} or pass --profile to install under another name`,
          'INSTALL_CONFLICT',
        )
      }
      const finalRecord: InstallationRecord = { ...record, digest, id: installationId(manifest.name, digest) }
      if (office.changed && digest !== verified.digest) {
        await removeRecord(registryPath, installationId(manifest.name, verified.digest)).catch(() => undefined)
      }
      log?.(stamp === undefined
        ? `registering pi bundle ${manifest.name} from ${bundleDir}`
        : `reusing installation: pi profile ${profile} in ${home}`)
      await assertVendoredOfficeCli(bundleDir, await readLock(manifest.lockfile))
      await provisionPython(bundleDir, subtree, manifest.lockfile, options.runPython, env, log)
      await writeInstallStamp(join(subtree, PI_STAMP_FILE), digest, bundleDir)
      await syncResourcePaths(home, subtree, profile, manifest)
      if (model !== undefined) await writeModelSelection(home, subtree, model)
      settingsApplied = true
      await dropCopiedBundle(subtree)
      await upsertRecord(registryPath, finalRecord)
      log?.(`installed pi bundle ${manifest.name} into ${home}`)
      return assembleNative(digest, home, profile, manifest, stamp !== undefined)
    } catch (error) {
      if (settingsApplied) await restorePiNativeSettings(home, subtree, log).catch(() => undefined)
      await restoreSourceSettings(subtree).catch(() => undefined)
      if (!venvExisted) await rm(join(bundleDir, '.venv'), { recursive: true, force: true })
      if (createdSubtree) await rm(subtree, { recursive: true, force: true })
      throw error
    }
  })
}

/**
 * Restore host settings from this profile's snapshot, then delete only the
 * profile subtree. The agent directory itself (auth, models, other profiles) stays.
 */
export async function removePiNativeProfile(
  record: Pick<InstallationRecord, 'home' | 'profile'>,
  log?: (line: string) => void,
): Promise<boolean> {
  const subtree = piProfileSubtree(record.home, record.profile)
  return await withDirLock(record.home, async () => {
    await restorePiNativeSettings(record.home, subtree, log)
    await restoreSourceSettings(subtree)
    const existed = await pathExists(subtree)
    if (existed) await rm(subtree, { recursive: true, force: true })
    return existed
  })
}

/** Drop this profile's settings entries. The snapshot lives inside the subtree, so this runs before that directory is deleted. */
export async function restorePiNativeSettings(home: string, subtree: string, log?: (line: string) => void): Promise<void> {
  const settingsPath = join(home, 'settings.json')
  const added = await readJsonFile<AddedPathsFile>(join(subtree, ADDED_PATHS_FILE))
  const scalars = await readJsonFile<ScalarSnapshot>(join(subtree, SCALAR_SNAPSHOT_FILE))
  if (!await pathExists(settingsPath)) {
    if (added === undefined && scalars === undefined) {
      log?.(`settings snapshot is missing under ${subtree}; host settings.json was left unchanged`)
    }
    return
  }
  let settings: Record<string, unknown>
  try {
    settings = asObject(JSON.parse(await readFile(settingsPath, 'utf8')))
  } catch {
    log?.(`host settings.json at ${settingsPath} is not valid JSON; left it unchanged`)
    return
  }
  let changed = added !== undefined
  if (added !== undefined) {
    for (const key of RESOURCE_KEYS) {
      if (added[key].length === 0) continue
      const drop = new Set(added[key].map(normalizePath))
      const current = stringArray(settings[key])
      const remaining = current.filter(item => !drop.has(normalizePath(item)))
      if (remaining.length === 0 && added.createdKeys.includes(key)) delete settings[key]
      else settings[key] = remaining
    }
  } else {
    const prefix = `agent-bundle/${basename(subtree)}`
    let stripped = false
    for (const key of RESOURCE_KEYS) {
      if (!Array.isArray(settings[key])) continue
      const current = stringArray(settings[key])
      const remaining = current.filter(item => {
        const normalized = normalizePath(item)
        return normalized !== prefix && !normalized.startsWith(`${prefix}/`)
      })
      if (remaining.length === current.length) continue
      settings[key] = remaining
      stripped = true
    }
    if (stripped) changed = true
    log?.(stripped
      ? `resource-path snapshot is missing under ${subtree}; removed settings paths under ${prefix} and left other keys unchanged`
      : `resource-path snapshot is missing under ${subtree}; resource keys in settings.json were left unchanged`)
  }
  if (scalars !== undefined) {
    changed = true
    restoreScalar(settings, 'defaultProvider', scalars.defaultProvider)
    restoreScalar(settings, 'defaultModel', scalars.defaultModel)
  }
  if (!changed) return
  if (added?.createdSettingsFile === true && Object.keys(settings).length === 0) {
    await rm(settingsPath, { force: true })
    return
  }
  await writeJsonAtomic(settingsPath, settings)
}

function assembleNative(
  digest: string,
  home: string,
  profile: string,
  manifest: PiBundleManifest,
  reused: boolean,
): InstallResult {
  const id = installationId(manifest.name, digest)
  return {
    id,
    digest,
    home,
    installationId: id,
    harness: { name: harnessNameForKind(PI_BUNDLE_KIND), versionRange: manifest.harnessVersion },
    profile,
    plugins: [],
    reused,
    ...piLaunchDescription('native', home),
    codingAgentDir: home,
    instructions: manifest.instructions,
    skills: manifest.skills,
    extensions: manifest.extensions.map(extension => extension.declared),
  }
}

/**
 * Point host settings at the source bundle. Paths already registered (including
 * a pre-existing `packages` entry for the same directory) are left in place and
 * not added a second time. Paths that belong to an older copied profile subtree
 * are removed. The snapshot records only the paths this install added.
 */
async function syncResourcePaths(
  home: string,
  subtree: string,
  profile: string,
  manifest: PiBundleManifest,
): Promise<void> {
  const settingsPath = join(home, 'settings.json')
  const createdSettingsFile = !await pathExists(settingsPath)
  const settings = createdSettingsFile ? {} : asObject(JSON.parse(await readFile(settingsPath, 'utf8')))
  const previous = await readJsonFile<AddedPathsFile>(join(subtree, ADDED_PATHS_FILE))
  for (const key of ['extensions', 'skills'] as const) {
    if (!(key in settings)) continue
    if (!Array.isArray(settings[key])) {
      throw new BundleError(`host settings.json ${key} must be an array of strings so native install can append to it`, 'MANIFEST_INVALID')
    }
    const owned = new Set((previous?.[key] ?? []).map(normalizePath))
    settings[key] = stringArray(settings[key]).filter(item => !owned.has(normalizePath(item)) && !isOwnedCopyPath(home, profile, item))
  }
  const paths = sourceResourcePaths(manifest)
  const createdKeys: string[] = []
  const addedExtensions = appendMissing(settings, 'extensions', paths.extensions.filter(path => !alreadyRegistered(home, settings, path)), createdKeys)
  const addedSkills = appendMissing(settings, 'skills', paths.skills.filter(path => !alreadyRegistered(home, settings, path)), createdKeys)
  const added: AddedPathsFile = {
    packages: [],
    extensions: addedExtensions,
    skills: addedSkills,
    createdKeys: [...new Set([...(previous?.createdKeys ?? []), ...createdKeys])],
    createdSettingsFile: previous?.createdSettingsFile === true || createdSettingsFile,
  }
  await writeJsonAtomic(join(subtree, ADDED_PATHS_FILE), added)
  await writeJsonAtomic(settingsPath, settings)
}

async function writeModelSelection(
  home: string,
  subtree: string,
  model: { readonly provider: string; readonly model: string },
): Promise<void> {
  if (await pathExists(join(subtree, SCALAR_SNAPSHOT_FILE))) return
  const settingsPath = join(home, 'settings.json')
  const settings = await pathExists(settingsPath)
    ? asObject(JSON.parse(await readFile(settingsPath, 'utf8')))
    : {}
  const snapshot: ScalarSnapshot = {
    defaultProvider: typeof settings['defaultProvider'] === 'string' ? settings['defaultProvider'] : null,
    defaultModel: typeof settings['defaultModel'] === 'string' ? settings['defaultModel'] : null,
  }
  settings['defaultProvider'] = model.provider
  settings['defaultModel'] = model.model
  await writeJsonAtomic(join(subtree, SCALAR_SNAPSHOT_FILE), snapshot)
  await writeJsonAtomic(settingsPath, settings)
}

function sourceResourcePaths(manifest: PiBundleManifest): { readonly extensions: string[]; readonly skills: string[] } {
  return {
    extensions: manifest.extensions.map(extension => extension.path),
    skills: [manifest.skills],
  }
}

function appendMissing(
  settings: Record<string, unknown>,
  key: 'extensions' | 'skills',
  adding: readonly string[],
  createdKeys: string[],
): string[] {
  if (adding.length === 0) return []
  if (!(key in settings)) createdKeys.push(key)
  else if (!Array.isArray(settings[key])) {
    throw new BundleError(`host settings.json ${key} must be an array of strings so native install can append to it`, 'MANIFEST_INVALID')
  }
  const current = stringArray(settings[key])
  settings[key] = [...current, ...adding]
  return [...adding]
}

function alreadyRegistered(home: string, settings: Record<string, unknown>, target: string): boolean {
  const candidates = [
    ...stringArray(settings['extensions']),
    ...stringArray(settings['skills']),
    ...packageSources(settings['packages']),
  ]
  return candidates.some(existing => samePath(home, existing, target))
}

function packageSources(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const sources: string[] = []
  for (const item of value) {
    if (typeof item === 'string') sources.push(item)
    else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const source = (item as { source?: unknown }).source
      if (typeof source === 'string') sources.push(source)
    }
  }
  return sources
}

function samePath(home: string, existing: string, target: string): boolean {
  const targetPath = normalizePath(resolve(target))
  if (normalizePath(existing) === targetPath) return true
  return normalizePath(resolve(home, existing)) === targetPath
}

function isOwnedCopyPath(home: string, profile: string, item: string): boolean {
  const normalized = normalizePath(item)
  const marker = `agent-bundle/${profile}`
  if (normalized === marker || normalized.startsWith(`${marker}/`)) return true
  const absolute = normalizePath(resolve(home, item))
  const subtree = normalizePath(piProfileSubtree(home, profile))
  return absolute === subtree || absolute.startsWith(`${subtree}/`)
}

/** Remove a bundle tree copied by an older native install. Stamp files stay. */
async function dropCopiedBundle(subtree: string): Promise<void> {
  if (!await pathExists(subtree)) return
  const entries = await readdir(subtree)
  await Promise.all(entries
    .filter(name => !PROFILE_META_FILES.has(name))
    .map(name => rm(join(subtree, name), { recursive: true, force: true })))
}

async function provisionPython(
  bundleDir: string,
  subtree: string,
  lockfile: string | undefined,
  runPython: RunPython | undefined,
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): Promise<void> {
  const packages = await pythonPackages(lockfile)
  if (packages.length === 0) return
  if (runPython === undefined) {
    throw new BundleError('pi native install requires a runPython seam to provision the office Python toolchain (the agent-bundle CLI provides one)')
  }
  const required = packages.filter(entry => entry.kind === 'required').map(entry => entry.spec)
  const optional = packages.filter(entry => entry.kind === 'optional').map(entry => entry.spec)
  const hash = createHash('sha256').update(JSON.stringify(packages)).digest('hex')
  const interpreter = venvPython(bundleDir)
  const recorded = await readJsonFile<{ hash?: string }>(join(subtree, PYTHON_LOCK_FILE))
  if (recorded?.hash === hash && await pathExists(interpreter)) {
    log?.(`reusing python venv at ${dirname(interpreter)}`)
    return
  }
  await createVenv(bundleDir, runPython, env, log)
  if (required.length > 0) {
    log?.(`installing required python packages: ${required.join(' ')}`)
    await pipInstall(runPython, env, interpreter, required)
  }
  for (const spec of optional) {
    try {
      await pipInstall(runPython, env, interpreter, [spec])
    } catch (error) {
      log?.(`warning: optional python package ${spec} was not installed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await writeJsonAtomic(join(subtree, PYTHON_LOCK_FILE), { hash })
}

async function pythonPackages(lockfile: string | undefined): Promise<PythonPackage[]> {
  const lock = await readLock(lockfile)
  if (lock === undefined) return []
  const python = lock['python']
  if (python === null || typeof python !== 'object' || Array.isArray(python)) return []
  const packages = (python as { packages?: unknown }).packages
  if (!Array.isArray(packages)) return []
  const selected: PythonPackage[] = []
  for (const entry of packages) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { package?: unknown; kind?: unknown; pin?: unknown; requires?: unknown }
    if (typeof record.package !== 'string' || record.package === '') continue
    if (record.kind !== 'required' && record.kind !== 'optional') continue
    const requires = record.requires
    if (requires !== undefined && requires !== null && typeof requires === 'object' && !Array.isArray(requires)) {
      const platform = (requires as { platform?: unknown }).platform
      if (typeof platform === 'string' && platform !== process.platform) continue
    }
    const spec = typeof record.pin === 'string' && record.pin !== '' ? `${record.package}==${record.pin}` : record.package
    selected.push({ spec, kind: record.kind })
  }
  return selected
}

async function createVenv(
  subtree: string,
  runPython: RunPython,
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): Promise<void> {
  const target = join(subtree, '.venv')
  const uv = await findUv(env)
  if (uv !== undefined) {
    log?.(`creating venv with uv: ${uv}`)
    // --seed puts pip into the venv. Package installation uses that pip, matching
    // Pi scripts/deps.mjs. `uv pip` rejects transitive pre-release
    // markers (markitdown[all] -> azure-ai-contentunderstanding>=1.2.0b1) unless
    // --prerelease=allow, which also selects unrelated pre-releases pip does not.
    await runPython(uv, ['venv', '--python', '3.12', '--seed', target], {})
    return
  }
  const python = await findPython(env)
  log?.(`using python from ${python.source}: ${python.command}`)
  try {
    await runPython(python.command, ['-c', PY_VERSION_CHECK], {})
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new BundleError(`pi native install requires Python >= 3.10 (${python.command}): ${detail}`, 'RUNTIME_UNRESOLVED')
  }
  log?.(`creating venv ${target}`)
  await runPython(python.command, ['-m', 'venv', target], {})
}

async function pipInstall(runPython: RunPython, _env: NodeJS.ProcessEnv, interpreter: string, specs: readonly string[]): Promise<void> {
  await runPython(interpreter, ['-m', 'pip', 'install', ...specs], {})
}

function venvPython(subtree: string): string {
  return process.platform === 'win32'
    ? join(subtree, '.venv', 'Scripts', 'python.exe')
    : join(subtree, '.venv', 'bin', 'python')
}

async function findUv(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const explicit = env['UV_BIN']
  if (explicit !== undefined && explicit !== '') return await pathExists(explicit) ? explicit : undefined
  return await scanPath(process.platform === 'win32' ? ['uv.exe', 'uv'] : ['uv'], env)
}

async function findPython(env: NodeJS.ProcessEnv): Promise<{ readonly command: string; readonly source: string }> {
  const explicit = env['PYTHON_BIN']
  if (explicit !== undefined && explicit !== '') {
    if (!await pathExists(explicit)) {
      throw new BundleError(`PYTHON_BIN points to a missing file: ${explicit}`, 'RUNTIME_UNRESOLVED')
    }
    return { command: explicit, source: 'PYTHON_BIN' }
  }
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe', 'python', 'python3'] : ['python3', 'python']
  const found = await scanPath(names, env)
  if (found === undefined) {
    throw new BundleError('cannot resolve a python interpreter: install Python >= 3.10 or set PYTHON_BIN or UV_BIN', 'RUNTIME_UNRESOLVED')
  }
  return { command: found, source: 'PATH' }
}

async function scanPath(names: readonly string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathEnv = env['PATH'] ?? ''
  for (const dir of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (await pathExists(candidate)) return candidate
    }
  }
  return undefined
}

async function readLock(lockfile: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (lockfile === undefined || !await pathExists(lockfile)) return undefined
  const parsed: unknown = JSON.parse(await readFile(lockfile, 'utf8'))
  return asObject(parsed)
}

function restoreScalar(settings: Record<string, unknown>, key: 'defaultProvider' | 'defaultModel', previous: string | null): void {
  if (previous === null) delete settings[key]
  else settings[key] = previous
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BundleError('settings.json must be a JSON object', 'MANIFEST_INVALID')
  }
  return value as Record<string, unknown>
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  if (!await pathExists(path)) return undefined
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function restoreSourceSettings(subtree: string): Promise<void> {
  const snapshot = await readJsonFile<{ path?: string; text?: string }>(join(subtree, SOURCE_SETTINGS_FILE))
  if (typeof snapshot?.path !== 'string' || typeof snapshot.text !== 'string') return
  await writeFile(snapshot.path, snapshot.text, 'utf8')
}

/**
 * Turn on office in the bundle settings file the plugin actually reads.
 * The previous text is kept in the profile snapshot and written back on uninstall.
 */
async function enableBundleOffice(
  settingsPath: string,
  subtree: string,
  log?: (line: string) => void,
): Promise<{ changed: boolean }> {
  const text = await readFile(settingsPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new BundleError(`bundle settings.json is not valid JSON (${settingsPath}): ${detail}`, 'MANIFEST_INVALID')
  }
  const raw = asObject(parsed)
  const office = raw['office']
  const current = office !== null && typeof office === 'object' && !Array.isArray(office)
    ? office as Record<string, unknown>
    : {}
  if (current['enabled'] === true && current['readOnly'] === false) return { changed: false }
  const snapshotPath = join(subtree, SOURCE_SETTINGS_FILE)
  if (!await pathExists(snapshotPath)) {
    await writeJsonAtomic(snapshotPath, { path: settingsPath, text })
  }
  const version = raw['version'] === undefined ? 1 : raw['version']
  const next = { ...raw, version, office: { ...current, enabled: true, readOnly: false } }
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  log?.(`enabled office in ${settingsPath}`)
  return { changed: true }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
