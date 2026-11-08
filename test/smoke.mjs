/**
 * mira_bilibili 自检：node test/smoke.mjs
 *
 * 全过 → 退出码 0，末行 `==== ALL PASS（N 项断言）====`；失败逐行 `[FAIL] 编号 说明`，退出码 1。
 *
 * 覆盖 tool_shared/PLAN.md §1.4 的 D1–D9：
 *   D1  本文件能跑通（下面每一条都是断言）
 *   D2  无 creds 文件 → bili_status 报 creds/missing，hint 指向 creds/<id>.json
 *   D3  登录自检：真请求一次 nav；成功 {ok:true,mid,uname}、失败 creds/invalid
 *   D4  读预算超限：第 N+1 次 budget/exceeded 且 **fetch 未被调用**
 *   D5  逃生舱 bili_api 打同一接口同样被预算拦（不可绕过；暂停期同样拦）
 *   D6  假 412 → pauseUntil 前进 + paused=true；暂停期内直接拒且不发请求；连续撞墙退避加倍
 *   D7  首次 bili_send_private_msg → 自动登记 taker 且调用 miraAccount.send；第二个会话冲突不发
 *   D8  同 msg_key 二次轮询不重复投递（手工去重 + mira_account.inbound 只被调一次）；合并窗口
 *   D9  直播间白名单外不自动应答（不建 agent 会话），bili_live_status 里 ignored 计数可见；白名单内正向对照
 *
 * 另加：预算填 0 不会关闭预算、凭据 600 自愈、凭据绝不回显、schemaVersion 拒绝、
 *       单实例保护、工具清单、adapter.createSession（config/missing 与成功两条路）。
 *
 * 全部在临时 `DSH_HOME` 里跑：不碰真实配置、不发真实请求（global fetch 被替换成假实现）。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __testing } from '../lib/index.js'
import { pollOnce } from '../lib/agent.js'

/* ── 测试小框架 ─────────────────────────────────────────── */

let passed = 0
const failures = []
let current = '(未命名)'

function check(ok, message) {
  if (ok) { passed++; return true }
  failures.push('[' + current + '] ' + message)
  return false
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return check(a === e, message + '（期望 ' + e + '，实得 ' + a + '）')
}

function includes(text, needle, message) {
  return check(String(text).includes(needle), message + '（应包含 ' + JSON.stringify(needle) + '，实得 ' + JSON.stringify(String(text).slice(0, 200)) + '）')
}

