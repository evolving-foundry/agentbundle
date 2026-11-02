import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJiuwenswarmBundleManifest } from '../src/adapters/jiuwenswarm/manifest.ts'
import { resolveJiuwenswarmCommand } from '../src/adapters/jiuwenswarm/jiuwenswarm-bin.ts'
import { installJiuwenswarmBundle } from '../src/adapters/jiuwenswarm/install.ts'
import { dispatchUninstall, loadRegistry } from '../src/index.ts'

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

const DEFAULT_JIUWENSWARM_BUNDLE_YAML = [
  'kind: jiuwenswarm-agent-bundle',
  'schemaVersion: 1',
  'name: example-jw',
  'harness:',
  '  name: jiuwenswarm',
  '  version: ">=0.2,<0.3"',
  'skills: ./skills',
  'packages:',
  '  - path: ./packages/office-expert',
  '    kind: agent_template',
  'templates: ./templates',
  'config: ./config.yaml',
  'lockfile: ./dependencies.lock',
].join('\n')

const AGENT_TEMPLATE_MANIFEST = JSON.stringify({
  id: 'office-expert',
  name: 'office-expert',
  package_type: 'agent_template',
  version: '0.1.0',
})

interface JiuwenswarmBundleOptions {
  readonly bundleYaml?: string
  readonly agentYaml?: string | null
  readonly skills?: Record<string, string>
  readonly packages?: Array<{ readonly id?: string; readonly manifest?: string }>
  readonly templates?: Record<string, string>
  readonly configYaml?: string
}

async function jiuwenswarmBundle(options: JiuwenswarmBundleOptions = {}): Promise<string> {
  const dir = await makeDir('jiuwenswarm-bundle-spec-')
  const files: Record<string, string> = {
    'bundle.yaml': options.bundleYaml ?? DEFAULT_JIUWENSWARM_BUNDLE_YAML,
    'dependencies.lock': JSON.stringify({ host: { name: 'jiuwenswarm', version: '0.2.5.beta1' } }),
    'config.yaml': options.configYaml ?? 'preferred_language: zh\nrsi:\n  enabled: false\n',
    'skills/office-report/SKILL.md': '# Office Report\n\nWrite the report.\n',
    'skills/office-report/references/notes.md': 'notes\n',
    'templates/config/config.yaml': 'preferred_language: zh\n',
    'templates/agent/workspace/AGENT.md': '# Agent\n',
    'packages/office-expert/manifest.json': AGENT_TEMPLATE_MANIFEST,
    'packages/office-expert/README.md': '# office-expert\n',
  }
  if (options.skills !== undefined) {
    for (const [rel, content] of Object.entries(options.skills)) {
      files[`skills/${rel}`] = content
    }
  }
  if (options.packages !== undefined) {
    for (const [index, entry] of options.packages.entries()) {
      const base = `packages/p${index + 1}`
      files[`${base}/manifest.json`] = entry.manifest ?? JSON.stringify({
        id: entry.id ?? `p${index + 1}`,
        name: entry.id ?? `p${index + 1}`,
        package_type: 'agent_template',
      })
    }
  }
  if (options.templates !== undefined) {
    for (const [rel, content] of Object.entries(options.templates)) {
      files[`templates/${rel}`] = content
    }
  }
  if (options.agentYaml !== null && options.agentYaml !== undefined) {
    files['agent.yaml'] = options.agentYaml
  }
  await writeFiles(dir, files)
  return dir
}

