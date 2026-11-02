import { access, constants } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { BundleError } from '../../errors.ts'

export interface JiuwenswarmCommand {
  readonly command: string
  readonly source: string
}

/** The headless single-process CLI (`jiuwenswarm-process`), the launch entry. */
const PROCESS_CLI_NAME = 'jiuwenswarm-process'

/**
 * Resolve the jiuwenswarm process CLI for launch hints: `JIUWENSWARM_BIN`
 * explicitly (invalid → hard `RUNTIME_UNRESOLVED`), else the companion repo
 * checkout's `uv sync` venv (`JIUWENSWARM_CHECKOUT`), else PATH. Pure path
 * resolution — no version probe (host runtime is trusted like pi). A missing
 * runtime returns undefined so the installer warns without blocking.
 */
export async function resolveJiuwenswarmCommand(env: NodeJS.ProcessEnv = process.env): Promise<JiuwenswarmCommand | undefined> {
  const explicit = env['JIUWENSWARM_BIN']
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolute(explicit)) {
      throw new BundleError(`JIUWENSWARM_BIN must be an absolute path, got ${JSON.stringify(explicit)}`, 'RUNTIME_UNRESOLVED')
    }
    await requireExecutable(explicit, 'JIUWENSWARM_BIN')
    return { command: explicit, source: 'JIUWENSWARM_BIN' }
  }

  const checkout = env['JIUWENSWARM_CHECKOUT']
  if (checkout !== undefined && checkout !== '') {
    const candidate = join(checkout, '.venv', 'bin', PROCESS_CLI_NAME)
    if (await isExecutable(candidate)) {
      return { command: candidate, source: 'JIUWENSWARM_CHECKOUT' }
    }
  }

  const found = await scanPath(PROCESS_CLI_NAME, env)
  if (found !== undefined) {
    return { command: found, source: `PATH:${PROCESS_CLI_NAME}` }
  }
  return undefined
}

async function scanPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathEnv = env['PATH'] ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

async function requireExecutable(path: string, label: string): Promise<void> {
  if (!await isExecutable(path)) {
    throw new BundleError(`${label} points to a missing or non-executable file: ${path}`, 'RUNTIME_UNRESOLVED')
  }
}

async function isExecutable(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(() => true, () => false)
}
