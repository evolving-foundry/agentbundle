# Bundle 编写指南

[English](bundle-formats.md) | [简体中文](bundle-formats.zh-CN.md) · [README](../README.zh-CN.md)

本文依据当前仓库解析器与标准校验规则编写。下文的 schema 指字段、类型、必填性和文件约束；项目目前不提供独立 JSON Schema。目录树是建议的交付物源目录，不是安装后的 home。示例版本仅演示兼容范围写法，不代表已完成对应运行时认证。

[dsh](#dsh) · [dify](#dify) · [pi](#pi) · [hermes](#hermes) · [deepagents](#deepagents) · [jiuwenswarm](#jiuwenswarm)

## 通用规则

| 字段 | 规则 |
| --- | --- |
| `kind` | 必填字符串，必须为下文六种选择器之一。 |
| `schemaVersion` | 必填数字 `1`，不是字符串 `"1"`。 |
| `name` | 必填字符串，匹配 `^[a-z0-9][a-z0-9-]*$`，如 `demo-agent`。 |
| `harness.name` | 必填字符串，必须与所选 harness 对应。 |
| `harness.version` | 必填非空字符串，范围值加引号。Pi 额外校验范围语法；版本匹配按适配器处理，静态校验不保证运行时兼容。 |

除特别说明外，声明的路径均相对 Bundle 根目录。使用 `./...`，目标必须位于 Bundle 内，避免绝对路径及 `..`，并包含所有引用文件。digest 遍历遇到符号链接会拒绝。未知字段不能作为通用扩展机制：当前解析器没有统一的 `additionalProperties: false` 规则。

### 标准校验所需的根目录文件

| Harness | `agent.yaml` | `dependencies.lock` |
| --- | --- | --- |
| dsh | 必需 | 必需 |
| dify | 可选 | 必需 |
| pi | 可选 | 可选 |
| hermes | 必需 | 必需 |
| deepagents | 必需 | 必需 |
| jiuwenswarm | 可选 | 可选 |

不选择模型时，必需的 `agent.yaml` 可写为 `{}`。通用模型结构为：

```yaml
model:
  provider: ${AGENT_MODEL_PROVIDER}
  model: ${AGENT_MODEL_NAME}
```

提供 `model` 时，`provider` 和 `model` 都必须为字符串，凭据另行提供。DSH、Pi、Hermes、jiuwenswarm 应用 Bundle 模型配置时在安装阶段解析环境占位符；native 模式可能保留宿主配置。Dify 可将模型绑定到工作流 LLM 节点。deepagents 由组合入口代码在运行时完成模型绑定，安装器不会替你实现该逻辑。

DSH、Dify、Hermes、deepagents 的标准校验检查根目录 `dependencies.lock` 存在，不校验统一锁格式，也不保证依赖解析。`lockfileVersion: 1` 这样的对象能满足存在性检查，但不能视为真实依赖锁定。Pi 的可选锁文件有自己的 JSON 格式，见下文。

<a id="dsh"></a>

## DSH

### 目录树

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

| 字段 | 规则 |
| --- | --- |
| `plugins` | 必填：非空对象列表，每项 `path` 指向插件目录。 |
| `entry` | 可选，指向现有路径，惯例为 `./agent.yaml`；不会改变根目录 Agent 配置的读取位置。 |
| `lockfile` | 可选，指向现有路径；不能替代根目录必需的 `dependencies.lock`。 |

每个插件需要 `package.json`，声明已构建的 JavaScript 入口（`main` 或受支持的 `exports["."]`）和 `dsh.bundle.patch`；两个路径都必须位于插件内且存在。例如：

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

`patch.yml` 应为目标 DSH 可加载的 Cordis patch，`lib/index.js` 应实现插件入口。这些内容由 harness 约定，不由 Bundle manifest schema 定义；文件存在不代表插件一定可运行。

<a id="dify"></a>

## Dify

### 目录树

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

| 字段 | 规则 |
| --- | --- |
| `entry` | 必填：指向导出的 Dify 工作流 DSL 文件的相对路径。 |

`workflow.yaml` 使用目标 Dify 服务导出的工作流 DSL，不要用 Bundle manifest 替代 DSL。Bundle 静态校验检查入口路径，不检查完整 Dify 图 schema；导入、已安装插件、节点合法性和执行需对接服务验证。`bundle.yaml` 不要求 `plugins` 列表。

可选 `agent.yaml` 支持通用模型块，以及以下 `human_input` 块：

```yaml
human_input:
  webapp_delivery: true
  default_action: approve
  action_title: Approve
```

`webapp_delivery` 为布尔值，默认 false；`default_action` 为字符串，默认 `approve`；`action_title` 为显示标题，默认 `Approve`。配置用于工作流中的 human-input 节点。

<a id="pi"></a>

## Pi

### 目录树

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

| 字段 | 规则 |
| --- | --- |
| `instructions` | 必填：指向现有指令文件。 |
| `skills` | 必填：Skill 文件或目录。发现的每个 `SKILL.md` 都需 YAML frontmatter 和非空 `description`。 |
| `settings` | 必填：JSON 对象文件；若提供 `defaultProvider`、`defaultModel`，必须为字符串。 |
| `extensions` | 必填：扩展文件或 Pi 包目录的相对路径非空列表；每项为字符串，不是 `{path}` 对象。 |
| `lockfile` | 可选 JSON 锁文件，额外校验见下文。 |

最小 `settings.json` 可写为 `{}`。适配器拥有 `packages`、`extensions`、`skills` 资源映射键，不要在 settings 中重定向这些资源。包形式的扩展可以声明：

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

`pi.extensions` 相对包目录，必须匹配存在的文件，支持文件名中的 `*`。也可使用 `extensions/` 惯例目录或包入口。交付代码及其相对导入文件；运行时 `dependencies` 不能为非空对象，因为本地安装不执行 npm install，也不复制 node_modules。宿主提供的导入应声明为 peer dependencies；静态检查接受导入不代表安装了这些 peer。

`skills/demo/SKILL.md` 示例：

```markdown
---
name: demo
description: Help summarize a document.
---
Summarize the supplied document clearly.
```

若声明 `lockfile: ./dependencies.lock`，文件需为 JSON 对象。Python 依赖项使用 `package` 非空字符串和 `kind`（`required` 或 `optional`）：

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

若包含 `vendor/officecli/officecli`（Windows 为 `officecli.exe`），锁文件必须在 `officecli.assets["<platform>-<arch>"].sha256` 记录真实哈希，如 `win32-x64`；不匹配会校验失败。Pi digest 排除 `dist/`、`.venv/`，但扩展入口仍必须存在，请先构建再校验。

<a id="hermes"></a>

## Hermes

### 目录树

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

| 字段 | 规则 |
| --- | --- |
| `plugins` | 必填：非空 `{path}` 对象列表，指向插件目录。 |
| `entry` | 可选现有路径，惯例为 `./agent.yaml`；仍读取根目录 `agent.yaml`。 |
| `lockfile` | 可选现有路径；根目录仍需 `dependencies.lock`。 |

每个插件目录需要 `plugin.yaml`，其 `name` 必须为非空字符串并匹配 Bundle 名称规则。典型元数据文件为：

```yaml
name: demo
version: 1.0.0
description: Demo Hermes plugin
```

Bundle 校验检查插件名，不覆盖原生插件的完整契约。请包含目标 Hermes 版本所需的实现和资源；图中的 `__init__.py` 是示意实现文件，不是 Bundle 强制文件名。安装器会复制并启用插件。

<a id="deepagents"></a>

## deepagents

### 目录树

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

| 字段 | 规则 |
| --- | --- |
| `entry` | 必填：LangGraph JSON 配置路径。 |
| `plugins` | 必填：非空 `{path}` 对象列表，目标必须存在于 Bundle 内。 |
| `lockfile` | 可选现有路径；根目录仍需 `dependencies.lock`。 |

`langgraph.json` 必须包含 `graphs.agent`，值为 `<module>:<attribute>`。模块路径相对该 JSON 的目录，必须存在且不能越出该目录边界。按此布局将 JSON 放在 Bundle 根目录：

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

`agent.py` 应导出名为 `agent` 的真实图对象。静态解析检查模块文件，不验证属性是否为可运行图。图组合和运行时模型绑定需在此实现。安装器通过 `pip install -e`（或 uv 等价命令）安装 Bundle 根目录，因此需提供有效 Python 包配置，例如：

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

请补充代码实际使用的图依赖及插件打包、导入配置。`plugins` 声明只检查目标存在，不会逐个作为独立 Python 包安装。安装采用 editable 模式，运行仍依赖源 Bundle，请保留源目录。digest 排除 `.langgraph_api/` 及以 `egg-info` 结尾的目录。

<a id="jiuwenswarm"></a>

## jiuwenswarm

### 目录树

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

| 字段 | 规则 |
| --- | --- |
| `skills` | 可选：名为 `SKILL.md` 的文件，或非空目录；其直接子项必须为含 `SKILL.md` 的目录。 |
| `packages` | 可选：非空 `{path, kind}` 列表；kind 为 `agent_template`、`plugin`、`agent_group`。 |
| `connectors` | 可选：非空、无重复、无空白名称的 connector 列表；必须覆盖包中 `mcps[].connector` 声明的依赖。 |
| `templates` | 可选：复制到隔离 home 的基础目录。 |
| `config` | 可选：YAML 对象文件，合并到 `<home>/config/config.yaml`。 |
| `lockfile` | 可选现有路径；不强制根目录锁文件。 |

示例中的资源字段均可分别省略；目录树展示同时使用各类资源的布局。只提供通用字段也能解析，但不会提供 Agent 资源。每个原生包需要 `manifest.json`，其中 `package_type` 必须与声明的包 `kind` 一致：

```json
{
  "id": "demo",
  "package_type": "agent_template"
}
```

缺少或空字符串 `id` 时回退到包目录名。此 JSON 只展示 Bundle 检查的元数据，不是完整原生 Agent 模板；还需提供运行时要求的实现与元数据。若包元数据声明 `mcps[].connector`，Bundle 的 `connectors` 必须覆盖所有名称；这些是依赖提示，不会自动注册 MCP 服务或凭据。

`config.yaml` 必须为 YAML 对象，`{}` 有效。安装时先复制 `templates/`，再叠加声明的 Skills、包和配置。Skills 写入 `<home>/agent/workspace/skills/`。Connector 注册与认证由宿主负责。

## 校验 Bundle

```bash
agent-bundle verify ./my-bundle --level standard
agent-bundle verify ./my-bundle
agent-bundle verify ./my-bundle --level standard --expect-digest sha256:<64-hex-characters>
```

先执行 `standard` 静态校验；第二条命令还会试装并卸载，需要目标运行时或服务。`minimal` 跳过 Agent 配置及标准级别的根锁文件检查，不能据此认定可安装。静态通过不保证原生插件成功加载或任务成功执行，交付前需使用真实 harness 与凭据验证。

所有类型的 digest 都排除 `node_modules/`、`.git/`、`__pycache__/`。digest 排除不代表可省略必需的已构建入口文件。不要在交付 Bundle 中放入凭据。
