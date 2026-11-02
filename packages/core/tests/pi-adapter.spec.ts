import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BundleError,
  computeBundleDigest,
  dispatchLoad,
  dispatchUninstall,
  expandExtensionEntry,
  installPiBundle,
  listBundleDigestPaths,
  loadRegistry,
  saveRegistry,
  parsePiAgentConfig,
  parsePiSettings,
  readPiSettingsIfPresent,
  resolvePiModelSelection,
  verifyBundle,
} from '../src/index.ts'
import { resolvePiCommand } from '../src/pi-bin.ts'
import { packageEntryTarget } from '../src/bundle-paths.ts'
import { assertVersionRange } from '../src/adapters/pi/range.ts'

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

const PI_PACKAGE_JSON = JSON.stringify({
  name: '@example/pi',
  version: '0.1.0',
  type: 'module',
  pi: { extensions: ['./dist/extension.js'] },
  exports: { '.': { import: './dist/index.js' } },
})

interface PiBundleOptions {
  readonly bundleYaml?: string
  readonly agentYaml?: string | null
  readonly settings?: string
  readonly extensionPath?: string
  readonly withDist?: boolean
}

const DEFAULT_PI_BUNDLE_YAML = [
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
].join('\n')

async function piBundle(options: PiBundleOptions = {}): Promise<string> {
  const dir = await makeDir('pi-bundle-spec-')
  const extensionPath = options.extensionPath ?? 'extensions/pi'
  const files: Record<string, string> = {
    'bundle.yaml': options.bundleYaml ?? DEFAULT_PI_BUNDLE_YAML,
    'dependencies.lock': JSON.stringify({ host: { name: '@earendil-works/pi-coding-agent', version: '0.85.1' } }),
    'settings.json': options.settings ?? '{}\n',
    'agent/instructions.md': 'You are Pi.\n',
    'skills/diagnose/SKILL.md': '---\nname: diagnose\ndescription: Diagnose a failing workspace before changing anything.\n---\n\nRun the checks.\n',
    'skills/verify/SKILL.md': '---\nname: verify\ndescription: Verify a change by re-reading the artifact you produced.\n---\n\nVerify it.\n',
  }
  if (extensionPath.endsWith('.js') || extensionPath.endsWith('.ts')) {
    files[extensionPath] = 'export default function () {}\n'
  } else {
    files[`${extensionPath}/package.json`] = PI_PACKAGE_JSON
    files[`${extensionPath}/README.md`] = '# plugin\n'
    files[`${extensionPath}/src/index.js`] = 'export default function () {}\n'
    if (options.withDist !== false) {
      files[`${extensionPath}/dist/index.js`] = 'export default function () {}\n'
      files[`${extensionPath}/dist/extension.js`] = 'export default function () {}\n'
    }
  }
  if (options.agentYaml !== null && options.agentYaml !== undefined) {
    files['agent.yaml'] = options.agentYaml
  }
  await writeFiles(dir, files)
  return dir
}

const AGENT_WITH_MODEL = 'model:\n  provider: ai-gateway\n  model: glm-5.3-flash\n'
const AGENT_WITH_PLACEHOLDERS = 'model:\n  provider: ${AGENT_MODEL_PROVIDER}\n  model: ${AGENT_MODEL_NAME}\n'

