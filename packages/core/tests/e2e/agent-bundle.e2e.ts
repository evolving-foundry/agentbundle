import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveDshCommand, type DshCommand } from 'agent-bundle-core'

const cliBin = new URL('../../../cli/dist/bin.mjs', import.meta.url).pathname
const dshRepo = process.env['AGENT_BUNDLE_DSH_REPO'] ?? join(homedir(), 'Example-DSH')
const bundleDir = join(dshRepo, 'bundles', 'office-agent')
const patchFixture = join(dshRepo, 'tests', 'fixtures', 'office-e2e.patch.yml')
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...(process.env['DSH_BIN'] === undefined && process.env['DSH_CHECKOUT'] === undefined
    ? { DSH_CHECKOUT: join(homedir(), 'deepseek-harness') }
    : {}),
}
const dshCommand: DshCommand | undefined = await resolveDshCommand(baseEnv).catch(() => undefined)

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function runProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<CliResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', code => resolveRun({ code: code ?? -1, stdout, stderr }))
  })
}

function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return runProcess(process.execPath, [cliBin, ...args], { ...baseEnv, ...extraEnv })
}

function runDsh(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}, cwd?: string): Promise<CliResult> {
  if (dshCommand === undefined) throw new Error('dsh command unavailable')
  return runProcess(dshCommand.command, [...dshCommand.args, ...args], { ...baseEnv, ...dshCommand.extraEnv, ...extraEnv }, cwd)
}

