import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HERMES_BUNDLE_KIND, parseBundleManifest } from '../src/manifest.ts'
import { verifyBundle } from '../src/verify.ts'
import { hermesAdapter, installHermesBundle } from '../src/adapters/hermes/install.ts'
import { uninstallInstallation } from '../src/adapters/uninstall.ts'
import { loadRegistry } from '../src/registry.ts'
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
    '  provider: ${AGENT_MODEL_PROVIDER}',
    '  model: ${AGENT_MODEL_NAME}',
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

describe('hermes manifest parsing', () => {
  it('parses a hermes bundle manifest via the kind dispatch', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-bundle-')))
    const manifest = await parseBundleManifest<typeof HERMES_BUNDLE_KIND>(dir)
    expect(manifest.kind).toBe('hermes-agent-bundle')
    expect(manifest.name).toBe('office-agent')
    expect(manifest.declaredPlugins).toEqual(['./plugins/office-base', './plugins/office-agent'])
    expect(manifest.pluginNames).toEqual(['office-base', 'office-agent'])
  })

  it('verifies a hermes bundle (lockfile + digest)', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-verify-')))
    const result = await verifyBundle(dir)
    expect(result.manifest.kind).toBe('hermes-agent-bundle')
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects a hermes plugin missing plugin.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-bad-'))
    writeFileSync(join(dir, 'bundle.yaml'), [
      'kind: hermes-agent-bundle',
      'schemaVersion: 1',
      'name: bad',
      'harness:',
      '  name: hermes',
      '  version: ">=0.21.0 <0.22"',
      'entry: ./agent.yaml',
      'lockfile: ./dependencies.lock',
      'plugins:',
      '  - path: ./plugins/none',
      '',
    ].join('\n'))
    mkdirSync(join(dir, 'plugins', 'none'), { recursive: true })
    writeFileSync(join(dir, 'agent.yaml'), 'plugins: {}\n')
    writeFileSync(join(dir, 'dependencies.lock'), 'lockfileVersion: 1\n')
    await expect(parseBundleManifest(dir)).rejects.toThrow(/plugin manifest/)
  })
})

describe('hermes adapter install/uninstall', () => {
  it('copies plugins, enables them, binds model, and registers', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-install-')))
    const home = join(mkdtempSync(join(tmpdir(), 'hermes-home-')), 'home')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-reg-')), 'installations.json')
    const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = []
    const runHermes: RunHermes = async (args, env) => { calls.push({ args, env }) }
    const result = await installHermesBundle({
      bundleDir: dir,
      home,
      runHermes,
      registryPath,
      env: { AGENT_MODEL_PROVIDER: 'deepseek', AGENT_MODEL_NAME: 'deepseek-v4-flash' },
    })
    expect(result.reused).toBe(false)
    expect(result.launchCommand).toBe('HERMES_HOME=' + home + ' hermes "<task>"')
    expect(result.plugins).toEqual(['./plugins/office-base', './plugins/office-agent'])
    expect(calls.map(c => c.args)).toEqual([
      ['plugins', 'enable', 'office-base'],
      ['plugins', 'enable', 'office-agent'],
    ])
    for (const c of calls) {
      expect(c.env.HERMES_HOME).toBe(home)
    }
    expect(readFileSync(join(home, 'plugins', 'office-base', 'plugin.yaml'), 'utf8')).toContain('name: office-base')
    expect(readFileSync(join(home, 'plugins', 'office-agent', 'plugin.yaml'), 'utf8')).toContain('name: office-agent')
    const config = readFileSync(join(home, 'config.yaml'), 'utf8')
    expect(config).toContain('deepseek-v4-flash')
    expect(config).toContain('deepseek')
    expect(hermesAdapter.kind).toBe('hermes-agent-bundle')
  })

  it('honors an explicit profile name (H1: profile passthrough)', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-profile-')))
    const home = join(mkdtempSync(join(tmpdir(), 'hermes-home3-')), 'home')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-reg3-')), 'installations.json')
    const runHermes: RunHermes = async () => {}
    const result = await installHermesBundle({
      bundleDir: dir,
      home,
      runHermes,
      registryPath,
      profileName: 'evaluator',
      env: { AGENT_MODEL_PROVIDER: 'deepseek', AGENT_MODEL_NAME: 'deepseek-v4-flash' },
    })
    expect(result.profile).toBe('evaluator')
  })

  it('reuses an existing installation with the same digest', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-reuse-')))
    const home = join(mkdtempSync(join(tmpdir(), 'hermes-home2-')), 'home')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-reg2-')), 'installations.json')
    const runHermes: RunHermes = async () => {}
    const env = { AGENT_MODEL_PROVIDER: 'deepseek', AGENT_MODEL_NAME: 'deepseek-v4-flash' }
    const first = await installHermesBundle({ bundleDir: dir, home, runHermes, registryPath, env })
    expect(first.reused).toBe(false)
    const second = await installHermesBundle({ bundleDir: dir, home, runHermes, registryPath, env })
    expect(second.reused).toBe(true)
  })
})

