/**
 * 开发工具（不属于发布产物）：用 Electron 自带的 CDP 远程调试自动检查客户端设置页。
 *
 * 用途：把"改 client.js → 人工刷新浏览器 → 肉眼判断"变成可自动化的闭环。
 *
 * 前置：
 *   1. 以 `--remote-debugging-port=9222` 启动隔离测试实例；
 *   2. 该实例已打印带 token 的 URL（本脚本从日志里读）。
 * 运行：node test/tools/cdp-probe.mjs [profilePageUrlOrToken] [cdpPort]
 */
const CDP_PORT = Number(process.argv[3] ?? 9222)
const LOG = process.env.DSH_E2E_LOG ?? 'C:/Users/xd503/dsh-cosplay-e2e/uiprobe.log'

import { readFileSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从实例日志里解析出带 token 的登录 URL。 */
function loginUrlFromLog() {
  if (process.argv[2]?.startsWith('http')) return process.argv[2]
  const text = readFileSync(LOG, 'utf8')
  const m = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
  if (!m) throw new Error(`日志里没有找到带 token 的 URL：${LOG}`)
  return m[0]
}

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

/** 极简 CDP 客户端：只用到 Page/Runtime/Console 三组域。 */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', (e) => reject(new Error(`CDP 连接失败: ${e?.message ?? e}`)), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  const events = []
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (entry) msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
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

const loginUrl = loginUrlFromLog()
console.log(`[probe] 登录 URL: ${loginUrl.replace(/token=.*/, 'token=***')}`)
console.log(`[probe] CDP 端口: ${CDP_PORT}`)

const targets = await cdpTargets()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('[probe] 没有找到可调试的 page target。当前 targets:')
  console.error(JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url, title: t.title })), null, 1))
  process.exit(2)
}
console.log(`[probe] 目标页面: ${page.url}`)

const cdp = await connect(page.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Log.enable')

// 收集控制台与异常
const consoleLines = []
cdp.events.length = 0
cdp.send('Runtime.enable').catch(() => {})

await cdp.send('Page.navigate', { url: loginUrl })
await sleep(6000)

/** 读取页面文本与关键 DOM 状态。 */
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    return { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }
  }
  return { value: result.result?.value }
}

const state = await evaluate(`(() => {
  const out = {};
  out.url = location.href.replace(/token=.*/, 'token=***');
  out.title = document.title;
  const bodyText = (document.body && document.body.innerText) || '';
  out.hasLoading = bodyText.includes('角色扮演设置加载中');
  out.hasUnavailable = bodyText.includes('角色库不可用');
  const idx = bodyText.indexOf('角色');
  out.snippet = bodyText.slice(Math.max(0, idx - 280), idx + 200);
  return out;
})()`)

console.log('\n[probe] 页面状态:', JSON.stringify(state, null, 1))

const consoleEvents = cdp.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .map((e) => ({
    type: e.params.type,
    text: (e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
  }))
const exceptionEvents = cdp.events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text)

console.log(`\n[probe] 控制台消息 ${consoleEvents.length} 条：`)
for (const line of consoleEvents.slice(-25)) console.log(`  [${line.type}] ${line.text.slice(0, 300)}`)
console.log(`\n[probe] 未捕获异常 ${exceptionEvents.length} 条：`)
for (const line of exceptionEvents.slice(-10)) console.log(`  ${String(line).slice(0, 400)}`)

cdp.close()
process.exit(0)
