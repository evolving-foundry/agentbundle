import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BundleError,
  computeBundleDigest,
  dispatchUninstall,
  findHomeOccupants,
  installBundle,
  installHome,
  loadRegistry,
  parseAgentConfig,
  parseBundleManifest,
  resolveDshCommand,
  saveRegistry,
  upsertRecord,
  verifyBundle,
  type InstallationRecord,
} from '../src/index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeBundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-spec-'))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
  tempDirs.push(dir)
  return dir
}

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-home-'))
  tempDirs.push(dir)
  return dir
}

const VALID_BUNDLE_YAML = [
  'kind: dsh-agent-bundle',
  'schemaVersion: 1',
  'name: probe-demo',
  'harness:',
  '  name: dsh',
  '  version: ">=0.1.6-alpha.1 <0.2"',
  'plugins:',
  '  - path: ./plugins/probe',
].join('\n')
const PROBE_PACKAGE_JSON = JSON.stringify({
  name: '@dsh-bundle-test/probe',
  version: '1.0.0',
  main: 'lib/index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
})

async function validBundle(agentYaml = 'model:\n  provider: test-provider\n  model: test-model\n'): Promise<string> {
  return await makeBundle({
    'bundle.yaml': VALID_BUNDLE_YAML,
    'agent.yaml': agentYaml,
    'dependencies.lock': '# placeholder\n',
    'plugins/probe/package.json': PROBE_PACKAGE_JSON,
    'plugins/probe/lib/index.js': 'export const probe = true\n',
    'plugins/probe/cordis.patch.yml': '- insert: []\n',
  })
}