describe('jiuwenswarm manifest parsing', () => {
  it('resolves the declared native resources', async () => {
    const dir = await jiuwenswarmBundle()
    const manifest = await parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      skills: './skills',
      packages: [{ path: './packages/office-expert', kind: 'agent_template' }],
      templates: './templates',
      config: './config.yaml',
      lockfile: './dependencies.lock',
    })
    expect(manifest.kind).toBe('jiuwenswarm-agent-bundle')
    expect(manifest.name).toBe('example-jw')
    expect(manifest.harnessVersion).toBe('>=0.2,<0.3')
    expect(manifest.skills).toBe(join(dir, 'skills'))
    expect(manifest.templates).toBe(join(dir, 'templates'))
    expect(manifest.config).toBe(join(dir, 'config.yaml'))
    expect(manifest.lockfile).toBe(join(dir, 'dependencies.lock'))
    expect(manifest.packages).toHaveLength(1)
    expect(manifest.packages?.[0]).toMatchObject({
      declared: './packages/office-expert',
      kind: 'agent_template',
      packageId: 'office-expert',
    })
  })

  it('accepts a bundle with no kind-specific resources', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: [
        'kind: jiuwenswarm-agent-bundle',
        'schemaVersion: 1',
        'name: example-jw',
        'harness:',
        '  name: jiuwenswarm',
        '  version: ">=0.2,<0.3"',
      ].join('\n'),
    })
    const manifest = await parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
    })
    expect(manifest.skills).toBeUndefined()
    expect(manifest.packages).toBeUndefined()
    expect(manifest.templates).toBeUndefined()
    expect(manifest.config).toBeUndefined()
    expect(manifest.lockfile).toBeUndefined()
  })

  it('resolves declared connectors', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: [
        'kind: jiuwenswarm-agent-bundle',
        'schemaVersion: 1',
        'name: example-jw',
        'harness:',
        '  name: jiuwenswarm',
        '  version: ">=0.2,<0.3"',
        'connectors:',
        '  - office-mail',
      ].join('\n'),
    })
    const manifest = await parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      connectors: ['office-mail'],
    })
    expect(manifest.connectors).toEqual(['office-mail'])
  })

  it('rejects connectors that are not a non-empty string list', async () => {
    const dir = await jiuwenswarmBundle()
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      connectors: 'office-mail',
    })).rejects.toThrow(/connectors must be a non-empty list/)
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      connectors: [''],
    })).rejects.toThrow(/non-empty strings/)
  })

  it('rejects duplicate connector names', async () => {
    const dir = await jiuwenswarmBundle()
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      connectors: ['office-mail', 'office-mail'],
    })).rejects.toThrow(/duplicate/)
  })

  it('requires every package-requested connector to be declared by the bundle', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: [
        'kind: jiuwenswarm-agent-bundle',
        'schemaVersion: 1',
        'name: example-jw',
        'harness:',
        '  name: jiuwenswarm',
        '  version: ">=0.2,<0.3"',
        'connectors:',
        '  - office-mail',
        'packages:',
        '  - path: ./packages/p1',
        '    kind: plugin',
      ].join('\n'),
      packages: [{
        id: 'office-tools',
        manifest: JSON.stringify({ id: 'office-tools', package_type: 'plugin', mcps: [{ connector: 'office-ldap' }] }),
      }],
    })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      connectors: ['office-mail'],
      packages: [{ path: './packages/p1', kind: 'plugin' }],
    })).rejects.toThrow(/require connectors office-ldap/)
  })

  it('accepts package-requested connectors that the bundle declares', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: [
        'kind: jiuwenswarm-agent-bundle',
        'schemaVersion: 1',
        'name: example-jw',
        'harness:',
        '  name: jiuwenswarm',
        '  version: ">=0.2,<0.3"',
        'connectors:',
        '  - office-mail',
        'packages:',
        '  - path: ./packages/p1',
        '    kind: plugin',
      ].join('\n'),
      packages: [{
        id: 'office-tools',
        manifest: JSON.stringify({ id: 'office-tools', package_type: 'plugin', mcps: [{ connector: 'office-mail' }] }),
      }],
    })
    const manifest = await parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      connectors: ['office-mail'],
      packages: [{ path: './packages/p1', kind: 'plugin' }],
    })
    expect(manifest.connectors).toEqual(['office-mail'])
  })

  it('rejects a non-1 schemaVersion', async () => {
    const dir = await jiuwenswarmBundle({ bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('schemaVersion: 1', 'schemaVersion: 2') })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 2,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
    })).rejects.toThrow(/schemaVersion must be 1/)
  })

  it('rejects a mismatched harness name', async () => {
    const dir = await jiuwenswarmBundle()
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'not-jiuwenswarm', version: '>=0.2,<0.3' },
    })).rejects.toThrow(/harness.name must be "jiuwenswarm"/)
  })

  it('rejects an empty harness version', async () => {
    const dir = await jiuwenswarmBundle()
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '' },
    })).rejects.toThrow(/harness.version must be a non-empty/)
  })

  it('rejects a name that is not a slug', async () => {
    const dir = await jiuwenswarmBundle({ bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('name: example-jw', 'name: ExampleAgent_JW') })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'ExampleAgent_JW',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
    })).rejects.toThrow(/name must match/)
  })

  it('rejects an absolute resource path', async () => {
    const dir = await jiuwenswarmBundle({ bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('config: ./config.yaml', 'config: /etc/config.yaml') })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      config: '/etc/config.yaml',
    })).rejects.toThrow(/relative path inside the bundle/)
  })

  it('rejects a traversal resource path', async () => {
    const dir = await jiuwenswarmBundle({ bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('skills: ./skills', 'skills: ../skills') })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      skills: '../skills',
    })).rejects.toThrow(/relative path inside the bundle/)
  })

  it('rejects a missing pointer', async () => {
    const dir = await jiuwenswarmBundle({ bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('templates: ./templates', 'templates: ./missing-templates') })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      templates: './missing-templates',
    })).rejects.toThrow(/points to a missing path/)
  })

  it('rejects a skills directory entry without SKILL.md', async () => {
    const dir = await jiuwenswarmBundle({ skills: { 'broken-skill/README.md': '# no SKILL.md\n' } })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      skills: './skills',
    })).rejects.toThrow(/broken-skill has no SKILL.md/)
  })

  it('accepts a single-file skill entry', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('skills: ./skills', 'skills: ./skills/office-report/SKILL.md'),
      skills: {},
    })
    const manifest = await parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      skills: './skills/office-report/SKILL.md',
    })
    expect(manifest.skills).toBe(join(dir, 'skills', 'office-report', 'SKILL.md'))
  })

  it('rejects a package entry with an unknown kind', async () => {
    const dir = await jiuwenswarmBundle({ bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('kind: agent_template', 'kind: mystery') })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      packages: [{ path: './packages/office-expert', kind: 'mystery' }],
    })).rejects.toThrow(/package kind must be one of/)
  })

  it('rejects a package without a manifest.json', async () => {
    const dir = await jiuwenswarmBundle({ packages: [{ id: 'orphan' }], templates: undefined })
    const target = join(dir, 'packages', 'p1')
    await rm(join(target, 'manifest.json'))
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      packages: [{ path: './packages/p1', kind: 'agent_template' }],
    })).rejects.toThrow(/has no manifest.json/)
  })

  it('rejects a package whose package_type does not match the declared kind', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('kind: agent_template', 'kind: plugin'),
      packages: [{ id: 'office-plugin', manifest: JSON.stringify({ id: 'office-plugin', package_type: 'agent_template' }) }],
    })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      packages: [{ path: './packages/p1', kind: 'plugin' }],
    })).rejects.toThrow(/package_type/)
  })

  it('rejects a config that is not a YAML mapping', async () => {
    const dir = await jiuwenswarmBundle({ configYaml: '- one\n- two\n' })
    await expect(parseJiuwenswarmBundleManifest(dir, {
      kind: 'jiuwenswarm-agent-bundle',
      schemaVersion: 1,
      name: 'example-jw',
      harness: { name: 'jiuwenswarm', version: '>=0.2,<0.3' },
      config: './config.yaml',
    })).rejects.toThrow(/must contain a YAML mapping/)
  })
})

