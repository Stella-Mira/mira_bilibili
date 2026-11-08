/**
 * mira_bilibili × mira_account 契约联调（开发期可选自检）
 *
 *   node test/integration-mira-account.mjs
 *
 * 与 `test/smoke.mjs` 的区别：smoke 用手写的假 miraAccount 验证本插件自己的行为；
 * 这里加载**真实的 `mira_account` 插件**（同仓库 `../../mira_account/lib/index.js`），
 * 验证两边契约真的对得上：
 *   · `registerAdapter` 被真实 service 接受（platform/send/onMessage/status/createSession）
 *   · `inboundPolicy=create` → 真实 router 调本插件 `createSession` → 落 bindings.json → steer 投递
 *   · 同 message_id 第二次被真实去重表丢掉
 *   · `miraAccount.send()` 首次反向绑定、已有 taker 时 `binding/conflict`、`force` 抢答后才发
 *   · 本插件 `adapter.send` 返回 B 站 `msg_key`，被真实服务记成 self（echo 去重）
 *   · 日志 / 状态 / 返回值里没有凭据明文
 *
 * 需要：同仓库里有 `mira_account/`（它是 mira_bilibili 的**运行前置**）。
 * 不发真实网络请求（global fetch 被替换）；全部在临时 DSH_HOME 里跑。
 * 只在开发/验收时跑，不随 npm 包发布（package.json 的 files 只有 lib）。
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []
function check(ok, message) {
  if (ok) { passed++; return true }
  failures.push(message)
  return false
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return check(a === e, message + '（期望 ' + e + '，实得 ' + a + '）')
}
function includes(text, needle, message) {
  return check(String(text).includes(needle), message + '（应包含 ' + JSON.stringify(needle) + '）')
}

const HOME = mkdtempSync(join(tmpdir(), 'mira-bili-contract-'))
process.env.DSH_HOME = HOME
const ACCOUNT_DIR = join(HOME, 'mira_config', 'mira_account')
mkdirSync(join(ACCOUNT_DIR, 'creds'), { recursive: true })

const SECRET = { SESSDATA: 'CONTRACT-SESSDATA', bili_jct: 'CONTRACT-JCT', buvid3: 'CONTRACT-BUVID' }

writeFileSync(join(ACCOUNT_DIR, 'accounts.json'), JSON.stringify({
  schemaVersion: 1,
  accounts: [{
    id: 'bili-main', platform: 'bilibili', label: '主号', enabled: true,
    inboundPolicy: 'create', createdAt: '2026-10-26T15:00:00.000Z',
  }],
}, null, 2))
const credsFile = join(ACCOUNT_DIR, 'creds', 'bili-main.json')
writeFileSync(credsFile, JSON.stringify({
  schemaVersion: 1, platform: 'bilibili', kind: 'cookie', fields: SECRET,
}, null, 2))
chmodSync(credsFile, 0o600)

/* ── 假 fetch（记录请求；回 nav 与 send_msg） ─────────────── */

const calls = []
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: String(init.method || 'GET').toUpperCase() }
  calls.push(call)
  if (call.url.includes('/x/web-interface/nav')) {
    return {
      ok: true, status: 200,
      json: async () => ({
        code: 0,
        data: { isLogin: true, mid: 12345, uname: '星辉', wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbb.png' } },
      }),
    }
  }
  if (call.url.includes('web_im/v1/web_im/send_msg')) {
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { msg_key: 'REAL-MSG-KEY', msg_seqno: 7 } }) }
  }
  return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }
}

const logs = []
const logger = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m), debug: () => {} }

/** 假 agents：create/resume/get，记录 steer（真实的 mira_account deliver 会调它）。 */
const agents = {
  created: [],
  live: new Map(),
  create({ sessionId }) {
    const agent = {
      id: sessionId,
      status: 'idle',
      session: {
        id: sessionId,
        events: [],
        append(type, data) { this.events.push({ type, data }) },
        deriveMessages: () => [],
      },
      steers: [],
      steer(message) { this.steers.push(message) },
      followup() {},
      cancel() {},
    }
    agents.created.push(sessionId)
    agents.live.set(sessionId, agent)
    return { agent }
  },
  async resume({ resumeSessionId }) {
    const agent = agents.live.get(resumeSessionId)
    if (!agent) throw new Error('会话不存在')
    return { agent }
  },
  get: (id) => agents.live.get(id) ?? null,
}

function makeCtx(extra = {}) {
  const tools = new Map()
  const provided = new Map()
  const disposers = []
  return Object.assign({
    logger,
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return () => {} },
    provide(name, value) { provided.set(name, value); return () => provided.delete(name) },
    sessionController: { async resolveAgent(sessionId) { return { agent: agents.live.get(sessionId) || null } } },
    sessions: { async flush() {} },
    toolsMap: tools,
    provided,
    dispose() { for (const dispose of disposers.reverse()) { try { if (typeof dispose === 'function') dispose() } catch { /* noop */ } } },
  }, extra)
}

