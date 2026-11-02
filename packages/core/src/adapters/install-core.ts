import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { BundleError } from '../errors.ts'
import type { InstallationRecord, InstallMode } from '../registry.ts'
import { pathExists } from '../yaml-file.ts'

/**
 * Core package version; part of the reuse key (digest + adapterVersion) and of
 * every installation record. Keep in sync with packages/core/package.json —
 * a bump must regenerate installed configuration, not silently reuse it.
 */
export const ADAPTER_VERSION = '0.5.0'

/** Directory-name prefixes for default install homes, per kind (historic values, unchanged). */
const HOME_PREFIXES: Record<string, string> = {
  'dsh-agent-bundle': 'dsh-bundle-',
  'pi-agent-bundle': 'pi-bundle-',
  'hermes-agent-bundle': 'hermes-bundle-',
  'deepagents-agent-bundle': 'deepagents-bundle-',
  'jiuwenswarm-agent-bundle': 'jiuwenswarm-bundle-',
}

export interface InstallHomeInput {
  readonly kind: string
  readonly name: string
  readonly digest: string
  /** Explicit home from the caller; wins over the mode-specific default. */
  readonly home?: string
  readonly mode: InstallMode
  /** Registry path; persistent homes default to a `homes/` sibling so registry overrides isolate them too. */
  readonly registryPath: string
  /** Environment for native-home resolution (`DSH_HOME` / `HERMES_HOME` / `PI_CODING_AGENT_DIR`); defaults to the process env. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Harness-native default home per kind. dsh resolves its world from `DSH_HOME`
 * (default `~/.dsh`), hermes from `HERMES_HOME` (default `~/.hermes`), pi from
 * `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) — the same rules the bare
 * binaries apply at run time. Other kinds have no native convention yet.
 */
export function nativeHome(kind: string, env: NodeJS.ProcessEnv): string {
  if (kind === 'dsh-agent-bundle') {
    const override = env['DSH_HOME']
    return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.dsh')
  }
  if (kind === 'hermes-agent-bundle') {
    const override = env['HERMES_HOME']
    return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.hermes')
  }
  if (kind === 'pi-agent-bundle') {
    const explicit = env['PI_CODING_AGENT_DIR']?.trim()
    return explicit ? resolve(explicit) : join(homedir(), '.pi', 'agent')
  }
  throw new BundleError(`no native home convention for bundle kind ${JSON.stringify(kind)}`, 'BUNDLE_KIND_UNKNOWN')
}

/** Resolve the install home: explicit override, else native default, tmpdir (ephemeral) or `<registryDir>/homes/…` (persistent). */
export function installHome(input: InstallHomeInput): string {
  if (input.home !== undefined) return resolve(input.home)
  if (input.mode === 'native') return nativeHome(input.kind, input.env ?? process.env)
  const prefix = HOME_PREFIXES[input.kind]
  if (prefix === undefined) {
    throw new BundleError(`no install home convention for bundle kind ${JSON.stringify(input.kind)}`, 'BUNDLE_KIND_UNKNOWN')
  }
  const leaf = `${prefix}${input.name}-${input.digest.slice(7, 15)}`
  if (input.mode === 'persistent') return join(dirname(input.registryPath), 'homes', leaf)
  return join(tmpdir(), leaf)
}

export interface DirLockOptions {
  /** How long to wait for a concurrent holder before failing; generous because installs (venv, pip) can be slow. */
  readonly timeoutMs?: number
  readonly retryMs?: number
}

/**
 * Serialize mutations of one target directory across processes: a sibling lock
 * file (`<dir>.lock`, never inside the dir — homes are deleted wholesale) is
 * created exclusively with `open 'wx'` and retried until the timeout. The lock
 * is released even when `fn` fails.
 */
export async function withDirLock<T>(dir: string, fn: () => Promise<T>, options: DirLockOptions = {}): Promise<T> {
  const lockPath = `${dir}.lock`
  const timeoutMs = options.timeoutMs ?? 120_000
  const retryMs = options.retryMs ?? 100
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let handle
  for (;;) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
      if (Date.now() > deadline) {
        throw new BundleError(
          `home ${dir} is locked by another install/uninstall (waited ${timeoutMs}ms); if the lock is stale, remove ${lockPath}`,
          'INSTALL_CONFLICT',
        )
      }
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, retryMs))
    }
  }
  await handle.writeFile(`${process.pid}\n`, 'utf8').catch(() => undefined)
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

/** Reuse-stamp payload written into a materialized home; `adapterVersion` makes regeneration explicit on adapter upgrades. */
export interface InstallStamp {
  readonly digest: string
  readonly bundleDir: string
  readonly adapterVersion: string
}

export async function readInstallStamp(stampPath: string): Promise<InstallStamp | undefined> {
  return await readFile(stampPath, 'utf8')
    .then(text => JSON.parse(text) as InstallStamp)
    .catch(() => undefined)
}

/**
 * A stamp matches only when both the digest and the adapter version match;
 * stamps from older adapters (missing the field) never match — the home is
 * regenerated instead of being silently reused across adapter upgrades.
 */
export function stampMatches(stamp: InstallStamp | undefined, digest: string): boolean {
  return stamp?.digest === digest && stamp?.adapterVersion === ADAPTER_VERSION
}

/** Reuse only when the stamp matches and the caller did not ask for a forced reinstall. */
export function shouldReuseInstall(stamp: InstallStamp | undefined, digest: string, force: boolean | undefined): boolean {
  return force !== true && stampMatches(stamp, digest)
}

export async function writeInstallStamp(stampPath: string, digest: string, bundleDir: string): Promise<void> {
  await mkdir(dirname(stampPath), { recursive: true })
  const stamp: InstallStamp = { digest, bundleDir, adapterVersion: ADAPTER_VERSION }
  await writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
}

/** Shared activation-time runtime check for stamp-based adapters: the home must still carry a matching stamp. */
export async function checkStampActivation(record: InstallationRecord, stampPath: string, log?: (line: string) => void): Promise<void> {
  if (!await pathExists(stampPath)) {
    throw new BundleError(`installation ${record.id} home has no reuse stamp at ${stampPath}; reinstall before activating`, 'INSTALL_CONFLICT')
  }
  const stamp = await readInstallStamp(stampPath)
  if (!stampMatches(stamp, record.digest)) {
    throw new BundleError(
      `installation ${record.id} home stamp does not match digest ${record.digest} + adapter ${ADAPTER_VERSION}; reinstall before activating`,
      'INSTALL_CONFLICT',
    )
  }
  log?.(`activation check ok: ${record.id} stamp matches digest and adapter ${ADAPTER_VERSION}`)
}

/** "使用中的版本拒绝卸载"（§4.4）：persistent/native 且 active 的安装不可卸载，force 覆盖。 */
export function assertUninstallable(record: InstallationRecord, force: boolean | undefined): void {
  const inUseMode = record.mode === 'persistent' || record.mode === 'native'
  if (inUseMode && record.status === 'active' && force !== true) {
    throw new BundleError(
      `installation ${record.id} is the active installation of ${record.name}; activate another installation or pass --force`,
      'INSTALL_CONFLICT',
    )
  }
}
