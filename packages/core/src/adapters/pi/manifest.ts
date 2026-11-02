import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { BundleError } from '../../errors.ts'
import {
  isDirectory,
  isFile,
  packageEntryTarget,
  pathExists,
  readJsonFile,
  readOptionalJsonFile,
  resolveInBundle,
} from '../../bundle-paths.ts'
import { pathExists as lstatExists, readMappingFile } from '../../yaml-file.ts'
import { assertVersionRange } from './range.ts'

export const PI_BUNDLE_KIND = 'pi-agent-bundle'
export const PI_HARNESS_NAME = 'pi'
/**
 * Not part of the candidate snapshot: `dist/` is Pi Package build output, and
 * `.venv` is the interpreter native install creates in the source bundle.
 */
export const PI_DIGEST_EXCLUDED_DIRECTORIES = ['dist', '.venv'] as const

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export interface PiExtensionResource {
  /** The declared path exactly as written in bundle.yaml. */
  readonly declared: string
  /** Absolute path of the extension file or Pi package directory. */
  readonly path: string
  readonly kind: 'file' | 'package'
  /** Only for package directories: `package.json` name/version, when present. */
  readonly packageName?: string
  readonly packageVersion?: string
}

export interface PiBundleManifest {
  readonly name: string
  readonly kind: typeof PI_BUNDLE_KIND
  readonly schemaVersion: number
  readonly harnessVersion: string
  readonly instructions: string
  readonly skills: string
  readonly settings: string
  readonly extensions: readonly PiExtensionResource[]
  readonly lockfile?: string
}

/**
 * Pi's native settings. The bundle ships a settings file that configures the
 * harness itself (for example UI and feature settings); the adapter
 * owns the resource mapping keys and merges whatever else the bundle declares.
 */
export interface PiSettings {
  readonly defaultProvider?: string
  readonly defaultModel?: string
  readonly raw: Record<string, unknown>
}

/** `agent.yaml` is optional for Pi bundles and currently only carries the model selection. */
export interface PiAgentConfig {
  readonly model?: {
    readonly provider: string
    readonly model: string
  }
}

/**
 * Entry paths a Pi package declares under `pi.extensions`. Pi-only, so it lives
 * with the adapter rather than in the cross-kind `bundle-paths.ts`.
 */
export function piExtensionEntries(manifest: Record<string, unknown>): string[] | undefined {
  const pi = manifest['pi']
  if (typeof pi !== 'object' || pi === null) return undefined
  const extensions = (pi as Record<string, unknown>)['extensions']
  if (extensions === undefined) return undefined
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new BundleError(`package.json pi.extensions must be a non-empty array of relative entry paths, got ${JSON.stringify(extensions)}`, 'MANIFEST_INVALID')
  }
  return extensions.map((entry) => {
    if (typeof entry !== 'string' || entry === '') {
      throw new BundleError(`package.json pi.extensions entries must be non-empty relative strings, got ${JSON.stringify(entry)}`, 'MANIFEST_INVALID')
    }
    resolveInBundle('.', entry, 'package.json pi.extensions entry')
    return entry
  })
}

