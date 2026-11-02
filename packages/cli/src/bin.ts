#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { Command, CommanderError } from 'commander'
import {
  DSH_BUNDLE_KIND,
  HERMES_BUNDLE_KIND,
  defaultRegistryPath,
  dispatchInstall,
  dispatchUninstall,
  errorCode,
  errorMessage,
  harnessNameForKind,
  isDeepagentsManifest,
  isDifyManifest,
  isJiuwenswarmManifest,
  isPiManifest,
  loadRegistry,
  parseBundleKind,
  parseBundleManifest,
  parseVersionTriplet,
  PI_BUNDLE_KIND,
  resolveDshCommand,
  resolveHermesCommand,
  verifyBundle,
  verifyInstallable,
  versionGateFailure,
  type AnyBundleManifest,
  type HermesCommand,
  type InstallResult,
  type RunDsh,
  type RunHermes,
  type RunPython,
  type UninstallResult,
  type VerifyResult,
} from 'agent-bundle-core'
import { BundleError } from 'agent-bundle-core'

const NAME = 'agent-bundle'

interface GlobalOptions {
  readonly json?: boolean
}

interface VerifyOptions extends GlobalOptions {
  readonly expectDigest?: string
  readonly harnessVersion?: string
  readonly level?: string
}

interface InstallOptions extends GlobalOptions {
  readonly home?: string
  readonly profile?: string
  readonly harnessVersion?: string
  readonly force?: boolean
  readonly skipVersionGate?: boolean
}

interface UninstallOptions extends GlobalOptions {
  readonly id?: string
  readonly name?: string
  readonly all?: boolean
  readonly digest?: string
  readonly home?: string
  readonly force?: boolean
}

const program = new Command()
program
  .name(NAME)
  .description('Verify, install, and uninstall Agent Bundle candidate deliveries.')
  .version('0.1.0')
  .option('--json', 'emit machine-readable JSON on stdout')
  .exitOverride()

program
  .command('verify')
  .description('validate a bundle, then trial-install and uninstall it in an isolated home')
  .argument('<bundle path>')
  .option('--json', 'emit machine-readable JSON on stdout')
  .option('--expect-digest <digest>', 'fail unless the computed digest matches sha256:<hex>')
  .option('--level <level>', 'install (default), standard, or minimal')
  .option('--harness-version <version>', 'report the caller-probed harness version as harness.actualVersion')
  .action((bundlePath: string, options: Omit<VerifyOptions, 'json'>, command: Command) => run(async () => runVerify(bundlePath, { ...options, json: jsonFlag(command) })))

program
  .command('install')
  .description('install a bundle into a harness home and register it (dsh/hermes/pi: the harness default home; others: an isolated temp home)')
  .argument('<bundle path>')
  .option('--json', 'emit machine-readable JSON on stdout')
  .option('--home <dir>', 'materialize into an isolated home of your own instead of the harness default home (uninstall then removes it wholesale)')
  .option('--profile <name>', 'dsh/pi native: install into this profile instead of bundle-<name>')
  .option('--harness-version <version>', 'report the caller-probed harness version as harness.actualVersion')
  .option('--force', 'reinstall even when the digest already matches, so leftover links are rewritten')
  .option('--skip-version-gate', 'skip the hermes version-range check during install')
  .action((bundlePath: string, options: Omit<InstallOptions, 'json'>, command: Command) => run(async () => runInstall(bundlePath, { ...options, json: jsonFlag(command) })))

program
  .command('list')
  .description('list installed bundles from the registry')
  .option('--json', 'emit machine-readable JSON on stdout')
  .action((options: { json?: boolean }, command: Command) => run(async () => runList({ json: jsonFlag(command) })))

program
  .command('uninstall')
  .description('remove an installation record and its home (native: only the bundle-owned subtrees)')
  .option('--id <installation>', 'uninstall by installation id')
  .option('--name <name>', 'uninstall every record of this bundle name (disambiguate with --digest)')
  .option('--all', 'uninstall every installation (interactive y/N confirmation)')
  .option('--json', 'emit machine-readable JSON on stdout')
  .option('--digest <digest>', 'disambiguate between records sharing an id or name')
  .option('--home <dir>', 'disambiguate between records sharing an id')
  .option('--force', 'uninstall even when the home is in use by a running process')
  .action((options: Omit<UninstallOptions, 'json'>, command: Command) => run(async () => runUninstall({ ...options, json: jsonFlag(command) })))

