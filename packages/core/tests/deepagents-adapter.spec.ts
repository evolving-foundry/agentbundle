import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BundleError,
  DEEPAGENTS_BUNDLE_KIND,
  DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORIES,
  DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORY_SUFFIXES,
  computeBundleDigest,
  digestOptions,
  dispatchUninstall,
  installDeepagentsBundle,
  loadRegistry,
  resolvePythonRuntime,
  saveRegistry,
  verifyBundle,
  type InstallationRecord,
  type RunPython,
} from '../src/index.ts'

const tempDirs: string[] = []
/** Deterministic env: no python/uv on PATH unless a test provides them. */
const bareEnv = { PATH: '/agent-bundle-spec-nothing' }

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function makeBundle(files: Record<string, string>): Promise<string> {
  const dir = await makeDir('agent-bundle-dg-')
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
  return dir
}

async function makeExecutable(path: string, content = ''): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, { mode: 0o755 })
  return path
}

const BUNDLE_YAML = [
  'kind: deepagents-agent-bundle',
  'schemaVersion: 1',
  'name: probe-dg',
  'harness:',
  '  name: deepagents',
  '  version: ">=0.7,<0.8"',
  'entry: ./langgraph.json',
  'plugins:',
  '  - path: ./plugins/office_base',
  '  - path: ./plugins/sop',
].join('\n')

async function validBundle(): Promise<string> {
  return await makeBundle({
    'bundle.yaml': BUNDLE_YAML,
    'agent.yaml': 'model:\n  provider: ${AGENT_MODEL_PROVIDER}\n  model: ${AGENT_MODEL_NAME}\nplugins: {}\n',
    'langgraph.json': JSON.stringify({ graphs: { agent: './agent.py:agent' }, dependencies: ['.'] }),
    'agent.py': 'agent = None\n',
    'dependencies.lock': '# placeholder\n',
    'plugins/office_base/__init__.py': '',
    'plugins/sop/README.md': 'sop product\n',
  })
}

function fakeRunPython(calls: Array<{ command: string; args: readonly string[] }>): RunPython {
  return async (command, args) => {
    calls.push({ command, args })
  }
}

describe('parseDeepagentsBundleManifest (via verifyBundle)', () => {
  it('accepts a valid bundle and resolves the composition entry', async () => {
    const dir = await validBundle()
    const result = await verifyBundle(dir)
    const manifest = result.manifest as import('../src/index.ts').DeepagentsBundleManifest
    expect(manifest.kind).toBe(DEEPAGENTS_BUNDLE_KIND)
    expect(manifest.entry).toBe('./langgraph.json')
    expect(manifest.graphId).toBe('agent')
    expect(manifest.graphModule).toBe('./agent.py')
    expect(manifest.declaredPlugins).toEqual(['./plugins/office_base', './plugins/sop'])
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects manifest defects with precise causes', async () => {
    const base: Record<string, string> = {
      'langgraph.json': JSON.stringify({ graphs: { agent: './agent.py:agent' } }),
      'agent.py': 'agent = None\n',
      'dependencies.lock': '# placeholder\n',
      'plugins/office_base/__init__.py': '',
      'plugins/sop/README.md': 'sop\n',
    }
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('deepagents-agent-bundle', 'other') }, 'kind must be'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('name: deepagents', 'name: dsh') }, 'harness.name must be'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('version: ">=0.7,<0.8"', 'version: ""') }, 'harness.version must be a non-empty'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('schemaVersion: 1', 'schemaVersion: 2') }, 'schemaVersion must be 1'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('entry: ./langgraph.json\n', '') }, 'entry must be a relative path'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('entry: ./langgraph.json', 'entry: ../outside.json') }, 'entry must stay inside the bundle'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('plugins:\n  - path: ./plugins/office_base\n  - path: ./plugins/sop', 'plugins: []') }, 'non-empty list'],
      [{ ...base, 'bundle.yaml': BUNDLE_YAML.replace('  - path: ./plugins/sop', '  - path: ../escape') }, 'must stay inside the bundle'],
    ]
    for (const [overrides, message] of cases) {
      const dir = await makeBundle(overrides)
      await expect(verifyBundle(dir)).rejects.toThrow(message)
    }
  })

  it('validates the langgraph.json composition entry deeply', async () => {
    const notJson = await validBundle()
    await writeFile(join(notJson, 'langgraph.json'), '{broken')
    await expect(verifyBundle(notJson)).rejects.toThrow('is not valid JSON')

    const noGraphs = await validBundle()
    await writeFile(join(noGraphs, 'langgraph.json'), JSON.stringify({ dependencies: ['.'] }))
    await expect(verifyBundle(noGraphs)).rejects.toThrow('must contain a "graphs" mapping')

    const noAgent = await validBundle()
    await writeFile(join(noAgent, 'langgraph.json'), JSON.stringify({ graphs: { other: './agent.py:agent' } }))
    await expect(verifyBundle(noAgent)).rejects.toThrow('graphs must declare "agent"')

    const missingModule = await validBundle()
    await rm(join(missingModule, 'agent.py'))
    await expect(verifyBundle(missingModule)).rejects.toThrow('module "./agent.py" is missing')

    const malformedRef = await validBundle()
    await writeFile(join(malformedRef, 'langgraph.json'), JSON.stringify({ graphs: { agent: 'agent.py' } }))
    await expect(verifyBundle(malformedRef)).rejects.toThrow('"<module>:<attr>"')
  })

  it('requires the lockfile pointer to exist', async () => {
    const dir = await validBundle()
    await writeFile(join(dir, 'bundle.yaml'), BUNDLE_YAML + '\nlockfile: ./absent.lock\n')
    await expect(verifyBundle(dir)).rejects.toThrow('lockfile points to a missing file')
  })
})