describe('hermes native install/uninstall', () => {
  it('installs natively into HERMES_HOME and leaves the host model config untouched when env is unset', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-native-')))
    const nativeHome = join(mkdtempSync(join(tmpdir(), 'hermes-native-home-')), 'hermes')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-native-reg-')), 'installations.json')
    const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = []
    const runHermes: RunHermes = async (args, env) => { calls.push({ args, env }) }

    const result = await installHermesBundle({
      bundleDir: dir,
      runHermes,
      registryPath,
      mode: 'native',
      env: { HERMES_HOME: nativeHome },
    })

    expect(result.home).toBe(nativeHome)
    expect(result.launchCommand).toBe('hermes "<task>"')
    expect(result.launchEnv).toBeUndefined()
    expect(calls.map(c => c.args)).toEqual([
      ['plugins', 'enable', 'office-base'],
      ['plugins', 'enable', 'office-agent'],
    ])
    expect(existsSync(join(nativeHome, 'plugins', 'office-base', 'plugin.yaml'))).toBe(true)
    // native + unresolved model: no config.yaml is written (host default applies)
    expect(existsSync(join(nativeHome, 'config.yaml'))).toBe(false)
    expect(existsSync(join(nativeHome, '.bundle', 'office-agent', '.bundle-install.json'))).toBe(true)

    const [record] = await loadRegistry(registryPath)
    expect(record?.mode).toBe('native')
    expect(record?.nativeSubtree).toContain('plugins/office-base')
    expect(record?.nativeSubtree).toContain('.bundle/office-agent')
  })

  it('reuses a native install whose stamp matches without re-enabling', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-native-reuse-')))
    const nativeHome = join(mkdtempSync(join(tmpdir(), 'hermes-native-reuse-home-')), 'hermes')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-native-reuse-reg-')), 'installations.json')
    let enables = 0
    const runHermes: RunHermes = async () => { enables += 1 }
    const installOptions = { bundleDir: dir, runHermes, registryPath, mode: 'native' as const, env: { HERMES_HOME: nativeHome } }
    const first = await installHermesBundle(installOptions)
    expect(first.reused).toBe(false)
    const second = await installHermesBundle(installOptions)
    expect(second.reused).toBe(true)
    expect(enables).toBe(2) // only the first install enabled the two plugins
  })

  it('refuses a native install over a foreign plugin dir (no reuse stamp)', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-native-foreign-')))
    const nativeHome = join(mkdtempSync(join(tmpdir(), 'hermes-native-foreign-home-')), 'hermes')
    mkdirSync(join(nativeHome, 'plugins', 'office-base'), { recursive: true })
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-native-foreign-reg-')), 'installations.json')
    const runHermes: RunHermes = async () => {}
    await expect(installHermesBundle({
      bundleDir: dir,
      runHermes,
      registryPath,
      mode: 'native',
      env: { HERMES_HOME: nativeHome },
    })).rejects.toThrow(/refuses to take over existing plugin/)
  })

  it('uninstalls a native install: removes bundle plugins + metadata, keeps the home', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-native-uninstall-')))
    const nativeHome = join(mkdtempSync(join(tmpdir(), 'hermes-native-uninstall-home-')), 'hermes')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-native-uninstall-reg-')), 'installations.json')
    const runHermes: RunHermes = async () => {}
    const installed = await installHermesBundle({
      bundleDir: dir,
      runHermes,
      registryPath,
      mode: 'native',
      env: { HERMES_HOME: nativeHome },
    })
    // a sibling user plugin the bundle did NOT own, plus a host config, must survive
    mkdirSync(join(nativeHome, 'plugins', 'user-plugin'), { recursive: true })
    writeFileSync(join(nativeHome, 'config.yaml'), 'model: {}\n')

    const result = await uninstallInstallation({ id: installed.id, digest: installed.digest, home: installed.home, registryPath })
    expect(result.homeKept).toBe(nativeHome)
    expect(existsSync(join(nativeHome, 'plugins', 'office-base'))).toBe(false)
    expect(existsSync(join(nativeHome, 'plugins', 'office-agent'))).toBe(false)
    expect(existsSync(join(nativeHome, '.bundle', 'office-agent'))).toBe(false)
    expect(existsSync(join(nativeHome, 'plugins', 'user-plugin'))).toBe(true)
    expect(existsSync(join(nativeHome, 'config.yaml'))).toBe(true)
    expect(existsSync(nativeHome)).toBe(true)
  })

  it('fails loudly when the model env is unresolved for an owned (non-native) home', async () => {
    const dir = writeHermesBundle(mkdtempSync(join(tmpdir(), 'hermes-owned-model-')))
    const home = join(mkdtempSync(join(tmpdir(), 'hermes-owned-model-home-')), 'home')
    const registryPath = join(mkdtempSync(join(tmpdir(), 'hermes-owned-model-reg-')), 'installations.json')
    const runHermes: RunHermes = async () => {}
    await expect(installHermesBundle({ bundleDir: dir, home, runHermes, registryPath })).rejects.toThrow(/AGENT_MODEL_PROVIDER/)
  })
})
