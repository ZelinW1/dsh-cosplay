/**
 * dsh-cosplay — 主机侧核心插件（组合行 id: cosplay-core）。
 *
 * 形态：全局开关（Round 3 决策）。
 *   - 状态即插件自身 Config 的 volatile 字段（enabled / thinkingStyle /
 *     activeRole / roles）：0.1.7 起 settings 不再是「自定义命名空间注册表」，
 *     而是把每个 profile 条目**自己的 Config schema** 投影成表单
 *     （SettingsForms）。可编辑字段标 `.volatile()` 后写入不触发插件重挂，
 *     Loader 走 volatile-only 路径原地更新引用（`loader/volatile-update`）。
 *     表单读写与持久化仍由 dsh 自带的 settings / config-editor 承担，
 *     插件不自建 typert Remote。
 *   - 读：`apply(ctx, config)` 的 config 里 volatile 字段是稳定引用，
 *     `config.<field>.get()` 取当前快照 —— 开关 / 换角色下一模型步骤即生效，
 *     无需重建会话。
 *   - 写：`ctx.get('configEditor').edit(entry, ...)` 把完整 volatile 配置写回
 *     profile patch（$DSH_HOME/profiles/<name>/cordis.patch.yml）。
 *   - 注册**全局**追加人格段 `cosplay-persona`（位于 persona 之后）与
 *     `{{cosplay_active}}` 变量：变量每次模型步骤组装时求值，开关关闭时渲染
 *     空串（人格静默回退），开启时渲染激活角色卡。
 *   - 注册**全局** `cosplay_*` 工具：`cosplay_switch` 在开关关闭时软禁用
 *     （提示先开启）；角色库管理工具（list/show/upsert/remove）始终可用。
 *
 * 本行是纯主机平面：不依赖任何 preset。全局生效范围含所有会话与子代理
 * （Round 3 已与用户确认）。
 *
 * 兼容性：0.1.7-alpha.2 起。0.1.5 及更早版本的 `ctx.settings.register/get`
 * 命名空间 API 已被移除，本插件不再支持那些版本。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  normalizeState,
  DEFAULT_ROLES,
  upsertRole,
  removeRole,
  setActiveRole,
  findRole,
  nextId,
  renderPersona,
  renderActivePersona,
} from './store.js'

import {
  CARD_AUTHORING_SKILL_NAME,
  CARD_AUTHORING_SKILL_DESCRIPTION,
  CARD_AUTHORING_SKILL_WHEN_TO_USE,
  CARD_AUTHORING_SKILL_CONTENT,
} from './skill.js'

export const name = 'cosplay-core'
export const inject = ['systemPrompt', 'tools', 'skills']

const RoleCardSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  emoji: z.string().default(''),
  // SillyTavern v2 标准字段（通用共享）
  description: z.string().default(''),
  personality: z.string().default(''),
  scenario: z.string().default(''),
  first_mes: z.string().default(''),
  mes_example: z.string().default(''),
  system_prompt: z.string().default(''),
  post_history_instructions: z.string().default(''),
  creator_notes: z.string().default(''),
  character_version: z.string().default(''),
  creator: z.string().default(''),
  tags: z.array(z.string()).default([]),
  // 插件扩展字段（导出归入 extensions.dshCosplay）
  style: z.string().default(''),
  rules: z.string().default(''),
  behavior: z.string().default(''),
})

/**
 * 插件配置 = 角色库状态（0.1.7 起设置页由此投影生成）。
 *
 * 四个字段全部 `.volatile()`：设置页可编辑，写入只更新引用、不重挂插件。
 * 内置示例角色作为 `roles` 的 schema 默认值提供：零启动写入、无竞态，
 * 用户编辑写入 user 层（profile patch）覆盖默认值。
 *
 * schemastery 无 null 类型：activeRole 以空串表示"未选择"（存储层），
 * store 层内部仍用 null 语义，写入时序列化为空串。
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  thinkingStyle: z.union(['neutral', 'role']).default('neutral').volatile(),
  activeRole: z.string().default('').volatile(),
  roles: z.array(RoleCardSchema).default(DEFAULT_ROLES).volatile(),
})

/** 追加人格段的段名（与 persona 段名不同，避免同一层重复名冲突）。 */
export const PERSONA_SECTION_ADDON = 'cosplay-persona'