describe('jiuwenswarm runtime resolution', () => {
  it('resolves JIUWENSWARM_BIN when it points to an executable', async () => {
    const dir = await makeDir('jiuwenswarm-bin-')
    const bin = join(dir, 'jiuwenswarm-process')
    await writeFile(bin, '#!/bin/sh\nexit 0\n')
    await chmod(bin, 0o755)
    const resolved = await resolveJiuwenswarmCommand({ JIUWENSWARM_BIN: bin })
    expect(resolved).toMatchObject({ command: bin, source: 'JIUWENSWARM_BIN' })
  })

  it('rejects a non-absolute JIUWENSWARM_BIN', async () => {
    await expect(resolveJiuwenswarmCommand({ JIUWENSWARM_BIN: 'jiuwenswarm-process' })).rejects.toMatchObject({ code: 'RUNTIME_UNRESOLVED' })
  })

  it('rejects a missing JIUWENSWARM_BIN', async () => {
    const missing = join(await makeDir('jiuwenswarm-bin-'), 'nope')
    await expect(resolveJiuwenswarmCommand({ JIUWENSWARM_BIN: missing })).rejects.toMatchObject({ code: 'RUNTIME_UNRESOLVED' })
  })

  it('resolves JIUWENSWARM_CHECKOUT .venv binary', async () => {
    const dir = await makeDir('jiuwenswarm-checkout-')
    const bin = join(dir, '.venv', 'bin', 'jiuwenswarm-process')
    await mkdir(join(dir, '.venv', 'bin'), { recursive: true })
    await writeFile(bin, '#!/bin/sh\nexit 0\n')
    await chmod(bin, 0o755)
    const resolved = await resolveJiuwenswarmCommand({ JIUWENSWARM_CHECKOUT: dir })
    expect(resolved).toMatchObject({ command: bin, source: 'JIUWENSWARM_CHECKOUT' })
  })

  it('resolves jiuwenswarm-process from PATH', async () => {
    const dir = await makeDir('jiuwenswarm-path-')
    const bin = join(dir, 'jiuwenswarm-process')
    await writeFile(bin, '#!/bin/sh\nexit 0\n')
    await chmod(bin, 0o755)
    const resolved = await resolveJiuwenswarmCommand({ PATH: dir })
    expect(resolved).toMatchObject({ command: bin, source: 'PATH:jiuwenswarm-process' })
  })

  it('prefers JIUWENSWARM_BIN over JIUWENSWARM_CHECKOUT', async () => {
    const dir = await makeDir('jiuwenswarm-priority-')
    const bin = join(dir, 'explicit')
    const checkoutBin = join(dir, '.venv', 'bin', 'jiuwenswarm-process')
    await mkdir(join(dir, '.venv', 'bin'), { recursive: true })
    for (const target of [bin, checkoutBin]) {
      await writeFile(target, '#!/bin/sh\nexit 0\n')
      await chmod(target, 0o755)
    }
    const resolved = await resolveJiuwenswarmCommand({ JIUWENSWARM_BIN: bin, JIUWENSWARM_CHECKOUT: dir })
    expect(resolved?.command).toBe(bin)
  })

  it('returns undefined when no runtime can be resolved', async () => {
    const dir = await makeDir('jiuwenswarm-empty-path-')
    const resolved = await resolveJiuwenswarmCommand({ PATH: dir, JIUWENSWARM_CHECKOUT: dir })
    expect(resolved).toBeUndefined()
  })

  it('rejects an invalid JIUWENSWARM_BIN even when PATH has the binary', async () => {
    const dir = await makeDir('jiuwenswarm-fallback-')
    const bin = join(dir, 'jiuwenswarm-process')
    await writeFile(bin, '#!/bin/sh\nexit 0\n')
    await chmod(bin, 0o755)
    await expect(resolveJiuwenswarmCommand({ JIUWENSWARM_BIN: '/does/not/exist', PATH: dir })).rejects.toMatchObject({ code: 'RUNTIME_UNRESOLVED' })
  })
})

