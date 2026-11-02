# Repository Development Guidelines

These instructions apply to the entire repository.

## Repository layout

- `packages/core/` (`agent-bundle-core`): process-pure orchestration library, independent of commander.
  - `src/index.ts`: the sole public package API.
  - `errors.ts`: `BundleError` and error formatting.
  - `digest.ts`: content digest and directory traversal with per-kind exclusions.
  - `bundle-paths.ts`: confined path resolution, file/directory checks, JSON reading, and package entry resolution.
  - `manifest.ts`: bundle/agent YAML parsing, kind constants, and kind parsing.
  - `verify.ts`, `verify-install.ts`: static validation, digest checks, and isolated trial installation.
  - `protocol.ts`, `inspect.ts`, `pack.ts`, `sdk.ts`: shared protocol, read-only inspection, immutable packaging, and SDK assembly.
  - `registry.ts`: installation records, ids, and home occupancy checks.
  - `yaml-file.ts`: YAML reading.
  - `dsh-bin.ts`, `pi-bin.ts`, `hermes-bin.ts`: runtime path resolution.
  - `adapters/types.ts`: adapter contracts and injected process functions.
  - `adapters/index.ts`: adapter registration and dispatch.
  - `adapters/uninstall.ts`: shared removal and running-process protection.
  - `adapters/<kind>/`: DSH, Dify, Pi, Hermes, deepagents, and jiuwenswarm implementations.
  - `tests/*.spec.ts`: unit tests with fake process functions.
  - `tests/e2e/*.e2e.ts`: real-runtime tests; skip when prerequisites are absent.
