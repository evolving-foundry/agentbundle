import { access, constants } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { BundleError } from '../../errors.ts'

export interface PythonRuntime {
  /** Executable python binary (absolute when PYTHON_BIN, else a PATH name). */
  readonly command: string
  readonly source: string
}

/** Well-known CPython 3.x launch names, best (newest) first. */
const PYTHON_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3'] as const

/**
 * Resolve a python interpreter for venv creation: `PYTHON_BIN` explicitly, else
 * the first PATH candidate. Version gating (>= 3.11, the deepagents pin) is the
 * caller's job — it needs a spawn, and resolution here stays process-pure.
 */
export async function resolvePythonRuntime(env: NodeJS.ProcessEnv = process.env): Promise<PythonRuntime> {
  const explicit = env['PYTHON_BIN']
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolute(explicit)) {
      throw new BundleError(`PYTHON_BIN must be an absolute path, got ${JSON.stringify(explicit)}`, 'RUNTIME_UNRESOLVED')
    }
    await requireExecutable(explicit, 'PYTHON_BIN')
    return { command: explicit, source: 'PYTHON_BIN' }
  }
  for (const candidate of PYTHON_CANDIDATES) {
    const found = await scanPath(candidate, env)
    if (found !== undefined) {
      return { command: found, source: `PATH:${candidate}` }
    }
  }
  throw new BundleError('cannot resolve a python interpreter: install python >= 3.11 (the deepagents pin) or set PYTHON_BIN', 'RUNTIME_UNRESOLVED')
}

/** Absolute `uv` path when installed (venv creation accelerator), else undefined. */
export async function detectUv(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const explicit = env['UV_BIN']
  if (explicit !== undefined && explicit !== '') {
    return await isExecutable(explicit) ? explicit : undefined
  }
  return await scanPath('uv', env)
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
