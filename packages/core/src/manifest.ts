import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { BundleError } from './errors.ts'
import { isFile, packageEntryTarget } from './bundle-paths.ts'
import { pathExists, readMappingFile } from './yaml-file.ts'
import { PI_BUNDLE_KIND, PI_HARNESS_NAME, parsePiBundleManifest, type PiBundleManifest } from './adapters/pi/manifest.ts'
import { DEEPAGENTS_BUNDLE_KIND, DEEPAGENTS_HARNESS_NAME, parseDeepagentsBundleManifest, type DeepagentsBundleManifest } from './adapters/deepagents/manifest.ts'
import { JIUWENSWARM_BUNDLE_KIND, JIUWENSWARM_HARNESS_NAME, parseJiuwenswarmBundleManifest, type JiuwenswarmBundleManifest } from './adapters/jiuwenswarm/manifest.ts'

export const DSH_BUNDLE_KIND = 'dsh-agent-bundle'
export const DIFY_BUNDLE_KIND = 'dify-agent-bundle'
export const HERMES_BUNDLE_KIND = 'hermes-agent-bundle'
export { PI_BUNDLE_KIND, DEEPAGENTS_BUNDLE_KIND, JIUWENSWARM_BUNDLE_KIND }

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Every registered kind's parsed manifest. */
export type BundleKind = typeof DSH_BUNDLE_KIND | typeof DIFY_BUNDLE_KIND | typeof PI_BUNDLE_KIND | typeof HERMES_BUNDLE_KIND | typeof DEEPAGENTS_BUNDLE_KIND | typeof JIUWENSWARM_BUNDLE_KIND
export type AnyBundleManifest = DshBundleManifest | DifyBundleManifest | PiBundleManifest | HermesBundleManifest | DeepagentsBundleManifest | JiuwenswarmBundleManifest

/** Stable harness selector corresponding to the parser-owned kind contract. */
export const HARNESS_NAMES: Readonly<Record<BundleKind, string>> = {
  [DSH_BUNDLE_KIND]: 'dsh',
  [DIFY_BUNDLE_KIND]: 'dify',
  [PI_BUNDLE_KIND]: PI_HARNESS_NAME,
  [HERMES_BUNDLE_KIND]: 'hermes',
  [DEEPAGENTS_BUNDLE_KIND]: DEEPAGENTS_HARNESS_NAME,
  [JIUWENSWARM_BUNDLE_KIND]: JIUWENSWARM_HARNESS_NAME,
}

export function harnessNameForKind(kind: BundleKind): string {
  return HARNESS_NAMES[kind]
}

export interface BundleManifest<K extends BundleKind = BundleKind> {
  readonly name: string
  readonly kind: K
  readonly schemaVersion: number
  readonly harnessVersion: string
  readonly plugins: readonly string[]
  readonly declaredPlugins: readonly string[]
  /** dify: relative path to the workflow DSL file (bundle.yaml entry). */
  readonly entry?: string
  /** hermes: plugin names (each plugin.yaml "name") in declared order. */
  readonly pluginNames?: readonly string[]
}

export type DshBundleManifest = BundleManifest<typeof DSH_BUNDLE_KIND>
export type DifyBundleManifest = BundleManifest<typeof DIFY_BUNDLE_KIND>
export type HermesBundleManifest = BundleManifest<typeof HERMES_BUNDLE_KIND>

export interface AgentConfig {
  readonly model?: {
    readonly provider: string
    readonly model: string
  }
}

export interface DifyAgentConfig {
  readonly model?: {
    readonly provider: string
    readonly model: string
  }
  readonly humanInput?: {
    readonly webappDelivery: boolean
    readonly defaultAction: string
    readonly actionTitle: string
  }
}

export async function parseBundleManifest<K extends BundleKind = BundleKind>(bundleDir: string): Promise<ManifestOf<K>> {
  return await parseManifestText<K>(await readMappingFile(join(bundleDir, 'bundle.yaml'), 'bundle file'), bundleDir)
}