describe('pi manifest parsing', () => {
  it('resolves the declared native resources through kind dispatch', async () => {
    const dir = await piBundle()
    const result = await verifyBundle<'pi-agent-bundle'>(dir)
    const manifest = result.manifest
    expect(manifest.kind).toBe('pi-agent-bundle')
    expect(manifest.name).toBe('pi')
    expect(manifest.harnessVersion).toBe('>=0.1 <0.2')
    expect(manifest.instructions).toBe(join(dir, 'agent', 'instructions.md'))
    expect(manifest.skills).toBe(join(dir, 'skills'))
    expect(manifest.settings).toBe(join(dir, 'settings.json'))
    expect(manifest.lockfile).toBe(join(dir, 'dependencies.lock'))
    expect(manifest.extensions).toHaveLength(1)
    expect(manifest.extensions[0]).toMatchObject({
      declared: './extensions/pi',
      kind: 'package',
      packageName: '@example/pi',
      packageVersion: '0.1.0',
    })
  })

  it('accepts a bare extension file entry', async () => {
    const dir = await piBundle({
      extensionPath: 'extensions/workspace-tools.ts',
      bundleYaml: DEFAULT_PI_BUNDLE_YAML.replace('./extensions/pi', './extensions/workspace-tools.ts'),
    })
    const manifest = (await verifyBundle<'pi-agent-bundle'>(dir)).manifest
    expect(manifest.extensions[0]).toMatchObject({ declared: './extensions/workspace-tools.ts', kind: 'file' })
  })

  it('rejects a non-pi kind, a wrong harness, resource escapes, and unsupported ranges', async () => {
    const cases: Array<[string, string]> = [
      ['kind: other\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"', 'kind must be'],
      ['kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"', 'harness.name must be "dsh"'],
      ['kind: pi-agent-bundle\nschemaVersion: 2\nname: x\nharness:\n  name: pi\n  version: ">=0.1"', 'schemaVersion must be 1'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: Bad_Name\nharness:\n  name: pi\n  version: ">=0.1"', 'name must match'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: other\n  version: ">=0.1"', 'harness.name must be "pi"'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ""', 'harness.version must be a non-empty'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: "later"\ninstructions: ./agent/instructions.md', 'range is not supported'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ../instructions.md', 'must be a relative path'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ./absent.md', 'points to a missing path'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ./agent/instructions.md', 'skills must be a relative path'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ./agent/instructions.md\nskills: ./skills', 'settings must be a relative path'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ./agent/instructions.md\nskills: ./skills\nsettings: ./settings.json', 'extensions must be a non-empty list'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ./agent/instructions.md\nskills: ./skills\nsettings: ./settings.json\nextensions:\n  - /abs/pkg', 'must be a relative path'],
      ['kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1"\ninstructions: ./agent/instructions.md\nskills: ./skills\nsettings: ./settings.json\nextensions:\n  - 3', 'must be relative strings'],
    ]
    for (const [yaml, message] of cases) {
      const dir = await piBundle({ bundleYaml: yaml })
      await expect(verifyBundle(dir)).rejects.toThrow(message)
    }
  })

  it('requires a loadable extension: package.json, pi.extensions targets, or a built entry', async () => {
    const missingDist = await piBundle({ withDist: false })
    await expect(verifyBundle(missingDist)).rejects.toThrow('"./dist/extension.js" which matches no file')

    const noManifest = await piBundle()
    await rm(join(noManifest, 'extensions', 'pi', 'package.json'))
    await expect(verifyBundle(noManifest)).rejects.toThrow('has no package.json')

    const noEntry = await piBundle()
    await writeFile(join(noEntry, 'extensions', 'pi', 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    await expect(verifyBundle(noEntry)).rejects.toThrow('neither pi.extensions nor an "extensions/" directory')

    const badPiField = await piBundle()
    await writeFile(join(badPiField, 'extensions', 'pi', 'package.json'), JSON.stringify({ name: 'p', pi: { extensions: [] } }))
    await expect(verifyBundle(badPiField)).rejects.toThrow('pi.extensions must be a non-empty array')

    const badJson = await piBundle()
    await writeFile(join(badJson, 'extensions', 'pi', 'package.json'), '{ oops')
    await expect(verifyBundle(badJson)).rejects.toThrow('is not valid JSON')

    const missingExtension = await piBundle({ bundleYaml: DEFAULT_PI_BUNDLE_YAML.replace('./extensions/pi', './extensions/absent') })
    await expect(verifyBundle(missingExtension)).rejects.toThrow('points to a missing path')
  })

  it('rejects an extension import that would not survive install', async () => {
    const missing = await piBundle()
    await writeFile(join(missing, 'extensions', 'pi', 'dist', 'extension.js'), "import './missing.js'\nexport default function () {}\n")
    await expect(verifyBundle(missing)).rejects.toThrow('missing.js')

    const runtimeDep = await piBundle()
    await writeFile(join(runtimeDep, 'extensions', 'pi', 'package.json'), JSON.stringify({
      name: '@example/pi',
      dependencies: { 'left-pad': '1.0.0' },
      pi: { extensions: ['./dist/extension.js'] },
    }))
    await expect(verifyBundle(runtimeDep)).rejects.toThrow('runtime dependencies')

    const peer = await piBundle()
    await writeFile(join(peer, 'extensions', 'pi', 'package.json'), JSON.stringify({
      name: '@example/pi',
      peerDependencies: { '@earendil-works/pi-coding-agent': '*' },
      pi: { extensions: ['./dist/extension.js'] },
    }))
    await writeFile(join(peer, 'extensions', 'pi', 'dist', 'extension.js'), "import { VERSION } from '@earendil-works/pi-coding-agent'\n// from \"not-a-module\"\nexport default function () {}\n")
    await expect(verifyBundle(peer)).resolves.toBeDefined()
  })

  it('rejects a skill Pi will not load', async () => {
    const dir = await piBundle()
    await writeFile(join(dir, 'skills', 'diagnose', 'SKILL.md'), '---\nname: diagnose\n---\n\nNo description.\n')
    await expect(verifyBundle(dir)).rejects.toThrow('no description')
  })

  it('treats dependencies.lock as optional but parses settings strictly', async () => {
    const dir = await piBundle()
    await rm(join(dir, 'dependencies.lock'))
    await writeFile(join(dir, 'bundle.yaml'), DEFAULT_PI_BUNDLE_YAML.replace('\nlockfile: ./dependencies.lock', ''))
    await expect(verifyBundle(dir)).resolves.toBeDefined()

    const badSettings = await piBundle({ settings: '{"defaultProvider": 3}\n' })
    await expect(verifyBundle(badSettings)).rejects.toThrow('defaultProvider must be a string')

    const listSettings = await piBundle({ settings: '[]\n' })
    await expect(verifyBundle(listSettings)).rejects.toThrow('must contain a JSON object')

    const missingSettings = await piBundle()
    await rm(join(missingSettings, 'settings.json'))
    await expect(verifyBundle(missingSettings)).rejects.toThrow('settings.json')
  })
})

describe('pi digest scope', () => {
  it('excludes dist/ build output and the install .venv from the digest', async () => {
    const dir = await piBundle()
    const before = (await verifyBundle(dir)).digest
    await writeFile(join(dir, 'extensions', 'pi', 'dist', 'extension.js'), '// rebuilt output\n')
    await mkdir(join(dir, '.venv', 'Lib'), { recursive: true })
    await writeFile(join(dir, '.venv', 'pyvenv.cfg'), 'home = python\n')
    const after = (await verifyBundle(dir)).digest
    expect(after).toBe(before)

    await writeFile(join(dir, 'agent', 'instructions.md'), 'You are Pi, updated.\n')
    const changed = (await verifyBundle(dir)).digest
    expect(changed).not.toBe(before)
  })

  it('covers build output in the digest when exclusions are not requested', async () => {
    const dir = await piBundle()
    const before = await computeBundleDigest(dir)
    await writeFile(join(dir, 'extensions', 'pi', 'dist', 'extension.js'), '// rebuilt output\n')
    // Default scope (dsh/dify semantics) still sees dist/, so the digest moves.
    expect(await computeBundleDigest(dir)).not.toBe(before)
  })

  it('lists exactly the paths the digest covers, in digest order', async () => {
    const dir = await piBundle()
    const paths = await listBundleDigestPaths(dir, { excludeDirectories: ['dist'] })
    expect(paths).toContain('bundle.yaml')
    expect(paths).toContain('skills/diagnose/SKILL.md')
    expect(paths).toContain('extensions/pi/package.json')
    expect(paths.some(path => path.startsWith('extensions/pi/dist/'))).toBe(false)
    expect(paths.some(path => path.startsWith('extensions/pi/node_modules/'))).toBe(false)
    expect(paths.indexOf('agent/instructions.md')).toBeLessThan(paths.indexOf('bundle.yaml'))
  })

  it('reports the digest through verify and honours --expect-digest', async () => {
    const dir = await piBundle()
    const result = await verifyBundle<'pi-agent-bundle'>(dir)
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    await expect(verifyBundle(dir, { expectDigest: result.digest })).resolves.toBeDefined()
    await expect(verifyBundle(dir, { expectDigest: 'nope' })).rejects.toThrow('must match sha256:<64 hex chars>')
    await writeFile(join(dir, 'agent', 'instructions.md'), 'tampered\n')
    await expect(verifyBundle(dir, { expectDigest: result.digest })).rejects.toThrow('digest mismatch: expected')
  })
})

describe('pi agent config', () => {
  it('parses an optional agent.yaml and resolves ${ENV} placeholders', async () => {
    const withModel = await piBundle({ agentYaml: AGENT_WITH_MODEL })
    expect(await parsePiAgentConfig(withModel)).toEqual({ model: { provider: 'ai-gateway', model: 'glm-5.3-flash' } })
    expect(resolvePiModelSelection({ model: { provider: 'ai-gateway', model: 'glm-5.3-flash' } }, {})).toEqual({ provider: 'ai-gateway', model: 'glm-5.3-flash' })

    const placeholders = await piBundle({ agentYaml: AGENT_WITH_PLACEHOLDERS })
    expect(resolvePiModelSelection((await parsePiAgentConfig(placeholders)), { AGENT_MODEL_PROVIDER: 'ai-gateway', AGENT_MODEL_NAME: 'glm-5.3-flash' }))
      .toEqual({ provider: 'ai-gateway', model: 'glm-5.3-flash' })
    expect(resolvePiModelSelection((await parsePiAgentConfig(placeholders)), { AGENT_MODEL_PROVIDER: 'ai-gateway' })).toBeUndefined()

    const none = await piBundle()
    expect(await parsePiAgentConfig(none)).toEqual({})

    const malformed = await piBundle({ agentYaml: 'model: nope\n' })
    await expect(parsePiAgentConfig(malformed)).rejects.toThrow('model must be an object')

    const partial = await piBundle({ agentYaml: 'model:\n  provider: only\n' })
    await expect(parsePiAgentConfig(partial)).rejects.toThrow('model must be an object')
  })

  it('reads the native settings file with typed model defaults', async () => {
    const dir = await piBundle({ settings: '{"defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4", "quietStartup": true}\n' })
    const settings = await parsePiSettings(join(dir, 'settings.json'))
    expect(settings.defaultProvider).toBe('anthropic')
    expect(settings.defaultModel).toBe('claude-sonnet-4')
    expect(settings.raw['quietStartup']).toBe(true)
    expect(await readPiSettingsIfPresent(join(dir, 'absent.json'))).toBeUndefined()
  })
})

describe('shared bundle-path helpers', () => {
  it('resolves package entry targets with explicit export-condition priority', () => {
    // dsh plugin convention (default cond): what manifest.ts validation relies on.
    const dshLike = { name: 'p', exports: { '.': { default: './lib/index.js' } } }
    expect(packageEntryTarget(dshLike)).toBe('./lib/index.js')
    expect(packageEntryTarget(dshLike, ['import', 'default'])).toBe('./lib/index.js')
    // Pi package convention: ESM `import` cond, and a `default`-only lookup finds nothing.
    const piLike = { name: 'p', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }
    expect(packageEntryTarget(piLike)).toBeUndefined()
    expect(packageEntryTarget(piLike, ['import', 'default'])).toBe('./dist/index.js')
    // `main` wins, string exports win, absolute/escaping targets are ignored.
    expect(packageEntryTarget({ main: 'lib/a.js', exports: { '.': './lib/b.js' } })).toBe('lib/a.js')
    expect(packageEntryTarget({ exports: { '.': './lib/index.js' } })).toBe('./lib/index.js')
    expect(packageEntryTarget({ main: '/abs/index.js' })).toBeUndefined()
    expect(packageEntryTarget({ main: '../outside/index.js' })).toBeUndefined()
    expect(packageEntryTarget({})).toBeUndefined()
    expect(packageEntryTarget({ exports: './not-an-object-with-a-dot-key' })).toBeUndefined()
  })

  it('collapses an extension glob to concrete files and reports an empty match', async () => {
    const packageDir = await makeDir('pi-entries-')
    await writeFiles(packageDir, {
      'dist/extension.js': 'export default () => {}\n',
      'dist/index.js': 'export default () => {}\n',
      'dist/README.md': 'not an entry\n',
    })
    const matches = await expandExtensionEntry('./extensions/pkg', packageDir, './dist/*.js')
    expect(matches.map(path => path.replaceAll('\\', '/').split('/').pop())).toEqual(['extension.js', 'index.js'])
    expect(await expandExtensionEntry('./extensions/pkg', packageDir, './dist/extension.js')).toHaveLength(1)
    expect(await expandExtensionEntry('./extensions/pkg', packageDir, './dist/*.mjs')).toEqual([])
    // Containment still applies to glob roots.
    await expect(expandExtensionEntry('./extensions/pkg', packageDir, '../../*.js')).rejects.toThrow('must be a relative path inside the bundle')
  })
})

describe('harness.version range grammar', () => {
  it('accepts the documented comparator subset', () => {
    for (const range of ['>=0.1 <0.2', '>=0.1.6-alpha.1 <0.2', '^1.2.3', '~1.2', '1.x', '1.2.*', '>=1.0 || <0.5', '0.85.1', '>=0.1']) {
      expect(() => assertVersionRange(range), range).not.toThrow()
    }
  })

  it('rejects unsupported syntax and empty ranges with the offending token', () => {
    expect(() => assertVersionRange('later')).toThrow('range is not supported: "later"')
    expect(() => assertVersionRange('>=0.1 lts')).toThrow('range is not supported: "lts"')
    expect(() => assertVersionRange('*.x')).toThrow('a wildcard needs at least a major version')
    expect(() => assertVersionRange('.x')).toThrow('range is not supported')
    expect(() => assertVersionRange('>=1 .0')).toThrow('range is not supported: ".0"')
    expect(() => assertVersionRange('   ')).toThrow('range is empty')
  })
})

describe('installPiBundle', () => {
  it('materializes instructions, skills, extensions and settings into a Pi config home', async () => {
    const dir = await piBundle({ agentYaml: AGENT_WITH_MODEL, settings: '{"quietStartup": true}\n' })
    const home = await makeDir('pi-home-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const lines: string[] = []
    const result = await installPiBundle({ bundleDir: dir, home, registryPath, log: line => { lines.push(line) } })

    expect(result.reused).toBe(false)
    expect(result.digest).toMatch(/^sha256:/)
    expect(result.codingAgentDir).toBe(join(home, 'agent'))
    expect(result.profile).toBe('pi')
    expect(result.launchCommand).toBe('pi "<task>"')
    expect(result.launchEnv).toEqual({ PI_CODING_AGENT_DIR: join(home, 'agent') })
    expect(result.extensions).toEqual(['./extensions/pi'])
    expect(result.plugins).toEqual([])

    expect(await readFile(join(home, 'agent', 'AGENTS.md'), 'utf8')).toContain('Pi')
    expect((await stat(join(home, 'agent', 'skills', 'diagnose', 'SKILL.md'))).isFile()).toBe(true)
    expect((await stat(join(home, 'agent', 'skills', 'verify', 'SKILL.md'))).isFile()).toBe(true)
    expect((await stat(join(home, 'agent', 'extensions', 'pi', 'dist', 'extension.js'))).isFile()).toBe(true)
    expect((await stat(join(home, 'agent', 'extensions', 'pi', 'src', 'index.js'))).isFile()).toBe(true)

    const settings = JSON.parse(await readFile(join(home, 'agent', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['quietStartup']).toBe(true)
    expect(settings['defaultProvider']).toBe('ai-gateway')
    expect(settings['defaultModel']).toBe('glm-5.3-flash')
    expect(settings['skills']).toEqual(['skills'])
    expect(settings['extensions']).toEqual([join(home, 'agent', 'extensions', 'pi').replaceAll('\\', '/')])

    const stamp = JSON.parse(await readFile(join(home, 'agent', '.pi-bundle-install.json'), 'utf8')) as { digest: string; bundleDir: string }
    expect(stamp.digest).toBe(result.digest)
    expect(stamp.bundleDir).toBe(dir)

    const records = await loadRegistry(registryPath)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: `pi-${result.digest.slice(7, 15)}`,
      kind: 'pi-agent-bundle',
      home,
      profile: 'pi',
      mode: 'ephemeral',
      harnessVersion: '>=0.1 <0.2',
      piConfigDir: join(home, 'agent'),
    })
    expect(lines.some(line => line.includes('materializing pi home'))).toBe(true)
  })

  it('resolves agent.yaml model placeholders from the install environment', async () => {
    const dir = await piBundle({ agentYaml: AGENT_WITH_PLACEHOLDERS })
    const home = await makeDir('pi-home-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    await installPiBundle({
      bundleDir: dir, home, registryPath,
      env: { AGENT_MODEL_PROVIDER: 'ai-gateway', AGENT_MODEL_NAME: 'glm-5.3-flash' },
    })
    const settings = JSON.parse(await readFile(join(home, 'agent', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['defaultProvider']).toBe('ai-gateway')
    expect(settings['defaultModel']).toBe('glm-5.3-flash')

    const unresolvedHome = await makeDir('pi-home-')
    const warnings: string[] = []
    await installPiBundle({
      bundleDir: dir, home: unresolvedHome, registryPath,
      env: {},
      log: line => { warnings.push(line) },
    })
    const unresolved = JSON.parse(await readFile(join(unresolvedHome, 'agent', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(unresolved['defaultProvider']).toBeUndefined()
    expect(warnings.some(line => line.includes('placeholders could not be resolved'))).toBe(true)
  })

  it('reuses a home whose stamp matches and rebuilds when it is gone or stale', async () => {
    const dir = await piBundle()
    const home = await makeDir('pi-home-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const first = await installPiBundle({ bundleDir: dir, home, registryPath })
    const second = await installPiBundle({
      bundleDir: dir, home, registryPath,
      log: line => {
        if (line.includes('warning:')) return
        expect(line).toContain('reusing installation')
      },
    })
    expect(second.reused).toBe(true)
    expect(second.digest).toBe(first.digest)
    expect(await loadRegistry(registryPath)).toHaveLength(1)

    // A stale stamp (different digest) rebuilds the home from scratch.
    await writeFile(join(home, 'agent', 'AGENTS.md'), 'stale\n')
    await writeFile(join(home, 'agent', '.pi-bundle-install.json'), `${JSON.stringify({ digest: 'sha256:0000' })}\n`)
    const rebuilt = await installPiBundle({ bundleDir: dir, home, registryPath })
    expect(rebuilt.reused).toBe(false)
    expect(await readFile(join(home, 'agent', 'AGENTS.md'), 'utf8')).not.toBe('stale\n')

    await writeFile(join(home, 'agent', 'AGENTS.md'), 'leftover-link\n')
    const forced = await installPiBundle({ bundleDir: dir, home, registryPath, force: true })
    expect(forced.reused).toBe(false)
    expect(await readFile(join(home, 'agent', 'AGENTS.md'), 'utf8')).not.toBe('leftover-link\n')
  })

  it('copies every declared extension entry into the staged package', async () => {
    const dir = await piBundle()
    await writeFile(join(dir, 'extensions', 'pi', 'package.json'), JSON.stringify({
      name: '@example/pi',
      pi: { extensions: ['./dist/extension.js', './dist/*.js'] },
    }))
    const home = await makeDir('pi-home-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const result = await installPiBundle({ bundleDir: dir, home, registryPath })
    expect(result.reused).toBe(false)
    for (const entry of ['extension.js', 'index.js']) {
      expect((await stat(join(home, 'agent', 'extensions', 'pi', 'dist', entry))).isFile()).toBe(true)
    }
  })

  it('rejects a glob entry that matches no built file', async () => {
    const dir = await piBundle()
    await writeFile(join(dir, 'extensions', 'pi', 'package.json'), JSON.stringify({
      name: '@example/pi',
      pi: { extensions: ['./dist/*.mjs'] },
    }))
    await expect(verifyBundle(dir)).rejects.toThrow('matches no file')
  })

  it('materializes a skill file entry as <name>/SKILL.md', async () => {
    const dir = await piBundle({
      bundleYaml: DEFAULT_PI_BUNDLE_YAML.replace('skills: ./skills', 'skills: ./skills/diagnose/SKILL.md'),
    })
    const home = await makeDir('pi-home-')
    await installPiBundle({ bundleDir: dir, home, registryPath: join(await makeDir('pi-registry-'), 'installations.json') })
    expect((await stat(join(home, 'agent', 'skills', 'diagnose', 'SKILL.md'))).isFile()).toBe(true)
  })

  it('skips node_modules when staging extension packages', async () => {
    const dir = await piBundle()
    await writeFiles(dir, { 'extensions/pi/node_modules/left-pad/index.js': 'module.exports = 1\n' })
    const home = await makeDir('pi-home-')
    await installPiBundle({ bundleDir: dir, home, registryPath: join(await makeDir('pi-registry-'), 'installations.json') })
    await expect(stat(join(home, 'agent', 'extensions', 'pi', 'node_modules'))).rejects.toThrow()
  })

  it('uninstalls through the registry and removes the ephemeral home', async () => {
    const dir = await piBundle()
    const home = await makeDir('pi-home-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const result = await installPiBundle({ bundleDir: dir, home, registryPath })
    const id = `pi-${result.digest.slice(7, 15)}`
    const removed = await dispatchUninstall({ id, registryPath })
    expect(removed.removed).toBe(true)
    expect(removed.homeExisted).toBe(true)
    await expect(stat(home)).rejects.toThrow()
    expect(await loadRegistry(registryPath)).toEqual([])
  })

  it('installs natively into PI_CODING_AGENT_DIR and restores only the paths it added', async () => {
    const dir = await piBundle({ agentYaml: AGENT_WITH_MODEL })
    await writeFiles(dir, { 'extensions/pi/node_modules/left-pad/index.js': 'module.exports = 1\n' })
    const home = await makeDir('pi-native-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const originalSettings = {
      extensions: ['extensions/mine'],
      skills: ['skills'],
      defaultProvider: 'keep-me',
      defaultModel: 'keep-model',
      quietStartup: true,
    }
    await writeFile(join(home, 'settings.json'), `${JSON.stringify(originalSettings)}\n`)
    await writeFile(join(home, 'auth.json'), '{"token":"host"}\n')
    const env = { PI_CODING_AGENT_DIR: home, PATH: '' }

    const result = await installPiBundle({ bundleDir: dir, registryPath, mode: 'native', env })
    const subtree = join(home, 'agent-bundle', 'bundle-pi')
    expect(result.reused).toBe(false)
    expect(result.profile).toBe('bundle-pi')
    expect(result.home).toBe(home)
    expect(result.launchCommand).toBe('pi --print "<task>"')
    expect(result.launchEnv).toEqual({})
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"token":"host"}\n')
    await expect(stat(join(home, 'AGENTS.md'))).rejects.toThrow()
    expect((await stat(join(dir, 'agent', 'instructions.md'))).isFile()).toBe(true)
    expect((await stat(join(subtree, '.pi-bundle-install.json'))).isFile()).toBe(true)
    await expect(stat(join(subtree, 'extensions'))).rejects.toThrow()

    const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['extensions']).toEqual([
      'extensions/mine',
      join(dir, 'extensions', 'pi'),
    ])
    expect(settings['skills']).toEqual(['skills', join(dir, 'skills')])
    expect(settings['defaultProvider']).toBe('ai-gateway')
    expect(settings['defaultModel']).toBe('glm-5.3-flash')
    expect(settings['quietStartup']).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toMatchObject({
      office: { enabled: true, readOnly: false },
    })
    expect((await loadRegistry(registryPath))[0]).toMatchObject({ mode: 'native', home, profile: 'bundle-pi' })

    const again = await installPiBundle({ bundleDir: dir, registryPath, mode: 'native', env })
    expect(again.reused).toBe(true)
    const reusedSettings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as { extensions: string[] }
    expect(reusedSettings.extensions).toEqual(settings['extensions'])

    const id = `pi-${result.digest.slice(7, 15)}`
    const loaded = await dispatchLoad({ id, registryPath, env })
    expect(loaded.launchCommand).toBe('pi --print "<task>"')
    expect(loaded.launchEnv).toEqual({})
    await loaded.cleanup()
    expect((await stat(home)).isDirectory()).toBe(true)
    expect(await loadRegistry(registryPath)).toHaveLength(1)

    const removed = await dispatchUninstall({ id, registryPath })
    expect(removed.profileRemoved).toBe('bundle-pi')
    expect(removed.homeKept).toBe(home)
    await expect(stat(subtree)).rejects.toThrow()
    expect((await stat(home)).isDirectory()).toBe(true)
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"token":"host"}\n')
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toEqual(originalSettings)
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{}\n')
    expect(await loadRegistry(registryPath)).toEqual([])
  })

  it('does not add a second extension path when the source package is already registered', async () => {
    const dir = await piBundle()
    const home = await makeDir('pi-native-')
    const extension = join(dir, 'extensions', 'pi')
    await writeFile(join(home, 'settings.json'), `${JSON.stringify({ packages: [extension], extensions: ['extensions/mine'] })}\n`)
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    await installPiBundle({
      bundleDir: dir,
      registryPath,
      mode: 'native',
      env: { PI_CODING_AGENT_DIR: home, PATH: '' },
    })
    const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as {
      packages: string[]
      extensions: string[]
      skills: string[]
    }
    expect(settings.packages).toEqual([extension])
    expect(settings.extensions).toEqual(['extensions/mine'])
    expect(settings.skills).toEqual([join(dir, 'skills')])
    await expect(stat(join(home, 'agent-bundle', 'bundle-pi', 'extensions'))).rejects.toThrow()
  })

  it('refuses a native subtree that is missing a stamp or carries a different one', async () => {
    const dir = await piBundle()
    const home = await makeDir('pi-native-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const subtree = join(home, 'agent-bundle', 'bundle-pi')
    await mkdir(subtree, { recursive: true })
    await writeFile(join(subtree, 'keep.txt'), 'keep\n')
    await writeFile(join(home, 'settings.json'), '{"extensions":["extensions/mine"]}\n')
    const env = { PI_CODING_AGENT_DIR: home, PATH: '' }

    await expect(installPiBundle({ bundleDir: dir, registryPath, mode: 'native', env })).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' })
    expect(await readFile(join(subtree, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(await readFile(join(home, 'settings.json'), 'utf8')).toBe('{"extensions":["extensions/mine"]}\n')

    await writeFile(join(subtree, '.pi-bundle-install.json'), `${JSON.stringify({ digest: 'sha256:0000', adapterVersion: '0.0.0' })}\n`)
    await expect(installPiBundle({ bundleDir: dir, registryPath, mode: 'native', env })).rejects.toBeInstanceOf(BundleError)
    expect(await readFile(join(home, 'settings.json'), 'utf8')).toBe('{"extensions":["extensions/mine"]}\n')
  })

  it('rolls back a native install when a required python package fails', async () => {
    const dir = await piBundle()
    await writeFile(join(dir, 'dependencies.lock'), `${JSON.stringify({
      host: { name: '@earendil-works/pi-coding-agent', version: '0.85.1' },
      python: { packages: [{ package: 'openpyxl', kind: 'required', pin: '3.1.5' }] },
    })}\n`)
    const home = await makeDir('pi-native-')
    const bin = await makeDir('uv-bin-')
    const uv = join(bin, process.platform === 'win32' ? 'uv.exe' : 'uv')
    await writeFile(uv, '')
    await writeFile(join(home, 'settings.json'), '{"quietStartup":true}\n')
    const subtree = join(home, 'agent-bundle', 'bundle-pi')

    const calls: string[][] = []
    await expect(installPiBundle({
      bundleDir: dir,
      registryPath: join(await makeDir('pi-registry-'), 'installations.json'),
      mode: 'native',
      env: { PI_CODING_AGENT_DIR: home, UV_BIN: uv, PATH: '' },
      runPython: async (command, args) => {
        calls.push([command, ...args])
        if (args.includes('pip')) throw new Error('pip boom')
      },
    })).rejects.toThrow('pip boom')
    expect(calls.some(call => call[0] === uv && call.includes('--seed'))).toBe(true)
    expect(calls.some(call => call[0] === uv && call.includes('pip'))).toBe(false)
    const interpreter = join(dir, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
    expect(calls).toContainEqual([interpreter, '-m', 'pip', 'install', 'openpyxl==3.1.5'])
    await expect(stat(subtree)).rejects.toThrow()
    await expect(stat(join(dir, '.venv'))).rejects.toThrow()
    expect((await stat(join(dir, 'agent', 'instructions.md'))).isFile()).toBe(true)
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{}\n')
    expect(await readFile(join(home, 'settings.json'), 'utf8')).toBe('{"quietStartup":true}\n')
  })

  it('keeps an explicit home on the owned install path even when mode is native', async () => {
    const dir = await piBundle()
    const home = await makeDir('pi-home-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const result = await installPiBundle({ bundleDir: dir, home, registryPath, mode: 'native' })
    expect(result.launchCommand).toBe('pi "<task>"')
    expect(result.launchEnv).toEqual({ PI_CODING_AGENT_DIR: join(home, 'agent') })
    expect((await loadRegistry(registryPath))[0]?.mode).toBe('ephemeral')
    expect((await stat(join(home, 'agent', 'AGENTS.md'))).isFile()).toBe(true)
  })

  it('refuses to uninstall an active native installation without force', async () => {
    const dir = await piBundle()
    const home = await makeDir('pi-native-')
    const registryPath = join(await makeDir('pi-registry-'), 'installations.json')
    const result = await installPiBundle({
      bundleDir: dir, registryPath, mode: 'native', env: { PI_CODING_AGENT_DIR: home, PATH: '' },
    })
    const records = await loadRegistry(registryPath)
    const current = records[0]
    if (current === undefined) throw new Error('expected a native installation record')
    await saveRegistry(registryPath, [{ ...current, status: 'active' }])
    const id = `pi-${result.digest.slice(7, 15)}`
    await expect(dispatchUninstall({ id, registryPath })).rejects.toThrow('active installation')
    expect((await stat(join(home, 'agent-bundle', 'bundle-pi'))).isDirectory()).toBe(true)
  })
})

describe('resolvePiCommand', () => {
  async function fakeBin(name: string): Promise<string> {
    const dir = await makeDir('pi-bin-')
    const file = join(dir, name)
    await writeFile(file, '#!/usr/bin/env node\n')
    return file
  }

  it('prefers PI_BIN and runs a .js entry with node', async () => {
    const entry = await fakeBin('pi-cli.js')
    const command = await resolvePiCommand({ PI_BIN: entry })
    expect(command.source).toBe('PI_BIN')
    expect(command.args).toEqual([entry])
    await expect(resolvePiCommand({ PI_BIN: join(tmpdir(), 'absent-pi.js') })).rejects.toThrow('points to a missing file')
  })

  it('falls back to PI_CHECKOUT build output, then PATH', async () => {
    const checkout = await makeDir('pi-checkout-')
    await writeFiles(checkout, { 'dist/bundle/cli.js': 'export {}\n' })
    const fromCheckout = await resolvePiCommand({ PI_CHECKOUT: checkout })
    expect(fromCheckout.source).toBe('PI_CHECKOUT')
    expect(fromCheckout.args).toEqual([join(checkout, 'dist', 'bundle', 'cli.js')])

    const emptyCheckout = await makeDir('pi-checkout-')
    await expect(resolvePiCommand({ PI_CHECKOUT: emptyCheckout })).rejects.toThrow('has no built CLI')

    const binDir = await makeDir('pi-path-')
    const candidate = join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await writeFile(candidate, '@echo off\n')
    const fromPath = await resolvePiCommand({ PATH: [binDir, process.env['PATH'] ?? ''].join(delimiter) })
    expect(fromPath.source).toBe('PATH')
    // A Windows shim is rewritten to the real Node entry so hosts can spawn it.
    if (process.platform === 'win32') {
      const entry = join(binDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
      await writeFiles(binDir, { 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js': 'export {}\n' })
      const rewritten = await resolvePiCommand({ PATH: binDir })
      expect(rewritten.command).toBe(process.execPath)
      expect(rewritten.args).toEqual([entry])
    } else {
      expect(fromPath.command).toBe(candidate)
    }

    await expect(resolvePiCommand({ PATH: tmpdir() })).rejects.toThrow('cannot resolve the pi CLI')
  })
})
