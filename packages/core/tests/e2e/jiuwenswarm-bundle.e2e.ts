import { spawn, type ChildProcessWithoutNullStreams, type StdioOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveJiuwenswarmCommand } from 'agent-bundle-core'

const cliBin = fileURLToPath(new URL('../../../cli/dist/bin.mjs', import.meta.url))
const jwRepo = process.env['AGENT_BUNDLE_JIUWENSWARM_REPO'] ?? join(homedir(), 'Example-Jiuwenswarm')
const bundleDir = join(jwRepo, 'bundles', 'example-jw')
const baseEnv: NodeJS.ProcessEnv = { ...process.env, JIUWENSWARM_CHECKOUT: jwRepo }
const jwCommand = await resolveJiuwenswarmCommand(baseEnv).catch(() => undefined)

interface ProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function runProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string, stdin?: string): Promise<ProcessResult> {
  return new Promise((resolveRun, rejectRun) => {
    const stdio = (stdin === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']) as StdioOptions
    const child = spawn(command, [...args], { cwd, env, stdio }) as ChildProcessWithoutNullStreams
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', code => resolveRun({ code: code ?? -1, stdout, stderr }))
    if (stdin !== undefined) {
      child.stdin?.write(stdin)
      child.stdin?.end()
    }
  })
}

function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<ProcessResult> {
  return runProcess(process.execPath, [cliBin, ...args], { ...baseEnv, ...extraEnv })
}

/** Keyless runtime smoke: a read-only `model.list` query proves the data dir launches without calling a model. */
function runQuery(dataDir: string): Promise<ProcessResult> {
  if (jwCommand === undefined) throw new Error('jiuwenswarm command unavailable')
  const query = JSON.stringify({ schema_version: '0.1', type: 'query', operation: 'model.list', params: {}, request_id: 'e2e-smoke' })
  return runProcess(jwCommand.command, ['--query-json', '-'], { ...baseEnv, JIUWENSWARM_DATA_DIR: dataDir }, undefined, `${query}\n`)
}

/** jiuwenswarm's own runtime loads the installed agent template and workspace skills. */
function runHostLoadCheck(dataDir: string): Promise<ProcessResult> {
  if (jwCommand === undefined) throw new Error('jiuwenswarm command unavailable')
  const python = join(dirname(jwCommand.command), 'python')
  const script = join(jwRepo, 'scripts', 'host-load-check.py')
  return runProcess(python, [script, dataDir], { ...baseEnv, JIUWENSWARM_DATA_DIR: dataDir })
}

/** Keyless skills listing through the real Runtime (`SKILLS_LIST`), no model call. */
function runSkillsList(dataDir: string): Promise<ProcessResult> {
  if (jwCommand === undefined) throw new Error('jiuwenswarm command unavailable')
  return runProcess(jwCommand.command, ['--_operation', 'skills.list', '--output', 'json', ''], { ...baseEnv, JIUWENSWARM_DATA_DIR: dataDir })
}

describe.skipIf(jwCommand === undefined || !existsSync(bundleDir))('agent-bundle jiuwenswarm e2e (real jiuwenswarm-process + real bundle)', () => {
  let scratch = ''
  let registryPath = ''
  let home = ''
  let digest = ''
  let installedId = ''

  beforeAll(async () => {
    if (!existsSync(cliBin)) {
      throw new Error(`CLI binary missing at ${cliBin}; run "pnpm build" first`)
    }
    if (!existsSync(bundleDir)) {
      throw new Error(`real jiuwenswarm bundle missing at ${bundleDir}; set AGENT_BUNDLE_JIUWENSWARM_REPO`)
    }
    scratch = await mkdtemp(join(tmpdir(), 'agent-bundle-jiuwenswarm-e2e-'))
    registryPath = join(scratch, 'installations.json')
    home = join(scratch, 'home-jiuwenswarm')
  })

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  const regEnv = (): NodeJS.ProcessEnv => ({ AGENT_BUNDLE_REGISTRY: registryPath })

  it('verifies the real bundle in text and json modes', async () => {
    const text = await runCli(['verify', bundleDir])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('name: example-jw')
    expect(text.stdout).toContain('kind: jiuwenswarm-agent-bundle')
    expect(text.stdout).toContain('packages: ./packages/office-expert:agent_template')
    const digestLine = text.stdout.split('\n').find(line => line.startsWith('digest: '))
    expect(digestLine).toMatch(/^digest: sha256:[0-9a-f]{64}$/)
    digest = digestLine!.slice('digest: '.length).trim()

    const json = await runCli(['--json', 'verify', bundleDir])
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.stdout) as {
      name: string
      kind: string
      schemaVersion: number
      skills: string
      packages: string
      connectors: string
      templates: string
      config: string
      digest: string
    }
    expect(parsed.name).toBe('example-jw')
    expect(parsed.kind).toBe('jiuwenswarm-agent-bundle')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.skills).toContain('skills')
    expect(parsed.packages).toBe('./packages/office-expert:agent_template, ./packages/office-tools:plugin, ./packages/office-council:agent_group')
    expect(parsed.connectors).toBe('office-mail')
    expect(parsed.templates).toContain('templates')
    expect(parsed.config).toContain('config.yaml')
    expect(parsed.digest).toBe(digest)
  })

