import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBundleSdk } from '../src/sdk.ts'
import type { RunHermes } from '../src/adapters/types.ts'

function writeHermesBundle(dir: string): string {
  writeFileSync(join(dir, 'bundle.yaml'), [
    'kind: hermes-agent-bundle',
    'schemaVersion: 1',
    'name: office-agent',
    'harness:',
    '  name: hermes',
    '  version: ">=0.21.0 <0.22"',
    'entry: ./agent.yaml',
    'lockfile: ./dependencies.lock',
    'plugins:',
    '  - path: ./plugins/office-base',
    '  - path: ./plugins/office-agent',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'agent.yaml'), [
    'model:',
    '  provider: \${AGENT_MODEL_PROVIDER}',
    '  model: \${AGENT_MODEL_NAME}',
    'plugins: {}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'dependencies.lock'), 'lockfileVersion: 1\n')
  for (const name of ['office-base', 'office-agent']) {
    const pluginDir = join(dir, 'plugins', name)
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.yaml'), ['name: ' + name, 'version: 0.2.0', 'description: test', ''].join('\n'))
  }
  return dir
}

describe('hermes SDK lifecycle (createBundleSdk)', () => {
  it('verifies a hermes bundle via the SDK', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'sdk-hermes-verify-')))
    const sdk = createBundleSdk({})
    const result = await sdk.verify(dir)
    expect(result.manifest.kind).toBe('hermes-agent-bundle')
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('installs, activates, loads, and uninstalls a hermes bundle via the SDK', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'sdk-hermes-life-')))
    const home = join(mkdtempSync(join(tmpdir(), 'sdk-hermes-home-')), 'home')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'sdk-hermes-reg-')), 'installations.json')
    const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = []
    const runHermes: RunHermes = async (args, env) => { calls.push({ args, env }) }
    const sdk = createBundleSdk({
      env: { AGENT_MODEL_PROVIDER: 'deepseek', AGENT_MODEL_NAME: 'deepseek-v4-flash' },
      registryPath,
      runHermes,
      log: () => {},
    })

    const installed = await sdk.install(dir, { home })
    expect(installed.reused).toBe(false)
    expect(installed.id).toBe(installed.installationId)
    expect(installed.harness).toEqual({ name: 'hermes', versionRange: '>=0.21.0 <0.22' })
    expect(installed.profile).toBe('office-agent')
    expect(installed.plugins).toEqual(['./plugins/office-base', './plugins/office-agent'])
    expect(installed.launchCommand).toBe('HERMES_HOME=' + home + ' hermes "<task>"')
    expect(calls.map(c => c.args)).toEqual([
      ['plugins', 'enable', 'office-base'],
      ['plugins', 'enable', 'office-agent'],
    ])
    for (const c of calls) expect(c.env.HERMES_HOME).toBe(home)
    const config = readFileSync(join(home, 'config.yaml'), 'utf8')
    expect(config).toContain('deepseek-v4-flash')
    expect(config).toContain('deepseek')

    const activated = await sdk.activate({ id: installed.id, digest: installed.digest, home: installed.home })
    expect(activated.kind).toBe('hermes-agent-bundle')
    expect(activated.name).toBe('office-agent')

    const loaded = await sdk.load({ id: installed.id, digest: installed.digest, home: installed.home })
    expect(loaded.kind).toBe('hermes-agent-bundle')
    expect(loaded.launchCommand).toBe('HERMES_HOME=' + home + ' hermes "<task>"')
    expect(loaded.launchEnv).toEqual({ HERMES_HOME: home })

    await loaded.cleanup()
    expect(existsSync(home)).toBe(false)
  })
})