- `packages/cli/src/bin.ts` (`agent-bundle`): commander assembly, output, and exit codes (`0` success, `1` failure, `2` usage error).
- `scripts/verify-pi.mjs`: real Pi verification workflow.
- `README.md` / `README.zh-CN.md`: English and Chinese user documentation. Keep them aligned.
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`: workspace, scripts, and dependency locking.
- `tsconfig.json`: strict no-emit type checking; maps `agent-bundle-core` to source.
- `vitest.config.ts`: unit tests; `vitest.e2e.config.ts`: serial e2e tests with a ten-minute timeout.
- `packages/core/dist/`, `packages/cli/dist/`: generated ESM/declarations and bundled CLI. Never edit or commit them.

Keep shared contracts, parsing, and registry logic at the core root; kind-specific semantics in `adapters/<kind>/`; command assembly and presentation in CLI. Core must not depend on commander or spawn processes itself. Inject process execution through the appropriate seam. Do not add kind-specific branching to shared modules; dispatch through the adapter registry.

## Commands and verification

```bash
pnpm install
pnpm build
pnpm test
pnpm test:e2e
pnpm verify:pi
pnpm typecheck
```

Build before e2e or real Pi verification. Individual package builds: `pnpm --filter agent-bundle-core build` and `pnpm --filter agent-bundle build`.

`node scripts/verify-pi.mjs <bundleDir> [--keep]` accepts an explicit bundle or preserves the temporary home for inspection.

For small changes, start with affected tests. For cross-module changes and before committing, run `pnpm typecheck` and `pnpm test`. There is no lint configuration. Changes to installation, removal, verification, digests, or registration also require relevant e2e or Pi verification after building, with the required runtime and environment. Skipped or unexecuted tests are pending validation, never passes.

## Environment

- `DSH_BIN` > `DSH_CHECKOUT` > PATH. A `.js` binary runs through Node. Checkout resolution prefers `apps/cli/lib/bin.js`, falling back to tsx source. An outdated PATH runtime fails during plugin loading with upgrade guidance.
- `PI_BIN` > `PI_CHECKOUT` > PATH > local `@earendil-works/pi-coding-agent`. JS/MJS/CJS entry points run through Node. Checkout uses `dist/bundle/cli.js`; Windows `.cmd` shims resolve to the real entry when possible. Missing Pi resolution warns without blocking installation. `harness.name` is `pi`.
- `HERMES_BIN` > PATH.
- `JIUWENSWARM_BIN` > `JIUWENSWARM_CHECKOUT` > PATH. Checkout uses `.venv/bin/jiuwenswarm-process`. Invalid explicit paths fail; absence only warns.
- `UV_BIN` / PATH uv is preferred for managed Python 3.12; fallback is `PYTHON_BIN` or PATH Python ≥ 3.11.
- Runtime resolution is path-based; do not add version probes to resolvers.
- `AGENT_BUNDLE_REGISTRY`: overrides `~/.agent-bundle/installations.json`.
- `AGENT_BUNDLE_DSH_REPO`: external DSH e2e fixture checkout; default `<home>/Example-DSH`.
- `AGENT_BUNDLE_PI_REPO`: Pi e2e fixture checkout; default `<home>/Pi`, with `bundles/pi`.
- `AGENT_BUNDLE_LANGGRAPH_REPO`: deepagents fixture checkout; default `<home>/Example-LangGraph`, with `bundles/office-quarterly-report` and its trace runner.
- `AGENT_BUNDLE_JIUWENSWARM_REPO`: jiuwenswarm fixture checkout; default `<home>/Example-Jiuwenswarm`, with `bundles/example-jw` and its runtime.
- `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_NAME`: sources for model placeholders. DSH, Pi, Hermes, and jiuwenswarm resolve them at installation; missing variables leave model selection unset. deepagents binds model environment variables at runtime in its composition entry point.

## Development workflow

1. Create design and task documents only when the user explicitly requests a design document. Without that explicit request, do not create either design or task documents, regardless of change size or complexity. When requested, place the design in `docs/design/` and its tasks in `docs/tasks/`; describe scope, approach, acceptance criteria, and the relationship to the canonical design, and maintain progress and validation in the same task file. Follow `docs/AGENTS.md` where present. Do not restore files deliberately deleted by another contributor.
2. Harness contracts follow the latest external checkout referenced by `AGENT_BUNDLE_*_REPO`. Resolve contract drift before implementation and update documentation. Do not claim alignment with an external checkout that was not inspected.
3. Changes to installation semantics, digests, registration, or shared contracts still require appropriate implementation review, verification, and updates to existing user documentation. Such changes do not authorize creating design or task documents without the user's explicit request for a design document.
4. Inspect current code, contracts, tests, and worktree state before editing. Preserve others' changes and avoid unrelated cleanup.
5. Verify observable behavior; add regression tests where useful. Do not add tests that merely repeat implementation. Unit tests inject fake process functions and do not require real harnesses.
6. Report actual changes, verification commands/results, and limitations. Mark unexecuted e2e and manual acceptance as pending. Update both READMEs when user-facing behavior changes.

## TypeScript conventions

- ESM only, Node ≥ 22. Relative imports include `.ts`; built-ins use `node:`. Use `import type` / `export type` with `verbatimModuleSyntax`.
- Preserve `strict` and `noUncheckedIndexedAccess`. Narrow external `unknown` values; avoid unjustified `any`, assertions, and non-null assertions. Public contracts distinguish omitted fields from explicit values even without `exactOptionalPropertyTypes`.
- Two-space indentation, double quotes, semicolons, UTF-8, LF, final newline. Follow neighboring code and avoid unrelated formatting changes.
- Kebab-case files, camelCase variables/functions, PascalCase types/classes, UPPER_SNAKE_CASE constants.
- Give public interfaces explicit parameter/return types and readonly fields. Prefer inference for internal locals.
- Keep functions focused. Extract shared logic only for demonstrated reuse.
- Use async/await. Inject all process execution (`runDsh`, `runHermes`, `runPython`); missing required functions raise `BundleError`.
- Include actionable context in errors and retain `cause` when wrapping. Do not swallow failures or expose API keys in logs, registry output, or JSON.
- Use `node:path`. Pass executable and arguments separately; do not interpolate untrusted input into shell commands.
- Comments explain constraints and non-obvious reasons. Public contract changes require reviewing digest exclusions, reuse, uninstall compatibility, and JSON output.

## Adapter requirements

- Implement new harnesses in `adapters/<kind>/`, with manifest parsing, runtime resolution as needed, and installation. Implement `HarnessAdapter` and register it in `adapters/index.ts`. CLI owns presentation. Do not change shared contracts for a single adapter's convenience.
- Validate before installation. Common digest exclusions: `node_modules`, `.git`, `__pycache__`; Pi additionally excludes `dist` and `.venv`; deepagents excludes `.langgraph_api` and `*.egg-info`; jiuwenswarm v1 adds none. Reject symbolic links. Digests determine reuse, installation ids, and evaluation association.
- Isolated installation materializes a dedicated home, delegates native harness operations, then atomically records the installation. Matching digests support reuse (`reused: true`). Uninstall removes the record and owned resources; refuse when occupied by running processes unless forced. Native installation preserves unrelated host resources. Never modify harness source code.
- Resource mapping keys belong to adapters; bundles cannot redirect them.
- DSH/Pi/Hermes/jiuwenswarm resolve model placeholders during installation. jiuwenswarm writes MODEL_NAME/MODEL_PROVIDER/ENDPOINT_PROFILE in `<data>/config/.env`. deepagents leaves model binding to runtime.
- Model selection is distinct from credentials and provider registration. Installers must not overwrite host credential/provider configuration. Dify Console authentication follows its adapter-specific API flow.
- Unit tests cover success, failure, reuse, and uninstall using fake execution. Real-bundle tests belong in `tests/e2e/`; Pi also has the manual verification script. Follow acceptance criteria in the canonical design where available.

## Git commits

Use Conventional Commits: `type(scope): short description`.

- Types include `feat`, `fix`, `docs`, and other appropriate types. Choose feat/fix for refactors according to purpose.
- Scopes: `core`, `cli`, or harness kind; combine scopes with commas. Documentation-only commits may omit scope.
- One-line summary, English or Chinese; omit implementation chronology and validation details.
- Do not include author information, `Author`, `Co-authored-by`, or attribution trailers.
- One coherent purpose per commit. Inspect diff and staging; include only this task's changes and preserve others' work.
- Dependency changes update manifests and lockfile together. Do not commit `lib`, `dist`, `node_modules`, registry files, caches, or temporary output; do not force-add ignored artifacts.
