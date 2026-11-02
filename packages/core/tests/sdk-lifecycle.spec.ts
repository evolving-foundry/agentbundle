import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ADAPTER_VERSION,
  BundleError,
  dispatchActivate,
  createBundleSdk,
  installBundle,
  installationId,
  loadRegistry,
  saveRegistry,
  uninstallInstallation,
  withDirLock,
  type InstallationRecord,
} from '../src/index.ts'

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

/** Two same-name bundles with different content → same record name, different digests/ids. */
async function probeBundle(variant: 'a' | 'b'): Promise<string> {
  const dir = await makeDir(`lifecycle-${variant}-`)
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
    'agent.yaml': `model:\n  provider: test-provider\n  model: test-model-${variant}\n`,
    'dependencies.lock': `# ${variant}\n`,
    'plugins/probe/package.json': PROBE_PACKAGE_JSON,
    'plugins/probe/lib/index.js': `export const probe = '${variant}'\n`,
    'plugins/probe/cordis.patch.yml': '- insert: []\n',
  })
  return dir
}

describe('withDirLock', () => {
  it('serializes concurrent mutations of the same directory', async () => {
    const dir = join(await makeDir('lock-'), 'home')
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>(resolveGate => { releaseGate = resolveGate })
    let mutations = 0
    const first = withDirLock(dir, async () => {
      await gate
      mutations += 1
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    await expect(withDirLock(dir, async () => { mutations += 10 }, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' })
    releaseGate!()
    await first
    expect(mutations).toBe(1)
  })

  it('releases the lock when the callback fails', async () => {
    const dir = join(await makeDir('lock-'), 'home')
    await expect(withDirLock(dir, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withDirLock(dir, async () => 'second', { timeoutMs: 500 })).resolves.toBe('second')
  })
})

describe('registry v2 records', () => {
  it('reads v1 records (missing adapterVersion/status) and keeps them on write', async () => {
    const registryPath = join(await makeDir('v1reg-'), 'installations.json')
    const v1Record = {
      id: 'x-12345678', name: 'x', kind: 'dsh-agent-bundle', digest: `sha256:${'a'.repeat(64)}`,
      home: '/tmp/x', profile: 'p', bundleDir: '/tmp/b', installedAt: '2026-01-01T00:00:00.000Z', mode: 'ephemeral',
    }
    await writeFile(registryPath, JSON.stringify([v1Record]))
    const records = await loadRegistry(registryPath)
    expect(records).toHaveLength(1)
    await saveRegistry(registryPath, [...records, { ...v1Record, id: 'x-87654321', adapterVersion: ADAPTER_VERSION, status: 'active' } as InstallationRecord])
    const reread = JSON.parse(await readFile(registryPath, 'utf8')) as Array<Record<string, unknown>>
    expect(reread).toHaveLength(2)
    expect(reread[0]).not.toHaveProperty('adapterVersion')
    expect(reread[1]).toMatchObject({ adapterVersion: ADAPTER_VERSION, status: 'active' })
  })
})

describe('persistent installs', () => {
  it('materializes under <registryDir>/homes and records mode + adapterVersion', async () => {
    const scratch = await makeDir('persist-')
    const registryPath = join(scratch, 'installations.json')
    const dir = await probeBundle('a')
    const result = await installBundle({ bundleDir: dir, registryPath, runDsh: async () => {}, mode: 'persistent' })
    expect(result.home).toBe(join(scratch, 'homes', `dsh-bundle-probe-demo-${result.digest.slice(7, 15)}`))
    const records = await loadRegistry(registryPath)
    expect(records[0]).toMatchObject({ mode: 'persistent', adapterVersion: ADAPTER_VERSION, status: 'installed' })
    const stamp = JSON.parse(await readFile(join(result.home, 'profiles', 'bundle-probe-demo', '.bundle-install.json'), 'utf8')) as Record<string, unknown>
    expect(stamp).toMatchObject({ digest: result.digest, adapterVersion: ADAPTER_VERSION })
  })

  it('refuses to uninstall the active persistent installation unless forced', async () => {
    const scratch = await makeDir('persist-guard-')
    const registryPath = join(scratch, 'installations.json')
    const dir = await probeBundle('a')
    const result = await installBundle({ bundleDir: dir, registryPath, runDsh: async () => {}, mode: 'persistent' })
    const id = installationId('probe-demo', result.digest)
    await dispatchActivate({ id, registryPath })
    const refused = await uninstallInstallation({ id, registryPath }).catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(BundleError)
    expect((refused as BundleError).code).toBe('INSTALL_CONFLICT')
    await expect(uninstallInstallation({ id, registryPath, force: true })).resolves.toMatchObject({ removed: true })
    expect(await loadRegistry(registryPath)).toEqual([])
  })

  it('still uninstalls an active ephemeral installation (guard is persistent-only)', async () => {
    const scratch = await makeDir('ephemeral-guard-')
    const registryPath = join(scratch, 'installations.json')
    const dir = await probeBundle('a')
    const result = await installBundle({ bundleDir: dir, home: join(scratch, 'home'), registryPath, runDsh: async () => {} })
    await dispatchActivate({ id: installationId('probe-demo', result.digest), registryPath })
    await expect(uninstallInstallation({ id: installationId('probe-demo', result.digest), registryPath })).resolves.toMatchObject({ removed: true })
  })
})

describe('activate', () => {
  it('activates and atomically demotes the previous active of the same name', async () => {
    const scratch = await makeDir('activate-')
    const registryPath = join(scratch, 'installations.json')
    const a = await installBundle({ bundleDir: await probeBundle('a'), home: join(scratch, 'home-a'), registryPath, runDsh: async () => {} })
    const b = await installBundle({ bundleDir: await probeBundle('b'), home: join(scratch, 'home-b'), registryPath, runDsh: async () => {} })
    const idA = installationId('probe-demo', a.digest)
    const idB = installationId('probe-demo', b.digest)

    const first = await dispatchActivate({ id: idA, registryPath })
    expect(first.previous).toBeUndefined()
    const second = await dispatchActivate({ id: idB, registryPath })
    expect(second.previous).toEqual({ id: idA, digest: a.digest })
    // ISO timestamps have millisecond precision; both activations can land in
    // the same millisecond, so ordering asserts monotonicity, not strict growth.
    expect(second.activatedAt >= first.activatedAt).toBe(true)

    const records = await loadRegistry(registryPath)
    expect(records.find(record => record.digest === a.digest)?.status).toBe('installed')
    expect(records.find(record => record.digest === b.digest)?.status).toBe('active')
  })

  it('leaves the previous active untouched when validation fails', async () => {
    const scratch = await makeDir('activate-fail-')
    const registryPath = join(scratch, 'installations.json')
    const a = await installBundle({ bundleDir: await probeBundle('a'), home: join(scratch, 'home-a'), registryPath, runDsh: async () => {} })
    const b = await installBundle({ bundleDir: await probeBundle('b'), home: join(scratch, 'home-b'), registryPath, runDsh: async () => {} })
    await dispatchActivate({ id: installationId('probe-demo', a.digest), registryPath })

    await rm(join(scratch, 'home-b'), { recursive: true, force: true })
    const homeGone = await dispatchActivate({ id: installationId('probe-demo', b.digest), registryPath }).catch((caught: unknown) => caught)
    expect(homeGone).toBeInstanceOf(BundleError)
    expect((homeGone as BundleError).code).toBe('INSTALL_CONFLICT')

    // Recreate an empty home: the base check passes but the dsh stamp check must reject.
    await mkdir(join(scratch, 'home-b'), { recursive: true })
    const noStamp = await dispatchActivate({ id: installationId('probe-demo', b.digest), registryPath }).catch((caught: unknown) => caught)
    expect(noStamp).toBeInstanceOf(BundleError)
    expect((noStamp as BundleError).code).toBe('INSTALL_CONFLICT')
    expect((noStamp as BundleError).message).toContain('reuse stamp')

    const records = await loadRegistry(registryPath)
    expect(records.find(record => record.digest === a.digest)?.status).toBe('active')
    expect(records.find(record => record.digest === b.digest)?.status).toBe('installed')
  })

  it('rejects unknown installation ids', async () => {
    const registryPath = join(await makeDir('activate-miss-'), 'installations.json')
    const error = await dispatchActivate({ id: 'nope-00000000', registryPath }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('RECORD_MISSING')
  })
})

describe('reuse key digest + adapterVersion', () => {
  it('rebuilds when the stamp predates the current adapter version, then reuses', async () => {
    const scratch = await makeDir('reuse-key-')
    const registryPath = join(scratch, 'installations.json')
    const home = join(scratch, 'home')
    const dir = await probeBundle('a')
    const stampPath = join(home, 'profiles', 'bundle-probe-demo', '.bundle-install.json')

    const first = await installBundle({ bundleDir: dir, home, registryPath, runDsh: async () => {} })
    expect(first.reused).toBe(false)

    await writeFile(stampPath, `${JSON.stringify({ digest: first.digest, bundleDir: dir }, null, 2)}\n`, 'utf8')
    const refused = await installBundle({ bundleDir: dir, home, registryPath, runDsh: async () => {} }).catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(BundleError)
    expect((refused as BundleError).message).toContain('--force')
    const rebuilt = await installBundle({ bundleDir: dir, home, registryPath, force: true, runDsh: async () => {} })
    expect(rebuilt.reused).toBe(false)
    const stamp = JSON.parse(await readFile(stampPath, 'utf8')) as Record<string, unknown>
    expect(stamp.adapterVersion).toBe(ADAPTER_VERSION)

    const reuse = await installBundle({ bundleDir: dir, home, registryPath, runDsh: async () => {} })
    expect(reuse.reused).toBe(true)

    let spawns = 0
    const sdk = createBundleSdk({ registryPath, runDsh: async () => { spawns += 1 } })
    const forced = await sdk.install(dir, { home, force: true })
    expect(forced.reused).toBe(false)
    expect(spawns).toBeGreaterThan(0)
  })
})