/**
 * persona 段基准 order（跨版本兼容）。
 *
 * 0.1.2-rc.1 的 section order 表用 `DEPLOYMENT_PERSONA`（=0）；0.1.5-rc.1 把它
 * 拆成 `DEPLOYMENT_PERSONA_PREFIX`（=0）与 `DEPLOYMENT_PERSONA_SUFFIX`（=10200）。
 * `getSectionOrder()` 对未知 key 返回 undefined：参与加法得到 NaN 后，
 * `section()` 的 `order must be a finite number` 检查会抛 TypeError，插件在
 * apply 阶段直接装载失败。因此按版本逐个回退，全都不认识时退回 0
 * （等价于旧版 persona 段的位置）。
 */
function resolvePersonaOrder(systemPrompt) {
  for (const key of ['DEPLOYMENT_PERSONA_PREFIX', 'DEPLOYMENT_PERSONA']) {
    const order = systemPrompt.getSectionOrder(key)
    if (Number.isFinite(order)) return order
  }
  return 0
}

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

export function apply(ctx, config) {
  const read = () =>
    normalizeState({
      enabled: config.enabled.get(),
      thinkingStyle: config.thinkingStyle.get(),
      activeRole: config.activeRole.get(),
      roles: config.roles.get(),
    })

  // 写回：把完整 volatile 配置交给 config-editor 落盘（profile patch），
  // Loader 随后原地更新 config 上的引用，所以 `read()` 立刻能看到新值。
  // 没有 config-editor（如 headless 组合）时无法持久化 —— 引用也不会变，
  // 必须显式报错，否则工具会谎报成功。
  const write = async (next) => {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) {
      throw new Error('无法保存 Cosplay 配置：当前组合未提供配置编辑（configEditor）服务。')
    }
    await editor.edit(entry, (current) => ({
      ...current,
      enabled: next.enabled,
      thinkingStyle: next.thinkingStyle,
      // schema 无 null 类型：序列化为空串
      activeRole: next.activeRole ?? '',
      roles: next.roles,
    }))
    return next
  }

  // ── 设置页策略：本插件自带「角色扮演」页，关掉按 schema 自动生成的表单 ──
  // 放在可选的 ctx.inject 子级里：Settings 迟到或被替换时策略依然生效，
  // 且业务逻辑本身不依赖 Settings 即可运行。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // ── 人格注入（全局，随变量每次组装求值；含思维链指令，见 store.js） ──────
  // section order 表由 dsh-system-prompt 集中维护：deployment persona 在
  // 0.1.2-rc.1 是 DEPLOYMENT_PERSONA（=0），0.1.5-rc.1 拆成
  // DEPLOYMENT_PERSONA_PREFIX（=0）/ DEPLOYMENT_PERSONA_SUFFIX（=10200）；
  // cosplay 人格段始终紧随 persona 前缀之后（见 resolvePersonaOrder）。
  // section()/variable() 已返回 disposer，这里包进 ctx.effect 以便热重载清理。
  ctx.effect(() => {
    const disposeVariable = ctx.systemPrompt.variable('cosplay_active', () => renderActivePersona(read()))
    const disposeSection = ctx.systemPrompt.section({
      name: PERSONA_SECTION_ADDON,
      order: resolvePersonaOrder(ctx.systemPrompt) + 1,
      text: '{{cosplay_active}}',
    })
    return () => {
      disposeVariable()
      disposeSection()
    }
  }, 'dsh-cosplay: persona addon')

  // ── 内置 skill：自然语言创建角色卡（全局注册，模型可加载） ───────────────
  ctx.skills.register({
    name: CARD_AUTHORING_SKILL_NAME,
    description: CARD_AUTHORING_SKILL_DESCRIPTION,
    whenToUse: CARD_AUTHORING_SKILL_WHEN_TO_USE,
    content: CARD_AUTHORING_SKILL_CONTENT,
  })

  // ── 全局工具（模式门控：开关关闭时 switch 软禁用） ────────────────────────
  ctx.tools.register(defineTool({
    name: 'cosplay_show',
    description:
      '查看当前激活角色的角色卡，或按 id 查看指定角色的角色卡。用于确认角色设定、语气与行为守则（Cosplay 开关关闭时也可预览）。',
    parameters: {
      id: { type: 'string', description: '角色 id；省略时返回当前激活角色。' },
    },
    output: textOutput,
    async execute(args) {
      const state = read()
      const role = args.id ? findRole(state, args.id) : findRole(state, state.activeRole)
      if (!role) return args.id ? `未找到角色: ${args.id}` : '当前未激活任何角色。'
      return renderPersona(role)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cosplay_list',
    description: '列出角色库中全部角色及其激活状态（角色库管理，开关关闭时也可用）。',
    parameters: {},
    output: textOutput,
    async execute() {
      const state = read()
      const head = state.enabled ? 'Cosplay 模式：开启' : 'Cosplay 模式：关闭'
      if (state.roles.length === 0) return `${head}\n角色库为空。`
      const lines = state.roles.map((r) => {
        const mark = r.id === state.activeRole ? '★ 激活' : '   '
        return `${mark} ${r.emoji ?? ''} ${r.name} (${r.id})`
      })
      return [head, ...lines].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cosplay_switch',
    description: '切换当前扮演的角色（按角色 id）；id 传 null 可退出扮演、恢复默认身份。Cosplay 开关未开启时不可用。',
    parameters: {
      id: { type: 'string', required: true, description: '目标角色 id；传字符串 "null" 表示退出扮演。' },
    },
    output: textOutput,
    async execute(args) {
      const state = read()
      if (!state.enabled) {
        return 'Cosplay 模式未开启。请先在设置页「角色扮演」中打开开关（或安装后由用户主动开启），再切换角色。'
      }
      const id = args.id === 'null' ? null : args.id
      const next = setActiveRole(state, id)
      await write(next)
      return id === null ? '已退出扮演，恢复默认身份。' : `已切换到角色「${findRole(next, id).name}」。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cosplay_upsert',
    description:
      '创建或更新一个角色（角色库管理，开关关闭时也可用）。未提供 id 时创建新角色（按 name 生成 id）；提供 id 时更新既有角色。字段兼容酒馆（SillyTavern）v2 角色卡。支持用户随时自定义任何角色。',
    parameters: {
      id: { type: 'string', description: '既有角色 id；省略表示新建。' },
      name: { type: 'string', required: true, description: '角色显示名。' },
      emoji: { type: 'string', description: '头像字符（如 🐋）。' },
      system_prompt: { type: 'string', description: '原样注入 persona 顶部的指令块（如 [PERSONA_LOAD] 格式）。' },
      description: { type: 'string', description: '身份与背景设定（我是谁）。' },
      personality: { type: 'string', description: '性格核心与层次。' },
      style: { type: 'string', description: '说话风格（怎么说话）。' },
      rules: { type: 'string', description: '行为守则（该做什么 / 不做什么）。' },
      behavior: { type: 'string', description: '行为模式 / 私密互动。' },
      scenario: { type: 'string', description: '场景 / 世界观 / 关系设定。' },
      first_mes: { type: 'string', description: '开场白。' },
      mes_example: { type: 'string', description: '示例对话（few-shot）。' },
    },
    output: textOutput,
    async execute(args) {
      const state = read()
      // id 必须先算并传入：upsertRole 只在未提供 id 时生成，且生成带随机后缀；
      // 事后重算（如按 name）会得到不同 id，导致 findRole 落空、响应报错。
      const id = args.id || nextId(state, args.name)
      const next = upsertRole(state, { ...args, id })
      await write(next)
      const role = findRole(next, id)
      return `已保存角色「${role.name}」(${role.id})。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cosplay_remove',
    description: '从角色库删除一个角色（角色库管理，开关关闭时也可用）。',
    parameters: {
      id: { type: 'string', required: true, description: '要删除的角色 id。' },
    },
    output: textOutput,
    async execute(args) {
      const state = read()
      if (!findRole(state, args.id)) return `未找到角色: ${args.id}`
      await write(removeRole(state, args.id))
      return `已删除角色 ${args.id}。`
    },
  }))
}
