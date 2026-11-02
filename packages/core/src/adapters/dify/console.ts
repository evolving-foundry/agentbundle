/**
 * Dify Console API client with an injectable fetch seam (mirrors the runDsh
 * seam philosophy: core never does real network I/O in tests).
 *
 * Auth conventions (dify 1.17.x, verified 2026-09-18):
 *   - login password field is Base64-encoded (api/libs/encryption.py)
 *   - session cookies: access_token / refresh_token / csrf_token
 *   - every request carries cookies; csrf_token is echoed as X-CSRF-Token
 *   - optional ADMIN_API_KEY bearer skips cookies entirely
 */

export interface DifyHttpResponse {
  readonly status: number
  readonly text: string
  readonly setCookie: readonly string[]
}

export interface DifyRequestInit {
  readonly method: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export type DifyFetch = (url: string, init: DifyRequestInit) => Promise<DifyHttpResponse>

export interface DifyConsoleOptions {
  readonly baseUrl: string
  readonly email?: string
  readonly password?: string
  readonly adminApiKey?: string
  readonly fetchFn: DifyFetch
}

export class DifyConsoleError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`dify console ${status}: ${body.slice(0, 300)}`)
  }
}

export class DifyConsoleClient {
  private readonly cookies = new Map<string, string>()
  private loggedIn = false

  constructor(private readonly options: DifyConsoleOptions) {}

  private fullUrl(path: string): string {
    return this.options.baseUrl.replace(/\/$/, '') + path
  }

  private absorbCookies(setCookie: readonly string[]): void {
    for (const header of setCookie) {
      const pair = header.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  private async rawRequest(method: string, path: string, body?: string, extra?: Record<string, string>): Promise<DifyHttpResponse> {
    const headers: Record<string, string> = { ...(extra ?? {}) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.options.adminApiKey !== undefined && this.options.adminApiKey !== '') {
      headers['Authorization'] = `Bearer ${this.options.adminApiKey}`
    } else {
      const cookies = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
      if (cookies !== '') headers['Cookie'] = cookies
      // dify validates the CSRF token on console API reads too (verified on
      // /workspaces/current/models/model-types/llm) — send it whenever present
      const csrf = this.cookies.get('csrf_token')
      if (csrf !== undefined) headers['X-CSRF-Token'] = csrf
    }
    const response = await this.options.fetchFn(this.fullUrl(path), { method, headers, body })
    this.absorbCookies(response.setCookie)
    return response
  }

  async call(method: string, path: string, payload?: unknown): Promise<{ status: number; body: unknown; text: string }> {
    if (!this.loggedIn && this.options.adminApiKey === undefined) await this.login()
    const text = payload === undefined ? undefined : JSON.stringify(payload)
    let response = await this.rawRequest(method, path, text)
    if (response.status === 401 && this.options.adminApiKey === undefined) {
      this.loggedIn = false
      await this.login()
      response = await this.rawRequest(method, path, text)
    }
    let parsed: unknown = undefined
    try {
      parsed = response.text === '' ? {} : JSON.parse(response.text)
    } catch {
      parsed = { raw: response.text.slice(0, 300) }
    }
    return { status: response.status, body: parsed, text: response.text }
  }

  async login(): Promise<void> {
    if (this.loggedIn || this.options.adminApiKey !== undefined) return
    const email = this.options.email ?? ''
    const password = this.options.password ?? ''
    const encoded = Buffer.from(password, 'utf8').toString('base64')
    const response = await this.rawRequest('POST', '/console/api/login', JSON.stringify({
      email, password: encoded, remember_me: true,
    }))
    if (response.status !== 200 || !this.cookies.has('access_token')) {
      throw new DifyConsoleError(response.status, `dify login failed: ${response.text.slice(0, 300)}`)
    }
    this.loggedIn = true
  }
}
