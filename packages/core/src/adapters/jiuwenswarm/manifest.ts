import { basename, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { BundleError } from '../../errors.ts'
import { isDirectory, isFile, pathExists, readJsonFile, resolveInBundle } from '../../bundle-paths.ts'
import { pathExists as lstatExists, readMappingFile } from '../../yaml-file.ts'

export const JIUWENSWARM_BUNDLE_KIND = 'jiuwenswarm-agent-bundle'
export const JIUWENSWARM_HARNESS_NAME = 'jiuwenswarm'

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export type JiuwenswarmPackageKind = 'agent_template' | 'plugin' | 'agent_group'

/** The native catalog kind a bundle package maps to (`extension_package_manager`). */
const PACKAGE_TYPES: Readonly<Record<JiuwenswarmPackageKind, string>> = {
  agent_template: 'agent_template',
  plugin: 'plugin',
  agent_group: 'agent_group',
}

export interface JiuwenswarmPackage {
  /** The declared path exactly as written in bundle.yaml. */
  readonly declared: string
  /** Absolute path of the package directory. */
  readonly path: string
  readonly kind: JiuwenswarmPackageKind
  /** Catalog package id (`manifest.json.id`, falling back to the declared basename). */
  readonly packageId: string
  /** Connector names the package requests via `mcps[].connector` (host-managed MCP deps). */
  readonly requiredConnectors: readonly string[]
}

export interface JiuwenswarmBundleManifest {
  readonly name: string
  readonly kind: typeof JIUWENSWARM_BUNDLE_KIND
  readonly schemaVersion: number
  readonly harnessVersion: string
  /** Directory of skills or a single `SKILL.md` file; materialized into `<home>/agent/workspace/skills/`. */
  readonly skills?: string
  /** Native extension packages; materialized into the jiuwenswarm catalog roots. */
  readonly packages?: readonly JiuwenswarmPackage[]
  /** Host connectors this bundle depends on; declaration-only, never materialized with credentials. */
  readonly connectors?: readonly string[]
  /** Workspace scaffold copied as the `<home>` baseline before overlays. */
  readonly templates?: string
  /** YAML mapping merged into `<home>/config/config.yaml`. */
  readonly config?: string
  readonly lockfile?: string
}

/** `agent.yaml` is optional for jiuwenswarm bundles and currently only carries the model selection. */
export interface JiuwenswarmAgentConfig {
  readonly model?: {
    readonly provider: string
    readonly model: string
  }
}

export async function parseJiuwenswarmBundleManifest(bundleDir: string, raw: Record<string, unknown>): Promise<JiuwenswarmBundleManifest> {
  if (raw['schemaVersion'] !== 1) {
    throw new BundleError(`bundle.yaml schemaVersion must be 1, got ${JSON.stringify(raw['schemaVersion'])}`, 'MANIFEST_INVALID')
  }
  if (typeof raw['name'] !== 'string' || !NAME_PATTERN.test(raw['name'])) {
    throw new BundleError(`bundle.yaml name must match ${String(NAME_PATTERN)}, got ${JSON.stringify(raw['name'])}`, 'MANIFEST_INVALID')
  }
  const harness = raw['harness'] as { name?: unknown; version?: unknown } | undefined
  if (harness?.name !== JIUWENSWARM_HARNESS_NAME) {
    throw new BundleError(`bundle.yaml harness.name must be ${JSON.stringify(JIUWENSWARM_HARNESS_NAME)}, got ${JSON.stringify(harness)}`, 'MANIFEST_INVALID')
  }
  if (typeof harness.version !== 'string' || harness.version === '') {
    throw new BundleError('bundle.yaml harness.version must be a non-empty compat range string (e.g. ">=0.2,<0.3")', 'MANIFEST_INVALID')
  }

  const skills = raw['skills'] === undefined ? undefined : await parseSkills(bundleDir, raw['skills'])
  const packages = raw['packages'] === undefined ? undefined : await parsePackages(bundleDir, raw['packages'])
  const connectors = raw['connectors'] === undefined ? undefined : parseConnectors(raw['connectors'])
  if (packages !== undefined) {
    const missing = [...new Set(packages.flatMap(entry => entry.requiredConnectors))]
      .filter(name => connectors === undefined || !connectors.includes(name))
    if (missing.length > 0) {
      throw new BundleError(
        `bundle packages require connectors ${missing.join(', ')} which are not declared in bundle.yaml connectors`,
        'MANIFEST_INVALID',
      )
    }
  }
  const templates = raw['templates'] === undefined ? undefined : await requireTarget(bundleDir, raw['templates'], 'templates', 'directory')
  const config = raw['config'] === undefined ? undefined : await parseConfig(bundleDir, raw['config'])
  const lockfile = raw['lockfile'] === undefined ? undefined : await requireTarget(bundleDir, raw['lockfile'], 'lockfile', 'path')

  return {
    name: raw['name'],
    kind: JIUWENSWARM_BUNDLE_KIND,
    schemaVersion: 1,
    harnessVersion: harness.version,
    ...(skills === undefined ? {} : { skills }),
    ...(packages === undefined ? {} : { packages }),
    ...(connectors === undefined ? {} : { connectors }),
    ...(templates === undefined ? {} : { templates }),
    ...(config === undefined ? {} : { config }),
    ...(lockfile === undefined ? {} : { lockfile }),
  }
}

/** jiuwenswarm agent.yaml is optional (like pi); a missing file yields an empty config. */
export async function parseJiuwenswarmAgentConfig(bundleDir: string): Promise<JiuwenswarmAgentConfig> {
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

async function parseSkills(bundleDir: string, declared: unknown): Promise<string> {
  const path = await requireTarget(bundleDir, declared, 'skills', 'path')
  if (await isFile(path)) {
    if (basename(path) !== 'SKILL.md') {
      throw new BundleError(`bundle.yaml skills single file must be named SKILL.md, got ${JSON.stringify(declared)}`, 'MANIFEST_INVALID')
    }
    return path
  }
  if (!await isDirectory(path)) {
    throw new BundleError(`bundle.yaml skills points to a missing path: ${path}`, 'POINTER_MISSING')
  }
  const entries = await readdir(path, { withFileTypes: true })
  if (entries.length === 0) {
    throw new BundleError(`bundle.yaml skills directory contains no skills: ${path}`, 'MANIFEST_INVALID')
  }
  for (const entry of entries) {
    const skillDir = join(path, entry.name)
    if (!entry.isDirectory() || !await isFile(join(skillDir, 'SKILL.md'))) {
      throw new BundleError(`bundle skill ${entry.name} has no SKILL.md at ${skillDir}`, 'MANIFEST_INVALID')
    }
  }
  return path
}

async function parsePackages(bundleDir: string, declared: unknown): Promise<readonly JiuwenswarmPackage[]> {
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new BundleError('bundle.yaml packages must be a non-empty list of {path, kind} entries', 'MANIFEST_INVALID')
  }
  const packages: JiuwenswarmPackage[] = []
  for (const entry of declared) {
    const rawEntry = entry as { path?: unknown; kind?: unknown } | undefined
    const kind = rawEntry?.kind
    if (typeof kind !== 'string' || !(kind in PACKAGE_TYPES)) {
      throw new BundleError(`bundle.yaml package kind must be one of agent_template, plugin, agent_group, got ${JSON.stringify(kind)}`, 'MANIFEST_INVALID')
    }
    const packageKind = kind as JiuwenswarmPackageKind
    const declaredPath = rawEntry?.path
    if (typeof declaredPath !== 'string' || declaredPath === '') {
      throw new BundleError(`bundle.yaml package path must be a relative string, got ${JSON.stringify(declaredPath)}`, 'MANIFEST_INVALID')
    }
    const path = resolveInBundle(bundleDir, declaredPath, `bundle.yaml package ${JSON.stringify(declaredPath)}`)
    if (!await isDirectory(path)) {
      throw new BundleError(`bundle jiuwenswarm package ${JSON.stringify(declaredPath)} is missing at ${path}`, 'POINTER_MISSING')
    }
    const manifestPath = join(path, 'manifest.json')
    if (!await isFile(manifestPath)) {
      throw new BundleError(`bundle jiuwenswarm package ${JSON.stringify(declaredPath)} has no manifest.json at ${path}`, 'POINTER_MISSING')
    }
    const manifest = await readJsonFile(manifestPath, `bundle jiuwenswarm package ${JSON.stringify(declaredPath)} manifest.json`)
    const declaredType = PACKAGE_TYPES[packageKind]
    if (manifest['package_type'] !== declaredType) {
      throw new BundleError(
        `bundle jiuwenswarm package ${JSON.stringify(declaredPath)} manifest.json package_type must be ${JSON.stringify(declaredType)}, got ${JSON.stringify(manifest['package_type'])}`,
        'MANIFEST_INVALID',
      )
    }
    const id = typeof manifest['id'] === 'string' && manifest['id'] !== '' ? manifest['id'] : basename(path)
    packages.push({
      declared: declaredPath,
      path,
      kind: packageKind,
      packageId: id,
      requiredConnectors: collectPackageConnectors(manifest),
    })
  }
  return packages
}

/**
 * Connector deps a package requests via `mcps[].connector` (host-managed MCP
 * names, mirroring jiuwenswarm's `_connector_names_from_manifest`). Read
 * tolerantly from the raw manifest: strict openjiuwen loaders forbid the
 * `connector` key on McpServerSpec, so these entries are display/dependency
 * hints, not loader fields.
 */
function collectPackageConnectors(manifest: Record<string, unknown>): string[] {
  const mcps = manifest['mcps']
  if (!Array.isArray(mcps)) return []
  const names: string[] = []
  const seen = new Set<string>()
  for (const entry of mcps) {
    if (typeof entry !== 'object' || entry === null) continue
    const connector = (entry as Record<string, unknown>)['connector']
    if (typeof connector !== 'string' || connector.trim() === '') continue
    const name = connector.trim()
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

function parseConnectors(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BundleError('bundle.yaml connectors must be a non-empty list of connector names', 'MANIFEST_INVALID')
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new BundleError(`bundle.yaml connectors entries must be non-empty strings, got ${JSON.stringify(entry)}`, 'MANIFEST_INVALID')
    }
    const name = entry.trim()
    if (seen.has(name)) {
      throw new BundleError(`bundle.yaml connectors contains duplicate ${JSON.stringify(name)}`, 'MANIFEST_INVALID')
    }
    seen.add(name)
    names.push(name)
  }
  return names
}

async function parseConfig(bundleDir: string, declared: unknown): Promise<string> {
  const path = await requireTarget(bundleDir, declared, 'config', 'file')
  await readMappingFile(path, 'bundle.yaml config')
  return path
}

async function requireTarget(bundleDir: string, declared: unknown, label: string, kind: 'path' | 'file' | 'directory'): Promise<string> {
  if (typeof declared !== 'string' || declared === '') {
    throw new BundleError(`bundle.yaml ${label} must be a relative path inside the bundle, got ${JSON.stringify(declared)}`, 'PATH_ESCAPE')
  }
  const path = resolveInBundle(bundleDir, declared, `bundle.yaml ${label}`)
  if (!await pathExists(path)) {
    throw new BundleError(`bundle.yaml ${label} points to a missing path: ${path}`, 'POINTER_MISSING')
  }
  if (kind === 'file' && !await isFile(path)) {
    throw new BundleError(`bundle.yaml ${label} must point to a file, got a directory: ${path}`, 'MANIFEST_INVALID')
  }
  if (kind === 'directory' && !await isDirectory(path)) {
    throw new BundleError(`bundle.yaml ${label} must point to a directory, got a file: ${path}`, 'MANIFEST_INVALID')
  }
  return path
}