export async function parsePiBundleManifest(bundleDir: string, raw: Record<string, unknown>): Promise<PiBundleManifest> {
  if (raw['schemaVersion'] !== 1) {
    throw new BundleError(`bundle.yaml schemaVersion must be 1, got ${JSON.stringify(raw['schemaVersion'])}`, 'MANIFEST_INVALID')
  }
  if (typeof raw['name'] !== 'string' || !NAME_PATTERN.test(raw['name'])) {
    throw new BundleError(`bundle.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(raw['name'])}`, 'MANIFEST_INVALID')
  }
  const harness = raw['harness'] as { name?: unknown; version?: unknown } | undefined
  if (harness?.name !== PI_HARNESS_NAME) {
    throw new BundleError(`bundle.yaml harness.name must be ${JSON.stringify(PI_HARNESS_NAME)}, got ${JSON.stringify(harness)}`, 'MANIFEST_INVALID')
  }
  if (typeof harness.version !== 'string' || harness.version === '') {
    throw new BundleError('bundle.yaml harness.version must be a non-empty compat range string (e.g. ">=0.1 <0.2")', 'MANIFEST_INVALID')
  }
  assertVersionRange(harness.version)

  const instructions = await requireTarget(bundleDir, raw['instructions'], 'instructions')
  if (!await isFile(instructions)) {
    throw new BundleError(`bundle.yaml instructions must be a file Pi and the plugin can read, got a directory: ${instructions}`, 'POINTER_MISSING')
  }
  const skills = await requireTarget(bundleDir, raw['skills'], 'skills')
  await assertSkillsLoadable(skills)
  const settings = await requireTarget(bundleDir, raw['settings'], 'settings')
  const lockfile = raw['lockfile'] === undefined
    ? undefined
    : await requireTarget(bundleDir, raw['lockfile'], 'lockfile')
  if (lockfile !== undefined) await assertPiLockfile(bundleDir, lockfile)

  const declaredExtensions = raw['extensions']
  if (!Array.isArray(declaredExtensions) || declaredExtensions.length === 0) {
    throw new BundleError('bundle.yaml extensions must be a non-empty list of relative paths to extension files or Pi packages', 'MANIFEST_INVALID')
  }
  const extensions: PiExtensionResource[] = []
  for (const declared of declaredExtensions) {
    if (typeof declared !== 'string') {
      throw new BundleError(`bundle.yaml extensions entries must be relative strings, got ${JSON.stringify(declared)}`, 'MANIFEST_INVALID')
    }
    const path = resolveInBundle(bundleDir, declared, `bundle.yaml extension ${JSON.stringify(declared)}`)
    extensions.push(await describeExtension(bundleDir, declared, path))
  }
  return {
    name: raw['name'],
    kind: PI_BUNDLE_KIND,
    schemaVersion: 1,
    harnessVersion: harness.version,
    instructions,
    skills,
    settings,
    extensions,
    ...(lockfile === undefined ? {} : { lockfile }),
  }
}

async function requireTarget(bundleDir: string, declared: unknown, label: string): Promise<string> {
  if (typeof declared !== 'string' || declared === '') {
    throw new BundleError(`bundle.yaml ${label} must be a relative path inside the bundle, got ${JSON.stringify(declared)}`, 'PATH_ESCAPE')
  }
  const path = resolveInBundle(bundleDir, declared, `bundle.yaml ${label}`)
  if (!await pathExists(path)) {
    throw new BundleError(`bundle.yaml ${label} points to a missing path: ${path}`, 'POINTER_MISSING')
  }
  return path
}

async function describeExtension(bundleDir: string, declared: string, path: string): Promise<PiExtensionResource> {
  if (await isDirectory(path)) {
    const manifestPath = join(path, 'package.json')
    if (!await isFile(manifestPath)) {
      throw new BundleError(`bundle Pi package ${declared} has no package.json at ${path}`, 'POINTER_MISSING')
    }
    const manifest = await readJsonFile(manifestPath, `bundle Pi package ${declared} package.json`)
    await validatePiPackageEntries(bundleDir, declared, path, manifest)
    const packageName = typeof manifest['name'] === 'string' ? manifest['name'] : undefined
    const packageVersion = typeof manifest['version'] === 'string' ? manifest['version'] : undefined
    return {
      declared,
      path,
      kind: 'package',
      ...(packageName === undefined ? {} : { packageName }),
      ...(packageVersion === undefined ? {} : { packageVersion }),
    }
  }
  if (await isFile(path)) {
    await assertImportClosure(bundleDir, [path], new Set())
    return { declared, path, kind: 'file' }
  }
  throw new BundleError(`bundle.yaml extension ${declared} points to a missing path: ${path}`, 'POINTER_MISSING')
}

/**
 * A Pi package must declare loadable entries. `pi.extensions` wins when present;
 * otherwise Pi falls back to convention directories and a package entry point.
 */
