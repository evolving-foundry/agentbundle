import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BundleError, listBundleDigestPaths, packBundle, verifyBundle } from '../src/index.ts'

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

async function validBundle(): Promise<string> {
  const dir = await makeDir('sdk-pack-src-')
  await writeFiles(dir, {
    'bundle.yaml': VALID_BUNDLE_YAML,
    'agent.yaml': 'model:\n  provider: test-provider\n  model: test-model\n',
    'dependencies.lock': '# placeholder\n',
    'plugins/probe/package.json': PROBE_PACKAGE_JSON,
    'plugins/probe/lib/index.js': 'export const probe = true\n',
    'plugins/probe/cordis.patch.yml': '- insert: []\n',
  })
  return dir
}

describe('packBundle', () => {
  it('packs a verified bundle into bundle-<name>-<digest8> and the artifact re-verifies', async () => {
    const source = await validBundle()
    const output = await makeDir('sdk-pack-out-')
    const result = await packBundle({ sourceDir: source, outputDir: output })
    const verified = await verifyBundle(source)
    expect(result.reused).toBe(false)
    expect(result.ref).toEqual({ kind: 'dsh-agent-bundle', uri: result.artifactDir, digest: verified.digest })
    expect(result.artifactDir).toBe(join(output, `bundle-probe-demo-${verified.digest.slice('sha256:'.length, 'sha256:'.length + 8)}`))
    expect(result.fileCount).toBe((await listBundleDigestPaths(source)).length)
    await expect(verifyBundle(result.artifactDir, { expectDigest: verified.digest })).resolves.toMatchObject({ digest: verified.digest })
    expect(await readdir(output)).toEqual([result.artifactDir.split('/').pop()])
  })

  it('reuses an identical artifact instead of packing again', async () => {
    const source = await validBundle()
    const output = await makeDir('sdk-pack-out-')
    const first = await packBundle({ sourceDir: source, outputDir: output })
    const second = await packBundle({ sourceDir: source, outputDir: output })
    expect(second.reused).toBe(true)
    expect(second.artifactDir).toBe(first.artifactDir)
    expect(second.ref.digest).toBe(first.ref.digest)
  })

  it('ignores digest-excluded runtime directories', async () => {
    const source = await validBundle()
    const output = await makeDir('sdk-pack-out-')
    const first = await packBundle({ sourceDir: source, outputDir: output })
    await writeFiles(source, {
      'node_modules/left-pad/index.js': 'module.exports = () => {}\n',
      '__pycache__/probe.cpython-312.pyc': 'fake bytecode\n',
    })
    const second = await packBundle({ sourceDir: source, outputDir: output })
    expect(second.reused).toBe(true)
    expect(second.artifactDir).toBe(first.artifactDir)
  })

  it('refuses to overwrite an existing artifact with different content', async () => {
    const source = await validBundle()
    const output = await makeDir('sdk-pack-out-')
    const verified = await verifyBundle(source)
    const artifactDir = join(output, `bundle-probe-demo-${verified.digest.slice('sha256:'.length, 'sha256:'.length + 8)}`)
    await writeFiles(artifactDir, { 'bundle.yaml': 'kind: other\n' })
    const error = await packBundle({ sourceDir: source, outputDir: output }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('INSTALL_CONFLICT')
    expect((error as BundleError).message).toContain('never overwritten')
    expect(await readdir(output)).toEqual([artifactDir.split('/').pop()])
  })

  it('rejects symbolic links in the source via the verify step', async () => {
    const source = await validBundle()
    await symlink('/etc/hostname', join(source, 'plugins/probe/lib/extra.js'))
    const error = await packBundle({ sourceDir: source, outputDir: await makeDir('sdk-pack-out-') }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('SYMLINK_REJECTED')
  })

  it('propagates manifest failures with structured codes', async () => {
    const source = await validBundle()
    await writeFile(join(source, 'bundle.yaml'), VALID_BUNDLE_YAML.replace('dsh-agent-bundle', 'not-a-kind'))
    const error = await packBundle({ sourceDir: source, outputDir: await makeDir('sdk-pack-out-') }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BundleError)
    expect((error as BundleError).code).toBe('BUNDLE_KIND_UNKNOWN')
  })
})