/** Dispatch a parsed bundle.yaml to the parser owned by its kind. */
export async function parseManifestText<K extends BundleKind>(raw: Record<string, unknown>, bundleDir: string): Promise<ManifestOf<K>> {
  const kind = raw.kind
  if (kind === DSH_BUNDLE_KIND) return await parseDshBundleManifest(raw, bundleDir) as ManifestOf<K>
  if (kind === DIFY_BUNDLE_KIND) return await parseDifyBundleManifest(raw, bundleDir) as ManifestOf<K>
  if (kind === PI_BUNDLE_KIND) return await parsePiBundleManifest(bundleDir, raw) as ManifestOf<K>
  if (kind === HERMES_BUNDLE_KIND) return await parseHermesBundleManifest(raw, bundleDir) as ManifestOf<K>
  if (kind === DEEPAGENTS_BUNDLE_KIND) return await parseDeepagentsBundleManifest(bundleDir, raw) as ManifestOf<K>
  if (kind === JIUWENSWARM_BUNDLE_KIND) return await parseJiuwenswarmBundleManifest(bundleDir, raw) as ManifestOf<K>
  throw new BundleError(
    `bundle.yaml kind must be ${JSON.stringify(DSH_BUNDLE_KIND)}, ${JSON.stringify(DIFY_BUNDLE_KIND)}, ${JSON.stringify(PI_BUNDLE_KIND)}, ${JSON.stringify(HERMES_BUNDLE_KIND)}, ${JSON.stringify(DEEPAGENTS_BUNDLE_KIND)}, or ${JSON.stringify(JIUWENSWARM_BUNDLE_KIND)}, `
    + `got ${JSON.stringify(kind)}`,
    'BUNDLE_KIND_UNKNOWN',
  )
}

export type ManifestOf<K extends BundleKind> =
  K extends typeof PI_BUNDLE_KIND ? PiBundleManifest
    : K extends typeof DIFY_BUNDLE_KIND ? DifyBundleManifest
      : K extends typeof HERMES_BUNDLE_KIND ? HermesBundleManifest
        : K extends typeof DEEPAGENTS_BUNDLE_KIND ? DeepagentsBundleManifest
          : K extends typeof JIUWENSWARM_BUNDLE_KIND ? JiuwenswarmBundleManifest
            : DshBundleManifest

export async function parseBundleKind(bundleDir: string): Promise<string> {
  const raw = await readMappingFile(join(bundleDir, 'bundle.yaml'), 'bundle file')
  const kind = raw.kind
  if (typeof kind !== 'string' || kind === '') {
    throw new BundleError('bundle.yaml kind must be a non-empty string', 'BUNDLE_KIND_UNKNOWN')
  }
  return kind
}

function requireHarnessName(raw: Record<string, unknown>, expected: string): { version: string } {
  const harness = raw.harness as { name?: unknown; version?: unknown } | undefined
  if (harness?.name !== expected) {
    throw new BundleError(`bundle.yaml harness.name must be ${JSON.stringify(expected)}, got ${JSON.stringify(harness)}`, 'MANIFEST_INVALID')
  }
  if (typeof harness.version !== 'string' || harness.version === '') {
    throw new BundleError('bundle.yaml harness.version must be a non-empty compat range string (e.g. ">=0.1.6-alpha.1 <0.2")', 'MANIFEST_INVALID')
  }
  return { version: harness.version }
}

async function parseDshBundleManifest(raw: Record<string, unknown>, bundleDir: string): Promise<BundleManifest> {
  if (raw.schemaVersion !== 1) {
    throw new BundleError(`bundle.yaml schemaVersion must be 1, got ${JSON.stringify(raw.schemaVersion)}`, 'MANIFEST_INVALID')
  }
  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) {
    throw new BundleError(`bundle.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(raw.name)}`, 'MANIFEST_INVALID')
  }
  const { version } = requireHarnessName(raw, 'dsh')
  await validatePointer(raw['entry'], bundleDir, 'entry')
  await validatePointer(raw['lockfile'], bundleDir, 'lockfile')
  const declared = raw.plugins
  if (!Array.isArray(declared)) {
    throw new BundleError('bundle.yaml plugins must be a non-empty list of {path} entries', 'MANIFEST_INVALID')
  }
  if (declared.length === 0) {
    throw new BundleError('bundle.yaml plugins must be a non-empty list of {path} entries', 'MANIFEST_INVALID')
  }
  const plugins: string[] = []
  const declaredPlugins: string[] = []
  for (const entry of declared) {
    const path = (entry as { path?: unknown } | undefined)?.path
    if (typeof path !== 'string') {
      throw new BundleError(`bundle.yaml plugin path must be a relative string, got ${JSON.stringify(path)}`, 'MANIFEST_INVALID')
    }
    if (path === '' || isAbsolute(path) || path.includes('..')) {
      throw new BundleError(`bundle.yaml plugin path must stay inside the bundle, got ${JSON.stringify(path)}`, 'PATH_ESCAPE')
    }
    const pluginDir = resolve(bundleDir, path)
    await validatePluginPackage(pluginDir, path)
    plugins.push(pluginDir)
    declaredPlugins.push(path)
  }
  return { name: raw.name, kind: DSH_BUNDLE_KIND, schemaVersion: 1, harnessVersion: version, plugins, declaredPlugins }
}

