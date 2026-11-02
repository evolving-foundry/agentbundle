# Agent Bundle

[English](README.md) | [简体中文](README.zh-CN.md)

Agent Bundle packages an agent's instructions, configuration, skills, plugins, and entry points into a directory with a `bundle.yaml` manifest. The manifest identifies the target agent harness: the runtime that loads and executes the agent.

This project provides the `agent-bundle` CLI and `agent-bundle-core` TypeScript SDK to validate, install, track, and uninstall bundles through harness-specific adapters.

## Why use it?

- Deliver an agent as a versioned set of resources with an explicit runtime contract.
- Validate resources and compute a content digest before installation.
- Install through one interface while respecting each harness's resource layout.
- Track installations, reuse matching content, and remove installed resources.
- Trial-install in an isolated home before adopting a bundle.

Bundles target a specific harness; adapters do not translate agents between runtimes. Install the runtime and supply its credentials separately. Installation prepares the agent; launch the harness afterward to execute tasks.

## Supported harnesses

| Harness | Manifest `kind` | Adapter behavior |
| --- | --- | --- |
| DSH | `dsh-agent-bundle` | Installs native plugins and profile settings. |
| Dify | `dify-agent-bundle` | Imports workflow DSL through the Dify Console API; requires a running service and Console credentials. |
| Pi | `pi-agent-bundle` | Maps instructions, skills, extensions, and settings. Use `harness.name: pi`. |
| Hermes | `hermes-agent-bundle` | Copies and enables directory plugins and writes model selection. |
| deepagents | `deepagents-agent-bundle` | Creates an isolated Python environment and installs bundle packages in editable mode; requires uv or Python ≥ 3.11. |
| jiuwenswarm | `jiuwenswarm-agent-bundle` | Materializes templates, skills, packages, and configuration in an isolated data root. |

## Get started

Requires Node.js ≥ 22 and pnpm (version pinned in `package.json`). From the repository root:

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.mjs --help
```

Use `node packages/cli/dist/bin.mjs` in place of `agent-bundle` below, or install the built CLI globally:

```bash
cd packages/cli
pnpm add -g .
```

Obtain a bundle for a supported harness. Required resource fields and files depend on its `kind`.

```bash
# Static validation without installation
agent-bundle verify ./my-bundle --level standard

# Validate, trial-install into an isolated home, then uninstall
agent-bundle verify ./my-bundle

# Install; keep the returned installation id and launch information
agent-bundle install ./my-bundle
agent-bundle list

# Remove an installation
agent-bundle uninstall --id <installation-id>
```

Launch the agent with its harness using the installation's launch information. Model credentials and provider setup follow that harness's conventions.

### Options and installation behavior

- CLI installation defaults to native mode for DSH, Pi, and Hermes, reusing the harness home. `--home <dir>` selects an isolated home; uninstall removes that directory in full. Use a dedicated directory.
- Native uninstall removes bundle-owned resources. Dify also creates and removes remote resources through its API.
- `install --profile <name>` selects a DSH or Pi native profile; `install --force` reinstalls matching content.
- `verify --expect-digest sha256:<hex>` rejects unexpected content. `minimal` and `standard` levels perform static checks; the CLI default `install` level requires the runtime/service for a trial installation.
- `--json` produces machine-readable output. Exit codes: `0` success, `1` operation failure, `2` usage error.
- `AGENT_BUNDLE_REGISTRY` overrides `~/.agent-bundle/installations.json`.

Runtime overrides: `DSH_BIN` / `DSH_CHECKOUT`, `PI_BIN` / `PI_CHECKOUT`, `HERMES_BIN`, `UV_BIN` / `PYTHON_BIN`, `JIUWENSWARM_BIN` / `JIUWENSWARM_CHECKOUT`. Dify accepts `DIFY_BASE` with `DIFY_EMAIL` / `DIFY_PASSWORD` or `DIFY_ADMIN_API_KEY`.

### TypeScript SDK

```ts
import { createBundleSdk } from 'agent-bundle-core'

const sdk = createBundleSdk()
const info = await sdk.inspect('./my-bundle')
const verified = await sdk.verify('./my-bundle')
console.log(info, verified.digest)
```

The SDK also exposes `pack`, `install`, `activate`, `load`, and `uninstall`. SDK verification defaults to static `standard` checks. Installation and runtime operations require the appropriate injected process functions (`runDsh`, `runHermes`, or `runPython`) where used; core does not spawn processes. SDK installation defaults can differ from CLI defaults; explicitly select `mode: 'native'` where supported to use an existing harness home.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Real-runtime e2e tests skip when prerequisites are missing. External fixture repositories can be configured through `AGENT_BUNDLE_DSH_REPO`, `AGENT_BUNDLE_PI_REPO`, `AGENT_BUNDLE_LANGGRAPH_REPO`, and `AGENT_BUNDLE_JIUWENSWARM_REPO`. Default checkout directories under the user home are `Example-DSH`, `Pi`, `Example-LangGraph`, and `Example-Jiuwenswarm`. Fixture names must match the tests, including `bundles/pi` and `bundles/example-jw`.

**Pi migration:** older branded manifests must change `harness.name` to `pi`. External fixture package names, paths, and command expectations must match the neutral names in the tests. Renaming content changes its digest; verify and reinstall the updated bundle.
