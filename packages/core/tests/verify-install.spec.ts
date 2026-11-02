import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyInstallable, type RunDsh } from '../src/index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeBundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bundle-verify-install-'))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
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

async function validBundle(): Promise<string> {
  return await makeBundle({
    'bundle.yaml': VALID_BUNDLE_YAML,
    'agent.yaml': 'model:\n  provider: test-provider\n  model: test-model\n',
    'dependencies.lock': '# placeholder\n',
    'plugins/probe/package.json': JSON.stringify({
      name: '@dsh-bundle-test/probe',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    'plugins/probe/lib/index.js': 'export const probe = true\n',
    'plugins/probe/cordis.patch.yml': '- insert: []\n',
  })
}

describe('verifyInstallable', () => {
  it('installs a legal dsh bundle into an isolated home and removes it', async () => {
    const dir = await validBundle()
    const sentinelDir = await mkdtemp(join(tmpdir(), 'agent-bundle-verify-registry-'))
    tempDirs.push(sentinelDir)
    const sentinel = join(sentinelDir, 'installations.json')
    const homes: string[] = []
    const spawned: Array<readonly string[]> = []
    const runDsh: RunDsh = async (args, env) => {
      spawned.push(args)
      const home = env['DSH_HOME']
      if (home !== undefined) homes.push(home)
    }

    const result = await verifyInstallable(dir, {
      runDsh,
      env: { AGENT_BUNDLE_REGISTRY: sentinel },
    })

    expect(result.manifest.name).toBe('probe-demo')
    expect(result.manifest.kind).toBe('dsh-agent-bundle')
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(spawned).toEqual([
      ['--profile', 'bundle-probe-demo', '--from-default-profile', 'headless'],
      ['plugin', '--profile', 'bundle-probe-demo', 'add', join(homes[0]!, 'profiles', 'bundle-probe-demo', '.bundle-plugins', 'probe')],
    ])
    const home = homes[0]
    expect(home).toBeDefined()
    await expect(stat(home!)).rejects.toThrow()
    await expect(stat(sentinel)).rejects.toThrow()
  })

  it('rejects an illegal dsh bundle before installing', async () => {
    const dir = await validBundle()
    await rm(join(dir, 'dependencies.lock'))
    let calls = 0
    const runDsh: RunDsh = async () => { calls += 1 }

    await expect(verifyInstallable(dir, { runDsh })).rejects.toThrow('required dependencies.lock is missing')
    expect(calls).toBe(0)
  })
})
