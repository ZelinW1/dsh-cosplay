/**
 * 开发工具（不属于发布产物）：CDP 驱动的设置页端到端检查。
 *
 * 前置：隔离实例已启动且带 `--remote-debugging-port=9222`；无头 Chrome 已在 9222。
 * 运行：DSH_E2E_LOG=<实例日志> node test/tools/settings-check.mjs
 *
 * 检查项：
 *   1. 应用能正常渲染（无 "Failed to load plugins"）；
 *   2. 打开 设置 后，左侧出现「角色扮演」分区且不再停在"加载中…"；
 *   3. 界面读到了真实状态（内置角色「蓝色大肥鱼」）；
 *   4. 点击主开关后状态变化（写通道打通）。
 */
import { readFileSync } from 'node:fs'

const CDP_PORT = Number(process.env.DSH_E2E_CDP_PORT ?? 9222)
const LOG = process.env.DSH_E2E_LOG ?? 'C:/Users/xd503/dsh-cosplay-e2e/uiprobe.log'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loginUrlFromLog() {
  const text = readFileSync(LOG, 'utf8')
  const m = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
  if (!m) throw new Error(`日志里没有找到带 token 的 URL：${LOG}`)
  return m[0]
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  const events = []
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (entry) (msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result))
      return
    }
    events.push(msg)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { send, events, close: () => socket.close() }
}

const results = []
const check = (ok, label, detail = '') => results.push({ ok, label, detail })

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('19488'))
  ?? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!target) {
  console.error('没有可调页面:', JSON.stringify(targets.map((t) => t.url)))
  process.exit(2)
}
const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Log.enable')

const evaluate = async (expression) => {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    return { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }
  }
  return { value: result.result?.value }
}

// 1) 打开登录 URL
cdp.events.length = 0
await cdp.send('Page.navigate', { url: loginUrlFromLog() })
await sleep(9000)

let page = await evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  return {
    failedPlugins: text.includes('Failed to load plugins') || text.includes('did not activate'),
    appRendered: text.includes('DeepSeek Harness') || text.includes('默认工作区'),
    hasCosplayText: text.includes('角色扮演'),
  };
})()`)
check(page.value?.appRendered === true, '应用正常渲染', JSON.stringify(page.value))
check(page.value?.failedPlugins === false, '没有插件加载失败告警')

// 2) 打开设置：优先按可访问名找按钮，否则找带齿轮图标的按钮
const openSettings = await evaluate(`(() => {
  const all = [...document.querySelectorAll('button,[role="button"],a')];
  const byLabel = all.find((el) => /设置|Settings/i.test(el.getAttribute('aria-label') ?? '') );
  const byText = all.find((el) => /^(设置|Settings)$/.test((el.textContent ?? '').trim()));
  const target = byLabel ?? byText;
  if (!target) return { clicked: false, candidates: all.slice(0, 12).map((el) => (el.textContent ?? '').trim().slice(0, 20)) };
  target.click();
  return { clicked: true, label: (target.getAttribute('aria-label') ?? target.textContent ?? '').trim().slice(0, 30) };
})()`)
check(openSettings.value?.clicked === true, '找到并点击「设置」入口', JSON.stringify(openSettings.value))
await sleep(2500)

// 3) 设置面板里找「角色扮演」导航项并打开
const openSection = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button,[role="button"],a,li')];
  const target = nodes.find((el) => (el.textContent ?? '').trim() === '角色扮演');
  if (!target) {
    const text = document.body?.innerText ?? '';
    return { clicked: false, hasSettingsPanel: text.includes('通用设置') || text.includes('模型'), sample: text.slice(0, 300) };
  }
  target.click();
  return { clicked: true };
})()`)
check(openSection.value?.clicked === true, '设置页出现「角色扮演」分区并可点击', JSON.stringify(openSection.value))
await sleep(3000)

// 4) 读取分区内容与状态
const section = await evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  return {
    loading: text.includes('角色扮演设置加载中'),
    unavailable: text.includes('角色库不可用'),
    hasSwitchLabel: text.includes('Cosplay 模式'),
    hasDefaultRole: text.includes('蓝色大肥鱼'),
    hasNewRoleButton: text.includes('新建角色'),
    hasImport: text.includes('导入角色卡'),
    hasThinkingStyle: text.includes('思考风格'),
    excerpt: (() => { const i = text.indexOf('角色扮演'); return text.slice(Math.max(0, i - 40), i + 420); })(),
  };
})()`)
const s = section.value ?? {}
check(s.loading === false, '分区不再停在"加载中…"')
check(s.unavailable === false, 'Remote 通道可用（无"角色库不可用"）')
check(s.hasSwitchLabel === true, '渲染出主开关（Cosplay 模式）')
check(s.hasDefaultRole === true, '读到内置角色「蓝色大肥鱼」（读通道打通）')
check(s.hasNewRoleButton === true && s.hasImport === true, '渲染出建卡/导入控件')
check(s.hasThinkingStyle === true, '渲染出思考风格控件')

// 5) 点击主开关（写通道）
const toggle = await evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  const before = /Cosplay 模式：开启/.test(text) ? 'on' : 'off';
  const nodes = [...document.querySelectorAll('span,button,div')];
  const label = nodes.find((el) => (el.textContent ?? '').trim() === (before === 'on' ? 'Cosplay 模式：开启' : 'Cosplay 模式：关闭'));
  const clickable = label?.previousElementSibling ?? label?.parentElement?.querySelector('span');
  if (clickable) clickable.click();
  return { before, clicked: !!clickable };
})()`)
await sleep(2500)
const after = await evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  return {
    on: /Cosplay 模式：开启/.test(text),
    off: /Cosplay 模式：关闭/.test(text),
    playing: /当前扮演：/.test(text),
  };
})()`)
check(toggle.value?.clicked === true && (after.value?.on !== (toggle.value?.before === 'on')), '点击主开关后状态变化（写通道打通）', `before=${toggle.value?.before} after=${JSON.stringify(after.value)}`)

console.log('\n===== 设置页端到端检查 =====')
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.label}${r.detail ? `\n      ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
console.log('\n--- 分区文本片段 ---')
console.log(s.excerpt ?? '(无)')

const errors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
if (errors.length) {
  console.log('\n--- 控制台错误 ---')
  for (const e of errors.slice(-8)) console.log((e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
}
cdp.close()
process.exit(failed === 0 ? 0 : 1)
