import { stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { BundleError } from './errors.ts'

export interface HermesCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly extraEnv: Readonly<Record<string, string>>
  readonly source: string
}

export async function resolveHermesCommand(env: NodeJS.ProcessEnv = process.env): Promise<HermesCommand> {
  const hermesBin = env['HERMES_BIN']
  if (hermesBin !== undefined && hermesBin !== '') {
    await requireFile(hermesBin, 'HERMES_BIN')
    return { command: hermesBin, args: [], extraEnv: {}, source: 'HERMES_BIN' }
  }
  const pathCommand = await resolvePathHermes(env)
  if (pathCommand !== undefined) return pathCommand
  throw new BundleError('cannot resolve the hermes CLI: no hermes on PATH; set HERMES_BIN to the hermes executable', 'RUNTIME_UNRESOLVED')
}

/** PATH fallback with an existence/executable check so the CLI fails fast (before materializing) rather than at the first spawn. */
async function resolvePathHermes(env: NodeJS.ProcessEnv): Promise<HermesCommand | undefined> {
  const pathValue = env['PATH']
  if (pathValue === undefined || pathValue === '') return undefined
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'hermes')
    if (await isExecutableFile(candidate)) {
      return { command: candidate, args: [], extraEnv: {}, source: 'PATH' }
    }
  }
  return undefined
}

async function requireFile(path: string, label: string): Promise<void> {
  if (!await fileExists(path)) {
    throw new BundleError(`${label} points to a missing file: ${path}`, 'RUNTIME_UNRESOLVED')
  }
}

async function fileExists(path: string): Promise<boolean> {
  return await stat(path).then(
    info => info.isFile(),
    () => false,
  )
}

async function isExecutableFile(path: string): Promise<boolean> {
  return await stat(path).then(
    info => info.isFile() && (info.mode & 0o111) !== 0,
    () => false,
  )
}
