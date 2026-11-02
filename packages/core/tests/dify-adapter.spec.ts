import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBundleManifest, parseDifyAgentConfig } from '../src/manifest.ts'
import { verifyBundle } from '../src/verify.ts'
import { applyHumanInputBinding, applyModelBinding, normalizeIfElseCases } from '../src/adapters/dify/dsl.ts'
import { installDifyBundle, difyAdapter } from '../src/adapters/dify/install.ts'
import { DifyConsoleClient } from '../src/adapters/dify/console.ts'

function writeDifyBundle(dir: string): string {
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
    '      - id: decide',
    '        type: custom',
    '        data:',
    '          type: if-else',
    '          title: decide',
    '          cases:',
    '            case-a: {branchId: case-a, conditions: []}',
    '            case-b: {branchId: case-b, conditions: []}',
    '      - id: step1',
    '        type: custom',
    '        data:',
    '          type: llm',
    '          title: step1',
    '          step_id: minutes.organize',
    '          prompt_template:',
    '            - {role: system, text: "organize {{#start.task#}}"}',
    '      - id: gate',
    '        type: custom',
    '        data:',
    '          type: human-input',
    '          title: gate',
    '          step_id: minutes.actions',
    '      - id: end',
    '        type: custom',
    '        data: {type: end, title: End}',
    '    edges: []',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'dependencies.lock'), 'lockfileVersion: 1\n')
  return dir
}

const WORKFLOW_CALLS: string[] = []
void WORKFLOW_CALLS

function fakeFetch(importedAppId: string) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetchFn = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    let status = 200
    let text = '{}'
    const setCookie: string[] = []
    if (path === '/console/api/login') {
      status = 200
      setCookie.push('access_token=tok-1; Path=/; HttpOnly', 'csrf_token=csrf-1; Path=/')
      text = JSON.stringify({ result: 'success' })
    } else if (path === '/console/api/apps/imports') {
      calls.push({ method: init.method ?? 'POST', path, body: JSON.parse(init.body ?? '{}') })
      status = 200
      text = JSON.stringify({ id: 'imp-1', status: 'completed', app_id: importedAppId, app_mode: 'workflow' })
    } else if (path.startsWith('/console/api/apps/') && path.endsWith('/workflows/publish')) {
      calls.push({ method: 'POST', path, body: {} })
      status = 200
      text = JSON.stringify({ result: 'success' })
    } else if (path.startsWith('/console/api/apps/') && path.endsWith('/api-keys')) {
      calls.push({ method: 'POST', path, body: {} })
      status = 201
      text = JSON.stringify({ token: 'app-test-key' })
    } else if (path.startsWith('/console/api/apps/') && init.method === 'DELETE') {
      calls.push({ method: 'DELETE', path, body: undefined })
      status = 204
      text = ''
    }
    return { status, text, setCookie }
  }
  return { fetchFn, calls }
}

