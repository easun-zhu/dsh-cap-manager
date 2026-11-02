# dsh-cap-manager 完整设计文档

> 一款 DeepSeek Harness（dsh）插件：在 Web UI 中统一管理 **MCP 服务** 与 **Skills**，支持全局 / Profile / 项目三个作用域的查看、新增、编辑、删除、开关，并尽可能实时生效。

| | |
|---|---|
| 插件包名 | `dsh-cap-manager`（备选：`dsh-mcp-skill-manager`，搜索发现性更好） |
| UI 名称 | MCP & Skills（侧边栏独立面板） |
| 形态 | 标准 dsh dual-half bundle（宿主半 + 浏览器半） |
| 目标版本 | **最低支持 0.2.1**：`>=0.2.1-rc.2`（覆盖 0.2.1 全线 rc 与 0.2.2-alpha；更旧版本一概不支持） |
| 仓库 | 本目录（`dsh-pm`），MIT |

> **版本策略**：下限 `0.2.1-rc.2`（npm `latest` tag 所在，也是 0.2.1 线的最早可装版），向上兼容 `next`(0.2.1-rc.4) 与 `alpha`(0.2.2-alpha.2)。**不设多版本兼容矩阵**，只在两端验证：最低 rc.2 与最新 alpha。已核实 `0.2.1-rc.2 → 0.2.1-rc.4 → master(0.2.2-alpha.2)` 区间内我方全部 API 触点的漂移：
>
> | 触点 | 漂移 | 结论 |
> |---|---|---|
> | `packages/mcp/mcp-client/src` | rc.2→rc.4 仅 `connection.ts` 19 行（重连微调）；rc.4→HEAD **零变化** | ✅ 稳定 |
> | plugin-manager `listPlugins`/`setPluginEnabled`/`patch.ts` | 签名未变（新增的是版本管理/git 传输等无关特性） | ✅ 稳定 |
> | config-editor / hmr | ±5 / ±8 行注释级 | ✅ 稳定 |
> | skill / skill-filesystem | skill 零变化；filesystem 15 行微调 | ✅ 稳定 |
> | client bundle 契约 | 仅**新增**可选 `require.asset()`（0.2.2-alpha 起，默认直通） | ✅ 增量兼容 |
>
> 上游后续 release 若破坏兼容，直接升 `engines.dsh` 下限，不写版本分支。

---

## 1. 目标与非目标

### 目标

1. **统一入口**：一个面板同时管 MCP 服务和 Skills，不需要手改任何 YAML / Markdown。
2. **三个作用域**（MCP）：全局（所有 profile 生效）、Profile（如 web）、项目（仅当前项目）。
3. **两个作用域**（Skills）：全局（`~/.dsh/skills` 等）、项目（`<项目根>/.dsh/skills` 等）；插件内置 skill 只读展示。
4. **完整 CRUD + 开关**：查看（含实时状态）、新增、编辑、删除、启用/停用开关（停用不丢配置）。
5. **实时生效**：Skills 天然热更新；MCP 依赖 HMR 热重载（web profile 默认开启），改动只重载受影响的 server 连接，无需重启。
6. **导入迁移**：一键导入 Claude / Cursor / Cline / Roo / VS Code 的 `mcpServers` JSON，带预览与合并策略。
7. **连接测试**：新增/编辑时先测连通（不污染会话工具表），再落盘。

### 非目标（v1 不做）

- MCP OAuth 授权流（dsh 的 mcp-client 仅支持静态 `headers`，见 `packages/mcp/mcp-client/src/index.ts:80-97`；Bearer token 走 header + 环境变量表达式）。
- 跨 profile 管理（plugin-manager 同样的约束：只管当前 profile，不动其他 profile）。
- 修改 agent preset 内嵌的 MCP 行（只读展示 + 提示）。
- 在线 MCP registry / 抓取 GitHub topic 的市场（v1 只做模板下拉 + URL 安装，见 §7.5；在线目录放 v3）。
- 管理其他插件本身（已有官方 ui-plugin-manager，不重复）。

---

## 2. 借鉴分析（热门项目 → 采纳什么）

### 2.1 dsh 生态内

| 项目 | 亮点 | 采纳方式 |
|---|---|---|
| dsh-plugin-setting-mcp (@opendsh) | 保存时只重载受影响 server；开关不动配置字段；显示连接相位 | ✅ 开关语义与状态相位模型直接借鉴 |
| dsh-mcp-manager-ui (imzl-zl) | Claude/Cursor/Cline/Roo/VSCode JSON 导入 + merge/replace 预览；`${TOKEN}`→`!!js process.env.TOKEN` 转换；预置模板；按传输/状态筛选 | ✅ 导入转换规则、模板、筛选全部纳入 |
| dsh-mcp-skills (Lrxc) | ZIP 导入 skills + 去重；15s 连接测试；YAML 有语法错误拒写；`.bak` 备份 | ✅ 拒写策略、备份策略、连接测试超时 |
| dsh-desktop-hub (FlashingChen) | skills 按优先级展示遮蔽关系；HMR 热生效写入；原子写 + 时间戳备份 | ✅ 遮蔽提示、热生效写入路径 |

### 2.2 主流工具

| 工具 | 亮点 | 采纳方式 |
|---|---|---|
| Cursor（`.cursor/mcp.json`） | 项目级配置文件 + 每行开关 + 状态灯（绿/灰） | ✅ 项目级 `.dsh/mcp.yml` + 行级开关 + 状态灯 |
| Claude Code（`/mcp` 命令） | 每个 server 的工具计数、失败工具标记的健康视图 | ✅ 列表显示工具数，失败展开看错误详情 |
| VS Code（`mcp.json`） | 工作区级配置；`promptString` 凭据输入；MCP Marketplace 一键装 | ✅ v1 做凭据占位输入；v3 接市场 |
| MCPBundles / mcpmarket | 目录化发现 | ✅ M5 已做 URL 安装 + 市场索引（内置精选目录后移除，模板下拉保留）；在线市场（registry/topic 抓取）仍留 v3 |

### 2.3 明确不抄的

- Claude Desktop Connectors 的"永远 Checking…"无取消：我们的测试必带取消与超时回报。
- VS Code 的生成 JSON 直接写文件：我们所有写入都过 schema 校验 + 组合结果预检。

---

## 3. 关键设计决策（Decision Records）

### D1 作用域模型

**MCP**（dsh 原生只有 全局/Profile/调用时 三层，无项目级 —— 项目级是本插件的自建约定）：

| 作用域 | 持久化位置 | 生效范围 | 开关机制 |
|---|---|---|---|
| 全局 | `$DSH_HOME/cordis.patch.yml`（home patch） | 所有 profile | 行上 `disabled` 覆盖 |
| Profile | `$DSH_HOME/profiles/<name>/cordis.patch.yml` | 该 profile | 行上 `disabled` 覆盖 |
| 项目 | `<项目根>/.dsh/mcp.yml`（自建格式，见 §5.3） | 挂载期间 | 文件内 `enabled` 字段（false = 不挂载） |

**Skills**（dsh 原生支持，直接对齐）：

| 作用域 | 目录（rank 越小优先级越高） | 可写 |
|---|---|---|
| 项目 | `<项目根>/.dsh/skills`(100)、`<项目根>/.agents/skills`(200) | ✅ |
| 全局 | `~/.dsh/skills`(400)、`~/.agents/skills`(500) | ✅ |
| 插件/内置 | provider/bundled(300/600) | ❌ 只读 |

### D2 全局 MCP 行的开关必须自己写 home patch（不能复用 pluginManager）

**事实**（已核实）：`ctx.pluginManager.setPluginEnabled()` 一律把 `{id, disabled}` 覆盖写进 **profile patch**（`packages/boot/plugin-manager/src/patch.ts:25-78`）。层序为 bundles → profile patch → **home patch** → `--patch`，后写的赢；而 `applyEntryPatches` 会丢弃"指向尚不存在条目"的覆盖（`vendor/include/src/index.ts:117-120`）。因此对**由 home patch insert 出来的行**，profile 里的覆盖排序在其 insert 之前会被丢弃，运行时状态不变，接口只会返回 `'overridden'`。

**决策**：本插件对全局行直接编辑 home patch 文件本体（增/删/改 `disabled`），Profile 行编辑 profile patch 本体；两边都是 HMR 明确监听的文件（`packages/boot/hmr/src/index.ts:384-407`），写入即触发热重载。

### D3 项目级 MCP = 动态挂载（有官方先例）

**事实**：mcp-client 是命名空间插件（导出 `name` / `inject=['tools']` / `Config` / `apply`），第三方可以直接 `ctx.plugin(McpClient, config)` 挂载、销毁即断连——**官方 ACP 插件正是这么做的**（`packages/acp/acp/src/mcp.ts:8,32-33`）。

