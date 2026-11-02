import { stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { BundleError } from './errors.ts'

export interface DshCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly extraEnv: Readonly<Record<string, string>>
  readonly source: string
}

export async function resolveDshCommand(env: NodeJS.ProcessEnv = process.env): Promise<DshCommand> {
  const dshBin = env['DSH_BIN']
  if (dshBin !== undefined && dshBin !== '') {
    if (dshBin.endsWith('.js')) {
      await requireFile(dshBin, 'DSH_BIN')
      return { command: process.execPath, args: [dshBin], extraEnv: {}, source: 'DSH_BIN' }
    }
    await requireFile(dshBin, 'DSH_BIN')
    return { command: dshBin, args: [], extraEnv: {}, source: 'DSH_BIN' }
  }
  const checkout = env['DSH_CHECKOUT']
  if (checkout !== undefined && checkout !== '') {
    const builtBin = join(checkout, 'apps', 'cli', 'lib', 'bin.js')
    if (await fileExists(builtBin)) {
      return { command: process.execPath, args: [builtBin], extraEnv: {}, source: 'DSH_CHECKOUT' }
    }
    const tsxLoader = join(checkout, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    const sourceBin = join(checkout, 'apps', 'cli', 'src', 'bin.ts')
    if (await fileExists(tsxLoader) && await fileExists(sourceBin)) {
      return {
        command: process.execPath,
        args: ['--import', tsxLoader, sourceBin],
        extraEnv: { TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json') },
        source: 'DSH_CHECKOUT',
      }
    }
    throw new BundleError(`DSH_CHECKOUT ${checkout} has neither a built CLI (${builtBin}) nor a tsx source launch (${sourceBin}); run "pnpm build" in the checkout or install its dependencies`, 'RUNTIME_UNRESOLVED')
  }
  const pathCommand = await resolvePathDsh(env)
  if (pathCommand !== undefined) return pathCommand
  throw new BundleError('cannot resolve the dsh CLI: no dsh on PATH; set DSH_BIN or DSH_CHECKOUT (a checkout needs "pnpm build")', 'RUNTIME_UNRESOLVED')
}

/**
 * PATH fallback (revision of decision 6): the hard disable predated the
 * plugin-flow release; an outdated dsh now fails loudly at `plugin add` and
 * the CLI adds a targeted hint, so trusting PATH is the zero-config default.
 */
async function resolvePathDsh(env: NodeJS.ProcessEnv): Promise<DshCommand | undefined> {
  const pathValue = env['PATH']
  if (pathValue === undefined || pathValue === '') return undefined
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'dsh')
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
