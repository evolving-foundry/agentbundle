# Agent Bundle

[English](README.md) | [简体中文](README.zh-CN.md)

Agent Bundle 将一个 Agent 的指令、配置、Skills、插件和运行入口组织为一个目录，并通过 `bundle.yaml` 声明目标 agent harness。Harness 是加载和执行 Agent 的运行时。

本项目提供 `agent-bundle` 命令行工具和 `agent-bundle-core` TypeScript SDK，通过各 harness 的适配器统一完成 Bundle 的校验、安装、登记和卸载。

## 有什么用？

- 将 Agent 作为一组有明确运行时契约、可版本管理的资源交付。
- 安装前检查资源，计算内容摘要（digest）。
- 使用统一入口安装，同时遵循各 harness 的资源布局。
- 管理安装记录，复用相同内容，并卸载已安装资源。
- 在隔离 home 中试装 Bundle。

每个 Bundle 面向特定 harness，适配器不会将 Agent 自动转换到另一种运行时。目标运行时需另行安装，凭据按对应 harness 的方式提供。安装完成后，仍需启动 harness 执行任务。

## 支持哪些 Harness？

| Harness | Manifest `kind` | 适配方式 | 详细介绍 |
| --- | --- | --- | --- |
| DSH | `dsh-agent-bundle` | 安装原生插件和 profile 配置。 | [格式说明](./docs/bundle-formats.zh-CN.md#dsh) |
| Dify | `dify-agent-bundle` | 通过 Console API 导入工作流 DSL；需要运行中的 Dify 服务和 Console 凭据。 | [格式说明](./docs/bundle-formats.zh-CN.md#dify) |
| Pi | `pi-agent-bundle` | 映射指令、Skills、扩展和配置；使用 `harness.name: pi`。 | [格式说明](./docs/bundle-formats.zh-CN.md#pi) |
| Hermes | `hermes-agent-bundle` | 复制并启用目录插件，写入模型选择。 | [格式说明](./docs/bundle-formats.zh-CN.md#hermes) |
| deepagents | `deepagents-agent-bundle` | 创建隔离 Python 环境，以 editable 模式安装 Bundle 包；需要 uv 或 Python ≥ 3.11。 | [格式说明](./docs/bundle-formats.zh-CN.md#deepagents) |
| jiuwenswarm | `jiuwenswarm-agent-bundle` | 在隔离数据根目录中物化 templates、skills、packages 和配置。 | [格式说明](./docs/bundle-formats.zh-CN.md#jiuwenswarm) |

## 快速使用

需要 Node.js ≥ 22 和 pnpm（版本见 `package.json`）。在仓库根目录执行：

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.mjs --help
```

下文中的 `agent-bundle` 可以替换为 `node packages/cli/dist/bin.mjs`，也可以全局安装构建后的 CLI：

```bash
cd packages/cli
pnpm add -g .
```

准备一个面向受支持 harness 的 Bundle。具体资源字段和必需文件由 `kind` 决定。

```bash
# 静态校验，不安装
agent-bundle verify ./my-bundle --level standard

# 校验、隔离试装，再卸载
agent-bundle verify ./my-bundle

# 安装；记录返回的安装 id 和启动信息
agent-bundle install ./my-bundle
agent-bundle list

# 卸载指定安装
agent-bundle uninstall --id <installation-id>
```

安装后，根据返回的启动信息使用对应 harness 运行 Agent。模型凭据和 provider 注册遵循该 harness 的惯例。

### 选项与安装行为

- DSH、Pi、Hermes 的 CLI 默认使用 native 模式，复用 harness home。`--home <dir>` 改为隔离安装；卸载会删除整个目录，请使用专用目录。
- Native 卸载只删除 Bundle 所属资源。Dify 还会通过 API 创建和删除远端资源。
- `install --profile <name>` 指定 DSH / Pi native profile；`install --force` 强制重装相同内容。
- `verify --expect-digest sha256:<hex>` 检查内容摘要。`minimal` 和 `standard` 级别执行静态校验；CLI 默认的 `install` 级别会试装，需要对应运行时或服务。
- `--json` 输出机器可读结果。退出码：`0` 成功、`1` 操作失败、`2` 用法错误。
- `AGENT_BUNDLE_REGISTRY` 可覆盖默认登记文件 `~/.agent-bundle/installations.json`。

运行时可通过 `DSH_BIN` / `DSH_CHECKOUT`、`PI_BIN` / `PI_CHECKOUT`、`HERMES_BIN`、`UV_BIN` / `PYTHON_BIN`、`JIUWENSWARM_BIN` / `JIUWENSWARM_CHECKOUT` 指定。Dify 支持 `DIFY_BASE`，配合 `DIFY_EMAIL` / `DIFY_PASSWORD` 或 `DIFY_ADMIN_API_KEY`。

### TypeScript SDK

```ts
import { createBundleSdk } from 'agent-bundle-core'

const sdk = createBundleSdk()
const info = await sdk.inspect('./my-bundle')
const verified = await sdk.verify('./my-bundle')
console.log(info, verified.digest)
```

SDK 还提供 `pack`、`install`、`activate`、`load`、`uninstall`。SDK 的 `verify` 默认执行 `standard` 静态校验。安装及运行操作按需注入进程执行函数（`runDsh`、`runHermes`、`runPython`）；core 自身不启动进程。SDK 安装模式的默认值可能与 CLI 不同；对接已有 harness home 时，在支持的适配器中显式选择 `mode: 'native'`。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

真实运行时 e2e 在缺少前提条件时自动跳过。通过 `AGENT_BUNDLE_DSH_REPO`、`AGENT_BUNDLE_PI_REPO`、`AGENT_BUNDLE_LANGGRAPH_REPO`、`AGENT_BUNDLE_JIUWENSWARM_REPO` 指定外部夹具仓库。默认使用用户主目录下的 `Example-DSH`、`Pi`、`Example-LangGraph`、`Example-Jiuwenswarm`。夹具名称需与测试一致，包括 `bundles/pi`、`bundles/example-jw`。

**Pi 迁移提示：**旧版带品牌名称的 manifest 需要将 `harness.name` 改为 `pi`。外部夹具的包名、路径、命令断言也需要对齐测试中的中性名称。内容改名会改变 digest，应重新校验并安装。
