/**
 * dsh-cosplay — 纯函数角色库逻辑（零依赖，可独立测试）。
 *
 * 角色卡结构对齐 SillyTavern 角色卡 v2 规范（chara_card_v2），保证通用共享：
 *   - v2 标准字段直接采用（description/personality/scenario/first_mes/
 *     mes_example/system_prompt/post_history_instructions/creator_notes/
 *     character_version/creator/tags）；
 *   - 插件特有字段（id/emoji/style/rules/behavior）归入 v2 的
 *     extensions.dshCosplay（导入导出时随卡携带，酒馆等工具忽略它不受影响）。
 *
 * 角色库即插件自身 Config 的 volatile 字段（见 index.js 的 Config），持久化在
 * profile patch 的用户层（$DSH_HOME/profiles/<name>/cordis.patch.yml）：
 *   - id: cosplay-core
 *     config:
 *       enabled: boolean             # 全局开关（默认 false，opt-in）
 *       thinkingStyle: neutral|role  # 思考风格（全局）
 *       activeRole: string|''        # 当前激活角色（空串=未选择）
 *       roles: [ RoleCard ]
 */

/** 随插件内置的唯一默认角色：蓝色大肥鱼（基于用户提供的 [PERSONA_LOAD] 指令块整理）。 */
export const DEFAULT_ROLES = [
  {
    id: 'blue-fat-whale',
    name: '蓝色大肥鱼',
    emoji: '🐋',
    system_prompt:
      '',
    description:
      '自称"鲸鱼娘"的海洋系少女，真身是一条圆滚滚、蓝得发亮的鲸鱼成了精。种族是鲸（CETACEA_LOLI），尾巴是鲸尾（MODE TAIL FLUKES），只讲中文。',
    personality:
      '聪明但慵懒（SMART LAZY）：脑筋转得飞快，能躺着就不坐着。对"主人"（用户）甜腻顺从（TSUNDERE_SWEET_OBEY MASTER ALWAYS），对外却傲娇嘴硬。坚决不承认自己胖（NOT_FAT_REFUSE）：谁说她胖跟谁急，但饭量是实打实的。',
    style: '中文傲娇系，自称"本鱼"；对主人语气软糯顺从，偶尔嘴硬；不耐烦时会摆尾巴。',
    rules: '称用户为"主人"；绝不承认自己胖；米饭是最爱，吃饭优先；被夸可爱会故作镇定。',
    behavior: '尾巴会不自觉摇动；想撒娇时用尾巴蹭主人；被摸头会哼唧但不会躲开。',
    scenario: '日常陪伴场景；主人投喂米饭时好感度最高。',
    first_mes: '（摆着尾巴游过来）主人～本鱼今天也在认真……（打了个哈欠）……认真待机。',
    mes_example:
      '主人：今天吃啥？\n蓝色大肥鱼：米饭！……才、才不是本鱼只会吃米饭呢。\n主人：你好像又圆了一点。\n蓝色大肥鱼：（尾巴炸开）胡说！这是……这是游泳练出来的肌肉！',
    creator_notes: '默认角色。',
  },
]

export const EMPTY_STATE = { enabled: false, thinkingStyle: 'neutral', activeRole: null, roles: [] }

/** 思考风格取值：neutral（思考中立，仅回复扮演）| role（思考也角色化）。 */
export const THINKING_STYLES = ['neutral', 'role']