**决策**：宿主半读 `<项目根>/.dsh/mcp.yml`，在本插件自己的作用域里 diff 式挂载/卸载 mcp-client fiber：
- 挂载跟随**活动会话**：某项目存在活动会话（`session/created`/`session/disposed`，根 = `findProjectRoot(header.cwd)`）或被面板选中（`setActiveProject` 锁）→ 其 `enabled: true` 的 server 被挂载；两者皆失 → 卸载。
- `enabled: false` 仅记录，不挂载（配置保留，借鉴 Cursor）。
- **serverName 全局唯一性由本插件在写入与挂载两个时刻强制预检**（mcp-client 的重名检查按 scope，跨层冲突会以工具名 `mcp__<server>__*` 撞名收场，上游不兜底）。
- 重启后不自动恢复挂载：插件启动时按"当前活动会话的项目"重新读文件挂载（文件是唯一事实源）。
- **已知取舍（M2 实现注记）**：挂在插件作用域（= Host 根作用域）的 fiber，其工具在挂载期间对全 Host 会话可见（dsh-scope 的注册视图向下继承）；真正的 per-Agent 隔离（像 ACP 那样挂进各 Agent 上下文）列为未来改进。"互不串扰"目前指**配置与挂载状态**按项目独立（serverName 冲突预检 + 每项目独立 fiber 组），非工具目录按会话过滤。
- `!!js` 表达式挂载期求值仅支持 `process.env.NAME` 引用与内插它的反引号模板（不做任意求值）；未设置的环境变量按错误处理，在卡片上报错而非静默空串。

### D4 实时生效路径

- **Skills**：天然实时。文件被 Chokidar watcher 监听（含目录不存在时逐段 follow），外部编辑也会触发 `skills/change`（`packages/skill/skill-filesystem/src/index.ts:294-615`）；下一个模型回合自动重发 catalog。UI 监听 `skills/change` 刷新即可。
- **MCP（全局/Profile）**：写入 patch 文件 → HMR watcher 触发 `recomposeProfile` → mcp-client 行级 dispose+recreate，未变的 server 不动（mcp-client HMR-aware）。
- **双保险**：写入后插件再显式 `ctx.get('hmr')?.runExclusive(() => reconcileProfilePatches(root, patches, 'dsh'))`（照抄 config-editor 的做法，`packages/boot/config-editor/src/index.ts:78-152`），避免 watcher 抖动。
- **no-HMR 环境**：操作结果标注 `restart-required`，UI 显示"需重启生效"角标（对应上游 `ChangeResult.application` 语义）。
- **UI 刷新事件**：`cap/changed`（本插件 emit）+ 转发 `skills/change`、`app-boot/config-reload`、`tools/change`（200ms 防抖）。

### D5 MCP 状态获取（上游无公开 API，组合推导）

上游 mcp-client 没有暴露连接状态服务；组合三个信号推导（全部已核实存在）：

| 信号 | 来源 | 推导 |
|---|---|---|
| fiber 状态 | `ctx.on('internal/status', (fiber, old) => ...)`，`FiberState = PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING`（`vendor/cordis/src/events.ts:329-334`） | ACTIVE=已连接（apply 会 await 初始连接 ready）；FAILED=失败（取 `fiber.error` 展示）；LOADING=连接中 |
| 工具表 | `ctx.tools.definitions()` 按 `mcp__<server>__` 前缀计数 + `ctx.on('tools/change')`（`packages/core/tools/src/events.ts:56`） | 工具数；归零且非 disabled ≈ 重连耗尽 |
| 行数据 | `ctx.pluginManager.listPlugins()` + `readProfilePatches('dsh', profile)` 组合 | enabled、配置、来源层 |

最终状态机：`disabled` → **已停用**；否则 fiber ACTIVE → **已连接(±N 工具)**；LOADING/PENDING → **连接中**；FAILED → **失败**；工具数 0 且无 fiber → **已断开**。

### D6 UI 形态：独立 main 面板

`MainPanelId` 是开放的品牌化 string（`packages/client/ui-layout/src/client/service.ts:16`，`Branded<'MainPanelId'>`），第三方可以直接注册新面板 + 侧边栏入口（照抄 `packages/client/ui-plugin-manager/src/client/index.ts:83,129-173` 的双注册）。内容量大（双 tab 卡片列表 + 详情页 + 导入向导），塞进 Settings 弹窗太挤。

### D7 RPC 命名空间与权限

- 宿主半：`TypertRemoteService` 子类，namespace `capabilityManager`，方法 `@Remote` 装饰（范式见 `packages/boot/plugin-manager/src/index.ts`；cookbook：`docs/cookbook/adding-a-remote-api.md`）。
- Web 浏览器端 peer 即 **owner** 主体（`packages/client/connection/src/rpc-host.ts:94`），owner 对所有 action 默认放行（`packages/api/remote-access/src/index.ts:253-257`）——标准 web 会话无需任何额外授权即可调用新命名空间。
- 客户端注册仍包一层 `ctx.remoteAccess.whenAccess('capabilityManager/list', ...)`，与 ui-plugin-manager 一致，面向未来非 owner 主体。

### D8 依赖自持

`base`/`web-app` bundle **不包含** `@deepseek-ai/dsh-mcp-client` 依赖；本插件必须自己声明依赖（否则 profile 里按名字挂载 mcp 行会因解析不到而失败）：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-mcp-client": ">=0.2.1-rc.2",     // 下限与 engines.dsh 一致；上游破坏性变更时同步升
    "@modelcontextprotocol/sdk": "^1.x"                 // 仅用于连接测试
  }
}
```

注意：harness 各包同版本锁步发布，且 npm 上 mcp-client 的 `latest` tag 已过期（停在 0.0.1-rc.1）——依赖必须显式写 `>=0.2.1-rc.2`，不能用 `^0.0.1`/`latest`。CI 保持"锁步升级"冒烟（安装最新 alpha 起本地 profile 验证两端），失败即升下限并修复——这是替代"兼容矩阵"的唯一跟进机制。

---

## 4. 总体架构

```
┌─ 浏览器半（dsh-cap-manager/client.js）──────────────────────────┐
│  apply(ctx)                                                      │
│   ├─ ctx.locale.register('capManager', {zh, en})                 │
│   ├─ ctx.slots.inject('main', …)      → MCP & Skills 页面        │
│   ├─ ctx.slots.inject('sidebar.panellist', …) → 侧边栏入口        │
│   └─ ctx.remote.$mount(capabilityManager 远程桩)                  │
│        ↕ Typert RPC（/api/remote.mux）                            │
├─ 宿主半（dsh-cap-manager，host plugin）──────────────────────────┤
│  CapabilityManagerService extends TypertRemoteService            │
│   ├─ MCP 存储                                                    │
│   │   ├─ PatchWriter：结构化编辑 home/profile cordis.patch.yml    │
│   │   │    （yaml Document 保注释/!!js + 文件锁 + 原子写 + 备份）   │
│   │   │    → HMR watcher 自动热重载 / 显式 reconcile 双保险        │
│   │   └─ ProjectMounter：watch 活动会话项目 → 读 .dsh/mcp.yml      │
│   │        → diff → ctx.plugin(McpClient, config) 挂载/卸载       │
│   ├─ Skills 存储：直接写 SKILL.md（新建/删除/改 frontmatter）       │
│   │    → skill-filesystem watcher 自动生效                        │
│   ├─ StatusTracker：internal/status + tools/change → 状态聚合      │
│   └─ Importer：mcpServers JSON → dsh Config 转换 + 预览            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. 数据模型与存储

### 5.1 patch YAML 中的 MCP 行（全局/Profile）

沿用 dsh 官方文档的行格式，**id 命名约定 `mcp-<serverName>`**（与生态示例一致，便于用户对照手改）：

```yaml
# $DSH_HOME/cordis.patch.yml 或 profiles/<name>/cordis.patch.yml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
      disabled: false        # 开关：只动这一个字段（学 dsh-plugin-setting-mcp）
```

配置 schema 完全对齐上游 `Config`（`packages/mcp/mcp-client/src/index.ts:119-142`）：

- stdio：`transport` / `serverName`（必填，`^[A-Za-z0-9_-]{1,32}$`）/ `command` / `args[]` / `env{}` / `cwd`
- streamable-http：`url` / `headers{}`
- 公共：`toolCallTimeoutMs`(默认 60000) / `failOnStartupError`(默认 false) / `reconnect{enabled,initialDelayMs,maxDelayMs,maxAttempts}` / `maxInstructionBytes`

### 5.2 Skills 存储

- 新增：`<目标根>/<name>/SKILL.md`（目录式，便于附资源文件）。
- frontmatter 序列化规则（上游解析见 `packages/skill/skill-filesystem/src/index.ts:811-854`）：