describe('dify manifest parsing', () => {
  it('parses a dify bundle manifest via the kind dispatch', async () => {
    const dir = writeDifyBundle(mkdtempSync(join(tmpdir(), 'dify-bundle-')))
    const manifest = await parseBundleManifest<'dify-agent-bundle'>(dir)
    expect(manifest.kind).toBe('dify-agent-bundle')
    expect(manifest.name).toBe('office-agent')
    expect(manifest.entry).toBe('./app/office-agent.dsl.yml')
    expect(manifest.plugins).toEqual([])
  })

  it('parses an optional dify agent.yaml', async () => {
    const dir = writeDifyBundle(mkdtempSync(join(tmpdir(), 'dify-agent-')))
    writeFileSync(join(dir, 'agent.yaml'), [
      'model:',
      '  provider: ${DIFY_MODEL_PROVIDER}',
      '  model: ${DIFY_MODEL_NAME}',
      'human_input:',
      '  webapp_delivery: true',
      '  default_action: approve',
      '  action_title: Approve',
      '',
    ].join('\n'))
    const config = await parseDifyAgentConfig(dir)
    expect(config.model).toEqual({ provider: '${DIFY_MODEL_PROVIDER}', model: '${DIFY_MODEL_NAME}' })
    expect(config.humanInput).toEqual({ webappDelivery: true, defaultAction: 'approve', actionTitle: 'Approve' })
  })

  it('verifies a dify bundle (lockfile + digest)', async () => {
    const dir = writeDifyBundle(mkdtempSync(join(tmpdir(), 'dify-verify-')))
    const result = await verifyBundle(dir)
    expect(result.manifest.kind).toBe('dify-agent-bundle')
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('dify DSL transforms', () => {
  it('normalizes legacy if-else cases mapping into a list', () => {
    const doc = { workflow: { graph: { nodes: [
      { data: { type: 'if-else', cases: { 'case-x': { branchId: 'case-x', conditions: [] } } } },
    ] } } }
    normalizeIfElseCases(doc as Record<string, unknown>)
    const node = (doc as any).workflow.graph.nodes[0].data
    expect(node.cases).toEqual([{ case_id: 'case-x', logical_operator: 'and', conditions: [] }])
  })

  it('injects model binding into llm nodes', () => {
    const doc = { workflow: { graph: { nodes: [
      { data: { type: 'llm' } },
      { data: { type: 'start' } },
    ] } } }
    applyModelBinding(doc as Record<string, unknown>, { provider: 'p', model: 'm' })
    const nodes = (doc as any).workflow.graph.nodes
    expect(nodes[0].data.model).toEqual({ provider: 'p', name: 'm', mode: 'chat', completion_params: {} })
    expect(nodes[0].data.context).toEqual({ enabled: false, variable_selector: [] })
    expect(nodes[1].data.model).toBeUndefined()
  })

  it('injects human-input webapp delivery and default action', () => {
    const doc = { workflow: { graph: { nodes: [
      { data: { type: 'human-input' } },
    ] } } }
    applyHumanInputBinding(doc as Record<string, unknown>, {
      webappDelivery: true, defaultAction: 'approve', actionTitle: 'Approve',
    })
    const node = (doc as any).workflow.graph.nodes[0].data
    expect(node.delivery_methods).toEqual([{ type: 'webapp', enabled: true }])
    expect(node.user_actions[0].id).toBe('approve')
  })
})

describe('dify adapter install/uninstall', () => {
  it('imports, publishes, activates and registers a dify bundle', async () => {
    const dir = writeDifyBundle(mkdtempSync(join(tmpdir(), 'dify-install-')))
    writeFileSync(join(dir, 'agent.yaml'), [
      'model:',
      '  provider: langgenius/openai_api_compatible/openai_api_compatible',
      '  model: deepseek-v4-flash',
      'human_input:',
      '  webapp_delivery: true',
      '  default_action: approve',
      '',
    ].join('\n'))
    const { fetchFn, calls } = fakeFetch('app-123')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'dify-reg-')), 'installations.json')
    const result = await installDifyBundle({
      bundleDir: dir,
      registryPath,
      env: {
        DIFY_BASE: 'http://dify.test',
        DIFY_EMAIL: 'ops@example.test',
        DIFY_PASSWORD: 'test-pw',
        AGENT_BUNDLE_CREDENTIALS: join(mkdtempSync(join(tmpdir(), 'dify-cred-')), 'credentials.json'),
      },
      fetchFn,
    })
    expect(result.appId).toBe('app-123')
    expect(result.apiKey).toBe('app-test-key')
    expect(result.reused).toBe(false)
    expect(result.launchCommand).toContain('/v1/workflows/run')
    const importCall = calls.find(c => c.path === '/console/api/apps/imports')
    expect(importCall).toBeDefined()
    const graph = parseYaml((importCall!.body as { yaml_content: string }).yaml_content) as {
      workflow: { graph: { nodes: { id: string; data: Record<string, unknown> }[] } }
    }
    const nodes = graph.workflow.graph.nodes
    const step1 = nodes.find((n) => n.id === 'step1')!
    expect((step1.data.model as { name: string }).name).toBe('deepseek-v4-flash')
    const gate = nodes.find((n) => n.id === 'gate')!
    expect(gate.data.delivery_methods).toEqual([{ type: 'webapp', enabled: true }])
    expect((gate.data.user_actions as { id: string }[])[0]!.id).toBe('approve')
    expect(difyAdapter.kind).toBe('dify-agent-bundle')
    void WORKFLOW_CALLS
  })

  it('reuses an existing installation with the same digest', async () => {
    const dir = writeDifyBundle(mkdtempSync(join(tmpdir(), 'dify-reuse-')))
    const { fetchFn } = fakeFetch('app-123')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'dify-reg2-')), 'installations.json')
    const env = {
      DIFY_BASE: 'http://dify.test',
      DIFY_EMAIL: 'ops@example.test',
      DIFY_PASSWORD: 'test-pw',
      AGENT_BUNDLE_CREDENTIALS: join(mkdtempSync(join(tmpdir(), 'dify-cred2-')), 'credentials.json'),
    }
    const first = await installDifyBundle({ bundleDir: dir, registryPath, env, fetchFn })
    expect(first.reused).toBe(false)
    const second = await installDifyBundle({ bundleDir: dir, registryPath, env, fetchFn })
    expect(second.reused).toBe(true)
    expect(second.appId).toBe(first.appId)
  })
})

describe('dify console client auth', () => {
  it('base64-encodes the password and echoes csrf on writes', async () => {
    const seen: { path: string; method: string; headers: Record<string, string>; body?: string }[] = []
    const client = new DifyConsoleClient({
      baseUrl: 'http://dify.test',
      email: 'a@b.c',
      password: 'secret',
      fetchFn: async (url, init) => {
        seen.push({ path: url.replace('http://dify.test', ''), method: init.method, headers: init.headers ?? {}, body: init.body })
        if (seen.length === 1) {
          return {
            status: 200,
            text: JSON.stringify({ result: 'success' }),
            setCookie: ['access_token=tok; Path=/', 'csrf_token=csrf; Path=/'],
          }
        }
        return { status: 200, text: '{}', setCookie: [] }
      },
    })
    await client.call('POST', '/console/api/apps')
    expect(seen[0]!.path).toBe('/console/api/login')
    expect(JSON.parse(seen[0]!.body ?? '{}').password).toBe(btoa('secret'))
    expect(seen[1]!.headers['X-CSRF-Token']).toBe('csrf')
  })
})
