/**
 * dsh-cosplay 桩测试（不启动 Electron，不写任何生产数据）。
 *
 * 验证目标：
 *   1. 改造后的 `apply(ctx, config)` 在 0.2.x 形态的 Config 引用下能完成注册、
 *      不抛错——桩只提供插件实际调用到的接口，"调了没桩的方法"会以 TypeError 暴露；
 *   2. 角色库读写、开关、思考风格、persona 求值端到端可用；
 *   3. Config schema 的 volatile 声明与默认值符合 0.2.x 设置表单的要求；
 *   4. 客户端描述符契约（参数 codec 必须 strict 且带 create）——这条是静态断言，
 *      因为该约束只在浏览器挂载时才会被触发，host 桩测不出来。
 *
 * 每个场景建独立桩（角色库互不干扰）。
 * 运行：node test/host-stub.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, Config, ENTRY_ID, PERSONA_SECTION_ADDON } from '../src/index.js'
import { DEFAULT_ROLES } from '../src/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROLE_ID = DEFAULT_ROLES[0].id

/** 递归解包 schemastery 的 volatile 引用（`{ get }`）与容器内部节点。 */
function unwrap(value) {
  let current = value
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    if (typeof current.get !== 'function') break
    current = current.get()
  }
  if (Array.isArray(current)) return current.map(unwrap)
  if (current !== null && typeof current === 'object' && Object.getPrototypeOf(current) === Object.prototype) {
    return Object.fromEntries(Object.entries(current).map(([k, v]) => [k, unwrap(v)]))
  }
  return current
}

/**
 * 构造与 0.2.x 运行时同形的 Config 视图：
 * 每个 volatile 字段是独立的 `{ get }` 引用，`get()` 读取可变 state，
 * 等价于 loader 对 volatile 变更的就地提交。
 */
function createStub() {
  const validated = Config['~standard'].validate({})
  assert.equal(validated.issues, undefined, 'Config 默认值应可校验通过')
  const state = unwrap(validated.value)

  const view = {}
  for (const key of Object.keys(state)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => ({ get: () => state[key], [Symbol.for('cosmokit.volatile.write')]: () => {} }),
    })
  }

  const registered = { tools: new Map(), sections: [], variables: new Map(), skills: [] }
  const events = { configPatches: [] }

  const ctx = {
    fiber: { id: 'stub-fiber' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(_deps, fn) {
      fn(ctx)
      return () => {}
    },
    get(name) {
      return ctx[name]
    },
    // Service 基类构造时会调用 ctx.reflect.provide(name, instance, check)
    reflect: {
      provide() {
        return () => {}
      },
      get() {
        return undefined
      },
    },
    settings: {
      configure(presentation, owner) {
        events.configure = { presentation, owner }
        return () => {}
      },
      async update(ns, patch) {
        events.configPatches.push({ ns, patch })
        Object.assign(state, patch)
      },
    },
    systemPrompt: {
      variable(name, provider) {
        registered.variables.set(name, provider)
        return () => {}
      },
      section(section) {
        registered.sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        registered.tools.set(tool.name, tool)
        return () => {}
      },
    },
    skills: {
      register(skill) {
        registered.skills.push(skill)
        return () => {}
      },
    },
    typert: {
      register(manifest) {
        registered.typertManifest = manifest
        return () => {}
      },
    },
  }

  return { ctx, config: view, state, registered, events }
}

async function callTool(registered, name, args) {
  const tool = registered.tools.get(name)
  assert.ok(tool, `工具 ${name} 未注册`)
  return tool.execute(args)
}

function persona(registered) {
  const provider = registered.variables.get('cosplay_active')
  assert.ok(provider, 'cosplay_active 变量未注册')
  return provider()
}

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push(['PASS', label, ''])
  } catch (error) {
    results.push(['FAIL', label, error?.message ?? String(error)])
  }
}

// ① 加载期注册
await check('apply() 完成注册：5 工具 + persona 段/变量 + skill + typert manifest + configure(auto:false)', async () => {
  const { ctx, config, registered, events } = createStub()
  apply(ctx, config)
  assert.equal(registered.tools.size, 5, `工具数量应为 5，实际 ${registered.tools.size}`)
  for (const name of ['cosplay_show', 'cosplay_list', 'cosplay_switch', 'cosplay_upsert', 'cosplay_remove']) {
    assert.ok(registered.tools.has(name), `缺少工具 ${name}`)
  }
  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].name, PERSONA_SECTION_ADDON)
  assert.equal(registered.sections[0].text, '{{cosplay_active}}')
  assert.ok(registered.sections[0].order > 10200, 'persona 段应挂在内置后缀段 10200 之后')
  assert.equal(registered.skills.length, 1)
  assert.equal(registered.skills[0].source, 'runtime')
  assert.equal(registered.typertManifest.package, 'dsh-cosplay')
  assert.equal(registered.typertManifest.invocations.length, 6)
  assert.equal(events.configure?.presentation?.auto, false)
  assert.equal(events.configure?.owner, ctx.fiber)
})