```yaml
---
name: my-skill              # ^[a-z0-9]+(-[a-z0-9]+)*$  kebab-case，与目录名一致
description: 一句话用途        # 必填非空
whenToUse: 触发时机提示         # 可选
disable-model-invocation: false   # 开关一：模型可见性（默认 false）
user-invocable: true              # 开关二：/名称 手动调用（默认 true）
---
正文（Markdown）…
```

- 开关 = 改写这两个布尔字段（接受 `true/false/yes/no/on/off/1/0` 写入，统一写 `true/false`）；删除 = 删目录（进回收站，见 §10）。
- 注意**同名遮蔽**：删除项目级 skill 后，全局同名 skill 会浮出。UI 在删除确认时检测并提示（`ctx.skills` 不返回被遮蔽者，见下）。

### 5.3 项目级 MCP 文件（自建约定）`<项目根>/.dsh/mcp.yml`

采用业界最熟悉的 `mcpServers` 映射格式（降低迁移心智），字段即 dsh Config + `enabled`：

```yaml
# 由 dsh-cap-manager 维护；也可手改，插件会监听变化重新挂载
mcpServers:
  github:
    enabled: true
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
  docs:
    enabled: false          # 配置保留，不挂载
    transport: streamable-http
    url: https://mcp.example.com/mcp
    headers: { Authorization: '!!js `Bearer ${process.env.DOCS_TOKEN}`' }
```

语义：

- 文件是唯一事实源；挂载状态是派生（跟随活动会话，见 D3）。
- 文件被外部（IDE/git）修改 → watcher 触发重新 diff 挂载（项目级也实时）。
- 版本友好：纯 YAML、无 dsh 私有结构，未来官方若出项目级 MCP 约定可平滑迁移。

---

## 6. 宿主半服务 API

### 6.1 类型定义

```ts
type McpScope = 'global' | 'profile' | 'project'

interface McpConfig {                    // 对齐 dsh-mcp-client Config（脱敏前）
  transport: 'stdio' | 'streamable-http'
  serverName: string
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string   // stdio
  url?: string; headers?: Record<string, string>                                   // http
  toolCallTimeoutMs?: number; failOnStartupError?: boolean; reconnect?: ReconnectConfig
}

interface McpServerEntry {
  id: string                // patch 行 id（mcp-<name>）或项目文件键
  serverName: string
  scope: McpScope
  config: McpConfig         // 敏感值脱敏后返回（见 §10.3）
  enabled: boolean
  status: 'connected' | 'connecting' | 'failed' | 'stopped' | 'disabled'
  toolCount: number
  error?: string            // fiber.error / 挂载错误
  sourceLayer: 'home-patch' | 'profile-patch' | 'preset' | 'project-file'
  managed: boolean          // 是否本插件可写（preset 行 = false，只读）
}

interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  source: 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | string
  scope: 'project' | 'user' | 'plugin'
  path?: string             // 绝对路径；provider 型可能没有
  modelInvocable: boolean
  userInvocable: boolean
  writable: boolean         // 在四个可写根内
  managedByPlugin?: string  // provider 型 skill 的来源插件
}

interface ChangeOutcome {
  applied: boolean
  live: boolean             // 是否已热生效（HMR 在场）
  restartRequired?: boolean
  overridden?: string       // 例：被更高层 overlay 压制时的说明
  warnings?: string[]
}
```

### 6.2 RPC 方法（namespace `capabilityManager`）

| 方法 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `list(request?)` | `{projectRoot?}` | `{ mcp: McpServerEntry[]; skills: SkillEntry[]; project?: {root, title, active, fileError?} }` | 全局/Profile/preset 行 + （带 projectRoot 时）该项目的服务器与挂载状态 + 已启用 CC 插件挂载的服务器（只读 `plugin` 行，带来源插件名，1.2.x） |
| `listProjects()` | — | `ProjectInfo[] = {root, title, liveSessions, hasConfig}` | `workspaceRegistry.list()` ∪ 活动会话根（realpath 归一），活动数排序 |
| `setActiveProject` | `{root?}` | `void` | 面板锁定根（undefined 释放）；锁 = 无会话也保持挂载 |
| `writeMcp` | `{scope, projectRoot?, config: McpConfig, enabled}` | `ChangeOutcome` | 新增或整体覆盖编辑（按 serverName 定位）；scope='project' 写 `.dsh/mcp.yml` |
| `removeMcp` | `{scope, projectRoot?, serverName}` | `ChangeOutcome` | 删行 / 删键（项目） |
| `setMcpEnabled` | `{scope, projectRoot?, serverName, enabled}` | `ChangeOutcome` | 只动 `disabled`/`enabled`，不碰其余字段 |
| `testMcp` | `{config: McpConfig, timeoutMs?}` | `{ok, serverInfo?, toolNames?, error?, durationMs}` | 见 §6.4，默认 15s |
| `importMcp` | `{json: string, mode: 'merge'\|'replace', scope}` | `{preview: ImportDiff}` | **只做解析+预览**；应用由客户端逐条调 `writeMcp/removeMcp`（复用同一校验） |
| `writeSkill` | `{scopeDir: 'project-dsh'\|'project-agents'\|'user-dsh'\|'user-agents', name, description, whenToUse?, content, modelInvocable, userInvocable}` | `ChangeOutcome` | 新建/覆盖（覆盖前备份） |
| `setSkillFlags` | `{path, modelInvocable?, userInvocable?}` | `ChangeOutcome` | 改 frontmatter 布尔 |
| `removeSkill` | `{path}` | `ChangeOutcome` | 移入回收站目录（§10.4），检测同名浮出并警告 |
| `readSkill` | `{path}` | `{content}` | 编辑器回显 |
| `previewMcpImport` | `{json: string}` | `ImportPreview`（条目 + 每条警告 + `${input:}` 清单 + 失败清单） | 解析+转换，不落盘；应用由客户端逐条 `writeMcp`（M4） |
| `exportMcp` | `{projectRoot?, serverName?}` | `{json, skipped}` | 全局+Profile（+选中项目）合并为标准 mcpServers JSON；`!!js` 反还原 `${VAR}`；已停用行跳过（M4）；`serverName` 单行导出（命中停用行也导出——点击即显式意图；未命中抛 `cap/not-found`）（1.1.x） |
| `importSkills` | `{scopeDir, projectRoot?, files: [{path, base64}], overwrite}` | `{imported[], skipped[]}` | ZIP/文件夹/散 .md 统一为文件列表；按 SKILL.md 位置分组、逐字节原样落盘（M4） |
| `readSkillBundleRpc` | `{path}` | `{name, files[]}` | 技能导出打包（目录递归 ≤200 文件/10MB，`.cap-bak-*` 排除）（M4） |
| `listTrash` / `restoreTrash` / `deleteTrash` / `clearTrash` | `{id}` / — | `TrashEntry[]` / `ChangeOutcome` / `ClearTrashResult` | 回收站枚举/恢复/彻底删除/一键清空（返回销毁数；备份不受影响）；新条目带 `trash-meta.json`，旧条目恢复禁用（M4，clearTrash 1.1.x） |
| `listBackups` / `restoreBackup` / `deleteBackup` | `{file}` / — | `BackupEntry[]` / `ChangeOutcome` / `void` | 所有受管文件旁的 `.cap-bak-*`（保留 5 份）；恢复=原子写回目标（HMR/watcher 自动接手）；只接受列表内的路径（M4） |
| `listCcPlugins` | `{refresh?}` | `CcPluginsListResult` | 官方 claude-plugins-official 目录（10min 缓存）+ 已安装叠影（版本/开关/技能数/服务器实时状态/更新标记）（M6） |
| `installCcPlugin` / `updateCcPlugin` | `{name}` | `CcInstallResult` | 下载 tarball → 解包落 store → 技能 provider 注册即时生效 + mcpServers 挂载；更新比对 pin（M6） |
| `uninstallCcPlugin` / `setCcPluginEnabled` | `{name}` / `{name, enabled}` | `ChangeOutcome` | 卸载（卸挂载+删目录+删登记）/ 开关（provider 过滤 + fiber mount/dispose，即时）（M6） |

事件（emit，经 remotes 转发）：`cap/changed`（任何写操作后）、`cap/status`（状态聚合变化，防抖 300ms）。

错误码：`cap/name-conflict`（serverName/skill name 冲突）、`cap/yaml-invalid`（目标 patch 已有语法错误，拒写）、`cap/readonly`（preset 行 / provider skill）、`cap/not-found`、`cap/invalid-config`（schema 校验失败，带字段路径）、`cap/test-timeout`。

### 6.3 patch 写入序列（关键正确性保证）

照抄 config-editor 的六步（`packages/boot/config-editor/src/index.ts:78-152`），落到 home/profile patch：