async function validatePiPackageEntries(bundleDir: string, declared: string, packageDir: string, manifest: Record<string, unknown>): Promise<void> {
  const dependencies = manifest['dependencies']
  if (dependencies !== undefined && dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies) && Object.keys(dependencies).length > 0) {
    throw new BundleError(`bundle Pi package ${declared} declares runtime dependencies ${JSON.stringify(Object.keys(dependencies))}; a local install does not run npm install and does not copy node_modules, so Pi could not load it`, 'MANIFEST_INVALID')
  }
  const peers = peerNames(manifest)
  const entries = piExtensionEntries(manifest)
  const files: string[] = []
  if (entries !== undefined) {
    for (const entry of entries) {
      const matches = await expandExtensionEntry(declared, packageDir, entry)
      if (matches.length === 0) {
        throw new BundleError(`bundle Pi package ${declared} declares pi.extensions ${JSON.stringify(entry)} which matches no file under ${packageDir} (build the package first)`, 'POINTER_MISSING')
      }
      files.push(...matches)
    }
  } else {
    const conventionsDir = join(packageDir, 'extensions')
    if (await isDirectory(conventionsDir)) {
      for (const name of await readdir(conventionsDir)) {
        if (!name.endsWith('.js') && !name.endsWith('.ts')) continue
        const file = join(conventionsDir, name)
        if (await isFile(file)) files.push(file)
      }
    } else {
      const target = packageEntryTarget(manifest)
      if (target === undefined) {
        throw new BundleError(`bundle Pi package ${declared} declares neither pi.extensions nor an "extensions/" directory nor a package entry point`, 'MANIFEST_INVALID')
      }
      const entryPath = resolveInBundle(packageDir, target, `bundle Pi package ${declared} entry`)
      if (!await isFile(entryPath)) {
        throw new BundleError(`bundle Pi package ${declared} entry ${JSON.stringify(target)} is missing at ${entryPath}`, 'POINTER_MISSING')
      }
      files.push(entryPath)
    }
  }
  await assertImportClosure(bundleDir, files, peers)
}

/**
 * Static import graph of the files Pi will load. A missing relative import, or a
 * bare import Pi will not provide, passes a file-exists check and then fails
 * when the installed bundle is started.
 */
async function assertImportClosure(bundleDir: string, entries: readonly string[], peers: ReadonlySet<string>): Promise<void> {
  const pending = [...entries]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const text = await readFile(file, 'utf8')
    for (const specifier of staticSpecifiers(text)) {
      if (specifier.startsWith('node:') || isPeerSpecifier(specifier, peers)) continue
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const resolved = fileURLToPath(new URL(specifier, pathToFileURL(file)))
        const rel = relative(resolve(bundleDir), resolve(resolved))
        const parts = rel.split(/[/\\]/)
        if (rel.startsWith('..') || isAbsolute(rel) || parts.includes('node_modules')) {
          throw new BundleError(`extension ${file} imports ${JSON.stringify(specifier)}, which install does not copy (outside the bundle or under node_modules)`, 'PATH_ESCAPE')
        }
        if (!await isFile(resolved)) {
          throw new BundleError(`extension ${file} imports ${JSON.stringify(specifier)}, which is missing at ${resolved}; Pi would fail to load the installed bundle`, 'POINTER_MISSING')
        }
        pending.push(resolved)
        continue
      }
      throw new BundleError(`extension ${file} imports ${JSON.stringify(specifier)}, which is not a node builtin or a peerDependency; a local Pi install does not npm-install and does not copy node_modules`, 'MANIFEST_INVALID')
    }
  }
}

function peerNames(manifest: Record<string, unknown>): Set<string> {
  const peers = manifest['peerDependencies']
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return new Set()
  return new Set(Object.keys(peers))
}

function isPeerSpecifier(specifier: string, peers: ReadonlySet<string>): boolean {
  for (const peer of peers) {
    if (specifier === peer || specifier.startsWith(`${peer}/`)) return true
  }
  return false
}

/**
 * Pi drops a skill that has no frontmatter description. A declared skill file
 * in that shape verifies as "present" and then never loads.
 */
async function assertSkillsLoadable(skillsPath: string): Promise<void> {
  if (await isFile(skillsPath)) {
    assertSkillDescription(skillsPath, await readFile(skillsPath, 'utf8'))
    return
  }
  if (await isDirectory(skillsPath)) await walkSkillDirs(skillsPath)
}

