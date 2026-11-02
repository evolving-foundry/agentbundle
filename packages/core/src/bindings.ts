import { BundleError } from './errors.ts'

/**
 * Minimal run bindings (agentBundle设计.md §3.3): a string value is either a
 * literal or a whole-string `${VAR}` environment reference (same semantics as
 * agent.yaml model placeholders — no substring interpolation); a credential
 * entry is resolved from the caller-provided credential map. core never
 * reaches into credential services itself.
 */
export type BindingInput = string | { readonly credentialRef: string }

export type RunBindings = Readonly<Record<string, BindingInput>>

const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export interface BindingResolutionContext {
  readonly env: NodeJS.ProcessEnv
  readonly credentials?: Readonly<Record<string, string>>
}

export function resolveBindings(bindings: RunBindings, context: BindingResolutionContext): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const [name, input] of Object.entries(bindings)) {
    resolved[name] = typeof input === 'string'
      ? resolveEnvBinding(name, input, context.env)
      : resolveCredentialBinding(name, input.credentialRef, context)
  }
  return resolved
}

function resolveEnvBinding(name: string, value: string, env: NodeJS.ProcessEnv): string {
  const match = ENV_PLACEHOLDER.exec(value)
  if (match === null) return value
  const variable = match[1]!
  const resolved = env[variable]
  if (resolved === undefined || resolved === '') {
    throw new BundleError(
      `binding ${JSON.stringify(name)} references environment variable ${JSON.stringify(variable)} which is not set`,
      'BINDING_MISSING',
    )
  }
  return resolved
}

function resolveCredentialBinding(name: string, ref: string, context: BindingResolutionContext): string {
  const resolved = context.credentials?.[ref]
  if (resolved === undefined || resolved === '') {
    throw new BundleError(
      `binding ${JSON.stringify(name)} references credential ${JSON.stringify(ref)} which was not provided`,
      'BINDING_MISSING',
    )
  }
  return resolved
}