await main()

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.code === 'commander.help' || error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2
      return
    }
    process.exitCode = 1
  }
}

async function run(action: () => Promise<number>): Promise<void> {
  process.exitCode = await action()
}

/** --json works before the subcommand (global) or after it (subcommand flag); read both. */
function jsonFlag(command: Command): boolean {
  return command.opts().json === true || program.opts().json === true
}

function fail(error: unknown, json: boolean | undefined): number {
  if (json === true) {
    process.stdout.write(`${JSON.stringify({ error: errorMessage(error), code: errorCode(error) }, null, 2)}\n`)
  } else {
    process.stderr.write(`${NAME}: ${errorMessage(error)}\n`)
  }
  return 1
}

function emit(value: Record<string, unknown>, json: boolean | undefined): void {
  if (json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  } else {
    const render = (line: unknown): string => (typeof line === 'object' && line !== null ? JSON.stringify(line) : String(line))
    process.stdout.write(`${Object.entries(value).map(([key, line]) => `${key}: ${render(line)}`).join('\n')}\n`)
  }
}

async function runVerify(bundlePath: string, options: VerifyOptions): Promise<number> {
  const level = options.level ?? 'install'
  if (level !== 'install' && level !== 'standard' && level !== 'minimal') {
    process.stderr.write(`${NAME}: --level must be install, standard, or minimal\n`)
    return 2
  }
  try {
    const bundleDir = resolve(bundlePath)
    const expectDigest = options.expectDigest === undefined ? {} : { expectDigest: options.expectDigest }
    if (level === 'install') {
      const log = (line: string): void => { process.stderr.write(`${NAME}: ${line}\n`) }
      const result = await verifyInstallable(bundleDir, {
        ...expectDigest,
        runDsh: buildRunDsh(options.json === true),
        runHermes: buildRunHermes(options.json === true),
        runPython: buildRunPython(options.json === true),
        log,
      })
      emit({ ...verifyLines(result, options.harnessVersion), install: 'ok' }, options.json)
      return 0
    }
    const result = await verifyBundle(bundleDir, { ...expectDigest, level })
    emit(verifyLines(result, options.harnessVersion), options.json)
    return 0
  } catch (error) {
    return fail(error, options.json)
  }
}

/** Per-kind verify summary: dsh reports plugins, pi reports its native resources. */
function verifyLines(result: VerifyResult, actualVersion?: string): Record<string, unknown> {
  const manifest: AnyBundleManifest = result.manifest
  const lines: Record<string, unknown> = {
    name: manifest.name,
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    harness: {
      name: harnessNameForKind(manifest.kind),
      versionRange: manifest.harnessVersion,
      ...(actualVersion === undefined ? {} : { actualVersion }),
    },
  }
  if (isPiManifest(manifest)) {
    lines['instructions'] = manifest.instructions.replaceAll('\\', '/')
    lines['skills'] = manifest.skills.replaceAll('\\', '/')
    lines['extensions'] = manifest.extensions.map(extension => extension.declared).join(', ')
  } else if (isDifyManifest(manifest)) {
    lines['entry'] = manifest.entry
  } else if (isDeepagentsManifest(manifest)) {
    lines['entry'] = manifest.entry
    lines['plugins'] = manifest.declaredPlugins.join(', ')
  } else if (isJiuwenswarmManifest(manifest)) {
    if (manifest.skills !== undefined) lines['skills'] = manifest.skills.replaceAll('\\', '/')
    if (manifest.packages !== undefined) lines['packages'] = manifest.packages.map(entry => `${entry.declared}:${entry.kind}`).join(', ')
    if (manifest.connectors !== undefined) lines['connectors'] = manifest.connectors.join(', ')
    if (manifest.templates !== undefined) lines['templates'] = manifest.templates.replaceAll('\\', '/')
    if (manifest.config !== undefined) lines['config'] = manifest.config.replaceAll('\\', '/')
  } else {
    lines['plugins'] = manifest.declaredPlugins.join(', ')
  }
  lines['digest'] = result.digest
  return lines
}