let biliCtx = null
let accountCtx = null
try {
  /* 1) 真装 mira_account（autoConnect:false：等我们注册适配器后再手动驱动） */
  const { apply: applyAccount } = await import('../../mira_account/lib/index.js')
  accountCtx = makeCtx()
  const accountResult = applyAccount(accountCtx, { autoConnect: false })
  eq(accountResult && accountResult.ok, true, 'mira_account 应加载成功')
  const miraAccount = accountCtx.provided.get('miraAccount')
  check(!!miraAccount, 'mira_account 应 provide("miraAccount")')

  /* 2) 装 mira_bilibili（autoStart:false：不自动登录，下面显式走路由） */
  const { apply: applyBili } = await import('../lib/index.js')
  biliCtx = makeCtx({ miraAccount, agents, workspaceRegistry: { async resolveByPath() { return null } } })
  const biliResult = applyBili(biliCtx, {
    schemaVersion: 2,
    accountId: 'bili-main',
    autoStart: false,
    autoReply: { enabled: true, strangerPolicy: 'reply', mergeWindowMs: 0, agentCwd: join(HOME, 'work') },
    danmaku: { enabled: false },
  })
  eq(biliResult && biliResult.ok, true, 'mira_bilibili 应加载成功')
  eq(biliResult.adapterRegistered, true, '适配器应注册成功')

  /* 3) 适配器被真实 service 接受 */
  const adapter = miraAccount.adapterFor('bilibili')
  check(!!adapter && adapter.platform === 'bilibili', '真实 mira_account 收到 bilibili 适配器')

  /* 4) inboundPolicy=create：真实路由 → createSession → 登记 taker → steer */
  const routed = await miraAccount.inbound({
    accountId: 'bili-main', kind: 'user', peerId: 456, display: '小明',
    message: { id: 'REAL-K1', text: '你好呀', sender: '456' },
  })
  eq(routed.routed, 'created', '入站应走 inboundPolicy=create')
  check(!!routed.sessionId, 'created 应返回 sessionId')
  eq(agents.created.length, 1, '真实 router 应调用本插件 adapter.createSession 建 1 个会话')
  const resolved = miraAccount.resolve('bili-main', 'user', 456)
  eq(resolved.taker && resolved.taker.sessionId, routed.sessionId, '真实绑定表里应有 taker')
  const bindingsFile = JSON.parse(readFileSync(join(ACCOUNT_DIR, 'bindings.json'), 'utf8'))
  check(bindingsFile.bindings.some((b) => b.kind === 'user' && b.peerId === '456' && b.mode === 'taker'),
    'bindings.json 应真落盘')
  const roomAgent = agents.live.get(routed.sessionId)
  eq(roomAgent.steers.length, 1, '消息应 steer 到新建会话（不是 followup）')
  includes(roomAgent.steers[0].content[0].text, '你好呀', 'steer 文本应是私信正文')

  /* 5) 同 message_id 第二次：真实去重表丢掉 */
  const dup = await miraAccount.inbound({
    accountId: 'bili-main', kind: 'user', peerId: 456, display: '小明',
    message: { id: 'REAL-K1', text: '你好呀', sender: '456' },
  })
  eq(dup.routed, 'dup', '同 message_id 第二次应是 dup')
  eq(roomAgent.steers.length, 1, 'dup 时不得再 steer')

  /* 6) 反向绑定：另一个会话 send → 冲突；force 抢答后才真发 */
  let conflict = null
  try {
    await miraAccount.send({ accountId: 'bili-main', kind: 'user', peerId: 456, payload: { text: '抢答' }, sessionId: 'S-human' })
  } catch (error) { conflict = error }
  eq(conflict && conflict.code, 'binding/conflict', '已有 taker 时 send 应报 binding/conflict')
  check(!calls.some((c) => c.url.includes('send_msg')), '冲突时不应发出私信')
  const sent = await miraAccount.send({
    accountId: 'bili-main', kind: 'user', peerId: 456, payload: { text: '抢答' }, sessionId: 'S-human', force: true,
  })
  eq(sent.ok, true, 'force 后应发出')
  eq(sent.messageId, 'REAL-MSG-KEY', '适配器应把 B 站 msg_key 作为 messageId 返回')
  eq(sent.binding && sent.binding.mode, 'taker', 'force 后反向绑定应为 taker')
  check(calls.some((c) => c.url.includes('send_msg') && c.method === 'POST'), '应真的请求 send_msg')
  check(miraAccount.bindings().some((b) => b.sessionId === 'S-human' && b.mode === 'taker'),
    '真实绑定表里的 taker 应换成 S-human')

  /* 7) echo 去重：出站 msg_key 被记成 self */
  check(miraAccount.status().dedup.self >= 1, '出站 msg_key 应被记成 self（echo 去重）')

  /* 8) 凭据不外泄 */
  const surfaces = JSON.stringify({ logs, biliResult }) + JSON.stringify(miraAccount.status())
  check(!surfaces.includes(SECRET.SESSDATA) && !surfaces.includes(SECRET.bili_jct),
    '日志/状态/返回值里不得出现凭据明文')
} finally {
  if (biliCtx) biliCtx.dispose()
  if (accountCtx) accountCtx.dispose()
  // dispose 会 flush 去重表；再确认一次落盘
  try {
    const seen = JSON.parse(readFileSync(join(ACCOUNT_DIR, 'seen', 'bilibili.json'), 'utf8'))
    // 去重键是「账号id|消息id」（平台级文件 + 账号级键）：两个账号撞号时不会互相误判
    check(!!seen.self && Object.keys(seen.self).includes('bili-main|REAL-MSG-KEY'),
      'seen/bilibili.json 落盘里应有 self 记录（键形如 bili-main|REAL-MSG-KEY）：' + JSON.stringify(Object.keys(seen.self || {})))
  } catch (error) {
    check(false, 'seen/bilibili.json 应落盘：' + error.message)
  }
  process.env.DSH_HOME = HOME
  rmSync(HOME, { recursive: true, force: true })
}

console.log('通过 ' + passed + ' 项断言')
if (failures.length) {
  for (const failure of failures) console.log('[FAIL] ' + failure)
  console.log('\n==== CONTRACT FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== CONTRACT PASS（' + passed + ' 项断言）====')
process.exit(0)