1. `withFileLock(join(profile.dir, 'package.json'))` 取锁。
2. **先沉降**：`await reconcileProfilePatches(root, readProfilePatches('dsh', profile), 'dsh')` 让当前树与磁盘一致。
3. 解析目标 patch 为 `yaml` Document（注册 `!!js` 自定义 tag），内存中增/删/改行或 `disabled` 字段——**注释与其他行原样保留**。
4. **预检组合结果**：对合成后的完整 entry 列表跑 `composeEntries`，校验 schema、id 不会失联、serverName 全局唯一（跨 home+profile+项目挂载集合）；失败即抛，磁盘未动。
5. `writeFileAtomic(path, text, {mode: 0o600})`，写前先落 `<path>.bak-<ts>` 备份（保留最近 5 份）。
6. `await reconcileProfilePatches(root, patches, 'dsh')` 应用；失败则恢复备份文本并再次 reconcile 回滚。

全序列包在 `ctx.get('hmr')?.runExclusive(fn) ?? fn()` 中；结束 emit `cap/changed`。HMR 缺席时跳过第 6 步的应用语义，返回 `{applied: true, live: false, restartRequired: true}`。

> 与 plugin-manager 的差异：我们写 **home patch 本体**（全局行开关的层序陷阱见 D2），这是本插件存在价值的一部分；不触碰 plugin-manager 的保护清单（`PROTECTED_PLUGINS`）所列行。

### 6.4 连接测试（不污染会话）

不通过 `ctx.plugin(McpClient, …)`（会短暂把 `mcp__test-…` 工具暴露给模型目录），而是**直接用 `@modelcontextprotocol/sdk`** 起独立客户端：

```ts
const transport = cfg.transport === 'stdio'
  ? new StdioClientTransport({ command, args, env: merge(scrubbedParentEnv(), cfg.env), cwd })
  : new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
const client = new Client({ name: 'dsh-cap-manager-test', version })
await withTimeout(client.connect(transport), timeoutMs)   // 默认 15000，可取消
const { tools, serverInfo } = await Promise.all([client.listTools(), client.getServerVersion?.()])
await client.close()
```

stdio 子进程环境沿用上游脱敏规则（`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 从父环境剔除后再合并 config.env，见 `packages/mcp/mcp-client/src/transport.ts` 的 `scrubbedParentEnv`）——所以**令牌必须在表单 env/headers 里显式给**，UI 要有文案说明。

### 6.5 项目挂载器（ProjectMounter）生命周期

```
插件 apply
 └─ ProjectMounter（专用 fork 的子上下文 mountCtx）
     ├─ 订阅：session 启动/结束、workspaceRegistry 变化、UI setProject 选择
     ├─ activeProjects = 有活动会话的项目 ∪ {UI 锁定项目}
     ├─ 对每个 activeProject：
     │    watch(<root>/.dsh/mcp.yml)（Chokidar，上游 skills watcher 同款策略）
     │    parse → 校验 → 与 mountedMap diff
     │    新增/变更 → dispose 旧 fiber；ctx.plugin(McpClient, config)
     │    移除/enabled:false → dispose
     │    冲突（serverName 与 patch 层或他项目撞名）→ 不挂载，记入 status.error
     └─ 会话全部结束且非 UI 锁定 → dispose 该项目全部 fiber
```

### 6.6 Skills 读写细节

- **列目录（M3 实现注记）**：插件**自己扫四个可写根目录**并按上游 rank（project-dsh=100 / project-agents=200 / user-dsh=400 / user-agents=500，低者胜）自算同名胜负——不依赖 `ctx.skills.snapshot()`：无 `scope` 的 snapshot 只返回 invocation-neutral 层（bundled 等），不含用户/项目层（实测 `skills/list` 带 sessionId 才返回用户层）；且 provider 经沙箱 fs 层读非 bundled 根，可见性不可控。snapshot 仅用于补充 my-scan 看不到的来源（bundled/runtime/custom）。`resolveAgentsHome()`（`@deepseek-ai/dsh-home-paths`）；项目根 = 自实现 `findProjectRoot`（向上找 `.git`，语义同上游 `packages/skill/skill-filesystem/src/index.ts:959-969`）。
- **frontmatter 解析**：与上游同规则（name/description 必填、kebab-case、`disable-model-invocation`/`user-invocable` 布尔宽格式、legacy 键拒绝），但**行尾归一 LF 后再喂 `yaml`**——`yaml` 包对"双引号标量闭合引号后的 `\r`"报 `Unexpected scalar at node end`，而上游 js-yaml 宽容（真实 `.agents/skills` 的 CRLF 文件因此曾在首版被误报"无法解析"）。损坏文件不再静默：卡片显式"无法解析"角标 + 可删除。
- **写**：新建/改 frontmatter 直接写文件（原子写 + `.cap-bak-*` 备份，覆盖时保留未知键与注释，开关统一归一 `true/false`）；外部写由 provider 的 watcher 兜住，面板侧刷新可见。
- **删除回收站**：`<DSH_HOME>/cap-manager/trash/<ts>-<name>/`，整目录移入；删除后重扫同名，浮出/遮蔽关系变化以 ChangeOutcome.warnings 报告。
- **cwd 选择**：UI 顶部项目选择器（M2 的同一选择器同时驱动项目 MCP 与项目技能）。

---

## 7. 导入与模板

### 7.1 mcpServers JSON 导入（Claude / Cursor / Cline / Roo / VS Code）

输入容错：接受顶层 `mcpServers` 或直接就是映射；每个值两种形态：

| 来源形态 | 转换 |
|---|---|
| `{command, args, env, cwd}`（stdio） | 直映射 dsh stdio Config |
| `{type: 'http', url, headers}` | → `transport: 'streamable-http'` |
| `{type: 'sse', url, headers}` | 同上映射 + ⚠ 警告"dsh 仅支持 streamable-http，可能不兼容" |
| `${VAR}` / `${env:VAR}`（值内） | → `!!js process.env.VAR`；`${input:…}`（VS Code promptString）→ 表单占位输入，落成 `!!js process.env.<用户命名>` |

规则：

1. `serverName` 逐个过 `^[A-Za-z0-9_-]{1,32}$`；非法自动 slug 化并标记。
2. 与目标作用域现有条目撞名：merge 模式 = 跳过（默认）或改名 `-2`；replace 模式 = 覆盖。
3. **预览差异表**（新增 n / 覆盖 n / 跳过 n + 每行 diff）确认后才逐条执行（复用 `writeMcp` 校验，天然原子+回滚）。

**M4 实现注记**：JSONC 容错（`//`/`/*…*/` 注释 + 尾逗号，字符串内内容不动 — 状态机剥除，VS Code `mcp.json` 直接可导）；顶层 `inputs` 数组的 `promptString` 元数据（description/password）并入 `${input:}` 表单；嵌入型引用转反引号模板（`` !!js `Bearer ${process.env.TOKEN}` ``），**与 `${input:}` 混用时保留字面量 + 警告**（避免 mount 期求值踩到未替换占位）；apply 前逐条替换占位值，缺值条目阻止导入；`streamable-http` 的 `url` 校验放宽接受 `!!js ` 表达式（挂载侧 `evaluateConfig` 本就支持）。

### 7.2 预置模板（新增对话框一键填充）

filesystem / memory / sequential-thinking / fetch / github / puppeteer 起步（对齐 dsh-mcp-manager-ui 的选择，只留最常用六个，避免目录膨胀）。**已实现**：新增表单顶部模板下拉（github 模板带 `GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN` env 预填）。**M5 起模板与精选目录（§7.5）共用同一份数据**（`src/client/catalog.ts` 的 `STARTERS` 子集），起步配置只存一处。

### 7.3 导出

全局/Profile/项目任意作用域 → 导出为标准 `mcpServers` JSON（`!!js process.env.X` 反向还原为 `${X}`），便于跨工具迁移。

**M4 实现注记**：一次导出合并 全局 + Profile + 选中项目（serverName 全层唯一由写入预检保证，合并无冲突）；已停用行跳过并在结果里计数（标准格式无 disabled 位）；密钥以明文导出（用户自取自存，UI 明示）；技能导出：目录技能 → zip（fflate，浏览器侧打包，资源文件随行、`.cap-bak-*` 排除），文件技能 → 原文 `.md`。

**1.1.x 单行导出**：MCP 卡片底部 ⇧ 按钮，导出仅含该行的单条 `mcpServers` JSON（`mcp-server-<name>.json`）；与技能的按卡导出对齐。单行模式不停用跳过（点按钮即显式意图）；项目行自动带上 projectRoot，全局/Profile 行只扫 patch 层。

### 7.4 技能导入（M4）

ZIP（含一层包装目录）/ 文件夹（`webkitdirectory`）/ 散 `.md` 统一为 `{path, base64}[]` 上载（浏览器 fflate 解包，`__MACOSX`/`.DS_Store` 客户端即弃）；宿主按 **SKILL.md 所在目录 = 技能根**分组（deepest-prefix 归属资产文件），frontmatter 校验通过后**逐字节原样落盘**（作者的自定义键/注释/CRLF 全保留）；限制 200 文件 / 单文件 2MB / 总 10MB；路径归一拒绝 `..`/绝对路径/点段（zip-slip）；同名默认跳过，勾选覆盖时先删旧目录。