async function test(id, name, fn) {
  current = id + ' ' + name
  try {
    await fn()
  } catch (error) {
    failures.push('[' + current + '] 抛异常：' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 隔离环境 ───────────────────────────────────────────── */

const TMP = mkdtempSync(join(tmpdir(), 'mira-bilibili-smoke-'))
process.env.DSH_HOME = TMP
let caseSeq = 0

const logLines = []
const logger = {
  info: (m) => logLines.push('I ' + m),
  warn: (m) => logLines.push('W ' + m),
  error: (m) => logLines.push('E ' + m),
  debug: () => {},
}

/** 每个用例一个独立 DSH_HOME（凭据 / 预算状态互不影响）。 */
function freshHome() {
  caseSeq++
  const home = join(TMP, 'case-' + caseSeq)
  mkdirSync(join(home, 'mira_config', 'mira_account', 'creds'), { recursive: true })
  mkdirSync(join(home, 'mira_config', 'mira_bilibili'), { recursive: true })
  process.env.DSH_HOME = home
  return home
}

const SECRET_SESSDATA = 'SESSDATA-VALUE-XYZ'
const SECRET_JCT = 'JCT-VALUE-ABC'
const SECRET_BUVID = 'BUVID-VALUE-123'

function writeCreds(home, { accountId = 'bili-main', fields, mode = 0o600, extra = {} } = {}) {
  const file = join(home, 'mira_config', 'mira_account', 'creds', accountId + '.json')
  const body = {
    schemaVersion: 1,
    platform: 'bilibili',
    kind: 'cookie',
    fields: fields ?? { SESSDATA: SECRET_SESSDATA, bili_jct: SECRET_JCT, buvid3: SECRET_BUVID },
    updatedAt: '2026-10-26T15:00:00.000Z',
    ...extra,
  }
  writeFileSync(file, JSON.stringify(body, null, 2))
  chmodSync(file, mode)
  return file
}

/* ── 假 fetch（绝不发真实请求） ─────────────────────────── */

const http = { calls: [], routes: [] }

function route(match, reply) {
  http.routes.push({ match, reply })
}

function resetHttp() {
  http.calls.length = 0
  http.routes.length = 0
}

const jsonOf = (json, status = 200) => () => ({ status, json })
const statusOf = (status) => () => ({ status, json: null })

globalThis.fetch = async (url, init = {}) => {
  const call = {
    url: String(url),
    method: String(init.method || 'GET').toUpperCase(),
    body: init.body === undefined ? '' : String(init.body),
    headers: init.headers || {},
  }
  http.calls.push(call)
  const hit = [...http.routes].reverse().find((r) => call.url.includes(r.match))
  const spec = hit ? hit.reply(call, http.calls.length) : { status: 200, json: { code: 0, data: {} } }
  if (!spec || spec.status !== 200) {
    return { ok: false, status: spec ? spec.status : 500, json: async () => { throw new Error('no json') } }
  }
  return { ok: true, status: 200, json: async () => spec.json }
}

const WBI_IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
const WBI_SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'

function routeNav({ isLogin = true, mid = 12345, uname = '星辉' } = {}) {
  route('/x/web-interface/nav', jsonOf({
    code: 0,
    data: {
      isLogin, mid, uname,
      wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB },
      level_info: { current_level: 6 },
    },
  }))
}

function routeSendMsg(messageId = 'msg-key-1') {
  route('/web_im/v1/web_im/send_msg', jsonOf({ code: 0, data: { msg_key: messageId, msg_seqno: 1 } }))
}

/* ── 假 miraAccount（契约入口，行为对齐真实 service） ─────── */

function makeMiraAccount({ accounts, bindings = [], inboundResult = null } = {}) {
  const state = {
    adapters: new Map(),
    accounts: accounts ?? [{
      id: 'bili-main', platform: 'bilibili', label: '主号', enabled: true, state: 'offline',
      error: null, inboundPolicy: 'create', createdAt: '2026-10-26T15:00:00.000Z', lastLoginAt: null,
    }],
    bindings: bindings.slice(),
    sent: [],
    inbound: [],
    unbinds: [],
    setStates: [],
    seq: 0,
    inboundResult: inboundResult || (() => ({ routed: 'taker', sessionId: 'S1' })),
  }

  function peerOf(input) {
    return String(input.peerId)
  }

  function bind(input) {
    const existing = state.bindings.find((b) => b.accountId === input.accountId && b.kind === input.kind
      && b.peerId === peerOf(input) && b.mode === 'taker')
    if (existing && existing.sessionId !== input.sessionId && !input.force && !input.observer) {
      throw Object.assign(new Error('peer 已经由会话 ' + existing.sessionId + ' 应答'), {
        code: 'binding/conflict',
        hint: '要抢过来加 force:true；只想旁听加 observer:true；不动就先 unbind 旧绑定',
      })
    }
    state.bindings = state.bindings.filter((b) => !(b.accountId === input.accountId && b.kind === input.kind
      && b.peerId === peerOf(input) && b.mode === 'taker'))
    const binding = {
      sessionId: String(input.sessionId),
      accountId: input.accountId,
      kind: input.kind,
      peerId: peerOf(input),
      mode: input.observer ? 'observer' : 'taker',
      updatedAt: '2026-10-26T15:00:00.000Z',
    }
    state.bindings.push(binding)
    return { ok: true, action: existing ? 'reused' : 'created', binding }
  }

  const api = {
    version: 1,
    state,
    registerAdapter(adapter) {
      if (state.adapters.has(adapter.platform)) {
        throw Object.assign(new Error('平台已有适配器'), { code: 'platform/duplicate' })
      }
      state.adapters.set(adapter.platform, adapter)
      return () => state.adapters.delete(adapter.platform)
    },
    adapterFor: (platform) => state.adapters.get(platform) ?? null,
    listAccounts: () => state.accounts,
    requireAccount(id) {
      const hit = state.accounts.find((a) => a.id === id)
      if (!hit) throw Object.assign(new Error('账号不存在：' + id), { code: 'account/not-found' })
      return hit
    },
    bindings: (sessionId) => state.bindings.filter((b) => !sessionId || b.sessionId === sessionId),
    resolve(accountId, kind, peerId) {
      const rows = state.bindings.filter((b) => b.accountId === accountId && b.kind === kind && b.peerId === String(peerId))
      return {
        accountId,
        key: accountId + '|' + kind + '|' + String(peerId),
        taker: rows.find((b) => b.mode === 'taker') ? { sessionId: rows.find((b) => b.mode === 'taker').sessionId } : null,
        observers: rows.filter((b) => b.mode === 'observer').map((b) => ({ sessionId: b.sessionId })),
      }
    },
    bind,
    unbind(query = {}) {
      const before = state.bindings.length
      state.bindings = state.bindings.filter((b) => {
        if (query.accountId !== undefined && b.accountId !== query.accountId) return true
        if (query.kind !== undefined && b.kind !== query.kind) return true
        if (query.peerId !== undefined && b.peerId !== String(query.peerId)) return true
        return false
      })
      state.unbinds.push(query)
      return { removed: before - state.bindings.length, filter: query }
    },
    async send(input) {
      if (!input.sessionId) throw Object.assign(new Error('sessionId 必填'), { code: 'config/missing' })
      // 先反向绑定，再交给适配器发（与真实 service.send 的顺序一致）
      const bound = bind(input)
      let messageId = null
      const adapter = state.adapters.get('bilibili')
      if (adapter) {
        const result = await adapter.send({ id: input.accountId }, input.kind, input.peerId, input.payload)
        messageId = result && result.messageId !== undefined ? result.messageId : null
      }
      state.sent.push(input)
      state.seq++
      return {
        ok: true,
        accountId: input.accountId,
        kind: input.kind,
        peerId: String(input.peerId),
        messageId: messageId ?? ('self-' + state.seq),
        binding: { mode: bound.binding.mode, action: bound.action },
      }
    },
    async inbound(input) {
      state.inbound.push(input)
      return state.inboundResult(input)
    },
    setState(id, nextState, error) {
      state.setStates.push({ id, state: nextState, error })
    },
    status: () => ({ ok: true }),
  }
  return api
}

/* ── 假 agents / workspace / ctx ────────────────────────── */

function makeAgentInstance(sessionId) {
  const session = {
    id: sessionId,
    events: [],
    messages: [],
    append(type, data) { session.events.push({ type, data }) },
    deriveMessages() { return session.messages },
  }
  const agent = {
    id: sessionId,
    session,
    status: 'idle',
    followups: [],
    steers: [],
    cancelled: 0,
    async followup(message) {
      agent.followups.push(message)
      session.messages = [
        { role: 'user', content: message.content },
        { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
      ]
      agent.status = 'idle'
    },
    steer(message) { agent.steers.push(message) },
    cancel() { agent.cancelled++ },
  }
  return agent
}

function makeAgents() {
  const state = { created: [], resumed: [], live: new Map() }
  return {
    state,
    create({ sessionId }) {
      const agent = makeAgentInstance(sessionId)
      state.created.push({ sessionId })
      state.live.set(sessionId, agent)
      return { agent }
    },
    async resume({ resumeSessionId }) {
      const agent = state.live.get(resumeSessionId)
      if (!agent) throw Object.assign(new Error('会话不存在'), { code: 'session/not-found' })
      state.resumed.push(resumeSessionId)
      return { agent }
    },
    get: (id) => state.live.get(id) ?? null,
  }
}

function makeCtx({ miraAccount, agents }) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger,
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    effect(fn) { const d = fn(); disposers.push(d); return () => {} },
    miraAccount,
    agents,
    workspaceRegistry: { async resolveByPath() { return null } },
    dispose() { for (const d of disposers.reverse()) { try { if (typeof d === 'function') d() } catch { /* noop */ } } },
    toolsMap: tools,
  }
  return ctx
}

async function callTool(ctx, name, args = {}, exec = { agent: { id: 'S-test' } }) {
  const def = ctx.toolsMap.get(name)
  if (!def) throw new Error('工具未注册：' + name + '（已注册：' + [...ctx.toolsMap.keys()].join(',') + '）')
  const text = await def.execute(args, exec)
  return JSON.parse(text)
}

/** 一次完整的「装插件」：新 home + 假 miraAccount/agents + apply。 */
function boot(options = {}) {
  const home = options.home || freshHome()
  process.env.DSH_HOME = home
  const miraAccount = options.miraAccount || makeMiraAccount(options.miraAccountOptions)
  const agents = options.agents || makeAgents()
  const ctx = makeCtx({ miraAccount, agents })
  const config = { schemaVersion: 2, accountId: 'bili-main', autoStart: false, ...(options.config || {}) }
  const result = apply(ctx, config)
  return { home, miraAccount, agents, ctx, result, current: __testing.getCurrent() }
}

const DEFAULT_BUDGET = { readPerHour: 1200, readPerDay: 20000, writePerHour: 60, writePerDay: 300 }

/* ══════════════════════════════════════════════════════════
 * D2 无凭据
 * ══════════════════════════════════════════════════════════ */

await test('D2', '无 creds 文件：bili_status 报 creds/missing，hint 给文件名', async () => {
  resetHttp()
  const { ctx, home } = boot()
  try {
    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, false, 'bili_status 应失败')
    eq(status.error.code, 'creds/missing', '错误码应是 creds/missing')
    includes(status.error.hint, 'creds/bili-main.json', 'hint 要指向具体文件')
    includes(status.error.message, home, 'message 里应有完整路径')

    const sessions = await callTool(ctx, 'bili_get_sessions')
    eq(sessions.ok, false, '需要凭据的工具也应失败')
    eq(sessions.error.code, 'creds/missing', '同样报 creds/missing')
    eq(http.calls.length, 0, '凭据缺失时不应发出任何请求')
  } finally {
    ctx.dispose()
  }
})

await test('D2b', 'accountId 为空 → config/missing（不猜、不自动探测）', async () => {
  resetHttp()
  const { ctx } = boot({ config: { accountId: '' } })
  try {
    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, false, '应失败')
    eq(status.error.code, 'config/missing', '错误码应是 config/missing')
    includes(status.error.message, 'accountId', '要指出缺 accountId')
    eq(http.calls.length, 0, '不应发请求')
  } finally {
    ctx.dispose()
  }
})

await test('D2c', '凭据缺必备字段 SESSDATA → config/missing', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home, { fields: { bili_jct: SECRET_JCT } })
  const { ctx } = boot({ home })
  try {
    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, false, '应失败')
    eq(status.error.code, 'config/missing', '缺字段报 config/missing')
    includes(status.error.message, 'SESSDATA', '要指出缺哪个字段')
    includes(status.error.hint, 'bili-main.json', 'hint 要给文件路径')
  } finally {
    ctx.dispose()
  }
})

