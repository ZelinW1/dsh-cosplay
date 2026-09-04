/**
 * dsh-cosplay — 主机侧核心插件（组合行 id: cosplay-core）。
 *
 * 形态：全局开关（Round 3 决策）。
 *   - 注册 settings 命名空间 `cosplay`（角色库 + 开关，$DSH_HOME/settings.yaml，
 *     热重载、schema 校验、revision 栅栏写入；内置示例角色经 composition base
 *     层提供，零启动写入）；
 *   - 提供 `cosplay` 服务能力（角色 CRUD / 激活 / 开关）—— 现在直接由标准
 *     settings 命名空间承载，浏览器设置页经 `remote.settings` 远程读写，无需自建
 *     typert Remote（0.1.2-rc.1 起第三方命名空间不再受白名单限制）；
 *   - 注册**全局**追加人格段 `cosplay-persona`（位于 persona 之后）与
 *     `{{cosplay_active}}` 变量：变量每次模型步骤组装时求值，开关关闭时渲染
 *     空串（人格静默回退），开启时渲染激活角色卡 —— 开/关/换角色下一模型步骤
 *     即生效，无需重建会话；
 *   - 注册**全局** `cosplay_*` 工具：`cosplay_switch` 在开关关闭时软禁用
 *     （提示先开启）；角色库管理工具（list/show/upsert/remove）始终可用。
 *
 * 本行是纯主机平面：不依赖任何 preset。全局生效范围含所有会话与子代理
 * （Round 3 已与用户确认）。
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
export const inject = ['settings', 'systemPrompt', 'tools', 'skills']

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

// schemastery 无 null 类型：activeRole 以空串表示"未选择"（存储层），
// store 层内部仍用 null 语义，写入时序列化为空串。
const CosplaySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  thinkingStyle: z.union(['neutral', 'role']).default('neutral'),
  activeRole: z.string().default(''),
  roles: z.array(RoleCardSchema).default([]),
})

export const Config = z.object({})

/** settings 命名空间名。 */
export const COSPLAY_NAMESPACE = 'cosplay'
/** 追加人格段的段名（与 persona 段名不同，避免同一层重复名冲突）。 */
export const PERSONA_SECTION_ADDON = 'cosplay-persona'

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

export function apply(ctx) {
  const ns = COSPLAY_NAMESPACE
  // 内置示例角色通过 composition base 层提供：零启动写入（避免装载期排队写入
  // 命中被替换的注册）、无竞态；用户编辑写入 user 层覆盖 base。
  ctx.settings.register(ns, CosplaySettingsSchema, {
    base: { enabled: false, thinkingStyle: 'neutral', activeRole: DEFAULT_ROLES[0].id, roles: DEFAULT_ROLES },
  })

  const read = () => normalizeState(ctx.settings.get(ns))
  const write = async (next) => {
    // 序列化：activeRole 的 null 语义 → 空串（schema 无 null 类型）
    await ctx.settings.replace(ns, { ...next, activeRole: next.activeRole ?? '' })
    return next
  }

  // ── 人格注入（全局，随变量每次组装求值；含思维链指令，见 store.js） ──────
  // 0.1.2-rc.1 起 dsh-system-prompt 不再导出 PERSONA_ORDER；改用集中维护的
  // section order 表：deployment persona 为 DEPLOYMENT_PERSONA（=0），cosplay
  // 人格段紧随其后。section()/variable() 已返回 disposer，这里包进 ctx.effect
  // 以便插件热重载时正确清理。
  ctx.effect(() => {
    const disposeVariable = ctx.systemPrompt.variable('cosplay_active', () => renderActivePersona(read()))
    const disposeSection = ctx.systemPrompt.section({
      name: PERSONA_SECTION_ADDON,
      order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA') + 1,
      text: '{{cosplay_active}}',
    })
    return () => {
      disposeVariable()
      disposeSection()
    }
  }, 'dsh-cosplay: persona addon')

  // ── 内置 skill：自然语言创建角色卡（全局注册，模型可加载） ───────────────
  // 0.1.2-rc.1 的 skills.register() 已内置 runtime provider，无需再显式传 source。
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