async function runInstall(bundlePath: string, options: InstallOptions): Promise<number> {
  try {
    const bundleDir = resolve(bundlePath)
    const log = (line: string): void => { process.stderr.write(`${NAME}: ${line}\n`) }
    const kind = await peekKind(bundleDir)
    const isHermes = kind === HERMES_BUNDLE_KIND
    const isDsh = kind === DSH_BUNDLE_KIND
    const isPi = kind === PI_BUNDLE_KIND
    // Default target: the harness's own world. dsh, hermes, and pi bundles
    // install natively (harness default home, host config reused as-is); other
    // kinds keep the isolated ephemeral default until they grow a native convention.
    const mode = options.home === undefined && (isDsh || isHermes || isPi) ? 'native' as const : undefined

    // S4: --profile has no meaning for hermes — plugins live under their own plugin.yaml names.
    if (options.profile !== undefined && isHermes) {
      return fail(new BundleError('--profile is not supported for hermes bundles: plugins are installed under their own plugin.yaml names; --profile only applies to dsh profiles', 'PROFILE_UNSUPPORTED'), options.json)
    }

    // S6 + S5: resolve the hermes runtime once. Missing hermes fails fast (before
    // materializing); a present hermes is version-gated against the bundle range.
    if (isHermes) {
      const hermes = await resolveHermesCommand()
      if (options.skipVersionGate !== true) {
        const manifest = await parseBundleManifest(bundleDir)
        gateHermesVersion(hermes, manifest.harnessVersion)
      }
    }
    const result = await dispatchInstall({
      bundleDir,
      ...(options.home === undefined ? {} : { home: resolve(options.home) }),
      ...(mode === undefined ? {} : { mode }),
      ...(options.profile === undefined ? {} : { profileName: options.profile }),
      ...(options.force === true ? { force: true } : {}),
      runDsh: buildRunDsh(options.json === true),
      runHermes: buildRunHermes(options.json === true),
      runPython: buildRunPython(options.json === true),
      log,
    })
    emit(installLines(result, options.harnessVersion), options.json)
    return 0
  } catch (error) {
    return fail(error, options.json)
  }
}

/** Peek the bundle kind for mode selection; failures fall through to dispatch for the real error. */
async function peekKind(bundleDir: string): Promise<string | undefined> {
  try {
    return await parseBundleKind(bundleDir)
  } catch {
    return undefined
  }
}

/** S5: probe `hermes --version` and reject an out-of-range runtime ("\u003E=x.y.z \u003Ca.b.c"). */
function gateHermesVersion(hermes: HermesCommand, range: string): void {
  const probe = spawnSync(hermes.command, [...hermes.args, '--version'], {
    encoding: 'utf8',
    env: { ...process.env, ...hermes.extraEnv },
  })
  const text = probe.status === 0 ? (probe.stdout ?? '').trim() : ''
  const actual = parseVersionTriplet(text)
  if (actual === undefined) {
    process.stderr.write(`${NAME}: could not parse a version from "hermes --version" (${text || 'no output'}); skipping version gate\n`)
    return
  }
  const failure = versionGateFailure(actual, range)
  if (failure === undefined) return
  if (failure === 'older') {
    throw new BundleError(`hermes ${text} is older than the bundle's required ${range}; upgrade hermes or pass --skip-version-gate`, 'VERSION_GATE')
  }
  throw new BundleError(`hermes ${text} is newer than the bundle's supported ${range}; pass --skip-version-gate to proceed anyway`, 'VERSION_GATE')
}

function installLines(result: InstallResult, actualVersion?: string): Record<string, unknown> {
  const lines: Record<string, unknown> = {
    id: result.id,
    installationId: result.installationId,
    harness: {
      ...result.harness,
      ...(actualVersion === undefined ? {} : { actualVersion }),
    },
    digest: result.digest,
    home: result.home,
    profile: result.profile,
    reused: result.reused,
    plugins: result.plugins.join(', '),
    launch: result.launchCommand,
  }
  if (result.codingAgentDir !== undefined) lines['coding-agent-dir'] = result.codingAgentDir
  if (result.launchEnv !== undefined && Object.keys(result.launchEnv).length > 0) {
    lines['launch-env'] = Object.entries(result.launchEnv).map(([key, value]) => `${key}=${value}`).join(' ')
  }
  if (result.instructions !== undefined) lines['instructions'] = result.instructions
  if (result.skills !== undefined) lines['skills'] = result.skills
  if (result.packages !== undefined) lines['packages'] = result.packages.join(', ')
  if (result.connectors !== undefined) lines['connectors'] = result.connectors.join(', ')
  if (result.config !== undefined) lines['config'] = result.config
  if (result.extensions !== undefined) lines['extensions'] = result.extensions.join(', ')
  if (result.appId !== undefined) lines['app-id'] = result.appId
  return lines
}