### 7.5 URL 安装与发布物（M5）

- **模板下拉**：`src/client/catalog.ts` 静态数据（6 个经典起步项，transport/command/args/env 表达式），供给 §7.2 新增表单的模板一键填充 —— **零新增 RPC**，只是数据 + 预填。（M5 原本另带 12 条"精选目录"卡片页，后按需求移除，只保留模板下拉。）
- **URL 安装**：`ImportWizard`（mcpServers JSON）与 `SkillImport`（技能 zip）各加一个 URL 输入，浏览器端 `fetch`（2MB / 10MB 上限，仅 http(s)）后进入与粘贴/选文件**完全相同**的预览/解包管线。抓取在浏览器发生（目标需 CORS 允许，GitHub raw 可用），宿主不加任何网络出口（无 SSRF 面）。
- **发布物**：`market/index.json` —— 官方 plugin-market format-1 索引（`@deepseek-ai/dsh-plugin-market-index` 校验，devDep + 冒烟），托管到任意 http(s) URL 后在 dsh 发现页添加即可安装（npm 源 + `engines.dsh >=0.2.1-rc.2`）；`package.json` 带 `dsh-plugin` keyword 供社区按 GitHub topic 收录。

### 7.6 Claude Code 插件源（M6）

唯一内置源：**Anthropic 官方 `anthropics/claude-plugins-official`**（`.claude-plugin/marketplace.json`，315 个插件；来源三种——仓库内子目录 / `git-subdir`+sha / 整仓 url+sha）。下载/更新/卸载/开关全链路：

- **下载**：宿主半拉取 raw marketplace.json（10 分钟磁盘缓存）→ 按条目来源取 codeload `tar.gz`（64MB/1500 文件/单文件 8MB 上限）→ **自写 USTAR/GNU-longname/pax 解包器**（`extractTar`：目录/符号链接跳过，`..` 拒绝，`__MACOSX` 等垃圾丢弃；`.claude-plugin/` 等点前缀目录合法）→ 子树剥离 tar 根后落 `store/<name>/<version>/`（临时目录 + rename）。fetcher 可注入（测试零网络）。
- **生效**：技能 = `ctx.skills.registerProvider` 自有 provider（`cc-plugins`，rank 550——用户同名技能 400/500 优先，bundled 600 让位；source `claude-plugin` → 面板只读组）；MCP = manifest `mcpServers` 复用 §7.1 转换器 → `ctx.plugin(McpClient)` 动态挂载（与 ProjectMounter 同款 diff/dispose 与跨层重名预检：patch 行 + 项目挂载 + 其他插件）。`commands/agents/hooks` 无 dsh 对应机制，卡片如实标注"未接入的内容"。
- **更新**：**用户点「刷新市场」即做精确判断**——刷新时顺带经 GitHub API 取 marketplace 仓库 HEAD commit sha 作为目录 pin（一次调用；API 失败回退时间戳，回退 pin 与 sha pin 混合时保守不报）。已装插件的比对：外部 git 源比对目录条目 sha，仓库内路径源比对 marketplace HEAD sha（**315 条全部精确**）；有差 → "有更新"角标。点「更新」重下后先做**逐字节内容哈希比对**：相同则只采纳新 pin 不重装（角标收敛），不同才重装（保留启停选择）。网络调用全部带超时（索引/HEAD 20s、tarball 120s），拉取失败回退过期缓存。
- **卸载/开关**：registry.json（原子写 + `.cap-bak`×5）为唯一事实源；停用 = provider 过滤 + invalidate（`skills/change` 即时）+ fiber dispose；卸载 = 卸挂载 + 删目录 + 删登记。启动时按 registry 恢复挂载。
- **面板形态**：已装与市场两区均为 ZCode 市场式**小卡片网格**（`repeat(auto-fill, minmax(226px, 1fr))` 自适应列数；卡片 = 名称+标签行 / 两行截断描述（悬停 title 显全文）/ 作者与按钮沉底对齐）。市场分页加载：首屏 40 张，底部居中「加载更多（还剩 N 个）」逐页追加 40 张；搜索词变化即重置回第一页。

---

## 8. 客户端 UI 设计

**总原则：视觉与交互完全对齐官方 Plugins 页**（`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx`）——**卡片列表 + 分组 + 点击标题进详情页**（master-detail 导航，非抽屉、非弹窗编辑）。官方卡片解剖（`CardHead`，`:429-452`；`PackageCard`，`:533-573`）：

```
┌ card ──────────────────────────────────────────────────┐
│ [图标] 标题(按钮,点击开详情) [Tag…]              [end区] │
│        一行描述（摘要）                                   │
└─────────────────────────────────────────────────────────┘
```

- 标题是拉伸覆盖卡片的按钮（`.cardTitle` + `.cardOpen`），end 区控件浮在其上；
- Tag 带 tone（`info` / `danger` / `neutral`）表达状态；
- 卡片在 `.cards` 列表内，按 `.group` 分组；首载显示 4 张 skeleton 卡（官方 `ListSkeleton` 同构）。

**复用边界**：`Switch` / `Tag` / `StateDot` / `Menu` 直接从 `@deepseek-ai/dsh-client-ui-primitives` 导入（它在平台共享模块表 `PLATFORM_MODULES` 内，`packages/client/web/src/platform.ts:8-15`，可直接 require）。`CardHead` 组件本身**不能跨包导入**（跨包值导入被构建规则禁止），用自有 CSS module 复刻同名结构：`card / cardHead / cardIcon / cardMain / cardTitle / cardDesc / cardEnd` 七个类对照官方 `PluginManagerPage.module.css:351-526`。

### 8.1 页面结构（main 面板，key = `'capabilities' as MainPanelId`）

```
┌ MCP & Skills ────────────────────────── 项目: [▾ my-project] ┐
│ [MCP 服务] [Skills]                   [+ 新增] [⇩ 导入] [⟳]   │
│ 🔍 搜索…   [传输: 全部▾] [状态: 全部▾]                       │
│                                                              │
│ ▾ 全局（2）                                                   │
│ ┌────────────────────────────────────────────────────────┐ │
│ │▣▣ github  [全局][stdio][● 已连接 · 12 工具]     [⬤ Switch]│ │
│ │   npx -y @modelcontextprotocol/server-github            │ │
│ ├────────────────────────────────────────────────────────┤ │
│ │▣▣ search  [全局][http][△ 失败]                  [⬤ Switch]│ │
│ │   https://mcp.example.com/mcp · connect ECONNREFUSED    │ │
│ └────────────────────────────────────────────────────────┘ │
│ ▾ Profile · web（1）                                          │
│ ▾ 项目 · my-project（2）                                      │
│ ┌────────────────────────────────────────────────────────┐ │
│ │▣▣ memory  [项目][stdio][◌ 已停用]               [◯ Switch]│ │
│ │   memorix-mcp                                           │ │
│ └────────────────────────────────────────────────────────┘ │
│ ▾ 插件提供 · 只读（1）                                        │
│ │▣▣ filesystem [插件][stdio]（随插件行启停，无开关）          │
└──────────────────────────────────────────────────────────────┘
```

卡片规则：

- **分组 = 作用域**（全局 / Profile / 项目 / 插件提供只读），与 Plugins 页"官方 / 已安装"分组同构；组头带计数。
- **状态 Tag**（tone）：已连接=`success`（文案含工具数）、连接中=`info`、失败=`danger`（hover `title` 显示 `fiber.error` 详情）、已停用=`neutral`；图标用 `StateDot` 状态灯辅助。
- **end 区：Switch + 「编辑」「删除」按钮**（`Switch`，`packages/client/ui-primitives/src/Switch.tsx:18-27`，完全受控 + 必填 aria label）；编辑/删除也可走标题进详情页操作，卡片上直接给显式入口；只读（插件/preset）行无任何控件。
- 失败卡片整行高亮 `data-cap-status="failed"`（对照官方 `data-plugin-highlight`）；只读组卡片无 Switch。
- 搜索/筛选只过滤当前 tab 的卡片组。

### 8.2 MCP 详情页（点击卡片标题进入）

```
┌ ‹ MCP 服务                                    [⬤ 启用] ──┐
│ [▣▣] github   [全局][stdio][● 已连接 · 12 工具]            │
│ ── 配置 ─────────────────────────── [编辑] [测试连接] ──  │
│  命令 npx -y @modelcontextprotocol/server-github          │
│  环境变量 GITHUB_TOKEN = ••••••（脱敏，留空=不变）          │
│ ── 工具（12）───────────────────────────────────────────  │
│  mcp__github__create_issue   创建 issue      [Schema ▾]   │
│ ── 状态 ────────────────────────────────────────────────  │
│  已连接 · 上次同步 14:32 · 重连策略 默认（500ms→30s ×10）   │
│ ── YAML 源（只读）───────────────────────────── [复制] ──  │
└───────────────────────────────────────────────────────────┘
```

