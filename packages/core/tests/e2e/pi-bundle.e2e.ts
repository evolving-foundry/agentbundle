import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolvePiCommand, type PiCommand } from 'agent-bundle-core'

const cliBin = fileURLToPath(new URL('../../../cli/dist/bin.mjs', import.meta.url))
const piRepo = process.env['AGENT_BUNDLE_PI_REPO'] ?? join(homedir(), 'Pi')
const bundleDir = join(piRepo, 'bundles', 'pi')
const baseEnv: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
const piCommand: PiCommand | undefined = await resolvePiCommand(baseEnv).catch(() => undefined)

interface ProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function runProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<ProcessResult> {
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

function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<ProcessResult> {
  return runProcess(process.execPath, [cliBin, ...args], { ...baseEnv, ...extraEnv })
}

function runPi(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}, cwd?: string): Promise<ProcessResult> {
  if (piCommand === undefined) throw new Error('pi command unavailable')
  return runProcess(piCommand.command, [...piCommand.args, ...args], { ...baseEnv, ...piCommand.extraEnv, ...extraEnv }, cwd)
}

/** Drive the Pi RPC protocol far enough to prove the extension and skills loaded. */
async function piRpc(agentDir: string, requests: readonly string[]): Promise<{ code: number; events: Record<string, unknown>[]; stderr: string }> {
  if (piCommand === undefined) throw new Error('pi command unavailable')
  const env = { ...baseEnv, ...piCommand.extraEnv, PI_CODING_AGENT_DIR: agentDir }
  const child = spawn(piCommand.command, [...piCommand.args, '--offline', '--no-session', '--no-approve', '--mode', 'rpc'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events: Record<string, unknown>[] = []
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  let buffer = ''
  const done = new Promise<void>((resolveDone, rejectDone) => {
    const timer = setTimeout(() => rejectDone(new Error(`pi RPC timed out: ${stderr}`)), 60_000)
    child.on('error', rejectDone)
    child.on('close', () => { clearTimeout(timer); resolveDone() })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') events.push(JSON.parse(line) as Record<string, unknown>)
        index = buffer.indexOf('\n')
      }
    })
  })
  child.stdin.write(`${requests.join('\n')}\n`)
  child.stdin.end()
  const code = await new Promise<number>(resolveCode => child.on('close', value => resolveCode(value ?? -1)))
  await done
  return { code, events, stderr }
}

