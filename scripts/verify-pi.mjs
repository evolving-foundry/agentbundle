#!/usr/bin/env node
/**
 * Direct Pi verification against a real bundle and a real `pi` runtime.
 *
 *   node scripts/verify-pi.mjs [bundleDir] [--keep]
 *
 * Runs the whole adapter surface end to end — verify → install → native pi RPC
 * load → reuse → uninstall — against an isolated ephemeral home and an isolated
 * registry, so nothing touches `~/.pi/agent` or the real installations.json.
 *
 * Defaults: bundleDir = $AGENT_BUNDLE_PI_REPO/bundles/pi (falling back
 * to <home>/Pi, then this checkout's sibling).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliBin = join(repoRoot, 'packages', 'cli', 'lib', 'bin.mjs')
const coreEntry = join(repoRoot, 'packages', 'core', 'lib', 'index.mjs')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const explicitBundle = argv.find(argument => !argument.startsWith('--'))

function defaultBundleDir() {
  const repo = process.env['AGENT_BUNDLE_PI_REPO']
  const candidates = [
    repo === undefined ? undefined : join(repo, 'bundles', 'pi'),
    join(homedir(), 'Pi', 'bundles', 'pi'),
    join(resolve(repoRoot, '..'), 'Pi', 'bundles', 'pi'),
  ].filter(candidate => candidate !== undefined)
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', rejectRun)
    child.on('close', code => resolveRun({ code: code ?? -1, stdout, stderr }))
  })
}

function fail(message) {
  console.error(`verify-pi: ${message}`)
  process.exitCode = 1
}

if (!existsSync(cliBin) || !existsSync(coreEntry)) {
  fail('build first: pnpm build')
  process.exit(1)
}

const bundleDir = resolve(explicitBundle ?? defaultBundleDir())
if (!existsSync(bundleDir)) {
  fail(`pi bundle not found at ${bundleDir}; pass a path or set AGENT_BUNDLE_PI_REPO`)
  process.exit(1)
}

const { resolvePiCommand } = await import(pathToFileURL(coreEntry).href)
const scratch = await mkdtemp(join(tmpdir(), 'verify-pi-'))
const home = join(scratch, 'home')
const agentDir = join(home, 'agent')
const env = { ...process.env, AGENT_BUNDLE_REGISTRY: join(scratch, 'installations.json') }

const step = (title) => console.log(`\n== ${title} ==`)

step(`verify ${bundleDir}`)
const verified = await run(process.execPath, [cliBin, 'verify', bundleDir], env)
console.log(verified.stdout.trim() || verified.stderr.trim())
if (verified.code !== 0) {
  fail(`verify failed (exit ${verified.code})`)
  process.exit(1)
}

step(`install --home ${home}`)
const installed = await run(process.execPath, [cliBin, 'install', bundleDir, '--home', home], env)
console.log(installed.stdout.trim())
console.error(installed.stderr.trim())
if (installed.code !== 0) {
  fail(`install failed (exit ${installed.code})`)
  process.exit(1)
}

const pi = await resolvePiCommand(process.env).catch(() => undefined)
if (pi === undefined) {
  step('real pi load: SKIPPED (no pi runtime resolved; set PI_BIN or PI_CHECKOUT)')
} else {
  step(`real pi (${pi.source}) loads ${agentDir}`)
  const child = spawn(pi.command, [...pi.args, '--offline', '--no-session', '--no-approve', '--mode', 'rpc'], {
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const loaded = []
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  const closed = new Promise(resolveClose => child.on('close', resolveClose))
  lines.on('line', (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event.type === 'response' && event.id === 'commands') {
      for (const command of event.data?.commands ?? []) loaded.push(command.name)
      child.stdin.end()
    }
  })
  child.stdin.write('{"id":"commands","type":"get_commands"}\n')
  await closed
  lines.close()
  const interesting = loaded.filter(name => name.startsWith('example') || name.startsWith('skill:'))
  for (const name of interesting) console.log('  -', name)
  if (interesting.length === 0) {
    fail(`no extension or skill commands loaded from this home\n${stderr.slice(0, 500)}`)
  }
}

step('reuse (same digest)')
const again = await run(process.execPath, [cliBin, '--json', 'install', bundleDir, '--home', home], env)
const reused = JSON.parse(again.stdout || '{}')['reused']
console.log(`reused: ${String(reused)}`)
if (reused !== true) fail('expected reused: true on a repeat install')

step('uninstall')
const records = JSON.parse(await readFile(env.AGENT_BUNDLE_REGISTRY, 'utf8'))
const removed = await run(process.execPath, [cliBin, 'uninstall', '--id', records[0].id], env)
console.log(removed.stdout.trim())
if (existsSync(home)) fail('home still exists after uninstall')
else console.log('home gone: true')

if (keep) console.log(`\nkept scratch: ${scratch}`)
else await rm(scratch, { recursive: true, force: true })

console.log(process.exitCode === 1 ? '\nRESULT: FAILED' : '\nRESULT: OK')