describe.skipIf(dshCommand === undefined)('agent-bundle e2e (real dsh + real bundle)', () => {
  let scratch = ''
  let registryPath = ''
  let home = ''
  let installedId = ''
  let digest = ''

  beforeAll(async () => {
    if (!existsSync(cliBin)) {
      throw new Error(`CLI binary missing at ${cliBin}; run "pnpm build" first`)
    }
    if (!existsSync(bundleDir)) {
      throw new Error(`real bundle missing at ${bundleDir}; set AGENT_BUNDLE_DSH_REPO`)
    }
    scratch = await mkdtemp(join(tmpdir(), 'agent-bundle-e2e-'))
    registryPath = join(scratch, 'installations.json')
    home = join(scratch, 'home-qr')
  })

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  const regEnv = (): NodeJS.ProcessEnv => ({ AGENT_BUNDLE_REGISTRY: registryPath })

  it('verifies the real bundle in text and json modes', async () => {
    const text = await runCli(['verify', bundleDir])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('name: office-agent')
    expect(text.stdout).toContain('kind: dsh-agent-bundle')
    const digestLine = text.stdout.split('\n').find(line => line.startsWith('digest: '))
    expect(digestLine).toMatch(/^digest: sha256:[0-9a-f]{64}$/)
    digest = digestLine!.slice('digest: '.length).trim()

    const json = await runCli(['--json', 'verify', bundleDir])
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.stdout) as { name: string; kind: string; schemaVersion: number; plugins: string; digest: string }
    expect(parsed.name).toBe('office-agent')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.plugins.split(', ')).toEqual(['./plugins/office-base', './plugins/office-quarterly-report'])
    expect(parsed.digest).toBe(digest)
  })

  it('rejects tampered copies with precise causes', async () => {
    const copy = join(scratch, 'tampered')
    await cp(bundleDir, copy, { recursive: true })

    const pristine = await runCli(['verify', copy, '--expect-digest', digest])
    expect(pristine.code).toBe(0)

    await writeFile(join(copy, 'agent.yaml'), (await readFile(join(copy, 'agent.yaml'), 'utf8')) + '# one byte more\n')
    const flipped = await runCli(['verify', copy, '--expect-digest', digest])
    expect(flipped.code).toBe(1)
    expect(flipped.stderr).toContain('digest mismatch: expected')
    expect(flipped.stderr).toContain(digest)

    await symlink('/etc/hostname', join(copy, 'alias'))
    const linked = await runCli(['verify', copy])
    expect(linked.code).toBe(1)
    expect(linked.stderr).toContain('symbolic link')

    await rm(join(copy, 'alias'))
    await writeFile(join(copy, 'bundle.yaml'), 'kind: other\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ./plugins/office-base\n')
    const badKind = await runCli(['verify', copy])
    expect(badKind.code).toBe(1)
    expect(badKind.stderr).toContain('kind must be')

    await writeFile(join(copy, 'bundle.yaml'), 'kind: dsh-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: dsh\n  version: ">=0.1"\nplugins:\n  - path: ./plugins/office-base\n')
    await rm(join(copy, 'agent.yaml'))
    const noAgent = await runCli(['verify', copy])
    expect(noAgent.code).toBe(1)
    expect(noAgent.stderr).toContain('agent file is missing')
  })

  it('installs into an ephemeral home, writes settings, and reuses on repeat', async () => {
    const first = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(first.code).toBe(0)
    const parsed = JSON.parse(first.stdout) as { digest: string; home: string; profile: string; reused: boolean; plugins: string; launch: string }
    expect(parsed.reused).toBe(false)
    expect(parsed.digest).toBe(digest)
    expect(parsed.home).toBe(home)
    expect(parsed.profile).toBe('bundle-office-agent')
    expect(parsed.plugins.split(', ')).toEqual(['./plugins/office-base', './plugins/office-quarterly-report'])
    expect(parsed.launch).toBe('dsh --profile bundle-office-agent "<task>"')
    installedId = `office-agent-${digest.slice(7, 15)}`

    const settings = await readFile(join(home, 'settings.yaml'), 'utf8').catch(() => undefined)
    expect(settings).toBeUndefined()

    const second = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(second.code).toBe(0)
    expect((JSON.parse(second.stdout) as { reused: boolean }).reused).toBe(true)
  })

  it('exposes both plugins in the composed profile', async () => {
    const dump = await runDsh(['--profile', 'bundle-office-agent', '--dump-config'], { DSH_HOME: home })
    expect(dump.stdout).toContain('# == @example/dsh-office-base')
    expect(dump.stdout).toContain('- id: office-base')
    expect(dump.stdout).toContain('- id: synthesized-process')
    expect(dump.stdout).toContain("name: '@sop-compiler/dsh-synthesized-process/cordis-host'")
  })

  it('runs a keyless mock-model task to completion through the launch command', async () => {
    await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: office-mock\n  model: office-mock\n')
    const run = await runDsh(
      ['--profile', 'bundle-office-agent', '--patch', patchFixture, '--json', 'Execute the SOP entry step.'],
      { DSH_HOME: home },
      scratch,
    )
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('"tool":"synthesized_process"')
    expect(run.stdout).toContain('"type":"final"')
    expect(run.stdout).toContain('OFFICE_E2E_MOCK_FINAL')
  })

  it('uninstalls and cleanly reinstalls', async () => {
    const removed = await runCli(['--json', 'uninstall', '--id', installedId], regEnv())
    expect(removed.code).toBe(0)
    const parsed = JSON.parse(removed.stdout) as { removed: string; 'home-existed': boolean }
    expect(parsed.removed).toBe(installedId)
    expect(parsed['home-existed']).toBe(true)
    expect(existsSync(home)).toBe(false)
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual([])

    const reinstalled = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(reinstalled.code).toBe(0)
    expect((JSON.parse(reinstalled.stdout) as { reused: boolean }).reused).toBe(false)
    const reinstalledSettings = await readFile(join(home, 'settings.yaml'), 'utf8').catch(() => undefined)
    expect(reinstalledSettings === undefined || !reinstalledSettings.includes('agent-default-model')).toBe(true)
  })

  it('installs natively into the harness default home and uninstalls profile-only', async () => {
    const nativeHome = join(scratch, 'native-home')
    const nativeEnv = (): NodeJS.ProcessEnv => ({ ...regEnv(), DSH_HOME: nativeHome })

    const first = await runCli(['--json', 'install', bundleDir], nativeEnv())
    expect(first.code).toBe(0)
    const parsed = JSON.parse(first.stdout) as { home: string; profile: string; reused: boolean; launch: string; 'launch-env'?: string }
    expect(parsed.home).toBe(nativeHome)
    expect(parsed.profile).toBe('bundle-office-agent')
    expect(parsed['launch-env']).toBeUndefined()
    expect(parsed.launch).toBe('dsh --profile bundle-office-agent "<task>"')

    const record = (JSON.parse(await readFile(registryPath, 'utf8')) as Array<{ home: string; mode: string }>)[0]
    expect(record?.home).toBe(nativeHome)
    expect(record?.mode).toBe('native')

    const second = await runCli(['--json', 'install', bundleDir], nativeEnv())
    expect(second.code).toBe(0)
    expect((JSON.parse(second.stdout) as { reused: boolean }).reused).toBe(true)

    const dump = await runDsh(['--profile', 'bundle-office-agent', '--dump-config'], { DSH_HOME: nativeHome })
    expect(dump.stdout).toContain('# == @example/dsh-office-base')
    expect(dump.stdout).toContain('- id: synthesized-process')

    // Simulate the host's own config living in the native home; uninstall must keep it.
    await writeFile(join(nativeHome, 'settings.yaml'), 'keep: true\n')
    await writeFile(join(nativeHome, '.env'), 'KEY=1\n')
    const removed = await runCli(['--json', 'uninstall', '--id', installedId], regEnv())
    expect(removed.code).toBe(0)
    const removedParsed = JSON.parse(removed.stdout) as { removed: string; 'profile-removed': string; 'home-kept': string }
    expect(removedParsed['profile-removed']).toBe('bundle-office-agent')
    expect(removedParsed['home-kept']).toBe(nativeHome)
    expect(await readFile(join(nativeHome, 'settings.yaml'), 'utf8')).toBe('keep: true\n')
    expect(await readFile(join(nativeHome, '.env'), 'utf8')).toBe('KEY=1\n')
    expect(existsSync(join(nativeHome, 'profiles', 'bundle-office-agent'))).toBe(false)
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual([])
  })
})