describe('parseBundleManifest', () => {
  it('accepts a valid bundle and resolves plugin paths', async () => {
    const dir = await validBundle()
    const manifest = await parseBundleManifest<'dsh-agent-bundle'>(dir)
    expect(manifest.name).toBe('probe-demo')
    expect(manifest.plugins).toEqual([join(dir, 'plugins', 'probe')])
    expect(manifest.declaredPlugins).toEqual(['./plugins/probe'])
  })

  it('rejects a missing directory, a file, missing files, and bad fields', async () => {
    await expect(parseBundleManifest(join(tmpdir(), 'agent-bundle-absent'))).rejects.toThrow(BundleError)
    const file = await makeBundle({ 'bundle.yaml': VALID_BUNDLE_YAML })
    await expect(parseBundleManifest(join(file, 'bundle.yaml'))).rejects.toThrow(BundleError)
    const noManifest = await makeBundle({ 'agent.yaml': '' })
    await expect(parseBundleManifest(noManifest)).rejects.toThrow('required bundle file is missing')
    const listManifest = await makeBundle({ 'bundle.yaml': '- just\n- a list\n' })
    await expect(parseBundleManifest(listManifest)).rejects.toThrow('must contain a YAML mapping')
    const nullManifest = await makeBundle({ 'bundle.yaml': 'null\n' })
    await expect(parseBundleManifest(nullManifest)).rejects.toThrow('must contain a YAML mapping')
    const cases: Array<[string, string]> = [
      ['kind: other\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ./p', 'kind must be'],
      ['kind: dsh-agent-bundle\nschemaVersion: 2\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ./p', 'schemaVersion must be 1'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: Bad_Name\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ./p', 'name must match'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\nplugins:\n  - path: ./p', 'harness.name must be "dsh"'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ""\nplugins:\n  - path: ./p', 'harness.version must be a non-empty'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: 3\nplugins:\n  - path: ./p', 'harness.version must be a non-empty'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\n', 'non-empty list'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins: []', 'non-empty list'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: /abs', 'must stay inside the bundle'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ../out', 'must stay inside the bundle'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ./absent', 'has no package.json'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: 3', 'must be a relative string'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nentry: ../agent.yaml\nplugins:\n  - path: ./p', 'entry must be a relative path'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nlockfile: ./absent.lock\nplugins:\n  - path: ./p', 'points to a missing file'],
    ]
    const scalar = await makeBundle({ 'bundle.yaml': 'just a string\n' })
    await expect(parseBundleManifest(scalar)).rejects.toThrow('must contain a YAML mapping')
    const invalid = await makeBundle({ 'bundle.yaml': 'settings: [unclosed\n' })
    await expect(parseBundleManifest(invalid)).rejects.toThrow('is not valid YAML')
    for (const [yaml, message] of cases) {
      const dir = await validBundle()
      await writeFile(join(dir, 'bundle.yaml'), yaml)
      await expect(parseBundleManifest(dir)).rejects.toThrow(message)
    }
  })

  it('enforces the plugin package contract (patch field, patch file, built entry)', async () => {
    const missingPatchField = await validBundle()
    await writeFile(join(missingPatchField, 'plugins/probe/package.json'), JSON.stringify({ name: 'p', version: '1.0.0', main: 'lib/index.js' }))
    await expect(parseBundleManifest(missingPatchField)).rejects.toThrow('must declare dsh.bundle.patch')

    const missingPatchFile = await validBundle()
    await rm(join(missingPatchFile, 'plugins/probe/cordis.patch.yml'))
    await expect(parseBundleManifest(missingPatchFile)).rejects.toThrow('which is missing at')

    const missingEntry = await validBundle()
    await rm(join(missingEntry, 'plugins/probe/lib/index.js'))
    await expect(parseBundleManifest(missingEntry)).rejects.toThrow('must contain built JS')

    const escapingPatch = await validBundle()
    await writeFile(join(escapingPatch, 'plugins/probe/package.json'), JSON.stringify({ name: 'p', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: '../../evil.yml' } } }))
    await expect(parseBundleManifest(escapingPatch)).rejects.toThrow('must stay inside the plugin')

    const exportsEntry = await validBundle()
    await writeFile(join(exportsEntry, 'plugins/probe/package.json'), JSON.stringify({
      name: 'p', version: '1.0.0',
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await expect(parseBundleManifest(exportsEntry)).resolves.toBeDefined()
  })
})

describe('parseAgentConfig', () => {
  it('returns an empty config when no model is declared', async () => {
    const dir = await makeBundle({ 'agent.yaml': 'other: value\n' })
    expect(await parseAgentConfig(dir)).toEqual({})
  })

  it('accepts a model and rejects malformed shapes', async () => {
    const good = await validBundle()
    expect(await parseAgentConfig(good)).toEqual({ model: { provider: 'test-provider', model: 'test-model' } })
    const bad = await makeBundle({ 'agent.yaml': 'model:\n  provider: 3\n' })
    await expect(parseAgentConfig(bad)).rejects.toThrow('string provider and model')
    const listAgent = await makeBundle({ 'agent.yaml': '- x\n' })
    await expect(parseAgentConfig(listAgent)).rejects.toThrow('must contain a YAML mapping')
    const scalarModel = await makeBundle({ 'agent.yaml': 'model: 3\n' })
    await expect(parseAgentConfig(scalarModel)).rejects.toThrow('string provider and model')
    const nullModel = await makeBundle({ 'agent.yaml': 'model: null\n' })
    await expect(parseAgentConfig(nullModel)).rejects.toThrow('string provider and model')
  })
})

describe('computeBundleDigest', () => {
  it('matches the known vector for a fixed bundle', async () => {
    const dir = await makeBundle({
      'agent.yaml': 'other: value\n',
      'dependencies.lock': '# placeholder\n',
    })
    expect(await computeBundleDigest(dir)).toBe('sha256:7669e16a8d7bcb6f78b9021dd037f2b7a6438f59786517632f01bc67af1bd7a3')
  })

  it('is deterministic, content-sensitive, and skips excluded directories', async () => {
    const dir = await validBundle()
    const first = await computeBundleDigest(dir)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await computeBundleDigest(dir)).toBe(first)
    await writeFile(join(dir, 'agent.yaml'), 'model:\n  provider: changed\n  model: test-model\n')
    expect(await computeBundleDigest(dir)).not.toBe(first)
    const withExcluded = await validBundle()
    await mkdir(join(withExcluded, 'node_modules/x'), { recursive: true })
    await writeFile(join(withExcluded, 'node_modules/x/index.js'), 'x')
    await mkdir(join(withExcluded, '.git'), { recursive: true })
    await writeFile(join(withExcluded, '.git/HEAD'), 'ref: refs/heads/main\n')
    const withoutExcluded = await validBundle()
    expect(await computeBundleDigest(withExcluded)).toBe(await computeBundleDigest(withoutExcluded))
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links and reports the offending path', async () => {
    const dir = await validBundle()
    await symlink('/etc/hostname', join(dir, 'linked'))
    await expect(computeBundleDigest(dir)).rejects.toThrow('symbolic link')
    await expect(computeBundleDigest(dir)).rejects.toThrow('linked')
  })
})