describe('jiuwenswarm adapter install', () => {
  async function installEnv(extra: Record<string, string> = {}): Promise<{ env: NodeJS.ProcessEnv; emptyPath: string }> {
    const emptyPath = await makeDir('jiuwenswarm-empty-path-')
    return { env: { PATH: emptyPath, ...extra }, emptyPath }
  }

  it('materializes the workspace, writes model env, and registers', async () => {
    const dir = await jiuwenswarmBundle({
      agentYaml: 'model:\n  provider: dashscope\n  model: qwen-max\n',
      bundleYaml: `${DEFAULT_JIUWENSWARM_BUNDLE_YAML}\nconnectors:\n  - office-mail\n`,
    })
    const registryPath = join(await makeDir('jw-registry-'), 'installations.json')
    const home = join(await makeDir('jw-home-'), 'home')
    const { env } = await installEnv()
    const logs: string[] = []
    const result = await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath, env, log: line => logs.push(line) })

    expect(result.reused).toBe(false)
    expect(result.profile).toBe('example-jw')
    expect(result.launchCommand).toBe('jiuwenswarm-process "<task>" --output json')
    expect(result.launchEnv).toEqual({ JIUWENSWARM_DATA_DIR: home })
    expect(result.harness).toEqual({ name: 'jiuwenswarm', versionRange: '>=0.2,<0.3' })
    expect(result.skills).toBe(join(home, 'agent', 'workspace', 'skills'))
    expect(result.packages).toEqual(['./packages/office-expert:agent_template'])
    expect(result.connectors).toEqual(['office-mail'])
    expect(result.config).toBe(join(home, 'config', 'config.yaml'))

    const configText = await readFile(join(home, 'config', 'config.yaml'), 'utf8')
    expect(configText).toContain('preferred_language: zh')
    expect(configText).toContain('enabled: false')
    expect(await readFile(join(home, 'agent', 'workspace', 'AGENT.md'), 'utf8')).toContain('# Agent')
    expect(await readFile(join(home, 'agent', 'workspace', 'skills', 'office-report', 'SKILL.md'), 'utf8')).toContain('# Office Report')

    const envText = await readFile(join(home, 'config', '.env'), 'utf8')
    expect(envText).toContain('MODEL_NAME=qwen-max')
    expect(envText).toContain('MODEL_PROVIDER=OpenAI')
    expect(envText).toContain('ENDPOINT_PROFILE=dashscope')

    const packageManifest = JSON.parse(await readFile(join(home, 'agent', 'workspace', 'plugins', 'agent_templates', 'built_in', 'office-expert', 'manifest.json'), 'utf8')) as { package_type: string }
    expect(packageManifest.package_type).toBe('agent_template')
    const marketplace = JSON.parse(await readFile(join(home, 'agent', 'workspace', 'plugins', 'agent_templates', 'marketplace.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> }
    expect(marketplace.plugins).toContainEqual({ id: 'office-expert', installed: true, source: 'builtin' })

    const stamp = JSON.parse(await readFile(join(home, '.bundle-install.json'), 'utf8')) as { digest: string }
    expect(stamp.digest).toBe(result.digest)
    const records = await loadRegistry(registryPath)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: result.id,
      name: 'example-jw',
      kind: 'jiuwenswarm-agent-bundle',
      home,
      profile: 'example-jw',
      mode: 'ephemeral',
    })
    expect(logs.join('\n')).toContain('warning:')
  })

  it('materializes a single-file skill into a named skill directory', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: DEFAULT_JIUWENSWARM_BUNDLE_YAML.replace('skills: ./skills', 'skills: ./skills/office-report/SKILL.md'),
      skills: {},
    })
    const home = join(await makeDir('jw-home-'), 'home')
    await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath: join(await makeDir('jw-registry-'), 'installations.json'), env: (await installEnv()).env })
    expect(await readFile(join(home, 'agent', 'workspace', 'skills', 'office-report', 'SKILL.md'), 'utf8')).toContain('# Office Report')
  })

  it('materializes all three package kinds into their catalog roots', async () => {
    const dir = await jiuwenswarmBundle({
      bundleYaml: [
        'kind: jiuwenswarm-agent-bundle',
        'schemaVersion: 1',
        'name: example-jw',
        'harness:',
        '  name: jiuwenswarm',
        '  version: ">=0.2,<0.3"',
        'packages:',
        '  - path: ./packages/p1',
        '    kind: agent_template',
        '  - path: ./packages/p2',
        '    kind: plugin',
        '  - path: ./packages/p3',
        '    kind: agent_group',
      ].join('\n'),
      packages: [
        { id: 'p1', manifest: JSON.stringify({ id: 'p1', package_type: 'agent_template' }) },
        { id: 'p2', manifest: JSON.stringify({ id: 'p2', package_type: 'plugin' }) },
        { id: 'p3', manifest: JSON.stringify({ id: 'p3', package_type: 'agent_group' }) },
      ],
    })
    const home = join(await makeDir('jw-home-'), 'home')
    await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath: join(await makeDir('jw-registry-'), 'installations.json'), env: (await installEnv()).env })
    const workspace = join(home, 'agent', 'workspace')
    for (const [root, id] of [
      [join(workspace, 'plugins', 'agent_templates'), 'p1'],
      [join(workspace, 'plugins', 'plugin_packages'), 'p2'],
      [join(home, '.agent_teams', 'agent_groups'), 'p3'],
    ] as const) {
      expect(await readFile(join(root, 'built_in', id, 'manifest.json'), 'utf8')).toContain(id)
      const marketplace = JSON.parse(await readFile(join(root, 'marketplace.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> }
      expect(marketplace.plugins).toContainEqual({ id, installed: true, source: 'builtin' })
    }
  })

  it('merges bundle skills into skills_state.json', async () => {
    const dir = await jiuwenswarmBundle({
      templates: {
        'agent/workspace/skills/skills_state.json': JSON.stringify({ marketplaces: [], installed_plugins: [], local_skills: [] }),
      },
    })
    const home = join(await makeDir('jw-home-'), 'home')
    await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath: join(await makeDir('jw-registry-'), 'installations.json'), env: (await installEnv()).env })
    const state = JSON.parse(await readFile(join(home, 'agent', 'workspace', 'skills', 'skills_state.json'), 'utf8')) as { installed_plugins: Array<{ name: string }> }
    expect(state.installed_plugins).toContainEqual(expect.objectContaining({ name: 'office-report', marketplace: 'builtin' }))
  })

  it('reuses the same digest without re-materializing', async () => {
    const dir = await jiuwenswarmBundle({})
    const registryPath = join(await makeDir('jw-registry-'), 'installations.json')
    const home = join(await makeDir('jw-home-'), 'home')
    const env = (await installEnv()).env
    const first = await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath, env })
    const configPath = join(home, 'config', 'config.yaml')
    await writeFile(configPath, 'mutated: true\n')
    const second = await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath, env })
    expect(second.reused).toBe(true)
    expect(second.id).toBe(first.id)
    expect(await readFile(configPath, 'utf8')).toBe('mutated: true\n')
  })

  it('rebuilds the home when the reuse stamp is missing', async () => {
    const dir = await jiuwenswarmBundle({})
    const registryPath = join(await makeDir('jw-registry-'), 'installations.json')
    const home = join(await makeDir('jw-home-'), 'home')
    const env = (await installEnv()).env
    await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath, env })
    await rm(join(home, '.bundle-install.json'))
    await writeFile(join(home, 'config', 'config.yaml'), 'mutated: true\n')
    const second = await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath, env })
    expect(second.reused).toBe(false)
    expect(await readFile(join(home, 'config', 'config.yaml'), 'utf8')).toContain('preferred_language: zh')
  })

  it('uninstalls the record and the home', async () => {
    const dir = await jiuwenswarmBundle({})
    const registryPath = join(await makeDir('jw-registry-'), 'installations.json')
    const home = join(await makeDir('jw-home-'), 'home')
    const env = (await installEnv()).env
    const result = await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath, env })
    const removed = await dispatchUninstall({ id: result.id, registryPath })
    expect(removed.removed).toBe(true)
    expect(removed.homeExisted).toBe(true)
    await expect(stat(join(home, 'config'))).rejects.toThrow()
    expect(await loadRegistry(registryPath)).toHaveLength(0)
  })

  it('resolves model placeholders at install time from the environment', async () => {
    const dir = await jiuwenswarmBundle({ agentYaml: 'model:\n  provider: ${JIUWENSWARM_MODEL_PROVIDER}\n  model: ${JIUWENSWARM_MODEL_NAME}\n' })
    const home = join(await makeDir('jw-home-'), 'home')
    const { env } = await installEnv({ JIUWENSWARM_MODEL_PROVIDER: 'deepseek', JIUWENSWARM_MODEL_NAME: 'deepseek-chat' })
    await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath: join(await makeDir('jw-registry-'), 'installations.json'), env })
    const envText = await readFile(join(home, 'config', '.env'), 'utf8')
    expect(envText).toContain('MODEL_NAME=deepseek-chat')
    expect(envText).toContain('ENDPOINT_PROFILE=deepseek')
  })

  it('skips the model write when a placeholder variable is missing', async () => {
    const dir = await jiuwenswarmBundle({ agentYaml: 'model:\n  provider: ${JIUWENSWARM_MODEL_PROVIDER}\n  model: ${JIUWENSWARM_MODEL_NAME}\n' })
    const home = join(await makeDir('jw-home-'), 'home')
    const { env } = await installEnv({ JIUWENSWARM_MODEL_PROVIDER: 'deepseek' })
    await installJiuwenswarmBundle({ bundleDir: dir, home, registryPath: join(await makeDir('jw-registry-'), 'installations.json'), env })
    let envText = ''
    try {
      envText = await readFile(join(home, 'config', '.env'), 'utf8')
    } catch {
      // No .env baseline in templates and no model write: the file may be absent.
    }
    expect(envText).not.toContain('MODEL_NAME')
    expect(envText).not.toContain('ENDPOINT_PROFILE')
  })
})
