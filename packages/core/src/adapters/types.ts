import type { AgentConfig } from '../manifest.ts'
import type { InstallationRecord, InstallMode } from '../registry.ts'
import type { RunBindings } from '../bindings.ts'

export type { InstallMode }

export interface RunDshOptions {
  readonly allowFailure?: boolean
  readonly quiet?: boolean
}

export type RunDsh = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  options?: RunDshOptions,
) => Promise<void>

export type RunHermes = RunDsh

/**
 * deepagents: process execution with an explicit binary — venv creation and
 * pip go through different interpreters (`python3 -m venv`, then the venv's
 * `python -m pip`), and uv accelerates both when present.
 */
export type RunPython = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  options?: RunDshOptions,
) => Promise<void>

export interface InstallOptions {
  readonly bundleDir: string
  readonly home?: string
  readonly profileName?: string
  /**
   * ephemeral（缺省）：digest 命名的隔离目录，卸载即整目录删除；
   * persistent：登记目录下的持久 home；native（dsh/hermes/pi）：harness 本体默认 home
   * （dsh: `DSH_HOME` 或 `~/.dsh`；hermes: `HERMES_HOME` 或 `~/.hermes`；pi:
   * `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`），与宿主裸 harness 共享世界，卸载只删
   * bundle 专属子树、保留 home 本体。
   */
  readonly mode?: InstallMode
  /** Re-run materialization even when the digest and adapter version already match. */
  readonly force?: boolean
  readonly runDsh?: RunDsh
  readonly runHermes?: RunHermes
  readonly runPython?: RunPython
  readonly log?: (line: string) => void
  readonly registryPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface InstallResult {
  /** Registry installation id (`<name>-<digest8>`); the key for activate / uninstall. */
  readonly id: string
  readonly digest: string
  readonly home: string
  /** Stable installation identity (bundle name + short digest). */
  readonly installationId: string
  /** Harness selector + declared compatibility range, present for every kind. */
  readonly harness: { readonly name: string; readonly versionRange: string }
  /** Harness-native selector: dsh profile name, or the bundle name for pi installs. */
  readonly profile: string
  readonly plugins: readonly string[]
  readonly reused: boolean
  readonly launchCommand: string
  /**
   * Environment the caller must add when running `launchCommand`, beyond the
   * ambient one. pi needs `PI_CODING_AGENT_DIR=<home>/agent` to select the
   * ephemeral configuration instead of the user's `~/.pi/agent`.
   */
  readonly launchEnv?: Readonly<Record<string, string>>
  /** pi: harness config directory the caller must export as PI_CODING_AGENT_DIR. */
  readonly codingAgentDir?: string
  /** pi: global instruction file materialized from the bundle. */
  readonly instructions?: string
  /** pi: skill root materialized from the bundle. */
  readonly skills?: string
  /** jiuwenswarm: declared package entries (`<path>:<kind>`) in installation order. */
  readonly packages?: readonly string[]
  /** jiuwenswarm: declared host connector dependencies (declaration-only, never materialized with credentials). */
  readonly connectors?: readonly string[]
  /** jiuwenswarm: materialized `config/config.yaml` path (declared config overlay only). */
  readonly config?: string
  /** pi: declared extension resources in installation order. */
  readonly extensions?: readonly string[]
  /** dify: created application id (dify adapter only). */
  readonly appId?: string
  /** dify: created Service API key (dify adapter only). */
  readonly apiKey?: string
}

export interface UninstallOptions {
  readonly id: string
  readonly digest?: string
  readonly home?: string
  readonly force?: boolean
  readonly log?: (line: string) => void
  readonly registryPath?: string
  /** dify uninstall resolves Console credentials from these variables. */
  readonly env?: NodeJS.ProcessEnv
}

export interface UninstallResult {
  readonly removed: boolean
  readonly homeExisted: boolean
  readonly occupied: boolean
  readonly bundleDir: string
  /** native installs: the removed bundle-owned subtree(s) (dsh: profile name; hermes: comma-separated plugin paths); the shared home is kept. */
  readonly profileRemoved?: string
  /** native installs: the shared home directory intentionally kept (harness default home). */
  readonly homeKept?: string
}

export interface ActivateOptions {
  readonly id: string
  /** Disambiguate between records sharing the id. */
  readonly digest?: string
  readonly home?: string
  readonly registryPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly log?: (line: string) => void
}

export interface ActivationResult {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly digest: string
  readonly home: string
  readonly mode: InstallMode
  readonly activatedAt: string
  /** The previously active installation of the same name, demoted by this activation. */
  readonly previous?: { readonly id: string; readonly digest: string }
}

/** Harness-native launch description derived from an installation record. */
export interface LaunchDescription {
  readonly launchCommand: string
  readonly launchEnv: Readonly<Record<string, string>>
}

export interface LoadOptions {
  readonly id: string
  /** Disambiguate between records sharing the id. */
  readonly digest?: string
  readonly home?: string
  readonly bindings?: RunBindings
  /** credentialRef name → secret value; provided by the caller per invocation. */
  readonly credentials?: Readonly<Record<string, string>>
  readonly registryPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly log?: (line: string) => void
}

/**
 * A loadable agent handle: launch description plus a cleanup entry. The SDK
 * never defines how the agent is started, called, or cancelled — the solver or
 * host owns that (agentBundle设计.md §4.2).
 */
export interface LoadedAgent {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly digest: string
  readonly home: string
  readonly mode: InstallMode
  readonly launchCommand: string
  /** Adapter baseline merged with the resolved bindings (bindings win on clash). */
  readonly launchEnv: Readonly<Record<string, string>>
  readonly bindings: Readonly<Record<string, string>>
  /** Ephemeral: uninstalls (registry + home). Persistent and native: no-op, so a shared harness home is not deleted. Idempotent. */
  readonly cleanup: () => Promise<void>
}

export type { AgentConfig }

export interface HarnessAdapter {
  readonly kind: string
  readonly install: (options: InstallOptions) => Promise<InstallResult>
  readonly uninstall: (options: UninstallOptions) => Promise<UninstallResult>
  /**
   * Activation-time runtime validation, run before the active pointer moves.
   * Adapters verify their materialized home is still the recorded installation
   * (stamp digest + adapter version); omit for adapters without local state.
   */
  readonly runtimeCheck?: (options: { readonly record: InstallationRecord; readonly log?: (line: string) => void }) => Promise<void>
  /** Harness-native launch description from an installation record; load requires it. */
  readonly describeLaunch: (options: { readonly record: InstallationRecord; readonly bindings: Readonly<Record<string, string>> }) => LaunchDescription
}
