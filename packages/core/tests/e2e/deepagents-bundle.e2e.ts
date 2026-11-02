import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const cliBin = new URL('../../../cli/dist/bin.mjs', import.meta.url).pathname
const langgraphRepo = process.env['AGENT_BUNDLE_LANGGRAPH_REPO'] ?? join(homedir(), 'Example-LangGraph')
const bundleDir = join(langgraphRepo, 'bundles', 'office-agent')
const traceRunner = join(langgraphRepo, 'scripts', 'dump-trace.py')

/** The bundle is under active restructuring upstream; the CLI contract is
 *  "plugins echoed in declared order", so derive the expectation from the
 *  manifest instead of pinning directory names. */
async function declaredPlugins(): Promise<string[]> {
  const manifest = parse(await readFile(join(bundleDir, 'bundle.yaml'), 'utf8')) as { plugins?: Array<{ path?: string }> }
  return (manifest.plugins ?? []).map(plugin => String(plugin.path))
}

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
  return runProcess(process.execPath, [cliBin, ...args], { ...process.env, ...extraEnv })
}

describe.skipIf(!existsSync(bundleDir))('agent-bundle deepagents e2e (real venv + real Example-LangGraph bundle)', () => {
  let scratch = ''
  let registryPath = ''
  let home = ''
  let workspace = ''
  let installedId = ''
  let digest = ''

  beforeAll(async () => {
    if (!existsSync(cliBin)) {
      throw new Error(`CLI binary missing at ${cliBin}; run "pnpm build" first`)
    }
    if (!existsSync(traceRunner)) {
      throw new Error(`trace runner missing at ${traceRunner}; the Example-LangGraph checkout looks incomplete`)
    }
    scratch = await mkdtemp(join(tmpdir(), 'agent-bundle-dg-e2e-'))
    registryPath = join(scratch, 'installations.json')
    home = join(scratch, 'venv')
    workspace = join(scratch, 'workspace')
    await mkdir(workspace, { recursive: true })
  })

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  const regEnv = (): NodeJS.ProcessEnv => ({ AGENT_BUNDLE_REGISTRY: registryPath })

  it('verifies the real bundle in json mode', async () => {
    const json = await runCli(['--json', 'verify', bundleDir])
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.stdout) as { name: string; kind: string; schemaVersion: number; entry: string; plugins: string; digest: string }
    expect(parsed.name).toBe('office-agent')
    expect(parsed.kind).toBe('deepagents-agent-bundle')
    expect(parsed.entry).toBe('./langgraph.json')
    expect(parsed.plugins.split(', ')).toEqual(await declaredPlugins())
    digest = parsed.digest
  })

  it('installs into an ephemeral venv and reuses on repeat', async () => {
    const first = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(first.code, first.stderr).toBe(0)
    const parsed = JSON.parse(first.stdout) as { digest: string; home: string; profile: string; reused: boolean; launch: string }
    expect(parsed.reused).toBe(false)
    expect(parsed.digest).toBe(digest)
    expect(parsed.home).toBe(home)
    expect(parsed.profile).toBe('office-agent')
    expect(parsed.launch).toBe(`cd ${bundleDir} && ${join(home, 'bin', 'python')} -c "import agent"`)
    installedId = `office-agent-${digest.slice(7, 15)}`
    expect(existsSync(join(home, 'bin', 'python'))).toBe(true)

    const second = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(second.code, second.stderr).toBe(0)
    expect((JSON.parse(second.stdout) as { reused: boolean }).reused).toBe(true)
  })

  it('imports the composed agent (assembly assertions)', async () => {
    const check = [
      'import agent',
      'assert "Office task discipline:" in agent.SYSTEM_PROMPT, "discipline missing"',
      'assert "SOP: synthesized-process" in agent.SYSTEM_PROMPT, "runbook missing"',
      'assert agent.INTERRUPT_ON, "interrupt gates missing"',
      'assert agent.agent is not None, "graph missing"',
      'print("assembly OK")',
    ].join('; ')
    const run = await runProcess(join(home, 'bin', 'python'), ['-c', check], process.env, bundleDir)
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toContain('assembly OK')
  })

  it('runs a keyless fake-model task with a tool round trip through the trace runner', async () => {
    const tracePath = join(workspace, 'trace.jsonl')
    const run = await runProcess(
      join(home, 'bin', 'python'),
      [traceRunner, '--fake', '--task', 'Run the office baseline smoke: write a demo file and report the result.', '--out', tracePath],
      { ...process.env, AGENT_MODEL_PROVIDER: 'fake' },
      workspace,
    )
    expect(run.code, run.stderr).toBe(0)

    const lines = (await readFile(tracePath, 'utf8')).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    const kinds = lines.map(line => line['kind'])
    expect(kinds).toContain('system_prompt')
    const system = lines.filter(line => line['kind'] === 'system_prompt').map(line => String(line['text'])).join('\n')
    expect(system).toContain('Office task discipline:')
    expect(system).toContain('SOP: synthesized-process')

    const messages = lines.filter(line => line['kind'] === 'message') as Array<{ role?: string; tool_calls?: Array<{ name?: string }>; content?: unknown }>
    expect(messages.some(message => (message.tool_calls ?? []).some(call => call.name === 'write_file'))).toBe(true)
    expect(messages.some(message => message.role === 'tool')).toBe(true)
    const skills = lines.find(line => line['kind'] === 'skills_metadata') as { names?: string[] } | undefined
    expect([...(skills?.names ?? [])].sort()).toEqual(['docx-documents', 'pptx-decks', 'synthesized-process', 'xlsx-workbooks'])
  })

  it('uninstalls and cleanly reinstalls', async () => {
    const removed = await runCli(['--json', 'uninstall', '--id', installedId], regEnv())
    expect(removed.code).toBe(0)
    expect((JSON.parse(removed.stdout) as { removed: string }).removed).toBe(installedId)
    expect(existsSync(join(home, 'bin', 'python'))).toBe(false)
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual([])

    const reinstalled = await runCli(['--json', 'install', bundleDir, '--home', home], regEnv())
    expect(reinstalled.code, reinstalled.stderr).toBe(0)
    expect((JSON.parse(reinstalled.stdout) as { reused: boolean }).reused).toBe(false)

    // The install output's launch command runs as printed (composition entry importable).
    const launched = JSON.parse(reinstalled.stdout) as { launch: string }
    const smoke = await runProcess('/bin/sh', ['-c', launched.launch], process.env)
    expect(smoke.code, smoke.stderr).toBe(0)
  })
})