// ② 关闭态
await check('开关关闭：persona 渲染空串；cosplay_switch 软禁用并提示先开启', async () => {
  const { ctx, config, registered } = createStub()
  apply(ctx, config)
  assert.equal(persona(registered), '')
  const text = await callTool(registered, 'cosplay_switch', { id: DEFAULT_ROLE_ID })
  assert.match(text, /未开启/)
})

// ③ 新装即用
await check('新装即用：默认角色「蓝色大肥鱼」及其激活状态均来自 Config 默认值', async () => {
  const { ctx, config, registered } = createStub()
  apply(ctx, config)
  const text = await callTool(registered, 'cosplay_list', {})
  assert.match(text, /Cosplay 模式：关闭/)
  assert.match(text, /蓝色大肥鱼/)
  assert.match(text, /★ 激活/)
})

// ④ 写入落在条目 Config 上
await check(`写入契约：settings.update 以 ns=${ENTRY_ID} 落盘，角色库与空串序列化正确`, async () => {
  const { ctx, config, registered, events } = createStub()
  apply(ctx, config)
  await callTool(registered, 'cosplay_upsert', { name: '测试角色A', description: '身份A' })
  const patch = events.configPatches.at(-1)
  assert.equal(patch.ns, ENTRY_ID, `配置命名空间应为条目 id ${ENTRY_ID}`)
  assert.equal(patch.patch.roles.length, 2, '角色库应含默认角色 + 新角色')
  assert.equal(patch.patch.activeRole, DEFAULT_ROLE_ID, '未显式切换时应保留默认激活角色（不被写入抹掉）')
  assert.equal(typeof patch.patch.enabled, 'boolean')
  assert.ok(['neutral', 'role'].includes(patch.patch.thinkingStyle))
})

// ⑤ 开启开关 + persona 生效
await check('开启开关：同一次读即见新值，persona 渲染角色卡 + 中立思维指令', async () => {
  const { ctx, config, registered } = createStub()
  apply(ctx, config)
  await callTool(registered, 'cosplay_upsert', { name: '测试角色A', description: '身份A' })
  await ctx.settings.update(ENTRY_ID, { enabled: true })
  const rendered = persona(registered)
  assert.match(rendered, /你正在扮演角色「蓝色大肥鱼」/)
  assert.match(rendered, /【思维模式要求】/, 'neutral 风格应追加中立思维指令')
  assert.match(rendered, /始终保持角色设定与口吻/)
})

// ⑥ 切换角色 / 思考风格 / 退出扮演 / 删除
await check('切换与删除：cosplay_switch、role 风格、退出扮演、cosplay_remove 全部生效', async () => {
  const { ctx, config, registered } = createStub()
  apply(ctx, config)
  await ctx.settings.update(ENTRY_ID, { enabled: true })
  await callTool(registered, 'cosplay_upsert', { id: 'role-b', name: '测试角色B', description: '身份B' })

  const switched = await callTool(registered, 'cosplay_switch', { id: 'role-b' })
  assert.match(switched, /已切换到角色「测试角色B」/)
  assert.match(persona(registered), /你正在扮演角色「测试角色B」/)

  await ctx.settings.update(ENTRY_ID, { thinkingStyle: 'role' })
  assert.match(persona(registered), /【角色沉浸要求】/, 'role 风格应追加角色化思考指令')

  const shown = await callTool(registered, 'cosplay_show', {})
  assert.match(shown, /你正在扮演角色「测试角色B」/)

  const quit = await callTool(registered, 'cosplay_switch', { id: 'null' })
  assert.match(quit, /已退出扮演/)
  assert.match(persona(registered), /已开启但未选择角色/, '退出扮演后 persona 应回落引导语（不再扮演任何角色）')

  const removed = await callTool(registered, 'cosplay_remove', { id: 'role-b' })
  assert.match(removed, /已删除角色 role-b/)
  assert.match(await callTool(registered, 'cosplay_show', { id: 'role-b' }), /未找到角色/)
  assert.doesNotMatch(await callTool(registered, 'cosplay_list', {}), /测试角色B/)
})

// ⑦ 默认激活角色在开关打开时生效（写入不得抹掉它）
await check('默认激活角色：upsert 后再开开关，persona 仍按默认角色渲染', async () => {
  const { ctx, config, registered } = createStub()
  apply(ctx, config)
  await callTool(registered, 'cosplay_upsert', { name: '测试角色A' })
  await ctx.settings.update(ENTRY_ID, { enabled: true, activeRole: DEFAULT_ROLE_ID })
  assert.match(persona(registered), /你正在扮演角色「蓝色大肥鱼」/)
})