describe('deepagents digest scope', () => {
  it('excludes __pycache__, .langgraph_api, and *.egg-info runtime state', async () => {
    const withState = await validBundle()
    await mkdir(join(withState, 'plugins/office_base/__pycache__'), { recursive: true })
    await writeFile(join(withState, 'plugins/office_base/__pycache__/init.cpython-312.pyc'), 'bytecode')
    await mkdir(join(withState, '.langgraph_api'), { recursive: true })
    await writeFile(join(withState, '.langgraph_api/store.pckl'), 'state')
    await mkdir(join(withState, 'probe_dg.egg-info'), { recursive: true })
    await writeFile(join(withState, 'probe_dg.egg-info/PKG-INFO'), 'metadata')
    const withoutState = await validBundle()
    const scope = {
      excludeDirectories: DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORIES,
      excludeDirectorySuffixes: DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORY_SUFFIXES,
    }
    expect(await computeBundleDigest(withState, scope)).toBe(await computeBundleDigest(withoutState, scope))
    expect(await computeBundleDigest(withoutState, digestOptions({ kind: DEEPAGENTS_BUNDLE_KIND } as never))).toBe(
      await computeBundleDigest(withoutState, scope),
    )
  })
})

describe('installDeepagentsBundle', () => {
  it('runs version check -> venv -> pip install and registers the install', async () => {
    const dir = await validBundle()
    const home = await makeDir('agent-bundle-dg-home-')
    const registryPath = join(await makeDir('agent-bundle-dg-reg-'), 'installations.json')
    const pyBin = await makeExecutable(join(await makeDir('agent-bundle-dg-py-'), 'python3.12'))
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const lines: string[] = []
    const result = await installDeepagentsBundle({
      bundleDir: dir,
      home,
      registryPath,
      runPython: fakeRunPython(calls),
      env: { ...bareEnv, PYTHON_BIN: pyBin },
      log: line => { lines.push(line) },
    })
    expect(result.reused).toBe(false)
    expect(result.profile).toBe('probe-dg')
    expect(result.launchCommand).toBe(`cd ${dir} && ${join(home, 'bin', 'python')} -c "import agent"`)
    expect(calls).toEqual([
      { command: pyBin, args: ['-c', expect.stringContaining('sys.version_info')] },
      { command: pyBin, args: ['-m', 'venv', home] },
      { command: join(home, 'bin', 'python'), args: ['-m', 'pip', 'install', '-e', dir] },
    ])
    const reuseRecord = JSON.parse(await readFile(join(home, '.bundle-install.json'), 'utf8')) as { digest: string; bundleDir: string }
    expect(reuseRecord.digest).toBe(result.digest)
    expect(reuseRecord.bundleDir).toBe(dir)
    const records = await loadRegistry(registryPath)
    expect(records).toHaveLength(1)
    expect(records[0]?.id).toBe(`probe-dg-${result.digest.slice(7, 15)}`)
    expect(records[0]?.kind).toBe(DEEPAGENTS_BUNDLE_KIND)
    expect(records[0]?.harnessVersion).toBe('>=0.7,<0.8')
    expect(lines.some(line => line.includes('creating venv'))).toBe(true)
  })

  it('prefers uv for venv creation and pip when UV_BIN is set (no python probe needed)', async () => {
    const dir = await validBundle()
    const home = await makeDir('agent-bundle-dg-home-')
    const uvBin = await makeExecutable(join(await makeDir('agent-bundle-dg-uv-'), 'uv'))
    const calls: Array<{ command: string; args: readonly string[] }> = []
    await installDeepagentsBundle({
      bundleDir: dir,
      home,
      registryPath: join(await makeDir('agent-bundle-dg-reg-'), 'installations.json'),
      runPython: fakeRunPython(calls),
      env: { ...bareEnv, UV_BIN: uvBin },
    })
    expect(calls).toEqual([
      { command: uvBin, args: ['venv', '--python', '3.12', home] },
      { command: uvBin, args: ['pip', 'install', '--python', join(home, 'bin', 'python'), '-e', dir] },
    ])
  })

  it('reuses an installation whose recorded digest matches without spawning', async () => {
    const dir = await validBundle()
    const home = await makeDir('agent-bundle-dg-home-')
    const registryPath = join(await makeDir('agent-bundle-dg-reg-'), 'installations.json')
    const pyBin = await makeExecutable(join(await makeDir('agent-bundle-dg-py-'), 'python3.12'))
    let spawns = 0
    const run = async (): Promise<void> => { spawns += 1 }
    await installDeepagentsBundle({
      bundleDir: dir, home, registryPath, runPython: fakeRunPython([]), env: { ...bareEnv, PYTHON_BIN: pyBin },
    })
    spawns = 0
    const reused = await installDeepagentsBundle({
      bundleDir: dir, home, registryPath, runPython: () => { spawns += 1; return Promise.resolve() }, env: { ...bareEnv, PYTHON_BIN: pyBin },
      log: line => { expect(line).toContain('reusing installation') },
    })
    expect(reused.reused).toBe(true)
    expect(spawns).toBe(0)
    expect((await loadRegistry(registryPath))).toHaveLength(1)
  })

  it('rejects version-check failures, a missing seam, and unresolvable python', async () => {
    const dir = await validBundle()
    const pyBin = await makeExecutable(join(await makeDir('agent-bundle-dg-py-'), 'python3.12'))
    await expect(installDeepagentsBundle({
      bundleDir: dir, home: await makeDir('agent-bundle-dg-home-'),
      runPython: async () => { throw new Error('version too old') },
      env: { ...bareEnv, PYTHON_BIN: pyBin },
    })).rejects.toThrow('python >= 3.11 is required')

    await expect(installDeepagentsBundle({ bundleDir: dir, env: { ...bareEnv, PYTHON_BIN: pyBin } }))
      .rejects.toThrow('requires a runPython seam')

    await expect(installDeepagentsBundle({
      bundleDir: dir, home: await makeDir('agent-bundle-dg-home-'),
      runPython: fakeRunPython([]), env: bareEnv,
    })).rejects.toThrow('cannot resolve a python interpreter')

    await expect(installDeepagentsBundle({
      bundleDir: dir, home: await makeDir('agent-bundle-dg-home-'),
      runPython: fakeRunPython([]), env: { ...bareEnv, PYTHON_BIN: join(await makeDir('agent-bundle-dg-x-'), 'missing') },
    })).rejects.toThrow('PYTHON_BIN points to a missing or non-executable file')
  })

  it('reinstalls into an existing venv when the install record is missing', async () => {
    const dir = await validBundle()
    const home = await makeDir('agent-bundle-dg-home-')
    const pyBin = await makeExecutable(join(await makeDir('agent-bundle-dg-py-'), 'python3.12'))
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeFile(join(home, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 })
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const lines: string[] = []
    await installDeepagentsBundle({
      bundleDir: dir, home,
      registryPath: join(await makeDir('agent-bundle-dg-reg-'), 'installations.json'),
      runPython: fakeRunPython(calls),
      env: { ...bareEnv, PYTHON_BIN: pyBin },
      log: line => { lines.push(line) },
    })
    expect(lines.some(line => line.includes('venv already exists'))).toBe(true)
    expect(calls.some(call => call.args[0] === '-m' && call.args[1] === 'venv')).toBe(false)
    expect(calls.some(call => call.args.includes('-e'))).toBe(true)
  })
})

