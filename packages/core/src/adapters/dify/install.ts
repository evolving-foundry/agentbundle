import { parse as parseYaml, stringify as dumpYaml } from 'yaml'
import { resolve } from 'node:path'
import { DIFY_BUNDLE_KIND, harnessNameForKind } from '../../manifest.ts'
import { verifyBundle, type VerifyResult } from '../../verify.ts'
import { defaultRegistryPath, findRecord, installationId, loadRegistry, removeRecord, upsertRecord, type InstallationRecord } from '../../registry.ts'
import { parseDifyAgentConfig, type DifyAgentConfig } from '../../manifest.ts'
import { resolveModelValue } from '../dsh/install.ts'
import { assertUninstallable, ADAPTER_VERSION } from '../install-core.ts'
import { BundleError } from '../../errors.ts'
import { loadStoredCredentials, resolveDifyConsole, saveDifyCredentials } from '../../credentials.ts'
import { DifyConsoleClient } from './console.ts'
import { applyHumanInputBinding, applyModelBinding, normalizeHumanInputFields, normalizeIfElseCases } from './dsl.ts'
import type { HarnessAdapter, InstallMode, InstallOptions, InstallResult, UninstallOptions, UninstallResult } from '../types.ts'

export interface DifyInstallOptions {
  readonly bundleDir: string
  readonly home?: string
  readonly profileName?: string
  readonly mode?: InstallMode
  /** When true, skip reuse and create a new Dify app. */
  readonly force?: boolean
  readonly log?: (line: string) => void
  readonly registryPath?: string
  /** Console credentials and base URL default to DIFY_* environment variables. */
  readonly env?: NodeJS.ProcessEnv
  readonly fetchFn?: import('./console.ts').DifyFetch
}

export const difyAdapter: HarnessAdapter = {
  kind: DIFY_BUNDLE_KIND,
  install: async (options: InstallOptions) => installDifyBundle(options as DifyInstallOptions),
  uninstall: uninstallDifyInstallation,
  runtimeCheck: async ({ record }) => {
    if (record.appId === undefined) {
      throw new BundleError(`dify installation ${record.id} has no appId recorded; reinstall before activating`, 'REGISTRY_CORRUPT')
    }
  },
  describeLaunch: ({ record }) => {
    const launchEnv: Record<string, string> = record.apiKey === undefined ? {} : { DIFY_API_KEY: record.apiKey }
    return {
      launchCommand: `POST ${record.baseUrl ?? 'http://localhost'}/v1/workflows/run {"inputs":{"task":"<task>"},"response_mode":"streaming"}`,
      launchEnv,
    }
  },
}

/**
 * Zero-config console access: env → stored credentials (~/.agent-bundle/credentials.json)
 * → interactive prompt (TTY only). After a successful login the values are persisted
 * so that every later install/uninstall runs without any environment configuration.
 */
async function buildConsole(options: DifyInstallOptions): Promise<{
  client: DifyConsoleClient
  baseUrl: string
}> {
  const env = options.env ?? process.env
  const resolved = await resolveDifyConsole(env, options.env === undefined)
  const fetchFn = options.fetchFn ?? defaultDifyFetch
  const client = new DifyConsoleClient({
    baseUrl: resolved.baseUrl,
    email: resolved.email,
    password: resolved.password,
    adminApiKey: resolved.adminApiKey,
    fetchFn,
  })
  if (resolved.source === 'env' || resolved.source === 'interactive') {
    const stored = loadStoredCredentials(env).dify
    if (stored?.email !== resolved.email || stored?.password !== resolved.password) {
      const path = saveDifyCredentials(env, {
        baseUrl: resolved.baseUrl,
        email: resolved.email,
        password: resolved.password,
      })
      options.log?.(`console credentials stored: ${path}`)
    }
  }
  return { client, baseUrl: resolved.baseUrl }
}

const defaultDifyFetch: import('./console.ts').DifyFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  })
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return { status: response.status, text: await response.text(), setCookie }
}