// ⑧ schema 契约
await check('Config schema：四个字段均声明 .volatile()，默认值符合预期', async () => {
  const dict = Config.dict ?? {}
  for (const key of ['enabled', 'thinkingStyle', 'activeRole', 'roles']) {
    assert.ok(dict[key]?.meta?.volatile, `字段 ${key} 应声明 .volatile()`)
  }
  const { state } = createStub()
  assert.equal(state.enabled, false)
  assert.equal(state.thinkingStyle, 'neutral')
  assert.equal(state.activeRole, DEFAULT_ROLE_ID, '默认应激活内置示例角色')
  assert.equal(state.roles.length, 1)
  assert.equal(state.roles[0].id, DEFAULT_ROLE_ID)
})

// ⑨ typert 描述符契约（复刻 dsh-typert-registry 的 validateCodec/validateInvocation）
// 这条是方案 B 在真宿主上抓到 `strict codec has no create() factory` 之后补的回归护栏。
await check('typert 契约：每个 invocation 的 codec 都能通过 validateCodec 校验', async () => {
  const { ctx, config, registered } = createStub()
  apply(ctx, config)
  const manifest = registered.typertManifest
  const validateCodec = (codec, subject) => {
    assert.ok(codec, `${subject} 缺少 codec`)
    if (codec.mode === 'src-json') return
    assert.ok(codec.typeSymbol && codec.typeSymbol.length > 0, `${subject} typeSymbol 不能为空`)
    assert.equal(typeof codec.create, 'function', `${subject} strict codec 必须提供 create() 工厂`)
  }
  const validateInvocation = (inv) => {
    const subject = `${manifest.package}#${inv.service}/${inv.method}`
    assert.ok(inv.id.length > 0 && !inv.id.includes('#') === false, `${subject} id 形状异常`)
    assert.equal(inv.invocation?.kind, 'direct', `${subject} 当前仅支持 direct`)
    for (const p of inv.parameters) validateCodec(p.codec, `${subject} 参数 ${p.name}`)
    validateCodec(inv.result, `${subject} 返回值`)
  }
  assert.equal(manifest.invocations.length, 6)
  for (const inv of manifest.invocations) validateInvocation(inv)
  // 服务成员声明与 Remote 方法必须一一对应
  const members = manifest.model.services[0].members.map((m) => m.name).sort()
  assert.deepEqual(members, ['getState', 'removeRole', 'setActiveRole', 'setEnabled', 'setThinkingStyle', 'upsertRole'])
})

// ⑩ 客户端描述符契约（静态断言）
// 依据：dsh-api-gateway 的 requireStrictInputs 要求**参数** codec 为 strict，
// 且 dsh-typert-registry 的 validateCodec 要求 strict codec 带 create() 工厂。
// 该约束只在浏览器 $mount 时触发，host 桩测不到，因此在此做源码级护栏。
await check('客户端契约：参数 codec 为 strict 且带 create()，result 可为 src-json', async () => {
  const source = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')
  // 注释里会引用反例（"不要这样写"），因此断言只针对剥离注释后的代码文本
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(
    code,
    /const\s+strictCodec\s*=\s*\([^)]*\)\s*=>\s*\(\{\s*mode:\s*'strict'[^}]*create:/,
    'client.js 必须定义带 create() 的 strictCodec（参数 codec 契约）',
  )
  assert.match(code, /codec:\s*strictCodec\(/, '参数必须使用 strictCodec')
  assert.match(code, /result:\s*resultCodec\(/, 'result 应使用 resultCodec（src-json）')
  assert.doesNotMatch(code, /codec:\s*resultCodec\(/, '参数不得使用 src-json codec（会被 requireStrictInputs 拒绝）')
  // 挂载不得包在 ctx.effect(async …) 里：那里的 rejection 会被 cordis 静默吞掉
  assert.doesNotMatch(code, /ctx\.effect\(\s*async/, '挂载不得包在 ctx.effect(async …) 中')
  assert.match(code, /async\s+apply\(ctx\)/, 'apply 应为 async 并 return disposer')
  // 读取命名空间前必须用 ctx.inject 声明
  assert.match(code, /ctx\.inject\(\s*\[\s*'remote\.cosplay'/, '读取 remote.cosplay 前必须 ctx.inject 声明')
})

let failed = 0
for (const [status, label, detail] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✅' : '❌'} ${label}${detail ? `\n     → ${detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exitCode = failed === 0 ? 0 : 1