describe('verifyBundle', () => {
  it('requires dependencies.lock to exist', async () => {
    const dir = await validBundle()
    await rm(join(dir, 'dependencies.lock'))
    await expect(verifyBundle(dir)).rejects.toThrow('required dependencies.lock is missing')
  })

  it('returns manifest, agent, and digest for a valid bundle', async () => {
    const dir = await validBundle()
    const result = await verifyBundle(dir)
    expect(result.manifest.kind).toBe('dsh-agent-bundle')
    expect(result.agent.model).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('anchors tamper detection on --expect-digest', async () => {
    const dir = await validBundle()
    const { digest } = await verifyBundle(dir)
    await expect(verifyBundle(dir, { expectDigest: digest })).resolves.toBeDefined()
    await writeFile(join(dir, 'agent.yaml'), 'model:\n  provider: changed\n  model: test-model\n')
    await expect(verifyBundle(dir, { expectDigest: digest })).rejects.toThrow('digest mismatch: expected')
    await expect(verifyBundle(dir, { expectDigest: digest })).rejects.toThrow(digest)
    await expect(verifyBundle(dir, { expectDigest: 'not-a-digest' })).rejects.toThrow('must match sha256:<64 hex chars>')
  })
})

describe('resolveDshCommand', () => {
  it('prefers DSH_BIN, wrapping .js entries with node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-dshbin-'))
    tempDirs.push(dir)
    const jsEntry = join(dir, 'entry.js')
    await writeFile(jsEntry, '// entry\n')
    const js = await resolveDshCommand({ DSH_BIN: jsEntry })
    expect(js.command).toBe(process.execPath)
    expect(js.args).toEqual([jsEntry])
    expect(js.source).toBe('DSH_BIN')
    const wrapper = join(dir, 'dsh-wrapper')
    await writeFile(wrapper, '#!/bin/sh\n')
    const exe = await resolveDshCommand({ DSH_BIN: wrapper })
    expect(exe.command).toBe(wrapper)
    expect(exe.args).toEqual([])
  })

  it('fails when DSH_BIN points nowhere', async () => {
    await expect(resolveDshCommand({ DSH_BIN: '/absent/dsh.js' })).rejects.toThrow('points to a missing file')
  })

  it('prefers the built checkout bin over the tsx source launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-checkout-'))
    tempDirs.push(dir)
    await mkdir(join(dir, 'apps/cli/lib'), { recursive: true })
    await writeFile(join(dir, 'apps/cli/lib/bin.js'), '// bin\n')
    const built = await resolveDshCommand({ DSH_CHECKOUT: dir })
    expect(built.command).toBe(process.execPath)
    expect(built.args).toEqual([join(dir, 'apps/cli/lib/bin.js')])
    expect(built.extraEnv).toEqual({})
  })

  it('falls back to the tsx source launch with the checkout tsconfig', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-checkout-'))
    tempDirs.push(dir)
    await mkdir(join(dir, 'apps/cli/src'), { recursive: true })
    await mkdir(join(dir, 'node_modules/tsx/dist/esm'), { recursive: true })
    await writeFile(join(dir, 'apps/cli/src/bin.ts'), '// bin\n')
    await writeFile(join(dir, 'node_modules/tsx/dist/esm/index.mjs'), '// tsx\n')
    const source = await resolveDshCommand({ DSH_CHECKOUT: dir })
    expect(source.args).toEqual(['--import', join(dir, 'node_modules/tsx/dist/esm/index.mjs'), join(dir, 'apps/cli/src/bin.ts')])
    expect(source.extraEnv['TSX_TSCONFIG_PATH']).toBe(join(dir, 'tsconfig.json'))
  })

  it('reports a checkout with neither build nor source launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-checkout-'))
    tempDirs.push(dir)
    await expect(resolveDshCommand({ DSH_CHECKOUT: dir })).rejects.toThrow('neither a built CLI')
  })

  it('falls back to an executable dsh on PATH (revision of the hard disable)', async () => {
    const binDir = await makeHome()
    const dshPath = join(binDir, 'dsh')
    await writeFile(dshPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const resolved = await resolveDshCommand({ PATH: binDir })
    expect(resolved).toMatchObject({ command: dshPath, args: [], source: 'PATH' })
  })

  it('hard-fails when nothing resolves (no env override, no dsh on PATH)', async () => {
    await expect(resolveDshCommand({ PATH: '/agent-bundle-spec-empty-path' })).rejects.toThrow('no dsh on PATH')
  })
})

