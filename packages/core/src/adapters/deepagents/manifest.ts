import { join } from 'node:path'
import { BundleError } from '../../errors.ts'
import { isFile, pathExists, readJsonFile, resolveInBundle } from '../../bundle-paths.ts'

export const DEEPAGENTS_BUNDLE_KIND = 'deepagents-agent-bundle'
export const DEEPAGENTS_HARNESS_NAME = 'deepagents'
/** The composition graph id the bundle contract mandates (`graphs.agent`). */
export const DEEPAGENTS_GRAPH_ID = 'agent'
/**
 * Runtime state that is not part of the candidate snapshot: `.langgraph_api/`
 * is written by `langgraph dev`, and setuptools editable installs drop
 * `<name>.egg-info/` into the bundle root. `__pycache__/` is already excluded
 * globally.
 */
export const DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORIES = ['.langgraph_api'] as const
export const DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORY_SUFFIXES = ['egg-info'] as const

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export interface DeepagentsBundleManifest {
  readonly name: string
  readonly kind: typeof DEEPAGENTS_BUNDLE_KIND
  readonly schemaVersion: number
  readonly harnessVersion: string
  /** Declared entry (relative langgraph.json path). */
  readonly entry: string
  /** Resolved absolute langgraph.json path. */
  readonly entryPath: string
  /** Graph id from langgraph.json graphs.agent (currently always "agent"). */
  readonly graphId: string
  /** Module path declared by graphs.agent (e.g. "./agent.py"). */
  readonly graphModule: string
  readonly plugins: readonly string[]
  readonly declaredPlugins: readonly string[]
}

export async function parseDeepagentsBundleManifest(bundleDir: string, raw: Record<string, unknown>): Promise<DeepagentsBundleManifest> {
  if (raw['schemaVersion'] !== 1) {
    throw new BundleError(`bundle.yaml schemaVersion must be 1, got ${JSON.stringify(raw['schemaVersion'])}`, 'MANIFEST_INVALID')
  }
  if (typeof raw['name'] !== 'string' || !NAME_PATTERN.test(raw['name'])) {
    throw new BundleError(`bundle.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(raw['name'])}`, 'MANIFEST_INVALID')
  }
  const harness = raw['harness'] as { name?: unknown; version?: unknown } | undefined
  if (harness?.name !== DEEPAGENTS_HARNESS_NAME) {
    throw new BundleError(`bundle.yaml harness.name must be ${JSON.stringify(DEEPAGENTS_HARNESS_NAME)}, got ${JSON.stringify(harness)}`, 'MANIFEST_INVALID')
  }
  if (typeof harness.version !== 'string' || harness.version === '') {
    throw new BundleError('bundle.yaml harness.version must be a non-empty compat range string (e.g. ">=0.7,<0.8")', 'MANIFEST_INVALID')
  }

  const entry = requireRelative(raw['entry'], 'entry')
  const entryPath = resolveInBundle(bundleDir, entry, 'bundle.yaml entry')
  if (!await isFile(entryPath)) {
    throw new BundleError(`bundle.yaml entry points to a missing file: ${entryPath}`, 'POINTER_MISSING')
  }
  const { graphId, graphModule } = await parseLanggraphJson(entryPath)

  const lockfile = raw['lockfile']
  if (lockfile !== undefined) {
    const declared = requireRelative(lockfile, 'lockfile')
    const lockPath = resolveInBundle(bundleDir, declared, 'bundle.yaml lockfile')
    if (!await pathExists(lockPath)) {
      throw new BundleError(`bundle.yaml lockfile points to a missing file: ${lockPath}`, 'POINTER_MISSING')
    }
  }

  const declared = raw['plugins']
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new BundleError('bundle.yaml plugins must be a non-empty list of {path} entries', 'MANIFEST_INVALID')
  }
  const plugins: string[] = []
  const declaredPlugins: string[] = []
  for (const plugin of declared) {
    const path = (plugin as { path?: unknown } | undefined)?.path
    if (typeof path !== 'string') {
      throw new BundleError(`bundle.yaml plugin path must be a relative string, got ${JSON.stringify(path)}`, 'MANIFEST_INVALID')
    }
    if (path === '' || path.includes('..') || path.startsWith('/')) {
      throw new BundleError(`bundle.yaml plugin path must stay inside the bundle, got ${JSON.stringify(path)}`, 'PATH_ESCAPE')
    }
    const pluginDir = resolveInBundle(bundleDir, path, 'bundle.yaml plugin path')
    if (!await pathExists(pluginDir)) {
      throw new BundleError(`bundle plugin ${JSON.stringify(path)} is missing at ${pluginDir}`, 'POINTER_MISSING')
    }
    plugins.push(pluginDir)
    declaredPlugins.push(path)
  }
  return {
    name: raw['name'],
    kind: DEEPAGENTS_BUNDLE_KIND,
    schemaVersion: 1,
    harnessVersion: harness.version,
    entry,
    entryPath,
    graphId,
    graphModule,
    plugins,
    declaredPlugins,
  }
}

/**
 * Parse the bundle's langgraph.json and resolve the composition graph.
 * `graphs[agent]` is mandatory: "./agent.py:agent" style — the module file
 * part must exist inside the bundle.
 */
async function parseLanggraphJson(entryPath: string): Promise<{ graphId: string; graphModule: string }> {
  const doc = await readJsonFile(entryPath, 'entry langgraph.json')
  const graphs = doc['graphs']
  if (typeof graphs !== 'object' || graphs === null || Array.isArray(graphs)) {
    throw new BundleError(`entry langgraph.json must contain a "graphs" mapping, got ${JSON.stringify(graphs)}`, 'MANIFEST_INVALID')
  }
  const declared = (graphs as Record<string, unknown>)[DEEPAGENTS_GRAPH_ID]
  if (typeof declared !== 'string' || declared === '') {
    throw new BundleError(`entry langgraph.json graphs must declare ${JSON.stringify(DEEPAGENTS_GRAPH_ID)}, got ${JSON.stringify(graphs)}`, 'MANIFEST_INVALID')
  }
  const separator = declared.lastIndexOf(':')
  if (separator <= 0) {
    throw new BundleError(`entry langgraph.json graphs[${JSON.stringify(DEEPAGENTS_GRAPH_ID)}] must be "<module>:<attr>", got ${JSON.stringify(declared)}`, 'MANIFEST_INVALID')
  }
  const graphModule = declared.slice(0, separator)
  const modulePath = resolveInBundle(entryPath === '' ? '.' : join(entryPath, '..'), graphModule, 'entry langgraph.json graphs[agent] module')
  if (!await isFile(modulePath)) {
    throw new BundleError(`entry langgraph.json graphs[${JSON.stringify(DEEPAGENTS_GRAPH_ID)}] module ${JSON.stringify(graphModule)} is missing at ${modulePath}`, 'POINTER_MISSING')
  }
  return { graphId: DEEPAGENTS_GRAPH_ID, graphModule }
}

function requireRelative(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new BundleError(`bundle.yaml ${label} must be a relative path inside the bundle, got ${JSON.stringify(value)}`, 'PATH_ESCAPE')
  }
  if (value.startsWith('/') || value.includes('..')) {
    throw new BundleError(`bundle.yaml ${label} must stay inside the bundle, got ${JSON.stringify(value)}`, 'PATH_ESCAPE')
  }
  return value
}
