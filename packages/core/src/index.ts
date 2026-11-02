export { BundleError, errorCode, errorMessage, type BundleErrorCode } from './errors.ts'
export { computeBundleDigest, listBundleDigestPaths, type DigestOptions } from './digest.ts'
export { resolveBindings, type BindingInput, type RunBindings } from './bindings.ts'
export type { BundleRef, VerifyLevel, BundleInfo, PackResult } from './protocol.ts'
export {
  parseBundleManifest,
  parseManifestText,
  parseAgentConfig,
  parseBundleKind,
  isBundleName,
  harnessNameForKind,
  DSH_BUNDLE_KIND,
  DIFY_BUNDLE_KIND,
  PI_BUNDLE_KIND,
  HERMES_BUNDLE_KIND,
  DEEPAGENTS_BUNDLE_KIND,
  JIUWENSWARM_BUNDLE_KIND,
  type AgentConfig,
  type AnyBundleManifest,
  type BundleManifest,
} from './manifest.ts'
export {
  verifyBundle,
  digestOptions,
  isDifyManifest,
  isPiManifest,
  isDeepagentsManifest,
  isJiuwenswarmManifest,
  type VerifyOptions,
  type VerifyResult,
  type VerifyAgentConfig,
} from './verify.ts'
export { verifyInstallable, type VerifyInstallOptions } from './verify-install.ts'
export { inspectBundle } from './inspect.ts'
export { packBundle, type PackOptions } from './pack.ts'
export {
  credentialsPath,
  loadStoredCredentials,
  resolveDifyConsole,
  saveDifyCredentials,
  type DifyStoredCredentials,
  type ResolvedDifyConsole,
  type StoredCredentials,
} from './credentials.ts'
export { createBundleSdk, type BundleSdk, type BundleSdkOptions } from './sdk.ts'
export { resolveDshCommand, type DshCommand } from './dsh-bin.ts'
export { resolvePiCommand, type PiCommand } from './pi-bin.ts'
export { resolveHermesCommand, type HermesCommand } from './hermes-bin.ts'
export { compareVersion, parseVersionBound, parseVersionTriplet, versionGateFailure, type VersionTriplet, type VersionGateFailure } from './version-range.ts'
export { resolveJiuwenswarmCommand, type JiuwenswarmCommand } from './adapters/jiuwenswarm/jiuwenswarm-bin.ts'
export {
  defaultRegistryPath,
  loadRegistry,
  saveRegistry,
  upsertRecord,
  removeRecord,
  findRecord,
  installationId,
  findHomeOccupants,
  type InstallationRecord,
} from './registry.ts'
export {
  dispatchActivate,
  dispatchInstall,
  dispatchLoad,
  dispatchUninstall,
  registerAdapter,
  getAdapter,
  listAdapterKinds,
} from './adapters/index.ts'
export { ADAPTER_VERSION, installHome, withDirLock } from './adapters/install-core.ts'
export { installBundle } from './adapters/dsh/install.ts'
export {
  installDeepagentsBundle,
  deepagentsAdapter,
  resolvePythonRuntime,
  detectUv,
  DEEPAGENTS_HARNESS_NAME,
  DEEPAGENTS_GRAPH_ID,
  DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORIES,
  DEEPAGENTS_DIGEST_EXCLUDED_DIRECTORY_SUFFIXES,
  parseDeepagentsBundleManifest,
  type DeepagentsBundleManifest,
  type PythonRuntime,
} from './adapters/deepagents/index.ts'
export {
  installPiBundle,
  piAdapter,
  resolvePiModelSelection,
  readPiSettingsIfPresent,
  expandExtensionEntry,
  type PiExtensionResource,
  type PiBundleManifest,
  type PiAgentConfig,
  type PiSettings,
  PI_HARNESS_NAME,
  PI_DIGEST_EXCLUDED_DIRECTORIES,
  parsePiBundleManifest,
  parsePiAgentConfig,
  parsePiSettings,
} from './adapters/pi/index.ts'
export {
  installJiuwenswarmBundle,
  jiuwenswarmAdapter,
  JIUWENSWARM_HARNESS_NAME,
  parseJiuwenswarmBundleManifest,
  parseJiuwenswarmAgentConfig,
  type JiuwenswarmBundleManifest,
  type JiuwenswarmPackage,
  type JiuwenswarmPackageKind,
  type JiuwenswarmAgentConfig,
} from './adapters/jiuwenswarm/index.ts'
export { uninstallInstallation } from './adapters/uninstall.ts'
export type {
  HarnessAdapter,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
  ActivateOptions,
  ActivationResult,
  LoadOptions,
  LoadedAgent,
  LaunchDescription,
  RunDsh,
  RunDshOptions,
  RunHermes,
  RunPython,
} from './adapters/types.ts'