describe.skipIf(piCommand === undefined || !existsSync(bundleDir))('agent-bundle pi e2e (real pi + real Pi bundle)', () => {
  let scratch = ''
  let registryPath = ''
  let home = ''
  let installedId = ''
  let digest = ''
  let agentDir = ''

  beforeAll(async () => {
    if (!existsSync(cliBin)) {
      throw new Error(`CLI binary missing at ${cliBin}; run "pnpm build" first`)
    }
    if (!existsSync(bundleDir)) {
      throw new Error(`real pi bundle missing at ${bundleDir}; set AGENT_BUNDLE_PI_REPO`)
    }
    scratch = await mkdtemp(join(tmpdir(), 'agent-bundle-pi-e2e-'))
    registryPath = join(scratch, 'installations.json')
    home = join(scratch, 'home-pi')
    agentDir = join(home, 'agent')
  })

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  const regEnv = (): NodeJS.ProcessEnv => ({ AGENT_BUNDLE_REGISTRY: registryPath })

  it('verifies the real bundle in text and json modes', async () => {
    const text = await runCli(['verify', bundleDir])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('name: pi')
    expect(text.stdout).toContain('kind: pi-agent-bundle')
    expect(text.stdout).toContain('extensions: ./extensions/office-pi')
    const digestLine = text.stdout.split('\n').find(line => line.startsWith('digest: '))
    expect(digestLine).toMatch(/^digest: sha256:[0-9a-f]{64}$/)
    digest = digestLine!.slice('digest: '.length).trim()

    const json = await runCli(['--json', 'verify', bundleDir])
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.stdout) as { name: string; kind: string; schemaVersion: number; extensions: string; digest: string; skills: string }
    expect(parsed.name).toBe('pi')
    expect(parsed.kind).toBe('pi-agent-bundle')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.extensions).toBe('./extensions/office-pi')
    expect(parsed.skills).toContain('skills')
    expect(parsed.digest).toBe(digest)
  })

  it('rejects tampered copies with precise causes', async () => {
    const copy = join(scratch, 'tampered')
    await cp(bundleDir, copy, { recursive: true })

    const pristine = await runCli(['verify', copy, '--expect-digest', digest])
    expect(pristine.code).toBe(0)

    // Build output is excluded from the digest by design.
    await writeFile(join(copy, 'extensions', 'office-pi', 'dist', 'extension.js'), '// rebuilt\n')
    const stillPristine = await runCli(['verify', copy, '--expect-digest', digest])
    expect(stillPristine.code).toBe(0)

    await writeFile(join(copy, 'agent', 'instructions.md'), `${await readFile(join(copy, 'agent', 'instructions.md'), 'utf8')}# one more line\n`)
    const flipped = await runCli(['verify', copy, '--expect-digest', digest])
    expect(flipped.code).toBe(1)
    expect(flipped.stderr).toContain('digest mismatch: expected')

    if (process.platform !== 'win32') {
      await symlink('/etc/hostname', join(copy, 'alias'))
      const linked = await runCli(['verify', copy])
      expect(linked.code).toBe(1)
      expect(linked.stderr).toContain('symbolic link')
      await rm(join(copy, 'alias'))
    }

    await writeFile(join(copy, 'bundle.yaml'), 'kind: other-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1 <0.2"\n')
    const badKind = await runCli(['verify', copy])
    expect(badKind.code).toBe(1)
    expect(badKind.stderr).toContain('kind must be')
    expect(badKind.stderr).toContain('got "other-agent-bundle"')

    await writeFile(join(copy, 'bundle.yaml'), 'kind: pi-agent-bundle\nschemaVersion: 1\nname: x\nharness:\n  name: pi\n  version: ">=0.1 <0.2"\ninstructions: ./agent/instructions.md\nskills: ./skills\nsettings: ./settings.json\nextensions:\n  - ./extensions/office-pi\n')
    await rm(join(copy, 'settings.json'))
    const noSettings = await runCli(['verify', copy])
    expect(noSettings.code).toBe(1)
    expect(noSettings.stderr).toContain('settings.json')
  })

  it('installs into an ephemeral Pi config home and reuses it on repeat', async () => {
    const first = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(first.code).toBe(0)
    const parsed = JSON.parse(first.stdout) as Record<string, unknown>
    expect(parsed['reused']).toBe(false)
    expect(parsed['digest']).toBe(digest)
    expect(parsed['home']).toBe(home)
    expect(parsed['coding-agent-dir']).toBe(agentDir)
    expect(parsed['extensions']).toBe('./extensions/office-pi')
    expect(parsed['launch']).toBe('pi "<task>"')
    installedId = `pi-${digest.slice(7, 15)}`

    expect(await readFile(join(agentDir, 'AGENTS.md'), 'utf8')).toContain('Pi')

    const second = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(second.code).toBe(0)
    expect((JSON.parse(second.stdout) as { reused: boolean }).reused).toBe(true)

    const records = JSON.parse(await readFile(registryPath, 'utf8')) as Array<Record<string, unknown>>
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: installedId, kind: 'pi-agent-bundle', home, piConfigDir: agentDir })
  })

  it('writes adapter-owned settings and keeps the bundle settings inert', async () => {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['skills']).toEqual(['skills'])
    expect(settings['extensions']).toEqual([join(agentDir, 'extensions', 'office-pi').replaceAll('\\', '/')])
    // The shipped bundle settings are empty by design: behaviour stays opt-in.
    expect(settings['office']).toBeUndefined()
    expect(existsSync(join(agentDir, 'skills', 'office-xlsx', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agentDir, 'extensions', 'office-pi', 'dist', 'extension.js'))).toBe(true)
  })

  it('loads the materialized extension through native pi without touching the user config', async () => {
    const rpc = await piRpc(agentDir, [
      JSON.stringify({ id: 'commands', type: 'get_commands' }),
    ])
    expect(rpc.code).toBe(0)
    const response = rpc.events.find(event => event['type'] === 'response' && event['id'] === 'commands')
    expect(response?.['success']).toBe(true)
    const commands = (response?.['data'] as { commands?: Array<{ name: string }> } | undefined)?.commands ?? []
    expect(commands.map(command => command.name)).toContain('example-status')
    // Skills from the bundle are discoverable as slash commands in the same run.
    expect(commands.map(command => command.name)).toContain('skill:office-xlsx')
    expect(JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8').catch(() => '""'))).not.toContain(agentDir)
  })

  it('reports the pi runtime used for the launch hint', async () => {
    const install = await runCli(['install', bundleDir, '--home', home], regEnv())
    expect(install.code).toBe(0)
    expect(install.stderr).toContain('using pi from')
  })
  it('uninstalls and cleanly reinstalls', async () => {
    const removed = await runCli(['--json', 'uninstall', '--id', installedId], regEnv())
    expect(removed.code).toBe(0)
    const parsed = JSON.parse(removed.stdout) as Record<string, unknown>
    expect(parsed['removed']).toBe(installedId)
    expect(parsed['home-existed']).toBe(true)
    expect(existsSync(home)).toBe(false)
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual([])

    const reinstalled = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(reinstalled.code).toBe(0)
    expect((JSON.parse(reinstalled.stdout) as { reused: boolean }).reused).toBe(false)
    expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true)
  })
})