export async function installDifyBundle(options: DifyInstallOptions): Promise<InstallResult> {
  const bundleDir = resolve(options.bundleDir)
  const verified = await verifyBundle<typeof DIFY_BUNDLE_KIND>(bundleDir)
  const manifest = verified.manifest
  if (manifest.kind !== DIFY_BUNDLE_KIND) {
    throw new BundleError(`dify adapter received a ${JSON.stringify(manifest.kind)} bundle`, 'MANIFEST_INVALID')
  }
  if (manifest.entry === undefined) {
    throw new BundleError('dify bundle manifest is missing the workflow DSL entry', 'MANIFEST_INVALID')
  }
  const agent: DifyAgentConfig = await parseDifyAgentConfig(bundleDir)
  const env = options.env ?? process.env
  const log = options.log

  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const id = installationId(manifest.name, verified.digest)
  const reusedRecord = options.force === true ? undefined : await findReusableApp(registryPath, id, verified.digest)
  if (reusedRecord !== undefined) {
    log?.(`reusing dify app ${reusedRecord.appId} for digest ${verified.digest}`)
    return assemble(verified, reusedRecord, true)
  }

  const { client, baseUrl: consoleBaseUrl } = await buildConsole(options)

  const envModel = agent.model === undefined
    ? undefined
    : ({
        provider: resolveModelValue(agent.model.provider, env),
        model: resolveModelValue(agent.model.model, env),
      } as { provider: string | undefined; model: string | undefined } | undefined)

  let model: { provider: string; model: string } | undefined =
    envModel !== undefined && envModel.provider !== undefined && envModel.model !== undefined
      ? { provider: envModel.provider, model: envModel.model }
      : undefined
  if (envModel !== undefined && model === undefined) {
    // zero-config fallback: bind to the first active chat model registered in the workspace
    log?.('model binding env unresolved; auto-selecting an active chat model from the workspace')
    const list = await client.call('GET', '/console/api/workspaces/current/models/model-types/llm')
    const data = (list.body as { data?: unknown }).data
    const providerEntries = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
    // the endpoint returns provider-level entries, each carrying a nested models array
    // (dify 1.17.x verified); tolerate a flat model-entry shape defensively
    const isActive = (status: unknown): boolean => status === undefined || status === 'active'
    let picked: { provider: string; model: string } | undefined
    for (const entry of providerEntries) {
      const entryProvider = typeof entry['provider'] === 'string' ? entry['provider'] : ''
      const nested = Array.isArray(entry['models']) ? (entry['models'] as Record<string, unknown>[]) : []
      for (const item of nested) {
        if (!isActive(item['status']) || typeof item['model'] !== 'string' || item['model'] === '') continue
        if (entryProvider !== '') {
          picked = { provider: entryProvider, model: item['model'] }
        }
        break
      }
      if (picked !== undefined) break
      if (typeof entry['model'] === 'string' && entry['model'] !== '' && isActive(entry['status'])) {
        picked = { provider: entryProvider, model: entry['model'] }
        break
      }
    }
    if (picked === undefined) {
      throw new BundleError(
        'no active chat model registered in this dify workspace; '
          + 'register one (console or scripts/register-model.py) then retry install',
        'BINDING_MISSING',
      )
    }
    model = picked
    log?.(`model auto-selected: ${picked.provider}/${picked.model} (active)`)
  }

  const dslPath = resolve(bundleDir, manifest.entry)
  const doc = parseYaml(await import('node:fs/promises').then(fs => fs.readFile(dslPath, 'utf8'))) as Record<string, unknown>
  normalizeIfElseCases(doc)
  normalizeHumanInputFields(doc)
  if (model !== undefined) {
    applyModelBinding(doc, { provider: model.provider, model: model.model })
  }
  if (agent.humanInput !== undefined) {
    applyHumanInputBinding(doc, agent.humanInput)
  }
  const yamlContent = dumpYaml(doc)

  const appName = `${manifest.name}-${verified.digest.slice(7, 15)}`
  log?.(`importing workflow into dify as ${appName}`)
  const imported = await importWorkflow(client, yamlContent, appName)
  await publishWorkflow(client, imported.appId)

  const apiKey = await createApiKey(client, imported.appId)

  const record: InstallationRecord = {
    id,
    name: manifest.name,
    kind: manifest.kind,
    digest: verified.digest,
    home: `dify-app:${imported.appId}`,
    profile: appName,
    bundleDir,
    installedAt: new Date().toISOString(),
    mode: options.mode ?? 'ephemeral',
    harnessVersion: manifest.harnessVersion,
    adapterVersion: ADAPTER_VERSION,
    status: 'installed',
    appId: imported.appId,
    apiKey,
    baseUrl: consoleBaseUrl,
  }
  await upsertRecord(options.registryPath ?? defaultRegistryPath(options.env), record)
  log?.(`installed dify app ${imported.appId} for bundle ${manifest.name}`)
  return assemble(verified, record, false)
}