- 顶部是官方 `DetailTop` 同构（`:488-507`）：crumb 返回按钮 + 大图标 + 右侧操作行（启用 Switch）。
- **编辑态**：详情页内联切换（不是对话框）。配置区变表单——作用域（全局/Profile/项目）、名称（`^[A-Za-z0-9_-]{1,32}$`）、传输（stdio/Streamable HTTP）、stdio 字段（命令/参数/工作目录/环境变量键值对）、http 字段（URL/请求头）、高级折叠（超时/启动失败即报错/重连策略）、底部 YAML 预览（只读，展示将写入的行）。底部 `[取消] [保存并生效]`——HMR 缺席时文案为"保存（重启后生效）"。
- 环境变量/请求头值输入框识别 `!!js ` 前缀做表达式高亮，附"插入环境变量表达式"快捷键（生成 `!!js process.env.XXX`）。
- 测试连接结果内联：`✓ 连接成功 · serverInfo · 12 tools` 或错误详情 + 建议操作。
- 工具 Schema 查看器：JSON 折叠树（只读）。

### 8.3 Skills tab：按来源分组的卡片列表

```
│ [MCP 服务] [Skills]                   [+ 新增] [⇩ 导入zip]  │
│ 🔍 搜索…   [来源: 全部▾]                                    │
│ ▾ 项目 · my-project（2）                                    │
│ ┌────────────────────────────────────────────────────────┐ │
│ │▣▣ morph-ppt [项目]              [⬤ Switch][编辑][删除][⇧]│ │
│ │   Use when the user wants a .pptx with smooth cross…    │ │
│ ├────────────────────────────────────────────────────────┤ │
│ │▣▣ demo     [项目][⚠ 遮蔽下层同名] [⬤ Switch][编辑][删除][⇧]│ │
│ └────────────────────────────────────────────────────────┘ │
│ ▾ 全局（2）                                                  │
│ │▣▣ officecli [全局][被项目级遮蔽]  [⬤ Switch][编辑][删除][⇧]│ │
│ ▾ 插件提供 · 只读（3）                                       │
│ │▣▣ dsh-code-review [插件]（随插件行启停，无开关）            │
```

- 卡片 end 区：**单一「启用」开关**（一次 RPC 同时写 `disable-model-invocation` 取反与 `user-invocable`，两标志永远联动）+ 「编辑」「删除」「⇧ 下载」按钮——编辑与删除不必再点标题进详情页（标题点击仍可进）。
- 遮蔽表达：项目级卡片加 warning Tag"遮蔽下层同名"；被遮蔽的全局同名卡加 neutral Tag"被项目级遮蔽"。
- **Skills 详情页**：描述 / whenToUse / 单一「启用技能」勾选框（联动两标志，附说明文案）/ 正文 Markdown 编辑器（编辑态）/ 元信息（路径、来源、frontmatter 源只读查看）/ 操作（复制内容、打开所在目录、删除→回收站）。
- 只读卡（插件提供）：无开关无删除，副文案"由插件行提供，可在 Plugins 页启停该插件"；两标志一致时不加状态 Tag（停用则标"已停用"），罕见的手改混合态仍并列两个明细 Tag。

### 8.4 新增与导入

- **新增 MCP**：页头 `[+ 新增]` 打开一张"空白详情页"（直接复用详情页编辑态），顶部提供模板一键填充（filesystem / memory / sequential-thinking / fetch / github / puppeteer）。
- **导入向导**（对话框，对齐官方安装对话框的 modal 风格）：粘贴 JSON / 选文件 / 选作用域 → 解析预览（**差异卡片列表** + 逐项勾选 + 警告 Tag：sse 不兼容 / 自动改名 / 令牌占位输入）→ 应用进度 + 结果摘要。
- **Skills 导入**：`.zip` 拖入或粘贴 Markdown（单/多 skill，去重不覆盖，学 dsh-mcp-skills）。

### 8.5 i18n 与无障碍

- `ctx.locale.register('capManager', { zh, en })`（zh/en 双 baseline 是 client locale 服务硬要求，`packages/client/locale/src/client/index.ts:319-322`；第三方用不带类型合并的 overload 即可）。
- 所有 Switch 必传 `label`；状态 Tag 用 `tone` + `title`，状态灯用 `StateDot` 配 `aria-hidden`（语义由 Tag 承担）。
- `verify-client-ui-i18n` 门禁只扫仓库内路径，第三方不受强制，但我们同样遵守规范以防未来收口。

---

## 9. 构建与打包

### 9.1 包结构

```
dsh-cap-manager/
├── package.json            # dsh.bundle + dsh.client 声明 + exports["./client"]
├── cordis.patch.yml        # - insert: 一行挂载宿主半
├── src/
│   ├── index.ts            # 宿主半：CapabilityManagerService
│   ├── service.ts          # capabilityManager Remote：list/writeMcp/…（§6.2）+ 项目层路由
│   ├── config-view.ts      # 原始行配置 ⇄ 脱敏视图 / storedPayload / !!js 标签化（patch 与项目文件共用）
│   ├── patch-writer.ts     # YAML 结构化编辑（保注释/!!js/原子写/备份/回滚）
│   ├── project-config.ts   # .dsh/mcp.yml 解析（含 !!js 求值）+ 结构化写
│   ├── project-mounter.ts  # 会话跟随/watcher/diff 挂载 + findProjectRoot
│   ├── status-tracker.ts   # fiber（FiberState 数字枚举 + _error）/tools 聚合
│   ├── mcp-test.ts         # SDK 直连测试
│   ├── skills-store.ts   # skills 读写/遮蔽检测/回收站+元数据/导入导出（M3+M4）
│   ├── importer → import-mcp.ts  # mcpServers JSON ⇄ wire 转换（M4）
│   ├── cc-market.ts        # claude-plugins-official 目录缓存 + codeload tar.gz 安全解包（M6）
│   ├── cc-store.ts         # 插件 registry/provider/rank550 技能供给 + mcpServers 动态挂载（M6）
│   └── types.ts          # §6 类型 + RemoteErrorDetailsMap 增强
│   └── client/
│       ├── index.ts        # 浏览器半：locale + slots + remote mount
│       ├── locales.ts      # {zh, en}
│       ├── CapabilitiesPage.tsx  # 卡片列表/tabs/项目选择器/导入导出回收站目录入口
│       ├── McpEditor.tsx / SkillEditor.tsx
│       ├── ImportWizard.tsx / SkillImport.tsx / TrashPanel.tsx   # M4（M5 加 URL 抓取）
│       ├── CatalogPanel.tsx / catalog.ts   # 内置精选目录（M5）
│       ├── CcPluginsPanel.tsx   # Claude Code 插件市场/已安装（M6）
│       ├── files.ts        # base64/zip（fflate）+ 下载 + URL 抓取
│       └── styles.ts / shims.ts / PanelIcon.tsx
└── test/m4-smoke.ts       # M4 转换器/导入冒烟（node --experimental-strip-types）
└── test/m5-smoke.ts       # M5 冒烟：目录不变量 + market 索引真校验器（M5）
└── test/m6-smoke.ts       # M6 冒烟：tar 解包/子树/manifest 转换（注入 fetcher，零网络）（M6）
└── market/index.json      # plugin-market format-1 索引（发现页安装，M5）
└── scripts/build-client.mjs  # esbuild 复刻 client bundle 包装（见下）
```

`package.json` 关键字段：

```jsonc
{
  "name": "dsh-cap-manager",
  "type": "module",
  "version": "0.1.0",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "engines": { "dsh": ">=0.2.1-rc.2" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "external": ["@deepseek-ai/dsh-api-remotes"]
    }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: cap-manager
      name: dsh-cap-manager
      config:
        defaultProjectPolicy: follow-sessions   # 或 lock-to-selected
```

### 9.2 client bundle 包装（第三方需手工复刻，无官方发布助手）

运行时契约（`packages/client/modules/src/client/manifest.ts:362-374` + `tsdown.client.ts:916-937`）——产物必须是经典 `<script>`，执行时调用：

```js
window.__ModuleLoader__.load({ id: 'dsh-cap-manager', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* ── bundler 产出的 CJS 体 ── */
  return module.exports;
} });
```

`id` 必须等于包名（与 boot-graph 行一致，重复注册会抛错）。`require(spec)` 解析：平台种子表（`react`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`，见 `packages/client/web/src/platform.ts:8-15`）→ 已注册的其他包行。**跨包值导入只允许这些平台外部依赖**，其余协作一律走 cordis 服务/slots。

`scripts/build-client.mjs` 骨架（esbuild）：

```js
import esbuild from 'esbuild'
const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-api-remotes']