describe('installBundle', () => {
  it('initializes the profile, installs plugins through the seam, writes settings, and registers the install', async () => {
    const dir = await validBundle()
    const target = await makeHome()
    const registryPath = join(await makeHome(), 'installations.json')
    const spawned: Array<{ args: readonly string[]; env: Record<string, string>; options?: { allowFailure?: boolean; quiet?: boolean } }> = []
    const lines: string[] = []
    const result = await installBundle({
      bundleDir: dir,
      home: target,
      registryPath,
      runDsh: async (args, env, options) => { spawned.push({ args, env: { ...env }, options }) },
      log: line => { lines.push(line) },
    })
    expect(result.reused).toBe(false)
    expect(result.profile).toBe('bundle-probe-demo')
    expect(result.plugins).toEqual(['./plugins/probe'])
    expect(result.launchCommand).toBe('dsh --profile bundle-probe-demo "<task>"')
    expect(spawned).toHaveLength(2)
    expect(spawned[0]?.args).toEqual(['--profile', 'bundle-probe-demo', '--from-default-profile', 'headless'])
    expect(spawned[0]?.env['DSH_HOME']).toBe(target)
    expect(spawned[0]?.options).toEqual({ allowFailure: true, quiet: true })
    const stagedDir = join(target, 'profiles', 'bundle-probe-demo', '.bundle-plugins', 'probe')
    expect(spawned[1]?.args).toEqual(['plugin', '--profile', 'bundle-probe-demo', 'add', stagedDir])
    expect(spawned[1]?.env['DSH_HOME']).toBe(target)
    // The plugin is materialized as a physical copy inside the profile
    // subtree (snapshot semantics): content present, node_modules excluded.
    const stagedEntry = await readFile(join(stagedDir, 'lib', 'index.js'), 'utf8')
    expect(stagedEntry).toContain('export const probe = true')
    await expect(readFile(join(stagedDir, 'node_modules'), 'utf8')).rejects.toThrow()
    const settings = await readFile(join(target, 'settings.yaml'), 'utf8')
    expect(settings).toContain('agent-default-model')
    expect(settings).toContain('test-provider')
    const reuseRecord = JSON.parse(await readFile(join(target, 'profiles', 'bundle-probe-demo', '.bundle-install.json'), 'utf8')) as { digest: string; bundleDir: string }
    expect(reuseRecord.digest).toBe(result.digest)
    expect(reuseRecord.bundleDir).toBe(dir)
    const records = await loadRegistry(registryPath)
    expect(records).toHaveLength(1)
    expect(records[0]?.id).toBe(`probe-demo-${result.digest.slice(7, 15)}`)
    expect(records[0]?.mode).toBe('ephemeral')
    expect(lines.some(line => line.includes('installing plugin probe'))).toBe(true)
  })

  it('reuses an installation whose recorded digest matches and still refreshes the registry', async () => {
    const dir = await validBundle()
    const target = await makeHome()
    const registryPath = join(await makeHome(), 'installations.json')
    let spawns = 0
    const runDsh = async (): Promise<void> => { spawns += 1 }
    await installBundle({ bundleDir: dir, home: target, registryPath, runDsh })
    expect(spawns).toBe(2)
    const reused = await installBundle({
      bundleDir: dir, home: target, registryPath, runDsh,
      log: line => { expect(line).toContain('reusing installation') },
    })
    expect(reused.reused).toBe(true)
    expect(spawns).toBe(2)
    expect((await loadRegistry(registryPath))).toHaveLength(1)

    const forcedArgs: string[][] = []
    const forced = await installBundle({
      bundleDir: dir,
      home: target,
      registryPath,
      force: true,
      runDsh: async args => {
        spawns += 1
        forcedArgs.push([...args])
      },
    })
    expect(forced.reused).toBe(false)
    expect(spawns).toBe(5)
    expect(forcedArgs.map(args => args[0] === 'plugin' ? args[3] : 'init')).toEqual(['remove', 'init', 'add'])
    expect(forcedArgs[0]).toEqual(['plugin', '--profile', 'bundle-probe-demo', 'remove', '@dsh-bundle-test/probe'])
    expect(forcedArgs[2]).toEqual(['plugin', '--profile', 'bundle-probe-demo', 'add', join(target, 'profiles', 'bundle-probe-demo', '.bundle-plugins', 'probe')])
  })

  it('fails a stamp mismatch unless --force is passed', async () => {
    const dir = await validBundle()
    const target = await makeHome()
    const registryPath = join(await makeHome(), 'installations.json')
    const installed = await installBundle({ bundleDir: dir, home: target, registryPath, runDsh: async () => {} })
    const stampPath = join(target, 'profiles', 'bundle-probe-demo', '.bundle-install.json')
    await writeFile(stampPath, `${JSON.stringify({ digest: installed.digest, bundleDir: dir }, null, 2)}\n`, 'utf8')
    let calls = 0
    const error = await installBundle({
      bundleDir: dir,
      home: target,
      registryPath,
      runDsh: async () => { calls += 1 },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('INSTALL_CONFLICT')
    expect((error as BundleError).message).toContain('--force')
    expect(calls).toBe(0)

    const args: string[][] = []
    const forced = await installBundle({
      bundleDir: dir,
      home: target,
      registryPath,
      force: true,
      runDsh: async (command) => { args.push([...command]) },
    })
    expect(forced.reused).toBe(false)
    expect(args.map(command => command[0] === 'plugin' ? command[3] : 'init')).toEqual(['remove', 'init', 'add'])
  })

  it('defaults the home to a digest-named temp dir and skips settings without a model', async () => {
    const dir = await validBundle('other: value\n')
    const result = await installBundle({ bundleDir: dir, registryPath: join(await makeHome(), 'installations.json'), runDsh: async () => {} })
    expect(result.home).toContain(`dsh-bundle-probe-demo-${result.digest.slice(7, 15)}`)
    await expect(readFile(join(result.home, 'settings.yaml'), 'utf8')).rejects.toThrow()
    tempDirs.push(result.home)
  })

  it('installs natively into the harness default home and leaves the launch env-free', async () => {
    const dir = await validBundle('other: value\n')
    const nativeHome = await makeHome()
    const registryPath = join(await makeHome(), 'installations.json')
    const spawned: Array<{ args: readonly string[]; env: Record<string, string> }> = []
    const result = await installBundle({
      bundleDir: dir,
      registryPath,
      mode: 'native',
      env: { DSH_HOME: nativeHome },
      runDsh: async (args, env) => { spawned.push({ args, env: { ...env } }) },
    })
    expect(result.home).toBe(nativeHome)
    expect(result.profile).toBe('bundle-probe-demo')
    expect(result.launchEnv).toBeUndefined()
    for (const spawn of spawned) {
      expect(spawn.env['DSH_HOME']).toBe(nativeHome)
    }
    await expect(readFile(join(nativeHome, 'settings.yaml'), 'utf8')).rejects.toThrow()
    const records = await loadRegistry(registryPath)
    expect(records[0]?.mode).toBe('native')
    expect(records[0]?.home).toBe(nativeHome)
  })

  it('reuses a native install whose stamp matches without spawning dsh', async () => {
    const dir = await validBundle('other: value\n')
    const nativeHome = await makeHome()
    const registryPath = join(await makeHome(), 'installations.json')
    const env = { DSH_HOME: nativeHome }
    await installBundle({ bundleDir: dir, registryPath, mode: 'native', env, runDsh: async () => {} })
    let spawns = 0
    const reused = await installBundle({
      bundleDir: dir, registryPath, mode: 'native', env,
      runDsh: async () => { spawns += 1 },
    })
    expect(reused.reused).toBe(true)
    expect(spawns).toBe(0)
    expect((await loadRegistry(registryPath))).toHaveLength(1)
  })

  it('refuses a native install over a foreign profile (no reuse stamp)', async () => {
    const dir = await validBundle()
    const nativeHome = await makeHome()
    await mkdir(join(nativeHome, 'profiles', 'bundle-probe-demo'), { recursive: true })
    await expect(installBundle({
      bundleDir: dir, registryPath: join(await makeHome(), 'installations.json'),
      mode: 'native', env: { DSH_HOME: nativeHome }, runDsh: async () => {},
    })).rejects.toThrow('no agent-bundle reuse stamp')
  })

  it('refuses a native install over a profile stamped for another digest or adapter', async () => {
    const dir = await validBundle()
    const nativeHome = await makeHome()
    const profileDir = join(nativeHome, 'profiles', 'bundle-probe-demo')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, '.bundle-install.json'), JSON.stringify({ digest: 'sha256:' + 'b'.repeat(64), bundleDir: dir, adapterVersion: '0.4.0' }))
    await expect(installBundle({
      bundleDir: dir, registryPath: join(await makeHome(), 'installations.json'),
      mode: 'native', env: { DSH_HOME: nativeHome }, runDsh: async () => {},
    })).rejects.toThrow('does not match this bundle; pass --force to replace the existing installation. To install into the native home instead remove')
  })

  it('rejects the native mode for kinds without a native home convention', () => {
    expect(() => installHome({ kind: 'dify-agent-bundle', name: 'x', digest: 'sha256:abcd1234', mode: 'native', registryPath: '/tmp/r.json' })).toThrow('no native home convention')
  })

  it('tolerates a failing profile initialization but propagates plugin install failures', async () => {
    const dir = await validBundle()
    const registryPath = join(await makeHome(), 'installations.json')
    const result = await installBundle({
      bundleDir: dir,
      home: await makeHome(),
      registryPath,
      runDsh: async args => {
        if (args[0] === '--profile') throw new Error('empty task exit')
      },
    })
    expect(result.reused).toBe(false)
    await expect(installBundle({
      bundleDir: dir,
      home: await makeHome(),
      registryPath,
      runDsh: async args => {
        if (args[0] === 'plugin') throw new Error('pnpm down')
      },
    })).rejects.toThrow('pnpm down')
  })

  it('validates an explicit profile name', async () => {
    const dir = await validBundle()
    await expect(installBundle({ bundleDir: dir, profileName: 'Bad_Profile', runDsh: async () => {} })).rejects.toThrow('profile name must match')
  })

  it('merges the model into an existing settings.yaml mapping', async () => {
    const dir = await validBundle()
    const target = await makeHome()
    await writeFile(join(target, 'settings.yaml'), 'existing: keep\n')
    await installBundle({ bundleDir: dir, home: target, registryPath: join(await makeHome(), 'installations.json'), runDsh: async () => {} })
    const settings = await readFile(join(target, 'settings.yaml'), 'utf8')
    expect(settings).toContain('existing: keep')
    expect(settings).toContain('test-provider')
  })

  it('resolves ${ENV} model placeholders from the install environment and skips unwritten bindings', async () => {
    const placeholderBundle = await validBundle('model:\n  provider: ${AGENT_MODEL_PROVIDER}\n  model: ${AGENT_MODEL_NAME}\n')
    const missing = await makeHome()
    await installBundle({
      bundleDir: placeholderBundle, home: missing, registryPath: join(await makeHome(), 'installations.json'),
      runDsh: async () => {}, env: {},
    })
    await expect(readFile(join(missing, 'settings.yaml'), 'utf8')).rejects.toThrow()

    const resolvedHome = await makeHome()
    await installBundle({
      bundleDir: placeholderBundle, home: resolvedHome, registryPath: join(await makeHome(), 'installations.json'),
      runDsh: async () => {}, env: { AGENT_MODEL_PROVIDER: 'mock-gw', AGENT_MODEL_NAME: 'mock-1' },
    })
    const settings = await readFile(join(resolvedHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('mock-gw')
    expect(settings).toContain('mock-1')
    expect(settings).not.toContain('${')
  })

  it('rejects an existing settings.yaml that is not a YAML mapping', async () => {
    const dir = await validBundle()
    const target = await makeHome()
    await writeFile(join(target, 'settings.yaml'), '- just\n- a list\n')
    await expect(installBundle({ bundleDir: dir, home: target, runDsh: async () => {} })).rejects.toThrow('must contain a YAML mapping')
    const invalid = await makeHome()
    await writeFile(join(invalid, 'settings.yaml'), 'settings: [unclosed\n')
    await expect(installBundle({ bundleDir: dir, home: invalid, runDsh: async () => {} })).rejects.toThrow('not valid YAML')
  })

  it('reports an unreadable settings.yaml distinctly', async () => {
    const dir = await validBundle()
    const target = await makeHome()
    await mkdir(join(target, 'settings.yaml'))
    await expect(installBundle({ bundleDir: dir, home: target, runDsh: async () => {} })).rejects.toThrow('missing or unreadable')
  })

  it.skipIf(process.platform !== 'linux')('warns about registry-sourced @deepseek-ai packages in plugin node_modules', async () => {
    const dir = await validBundle()
    await mkdir(join(dir, 'plugins/probe/node_modules/.pnpm'), { recursive: true })
    await writeFile(join(dir, 'plugins/probe/node_modules/.pnpm/@deepseek-ai+dsh-skill-filesystem@0.0.1-rc.3'), 'x')
    const lines: string[] = []
    await installBundle({
      bundleDir: dir,
      home: await makeHome(),
      registryPath: join(await makeHome(), 'installations.json'),
      runDsh: async () => {},
      log: line => { lines.push(line) },
    })
    expect(lines.some(line => line.includes('registry-sourced @deepseek-ai packages'))).toBe(true)
  })
})

describe('installation registry', () => {
  const record = (overrides: Partial<InstallationRecord> = {}): InstallationRecord => ({
    id: 'probe-demo-abcd1234',
    name: 'probe-demo',
    kind: 'dsh-agent-bundle',
    digest: 'sha256:abcd123400000000000000000000000000000000000000000000000000000000',
    home: '/tmp/dsh-bundle-probe-demo-abcd1234',
    profile: 'bundle-probe-demo',
    bundleDir: '/bundles/probe',
    installedAt: '2026-09-18T00:00:00.000Z',
    mode: 'ephemeral',
    ...overrides,
  })

  it('round-trips through an atomic save and treats a missing file as empty', async () => {
    const registryPath = join(await makeHome(), 'nested', 'installations.json')
    expect(await loadRegistry(registryPath)).toEqual([])
    await saveRegistry(registryPath, [record()])
    expect(await loadRegistry(registryPath)).toHaveLength(1)
  })

  it('reports a corrupt or non-array registry distinctly', async () => {
    const registryPath = join(await makeHome(), 'installations.json')
    await writeFile(registryPath, '{not json')
    await expect(loadRegistry(registryPath)).rejects.toThrow('is corrupt')
    await writeFile(registryPath, '{"not": "an array"}')
    await expect(loadRegistry(registryPath)).rejects.toThrow('JSON array')
  })

  it('upserts by id and digest: same identity updates, new digest appends', async () => {
    const registryPath = join(await makeHome(), 'installations.json')
    await upsertRecord(registryPath, record({ installedAt: '2026-09-18T00:00:00.000Z' }))
    await upsertRecord(registryPath, record({ installedAt: '2026-09-18T01:00:00.000Z' }))
    const afterUpdate = await loadRegistry(registryPath)
    expect(afterUpdate).toHaveLength(1)
    expect(afterUpdate[0]?.installedAt).toBe('2026-09-18T01:00:00.000Z')
    await upsertRecord(registryPath, record({ digest: 'sha256:eeee111100000000000000000000000000000000000000000000000000000000', id: 'probe-demo-eeee1111' }))
    expect(await loadRegistry(registryPath)).toHaveLength(2)
  })

  it.skipIf(process.platform !== 'linux')('finds processes whose cwd or fds live under the home', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'profiles/p'), { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: join(home, 'profiles/p'), stdio: 'ignore' })
    try {
      let occupants: string[] = []
      for (let i = 0; i < 50 && occupants.length === 0; i += 1) {
        occupants = await findHomeOccupants(home)
        if (occupants.length === 0) await new Promise(resolvePoll => setTimeout(resolvePoll, 100))
      }
      expect(occupants).toContain(String(child.pid))
      expect(await findHomeOccupants(join(home, 'elsewhere'))).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('uninstallInstallation', () => {
  async function prepareRegistry(entries: InstallationRecord[]): Promise<string> {
    const registryPath = join(await makeHome(), 'installations.json')
    await saveRegistry(registryPath, entries)
    return registryPath
  }

  const baseRecord: InstallationRecord = {
    id: 'probe-demo-abcd1234',
    name: 'probe-demo',
    kind: 'dsh-agent-bundle',
    digest: 'sha256:abcd123400000000000000000000000000000000000000000000000000000000',
    home: '',
    profile: 'bundle-probe-demo',
    bundleDir: '/bundles/probe',
    installedAt: '2026-09-18T00:00:00.000Z',
    mode: 'ephemeral',
  }

  it('removes the record and the ephemeral home', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'profiles/p'), { recursive: true })
    await writeFile(join(home, 'marker'), 'x')
    const registryPath = await prepareRegistry([{ ...baseRecord, home }])
    const result = await dispatchUninstall({ id: baseRecord.id, registryPath })
    expect(result).toEqual({ removed: true, homeExisted: true, occupied: false, bundleDir: '/bundles/probe' })
    expect(await loadRegistry(registryPath)).toEqual([])
    await expect(readFile(join(home, 'marker'), 'utf8')).rejects.toThrow()
  })

  it('succeeds when the home is already gone', async () => {
    const home = join(await makeHome(), 'vanished')
    const registryPath = await prepareRegistry([{ ...baseRecord, home }])
    const result = await dispatchUninstall({ id: baseRecord.id, registryPath })
    expect(result.homeExisted).toBe(false)
    expect(await loadRegistry(registryPath)).toEqual([])
  })

  it('removes only the profile subtree of a native home and keeps the rest', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'profiles', 'bundle-probe-demo'), { recursive: true })
    await mkdir(join(home, 'profiles', 'other-profile'), { recursive: true })
    await writeFile(join(home, 'profiles', 'bundle-probe-demo', 'x'), 'x')
    await writeFile(join(home, 'profiles', 'other-profile', 'y'), 'y')
    await writeFile(join(home, '.env'), 'KEY=1')
    await writeFile(join(home, 'settings.yaml'), 'keep: true\n')
    const registryPath = await prepareRegistry([{ ...baseRecord, home, mode: 'native' }])
    const result = await dispatchUninstall({ id: baseRecord.id, registryPath })
    expect(result).toEqual({
      removed: true,
      homeExisted: false,
      occupied: false,
      bundleDir: '/bundles/probe',
      profileRemoved: 'bundle-probe-demo',
      homeKept: home,
    })
    expect(await loadRegistry(registryPath)).toEqual([])
    expect(await readFile(join(home, '.env'), 'utf8')).toBe('KEY=1')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe('keep: true\n')
    expect(await readFile(join(home, 'profiles', 'other-profile', 'y'), 'utf8')).toBe('y')
    await expect(readFile(join(home, 'profiles', 'bundle-probe-demo', 'x'), 'utf8')).rejects.toThrow()
  })

  it('refuses to uninstall an active native installation without --force', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'profiles', 'bundle-probe-demo'), { recursive: true })
    const registryPath = await prepareRegistry([{ ...baseRecord, home, mode: 'native', status: 'active' }])
    await expect(dispatchUninstall({ id: baseRecord.id, registryPath })).rejects.toThrow('--force')
    const forced = await dispatchUninstall({ id: baseRecord.id, registryPath, force: true })
    expect(forced).toMatchObject({ removed: true, profileRemoved: 'bundle-probe-demo' })
    expect(await loadRegistry(registryPath)).toEqual([])
  })

  it('refuses an in-use home without --force and proceeds with it', async () => {
    if (process.platform !== 'linux') return
    const home = await makeHome()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: home, stdio: 'ignore' })
    try {
      const registryPath = await prepareRegistry([{ ...baseRecord, home }])
      for (let i = 0; i < 50; i += 1) {
        if ((await findHomeOccupants(home)).length > 0) break
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
      await expect(dispatchUninstall({ id: baseRecord.id, registryPath })).rejects.toThrow('--force')
      const forced = await dispatchUninstall({ id: baseRecord.id, registryPath, force: true })
      expect(forced.occupied).toBe(true)
      expect(forced.homeExisted).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('reports unknown ids and ambiguous records with disambiguation guidance', async () => {
    const registryPath = join(await makeHome(), 'installations.json')
    await expect(dispatchUninstall({ id: 'absent', registryPath })).rejects.toThrow('no installation record')
    const homeA = await makeHome()
    const homeB = await makeHome()
    await saveRegistry(registryPath, [
      { ...baseRecord, home: homeA },
      { ...baseRecord, home: homeB, digest: 'sha256:eeee111100000000000000000000000000000000000000000000000000000000' },
    ])
    await expect(dispatchUninstall({ id: baseRecord.id, registryPath })).rejects.toThrow('ambiguous')
    const byDigest = await dispatchUninstall({
      id: baseRecord.id,
      registryPath,
      digest: 'sha256:eeee111100000000000000000000000000000000000000000000000000000000',
    })
    expect(byDigest.bundleDir).toBe('/bundles/probe')
    expect(await loadRegistry(registryPath)).toHaveLength(1)
  })
})
