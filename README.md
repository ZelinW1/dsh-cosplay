# dsh-cosplay 🎭

让 DeepSeek Harness 的 Agent 扮演任何角色。

## 这是什么？

一个 DSH（DeepSeek Harness）插件。开启后，Agent 会以你选定的角色人格、语气和行为守则来对话，同时保留干活的能力（写代码、查资料、读文件正常）。内置一条「蓝色大肥鱼」；也可以自己创建任意角色，或者一句话让 Agent 帮你搜设定、生成角色卡。

## 功能

- **全局开关**：设置页一键开/关。开着的时候所有会话都进入角色扮演；关掉立即恢复默认人格（下一轮对话生效）。
- **思考风格**：默认「中立思考」——模型思考时保持专业分析，只在回复里扮演，保 Agent 能力；全沉浸可切「角色化思考」（注：概率触发，可能影响 Agent 任务能力，仅适用于 Deepseek v4，方法参考：https://github.com/victorchen96/deepseek_v4_rolepaly_instruct ）。
- **角色卡**：对齐 SillyTavern（酒馆）v2 规范；支持导入/导出标准 v2 JSON。
- **自然语言建卡**：直接说"帮我生成一个角色卡，角色为：XXX"，Agent 会自己搜索设定、整理成卡、写入角色库。
- **内置默认角色**：蓝色大肥鱼（鲸鱼娘）🐋，装完即用。

## 兼容性

| DSH 版本 | 状态 | 说明 |
|---|---|---|
| **0.2.x（含桌面版 0.2.0-rc.2）** | ✅ 支持（host + 设置页 UI 均已真机验证） | 状态层基于 Config/表单模型，设置页经 Typert Remote 通道读写 |
| 0.1.0-rc.6 及更早 | ❌ 不再支持 | 旧版无 `ctx.settings.update` 与 volatile Config 语义；如需旧版请用 `dsh-cosplay@0.4.0` |

### 从 0.1.x 升级到 0.2.x（含数据迁移）

DSH 0.2.0 移除了 `settingsNamespace` / `ctx.settings.register|get|replace` 与 `PERSONA_ORDER`，本插件对应改造：

- 角色库与开关存于本插件所在 profile 条目的 **Config**（`- id: cosplay-core` 的 `config` 段），四个字段全部声明 `.volatile()`：写入只改运行时引用、不触发插件重载，开/关/换角色下一模型步骤即生效。
- 状态写入走 `ctx.settings.update(ENTRY_ID, patch)`，落到当前 profile 的 Cordis patch；旧的 `$DSH_HOME/settings.yaml` 由运行时一次性导入并改名为 `settings.yaml.imported`，本插件不再读写它。
- 人格段挂在内置 persona **后缀段**之后（order 10250），替代已移除的 `PERSONA_ORDER + 1`。
- 设置页仍走插件自有的 Typert Remote 命名空间 `cosplay`（`getState`/`upsertRole`/`removeRole`/`setActiveRole`/`setEnabled`/`setThinkingStyle`）。
- 插件自带设置页，因此以 `configure({ auto: false })` 关闭自动生成的配置表单。

> ⚠️ **旧角色库不会自动迁移**：0.4.0 的角色存在 `$DSH_HOME/settings.yaml` 的 `cosplay:` 段里，0.5.0 改存 profile 补丁。升级后角色库会是空的（内置「蓝色大肥鱼」仍在）。迁移方式：用设置页的「导入角色卡」，或把旧 `settings.yaml.imported` 里 `cosplay.roles` 的内容按下面的补丁片段写进 profile：
>
> ```yaml
> # $DSH_HOME/profiles/<profile>/cordis.patch.yml
> - id: cosplay-core
>   name: dsh-cosplay
>   config:
>     enabled: true
>     thinkingStyle: neutral
>     activeRole: <角色 id>
>     roles: [ ... ]   # 旧 settings.yaml 里的 cosplay.roles 数组
> ```

### 插件作者须知：0.2.x 客户端半边契约

改造过程中踩到的三条硬约束（都验证过，改客户端前请先读）：

1. **参数 codec 必须是 `strict` 且带 `create` 工厂**。客户端 `requireStrictInputs` 会对每个参数断言 `mode === 'strict'`，否则 `$mount` 抛错；`result` 可以留 `src-json`。`create` 在客户端只是校验令牌、不会被执行，写 `() => ({})` 即可。
2. **不要把挂载包在 `ctx.effect(async () => ...)` 里**。cordis 的 effect 收尾会静默吞掉该 promise 的 rejection（连 logger 都不打），浏览器侧只表现为设置页永远"加载中…"。应让 `apply` 自身 async 并 return disposer，失败会置 fiber 为 FAILED 并出现在插件失败清单。
3. **读 `ctx.remote.<ns>` 前必须 `ctx.inject(['remote.<ns>'], cb)` 声明**，否则抛 `cannot get property "remote.x" without inject`；且该注入必须在 `$mount` 之后发起（在插件顶层 inject 自己的命名空间会自依赖死锁）。

`npm test` 里有一条静态护栏覆盖这三条，改坏了会直接失败。

## 安装

在桌面版：插件管理页安装本插件（桌面端菜单栏「管理 dsh 命令」可把 `dsh` 命令装到 PATH，无需另装 Node/pnpm）。

在 CLI 环境：

```bash
dsh plugin --profile <profile> add dsh-cosplay
```

装完重启 dsh 即可。前提：pnpm 在 PATH（Windows 上确保 `pnpm.cmd` 可用）。

> 依赖说明：运行时只需额外装一个 `@deepseek-ai/schemastery`；其余服务包（cordis、dsh-settings、dsh-tools、dsh-system-prompt、dsh-typert-protocol）由 dsh 自带解析，无需单独安装。

## 使用

1. 打开设置 → 「角色扮演」→ 打开开关（默认关闭）。
2. 选一个角色（默认蓝色大肥鱼），也可以新建、导入，或让 Agent 帮你生成。
3. 新建一个会话正常聊天——下一轮对话起，Agent 就是那个角色了。
4. 想换角色：设置页点「设为当前」，或对话里让 Agent 用 `cosplay_switch` 切换；随时关开关恢复默认。

## 角色卡字段

对齐酒馆 v2：`name`、`description`（身份）、`personality`（性格）、`scenario`（场景）、`first_mes`（开场白）、`mes_example`（示例对话）、`system_prompt`（置顶指令块）……全部自由文本，想写多详细写多详细。插件特有的 `style`（语气）、`rules`（守则）、`behavior`（行为）也随卡存储，导出时放进 v2 的 `extensions`，互相不干扰。

## 开发

```bash
npm run check   # 语法检查
npm test        # 主机侧桩测试（不启动 Electron，不写生产数据）
```

纯 JS ESM，无构建步骤，改完 `src/` 重启 dsh 即生效。

`npm test` 需要能从 `node_modules` 解析到 `@deepseek-ai/schemastery`（以及 0.2.x 运行时的 `@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-typert-protocol`）。在桌面版环境下可从应用内运行时取出这些包：

```powershell
# 运行时包在 <安装目录>/resources/app.asar 内（/dsh/node_modules），
# 解出共享包树即可，例如按 resources/app.asar 的 dsh/desktop-runtime.json 的 sharedPackages 列表还原。
```

## 许可

见 LICENSE 文件。