async function parseDifyBundleManifest(raw: Record<string, unknown>, bundleDir: string): Promise<BundleManifest> {
  if (raw.schemaVersion !== 1) {
    throw new BundleError(`bundle.yaml schemaVersion must be 1, got ${JSON.stringify(raw.schemaVersion)}`, 'MANIFEST_INVALID')
  }
  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) {
    throw new BundleError(`bundle.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(raw.name)}`, 'MANIFEST_INVALID')
  }
  const { version } = requireHarnessName(raw, 'dify')
  if (typeof raw['entry'] !== 'string' || raw['entry'] === '') {
    throw new BundleError('bundle.yaml entry must be a relative path to the workflow DSL file', 'MANIFEST_INVALID')
  }
  const entry = raw['entry'] as string
  if (isAbsolute(entry) || entry.includes('..')) {
    throw new BundleError(`bundle.yaml entry must stay inside the bundle, got ${JSON.stringify(entry)}`, 'PATH_ESCAPE')
  }
  await validatePointer(entry, bundleDir, 'entry')
  return {
    name: raw.name as string,
    kind: DIFY_BUNDLE_KIND,
    schemaVersion: 1,
    harnessVersion: version,
    plugins: [],
    declaredPlugins: [],
    entry,
  }
}

async function parseHermesBundleManifest(raw: Record<string, unknown>, bundleDir: string): Promise<BundleManifest> {
  if (raw.schemaVersion !== 1) {
    throw new BundleError(`bundle.yaml schemaVersion must be 1, got ${JSON.stringify(raw.schemaVersion)}`, 'MANIFEST_INVALID')
  }
  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) {
    throw new BundleError(`bundle.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(raw.name)}`, 'MANIFEST_INVALID')
  }
  const { version } = requireHarnessName(raw, 'hermes')
  await validatePointer(raw['entry'], bundleDir, 'entry')
  await validatePointer(raw['lockfile'], bundleDir, 'lockfile')
  const declared = raw.plugins
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new BundleError('bundle.yaml plugins must be a non-empty list of {path} entries', 'MANIFEST_INVALID')
  }
  const plugins: string[] = []
  const declaredPlugins: string[] = []
  const pluginNames: string[] = []
  for (const entry of declared) {
    const path = (entry as { path?: unknown } | undefined)?.path
    if (typeof path !== 'string') {
      throw new BundleError(`bundle.yaml plugin path must be a relative string, got ${JSON.stringify(path)}`, 'MANIFEST_INVALID')
    }
    if (path === '' || isAbsolute(path) || path.includes('..')) {
      throw new BundleError(`bundle.yaml plugin path must stay inside the bundle, got ${JSON.stringify(path)}`, 'PATH_ESCAPE')
    }
    const pluginDir = resolve(bundleDir, path)
    pluginNames.push(await validateHermesPlugin(pluginDir, path))
    plugins.push(pluginDir)
    declaredPlugins.push(path)
  }
  return { name: raw.name, kind: HERMES_BUNDLE_KIND, schemaVersion: 1, harnessVersion: version, plugins, declaredPlugins, pluginNames }
}

async function validateHermesPlugin(pluginDir: string, declared: string): Promise<string> {
  const manifestPath = join(pluginDir, 'plugin.yaml')
  const raw = await readMappingFile(manifestPath, 'plugin manifest')
  const name = raw['name']
  if (typeof name !== 'string' || name === '') {
    throw new BundleError(`bundle plugin ${declared} plugin.yaml must declare a non-empty "name", got ${JSON.stringify(name)}`, 'MANIFEST_INVALID')
  }
  if (!NAME_PATTERN.test(name)) {
    throw new BundleError(`bundle plugin ${declared} plugin.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(name)}`, 'MANIFEST_INVALID')
  }
  return name
}

