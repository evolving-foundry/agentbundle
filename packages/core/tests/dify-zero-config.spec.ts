import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBundleSdk,
  credentialsPath,
  loadStoredCredentials,
  resolveDifyConsole,
  saveDifyCredentials,
} from '../src/index.ts'

let workdir: string
let credentialsFile: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'dify-zero-config-'))
  credentialsFile = join(workdir, 'credentials.json')
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const REGISTRY = (name: string) => join(workdir, `registry-${name}.json`)

function fakeConsoleFetch(options: { activeModels: number }) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetchFn = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    let status = 200
    let text = '{}'
    const setCookie: string[] = []
    if (path === '/console/api/login') {
      setCookie.push('access_token=tok-1; Path=/; HttpOnly', 'csrf_token=csrf-1; Path=/')
      text = JSON.stringify({ result: 'success' })
    } else if (path === '/console/api/workspaces/current/models/model-types/llm') {
      // real dify 1.17.x shape: provider-level entries with nested models arrays
      const providers = Array.from({ length: Math.max(options.activeModels, 0) }, (_, i) => ({
        provider: `prov-${i + 1}/openai_api_compatible/openai_api_compatible`,
        status: 'active',
        models: [{
          model: `auto-model-${i + 1}`,
          model_type: 'llm',
          status: 'active',
        }],
      }))
      text = JSON.stringify({ data: providers })
    } else if (path === '/console/api/apps/imports') {
      calls.push({ method: init.method ?? 'POST', path, body: JSON.parse(init.body ?? '{}') })
      text = JSON.stringify({ id: 'imp-1', status: 'completed', app_id: 'app-auto-1', app_mode: 'workflow' })
    } else if (path.startsWith('/console/api/apps/') && path.endsWith('/workflows/publish')) {
      text = JSON.stringify({ result: 'success' })
    } else if (path.startsWith('/console/api/apps/') && path.endsWith('/api-keys')) {
      status = 201
      text = JSON.stringify({ token: 'app-auto-key' })
    }
    return { status, text, setCookie }
  }
  return { fetchFn, calls }
}

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    AGENT_BUNDLE_CREDENTIALS: credentialsFile,
    AGENT_BUNDLE_REGISTRY: REGISTRY('main'),
    ...overrides,
  }
}

describe('dify credentials store', () => {
  it('round-trips through the JSON file with owner-only access', () => {
    saveDifyCredentials(env({}), { baseUrl: 'http://localhost', email: 'a@b.c', password: 'p' })
    chmodSync(credentialsPath(env({})), 0o644)
    saveDifyCredentials(env({}), { email: 'a@b.c', password: 'p2' })
    expect(statSync(credentialsPath(env({}))).mode & 0o777).toBe(0o600)
    expect(loadStoredCredentials(env({})).dify?.password).toBe('p2')
  })

  it('resolves in precedence order: env > store', async () => {
    saveDifyCredentials(env({}), { baseUrl: 'http://stored', email: 'stored@x', password: 'sp' })
    const fromEnv = await resolveDifyConsole(env({ DIFY_EMAIL: 'env@x', DIFY_PASSWORD: 'ep' }), false)
    expect(fromEnv.source).toBe('env')
    expect(fromEnv.email).toBe('env@x')
    const fromStore = await resolveDifyConsole(env({}), false)
    expect(fromStore.source).toBe('store')
    expect(fromStore.email).toBe('stored@x')
  })

  it('throws CREDENTIALS_MISSING when nothing is configured outside a TTY', async () => {
    await expect(resolveDifyConsole(env({}), false)).rejects.toMatchObject({
      code: 'CREDENTIALS_MISSING',
    })
  })
})

describe('dify zero-config install', () => {
  function writeBundle(dir: string): string {
    writeFileSync(join(dir, 'bundle.yaml'), [
      'kind: dify-agent-bundle',
      'schemaVersion: 1',
      'name: office-agent',
      'harness:',
      '  name: dify',
      '  version: ">=1.17 <2"',
      'entry: ./app/office-agent.dsl.yml',
      'lockfile: ./dependencies.lock',
      'plugins: []',
      'datasets: []',
      '',
    ].join('\n'))
    const appDir = join(dir, 'app')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'office-agent.dsl.yml'), [
      'app:',
      '  mode: workflow',
      '  name: office-agent',
      'kind: app',
      'version: 0.7.0',
      'workflow:',
      '  graph:',
      '    nodes:',
      '      - id: start',
      '        type: start',
      '        data: {type: start, title: Start}',
      '      - id: step1',
      '        type: custom',
      '        data:',
      '          type: llm',
      '          title: step1',
      '          prompt_template:',
      '            - {role: system, text: "organize {{#start.task#}}"}',
      '      - id: end',
      '        type: custom',
      '        data: {type: end, title: End}',
      '    edges: []',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'dependencies.lock'), 'lockfileVersion: 1\n')
    writeFileSync(join(dir, 'agent.yaml'), [
      'model:',
      '  provider: ${DIFY_MODEL_PROVIDER}',
      '  model: ${DIFY_MODEL_NAME}',
      'human_input:',
      '  webapp_delivery: true',
      '  default_action: approve',
      '',
    ].join('\n'))
    return dir
  }

  it('auto-selects the first active chat model when DIFY_MODEL_* is unresolved', async () => {
    const dir = writeBundle(mkdtempSync(join(tmpdir(), 'dify-bundle-auto-')))
    const { fetchFn, calls } = fakeConsoleFetch({ activeModels: 2 })
    const sdk = createBundleSdk({
      env: env({ DIFY_EMAIL: 'ops@example.com', DIFY_PASSWORD: 'pw' }),
      fetchFn,
    })
    const result = await sdk.install(dir)
    expect(result.appId).toBe('app-auto-1')
    const importCall = calls.find(c => c.path === '/console/api/apps/imports')
    expect(JSON.stringify(importCall?.body)).toContain('auto-model-1')
  })

  it('uses stored credentials when env is absent (zero-env install)', async () => {
    const dir = writeBundle(mkdtempSync(join(tmpdir(), 'dify-bundle-zero-')))
    saveDifyCredentials(env({}), {
      baseUrl: 'http://localhost',
      email: 'stored@example.com',
      password: 'stored-pw',
    })
    const { fetchFn } = fakeConsoleFetch({ activeModels: 1 })
    const sdk = createBundleSdk({ env: env({}), fetchFn })
    const result = await sdk.install(dir)
    expect(result.appId).toBe('app-auto-1')
    expect(loadStoredCredentials(env({})).dify?.email).toBe('stored@example.com')
  })

  it('throws CREDENTIALS_MISSING when nothing is configured outside a TTY', async () => {
    const dir = writeBundle(mkdtempSync(join(tmpdir(), 'dify-bundle-miss-')))
    const sdk = createBundleSdk({ env: env({}) })
    await expect(sdk.install(dir)).rejects.toMatchObject({ code: 'CREDENTIALS_MISSING' })
  })

  it('throws BINDING_MISSING when the workspace has no active chat model', async () => {
    const dir = writeBundle(mkdtempSync(join(tmpdir(), 'dify-bundle-nomodel-')))
    const sdk = createBundleSdk({
      env: env({ DIFY_EMAIL: 'ops@example.com', DIFY_PASSWORD: 'pw' }),
      fetchFn: fakeConsoleFetch({ activeModels: 0 }).fetchFn,
    })
    await expect(sdk.install(dir)).rejects.toMatchObject({ code: 'BINDING_MISSING' })
  })
})