function assemble(verified: VerifyResult<typeof DIFY_BUNDLE_KIND>, record: InstallationRecord, reused: boolean): InstallResult {
  const baseUrl = record.baseUrl ?? 'http://localhost'
  return {
    id: record.id,
    digest: verified.digest,
    home: record.home,
    installationId: record.id,
    harness: { name: harnessNameForKind(DIFY_BUNDLE_KIND), versionRange: verified.manifest.harnessVersion },
    profile: record.profile,
    plugins: [],
    reused,
    launchCommand: `POST ${baseUrl}/v1/workflows/run {"inputs":{"task":"<task>"},"response_mode":"streaming"}`,
    ...(record.appId !== undefined ? { appId: record.appId } : {}),
    ...(record.apiKey !== undefined ? { apiKey: record.apiKey } : {}),
  }
}

export interface ImportedApp {
  readonly appId: string
}

async function importWorkflow(client: DifyConsoleClient, yamlContent: string, name: string): Promise<ImportedApp> {
  const imported = await client.call('POST', '/console/api/apps/imports', {
    mode: 'yaml-content', yaml_content: yamlContent, name,
  })
  if (imported.status !== 200) {
    throw new BundleError(`dify DSL import failed: ${imported.status} ${JSON.stringify(imported.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
  }
  const body = imported.body as { id?: string; status?: string; app_id?: string; error?: string }
  let appId = body.app_id
  if (appId === undefined && body.id !== undefined && (body.status === 'pending' || body.status === 'waiting')) {
    const confirmed = await client.call('POST', `/console/api/apps/imports/${body.id}/confirm`, {})
    if (confirmed.status !== 200) {
      throw new BundleError(`dify import confirm failed: ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
    }
    const confirmedBody = confirmed.body as { app_id?: string }
    appId = confirmedBody.app_id
  }
  if (appId === undefined) {
    throw new BundleError(`dify import did not yield app_id: ${JSON.stringify(imported.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
  }
  return { appId }
}

async function publishWorkflow(client: DifyConsoleClient, appId: string): Promise<void> {
  const published = await client.call('POST', `/console/api/apps/${appId}/workflows/publish`, {})
  if (published.status !== 200 && published.status !== 201) {
    throw new BundleError(`dify workflow publish failed: ${published.status} ${JSON.stringify(published.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
  }
}

async function createApiKey(client: DifyConsoleClient, appId: string): Promise<string> {
  const created = await client.call('POST', `/console/api/apps/${appId}/api-keys`, {})
  if (created.status !== 200 && created.status !== 201) {
    throw new BundleError(`dify api-key creation failed: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
  }
  const body = created.body as { token?: string; data?: { token?: string } }
  const token = body.token ?? body.data?.token
  if (token === undefined) {
    throw new BundleError(`dify api-key response did not contain a token: ${JSON.stringify(created.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
  }
  return token
}

async function findReusableApp(registryPath: string, id: string, digest: string): Promise<InstallationRecord | undefined> {
  const records = await loadRegistry(registryPath)
  const match = records.find(entry => entry.id === id && entry.digest === digest && entry.appId !== undefined)
  return match
}

async function uninstallDifyInstallation(options: UninstallOptions): Promise<UninstallResult> {
  const env = options.env ?? process.env
  const resolved = await resolveDifyConsole(env, options.env === undefined)
  const client = new DifyConsoleClient({
    baseUrl: resolved.baseUrl,
    email: resolved.email,
    password: resolved.password,
    adminApiKey: resolved.adminApiKey,
    fetchFn: defaultDifyFetch,
  })
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env)
  const record = await findRecord(registryPath, options.id, options.digest !== undefined ? { digest: options.digest } : {})
  assertUninstallable(record, options.force)
  const appId = record.appId
  if (appId === undefined) {
    throw new BundleError(`dify installation ${options.id} has no appId recorded; cannot uninstall`, 'REGISTRY_CORRUPT')
  }
  const deleted = await client.call('DELETE', `/console/api/apps/${appId}`)
  if (deleted.status !== 200 && deleted.status !== 204 && deleted.status !== 404) {
    throw new BundleError(`dify app deletion failed: ${deleted.status} ${JSON.stringify(deleted.body).slice(0, 300)}`, 'NATIVE_COMMAND_FAILED')
  }
  await removeRecord(registryPath, options.id, options.digest !== undefined ? { digest: options.digest } : {})
  return { removed: true, homeExisted: false, occupied: false, bundleDir: record.bundleDir }
}