export async function parseAgentConfig(bundleDir: string): Promise<AgentConfig> {
  const raw = await readMappingFile(join(bundleDir, 'agent.yaml'), 'agent file')
  const model = raw.model
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

/** dify agent.yaml is optional; missing file yields an empty config. */
export async function parseDifyAgentConfig(bundleDir: string): Promise<DifyAgentConfig> {
  const agentPath = join(bundleDir, 'agent.yaml')
  if (!await pathExists(agentPath)) return {}
  const raw = await readMappingFile(agentPath, 'agent file')
  const config: {
    model?: { provider: string; model: string }
    humanInput?: { webappDelivery: boolean; defaultAction: string; actionTitle: string }
  } = {}
  const model = raw['model']
  if (model !== undefined) {
    if (typeof model !== 'object' || model === null) {
      throw new BundleError('agent.yaml model must be an object with string provider and model fields', 'MANIFEST_INVALID')
    }
    const shaped = model as { provider?: unknown; model?: unknown }
    if (typeof shaped.provider !== 'string' || typeof shaped.model !== 'string') {
      throw new BundleError('agent.yaml model must be an object with string provider and model fields', 'MANIFEST_INVALID')
    }
    config.model = { provider: shaped.provider, model: shaped.model }
  }
  const humanInput = raw['human_input']
  if (humanInput !== undefined) {
    if (typeof humanInput !== 'object' || humanInput === null) {
      throw new BundleError('agent.yaml human_input must be an object', 'MANIFEST_INVALID')
    }
    const shaped = humanInput as { webapp_delivery?: unknown; default_action?: unknown; action_title?: unknown }
    if (shaped.webapp_delivery !== undefined && typeof shaped.webapp_delivery !== 'boolean') {
      throw new BundleError('agent.yaml human_input.webapp_delivery must be a boolean', 'MANIFEST_INVALID')
    }
    if (shaped.default_action !== undefined && typeof shaped.default_action !== 'string') {
      throw new BundleError('agent.yaml human_input.default_action must be a string', 'MANIFEST_INVALID')
    }
    config.humanInput = {
      webappDelivery: shaped.webapp_delivery === true,
      defaultAction: typeof shaped.default_action === 'string' ? shaped.default_action : 'approve',
      actionTitle: typeof shaped.action_title === 'string' ? shaped.action_title : 'Approve',
    }
  }
  return config
}

export function isBundleName(value: string): boolean {
  return NAME_PATTERN.test(value)
}

async function validatePointer(value: unknown, bundleDir: string, label: string): Promise<void> {
  if (value === undefined) return
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || value.includes('..')) {
    throw new BundleError(`bundle.yaml ${label} must be a relative path inside the bundle, got ${JSON.stringify(value)}`, 'PATH_ESCAPE')
  }
  const target = resolve(bundleDir, value)
  if (!await pathExists(target)) {
    throw new BundleError(`bundle.yaml ${label} points to a missing file: ${target}`, 'POINTER_MISSING')
  }
}

async function validatePluginPackage(pluginDir: string, declared: string): Promise<void> {
  const manifestPath = join(pluginDir, 'package.json')
  if (!await pathExists(manifestPath)) {
    throw new BundleError(`bundle plugin ${declared} has no package.json at ${pluginDir}`, 'POINTER_MISSING')
  }
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new BundleError(`bundle plugin ${declared} package.json is not valid JSON: ${String(error)}`, 'MANIFEST_INVALID')
  }
  const dsh = pkg['dsh'] as { bundle?: { patch?: unknown } } | undefined
  const patch = dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch === '') {
    throw new BundleError(`bundle plugin ${declared} package.json must declare dsh.bundle.patch (a relative path to the cordis patch), got ${JSON.stringify(patch)}`, 'MANIFEST_INVALID')
  }
  if (isAbsolute(patch) || patch.includes('..')) {
    throw new BundleError(`bundle plugin ${declared} dsh.bundle.patch must stay inside the plugin, got ${JSON.stringify(patch)}`, 'PATH_ESCAPE')
  }
  const patchPath = resolve(pluginDir, patch)
  if (!await isFile(patchPath)) {
    throw new BundleError(`bundle plugin ${declared} declares dsh.bundle.patch ${JSON.stringify(patch)} which is missing at ${patchPath}`, 'POINTER_MISSING')
  }
  const entry = packageEntryTarget(pkg)
  if (entry === undefined) {
    throw new BundleError(`bundle plugin ${declared} package.json must declare a "main" or exports["."] entry pointing at built JS`, 'MANIFEST_INVALID')
  }
  if (isAbsolute(entry) || entry.includes('..')) {
    throw new BundleError(`bundle plugin ${declared} entry must stay inside the plugin, got ${JSON.stringify(entry)}`, 'PATH_ESCAPE')
  }
  const entryPath = resolve(pluginDir, entry)
  if (!await isFile(entryPath)) {
    throw new BundleError(`bundle plugin ${declared} entry ${JSON.stringify(entry)} is missing at ${entryPath} (lib/ must contain built JS)`, 'POINTER_MISSING')
  }
}