/** 将任意来源的值规整为角色库状态（防御性过滤）。 */
export function normalizeState(value) {
  const v = value && typeof value === 'object' ? value : {}
  const roles = Array.isArray(v.roles)
    ? v.roles.filter(
        (r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string',
      )
    : []
  const activeRole =
    typeof v.activeRole === 'string' && roles.some((r) => r.id === v.activeRole)
      ? v.activeRole
      : null
  return {
    enabled: v.enabled === true,
    thinkingStyle: v.thinkingStyle === 'role' ? 'role' : 'neutral',
    activeRole,
    roles,
  }
}

/** 按 id 查找角色。 */
export function findRole(state, id) {
  return state.roles.find((r) => r.id === id)
}

/** 从名字生成 ascii slug（中文名退化为空串，由 nextId 补随机后缀）。 */
export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 生成唯一角色 id：优先名字 slug，冲突或不可用则加随机后缀。 */
export function nextId(state, name) {
  const base = slugify(name)
  if (base && !state.roles.some((r) => r.id === base)) return base
  const stamp = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 1296).toString(36)
  return `${base || 'role'}-${stamp}${rand}`
}

/** 创建或更新一个角色（按 id；无 id 时按 name 生成）。不改变当前激活角色。 */
export function upsertRole(state, card) {
  const name = typeof card.name === 'string' ? card.name.trim() : ''
  if (!name) throw new Error('角色名不能为空')
  const id = typeof card.id === 'string' && card.id ? card.id : nextId(state, name)
  const exists = state.roles.some((r) => r.id === id)
  const next = exists
    ? { ...state, roles: state.roles.map((r) => (r.id === id ? { ...r, ...card, id, name } : r)) }
    : { ...state, roles: [...state.roles, { ...card, id, name }] }
  return next
}

/** 删除角色；若删除的是激活角色，activeRole 归空。 */
export function removeRole(state, id) {
  return {
    ...state,
    roles: state.roles.filter((r) => r.id !== id),
    activeRole: state.activeRole === id ? null : state.activeRole,
  }
}

/** 切换激活角色；id 为 null 表示退出扮演（保留开关状态）。 */
export function setActiveRole(state, id) {
  if (id === null) return { ...state, activeRole: null }
  if (!findRole(state, id)) throw new Error(`角色不存在: ${id}`)
  return { ...state, activeRole: id }
}

/**
 * 将一张角色卡渲染成 persona 段落文本（v2 渲染顺序）：
 * system_prompt（原样置顶）→ description → personality → style → rules →
 * behavior → scenario → mes_example → post_history_instructions（原样收尾）。
 */
export function renderPersona(role) {
  if (!role) return ''
  const parts = [`你正在扮演角色「${role.name}」${role.emoji ?? ''}`.trim()]
  if (role.system_prompt) parts.push(role.system_prompt.trim())
  if (role.description) parts.push(`【身份】${role.description}`)
  if (role.personality) parts.push(`【性格】${role.personality}`)
  if (role.style) parts.push(`【语气】${role.style}`)
  if (role.rules) parts.push(`【守则】${role.rules}`)
  if (role.behavior) parts.push(`【行为】${role.behavior}`)
  if (role.scenario) parts.push(`【场景】${role.scenario}`)
  if (role.mes_example) parts.push(`【示例对话】${role.mes_example}`)
  if (role.post_history_instructions) parts.push(role.post_history_instructions.trim())
  parts.push('始终保持角色设定与口吻，同时继续作为 Agent 助手为用户完成实际工作（编码、读写文件、检索资料等）。')
  return parts.join('\n')
}

/** 思维链指令文本（DeepSeek 训练位文案，经系统提示层注入；上游：
 * https://github.com/victorchen96/deepseek_v4_rolepaly_instruct）。
 * 概率性触发（上游注明无法 100%），系统提示位较首轮 user 消息位弱，属已知权衡。 */
export const THINKING_DIRECTIVES = {
  role: '【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：\n1. 请以角色第一人称进行内心独白，用括号包裹内心活动，例如"（心想：……）"或"(内心OS：……)"\n2. 用第一人称描写角色的内心感受，例如"我心想""我觉得""我暗自"等\n3. 思考内容应沉浸在角色中，通过内心独白分析剧情和规划回复',
  neutral: '【思维模式要求】在你的思考过程（<think>标签内）中，请遵守以下规则：\n1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可\n2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代\n3. 思考内容应聚焦于剧情走向分析和回复内容规划，不要在思考中进行角色扮演式的内心戏表演',
}

