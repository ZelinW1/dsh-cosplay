/**
 * dsh-cosplay — 主机侧核心插件（组合行 id: cosplay-core）。
 *
 * 形态：全局开关（Round 3 决策），状态源为 DSH 0.2.x 的 Config/表单模型。
 *   - 角色库与开关存放于本行 Config（profile 的 Cordis patch 中 `- id: cosplay-core`
 *     的 config 段），字段全部 volatile：写入只改运行时引用、不触发插件重载；
 *   - 读取统一走 Config 引用（schemastery 的 `.get()`；桩测试下退化为普通值），
 *     每次模型步骤求值，开/关/换角色下一模型步骤即生效、无需重建会话；
 *   - 提供 `cosplay` 服务（角色 CRUD / 激活 / 开关）与 Typert Remote 通道，
 *     供浏览器设置页读写；
 *   - 注册**全局**追加人格段 `cosplay-persona`（挂在内置 persona 后缀段之后）
 *     与 `{{cosplay_active}}` 变量：变量每次模型步骤组装时求值，开关关闭时渲染
 *     空串（人格静默回退），开启时渲染激活角色卡；
 *   - 注册**全局** `cosplay_*` 工具：`cosplay_switch` 在开关关闭时软禁用
 *     （提示先开启）；角色库管理工具（list/show/upsert/remove）始终可用。
 *
 * 本行是纯主机平面：不依赖任何 preset。全局生效范围含所有会话与子代理
 * （Round 3 已与用户确认）。
 *
 * 兼容性（0.1.x → 0.2.x）：
 *   - 0.2.0 移除 `@deepseek-ai/dsh-settings` 的 `settingsNamespace` 与
 *     `ctx.settings.register/get/replace`；状态改由本行 Config +
 *     `ctx.settings.update(ENTRY_ID, patch)` 承载（旧 settings.yaml 由运行时
 *     一次性导入，本插件不再读写它）；
 *   - 0.2.0 的 persona 段由 `PERSONA_SECTION` 拆为
 *     `PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION`，本插件挂后缀之后；
 *   - 0.2.0 的 Remote marker 表写在原型上，装饰器可手工以等价 context 应用。
 */
import z from '@deepseek-ai/schemastery'
import { PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  normalizeState,
  DEFAULT_ROLES,
  upsertRole,
  removeRole,
  setActiveRole,
  findRole,
  nextId,
  renderActivePersona,
  renderPersona,
} from './store.js'

import {
  CARD_AUTHORING_SKILL_NAME,
  CARD_AUTHORING_SKILL_DESCRIPTION,
  CARD_AUTHORING_SKILL_WHEN_TO_USE,
  CARD_AUTHORING_SKILL_CONTENT,
} from './skill.js'

export const name = 'cosplay-core'
export const inject = ['settings', 'systemPrompt', 'tools', 'typert', 'skills']

/** profile 条目 id：cordis.patch.yml 里 `- id: cosplay-core` 必须与此一致。 */
export const ENTRY_ID = 'cosplay-core'

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
 * 本行 Config。字段全部 volatile：
 *   - 0.2.x 下只有 volatile 字段会出现在设置表单里（volatileForm 过滤）；
 *   - volatile-only 变更由 loader 原地提交进运行时引用，不重启插件；
 *   - schemastery 无 null 类型：activeRole 以空串表示"未选择"（存储层），
 *     store 层内部仍用 null 语义，写入时序列化为空串。
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  thinkingStyle: z.union(['neutral', 'role']).default('neutral').volatile(),
  // 默认激活内置示例角色：该意图必须落在 schema 默认值上，否则首次写入
  // （补丁里 activeRole 为空串）会把"默认激活"抹掉。用户主动退出扮演写入空串后，
  // 空串即用户选择，不会被默认值覆盖。
  activeRole: z.string().default(DEFAULT_ROLES[0].id).volatile(),
  roles: z.array(RoleCardSchema).default(DEFAULT_ROLES).volatile(),
})

/** 追加人格段的段名（与内置 persona 段名不同，避免重复名冲突）。 */
export const PERSONA_SECTION_ADDON = 'cosplay-persona'

/**
 * 读取 Config 字段：0.2.x 运行时把 Config 包成带 `.get()` 的引用（volatile 引用），
 * 桩测试或普通对象下退化为普通值。注意引用可能逐层包裹（数组/对象字段本身也会被
 * 包一层），因此循环解包直到拿到普通值。
 * @param holder - Config 对象或字段值本身。
 * @returns 当前值。
 */
function readField(holder) {
  let current = holder
  // 引用形态：带 .get()（schemastery 的 volatile 引用）
  for (let depth = 0; depth < 8; depth++) {
    if (current === undefined || current === null) return current
    if (typeof current.get !== 'function') return current
    current = current.get()
  }
  return current
}