  it('installs into an ephemeral data dir, materializing the workspace', async () => {
    const first = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(first.code).toBe(0)
    const parsed = JSON.parse(first.stdout) as Record<string, unknown>
    expect(parsed['reused']).toBe(false)
    expect(parsed['digest']).toBe(digest)
    expect(parsed['home']).toBe(home)
    expect(parsed['profile']).toBe('example-jw')
    expect(parsed['launch']).toBe('jiuwenswarm-process "<task>" --output json')
    expect(parsed['launch-env']).toBe(`JIUWENSWARM_DATA_DIR=${home}`)
    expect(parsed['skills']).toBe(join(home, 'agent', 'workspace', 'skills'))
    expect(parsed['packages']).toBe('./packages/office-expert:agent_template, ./packages/office-tools:plugin, ./packages/office-council:agent_group')
    expect(parsed['connectors']).toBe('office-mail')
    expect(parsed['config']).toBe(join(home, 'config', 'config.yaml'))
    installedId = `example-jw-${digest.slice(7, 15)}`

    expect(await readFile(join(home, 'agent', 'workspace', 'skills', 'office-report', 'SKILL.md'), 'utf8')).toContain('Office Report')
    expect(await readFile(join(home, 'agent', 'workspace', 'AGENT.md'), 'utf8')).toContain('ExampleAgent')
    const config = await readFile(join(home, 'config', 'config.yaml'), 'utf8')
    expect(config).toContain('preferred_language: zh')
    expect(config).toContain('enabled: false')
    const marketplace = JSON.parse(await readFile(join(home, 'agent', 'workspace', 'plugins', 'agent_templates', 'marketplace.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> }
    expect(marketplace.plugins).toContainEqual({ id: 'office-expert', installed: true, source: 'builtin' })
  })

  it('runs a keyless read-only query in the installed data dir', async () => {
    const query = await runQuery(home)
    expect(query.code).toBe(0)
    expect(query.stdout).toContain('query_result')
  }, 120_000)

  it('loads the installed agent template package and workspace skills through the host runtime', async () => {
    const check = await runHostLoadCheck(home)
    expect(check.code).toBe(0)
    expect(check.stdout).toContain('host-load-ok')

    const skills = await runSkillsList(home)
    expect(skills.code).toBe(0)
    const parsed = JSON.parse(skills.stdout) as { events: Array<{ payload: { skills: Array<{ name: string; source: string; path: string }> } }> }
    const listed = parsed.events[0]?.payload.skills ?? []
    expect(listed).toContainEqual(expect.objectContaining({ name: 'office-report', source: 'builtin' }))
    expect(listed.some(entry => entry.path.startsWith(`${home}/agent/workspace/skills/`))).toBe(true)
  }, 120_000)

  it('reuses the installation on repeat and uninstalls it', async () => {
    const second = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout) as { reused: boolean }).toMatchObject({ reused: true })

    const removed = await runCli(['--json', 'uninstall', '--id', installedId], regEnv())
    expect(removed.code).toBe(0)
    expect(removed.stdout).toContain('"home-existed": true')
    await expect(readFile(join(home, 'config'), 'utf8')).rejects.toThrow()
  })
})
