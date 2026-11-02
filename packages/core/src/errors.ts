/**
 * Structured error taxonomy for the bundle protocol. `message` stays a single
 * human-readable line; `code` is the machine-readable discriminator shared by
 * the TS SDK and the CLI `--json` output (future Python bridge aligns on it).
 */
export type BundleErrorCode =
  | 'BUNDLE_KIND_UNKNOWN'
  | 'MANIFEST_INVALID'
  | 'POINTER_MISSING'
  | 'PATH_ESCAPE'
  | 'SYMLINK_REJECTED'
  | 'SPECIAL_FILE_REJECTED'
  | 'DIGEST_MISMATCH'
  | 'DIGEST_FORMAT_INVALID'
  | 'REGISTRY_CORRUPT'
  | 'RECORD_MISSING'
  | 'INSTALL_CONFLICT'
  | 'RUNTIME_UNRESOLVED'
  | 'MODEL_UNRESOLVED'
  | 'PROFILE_UNSUPPORTED'
  | 'VERSION_GATE'
  | 'NATIVE_COMMAND_FAILED'
  | 'BINDING_MISSING'
  | 'CREDENTIALS_MISSING'
  | 'CREDENTIALS_INVALID'
  | 'INTERNAL'

export class BundleError extends Error {
  readonly code: BundleErrorCode

  constructor(message: string, code: BundleErrorCode = 'INTERNAL') {
    super(message)
    this.name = 'BundleError'
    this.code = code
  }
}

export function errorCode(error: unknown): BundleErrorCode {
  return error instanceof BundleError ? error.code : 'INTERNAL'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