async function runList(options: { json?: boolean }): Promise<number> {
  try {
    const registryPath = defaultRegistryPath()
    const records = await loadRegistry(registryPath)
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(records.map(record => ({
        id: record.id,
        name: record.name,
        kind: record.kind,
        digest: record.digest.slice(0, 12),
        home: record.home,
        mode: record.mode,
        status: record.status ?? 'installed',
      })), null, 2)}\n`)
    } else {
      if (records.length === 0) {
        process.stdout.write(`${NAME}: no installations in ${registryPath}\n`)
      }
      for (const record of records) {
        process.stdout.write([
          `id: ${record.id}`,
          `name: ${record.name}`,
          `kind: ${record.kind}`,
          `digest: ${record.digest.slice(0, 12)}`,
          `home: ${record.home}`,
          `mode: ${record.mode}`,
          `status: ${record.status ?? 'installed'}`,
          '',
        ].join('\n'))
      }
    }
    return 0
  } catch (error) {
    return fail(error, options.json)
  }
}

async function runUninstall(options: UninstallOptions): Promise<number> {
  try {
    const log = (line: string): void => { process.stderr.write(`${NAME}: ${line}\n`) }
    const selectors = [options.id !== undefined, options.name !== undefined, options.all === true].filter(Boolean).length
    if (selectors !== 1) {
      process.stderr.write(`${NAME}: exactly one of --id, --name, or --all is required\n`)
      return 2
    }
    if (options.all === true) {
      const confirmed = await confirm(`${NAME}: uninstall ALL installations? [y/N] `)
      if (!confirmed) {
        process.stdout.write(`${NAME}: cancelled\n`)
        return 0
      }
      const records = await loadRegistry(defaultRegistryPath())
      for (const record of records) {
        await dispatchUninstall({ id: record.id, digest: record.digest, home: record.home, log })
      }
      emit({ removed: records.map(record => record.id) }, options.json)
      return 0
    }
    if (options.name !== undefined) {
      const records = await loadRegistry(defaultRegistryPath())
      const matches = records.filter(record => record.name === options.name)
      if (matches.length === 0) {
        return fail(new BundleError(`no installation with name ${JSON.stringify(options.name)}`, 'RECORD_MISSING'), options.json)
      }
      if (matches.length > 1 && options.digest === undefined) {
        return fail(new BundleError(`name ${JSON.stringify(options.name)} matches ${matches.length} installations (ids: ${matches.map(r => r.id).join(', ')}); pass --digest to disambiguate`, 'RECORD_MISSING'), options.json)
      }
      const target = options.digest === undefined ? matches[0] : matches.find(record => record.digest === options.digest)
      if (target === undefined) {
        return fail(new BundleError(`no installation named ${JSON.stringify(options.name)} with digest ${options.digest}`, 'RECORD_MISSING'), options.json)
      }
      const result = await dispatchUninstall({ id: target.id, digest: target.digest, home: target.home, ...(options.force === undefined ? {} : { force: options.force }), log })
      emit(uninstallLines(result, target.id), options.json)
      return 0
    }
    const result = await dispatchUninstall({
      id: options.id!,
      ...(options.digest === undefined ? {} : { digest: options.digest }),
      ...(options.home === undefined ? {} : { home: resolve(options.home) }),
      ...(options.force === undefined ? {} : { force: options.force }),
      log,
    })
    emit(uninstallLines(result, options.id!), options.json)
    return 0
  } catch (error) {
    return fail(error, options.json)
  }
}

function uninstallLines(result: UninstallResult, id: string): Record<string, unknown> {
  return result.profileRemoved !== undefined
    ? {
        removed: id,
        'profile-removed': result.profileRemoved,
        'home-kept': result.homeKept,
        'reinstall-hint': `agent-bundle install ${relative(process.cwd(), result.bundleDir) || result.bundleDir}`,
      }
    : {
        removed: id,
        'home-existed': result.homeExisted,
        ...(result.occupied ? { occupied: true } : {}),
        'reinstall-hint': `agent-bundle install ${relative(process.cwd(), result.bundleDir) || result.bundleDir}`,
      }
}

/** Read a single y/n answer from an interactive terminal (--all needs a human in the loop). */
function confirm(prompt: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new BundleError('--all requires an interactive terminal; uninstall by --id or --name instead', 'INSTALL_CONFLICT')
  }
  return new Promise(resolve => {
    process.stdout.write(prompt)
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      process.stdin.pause()
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      const answer = chunk.toString().trim().toLowerCase()
      finish(answer === 'y' || answer === 'yes')
    }
    const onEnd = (): void => { finish(false) }
    process.stdin.resume()
    process.stdin.once('data', onData)
    process.stdin.once('end', onEnd)
  })
}

/**
 * The dsh runtime is resolved lazily, on the first native call. A bundle that
 * never invokes dsh (pi) must not fail because no dsh runtime is configured.
 */
function buildRunDsh(json: boolean): RunDsh {
  let resolved: Awaited<ReturnType<typeof resolveDshCommand>> | undefined
  return async (args, env, runOptions) => {
    if (resolved === undefined) {
      resolved = await resolveDshCommand()
      process.stderr.write(`${NAME}: using dsh from ${resolved.source}: ${[resolved.command, ...resolved.args].join(' ')}\n`)
    }
    const dsh = resolved
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const quiet = runOptions?.quiet === true
      const child = spawn(dsh.command, [...dsh.args, ...args], {
        stdio: quiet ? 'ignore' : json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...process.env, ...dsh.extraEnv, ...env },
      })
      if (!quiet && json) {
        child.stdout?.on('data', chunk => process.stderr.write(chunk))
        child.stderr?.on('data', chunk => process.stderr.write(chunk))
      }
      child.on('error', rejectSpawn)
      child.on('close', code => {
        if (code !== 0 && runOptions?.allowFailure !== true) {
          const hint = dsh.source === 'PATH' && args[0] === 'plugin'
            ? '; the dsh on PATH may predate the plugin flow — upgrade @deepseek-ai/dsh (>= 0.1.6-alpha.1) or set DSH_BIN/DSH_CHECKOUT'
            : ''
          rejectSpawn(new Error(`native dsh command failed (exit ${code ?? 'signal'}): dsh ${args.join(' ')}${hint}`))
          return
        }
        resolveSpawn()
      })
    })
  }
}

/**
 * The hermes runtime is resolved lazily, on the first native call. A bundle that
 * never invokes hermes (dsh/pi/dify) must not fail because no hermes runtime is configured.
 */
function buildRunHermes(json: boolean): RunHermes {
  let resolved: Awaited<ReturnType<typeof resolveHermesCommand>> | undefined
  return async (args, env, runOptions) => {
    if (resolved === undefined) {
      resolved = await resolveHermesCommand()
      process.stderr.write(`${NAME}: using hermes from ${resolved.source}: ${[resolved.command, ...resolved.args].join(' ')}\n`)
    }
    const hermes = resolved
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const quiet = runOptions?.quiet === true
      const child = spawn(hermes.command, [...hermes.args, ...args], {
        stdio: quiet ? 'ignore' : json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...process.env, ...hermes.extraEnv, ...env },
      })
      if (!quiet && json) {
        child.stdout?.on('data', chunk => process.stderr.write(chunk))
        child.stderr?.on('data', chunk => process.stderr.write(chunk))
      }
      child.on('error', rejectSpawn)
      child.on('close', code => {
        if (code !== 0 && runOptions?.allowFailure !== true) {
          rejectSpawn(new Error(`native hermes command failed (exit ${code ?? 'signal'}): hermes ${args.join(' ')}`))
          return
        }
        resolveSpawn()
      })
    })
  }
}

/**
 * deepagents process execution: the adapter passes the binary explicitly
 * (base python, the venv's python, or uv), so no runtime resolution happens
 * here — resolution and version gating live in the adapter over this seam.
 */
function buildRunPython(json: boolean): RunPython {
  return async (command, args, env, runOptions) => {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const quiet = runOptions?.quiet === true
      const child = spawn(command, [...args], {
        stdio: quiet ? 'ignore' : json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...process.env, ...env },
      })
      if (!quiet && json) {
        child.stdout?.on('data', chunk => process.stderr.write(chunk))
        child.stderr?.on('data', chunk => process.stderr.write(chunk))
      }
      child.on('error', rejectSpawn)
      child.on('close', code => {
        if (code !== 0 && runOptions?.allowFailure !== true) {
          rejectSpawn(new Error(`native python command failed (exit ${code ?? 'signal'}): ${command} ${args.join(' ')}`))
          return
        }
        resolveSpawn()
      })
    })
  }
}