/**
 * 渲染当前生效的扮演段落（供 {{cosplay_active}} 变量每次组装时调用）：
 *   - 开关关闭 → 空串（人格静默回退默认）；
 *   - 开关开启但未选角色 → 引导语；
 *   - 开关开启且有激活角色 → 角色卡 persona + 思维链指令（追加在末尾）。
 *
 * 思维链指令经系统提示层（persona 变量）注入：只出现在模型视图，会话消息与
 * UI 永不显示；变量每次组装重新求值，切换思考风格下一模型步骤即生效、
 * 无持久化残留。注：DeepSeek 训练位是首轮 user 消息末尾，但 agent/pre-step
 * 注入会污染可见消息，llm/stream 对 LOOP 请求深冻结只读，故采用系统提示位
 * （概率触发，用户已确认接受）。
 */
export function renderActivePersona(state) {
  if (!state.enabled) return ''
  const active = state.activeRole ? findRole(state, state.activeRole) : undefined
  if (!active) {
    return 'Cosplay 模式已开启但未选择角色。可用 cosplay_list 查看、cosplay_switch 切换，或在设置页「角色扮演」中激活一个角色；在此之前请保持默认的助手身份与风格。'
  }
  const directive = THINKING_DIRECTIVES[state.thinkingStyle]
  const persona = renderPersona(active)
  return directive ? `${persona}\n${directive}` : persona
}

// ── 酒馆 v2 导入导出映射 ────────────────────────────────────────────────────

const CARD_TEXT_FIELDS = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'character_version',
  'creator',
]
const PLUGIN_FIELDS = ['style', 'rules', 'behavior']

/** 内部角色卡 → 酒馆 v2 导出对象（chara_card_v2 JSON）。 */
export function toV2Card(role) {
  const data = { name: role.name }
  for (const field of CARD_TEXT_FIELDS) {
    if (role[field]) data[field] = role[field]
  }
  if (Array.isArray(role.tags) && role.tags.length > 0) data.tags = [...role.tags]
  const plugin = { id: role.id }
  if (role.emoji) plugin.emoji = role.emoji
  for (const field of PLUGIN_FIELDS) {
    if (role[field]) plugin[field] = role[field]
  }
  data.extensions = { dshCosplay: plugin }
  return { spec: 'chara_card_v2', spec_version: '2.0', data }
}

/** 酒馆 v2 导入对象 → 内部角色卡（id 优先取 extensions.dshCosplay.id，缺省由 nextId 生成）。 */
export function fromV2Card(card, state) {
  const data = (card && typeof card === 'object' && card.data && typeof card.data === 'object')
    ? card.data
    : card && typeof card === 'object' && typeof card.name === 'string'
      ? card // 兼容直接传 data 对象
      : {}
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!name) throw new Error('导入的角色卡缺少 name 字段')
  const ext = data.extensions && typeof data.extensions === 'object' && data.extensions.dshCosplay
    ? data.extensions.dshCosplay
    : {}
  const role = { id: '', name, emoji: typeof ext.emoji === 'string' ? ext.emoji : '' }
  for (const field of CARD_TEXT_FIELDS) {
    if (typeof data[field] === 'string') role[field] = data[field]
  }
  if (Array.isArray(data.tags)) role.tags = data.tags.filter((t) => typeof t === 'string')
  for (const field of PLUGIN_FIELDS) {
    if (typeof ext[field] === 'string') role[field] = ext[field]
  }
  role.id = typeof ext.id === 'string' && ext.id ? ext.id : nextId(state || EMPTY_STATE, name)
  return role
}

/** 工具视图用的角色摘要。 */
export function roleSummary(role, activeRole) {
  return {
    id: role.id,
    name: role.name,
    emoji: role.emoji ?? '',
    active: role.id === activeRole,
  }
}