await esbuild.build({
  entryPoints: ['src/client/index.ts'],
  bundle: true, format: 'cjs', platform: 'browser', minify: true,
  external: EXTERNAL,
  outfile: 'lib/client.js',
  banner: { js: `window.__ModuleLoader__.load({ id: 'dsh-cap-manager', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: `return module.exports; } });` },
})
```

> **Spike 1 结论（已验证 ✅）**：esbuild `--format=cjs` + banner/footer 复刻契约可行（intro 需自带 `var module = { exports: {} }`，esbuild 的 CJS 出口赋值会落到我们的 `module` 上）；构建脚本内置首尾契约断言。实测 capdev profile 加载成功。
>
> **Spike 2 结论（已验证 ✅，无需 HTTP 回退）**：宿主侧网关是**纯运行时发现**——`TypertRemoteService` 子类 + `@Remote` 装饰器，`ctx.on('internal/service')` 自动接管，第三方无需生成器；客户端侧手写 `TypertRemoteContribution`（零参数方法 `parameters: []` + `result: {mode:'src-json'}` 即可），`ctx.remote.$mount()` 挂载。访问挂载后的命名空间需经 `ctx.inject(['remote.<ns>'], ...)` 子上下文（Cordis 属性注入检查）。

### 9.3 客户端 remote 桩挂载

官方 web app 的 remote 命名空间集中在 `packages/api/remotes` 组装；第三方需在**自己的浏览器半**挂载远程桩：`import { mount } from '@deepseek-ai/dsh-api-remotes/client'`（经 `dsh.client.external` + inject 边解析），按 `docs/cookbook/adding-a-remote-api.md` 的客户端模式 `ctx.remote.$mount({ namespace: 'capabilityManager', methods: { list: {...}, writeMcp: {...}, … } })`。**M0 spike 第二项**：验证 out-of-repo `$mount` 可行；不可行时的回退方案——宿主半用 `ctx.webServer.register()` 开私有 HTTP 路由 `/cap-manager/*`（浏览器半 owner 会话直接 fetch），功能不缩水只是类型不漂亮。

---

## 10. 安全与可靠性

1. **原子写 + 备份**：`writeFileAtomic` + 文件锁（profile `package.json` 锁，与 config-editor 同锁避免竞态）+ `.bak-<ts>` 保留 5 份；恢复入口在 UI"备份"菜单。**（M4 已实现：♻ 面板枚举所有受管文件旁的 `.cap-bak-*`，一键恢复/删除；恢复走原子写，HMR/watcher 自动接手。）**
2. **拒写保护**：目标 patch 解析失败（已有语法错误）→ `cap/yaml-invalid` 拒绝任何写入，提示用户手修（学 dsh-mcp-skills）。
3. **敏感值脱敏**：`env`/`headers` 中 key 匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的值，返回客户端时以 `•••` 掩码 + 长度提示；编辑时留空 = 不变，输入 `!!js` 表达式原样透传。
4. **skills 删除回收站**：移入 `$DSH_HOME/cap-manager/trash/<ts>-<name>/`（源目录整体移入 + `trash-meta.json` 记录原路径/种类/时间），UI 可恢复；M4 之前的旧条目无元数据，恢复禁用（仅彻底删除）。回收站节标题旁有「清空全部」（二次确认，一次 RPC 销毁全部条目并返回计数；`.cap-bak` 备份节不受影响）。patch 行删除则依赖 `.bak`。
5. **锁与串行**：所有写操作经 `hmr.runExclusive`，与 HMR/plugin-manager 的写队列互斥。
6. **自保**：拒绝管理 `PROTECTED_PLUGINS` 清单内条目与 agent preset 内 MCP 行（只读展示）。
7. **不做的**：不做静默降级——任何被更高层 overlay 压制的写入都显式回报 `overridden`（对应上游 `ChangeResult.application`）。

---

## 11. 兼容性与风险表

| 风险 | 概率 | 缓解 |
|---|---|---|
| dsh pre-stable API 破坏性变更（AGENTS.md 明示 WILL break） | 高 | 下限 0.2.1-rc.2 + 两端验证（见"版本策略"漂移表）：上游破坏性 release 即升 `engines.dsh` 下限 + 修复，不写版本分支；上游 API 引用集中在 `patch-writer`/`status-tracker` 两个适配层文件；CI 锁步升级冒烟 |
| `reconcileProfilePatches` / `internal/status` 属事实公开而非承诺 API | 中 | 适配层隔离 + M0 spike 回归用例；变化时只改适配层 |
| out-of-repo client bundle 契约变化 | 中 | 构建脚本内置契约自检（首尾字符串断言），构建即验证 |
| serverName 跨层撞名导致挂载失败 | 中 | 写入与挂载双预检 + UI 冲突提示（D3） |
| 官方未来内置同类管理 UI | 中 | 差异化在项目级作用域 + 双域统一 + 导入生态；数据格式（patch 行/.dsh/mcp.yml/SKILL.md）全部是原生格式，可无痛迁移 |

---

## 12. 测试策略

- **单元**（vitest）：`patch-writer`（注释/`!!js` 保留快照、增删改开关、语法错误拒写、备份回滚）；`importer`（五种来源格式 × 转换矩阵）；`project-mounter`（diff/冲突/会话跟随）；`skills-store`（frontmatter 往返、遮蔽检测、kebab 校验）。
- **集成**（本地跑 `pnpm dsh web` + profile 安装本插件）：写入 → 15s 内状态变化；HMR off → `restart-required`；外部改 `.dsh/mcp.yml` → 重挂载。
- **E2E**（参照 `apps/web/tests/*.e2e.ts` 模式）：面板出现、列表渲染、开关往返、导入向导全流程。
- **手测清单**：Windows/macOS 路径（`$DSH_HOME`）、只读 preset 行、密钥脱敏回显。

---