/**
 * 合并写入本行 Config（落到 profile 的 Cordis patch）。
 * volatile 字段写入后由 loader 原地提交进运行时的 Config 引用，因此写入成功后
 * 同一次读就能拿到新值（桩测试里由 ctx.__test 钩子把补丁写回桩对象）。
 * @param ctx - 插件上下文。
 * @param patch - 要合并的配置字段。
 */
async function writeConfig(ctx, patch) {
  if (typeof ctx.settings?.update === 'function') {
    await ctx.settings.update(ENTRY_ID, patch)
    return
  }
  // 桩测试/无 settings 服务：交给测试钩子把补丁写回桩 Config
  if (typeof ctx.__test?.applyConfigPatch === 'function') {
    ctx.__test.applyConfigPatch(patch)
    return
  }
  throw new Error('dsh-cosplay: ctx.settings.update 不可用，无法持久化角色库')
}

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

// ── typert Remote（浏览器设置页的数据通道） ─────────────────────────────────
// settings 的远程读写按条目 id 暴露，第三方插件仍走自有 Typert Remote 通道
// （dsh-at-file 同款模式）。codec 使用 { mode: 'strict' } + 极简透传 schema。

/**
 * 以纯 JS 应用 TC39 现代装饰器 @Remote（0.2.x 形态）。
 * `Remote(method, context)` 是标准装饰器：框架经 `__esDecorate` 调用它；这里手工
 * 传入等价 context 直接调用，并立即以空 this 跑一次 initializer，把 marker 写到
 * **原型**上——0.2.x 的 mark()/remoteMethods() 都从原型读该 descriptor。
 */
function markRemoteMethod(proto, methodName) {
  const marker = {
    kind: 'method',
    name: methodName,
    static: false,
    private: false,
    addInitializer(fn) {
      fn.call({})
    },
  }
  try {
    Remote(proto[methodName], marker)
  } catch (error) {
    // 形态差异不该阻断插件加载，但要留下可诊断记录
    console.warn(`[dsh-cosplay] Remote marker 失败（${methodName}）: ${error?.message ?? error}`)
  }
}

/** 设置页可用的角色库读写服务（Remote 命名空间 `cosplay`）。 */
class CosplayRuntime extends TypertRemoteService {
  constructor(ctx, read, write) {
    super(ctx, 'cosplay')
    this._read = read
    this._write = write
  }
  getState() {
    return this._read()
  }
  async upsertRole(card) {
    return this._write(upsertRole(this._read(), card))
  }
  async removeRole(id) {
    return this._write(removeRole(this._read(), id))
  }
  async setActiveRole(id) {
    // id 为 null 表示退出扮演（写入层序列化为空串）
    return this._write(setActiveRole(this._read(), id))
  }
  async setEnabled(enabled) {
    return this._write({ ...this._read(), enabled: enabled === true })
  }
  async setThinkingStyle(style) {
    const next = style === 'role' ? 'role' : 'neutral'
    return this._write({ ...this._read(), thinkingStyle: next })
  }
}
for (const method of ['getState', 'upsertRole', 'removeRole', 'setActiveRole', 'setEnabled', 'setThinkingStyle']) {
  markRemoteMethod(CosplayRuntime.prototype, method)
}

/**
 * 主机侧 codec：`src-json` 不要求 create() 工厂（strict 模式会被
 * typert-registry 的 validateCodec 拒绝：`strict codec has no create() factory`）。
 * 参数与结果都是 JSON 形状，src-json 的线格式足够。
 * 客户端挂载那一侧另需 strict（dsh-api-gateway 的 requireStrictCodec），见 client.js。
 */
const srcJsonCodec = (typeSymbol) => ({ mode: 'src-json', typeSymbol })

const COSPLAY_INVOCATIONS = [
  {
    id: 'dsh-cosplay#cosplay/getState',
    service: 'cosplay',
    namespace: 'cosplay',
    method: 'getState',
    invocation: { kind: 'direct' },
    parameters: [],
    result: srcJsonCodec('dsh-cosplay#CosplayState'),
  },
  {
    id: 'dsh-cosplay#cosplay/upsertRole',
    service: 'cosplay',
    namespace: 'cosplay',
    method: 'upsertRole',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'card', wire: 'card', source: 'json', codec: srcJsonCodec('dsh-cosplay#RoleCard') }],
    result: srcJsonCodec('dsh-cosplay#CosplayState'),
  },
  {
    id: 'dsh-cosplay#cosplay/removeRole',
    service: 'cosplay',
    namespace: 'cosplay',
    method: 'removeRole',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'id', wire: 'id', source: 'json', codec: srcJsonCodec('dsh-cosplay#RoleId') }],
    result: srcJsonCodec('dsh-cosplay#CosplayState'),
  },
  {
    id: 'dsh-cosplay#cosplay/setActiveRole',
    service: 'cosplay',
    namespace: 'cosplay',
    method: 'setActiveRole',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'id', wire: 'id', source: 'json', codec: srcJsonCodec('dsh-cosplay#RoleId') }],
    result: srcJsonCodec('dsh-cosplay#CosplayState'),
  },
  {
    id: 'dsh-cosplay#cosplay/setEnabled',
    service: 'cosplay',
    namespace: 'cosplay',
    method: 'setEnabled',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'enabled', wire: 'enabled', source: 'json', codec: srcJsonCodec('dsh-cosplay#Enabled') }],
    result: srcJsonCodec('dsh-cosplay#CosplayState'),
  },
  {
    id: 'dsh-cosplay#cosplay/setThinkingStyle',
    service: 'cosplay',
    namespace: 'cosplay',
    method: 'setThinkingStyle',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'style', wire: 'style', source: 'json', codec: srcJsonCodec('dsh-cosplay#ThinkingStyle') }],
    result: srcJsonCodec('dsh-cosplay#CosplayState'),
  },
]