describe('deepagents uninstall', () => {
  it('removes the venv home and the registry record through the shared path', async () => {
    const home = await makeDir('agent-bundle-dg-home-')
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeFile(join(home, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 })
    const registryPath = join(await makeDir('agent-bundle-dg-reg-'), 'installations.json')
    const record: InstallationRecord = {
      id: 'probe-dg-abcdef01',
      name: 'probe-dg',
      kind: DEEPAGENTS_BUNDLE_KIND,
      digest: 'sha256:abcdef0100000000000000000000000000000000000000000000000000000000',
      home,
      profile: 'probe-dg',
      bundleDir: '/bundles/probe-dg',
      installedAt: '2026-09-20T00:00:00.000Z',
      mode: 'ephemeral',
      harnessVersion: '>=0.7,<0.8',
    }
    await saveRegistry(registryPath, [record])
    const result = await dispatchUninstall({ id: record.id, registryPath })
    expect(result).toEqual({ removed: true, homeExisted: true, occupied: false, bundleDir: '/bundles/probe-dg' })
    expect(await loadRegistry(registryPath)).toEqual([])
  })
})

describe('resolvePythonRuntime', () => {
  it('prefers PYTHON_BIN, then PATH candidates in order', async () => {
    const dir = await makeDir('agent-bundle-dg-py-')
    const py313 = await makeExecutable(join(dir, 'python3.13'))
    const py312 = await makeExecutable(join(dir, 'python3.12'))
    await writeFile(join(dir, 'python3.11'), '', { mode: 0o644 })
    const runtime = await resolvePythonRuntime({ ...bareEnv, PYTHON_BIN: py313 })
    expect(runtime).toEqual({ command: py313, source: 'PYTHON_BIN' })
    const fromPath = await resolvePythonRuntime({ ...bareEnv, PATH: `${bareEnv['PATH']}:${dir}` })
    expect(fromPath.source).toBe('PATH:python3.13')
    await rm(py313)
    const next = await resolvePythonRuntime({ ...bareEnv, PATH: `${bareEnv['PATH']}:${dir}` })
    expect(next.source).toBe('PATH:python3.12')
    expect(next.command).toBe(py312)
  })

  it('reports an unresolvable interpreter with guidance', async () => {
    await expect(resolvePythonRuntime({ PATH: '' })).rejects.toThrow('cannot resolve a python interpreter')
    const nonExec = await makeDir('agent-bundle-dg-x-')
    await writeFile(join(nonExec, 'noexec'), '')
    await expect(resolvePythonRuntime({ PATH: '', PYTHON_BIN: join(nonExec, 'noexec') })).rejects.toThrow('missing or non-executable')
    if (process.platform === 'win32') return
    await symlink('/nonexistent', join(nonExec, 'dangling'))
    await expect(resolvePythonRuntime({ PATH: '', PYTHON_BIN: join(nonExec, 'dangling') })).rejects.toThrow('missing or non-executable')
  })
})