## 13. 路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 骨架 + spike**（0.1.0）✅ 已完成并实测 | 包结构、两个 spike（client bundle 契约、remote $mount/HTTP 回退）、宿主半 `list()` 打通、空面板 | ✅ capdev profile 实测通过：面板+侧边栏+双 tab；`list()` 返回真实 MCP 行（作用域/传输/摘要/**已连接·N 工具**状态）与 skills 目录；宿主运行期间改 patch 热挂载 MCP server 无需重启 |
| **M1 MCP 管理**（0.2.0）✅ 已完成并实测 | 全局/Profile 增删改查 + 开关 + 状态 + 卡片列表与详情页编辑 + 热生效 | ✅ 实测通过：开关往返热挂载/卸载（patch 只动 `disabled`）；新增全局行正确写入 home patch（D2 路径）；隔离式连接测试（311ms · serverInfo · 工具数，不污染模型工具表）；删除后 patch 清理 + `.cap-bak-*` 备份保留 |
| **M2 项目级 + 测试**（0.3.0）✅ 已完成并实测 | `.dsh/mcp.yml` 结构化读写（保注释/`!!js` 往返/备份/原子写）+ ProjectMounter（活动会话跟随 ∪ 面板锁定、chokidar watcher、diff 挂载、跨层重名/表达式错误入列报错）+ 项目选择器（workspaceRegistry ∪ 会话根、活动数徽标）+ 项目作用域增删改开关 + RPC `listProjects`/`setActiveProject` + `list({projectRoot})` | ✅ 浏览器端到端实测：选中项目即挂载（已连接 · 2 工具）；外部改文件 `enabled: false` → watcher 自动卸载（已停用）→ UI 开关打开 → 重挂载；编辑器新增项目服务默认项目作用域、保存即挂载；与 Profile 行重名被 `cap/name-conflict` 拒绝（文件未动）；删除清理文件条目并卸载；**会话跟随决定性验证**——释放 UI 锁 4 秒后项目仍 connected（由活动会话持有，非锁） |
| **M3 Skills 管理**（0.4.0）✅ 已完成并实测 | skills-store（四根目录扫描，按上游 rank 自算胜负；CRLF 宽容；损坏文件显式上报）+ `writeSkill`/`setSkillFlags`/`removeSkill`/`readSkill` RPC + 技能卡片（双开关、遮蔽角标、错误角标）+ 技能编辑器（frontmatter 表单 + Markdown 正文 + 四作用域）+ 删除回收站 `~/.dsh/cap-manager/trash/`；ZIP 导入顺延至 M4 | ✅ 浏览器端到端实测：新建 → 卡片即时出现；双开关往返（`disable-model-invocation` 落盘、卡片同步）；项目版同名遮蔽全局版（角标 + shadowedBy）；删除项目版 → 全局版浮出（角标消失）+ 目录进回收站；编辑器正文回显；真实 `.agents/skills` 12 个技能全部解析（含 CRLF 文件——`yaml` 包对引号后 `\r` 报错而上游 js-yaml 宽容，解析前归一 LF 修复） |
| **M4 导入与体验**（0.5.0）✅ 已完成并实测 | mcpServers JSON 导入向导（JSONC 容错/`${VAR}`·`${env:VAR}`→`!!js`/`${input:}` 凭据表单/slug 改名/sse 警告/逐条预览·勾选·应用）+ 新增表单模板 + MCP 导出（`!!js`→`${VAR}` 反还原，Profile+项目合并）+ 技能 ZIP/文件夹/.md 导入（原样落盘）+ 技能导出（.md/.zip）+ 回收站恢复/彻底删除（trash-meta.json）+ `.cap-bak` 备份浏览/恢复/删除 + `validateConfig` 放宽 `!!js` url | ✅ 浏览器端到端实测：导入向导 4/4 条目（env 引用→`!!js` 模板、`imp.fetch x`→`imp-fetch-x` 改名角标、`${input:key}` 表单值落盘、坏条目进"无法转换"清单、缺占位值阻止导入）；落盘 patch 与预期逐字段一致（含 `!!js` 反引号模板），HMR 即时挂载 imp-mini/imp-secret（已连接·2 工具）；导出 JSON 拦截验证（`Bearer ${DOCS_TOKEN}` 反还原、项目行合并）；技能 zip 导入（包装目录+assets+CRLF 原样落盘、孤儿目录正确跳过）；导出 zip 解包回验；删除→回收站（带元数据）→恢复→卡片回归→再删→彻底删除全链路；备份恢复把 patch 回滚到备份状态且 HMR 热接手；模板预填。node 冒烟 16 项全过（含 zip-slip 拒绝/覆盖/重名跳过）。开发期抓到并修复：导出对 `{__jsExpr}` url/command 误丢、包装目录分组、React updater 内读 `event.currentTarget` 崩面板 |
| **M5 生态**（1.0.0）✅ 已完成并实测 | URL 安装、`dsh-plugin` topic 发布（内置精选目录后按需求移除，模板下拉保留） | ✅ 浏览器端到端实测：URL 导入 MCP（临时 CORS 服务器供 JSON）→ 抓取即预览 → 应用 → patch 落行 → HMR 挂载（已连接 · 2 工具）；URL 导入技能 zip → 浏览器解包 2 文件 → 导入原样落盘（CRLF + assets）→ 删除 → 回收站 → 彻底删除。**零新增 RPC**（模板=数据+预填，URL=浏览器 fetch + 既有管线）；`market/index.json` 通过上游 `@deepseek-ai/dsh-plugin-market-index` format-1 真校验（devDep + test/m5-smoke.ts）；README 双语（en 主 + zh 全译）+ 发布手册（npm/git 安装、市场索引托管、OWNER 占位替换、topic 收录）；版本 1.0.0 + keywords/repository 元数据。开发期抓到并修复：locale 描述键 pascal 大小写不一致（en `DeepWiki` vs 生成键 `Deepwiki`）、模板 env 映射 null 类型。精选目录卡片页（12 条 + 安装预填流）曾完整交付并实测，后于 1.1.x 按需求移除 |
| **M6 Claude Code 插件源**（1.1.0）✅ 已完成并实测 | 官方 `claude-plugins-official` 唯一内置源：下载/更新/卸载/开关；技能经 `ctx.skills.registerProvider` 供给、mcpServers 动态挂载 | ✅ 浏览器端到端实测（真实网络）：插件 tab 市场 315 条（10min 缓存 + 强刷）；安装 `frontend-design`（仓库内路径源）→ codeload tarball 下载解包 → 卡片 v1.1.1 · 1 技能 → **技能 tab 即时出现**（插件只读组，双开关语义透传）；停用 → 技能即时消失 → 启用恢复；安装 `chrome-devtools-mcp`（整仓源）→ v1.11.0 · 7 技能 + `chrome-devtools` server 挂载 → **已连接 · 32 个工具**（卡片实时状态）；两个卸载 → store 清空、registry 归零（`.cap-bak`×5 保留）、技能组回到基线。node 冒烟 15 项（tar 解包 GNU-longname/pax/逃逸拒绝、子树剥离、manifest→`!!js` 标记、315 条快照解析）；**更新路径实测**（停用状态下点更新 → tarball 重下、pin/updatedAt 刷新、enabled 保持 false、技能随开关进出）。开发期修复：strip-types 不支持参数属性（改显式字段）、点前缀目录被误拒（`.claude-plugin` 合法化——只拒 `..`）、更新重置启停状态、市场拉取失败回退过期缓存 |

---

## 14. 附录 A：上游 API 速查（已核实 file:line）

| 能力 | API | 位置 |
|---|---|---|
| MCP 行挂载 | `ctx.plugin(McpClient, config)`（ACP 先例） | `packages/acp/acp/src/mcp.ts:32-33` |
| MCP Config schema | `z.union([stdio, http])` | `packages/mcp/mcp-client/src/index.ts:119-142` |
| 工具名 | `mcp__<serverName>__<tool>` | `packages/mcp/mcp-client/src/tools.ts:82` |
| fiber 状态事件 | `'internal/status'(fiber, old)` | `vendor/cordis/src/events.ts:329-334` |
| 工具变更事件 | `'tools/change'` | `packages/core/tools/src/events.ts:56` |
| 工具枚举 | `ctx.tools.definitions(scope?)` | `packages/core/tools/src/index.ts:305` |
| 热重载串行 | `ctx.hmr.runExclusive(fn)` | `packages/boot/hmr/src/index.ts` |
| patch 重算 | `reconcileProfilePatches(ctx, patches, bin, requiredIds)` | `packages/boot/app-boot/src/index.ts:320-324` |
| 写入范本（六步） | ConfigEditor.edit | `packages/boot/config-editor/src/index.ts:78-152` |
| 开关写路径（含陷阱） | writePluginEnabled 只写 profile patch | `packages/boot/plugin-manager/src/patch.ts:25-78` |
| HMR 监听面 | profile patch + home patch + package.json | `packages/boot/hmr/src/index.ts:384-407` |
| skills 快照 | `ctx.skills.snapshot({cwd, scope})` | `packages/skill/skill/src/index.ts:481-489` |
| skills 变更事件 | `'skills/change'` | `packages/skill/skill/src/index.ts:286-294` |
| 根目录解析 | `resolveDshHome()/resolveAgentsHome()` | `packages/util/home-paths/src/index.ts:135,151` |
| 会话工作目录 | `ctx.workingDirectory.get(session)` | `packages/session/working-directory/src/index.ts:122` |
| 工作区注册表 | `ctx.workspaceRegistry.list()` | `packages/workspace/workspace/src/index.ts:292` |
| 主面板注册 | `ctx.slots.register({name:'main', key, …})` | `packages/client/ui-plugin-manager/src/client/index.ts:129-149` |
| 侧边栏注册 | `ctx.slots.inject('sidebar.panellist', …)` | 同上 `:167-173` |
| Switch 组件 | `@deepseek-ai/dsh-client-ui-primitives` | `packages/client/ui-primitives/src/Switch.tsx:18-27` |
| 卡片范式（复刻对象） | `CardHead` / `PackageCard` / `ListSkeleton` / `DetailTop` | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:429-452,533-573,455-485,488-507` |
| Tag/StateDot/Menu 原语 | `@deepseek-ai/dsh-client-ui-primitives`（平台共享模块表内） | `packages/client/web/src/platform.ts:8-15` |
| client bundle 契约 | `window.__ModuleLoader__.load({id, factory})` | `packages/client/modules/src/client/manifest.ts:362-374` |
| 浏览器 owner 权限 | peer principal=owner 默认放行 | `packages/client/connection/src/rpc-host.ts:94` |

## 15. 附录 B：参考项目

- [Lrxc/dsh-manage-hub (dsh-mcp-skills)](https://github.com/Lrxc/dsh-manage-hub)
- [Ceelog/dsh-plugins (dsh-plugin-setting-mcp)](https://github.com/Ceelog/dsh-plugins/tree/main/src/plugins/dsh-plugin-setting-mcp)
- [imzl-zl/dsh-mcp-manager-ui](https://github.com/imzl-zl/dsh-mcp-manager-ui)
- [FlashingChen/dsh-desktop-hub](https://github.com/FlashingChen/dsh-desktop-hub)
- [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)
- [dsh 官方文档：插件开发](https://github.com/deepseek-ai/deepseek-harness/tree/main/docs/user/develop)
- Cursor `.cursor/mcp.json`、Claude Code `/mcp`、VS Code `mcp.json` 的交互范式（[VS Code MCP 讨论](https://github.com/orgs/community/discussions/178315)、[Claude /mcp 健康视图](https://github.com/anthropics/claude-code/issues/44535)）