const COSPLAY_MEMBERS = [
  { kind: 'method', name: 'getState', signature: 'getState(): CosplayState' },
  { kind: 'method', name: 'upsertRole', signature: 'upsertRole(card: RoleCard): Promise<CosplayState>' },
  { kind: 'method', name: 'removeRole', signature: 'removeRole(id: string): Promise<CosplayState>' },
  { kind: 'method', name: 'setActiveRole', signature: 'setActiveRole(id: string | null): Promise<CosplayState>' },
  { kind: 'method', name: 'setEnabled', signature: 'setEnabled(enabled: boolean): Promise<CosplayState>' },
  { kind: 'method', name: 'setThinkingStyle', signature: 'setThinkingStyle(style: "neutral" | "role"): Promise<CosplayState>' },
]

const TYPERT_MANIFEST = {
  package: 'dsh-cosplay',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'cosplay',
        exportName: 'CosplayRuntime',
        description: 'Cosplay 角色库与开关（dsh-cosplay 设置页数据通道）。',
        tags: [],
        members: COSPLAY_MEMBERS,
      },
    ],
    events: [],
    objects: [],
  },
  invocations: COSPLAY_INVOCATIONS,
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 * @param config - 本行 Config（0.2.x 为带 `.get()` 的 volatile 引用；桩测试下可为普通值）。
 */
export function apply(ctx, config) {
  // ── 状态源 ────────────────────────────────────────────────────────────────
  // 读：以运行时 Config 为准——0.2.x 把**每个 volatile 字段**单独包成带 `.get()` 的
  // 引用（整对象本身不是引用），且 loader 在提交 volatile 变更时就地改写这些引用，
  // 所以逐字段解包后才能读到最新值。普通对象（桩测试）下 readField 原样返回。
  const readState = () => readField(config) ?? {}
  const read = () => normalizeState({
    enabled: readField(readState().enabled),
    thinkingStyle: readField(readState().thinkingStyle),
    activeRole: readField(readState().activeRole),
    roles: readField(readState().roles),
  })

  const write = async (next) => {
    // 序列化：activeRole 的 null 语义 → 空串（schema 无 null 类型）
    const patch = {
      enabled: next.enabled === true,
      thinkingStyle: next.thinkingStyle === 'role' ? 'role' : 'neutral',
      activeRole: next.activeRole ?? '',
      roles: next.roles,
    }
    await writeConfig(ctx, patch)
    return read()
  }

  // ── typert Remote（设置页数据通道；同时注册 `cosplay` 服务） ───────────────
  new CosplayRuntime(ctx, read, write)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => {
      void dispose()
    }
  }, 'dsh-cosplay: typert manifest')

  // ── 设置表单策略：本插件自带设置页，关闭自动生成表单 ─────────────────────
  // 0.2.x 形态：在 settings 子级里以 effect 注册，并把策略绑定到本插件 fiber。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // ── 人格注入（全局，随变量每次组装求值；含思维链指令，见 store.js） ──────
  ctx.systemPrompt.variable('cosplay_active', () => renderActivePersona(read()))
  ctx.systemPrompt.section({
    name: PERSONA_SECTION_ADDON,
    // 0.2.x 内置 persona 后缀段 order = 10200；本段紧随其后
    order: 10250,
    text: '{{cosplay_active}}',
  })

  // ── 内置 skill：自然语言创建角色卡（全局注册，模型可加载） ───────────────
  // source 必须显式提供：加载路径会校验 source 必须为字符串。
  ctx.skills.register({
    name: CARD_AUTHORING_SKILL_NAME,
    description: CARD_AUTHORING_SKILL_DESCRIPTION,
    whenToUse: CARD_AUTHORING_SKILL_WHEN_TO_USE,
    content: CARD_AUTHORING_SKILL_CONTENT,
    source: 'runtime',
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

  console.log(`[dsh-cosplay] cosplay-core activated (entry=${ENTRY_ID})`)
}
