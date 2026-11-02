import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BundleError,
  dispatchLoad,
  getAdapter,
  installBundle,
  loadRegistry,
  verifyBundle,
} from '../src/index.ts'
import { resolveBindings } from '../src/bindings.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

const PROBE_PACKAGE_JSON = JSON.stringify({
  name: '@dsh-bundle-test/probe',
  version: '1.0.0',
  main: 'lib/index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
})

async function probeBundle(): Promise<string> {
  const dir = await makeDir('load-src-')
  await writeFiles(dir, {
    'bundle.yaml': [
      'kind: dsh-agent-bundle',
      'schemaVersion: 1',
      'name: probe-demo',
      'harness:',
      '  name: dsh',
      '  version: ">=0.1.6-alpha.1 <0.2"',
      'plugins:',
      '  - path: ./plugins/probe',
    ].join('\n'),
    'agent.yaml': 'model:\n  provider: test-provider\n  model: test-model\n',
    'dependencies.lock': '# placeholder\n',
    'plugins/probe/package.json': PROBE_PACKAGE_JSON,
    'plugins/probe/lib/index.js': 'export const probe = true\n',
    'plugins/probe/cordis.patch.yml': '- insert: []\n',
  })
  return dir
}

describe('resolveBindings', () => {
  it('passes literals through and resolves whole-string env placeholders', () => {
    const resolved = resolveBindings(
      { endpoint: 'http://mem0.internal', namespace: '${RUN_NAMESPACE}' },
      { env: { RUN_NAMESPACE: 'eval-42' } },
    )
    expect(resolved).toEqual({ endpoint: 'http://mem0.internal', namespace: 'eval-42' })
  })

  it('resolves credentialRef entries from the injected credential map', () => {
    const resolved = resolveBindings(
      { token: { credentialRef: 'mem0-token' } },
      { env: {}, credentials: { 'mem0-token': 'secret-value' } },
    )
    expect(resolved).toEqual({ token: 'secret-value' })
  })

  it('reports missing env variables and credentials as BINDING_MISSING', () => {
    const missingEnv = (() => {
      try {
        resolveBindings({ namespace: '${RUN_NAMESPACE}' }, { env: {} })
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(missingEnv).toBeInstanceOf(BundleError)
    expect((missingEnv as BundleError).code).toBe('BINDING_MISSING')

    const missingCredential = (() => {
      try {
        resolveBindings({ token: { credentialRef: 'nope' } }, { env: {}, credentials: {} })
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(missingCredential).toBeInstanceOf(BundleError)
    expect((missingCredential as BundleError).code).toBe('BINDING_MISSING')
  })
})

describe('describeLaunch per kind', () => {
  it('derives the launch description from the record for every kind', () => {
    const home = '/tmp/homes/x'
    const base = { name: 'probe', digest: 'sha256:' + 'a'.repeat(64), bundleDir: '/tmp/src' }
    expect(getAdapter('dsh-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'dsh-agent-bundle', home, profile: 'bundle-probe', installedAt: '', mode: 'ephemeral', status: 'installed' },
      bindings: {},
    })).toEqual({ launchCommand: 'dsh --profile bundle-probe "<task>"', launchEnv: { DSH_HOME: home } })

    expect(getAdapter('dsh-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'dsh-agent-bundle', home, profile: 'bundle-probe', installedAt: '', mode: 'native', status: 'installed' },
      bindings: {},
    })).toEqual({ launchCommand: 'dsh --profile bundle-probe "<task>"', launchEnv: {} })

    expect(getAdapter('pi-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'pi-agent-bundle', home, profile: 'probe', installedAt: '', mode: 'ephemeral', status: 'installed', piConfigDir: `${home}/agent` },
      bindings: {},
    })).toEqual({ launchCommand: 'pi "<task>"', launchEnv: { PI_CODING_AGENT_DIR: `${home}/agent` } })
    expect(getAdapter('pi-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'pi-agent-bundle', home, profile: 'bundle-probe', installedAt: '', mode: 'native', status: 'installed', piConfigDir: home },
      bindings: {},
    })).toEqual({ launchCommand: 'pi --print "<task>"', launchEnv: {} })

    expect(getAdapter('hermes-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'hermes-agent-bundle', home, profile: 'probe', installedAt: '', mode: 'ephemeral', status: 'installed' },
      bindings: {},
    })).toEqual({ launchCommand: `HERMES_HOME=${home} hermes "<task>"`, launchEnv: { HERMES_HOME: home } })

    expect(getAdapter('deepagents-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'deepagents-agent-bundle', home, profile: 'probe', installedAt: '', mode: 'ephemeral', status: 'installed' },
      bindings: {},
    })).toEqual({ launchCommand: `cd /tmp/src && ${join(home, 'bin', 'python')} -c "import agent"`, launchEnv: {} })

    expect(getAdapter('dify-agent-bundle')?.describeLaunch({
      record: { ...base, id: 'probe-aaaaaaaa', kind: 'dify-agent-bundle', home: 'dify-app:1', profile: 'probe', installedAt: '', mode: 'ephemeral', status: 'installed', appId: '1', apiKey: 'sk-x', baseUrl: 'http://dify' },
      bindings: {},
    })?.launchCommand).toContain('POST http://dify/v1/workflows/run')
  })
})

