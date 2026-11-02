import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BundleError, createBundleSdk, inspectBundle, packBundle, verifyBundle } from '../src/index.ts'

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

async function dshBundle(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeDir('sdk-inspect-dsh-')
  await writeFiles(dir, {
    'bundle.yaml': VALID_BUNDLE_YAML,
    'agent.yaml': 'model:\n  provider: test-provider\n  model: test-model\n',
    'dependencies.lock': '# placeholder\n',
    'plugins/probe/package.json': PROBE_PACKAGE_JSON,
    'plugins/probe/lib/index.js': 'export const probe = true\n',
    'plugins/probe/cordis.patch.yml': '- insert: []\n',
    ...files,
  })
  return dir
}

const PI_PACKAGE_JSON = JSON.stringify({
  name: '@example/pi',
  version: '0.1.0',
  type: 'module',
  pi: { extensions: ['./dist/extension.js'] },
})

async function piBundle(): Promise<string> {
  const dir = await makeDir('sdk-inspect-pi-')
  await writeFiles(dir, {
    'bundle.yaml': [
      'kind: pi-agent-bundle',
      'schemaVersion: 1',
      'name: pi',
      'harness:',
      '  name: pi',
      '  version: ">=0.1 <0.2"',
      'instructions: ./agent/instructions.md',
      'skills: ./skills',
      'extensions:',
      '  - ./extensions/pi',
      'settings: ./settings.json',
      'lockfile: ./dependencies.lock',
    ].join('\n'),
    'dependencies.lock': '{}\n',
    'settings.json': '{}\n',
    'agent/instructions.md': 'You are Pi.\n',
    'skills/diagnose/SKILL.md': '---\nname: diagnose\ndescription: Diagnose before changing.\n---\n\nRun the checks.\n',
    'extensions/pi/package.json': PI_PACKAGE_JSON,
    'extensions/pi/dist/extension.js': 'export default function () {}\n',
  })
  return dir
}

describe('inspectBundle', () => {
  it('describes a dsh bundle: identity, plugins, model, lockfile', async () => {
    const dir = await dshBundle()
    const info = await inspectBundle(dir)
    const verified = await verifyBundle(dir)
    expect(info.ref).toEqual({ kind: 'dsh-agent-bundle', uri: dir, digest: verified.digest })
    expect(info.name).toBe('probe-demo')
    expect(info.schemaVersion).toBe(1)
    expect(info.harnessVersion).toBe('>=0.1.6-alpha.1 <0.2')
    expect(info.declaredPlugins).toEqual(['./plugins/probe'])
    expect(info.model).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(info.lockfile).toBe(true)
    expect(info['entry']).toBeUndefined()
    expect(info['instructions']).toBeUndefined()
  })

  it('describes a pi bundle with native resource pointers and no plugins', async () => {
    const dir = await piBundle()
    const info = await inspectBundle(dir)
    expect(info.ref.kind).toBe('pi-agent-bundle')
    expect(info.instructions).toBe(join(dir, 'agent', 'instructions.md'))
    expect(info.skills).toBe(join(dir, 'skills'))
    expect(info.extensions).toEqual(['./extensions/pi'])
    expect(info.declaredPlugins).toEqual([])
    expect(info.lockfile).toBe(true)
    expect(info.model).toBeUndefined()
  })

  it('reports the root dependencies.lock presence honestly for pi (where it is optional)', async () => {
    const dir = await piBundle()
    const withoutLockfile = (await readFile(join(dir, 'bundle.yaml'), 'utf8')).split('\n').filter(line => !line.startsWith('lockfile:')).join('\n')
    await writeFile(join(dir, 'bundle.yaml'), withoutLockfile)
    await rm(join(dir, 'dependencies.lock'))
    const info = await inspectBundle(dir)
    expect(info.lockfile).toBe(false)
  })

  it('fails at the standard level when dependencies.lock is absent', async () => {
    const dir = await dshBundle()
    await rm(join(dir, 'dependencies.lock'))
    const error = await inspectBundle(dir).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('POINTER_MISSING')
  })
})

describe('verifyBundle levels', () => {
  it('minimal passes without agent.yaml and dependencies.lock, and reports no agent config', async () => {
    const dir = await dshBundle()
    await rm(join(dir, 'dependencies.lock'))
    await rm(join(dir, 'agent.yaml'))
    const minimal = await verifyBundle(dir, { level: 'minimal' })
    expect(minimal.agent).toBeUndefined()
    const standard = await verifyBundle(dir).catch((caught: unknown) => caught)
    expect(standard).toBeInstanceOf(BundleError)
  })

  it('anchors tampered content with DIGEST_MISMATCH', async () => {
    const dir = await dshBundle()
    const digest = (await verifyBundle(dir)).digest
    await writeFile(join(dir, 'plugins/probe/lib/index.js'), 'export const probe = false\n')
    const error = await verifyBundle(dir, { expectDigest: digest }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('DIGEST_MISMATCH')
  })

  it('classifies path escapes as PATH_ESCAPE', async () => {
    const dir = await dshBundle({ 'bundle.yaml': VALID_BUNDLE_YAML.replace('./plugins/probe', '../evil') })
    const error = await verifyBundle(dir).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('PATH_ESCAPE')
  })
})

describe('createBundleSdk', () => {
  it('exposes the stateless operations with the same semantics as direct calls', async () => {
    const sdk = createBundleSdk()
    const dir = await dshBundle()
    const output = await makeDir('sdk-facade-out-')
    const info = await sdk.inspect(dir)
    expect(info.name).toBe('probe-demo')
    const verified = await sdk.verify(dir, { level: 'minimal' })
    expect(verified.agent).toBeUndefined()
    const packed = await sdk.pack({ sourceDir: dir, outputDir: output })
    expect(packed.reused).toBe(false)
    await expect(packBundle({ sourceDir: dir, outputDir: output })).resolves.toMatchObject({ reused: true })
  })

  it('routes uninstall through the registry and reports missing records', async () => {
    const sdk = createBundleSdk({ registryPath: join(await makeDir('sdk-facade-reg-'), 'installations.json') })
    const error = await sdk.uninstall({ id: 'nope-00000000' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('RECORD_MISSING')
  })
})
