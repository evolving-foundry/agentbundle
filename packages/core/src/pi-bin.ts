import { stat } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import process from 'node:process'
import { BundleError } from './errors.ts'

export interface PiCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly extraEnv: Readonly<Record<string, string>>
  readonly source: string
}

/** The Pi CLI always runs from plain Node with an explicit entry file. */
const PI_ENTRY_RELATIVE = ['dist', 'bundle', 'cli.js'] as const

/**
 * Resolve the Pi runtime that the returned launch hints assume.
 *
 * Order: `PI_BIN` (an explicit `pi` binary or `cli.js` entry) → `PI_CHECKOUT`
 * (a Pi source checkout with `dist/bundle/cli.js`) → `PATH` → a locally installed
 * `@earendil-works/pi-coding-agent`. Unlike the dsh resolver there is no
 * known-bad PATH install, so PATH is a legitimate source.
 *
 * No version probe: `harness.version` names the harness profile (Pi),
 * which the Pi CLI does not report, so a `pi --version` reading could not be
 * compared against it. The version is discovered when something needs it.
 */
export async function resolvePiCommand(env: NodeJS.ProcessEnv = process.env): Promise<PiCommand> {
  const explicitBin = env['PI_BIN']
  if (explicitBin !== undefined && explicitBin !== '') {
    if (/\.(?:[cm]?js)$/.test(explicitBin)) {
      await requireFile(explicitBin, 'PI_BIN')
      return { command: process.execPath, args: [explicitBin], extraEnv: {}, source: 'PI_BIN' }
    }
    await requireFile(explicitBin, 'PI_BIN')
    return { command: explicitBin, args: [], extraEnv: {}, source: 'PI_BIN' }
  }

  const checkout = env['PI_CHECKOUT']
  if (checkout !== undefined && checkout !== '') {
    const entry = join(checkout, ...PI_ENTRY_RELATIVE)
    if (await fileExists(entry)) {
      return { command: process.execPath, args: [entry], extraEnv: {}, source: 'PI_CHECKOUT' }
    }
    throw new BundleError(`PI_CHECKOUT ${checkout} has no built CLI at ${entry}; build the checkout or set PI_BIN`, 'RUNTIME_UNRESOLVED')
  }

  const fromPath = env['PATH'] === undefined ? [] : env['PATH'].split(delimiter).filter(part => part !== '')
  for (const directory of fromPath) {
    for (const candidate of pathCandidates(directory)) {
      if (!await fileExists(candidate)) continue
      // A Windows `.cmd`/`.bat` shim cannot be spawned without a shell, and a
      // `.ps1` shim cannot be spawned at all. Prefer the real Node entry point of
      // the package the shim belongs to so hosts can always `spawn` it directly.
      const packageEntry = await resolvePiPackageEntryNear(candidate)
      if (packageEntry !== undefined) {
        return { command: process.execPath, args: [packageEntry], extraEnv: {}, source: 'PATH' }
      }
      return { command: candidate, args: [], extraEnv: {}, source: 'PATH' }
    }
  }
  const packageEntry = await resolvePiPackageEntry()
  if (packageEntry !== undefined) {
    return { command: process.execPath, args: [packageEntry], extraEnv: {}, source: 'PI_PACKAGE' }
  }
  throw new BundleError('cannot resolve the pi CLI: set PI_BIN to the pi entry point or PI_CHECKOUT to a Pi checkout, or install pi on PATH', 'RUNTIME_UNRESOLVED')
}

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'

/** The CLI entry of the pi package installed next to a PATH shim (npm global layout). */
async function resolvePiPackageEntryNear(shim: string): Promise<string | undefined> {
  let directory = dirname(shim)
  for (let depth = 0; depth < 3; depth += 1) {
    const entry = join(directory, 'node_modules', ...PI_PACKAGE_NAME.split('/'), ...PI_ENTRY_RELATIVE)
    if (await fileExists(entry)) return entry
    directory = dirname(directory)
  }
  return undefined
}

/** The CLI entry of the pi package resolvable from this module (local install). */
async function resolvePiPackageEntry(): Promise<string | undefined> {
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve(`${PI_PACKAGE_NAME}/package.json`)
    const entry = join(dirname(manifestPath), ...PI_ENTRY_RELATIVE)
    return await fileExists(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

function pathCandidates(directory: string): string[] {
  if (process.platform !== 'win32') return [join(directory, 'pi')]
  return [join(directory, 'pi.cmd'), join(directory, 'pi.exe'), join(directory, 'pi.bat'), join(directory, 'pi')]
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
