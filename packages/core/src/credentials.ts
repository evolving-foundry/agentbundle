/**
 * Persisted console credentials for zero-env installs.
 *
 * Resolution order (dify adapter):
 *   1. explicit env (DIFY_EMAIL / DIFY_PASSWORD / DIFY_ADMIN_API_KEY / DIFY_BASE)
 *   2. stored credentials (~/.agent-bundle/credentials.json, chmod 600)
 *   3. interactive prompt (only when running on a real TTY, outside injected-env tests)
 *
 * After a successful login the values are persisted (2) so that every later
 * verify/install/uninstall runs without any environment configuration.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { BundleError } from './errors.ts'

export interface DifyStoredCredentials {
  readonly baseUrl?: string
  readonly email?: string
  readonly password?: string
}

export interface StoredCredentials {
  readonly dify?: DifyStoredCredentials
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENT_BUNDLE_CREDENTIALS']
  return override !== undefined && override !== ''
    ? override
    : join(homedir(), '.agent-bundle', 'credentials.json')
}

export function loadStoredCredentials(env: NodeJS.ProcessEnv = process.env): StoredCredentials {
  const path = credentialsPath(env)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredCredentials
  } catch {
    throw new BundleError(`credentials file is not valid JSON: ${path}`, 'CREDENTIALS_INVALID')
  }
}

/** Merge-write the dify section and restrict the file to owner-only access. */
export function saveDifyCredentials(env: NodeJS.ProcessEnv, creds: DifyStoredCredentials): string {
  const path = credentialsPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const store = loadStoredCredentials(env)
  const next: StoredCredentials = { ...store, dify: { ...store.dify, ...creds } }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // some filesystems ignore explicit modes; the write mode above already covers ext4
  }
  return path
}

export interface ResolvedDifyConsole {
  readonly baseUrl: string
  readonly email?: string
  readonly password?: string
  readonly adminApiKey?: string
  /** provenance of the values: env > store > interactive prompt > admin key */
  readonly source: 'env' | 'store' | 'interactive' | 'admin-key'
}

/**
 * Resolve dify console access. `interactiveAllowed` must be false when the env
 * was injected programmatically (tests/embedded SDK runs) so that we never
 * block on stdin.
 */
export async function resolveDifyConsole(
  env: NodeJS.ProcessEnv,
  interactiveAllowed: boolean,
): Promise<ResolvedDifyConsole> {
  const baseUrlFromEnv = env['DIFY_BASE']
  const adminApiKey = env['DIFY_ADMIN_API_KEY']
  if (adminApiKey !== undefined && adminApiKey !== '') {
    return { baseUrl: baseUrlFromEnv ?? 'http://localhost', adminApiKey, source: 'admin-key' }
  }

  const email = env['DIFY_EMAIL']
  const password = env['DIFY_PASSWORD']
  if (email !== undefined && email !== '' && password !== undefined && password !== '') {
    return { baseUrl: baseUrlFromEnv ?? 'http://localhost', email, password, source: 'env' }
  }

  const stored = loadStoredCredentials(env).dify
  if (stored?.email !== undefined && stored?.email !== '' && stored?.password !== undefined && stored?.password !== '') {
    return {
      baseUrl: baseUrlFromEnv ?? stored.baseUrl ?? 'http://localhost',
      email: stored.email,
      password: stored.password,
      source: 'store',
    }
  }

  if (!interactiveAllowed || !process.stdin.isTTY) {
    throw new BundleError(
      'dify console credentials not configured: run `agent-bundle login` once, '
        + 'set DIFY_EMAIL / DIFY_PASSWORD, or create ~/.agent-bundle/credentials.json',
      'CREDENTIALS_MISSING',
    )
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const promptedBase = (await rl.question('dify base url [http://localhost]: ')).trim()
    const promptedEmail = (await rl.question('dify admin email: ')).trim()
    const promptedPassword = (await rl.question('dify admin password: ')).trim()
    if (promptedEmail === '' || promptedPassword === '') {
      throw new BundleError('dify admin email and password are required', 'CREDENTIALS_MISSING')
    }
    return {
      baseUrl: promptedBase !== '' ? promptedBase : 'http://localhost',
      email: promptedEmail,
      password: promptedPassword,
      source: 'interactive',
    }
  } finally {
    rl.close()
  }
}