async function walkSkillDirs(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
    assertSkillDescription(join(dir, 'SKILL.md'), await readFile(join(dir, 'SKILL.md'), 'utf8'))
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    await walkSkillDirs(join(dir, entry.name))
  }
}

function assertSkillDescription(path: string, text: string): void {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) {
    throw new BundleError(`skill ${path} has no YAML frontmatter, so Pi will not load it`, 'MANIFEST_INVALID')
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    throw new BundleError(`skill ${path} has unclosed frontmatter, so Pi will not load it`, 'MANIFEST_INVALID')
  }
  let parsed: unknown
  try {
    parsed = parseYaml(normalized.slice(4, end))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new BundleError(`skill ${path} frontmatter is not valid YAML: ${detail}`, 'MANIFEST_INVALID')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BundleError(`skill ${path} frontmatter must be a mapping, so Pi will not load it`, 'MANIFEST_INVALID')
  }
  const description = (parsed as { description?: unknown }).description
  if (typeof description !== 'string' || description.trim() === '') {
    throw new BundleError(`skill ${path} has no description, so Pi will not load it`, 'MANIFEST_INVALID')
  }
}

/** Lock shape install reads, plus a vendored OfficeCLI whose hash must already match. */
async function assertPiLockfile(bundleDir: string, lockfile: string): Promise<void> {
  const lock = await readJsonFile(lockfile, 'dependencies.lock')
  const python = lock['python']
  if (python !== undefined && python !== null && typeof python === 'object' && !Array.isArray(python)) {
    const packages = (python as { packages?: unknown }).packages
    if (packages !== undefined) {
      if (!Array.isArray(packages)) {
        throw new BundleError('dependencies.lock python.packages must be an array', 'MANIFEST_INVALID')
      }
      for (const entry of packages) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new BundleError('dependencies.lock python.packages entries must be objects with package and kind', 'MANIFEST_INVALID')
        }
        const record = entry as { package?: unknown; kind?: unknown }
        if (typeof record.package !== 'string' || record.package === '' || (record.kind !== 'required' && record.kind !== 'optional')) {
          throw new BundleError(`dependencies.lock python package ${JSON.stringify(record.package)} needs a package name and kind "required" or "optional"`, 'MANIFEST_INVALID')
        }
      }
    }
  }
  await assertVendoredOfficeCli(bundleDir, lock)
}

export async function assertVendoredOfficeCli(bundleDir: string, lock: Record<string, unknown> | undefined): Promise<void> {
  const binary = join(bundleDir, 'vendor', 'officecli', process.platform === 'win32' ? 'officecli.exe' : 'officecli')
  if (!await pathExists(binary)) return
  const expected = officeCliPin(lock)
  if (expected === undefined) {
    throw new BundleError(`vendored OfficeCLI at ${binary} has no sha256 pin in dependencies.lock`, 'MANIFEST_INVALID')
  }
  const actual = createHash('sha256').update(await readFile(binary)).digest('hex')
  if (actual !== expected) {
    throw new BundleError(`vendored OfficeCLI sha256 mismatch: expected ${expected}, got ${actual}`, 'DIGEST_MISMATCH')
  }
}

function officeCliPin(lock: Record<string, unknown> | undefined): string | undefined {
  if (lock === undefined) return undefined
  const officecli = lock['officecli']
  if (officecli === null || typeof officecli !== 'object' || Array.isArray(officecli)) return undefined
  const assets = (officecli as { assets?: unknown }).assets
  if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) return undefined
  const asset = (assets as Record<string, unknown>)[`${process.platform}-${process.arch}`]
  if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) return undefined
  const sha = (asset as { sha256?: unknown }).sha256
  return typeof sha === 'string' && sha !== '' ? sha : undefined
}