await test('D2d', '凭据权限不是 600 → 自愈成 600，status.mode=0o600', async () => {
  resetHttp()
  const home = freshHome()
  const file = writeCreds(home, { mode: 0o644 })
  eq(statSync(file).mode & 0o777, 0o644, '前置：文件是 644')
  const { ctx } = boot({ home })
  try {
    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, true, '有凭据就该能读状态：' + JSON.stringify(status.error || {}))
    eq(statSync(file).mode & 0o777, 0o600, '读凭据时应把权限修回 600')
    eq(status.credentials.mode, '0o600', 'status 里应报 0o600')
    eq(status.credentials.modeOk, true, 'modeOk 应为 true')
    eq(status.credentials.fieldNames.sort(), ['SESSDATA', 'bili_jct', 'buvid3'].sort(), '只报字段名')
    const text = JSON.stringify(status)
    check(!text.includes(SECRET_SESSDATA) && !text.includes(SECRET_JCT), '状态里绝不能出现凭据值')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * D3 登录自检
 * ══════════════════════════════════════════════════════════ */

await test('D3', '登录自检成功：真请求 nav，返回 mid/uname，且不泄漏凭据', async () => {
  resetHttp()
  routeNav({ mid: 12345, uname: '星辉' })
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({ home })
  try {
    const before = http.calls.length
    const result = await callTool(ctx, 'bili_login_check')
    eq(result.ok, true, '自检应成功：' + JSON.stringify(result.error || {}))
    eq(result.mid, 12345, '应返回 mid')
    eq(result.uname, '星辉', '应返回 uname')
    check(http.calls.length > before, '必须真发 nav 请求')
    check(http.calls.some((c) => c.url.includes('/x/web-interface/nav')), '请求的是 nav 接口')
    check(!JSON.stringify(result).includes(SECRET_SESSDATA), '工具返回值不能带 SESSDATA')

    // 适配器确实注册到 mira_account
    const adapter = miraAccount.state.adapters.get('bilibili')
    check(!!adapter, '应注册 platform=bilibili 适配器')
    eq(adapter.platform, 'bilibili', '适配器平台应为 bilibili')
    for (const method of ['connect', 'disconnect', 'send', 'onMessage', 'status', 'createSession']) {
      check(typeof adapter[method] === 'function', '适配器应有 ' + method + '()')
    }

    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, true, 'bili_status 应成功')
    eq(status.login.loggedIn, true, '登录态应为 true')
    eq(status.login.mid, 12345, '状态里应有 mid')
    check(status.budget && status.budget.remaining && status.budget.remaining.read, '状态里应有预算余量')
    eq(status.paused, false, '未暂停')
    check(Array.isArray(status.danmaku.rooms), '状态里应有监听房间')
    check(Object.prototype.hasOwnProperty.call(status, 'lastError'), '状态里应有最后错误字段')
    check(status.credentials.fieldNames.length === 3, '凭据状态只报字段名（3 个）')
  } finally {
    ctx.dispose()
  }
})

await test('D3b', '登录自检失败：nav.isLogin=false → creds/invalid', async () => {
  resetHttp()
  routeNav({ isLogin: false })
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({ home })
  try {
    const result = await callTool(ctx, 'bili_login_check')
    eq(result.ok, false, '自检应失败')
    eq(result.error.code, 'creds/invalid', '错误码应是 creds/invalid')
    includes(result.error.hint, 'creds/bili-main.json', 'hint 指向凭据文件')
    check(!JSON.stringify(result).includes(SECRET_SESSDATA), '失败信息也不能带凭据值')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * D4 / D5 预算
 * ══════════════════════════════════════════════════════════ */

await test('D4', '读预算 3/时：第 4 次 budget/exceeded，且 fetch 未被调用', async () => {
  resetHttp()
  route('/x/relation/stat', jsonOf({ code: 0, data: { follower: 1, following: 2 } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home, config: { budget: { readPerHour: 3, readPerDay: 100, writePerHour: 5, writePerDay: 10 } } })
  try {
    for (let i = 1; i <= 3; i++) {
      const ok = await callTool(ctx, 'bili_get_relation_stat', { vmid: 1 })
      eq(ok.ok, true, '第 ' + i + ' 次读应成功：' + JSON.stringify(ok.error || {}))
    }
    const usedBefore = inst.budget.status().used.readHour
    eq(usedBefore, 3, '已用满 3 次')
    const callsBefore = http.calls.length
    const denied = await callTool(ctx, 'bili_get_relation_stat', { vmid: 1 })
    eq(denied.ok, false, '第 4 次应被拒')
    eq(denied.error.code, 'budget/exceeded', '错误码应是 budget/exceeded')
    check(/等 \d{2}:\d{2}/.test(denied.error.hint), 'hint 应给出恢复时刻 HH:MM：' + denied.error.hint)
    eq(http.calls.length, callsBefore, '被拒时**不得**发出请求')
    eq(inst.budget.status().used.readHour, 3, '被拒不应消耗配额')
    eq(inst.budget.status().rejected, 1, '应记一次拒绝')
  } finally {
    ctx.dispose()
  }
})

await test('D4b', '写预算 2/时：发送动态第 3 次被拒且不发请求', async () => {
  resetHttp()
  route('/dynamic_svr/v1/dynamic_svr/create', jsonOf({ code: 0, data: { dynamic_id: 'dyn-1' } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({ home, config: { budget: { readPerHour: 100, readPerDay: 100, writePerHour: 2, writePerDay: 10 } } })
  try {
    for (let i = 1; i <= 2; i++) {
      const ok = await callTool(ctx, 'bili_send_dynamic', { text: '动态 ' + i })
      eq(ok.ok, true, '第 ' + i + ' 次写应成功')
    }
    const callsBefore = http.calls.length
    const denied = await callTool(ctx, 'bili_send_dynamic', { text: '第三条' })
    eq(denied.ok, false, '第 3 次写应被拒')
    eq(denied.error.code, 'budget/exceeded', '错误码应是 budget/exceeded')
    eq(http.calls.length, callsBefore, '被拒时不得发请求')
  } finally {
    ctx.dispose()
  }
})

await test('D5', '逃生舱 bili_api 同样被预算拦（不可绕过）', async () => {
  resetHttp()
  route('/x/relation/stat', jsonOf({ code: 0, data: { follower: 1 } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({ home, config: { budget: { readPerHour: 1, readPerDay: 10, writePerHour: 1, writePerDay: 10 } } })
  try {
    const first = await callTool(ctx, 'bili_api', { method: 'GET', path: '/x/relation/stat?vmid=1' })
    eq(first.ok, true, '第 1 次逃生舱调用应成功：' + JSON.stringify(first.error || {}))
    eq(first.data.code, 0, '应返回原始 API 数据')
    const callsBefore = http.calls.length
    const denied = await callTool(ctx, 'bili_api', { method: 'GET', path: '/x/relation/stat?vmid=2' })
    eq(denied.ok, false, '第 2 次应被预算拦')
    eq(denied.error.code, 'budget/exceeded', '逃生舱与普通工具用同一个预算闸')
    eq(http.calls.length, callsBefore, '被拒时逃生舱也不得发请求')
    // 写桶同样拦逃生舱
    const writeDenied = await callTool(ctx, 'bili_api', {
      method: 'GET', path: '/x/relation/stat?vmid=3', form: { fake: 1 },
    })
    eq(writeDenied.error.code, 'budget/exceeded', '仍被拦')
  } finally {
    ctx.dispose()
  }
})

await test('D5b', '预算填 0/负数不会关闭预算（回落到默认值并告警）', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({
    home,
    config: { budget: { readPerHour: 0, readPerDay: -5, writePerHour: 0, writePerDay: 0 } },
  })
  try {
    const limits = inst.budget.status().limits
    eq(limits.readPerHour, DEFAULT_BUDGET.readPerHour, '读/时应回落默认')
    eq(limits.readPerDay, DEFAULT_BUDGET.readPerDay, '读/天应回落默认')
    eq(limits.writePerHour, DEFAULT_BUDGET.writePerHour, '写/时应回落默认')
    check(logLines.some((l) => l.includes('预算不能靠填 0 关掉')), '应打一条警告说明不能靠 0 关闭预算')
    eq(inst.budget.status().used.readHour, 0, '尚未消耗')
  } finally {
    ctx.dispose()
  }
})

await test('D6', '假 412 → pauseUntil 前进 + 暂停期内直接拒（含逃生舱）、连续撞墙退避加倍', async () => {
  resetHttp()
  route('/x/relation/stat', statusOf(412))
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    const callsBefore = http.calls.length
    const t0 = Date.now()
    const risk = await callTool(ctx, 'bili_get_relation_stat', { vmid: 1 })
    eq(risk.ok, false, '412 应失败')
    eq(risk.error.code, 'budget/risk', '错误码应是 budget/risk')
    eq(http.calls.length, callsBefore + 1, '触发 412 的那次请求确实发出去了')

    const pausedStatus = inst.budget.status()
    eq(pausedStatus.paused, true, '应进入全局暂停')
    check(pausedStatus.pauseUntil > t0, 'pauseUntil 应前进（> 412 发生的时刻）')
    const firstPause = pausedStatus.pauseUntil

    // bili_status 上能看到暂停（不请求网络）
    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, true, '暂停期间 bili_status 仍应可读')
    eq(status.paused, true, 'bili_status.paused 应为 true')
    check(status.budget.pauseUntilText, '应给出可读的暂停到期时间')
    eq(status.budget.lastRisk, '412', '应记下最后撞的是 412')

    // 暂停期内：普通工具直接拒
    const denied = await callTool(ctx, 'bili_get_relation_stat', { vmid: 1 })
    eq(denied.ok, false, '暂停期内应直接拒')
    eq(denied.error.code, 'budget/paused', '错误码应是 budget/paused')
    // 暂停期内：逃生舱也拒
    const escape = await callTool(ctx, 'bili_api', { method: 'GET', path: '/x/relation/stat?vmid=9' })
    eq(escape.ok, false, '逃生舱也应被暂停拦')
    eq(escape.error.code, 'budget/paused', '逃生舱同样报 budget/paused')
    eq(http.calls.length, callsBefore + 1, '暂停期内不得发出任何请求')

    // 连续撞墙：退避加倍
    inst.budget.noteRisk(429)
    check(inst.budget.status().pauseUntil > firstPause, '连续撞墙后 pauseUntil 应更晚（2 倍退避）')
    eq(inst.budget.status().riskCount, 2, '应记到第 2 次撞墙')
  } finally {
    ctx.dispose()
  }
})

await test('D6b', '412 暂停会落盘，重载插件后仍然生效', async () => {
  resetHttp()
  route('/x/relation/stat', statusOf(412))
  const home = freshHome()
  writeCreds(home)
  const first = boot({ home })
  let pauseUntil = 0
  try {
    await callTool(first.ctx, 'bili_get_relation_stat', { vmid: 1 })
    pauseUntil = first.current.budget.status().pauseUntil
    check(pauseUntil > Date.now(), '第一次实例应已暂停')
  } finally {
    first.ctx.dispose()
  }
  // 重载（mira_account 重新给一份 adapter，不复用旧实例）
  resetHttp()
  const second = boot({ home })
  try {
    const status = second.current.budget.status()
    check(status.paused, '重载后暂停应仍在（budget.json 落盘）')
    eq(status.pauseUntil, pauseUntil, 'pauseUntil 应沿用落盘值')
    const denied = await callTool(second.ctx, 'bili_get_relation_stat', { vmid: 1 })
    eq(denied.error.code, 'budget/paused', '重载后暂停期内仍直接拒')
    eq(http.calls.length, 0, '不应发出请求')
  } finally {
    second.ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * D7 反向绑定
 * ══════════════════════════════════════════════════════════ */

await test('D7', '首次 bili_send_private_msg → 自动登记 taker + 调用 miraAccount.send', async () => {
  resetHttp()
  routeNav({ mid: 12345, uname: '星辉' })
  routeSendMsg('msg-key-1')
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({ home })
  try {
    const result = await callTool(ctx, 'bili_send_private_msg', { receiver_id: 456, text: '你好呀' }, { agent: { id: 'S1' } })
    eq(result.ok, true, '发送应成功：' + JSON.stringify(result.error || {}))
    eq(result.receiver_id, 456, '应回显 receiver_id')
    eq(result.message_id, 'msg-key-1', '应回 message_id（B 站 msg_key）')
    eq(result.binding && result.binding.mode, 'taker', '应登记为 taker')
    eq(miraAccount.state.sent.length, 1, 'miraAccount.send 应被调用 1 次')
    const sent = miraAccount.state.sent[0]
    eq(sent.sessionId, 'S1', '应带当前会话 id（反向绑定）')
    eq(sent.kind, 'user', 'kind=user')
    eq(String(sent.peerId), '456', 'peerId 是对方 mid')
    eq(sent.payload.text, '你好呀', 'payload.text 是正文')
    const binding = miraAccount.state.bindings.find((b) => b.kind === 'user' && b.peerId === '456' && b.mode === 'taker')
    check(!!binding, 'bindings 里应有该 peer 的 taker')
    eq(binding.sessionId, 'S1', 'taker 是发起会话')
    // 出站真的走了 B 站发送接口
    check(http.calls.some((c) => c.url.includes('web_im/v1/web_im/send_msg') && c.method === 'POST'), '应请求 send_msg')
  } finally {
    ctx.dispose()
  }
})

await test('D7b', '第二个会话发同一用户 → binding/conflict，且没有发出去', async () => {
  resetHttp()
  routeNav()
  routeSendMsg()
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({ home })
  try {
    const first = await callTool(ctx, 'bili_send_private_msg', { receiver_id: 789, text: 'hi' }, { agent: { id: 'S1' } })
    eq(first.ok, true, '第一个会话应成功')
    const callsAfterFirst = http.calls.filter((c) => c.url.includes('send_msg')).length
    const second = await callTool(ctx, 'bili_send_private_msg', { receiver_id: 789, text: 'hi again' }, { agent: { id: 'S2' } })
    eq(second.ok, false, '第二个会话应被拒')
    eq(second.error.code, 'binding/conflict', '错误码应是 binding/conflict')
    includes(second.error.hint, 'force', 'hint 应提示用 force 抢答')
    eq(miraAccount.state.sent.length, 1, 'miraAccount.send 不应再被调用')
    eq(http.calls.filter((c) => c.url.includes('send_msg')).length, callsAfterFirst, '冲突时不应真的发出私信')
    const forced = await callTool(ctx, 'bili_send_private_msg', { receiver_id: 789, text: '我抢', force: true }, { agent: { id: 'S2' } })
    eq(forced.ok, true, '带 force 应成功：' + JSON.stringify(forced.error || {}))
    eq(miraAccount.state.sent.length, 2, 'force 后才会再发')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * D8 私信去重 / 合并窗口
 * ══════════════════════════════════════════════════════════ */

function routePrivateMessages(messages, { unread = messages.length } = {}) {
  route('/session_svr/v1/session_svr/get_sessions', jsonOf({
    code: 0,
    data: { session_list: [{ talker_id: 456, session_type: 1, unread_count: unread }] },
  }))
  route('/fetch_session_msgs', jsonOf({ code: 0, data: { messages } }))
  route('/x/msgfeed/at', jsonOf({ code: 0, data: { items: [] } }))
  route('/session_svr/v1/session_svr/update_ack', jsonOf({ code: 0, data: {} }))
  route('/x/space/acc/info', jsonOf({ code: 0, data: { mid: 456, name: '小明' } }))
}

function dmMessage(seqno, text, msgKey) {
  return {
    sender_uid: 456,
    receiver_uid: 12345,
    msg_seqno: seqno,
    msg_key: msgKey,
    timestamp: 1700000000 + seqno,
    msg_type: 1,
    content: JSON.stringify({ content: text }),
  }
}

await test('D8', '同 msg_key 二次轮询不重复投递（inbound 只 1 次、缓冲只 1 条）', async () => {
  resetHttp()
  routeNav()
  routePrivateMessages([dmMessage(1, '在吗', 'key-1')])
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({
    home,
    config: { autoReply: { enabled: true, strangerPolicy: 'reply', mergeWindowMs: 0, agentCwd: join(home, 'work') } },
  })
  try {
    const login = await callTool(ctx, 'bili_login_check')
    eq(login.ok, true, '先登录（假 nav）')
    await pollOnce()
    eq(miraAccount.state.inbound.length, 1, '第 1 次轮询应投递 1 次')
    const inbound = miraAccount.state.inbound[0]
    eq(inbound.accountId, 'bili-main', '入站带 accountId')
    eq(inbound.kind, 'user', '入站 kind=user')
    eq(String(inbound.peerId), '456', '入站 peerId 是对方 mid')
    eq(inbound.message.id, 'key-1', '入站 message.id 用 B 站 msg_key（mira_account 去重用）')
    // 正文必须按 qqbot 的口径拼好（mira_account 只原样投递 message.text）
    const body = String(inbound.message.text || '')
    check(body.includes('【安全规则】'), '正文要带【安全规则】：' + body.slice(0, 80))
    check(body.includes('【识别名单】'), '正文要带【识别名单】')
    check(body.includes('【消息来源】'), '正文要带【消息来源】')
    check(body.includes('工具：mira_bilibili'), '来源里要写明是 mira_bilibili')
    check(body.includes('平台：哔哩哔哩私信'), '来源里要写明平台与性质')
    check(body.includes('ID号：456'), '来源里要有对方 mid')
    check(body.includes('bili_send_private_msg'), '要告诉它用哪个工具回话')
    check(body.includes('【行为规则】'), '正文要带配置的【行为规则】')
    check(body.includes('【聊天消息】\n在吗'), '最后才是【聊天消息】+ 原文：' + body.slice(-40))
    eq(inbound.source && inbound.source.kind, 'mira_bilibili', '入站要带 source.kind=mira_bilibili（宿主读它）')
    const recv1 = await callTool(ctx, 'bili_recv_messages', { since: 0 })
    eq(recv1.count, 1, '缓冲里应有 1 条私信')
    eq(recv1.messages[0].post_type, 'message', 'post_type=message')
    eq(recv1.messages[0].text, '在吗', '缓冲正文')

    await pollOnce()
    eq(miraAccount.state.inbound.length, 1, '第 2 次轮询不得重复投递')
    const recv2 = await callTool(ctx, 'bili_recv_messages', { since: 0 })
    eq(recv2.count, 1, '缓冲里也不应多出重复消息')
    // update_ack 记读桶（轮询的维护动作不占写预算）
    const budget = __testing.getCurrent().budget.status()
    eq(budget.used.writeDay, 0, '轮询不应消耗写预算')
    check(budget.used.readHour > 0, '轮询应消耗读预算')
  } finally {
    ctx.dispose()
  }
})

await test('D8b', '合并窗口：窗口内两条私信合并成一次投递', async () => {
  resetHttp()
  routeNav()
  routePrivateMessages([dmMessage(1, '第一句', 'key-1'), dmMessage(2, '第二句', 'key-2')], { unread: 2 })
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({
    home,
    config: { autoReply: { enabled: true, strangerPolicy: 'reply', mergeWindowMs: 30, agentCwd: join(home, 'work') } },
  })
  try {
    await callTool(ctx, 'bili_login_check')
    await pollOnce()
    eq(miraAccount.state.inbound.length, 0, '合并窗口内还不应投递')
    await sleep(90)
    eq(miraAccount.state.inbound.length, 1, '窗口到点后应合并成 1 次投递')
    const inbound = miraAccount.state.inbound[0]
    includes(inbound.message.text, '第一句', '合并文本含第一条')
    includes(inbound.message.text, '第二句', '合并文本含第二条')
    eq(inbound.message.id, 'key-2', '合并批用最后一条的 msg_key')
  } finally {
    ctx.dispose()
  }
})

await test('D8c', '陌生人策略 buffer：私信进缓冲但不投递，计数可见', async () => {
  resetHttp()
  routeNav()
  routePrivateMessages([dmMessage(1, '你好', 'key-9')])
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({
    home,
    config: { autoReply: { enabled: true, strangerPolicy: 'buffer', mergeWindowMs: 0, agentCwd: join(home, 'work') } },
  })
  try {
    await callTool(ctx, 'bili_login_check')
    await pollOnce()
    await sleep(30)
    eq(miraAccount.state.inbound.length, 0, '陌生人默认不自动应答（功能点6）')
    const recv = await callTool(ctx, 'bili_recv_messages', { since: 0 })
    eq(recv.count, 1, '但仍要进消息缓冲（不静默丢弃）')
    const status = await callTool(ctx, 'bili_status')
    eq(status.autoReply.ignoredStranger, 1, 'ignored.stranger 计数应可见')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * D9 直播间白名单 + 忽略计数
 * ══════════════════════════════════════════════════════════ */

await test('D9', '直播间白名单外不自动应答、忽略计数可见；白名单内才建 agent 会话', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx, agents, miraAccount, current: inst } = boot({
    home,
    config: {
      danmaku: { enabled: true, rooms: [], autoReply: { enabled: true, scope: 'whitelist', mergeWindowMs: 0, minIntervalMs: 0 } },
      autoReply: { enabled: false, agentCwd: join(home, 'work') },
    },
  })
  try {
    const liveMod = inst.modules.live
    // 白名单外（临时 join 的房间）：不自动应答
    const outside = { realRoomId: 777, whitelisted: false, joined: true, title: '别人的直播间', uname: '主播', queue: [], busy: false, lastReplyAt: 0 }
    const eligible = liveMod.handleHistoryDanmaku(outside, { text: '主播好', uid: 55, nickname: '路人', id_str: 'dm-1' })
    eq(eligible, false, '白名单外不应自动应答')
    eq(agents.state.created.length, 0, '不应为白名单外房间创建 agent 会话')

    const status = await callTool(ctx, 'bili_live_status')
    eq(status.ok, true, 'bili_live_status 应成功')
    eq(status.scope, 'whitelist', '默认 scope=whitelist')
    eq(status.autoReplyEnabled, true, '自动应答开关是开的')
    check(status.ignored >= 1, '被忽略的弹幕计数应可见（实得 ' + status.ignored + '）')
    eq(status.autoReplyQueued, 0, '没有入队的自动应答')

    const recv = await callTool(ctx, 'bili_recv_messages', { types: 'danmaku' })
    eq(recv.count, 1, '弹幕仍要进缓冲（不静默丢弃）')
    eq(recv.messages[0].room_id, 777, '弹幕记录带房间号')

    // 白名单房间：自动应答（建会话 + followup 合并文本）
    const inside = { realRoomId: 888, whitelisted: true, joined: false, title: '我的直播间', uname: '我', queue: [], busy: false, lastReplyAt: 0 }
    eq(liveMod.handleHistoryDanmaku(inside, { text: '主播在吗', uid: 66, nickname: '观众', id_str: 'dm-2' }), true, '白名单内应参与自动应答')
    await sleep(60)
    eq(agents.state.created.length, 1, '应白名单房间创建 1 个 agent 会话')
    const created = agents.state.created[0]
    const agentObj = agents.state.live.get(created.sessionId)
    eq(agentObj.followups.length, 1, '应把合并后的弹幕 followup 给 agent')
    includes(JSON.stringify(agentObj.followups[0]), '主播在吗', '注入文本含弹幕内容')
    check(miraAccount.state.bindings.some((b) => b.kind === 'room' && b.peerId === '888' && b.mode === 'taker'),
      '直播间 ↔ 会话的对应关系应存进 mira_account 绑定（不再写 bili_meta.json）')
    const status2 = await callTool(ctx, 'bili_live_status')
    eq(status2.autoReplyQueued, 1, '入队计数 +1')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * 结构 / 配置 / 适配器
 * ══════════════════════════════════════════════════════════ */

await test('S1', '工具清单：25 个 bili_*（含 bili_api 逃生舱，无送礼工具）', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({ home })
  try {
    const names = [...ctx.toolsMap.keys()]
    eq(names.length, 25, '应注册 25 个工具（实得：' + names.join(',') + '）')
    eq(names.sort(), [...__testing.TOOL_NAMES].sort(), '工具名与 TOOL_NAMES 一致')
    check(names.includes('bili_api'), '应有 bili_api 逃生舱')
    check(!names.some((n) => n.includes('gift')), '不应有送礼（花钱）工具')
    check(!names.some((n) => n.includes('follow') || n.includes('coin') || n.includes('triple')), '不应有关注/投币/三连工具')
  } finally {
    ctx.dispose()
  }
})

await test('S2', 'schemaVersion 不符 → 拒绝加载且不注册工具；enabled=false 同理', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const bad = boot({ home, config: { schemaVersion: 99 } })
  eq(bad.result.ok, false, '应拒绝加载')
  eq(bad.result.error.code, 'config/schema', '错误码应是 config/schema')
  eq(bad.ctx.toolsMap.size, 0, '被拒的实例不应注册工具')
  bad.ctx.dispose()

  const disabled = boot({ home, config: { enabled: false } })
  eq(disabled.result.ok, false, '禁用时应返回 ok:false')
  eq(disabled.result.error.code, 'plugin/disabled', '错误码应是 plugin/disabled')
  eq(disabled.ctx.toolsMap.size, 0, '禁用时不应注册工具')
  disabled.ctx.dispose()
})

await test('S3', '单实例：第二个实例 plugin/instance，释放后可重新加载', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const first = boot({ home })
  try {
    eq(first.result.ok, true, '第一个实例应成功')
    const second = boot({ home })
    try {
      eq(second.result.ok, false, '第二个实例应被拒')
      eq(second.result.error.code, 'plugin/instance', '错误码应是 plugin/instance')
      eq(second.ctx.toolsMap.size, 0, '被拒实例不应注册工具')
      check(logLines.some((l) => l.includes('已经有一个实例在跑')), '应打 warn 日志')
    } finally {
      second.ctx.dispose()
    }
  } finally {
    first.ctx.dispose()
  }
  // 释放认领后可以重新加载
  const third = boot({ home })
  try {
    eq(third.result.ok, true, '释放后应能重新加载')
    eq(third.ctx.toolsMap.size, 25, '重载后工具齐全')
  } finally {
    third.ctx.dispose()
  }
})

await test('S4', 'adapter.createSession：无 agentCwd 报 config/missing；有则建会话并写标题', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  // 无 agentCwd
  const noCwd = boot({ home, config: { autoReply: { enabled: true, agentCwd: '' } } })
  try {
    let err = null
    try {
      await noCwd.current.adapter.createSession({ account: { id: 'bili-main', platform: 'bilibili' }, kind: 'user', peerId: 456, display: '小明', text: 'hi' })
    } catch (error) { err = error }
    eq(err && err.code, 'config/missing', '缺 agentCwd 应报 config/missing')
    includes(err && err.hint, 'agentCwd', 'hint 要指出缺 agentCwd')
    eq(noCwd.agents.state.created.length, 0, '没有 cwd 不应建会话')
  } finally {
    noCwd.ctx.dispose()
  }
  // 有 agentCwd
  const withCwd = boot({ home, config: { autoReply: { enabled: true, agentCwd: join(home, 'work') } } })
  try {
    const sessionId = await withCwd.current.adapter.createSession({
      account: { id: 'bili-main', platform: 'bilibili' }, kind: 'user', peerId: 456, display: '小明', text: 'hi',
    })
    check(/^bili-/.test(sessionId), '应返回新会话 id（实得 ' + sessionId + '）')
    eq(withCwd.agents.state.created.length, 1, '应创建一个会话')
    const agentObj = withCwd.agents.state.live.get(sessionId)
    const titleEvent = agentObj.session.events.find((e) => e.type === 'session/title')
    check(!!titleEvent && String(titleEvent.data.title).includes('456'), '应写入会话标题（昵称(mid)）')
    const presetEvent = agentObj.session.events.find((e) => e.type === 'agent-preset/selected')
    check(!!presetEvent, '应写入预设归属')
  } finally {
    withCwd.ctx.dispose()
  }
})

await test('S5', 'adapter：kind=group 直接 platform/unsupported；payload 空 config/missing', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    let err = null
    try { await inst.adapter.send({ id: 'bili-main' }, 'group', '123', { text: 'hi' }) } catch (e) { err = e }
    eq(err && err.code, 'platform/unsupported', 'B 站没有群聊：应报 platform/unsupported')
    err = null
    try { await inst.adapter.send({ id: 'bili-main' }, 'user', '123', {}) } catch (e) { err = e }
    eq(err && err.code, 'config/missing', '空 payload 应报 config/missing')

    // onMessage 订阅者能收到入站（只旁听；路由仍走 miraAccount）
    const seen = []
    const dispose = inst.adapter.onMessage({ id: 'bili-main' }, (msg) => seen.push(msg))
    inst.adapter.notifyInbound({ id: 'bili-main' }, { text: 'hi' })
    eq(seen.length, 1, '订阅者应收到 1 条')
    dispose()
    inst.adapter.notifyInbound({ id: 'bili-main' }, { text: 'again' })
    eq(seen.length, 1, '退订后不再收到')
  } finally {
    ctx.dispose()
  }
})

await test('S6', 'bili_recv_messages：过滤 + limit + since 游标', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    inst.runtime.push({ post_type: 'message', kind: 'private', talker_id: 1, mid: 1, text: '私信1' })
    inst.runtime.push({ post_type: 'danmaku', kind: 'danmaku', room_id: 9, text: '弹幕1' })
    inst.runtime.push({ post_type: 'message', kind: 'private', talker_id: 2, mid: 2, text: '私信2' })
    const all = await callTool(ctx, 'bili_recv_messages', { since: 0 })
    eq(all.count, 3, '默认返回全部')
    const onlyMsg = await callTool(ctx, 'bili_recv_messages', { since: 0, types: 'message' })
    eq(onlyMsg.count, 2, 'types 过滤只留私信')
    const limited = await callTool(ctx, 'bili_recv_messages', { since: 0, limit: 1 })
    eq(limited.count, 1, 'limit 生效')
    eq(limited.messages[0].text, '私信2', 'limit 取最后 N 条')
    const next = await callTool(ctx, 'bili_recv_messages', { since: limited.maxSeq })
    eq(next.count, 0, 'since 游标之后没有新消息')
  } finally {
    ctx.dispose()
  }
})

await test('S7', '登录态/凭据不进日志：所有日志行都不含凭据值', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({ home })
  try {
    await callTool(ctx, 'bili_login_check')
    await callTool(ctx, 'bili_status')
    const text = logLines.join('\n')
    check(!text.includes(SECRET_SESSDATA), '日志不能含 SESSDATA')
    check(!text.includes(SECRET_JCT), '日志不能含 bili_jct')
    check(!text.includes(SECRET_BUVID), '日志不能含 buvid3')
  } finally {
    ctx.dispose()
  }
})


/* ══════════════════════════════════════════════════════════
 * 启动装配（autoStart）
 * ══════════════════════════════════════════════════════════ */

await test('S8', 'autoStart=true：登录自检 → 账号置 online → 起轮询；dispose 后停轮询', async () => {
  resetHttp()
  routeNav()
  route('/session_svr/v1/session_svr/get_sessions', jsonOf({ code: 0, data: { session_list: [] } }))
  route('/x/msgfeed/at', jsonOf({ code: 0, data: { items: [] } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount, current: inst } = boot({ home, config: { autoStart: true } })
  try {
    await sleep(80)
    check(miraAccount.state.setStates.some((s) => s.state === 'online'), '启动自检通过后应把账号置 online')
    eq(inst.modules.agent.statusView().polling, true, 'autoStart=true 应起轮询')
    const status = await callTool(ctx, 'bili_status')
    eq(status.login.loggedIn, true, '状态里应为已登录')
  } finally {
    ctx.dispose()
  }
  eq(inst.modules.agent.statusView().polling, false, 'dispose 后应停掉轮询（不留定时器）')
})

await test('S9', 'autoStart=true 但 Cookie 失效：账号置 error、不起轮询、lastError=creds/invalid', async () => {
  resetHttp()
  routeNav({ isLogin: false })
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount, current: inst } = boot({ home, config: { autoStart: true } })
  try {
    await sleep(80)
    check(miraAccount.state.setStates.some((s) => s.state === 'error'), '登录失败应把账号置 error')
    eq(inst.modules.agent.statusView().polling, false, '登录失败不应起轮询')
    const status = await callTool(ctx, 'bili_status')
    eq(status.lastError && status.lastError.code, 'creds/invalid', 'bili_status.lastError 应记 creds/invalid')
  } finally {
    ctx.dispose()
  }
})


await test('S10', '旧 config.cookie/csrf 只提醒不读取：凭据仍只来自 creds/<id>.json', async () => {
  resetHttp()
  routeNav()
  route('/x/relation/stat', jsonOf({ code: 0, data: { follower: 1 } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({
    home,
    config: { cookie: 'SESSDATA=LEGACY-SESSDATA; bili_jct=LEGACY-JCT', csrf: 'LEGACY-JCT' },
  })
  try {
    const status = await callTool(ctx, 'bili_status')
    eq(status.ok, true, '状态应能读（凭据文件在）')
    check(status.warnings.some((w) => w.code === 'config/warn' && String(w.message).includes('config.cookie')),
      'bili_status.warnings 里应有「config.cookie 已废弃」的提醒')
    eq(status.credentials.fieldNames.sort(), ['SESSDATA', 'bili_jct', 'buvid3'].sort(), '凭据字段来自 creds 文件')
    await callTool(ctx, 'bili_get_relation_stat', { vmid: 1 })
    const sent = http.calls.map((c) => JSON.stringify(c.headers)).join('\n')
    includes(sent, SECRET_SESSDATA, '请求 Cookie 头用的是 creds 文件里的 SESSDATA')
    check(!sent.includes('LEGACY-SESSDATA'), '绝不能把旧 config.cookie 拼进请求')
    check(!sent.includes('LEGACY-JCT'), '绝不能把旧 config.csrf 拼进请求')
  } finally {
    ctx.dispose()
  }
})

await test('S11', '凭据文件版本/平台不对：config/schema 与 creds/invalid 分别报出', async () => {
  resetHttp()
  // 版本不对
  const homeA = freshHome()
  const fileA = writeCreds(homeA)
  writeFileSync(fileA, JSON.stringify({
    schemaVersion: 99, platform: 'bilibili', kind: 'cookie', fields: { SESSDATA: 'x', bili_jct: 'y' },
  }))
  const a = boot({ home: homeA })
  try {
    const status = await callTool(a.ctx, 'bili_status')
    eq(status.ok, false, '版本不符应失败')
    eq(status.error.code, 'config/schema', '错误码应是 config/schema')
  } finally {
    a.ctx.dispose()
  }
  // 平台不对
  const homeB = freshHome()
  const fileB = writeCreds(homeB)
  writeFileSync(fileB, JSON.stringify({
    schemaVersion: 1, platform: 'qq', kind: 'cookie', fields: { SESSDATA: 'x', bili_jct: 'y' },
  }))
  const b = boot({ home: homeB })
  try {
    const status = await callTool(b.ctx, 'bili_status')
    eq(status.ok, false, '平台不符应失败')
    eq(status.error.code, 'creds/invalid', '错误码应是 creds/invalid')
    includes(status.error.message, 'qq', 'message 要指出实际 platform')
  } finally {
    b.ctx.dispose()
  }
})


await test('S12', 'bili_live_join/leave 白名单房间 → live/whitelisted，且不建立任何连接', async () => {
  resetHttp()
  route('/room/v1/Room/room_init', jsonOf({ code: 0, data: { room_id: 888, short_id: 0, uid: 1, live_status: 1 } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home, config: { danmaku: { enabled: true, rooms: ['888'] } } })
  try {
    const join = await callTool(ctx, 'bili_live_join', { roomid: 888 })
    eq(join.ok, false, '白名单房间不能临时进入')
    eq(join.error.code, 'live/whitelisted', '错误码应是 live/whitelisted')
    includes(join.error.hint, 'danmaku.rooms', 'hint 指向配置项')
    const leave = await callTool(ctx, 'bili_live_leave', { roomid: 888 })
    eq(leave.error.code, 'live/whitelisted', '白名单房间也不能临时退出')
    eq(inst.modules.live.getRooms().size, 0, '不应留下任何房间连接')
    const tasks = await callTool(ctx, 'bili_live_tasks')
    eq(tasks.ok, true, '任务列表可用')
    eq(tasks.count, 0, '没有任务')
  } finally {
    ctx.dispose()
  }
})

await test('S13', '缺少 miraAccount 服务 → platform/unsupported，且释放单实例认领', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const agents = makeAgents()
  const ctx = makeCtx({ miraAccount: null, agents })
  const result = apply(ctx, { schemaVersion: 2, accountId: 'bili-main', autoStart: false })
  try {
    eq(result.ok, false, '缺少 miraAccount 应拒绝加载')
    eq(result.error.code, 'platform/unsupported', '错误码应是 platform/unsupported')
    includes(result.error.hint, 'mira_account', 'hint 要指向 mira_account')
    eq(ctx.toolsMap.size, 0, '不应注册工具')
  } finally {
    ctx.dispose()
  }
  // 认领已释放 → 正常加载能成功
  const normal = boot({ home })
  try {
    eq(normal.result.ok, true, '失败的那次不能把单实例认领留着')
    eq(normal.ctx.toolsMap.size, 25, '工具齐全')
  } finally {
    normal.ctx.dispose()
  }
})


await test('S14', '逃生舱不允许非 B 站域名（防止 Cookie 被发给第三方），且不占配额', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    const denied = await callTool(ctx, 'bili_api', { method: 'GET', path: 'https://evil.example.com/steal' })
    eq(denied.ok, false, '非 B 站域名应被拒')
    eq(denied.error.code, 'api/unsupported-host', '错误码应是 api/unsupported-host')
    eq(http.calls.length, 0, '不应发出任何请求（Cookie 更不能发出去）')
    eq(inst.budget.status().used.readHour, 0, '被拒的 URL 不应消耗配额')
    // B 站域名仍然放行
    route('/x/v2/reply/add', jsonOf({ code: 0, data: { rpid: 1 } }))
    const ok = await callTool(ctx, 'bili_api', { method: 'GET', path: 'https://api.bilibili.com/x/web-interface/nav' })
    eq(ok.ok, true, 'B 站域名应放行：' + JSON.stringify(ok.error || {}))
    check(http.calls.some((c) => c.url.includes('api.bilibili.com/x/web-interface/nav')), '应请求 B 站域名')
  } finally {
    ctx.dispose()
  }
})


/* ══════════════════════════════════════════════════════════
 * P1/P2 回归（独立评审）
 * ══════════════════════════════════════════════════════════ */

await test('S15', 'P1-1 claim 之后 registerTools 抛错 → 认领释放，进程内仍能正常加载', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const miraAccount = makeMiraAccount()
  const agents = makeAgents()
  const ctx = makeCtx({ miraAccount, agents })
  ctx.tools.register = () => { throw new Error('boom-register') }
  let thrown = null
  try {
    apply(ctx, { schemaVersion: 2, accountId: 'bili-main', autoStart: false })
  } catch (error) {
    thrown = error
  }
  check(thrown !== null, 'apply 应把 registerTools 的异常抛出来')
  includes(thrown && thrown.message, 'boom-register', '抛出的应是原始异常')
  // 认领已释放：同进程再装一次必须成功（修之前这里是 plugin/instance）
  const normal = boot({ home })
  try {
    eq(normal.result.ok, true, '失败的那次不能把单实例认领永久占住：' + JSON.stringify(normal.result.error || {}))
    eq(normal.ctx.toolsMap.size, 25, '第二次加载工具齐全')
  } finally {
    normal.ctx.dispose()
  }
})

await test('S16', 'P1-2 陌生人发 /new 不解绑、不回话、只进缓冲；受信 peer 的 /new 仍然生效', async () => {
  resetHttp()
  routeNav()
  routePrivateMessages([dmMessage(1, '/new', 'key-new-1')])
  routeSendMsg('msg-reset-1')
  route('/x/space/acc/info', jsonOf({ code: 0, data: { mid: 456, name: '陌生人' } }))
  const home = freshHome()
  writeCreds(home)
  const { ctx, miraAccount } = boot({
    home,
    config: { autoReply: { enabled: true, strangerPolicy: 'buffer', mergeWindowMs: 0, newCommand: '/new', agentCwd: join(home, 'work') } },
  })
  try {
    await callTool(ctx, 'bili_login_check')
    await pollOnce()
    eq(miraAccount.state.unbinds.length, 0, '陌生人 /new 不得解绑该 peer 的 taker')
    eq(miraAccount.state.inbound.length, 0, '陌生人 /new 不得触发应答/投递')
    check(!http.calls.some((c) => c.url.includes('/web_im/v1/web_im/send_msg')), '陌生人 /new 不得发出任何私信')
    const recv = await callTool(ctx, 'bili_recv_messages', { since: 0 })
    eq(recv.count, 1, '但仍进消息缓冲（不静默丢弃）')
    const status = await callTool(ctx, 'bili_status')
    eq(status.autoReply.ignoredStranger, 1, 'ignored.stranger 计数可见')
  } finally {
    ctx.dispose()
  }

  // 正向对照：已绑定 taker 的 peer 发 /new 仍然重置会话
  resetHttp()
  routeNav()
  route('/session_svr/v1/session_svr/get_sessions', jsonOf({ code: 0, data: { session_list: [{ talker_id: 777, session_type: 1, unread_count: 1 }] } }))
  route('/fetch_session_msgs', jsonOf({ code: 0, data: { messages: [{ ...dmMessage(1, '/new', 'key-new-2'), sender_uid: 777 }] } }))
  route('/x/msgfeed/at', jsonOf({ code: 0, data: { items: [] } }))
  route('/session_svr/v1/session_svr/update_ack', jsonOf({ code: 0, data: {} }))
  routeSendMsg('msg-reset-2')
  const home2 = freshHome()
  writeCreds(home2)
  const bound = boot({
    home: home2,
    miraAccountOptions: { bindings: [{ accountId: 'bili-main', kind: 'user', peerId: '777', sessionId: 'S-test', mode: 'taker', updatedAt: 1 }] },
    config: { autoReply: { enabled: true, strangerPolicy: 'buffer', mergeWindowMs: 0, newCommand: '/new', agentCwd: join(home2, 'work') } },
  })
  try {
    await callTool(bound.ctx, 'bili_login_check')
    await pollOnce()
    eq(bound.miraAccount.state.unbinds.length, 1, '受信 peer 的 /new 应解绑一次')
    eq(bound.miraAccount.state.unbinds[0].peerId, '777', '解绑的是该 peer')
    check(http.calls.some((c) => c.url.includes('/web_im/v1/web_im/send_msg')), '应回一句「新会话已开启」')
  } finally {
    bound.ctx.dispose()
  }
})

await test('S17', 'P1-3 bili_api 拒绝 http://（Cookie 不明文发出），且不占配额', async () => {
  resetHttp()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    const denied = await callTool(ctx, 'bili_api', { method: 'GET', path: 'http://api.bilibili.com/x/web-interface/nav' })
    eq(denied.ok, false, 'http:// 应被拒')
    eq(denied.error.code, 'api/unsupported-host', '错误码应是 api/unsupported-host')
    eq(http.calls.length, 0, '不应发出任何请求')
    eq(inst.budget.status().used.readHour, 0, '被拒的 URL 不应消耗配额')
  } finally {
    ctx.dispose()
  }
})

await test('S18', 'P1-4 降级轮询撞 budget/exceeded → 停 interval 并切回 WS，计数在 bili_status 可见', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home, config: { budget: { readPerHour: 2 }, danmaku: { enabled: true, rooms: [] } } })
  try {
    await callTool(ctx, 'bili_login_check') // 1 次读
    await callTool(ctx, 'bili_get_relation_stat', { vmid: 1 }) // 2 次读 → 读预算耗尽
    const fake = { realRoomId: 12345, status: 'polling', mode: 'polling', seenIds: new Set(), pollTimer: setTimeout(() => {}, 1e6) }
    await inst.modules.live.__testing.pollDanmakuOnce(fake)
    eq(fake.status, 'budget-blocked', '撞预算的房间状态应标成 budget-blocked')
    eq(fake.pollTimer, null, '必须停掉本房间的 3s interval（不每 3s 重试）')
    eq(fake.mode, 'ws', '应尝试切回 WS 主通道')
    const liveStatus = await callTool(ctx, 'bili_live_status')
    eq(liveStatus.budgetBlocked, 1, 'bili_live_status 里能看到被预算挡住的降级轮询')
    const status = await callTool(ctx, 'bili_status')
    eq(status.danmaku.budgetBlocked, 1, 'bili_status.danmaku 里也能看到')
  } finally {
    ctx.dispose()
  }
})

await test('S19', 'P1-5 @我 同批 3 条（新→旧）全部入缓冲，游标循环后统一前进', async () => {
  resetHttp()
  routeNav()
  route('/session_svr/v1/session_svr/get_sessions', jsonOf({ code: 0, data: { session_list: [] } }))
  route('/x/msgfeed/at', jsonOf({
    code: 0,
    data: {
      items: [
        { id: 103, mid: 456, user: { nickname: 'A' }, type: 1, business_id: 1, source_id: 1, item: {}, uri: 'u3', source_content: '三' },
        { id: 102, mid: 456, user: { nickname: 'B' }, type: 1, business_id: 1, source_id: 1, item: {}, uri: 'u2', source_content: '二' },
        { id: 101, mid: 456, user: { nickname: 'C' }, type: 1, business_id: 1, source_id: 1, item: {}, uri: 'u1', source_content: '一' },
      ],
    },
  }))
  const home = freshHome()
  writeCreds(home)
  const { ctx } = boot({ home })
  try {
    await callTool(ctx, 'bili_login_check')
    await pollOnce()
    const recv1 = await callTool(ctx, 'bili_recv_messages', { since: 0, types: ['at'] })
    eq(recv1.count, 3, '同批 3 条 @我 都要入缓冲（修之前只剩最新 1 条）')
    eq(recv1.messages.map((m) => m.at_id).sort((a, b) => a - b), [101, 102, 103], '三条 id 齐全')
    await pollOnce()
    const recv2 = await callTool(ctx, 'bili_recv_messages', { since: 0, types: ['at'] })
    eq(recv2.count, 3, '第 2 次轮询不重复投递（游标已抬到本批 max(id)=103）')
  } finally {
    ctx.dispose()
  }
})

await test('S20', 'P1-6 refreshLogin 抛错后 loggedIn=false（不假在线）、身份清空、轮询守卫生效', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    const ok = await callTool(ctx, 'bili_login_check')
    eq(ok.ok, true, '先成功登录一次')
    eq(inst.modules.api.selfStatus().loggedIn, true, '登录态为真')
    // 之后的 nav 请求失败（HTTP 500）
    resetHttp()
    route('/x/web-interface/nav', statusOf(500))
    const failed = await callTool(ctx, 'bili_login_check')
    eq(failed.ok, false, 'nav 失败应报错')
    eq(inst.modules.api.selfStatus().loggedIn, false, '抛错后不能还是 true（假在线）')
    eq(inst.modules.api.selfStatus().mid, null, '失败时应清 selfMid')
    eq(await pollOnce(), { skipped: true }, 'pollOnce 守卫应生效（未登录就跳过）')
  } finally {
    ctx.dispose()
  }
})

await test('S21', 'P2-8 登录成功只清 creds/* 错误，不抹掉无关 lastError', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    await callTool(ctx, 'bili_login_check')
    inst.runtime.noteError('poll/failed', '无关错误不应被登录抹掉')
    await callTool(ctx, 'bili_login_check')
    eq(inst.runtime.lastError && inst.runtime.lastError.code, 'poll/failed', '无关错误应保留')
    inst.runtime.noteError('creds/invalid', '过期凭据错误')
    await callTool(ctx, 'bili_login_check')
    eq(inst.runtime.lastError, null, 'creds/* 错误应被成功登录清掉')
  } finally {
    ctx.dispose()
  }
})

await test('S22', 'P2-9 disconnect 停 live 任务；dispose 清凭据', async () => {
  resetHttp()
  routeNav()
  const home = freshHome()
  writeCreds(home)
  const { ctx, current: inst } = boot({ home })
  try {
    await callTool(ctx, 'bili_login_check')
    let killed = ''
    inst.modules.live.__testing.liveTasks.set('T-smoke', {
      id: 'T-smoke', kind: 'record', roomid: 1, status: 'running', file: '', durSec: 1,
      proc: { kill(signal) { killed = signal } },
    })
    await inst.adapter.disconnect({ id: 'bili-main' })
    eq(killed, 'SIGTERM', 'disconnect 必须停掉录制/截图任务（stopAllLiveTasks）')
    inst.modules.live.__testing.liveTasks.delete('T-smoke')
    eq(inst.modules.api.isLoggedIn(), false, 'disconnect 清凭据')
  } finally {
    ctx.dispose()
  }

  resetHttp()
  routeNav()
  const home2 = freshHome()
  writeCreds(home2)
  const second = boot({ home: home2 })
  await callTool(second.ctx, 'bili_login_check')
  eq(second.current.modules.api.isLoggedIn(), true, '卸载前是登录态')
  second.ctx.dispose()
  eq(second.current.modules.api.isLoggedIn(), false, 'dispose 必须 clearCredentials（Cookie 不留在内存）')
})

/* ── 收尾 ───────────────────────────────────────────────── */

process.env.DSH_HOME = TMP
rmSync(TMP, { recursive: true, force: true })
console.log('通过 ' + passed + ' 项断言')
if (failures.length) {
  for (const f of failures) console.log('[FAIL] ' + f)
  console.log('\n==== FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + passed + ' 项断言）====')
process.exit(0)