describe('loadInstallation', () => {
  it('returns a handle whose launch matches the install result, with bindings merged into launchEnv', async () => {
    const scratch = await makeDir('load-')
    const registryPath = join(scratch, 'installations.json')
    const installed = await installBundle({
      bundleDir: await probeBundle(),
      home: join(scratch, 'home'),
      registryPath,
      runDsh: async () => {},
    })
    const agent = await dispatchLoad({
      id: installed.id,
      registryPath,
      bindings: { RUN_NAMESPACE: 'eval-42' },
    })
    expect(agent.id).toBe(installed.id)
    expect(agent.kind).toBe('dsh-agent-bundle')
    expect(agent.launchCommand).toBe(installed.launchCommand)
    expect(agent.launchEnv).toEqual({ DSH_HOME: join(scratch, 'home'), RUN_NAMESPACE: 'eval-42' })
    expect(agent.mode).toBe('ephemeral')

    // load never activates.
    const records = await loadRegistry(registryPath)
    expect(records.find(record => record.id === installed.id)?.status).toBe('installed')
  })

  it('cleanup uninstalls ephemeral installations and is idempotent', async () => {
    const scratch = await makeDir('load-cleanup-')
    const registryPath = join(scratch, 'installations.json')
    const home = join(scratch, 'home')
    const installed = await installBundle({ bundleDir: await probeBundle(), home, registryPath, runDsh: async () => {} })
    const agent = await dispatchLoad({ id: installed.id, registryPath })
    await agent.cleanup()
    expect(await loadRegistry(registryPath)).toEqual([])
    const { stat } = await import('node:fs/promises')
    expect(await stat(home).then(() => true).catch(() => false)).toBe(false)
    await expect(agent.cleanup()).resolves.toBeUndefined()
  })

  it('cleanup keeps persistent installations', async () => {
    const scratch = await makeDir('load-persist-')
    const registryPath = join(scratch, 'installations.json')
    const installed = await installBundle({ bundleDir: await probeBundle(), registryPath, runDsh: async () => {}, mode: 'persistent' })
    const agent = await dispatchLoad({ id: installed.id, registryPath })
    await agent.cleanup()
    const records = await loadRegistry(registryPath)
    expect(records).toHaveLength(1)
    const { stat } = await import('node:fs/promises')
    expect(await stat(installed.home).then(() => true).catch(() => false)).toBe(true)
  })

  it('fails with precise causes and never returns a half-usable handle', async () => {
    const scratch = await makeDir('load-fail-')
    const registryPath = join(scratch, 'installations.json')
    const installed = await installBundle({ bundleDir: await probeBundle(), home: join(scratch, 'home'), registryPath, runDsh: async () => {} })

    const unknown = await dispatchLoad({ id: 'nope-00000000', registryPath }).catch((caught: unknown) => caught)
    expect(unknown).toBeInstanceOf(BundleError)
    expect((unknown as BundleError).code).toBe('RECORD_MISSING')

    // Bindings are resolved after the integrity checks: a missing binding fails the load.
    const missingBinding = await dispatchLoad({ id: installed.id, registryPath, bindings: { token: { credentialRef: 'nope' } } }).catch((caught: unknown) => caught)
    expect(missingBinding).toBeInstanceOf(BundleError)
    expect((missingBinding as BundleError).code).toBe('BINDING_MISSING')

    // Tampered stamp → runtimeCheck rejects the load.
    await writeFile(
      join(installed.home, 'profiles', 'bundle-probe-demo', '.bundle-install.json'),
      '{"digest": "sha256:' + '0'.repeat(64) + '", "bundleDir": "/x", "adapterVersion": "0.4.0"}\n',
    )
    const tampered = await dispatchLoad({ id: installed.id, registryPath }).catch((caught: unknown) => caught)
    expect(tampered).toBeInstanceOf(BundleError)
    expect((tampered as BundleError).code).toBe('INSTALL_CONFLICT')
  })
})