function staticSpecifiers(source: string): string[] {
  const found: string[] = []
  const code = stripComments(source)
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of code.matchAll(dynamic)) {
    const specifier = match[1]
    if (specifier !== undefined && specifier !== '') found.push(specifier)
  }
  const lines = code.split('\n')
  let statement = ''
  let collecting = false
  const push = (text: string): void => {
    const match = /\bfrom\s*['"]([^'"]+)['"]/.exec(text) ?? /^\s*import\s*['"]([^'"]+)['"]/.exec(text)
    const specifier = match?.[1]
    if (specifier !== undefined && specifier !== '') found.push(specifier)
  }
  for (const line of lines) {
    if (!collecting) {
      if (!/^\s*(?:import|export)\b/.test(line)) continue
      if (/^\s*export\s+(?:default|const|let|var|function|class|async)\b/.test(line)) continue
      collecting = true
      statement = line
    } else {
      statement += `\n${line}`
    }
    if (collecting && (/\bfrom\s*['"][^'"]+['"]/.test(line) || /;\s*$/.test(line) || /^\s*import\s*['"][^'"]+['"]/.test(statement))) {
      push(statement)
      collecting = false
      statement = ''
    }
  }
  if (collecting) push(statement)
  return found
}

/** Comments are not imports. Strings and template literals are left intact so a quote inside one is not a specifier. */
function stripComments(source: string): string {
  let out = ''
  let quote: '"' | "'" | '`' | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (quote !== undefined) {
      out += char ?? ''
      if (char === '\\') {
        out += next ?? ''
        index += 1
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 1
      out += ' '
      continue
    }
    out += char ?? ''
  }
  return out
}

/**
 * Pi manifest entries accept directory globs (`./dist/*.js`). Bundle verification
 * resolves them against the package on disk and returns the concrete files, so
 * both verify and the install-time materialization check work on real paths.
 */
export async function expandExtensionEntry(declared: string, packageDir: string, entry: string): Promise<string[]> {
  if (!entry.includes('*')) {
    const entryPath = resolveInBundle(packageDir, entry, `bundle Pi package ${declared} pi.extensions entry`)
    return await isFile(entryPath) ? [entryPath] : []
  }
  const slash = entry.lastIndexOf('/')
  const directory = slash < 0 ? '.' : entry.slice(0, slash)
  const pattern = slash < 0 ? entry : entry.slice(slash + 1)
  const resolvedDir = resolveInBundle(packageDir, directory, `bundle Pi package ${declared} pi.extensions entry`)
  const expression = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  const entries = await readdir(resolvedDir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(item => item.isFile() && expression.test(item.name))
    .map(item => join(resolvedDir, item.name))
    .sort((left, right) => left.localeCompare(right))
}

export async function parsePiAgentConfig(bundleDir: string): Promise<PiAgentConfig> {
  const agentPath = join(bundleDir, 'agent.yaml')
  if (!await lstatExists(agentPath)) return {}
  const raw = await readMappingFile(agentPath, 'agent file')
  const model = raw['model']
  if (model === undefined) return {}
  if (typeof model !== 'object' || model === null) {
    throw new BundleError('agent.yaml model must be an object with string provider and model fields', 'MANIFEST_INVALID')
  }
  const shaped = model as { provider?: unknown; model?: unknown }
  if (typeof shaped.provider !== 'string' || typeof shaped.model !== 'string') {
    throw new BundleError('agent.yaml model must be an object with string provider and model fields', 'MANIFEST_INVALID')
  }
  return { model: { provider: shaped.provider, model: shaped.model } }
}

/**
 * Pi's native settings file. Required by the bundle contract, must be a JSON
 * object; unknown keys are preserved so the adapter can merge them verbatim.
 */
export async function parsePiSettings(path: string): Promise<PiSettings> {
  const raw = await readJsonFile(path, 'bundle settings file')
  const provider = raw['defaultProvider']
  const model = raw['defaultModel']
  if (provider !== undefined && typeof provider !== 'string') {
    throw new BundleError('settings.json defaultProvider must be a string', 'MANIFEST_INVALID')
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new BundleError('settings.json defaultModel must be a string', 'MANIFEST_INVALID')
  }
  return {
    raw,
    ...(provider === undefined ? {} : { defaultProvider: provider }),
    ...(model === undefined ? {} : { defaultModel: model }),
  }
}

/** Read a settings.json that may not exist yet (a fresh ephemeral home). */
export async function readPiSettingsIfPresent(path: string): Promise<Record<string, unknown> | undefined> {
  return await readOptionalJsonFile(path, 'Pi settings file')
}
