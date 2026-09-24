# dsh-cosplay 🎭

让 DeepSeek Harness 的 Agent 扮演任何角色。

## 这是什么？

一个 DSH（DeepSeek Harness）插件。开启后，Agent 会以你选定的角色人格、语气和行为守则来对话，同时保留干活的能力（写代码、查资料、读文件正常）。内置一条「蓝色大肥鱼」；也可以自己创建任意角色，或者一句话让 Agent 帮你搜设定、生成角色卡。

## 功能

- **全局开关**：设置页一键开/关。开着的时候所有会话都进入角色扮演；关掉立即恢复默认人格（下一轮对话生效）。
- **思考风格**：默认「中立思考」——模型思考时保持专业分析，只在回复里扮演，保 Agent 能力；全沉浸可切「角色化思考」（注：概率触发，可能影响 Agent 任务能力，仅适用于 Deepseek v4，方法参考：https://github.com/victorchen96/deepseek_v4_rolepaly_instruct）。
- **角色卡**：对齐 SillyTavern（酒馆）v2 规范；支持导入/导出标准 v2 JSON。
- **自然语言建卡**：直接说"帮我生成一个角色卡，角色为：XXX"，Agent 会自己搜索设定、整理成卡、写入角色库。
- **内置默认角色**：蓝色大肥鱼（鲸鱼娘）🐋，装完即用。

## 安装

```bash
dsh plugin --profile web add dsh-cosplay
```

装完重启 dsh 即可。前提：pnpm 在 PATH（Windows 上确保 `pnpm.cmd` 可用）。

> 依赖说明：运行时只需额外装一个 `@deepseek-ai/schemastery`；其余服务包（cordis、dsh-settings、dsh-tools、dsh-system-prompt）写在 `peerDependencies` 里即可 —— dsh 对 linked 插件有一套模块解析拦截，会把声明为 peer 的包路由到 **harness 自己的安装副本**，所以本地**不要**安装它们（每个都拖着 10+ 个 harness 包的 peer，装了会让 pnpm 解析爆炸、安装卡死）。仓库里的 `.npmrc` 已关掉 `auto-install-peers` 来保证这一点。
>
> 兼容性：需要 DeepSeek Harness **`0.1.7-alpha.2` 起**。0.1.7 把 `ctx.settings` 从「自定义命名空间注册表」（`register` / `get` / 按命名空间 `replace`）换成了 `SettingsForms`：设置表单改由**插件自己的 Config schema** 投影生成，可编辑字段标 `.volatile()`，表单以 profile 条目 id 为键。因此 0.1.5 及更早版本不再支持。persona 段位置仍按版本解析（`DEPLOYMENT_PERSONA_PREFIX` 优先，回退旧 `DEPLOYMENT_PERSONA`）。

## 使用

1. 打开设置 → 「角色扮演」→ 打开开关（默认关闭）。
2. 选一个角色（默认蓝色大肥鱼），也可以新建、导入，或让 Agent 帮你生成。
3. 新建一个会话正常聊天——下一轮对话起，Agent 就是那个角色了。
4. 想换角色：设置页点「设为当前」，或对话里让 Agent 用 `cosplay_switch` 切换；随时关开关恢复默认。

开关与角色库存放在当前 profile 的 patch 用户层（`$DSH_HOME/profiles/<name>/cordis.patch.yml` 里 `id: cosplay-core` 那一行的 `config`）——改了角色卡直接编辑那个文件也生效，删掉那段配置就回到内置默认。

## 角色卡字段

对齐酒馆 v2：`name`、`description`（身份）、`personality`（性格）、`scenario`（场景）、`first_mes`（开场白）、`mes_example`（示例对话）、`system_prompt`（置顶指令块）……全部自由文本，想写多详细写多详细。插件特有的 `style`（语气）、`rules`（守则）、`behavior`（行为）也随卡存储，导出时放进 v2 的 `extensions`，互相不干扰。

## 开发

```bash
npm run check   # 语法检查
```

纯 JS ESM，无构建步骤，改完 `src/` 重启 dsh 即生效。

## 许可

见 LICENSE 文件。
