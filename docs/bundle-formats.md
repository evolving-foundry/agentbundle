# Bundle authoring guide

[English](bundle-formats.md) | [简体中文](bundle-formats.zh-CN.md) · [README](../README.md)

This guide documents the current repository parsers and standard verification rules. “Schema” below means field names, types, requiredness, and file constraints; no standalone JSON Schema is shipped. The trees are suggested source layouts, not installed-home layouts. Versions shown are illustrative compatibility declarations, not a claim of runtime certification.

[dsh](#dsh) · [dify](#dify) · [pi](#pi) · [hermes](#hermes) · [deepagents](#deepagents) · [jiuwenswarm](#jiuwenswarm)

## Common rules

| Field | Rule |
| --- | --- |
| `kind` | Required string: one of the six exact selectors below. |
| `schemaVersion` | Required number: `1` (not the string `"1"`). |
| `name` | Required string matching `^[a-z0-9][a-z0-9-]*$`; for example `demo-agent`. |
| `harness.name` | Required exact string matching the selected harness. |
| `harness.version` | Required non-empty string. Quote ranges. Pi additionally validates range syntax; version checking is adapter-specific, not guaranteed by static verification. |

All declared paths are relative to the bundle root unless stated otherwise. Keep targets inside the bundle, use `./...`, avoid absolute paths and `..`, and include all referenced files. Symlinks in digest traversal are rejected. Unknown fields are not a portable extension mechanism: these parsers do not provide a universal `additionalProperties: false` schema.

### Root files required by standard verification

| Harness | `agent.yaml` | `dependencies.lock` |
| --- | --- | --- |
| dsh | Required | Required |
| dify | Optional | Required |
| pi | Optional | Optional |
| hermes | Required | Required |
| deepagents | Required | Required |
| jiuwenswarm | Optional | Optional |

A required `agent.yaml` may contain `{}` when no model is selected. The common model shape is:

```yaml
model:
  provider: ${AGENT_MODEL_PROVIDER}
  model: ${AGENT_MODEL_NAME}
```

If `model` is supplied, both `provider` and `model` must be strings. Credentials are supplied separately. DSH, Pi, Hermes, and jiuwenswarm resolve environment placeholders during installation when applying bundle model settings; native mode can preserve host settings. Dify can bind models into workflow LLM nodes. deepagents performs model binding in its composition code at runtime; the installer does not implement that binding for you.

For DSH, Dify, Hermes, and deepagents, standard verification checks root `dependencies.lock` existence, not a universal lock schema or dependency resolution. A mapping such as `lockfileVersion: 1` is sufficient for that existence check, but is not a real dependency pin. Pi has its own optional JSON lock format described below.

<a id="dsh"></a>

## DSH

### Directory tree

```text
demo-dsh/
├── bundle.yaml
├── agent.yaml
├── dependencies.lock
└── plugins/demo/
    ├── package.json
    ├── patch.yml
    └── lib/index.js
```

### `bundle.yaml`

```yaml
kind: dsh-agent-bundle
schemaVersion: 1
name: demo-dsh
harness:
  name: dsh
  version: ">=0.1.6-alpha.1 <0.2"
entry: ./agent.yaml
lockfile: ./dependencies.lock
plugins:
  - path: ./plugins/demo
```

| Field | Rule |
| --- | --- |
| `plugins` | Required: non-empty list of objects; each `path` points to a plugin directory. |
| `entry` | Optional existing path; conventionally `./agent.yaml`. Does not relocate the root agent configuration. |
| `lockfile` | Optional existing path; does not replace the root `dependencies.lock` requirement. |

Each plugin needs a `package.json` with a loadable built JavaScript entry (`main` or supported `exports["."]`) and `dsh.bundle.patch`. Both paths must stay inside the plugin and exist. For example:

```json
{
  "name": "@example/demo-dsh",
  "version": "1.0.0",
  "main": "./lib/index.js",
  "dsh": {
    "bundle": {
      "patch": "./patch.yml"
    }
  }
}
```

`patch.yml` must be a real Cordis patch for the target DSH runtime; `lib/index.js` must implement its plugin entry. Their contents are harness-owned, not defined by the Bundle manifest schema. A file existing is insufficient to prove a plugin will execute.

<a id="dify"></a>

## Dify

### Directory tree

```text
demo-dify/
├── bundle.yaml
├── dependencies.lock
├── workflow.yaml
└── agent.yaml              # optional / 可选
```

### `bundle.yaml`

```yaml
kind: dify-agent-bundle
schemaVersion: 1
name: demo-dify
harness:
  name: dify
  version: ">=1.0 <2.0"
entry: ./workflow.yaml
```

| Field | Rule |
| --- | --- |
| `entry` | Required: relative path to an exported Dify workflow DSL file. |

Use a workflow DSL exported by your target Dify service as `workflow.yaml`; do not substitute the Bundle manifest for the DSL. Static Bundle verification checks its path, not the complete Dify graph schema. Importability, installed Dify plugins, node validity, and execution must be checked against the service. No `plugins` list is required in `bundle.yaml`.

Optional `agent.yaml` supports the common model block and this `human_input` block:

```yaml
human_input:
  webapp_delivery: true
  default_action: approve
  action_title: Approve
```

`webapp_delivery` is a boolean (default false), `default_action` is a string (default `approve`), and `action_title` is a display title (default `Approve`). These settings apply to workflow human-input nodes.

<a id="pi"></a>

## Pi

### Directory tree

```text
demo-pi/
├── bundle.yaml
├── agent.yaml              # optional / 可选
├── settings.json
├── agent/instructions.md
├── skills/demo/SKILL.md
└── extensions/demo/
    ├── package.json
    └── index.js
```

### `bundle.yaml`

```yaml
kind: pi-agent-bundle
schemaVersion: 1
name: demo-pi
harness:
  name: pi
  version: ">=0.1 <0.2"
instructions: ./agent/instructions.md
skills: ./skills
settings: ./settings.json
extensions:
  - ./extensions/demo
```

| Field | Rule |
| --- | --- |
| `instructions` | Required: path to an existing instruction file. |
| `skills` | Required: skill file or directory. Every discovered `SKILL.md` needs YAML frontmatter with a non-empty `description`. |
| `settings` | Required: JSON object file. `defaultProvider` and `defaultModel`, if present, must be strings. |
| `extensions` | Required: non-empty list of relative paths to extension files or Pi package directories; entries are strings, not `{path}` objects. |
| `lockfile` | Optional JSON lock file, with additional validation described below. |

Use `{}` as a minimal `settings.json`. The adapter owns resource mapping keys `packages`, `extensions`, and `skills`; do not use settings to redirect those resources. A package extension can declare:

```json
{
  "name": "@example/demo-pi",
  "version": "1.0.0",
  "type": "module",
  "pi": {
    "extensions": [
      "./index.js"
    ]
  }
}
```

`pi.extensions` entries are relative to the package directory and must resolve to existing files (filename `*` patterns are supported). Alternatively, the parser accepts an `extensions/` convention directory or a package entry. Ship code and its relative imports; runtime `dependencies` must not be non-empty, since local installation does not run npm install or copy node_modules. Host-provided imports should be declared as peer dependencies; acceptance by static checks does not install those peers.

Example `skills/demo/SKILL.md`:

```markdown
---
name: demo
description: Help summarize a document.
---
Summarize the supplied document clearly.
```

If you declare `lockfile: ./dependencies.lock`, use a JSON object. Python entries use `package` (non-empty string) and `kind` (`required` or `optional`):

```json
{
  "python": {
    "packages": [
      {
        "package": "pypdf==5.0.0",
        "kind": "optional"
      }
    ]
  }
}
```

If `vendor/officecli/officecli` (Windows: `officecli.exe`) is present, the lock must pin its actual hash at `officecli.assets["<platform>-<arch>"].sha256`, for example `win32-x64`; mismatch fails validation. Pi digest excludes `dist/` and `.venv/`, but extension entry files must still exist: build before verification.

<a id="hermes"></a>

## Hermes

### Directory tree

```text
demo-hermes/
├── bundle.yaml
├── agent.yaml
├── dependencies.lock
└── plugins/demo/
    ├── plugin.yaml
    └── __init__.py
```

### `bundle.yaml`

```yaml
kind: hermes-agent-bundle
schemaVersion: 1
name: demo-hermes
harness:
  name: hermes
  version: ">=0.21.0 <0.22"
entry: ./agent.yaml
lockfile: ./dependencies.lock
plugins:
  - path: ./plugins/demo
```

| Field | Rule |
| --- | --- |
| `plugins` | Required: non-empty list of `{path}` objects pointing to plugin directories. |
| `entry` | Optional existing path; conventionally `./agent.yaml`. Root `agent.yaml` is still read. |
| `lockfile` | Optional existing path; root `dependencies.lock` is still required. |

Each plugin directory needs a `plugin.yaml`. Its `name` must be a non-empty string matching the bundle name pattern. A typical metadata file is:

```yaml
name: demo
version: 1.0.0
description: Demo Hermes plugin
```

Bundle validation checks the plugin name, not the entire native plugin contract. Include the implementation and any files required by your Hermes version; `__init__.py` is an illustrative implementation file, not a Bundle-required filename. Installation copies and enables the plugin.

<a id="deepagents"></a>

## deepagents

### Directory tree

```text
demo-deepagents/
├── bundle.yaml
├── agent.yaml
├── dependencies.lock
├── langgraph.json
├── agent.py
├── pyproject.toml
└── plugins/demo/
    └── __init__.py
```

### `bundle.yaml`

```yaml
kind: deepagents-agent-bundle
schemaVersion: 1
name: demo-deepagents
harness:
  name: deepagents
  version: ">=0.7,<0.8"
entry: ./langgraph.json
lockfile: ./dependencies.lock
plugins:
  - path: ./plugins/demo
```

| Field | Rule |
| --- | --- |
| `entry` | Required: path to a LangGraph JSON configuration. |
| `plugins` | Required: non-empty list of `{path}` objects. Each target must exist inside the bundle. |
| `lockfile` | Optional existing path; root `dependencies.lock` is still required. |

`langgraph.json` must contain `graphs.agent` with a `<module>:<attribute>` reference. The module path is relative to the JSON file directory and must exist within that directory boundary. Keep the JSON at the bundle root for this layout:

```json
{
  "graphs": {
    "agent": "./agent.py:agent"
  },
  "dependencies": [
    "."
  ]
}
```

`agent.py` must expose a real graph as `agent`. The static parser checks the module file, not whether the attribute is a runnable graph. Implement graph composition and runtime model binding there. The installer installs the bundle root with `pip install -e` (or uv equivalent), so provide valid Python packaging; for example:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "demo-deepagents"
version = "1.0.0"
requires-python = ">=3.11"

[tool.setuptools]
py-modules = ["agent"]
```

Add the actual graph dependencies and plugin packaging/import configuration used by your code. `plugins` declarations are checked for existence; they do not install every directory as a separate Python package. Installation is editable and continues to depend on the source bundle: retain it. Runtime state `.langgraph_api/` and directories ending in `egg-info` are excluded from digest.

<a id="jiuwenswarm"></a>

## jiuwenswarm

### Directory tree

```text
demo-jiuwenswarm/
├── bundle.yaml
├── agent.yaml              # optional / 可选
├── config.yaml
├── skills/demo/SKILL.md
├── packages/demo/
│   └── manifest.json
└── templates/
    └── agent/workspace/AGENT.md
```

### `bundle.yaml`

```yaml
kind: jiuwenswarm-agent-bundle
schemaVersion: 1
name: demo-jiuwenswarm
harness:
  name: jiuwenswarm
  version: ">=0.2,<0.3"
skills: ./skills
packages:
  - path: ./packages/demo
    kind: agent_template
connectors:
  - document-service
templates: ./templates
config: ./config.yaml
```

| Field | Rule |
| --- | --- |
| `skills` | Optional: a file named `SKILL.md`, or a non-empty directory whose immediate children are skill directories containing `SKILL.md`. |
| `packages` | Optional: non-empty list of `{path, kind}`; kind is `agent_template`, `plugin`, or `agent_group`. |
| `connectors` | Optional: non-empty list of distinct, non-blank connector names. Must include every package dependency declared via `mcps[].connector`. |
| `templates` | Optional: directory copied into the isolated home as a baseline. |
| `config` | Optional: YAML mapping file merged into `<home>/config/config.yaml`. |
| `lockfile` | Optional existing path; no mandatory root lock file. |

All resource fields in this example are optional independently; the tree shows a bundle using every resource class. With only the common fields, the manifest also parses, but supplies no agent resources. Each native package needs `manifest.json`, whose `package_type` must equal the declared package `kind`:

```json
{
  "id": "demo",
  "package_type": "agent_template"
}
```

A missing/empty string `id` falls back to the package directory basename. This JSON shows only Bundle-checked metadata, not a complete native agent template: include the native implementation and metadata required by your runtime. If package metadata declares `mcps[].connector`, list every name under bundle `connectors`; these are dependency hints, not automatically registered MCP servers or credentials.

`config.yaml` must be a YAML mapping (`{}` is valid). `templates/` is copied first, then declared skills/packages and configuration are overlaid. Skills are copied to `<home>/agent/workspace/skills/`. Connector registration and authentication remain host responsibilities.

## Validate your bundle

```bash
agent-bundle verify ./my-bundle --level standard
agent-bundle verify ./my-bundle
agent-bundle verify ./my-bundle --level standard --expect-digest sha256:<64-hex-characters>
```

Start with `standard` static verification; the second command additionally trial-installs and uninstalls, requiring the target runtime/service. `minimal` skips agent configuration and the standard root lockfile checks, so it does not establish installability. Static success does not prove native plugin loading or successful task execution. Test with your actual harness and credentials before delivery.

All kinds exclude `node_modules/`, `.git/`, and `__pycache__/` from digest. Exclusion from digest is not permission to omit required built entry files. Keep credentials out of delivered bundles.
