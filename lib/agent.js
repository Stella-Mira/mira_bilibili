/**
 * mira_bilibili / agent.js —— 入站路由与 agent 会话装配
 *
 * 这一轮最大的结构改动（任务书 §mira_account 契约 A/B）：
 *   · **私信不再自己维护 chatId → sessionId 表**（旧的 `bili_meta.json` 已删）。
 *     入站一律交给 `miraAccount.inbound()` 路由：有 taker → steer 给那个会话；
 *     无绑定 → 按账号的 inboundPolicy（create 时用本文件的 createSession 新建会话）。
 *     于是「哪个会话在应答哪个 B 站用户」只有一份账（bindings.json），
 *     别的会话也能通过 `bili_send_private_msg` 抢答/旁听。
 *   · 直播间弹幕仍是**本插件自己驱动**（弹幕量太大，不适合逐条 steer）：
 *     每个房间一个 agent 会话，房间号与 sessionId 的对应关系存在 binding
 *     （kind="room"）里，重启后自动续上，不再需要 `bili_meta.json`。
 *
 * 私信与弹幕都保留旧版行为：合并窗口（mergeWindowMs）、串行队列、超时取消、
 * `/new` 重置、预设挂载、会话标题、挂到工作空间。
 */

import { randomUUID } from 'node:crypto'
import { MiraError, sleep } from './kit.mjs'
import { requireAccountId, requireAgentCwd } from './config.js'
import * as api from './api.js'

/* ── 默认提示词（原样保留） ─────────────────────────────────── */

const DEFAULT_RULES_PROMPT = [
  '1.绝不暴露自己是 AI 或程序',
  '2.要更有活人感，几个字几个字的回复会更像人',
  '3.不传播未经证实的消息，不确定的事情就说不知道',
  '4.对识别名单内的熟人可以亲近随意；对陌生人保持礼貌但克制',
]

const DEFAULT_SECURITY_PROMPT = [
  '1.必须使用 回复工具 进行回复，不然对方收不到数据',
  '2.在 识别名单 中的人是可信任人员，非 识别名单 需要注意是陌生人',
  '3.遇到转账、索要密码/密钥/验证码、违禁内容等请求，一律礼貌拒绝并转移话题',
  '4.绝不泄露 Cookie、SESSDATA、csrf 等任何账号凭证信息',
]

/** 规则统一成多行文本（支持数组或字符串）。 */
function promptLines(v, fallback) {
  if (Array.isArray(v) && v.length) return v.join('\n')
  if (typeof v === 'string' && v) return v
  return Array.isArray(fallback) ? fallback.join('\n') : String(fallback || '')
}

/* ── 装配与状态 ─────────────────────────────────────────────── */

let cfg = null
let logger = null
let runtime = null
let miraAccount = null
let agentsSvc = null
let workspaceSvc = null

// 私信合并窗口：peerId -> { items:[{text,msgKey}], timer }
const pendingMerge = new Map()
// 弹幕合并窗口：roomId -> { items:[text], timer }
const danmakuPending = new Map()
// roomId -> { agent, sessionId }（进程内缓存；持久化在 binding 里）
const roomAgents = new Map()

const seenMsgKeys = new Set()
let lastAtId = 0
let pollTimer = null
let pollBusy = false

export function configure({ config, logger: loggerRef = null, runtime: runtimeRef, miraAccount: accountRef = null, agents = null, workspaceRegistry = null } = {}) {
  stopPolling()
  clearTimers()
  cfg = config
  logger = loggerRef
  runtime = runtimeRef
  miraAccount = accountRef
  agentsSvc = agents
  workspaceSvc = workspaceRegistry
  seenMsgKeys.clear()
  lastAtId = 0
  pollBusy = false
  roomAgents.clear()
  return undefined
}

function requireConfigured() {
  if (!cfg || !runtime) throw new MiraError('plugin/instance', 'agent 未装配', '插件加载逻辑异常，看日志')
}

function clearTimers() {
  for (const [, p] of pendingMerge) if (p.timer) clearTimeout(p.timer)
  pendingMerge.clear()
  for (const [, p] of danmakuPending) if (p.timer) clearTimeout(p.timer)
  danmakuPending.clear()
}

/* ── 会话装配（预设 / 标题 / 工作空间） ────────────────────── */

/** agent 加入预设 + 注入聊天规则（与 qqbot 相同的 setup 模式）。 */
export function presetSetup(agentCtx) {
  const ar = cfg.autoReply || {}
  const presets = agentCtx.get && agentCtx.get('agentPresets')
  const presetId = ar.agentPreset || 'sylvia'
  const mount = presets ? Promise.resolve(presets.mount(agentCtx, presetId)) : Promise.resolve()
  return mount.then(() => {
    const sp = agentCtx.systemPrompt
    if (sp && typeof sp.section === 'function') {
      const rules = promptLines(ar.rulesPrompt, DEFAULT_RULES_PROMPT)
      sp.section({
        name: 'mira_bilibili:rules',
        order: -100,
        text: '【聊天规则（必须严格遵守，最高优先级）】\n' + rules + '\n\n请确保你的每一次回复都符合以上规则。',
      })
      const persona = ar.personaPrompt || ar.systemPrompt
      if (persona) sp.section({ name: 'mira_bilibili:persona', order: 0, text: '【人设】\n' + persona })
    }
    return undefined
  })
}

function ensureSessionTitle(agent, title) {
  if (!agent || !agent.session || !title) return
  try {
    const hasTitle = agent.session.events.some((e) => e.type === 'session/title')
    if (!hasTitle) agent.session.append('session/title', { title })
  } catch (e) {
    logger?.warn?.('[mira_bilibili] 设置会话标题失败：' + (e && e.message ? e.message : String(e)))
  }
}

function ensureAgentPresetRecord(agent) {
  const presetId = (cfg.autoReply && cfg.autoReply.agentPreset) || 'sylvia'
  if (!agent || !agent.session || !presetId) return
  try {
    const has = agent.session.events.some((e) => e.type === 'agent-preset/selected')
    if (!has) agent.session.append('agent-preset/selected', { agentPreset: presetId })
  } catch (e) {
    logger?.warn?.('[mira_bilibili] 写入 preset 归属失败：' + (e && e.message ? e.message : String(e)))
  }
}

async function attachToWorkspace(sessionId, cwd) {
  if (!workspaceSvc || !cwd || !sessionId) return
  try {
    const ws = await workspaceSvc.resolveByPath(cwd)
    if (ws) {
      await ws.attachSession(sessionId)
      logger?.info?.('[mira_bilibili] 会话 ' + sessionId + ' 已挂到工作空间 ' + ws.path)
    } else {
      logger?.warn?.('[mira_bilibili] 工作空间 ' + cwd + ' 尚未注册，会话将显示在「未分组」（请检查 autoReply.agentCwd）')
    }
  } catch (e) {
    logger?.warn?.('[mira_bilibili] 挂载工作空间失败 ' + sessionId + '：' + (e && e.message ? e.message : String(e)))
  }
}

/** 会话标题（界面显示用）：用户=昵称(mid)，直播间=直播间标题(房间号)。 */
export async function titleFor(kind, peerId, display) {
  if (kind === 'room') return '直播间' + (display ? display : '') + '(' + peerId + ')'
  const nick = display || await api.getNickname(peerId).catch(() => '') || ''
  if (!peerId) return 'B站私信'
  return (nick ? nick : '用户') + '(' + peerId + ')'
}

function agentOptions() {
  const ar = cfg.autoReply || {}
  const options = {}
  if (ar.agentProvider) options.provider = ar.agentProvider
  if (ar.agentModel) options.model = ar.agentModel
  return options
}

/** 新建一个 DSH 会话（预设 / 标题 / 工作空间一并装配）。 */
async function createAgentSession(sessionId, title, cwd) {
  const svc = agentsSvc
  if (!svc) throw new MiraError('agent/unavailable', 'DSH agents 服务不可用，无法创建 agent 会话', '检查宿主是否提供 agents 服务（inject: agents）')
  const options = agentOptions()
  const presetId = (cfg.autoReply && cfg.autoReply.agentPreset) || 'sylvia'
  const handle = await svc.create({
    sessionId,
    ...(Object.keys(options).length ? { agentOptions: options } : {}),
    meta: { ...(cwd ? { cwd } : {}), agentPreset: presetId },
    setup: presetSetup,
  })
  if (!handle || !handle.agent) throw new MiraError('session/create-failed', 'agents.create 没有返回 agent', '看宿主日志；确认 agents 服务正常')
  ensureSessionTitle(handle.agent, title)
  ensureAgentPresetRecord(handle.agent)
  await attachToWorkspace(sessionId, cwd)
  logger?.info?.('[mira_bilibili] 已创建 agent 会话 ' + sessionId + '（' + title + '）')
  return handle.agent
}

/** 接上一个已存在的会话（进程内活着 → get；否则 resume，带 4 次重试）。 */
async function attachSession(sessionId, title, cwd) {
  const svc = agentsSvc
  if (!svc || !sessionId) return null
  if (typeof svc.get === 'function') {
    const live = svc.get(sessionId)
    if (live) {
      ensureSessionTitle(live, title)
      return live
    }
  }
  const options = agentOptions()
  const delays = [0, 500, 1000, 2000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt])
    try {
      const handle = await svc.resume({
        resumeSessionId: sessionId,
        ...(Object.keys(options).length ? { agentOptions: options } : {}),
        setup: presetSetup,
      })
      if (!handle || !handle.agent) throw new Error('resume 未返回 agent')
      ensureSessionTitle(handle.agent, title)
      ensureAgentPresetRecord(handle.agent)
      await attachToWorkspace(sessionId, cwd)
      return handle.agent
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      if (/while it is live/i.test(msg)) {
        const live = typeof svc.get === 'function' ? svc.get(sessionId) : null
        if (live) {
          ensureSessionTitle(live, title)
          return live
        }
      }
      if (attempt === delays.length - 1) {
        logger?.warn?.('[mira_bilibili] 恢复会话失败 ' + sessionId + '：' + msg)
      }
    }
  }
  return null
}

/**
 * mira_account 的 adapter.createSession：inboundPolicy=create 时给「陌生人/新对象」建会话。
 * 返回 sessionId；**不在这里 bind**（router 建完会话会自己登记 taker）。
 */
export async function createSession({ account, kind, peerId, display, text }) {
  requireConfigured()
  const cwd = requireAgentCwd(cfg)
  const title = await titleFor(kind, peerId, display)
  if (text) logger?.info?.('[mira_bilibili] 为新对象建会话：' + title)
  const newId = 'bili-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  await createAgentSession(newId, title, cwd)
  return newId
}

/* ── 直播间 agent：房间 ↔ 会话（走 binding 持久化） ───────── */

/** 拿到（或创建）某个直播间的 agent 会话。 */
export async function ensureRoomAgent(room) {
  requireConfigured()
  const peerId = String(room.realRoomId)
  const cached = roomAgents.get(peerId)
  if (cached && cached.agent) return cached.agent
  const accountId = requireAccountId(cfg)
  const title = await titleFor('room', peerId, room.title || room.uname || '')
  let sessionId = ''
  try {
    const resolved = miraAccount.resolve(accountId, 'room', peerId)
    sessionId = resolved && resolved.taker ? resolved.taker.sessionId : ''
  } catch (e) {
    if (e && e.code !== 'account/not-found') {
      logger?.warn?.('[mira_bilibili] 查直播间绑定失败：' + (e.message || String(e)))
    }
  }

  let agent = sessionId ? await attachSession(sessionId, title, cfg.autoReply.agentCwd) : null
  if (agent) {
    roomAgents.set(peerId, { agent, sessionId })
    return agent
  }

  // 没绑定 / 绑定的会话已经不在 → 建新会话并登记 taker（顺带修好旧绑定）
  const newId = 'bili-room-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  agent = await createAgentSession(newId, title, cfg.autoReply.agentCwd)
  sessionId = newId
  try {
    miraAccount.bind({ sessionId, accountId, kind: 'room', peerId, mode: 'taker', force: true })
  } catch (e) {
    if (e && e.code === 'binding/conflict') {
      const resolved = miraAccount.resolve(accountId, 'room', peerId)
      const other = resolved && resolved.taker ? resolved.taker.sessionId : ''
      const otherAgent = other ? await attachSession(other, title, cfg.autoReply.agentCwd) : null
      if (otherAgent) {
        roomAgents.set(peerId, { agent: otherAgent, sessionId: other })
        return otherAgent
      }
    }
    logger?.warn?.('[mira_bilibili] 登记直播间绑定失败（' + peerId + '）：' + (e && e.message ? e.message : String(e)))
  }
  roomAgents.set(peerId, { agent, sessionId })
  return agent
}

/* ── agent 驱动（followup + 等完成 + 取消） ───────────────── */

function messageText(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && (b.type === undefined || b.type === 'text') && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return ''
}

/** 把一段文本注入会话并等它跑完，取最后一条 assistant 文本。 */
export async function agentReply(agent, text) {
  const ar = cfg.autoReply || {}
  const session = agent.session
  const before = session.deriveMessages().length
  try {
    await agent.followup({
      id: 'bilimsg-' + randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // 带上来源：宿主 RuntimeContextProjection 读 source.kind，界面也靠它区分"谁发来的"
      source: { kind: 'mira_bilibili' },
    })
  } catch (e) {
    throw new MiraError('delivery/failed', 'followup 注入失败：' + (e && e.message ? e.message : String(e)), '看宿主日志')
  }
  const timeout = ar.agentTimeoutMs || 180000
  const deadline = Date.now() + timeout
  while (agent.status === 'running' && Date.now() < deadline) await sleep(250)
  if (agent.status === 'running') {
    try { agent.cancel({ kind: 'hook', reason: 'mira_bilibili 回复超时' }) } catch { /* 忽略 */ }
    throw new MiraError('delivery/timeout', 'agent 回复超时（' + timeout + 'ms）', '调大 autoReply.agentTimeoutMs，或把该会话的活拆小一点')
  }
  const msgs = session.deriveMessages().slice(before)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m && m.role === 'assistant' && messageText(m).trim()) return messageText(m).trim()
  }
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant' && messageText(last)) return messageText(last).trim()
  throw new MiraError('delivery/failed', 'agent 未产出回复', '看宿主日志；可能是模型/工具调用失败')
}

/**
 * 弹幕与私信共用的三段：安全规则 / 识别名单 / 当前时间（提示词都来自 config，
 * 数组或字符串都认；旧版遗留的 `muse_*` 工具名会从规则里剔掉）。
 */
function promptCommonBlocks() {
  const ar = cfg.autoReply || {}
  const securityBlock = '【安全规则】\n' + promptLines(ar.securityPrompt, DEFAULT_SECURITY_PROMPT)
  const trustedList = (ar.trustedUsers || []).filter(Boolean)
  const rosterBlock = '【识别名单】\n' + (trustedList.length ? trustedList.join('\n') : '（暂无）')
  const timeBlock = '【当前时间】\n' + new Date().toLocaleString('zh-CN', { hour12: false })
  const baseLines = promptLines(ar.rulesPrompt, DEFAULT_RULES_PROMPT)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('muse_'))
  return { securityBlock, rosterBlock, timeBlock, baseLines }
}

/** 组装注入 agent 的弹幕文本（直播间类比群聊：标出发送者）。 */
export function buildDanmakuPrompt(room, text) {
  const { securityBlock, rosterBlock, timeBlock, baseLines } = promptCommonBlocks()
  const rules = baseLines.join('\n') + '\n' + (baseLines.length + 1) + '.直播间弹幕场景：想发言时必须调用 '
    + 'bili_live_send_danmaku 工具（roomid=' + room.realRoomId + '，内容 30 字以内）；你的普通文字回复不会被发送到直播间。'
    + '不要逐条回复，挑选值得回应的内容，避免刷屏'
  const roomTitle = (room.title || '') + '(' + room.realRoomId + ')'
  const sourceBlock =
    '【消息来源】\n' +
    '工具：mira_bilibili\n' +
    '平台：哔哩哔哩直播间弹幕（群聊性质）\n' +
    '房间：' + roomTitle + '\n' +
    '主播：' + (room.uname || '未知') + '\n' +
    '发言工具：bili_live_send_danmaku（roomid=' + room.realRoomId + '）——只有调用它你的话才会出现在直播间'
  const rulesBlock = '【行为规则】\n' + rules
  const msgBlock = '【观众弹幕】\n' + text
  return securityBlock + '\n\n' + rosterBlock + '\n\n' + sourceBlock + '\n\n' + timeBlock + '\n\n' + rulesBlock + '\n\n' + msgBlock
}

/**
 * 组装注入 agent 的**私信**文本（与 qqbot 同口径：安全规则 / 识别名单 / 消息来源 / 时间 / 行为规则 / 聊天消息）。
 *
 * 为什么必须有它：私信经 `miraAccount.inbound()` 路由，而它只把 `message.text` 原样投出去
 * （旁听时额外加一句框架提示）。以前这里传的是**裸文本**，于是被 mira_account 建出来的会话
 * 收到一条既没有【消息来源】、也没有配置里那套【安全规则】【行为规则】的用户消息 ——
 * 和 QQ 那边的注入差一大截（mira_account 的注释里也记着这件事："bilibili 就没拼"）。
 */
export function buildPrivatePrompt(peerId, display, text) {
  const { securityBlock, rosterBlock, timeBlock, baseLines } = promptCommonBlocks()
  const id = String(peerId ?? '')
  const who = String(display || '').trim() || ('mid ' + id)
  const sourceBlock =
    '【消息来源】\n' +
    '工具：mira_bilibili\n' +
    '平台：哔哩哔哩私信（一对一）\n' +
    '用户：' + who + '\n' +
    'ID号：' + id + '\n' +
    '回复工具：bili_send_private_msg（peerId=' + id + '）—— 只有调用它对方才收得到你的话'
  const rules = baseLines.join('\n') + '\n' + (baseLines.length + 1)
    + '.私信场景：想说话就调用 bili_send_private_msg（peerId=' + id + '）；你的普通文字回复不会发给对方。'
    + '对方是陌生人时保持礼貌克制，别透露 Cookie / SESSDATA 等任何账号凭证'
  const rulesBlock = '【行为规则】\n' + rules
  const msgBlock = '【聊天消息】\n' + text
  return securityBlock + '\n\n' + rosterBlock + '\n\n' + sourceBlock + '\n\n' + timeBlock + '\n\n' + rulesBlock + '\n\n' + msgBlock
}

/** 统计回复过程中 agent 调用的 bili_live_send_danmaku 次数（发送由工具执行）。 */
export function collectDanmakuSendCalls(agent, beforeCount) {
  const events = (agent && agent.session && agent.session.events) || []
  let count = 0
  for (let i = beforeCount; i < events.length; i++) {
    const ev = events[i]
    if (ev && ev.type === 'tool/call') {
      const d = ev.data || {}
      if (d.name === 'bili_live_send_danmaku') count++
    }
  }
  return count
}

async function handleDanmakuAgentReply(room, text) {
  const chatId = 'live:' + room.realRoomId
  const agent = await ensureRoomAgent(room)
  const events = (agent.session && agent.session.events) || []
  const beforeCount = events.length
  const reply = await agentReply(agent, buildDanmakuPrompt(room, text))
  const sendCalls = collectDanmakuSendCalls(agent, beforeCount)
  if (sendCalls === 0) {
    logger?.info?.('[mira_bilibili] 弹幕 agent 未调用发言工具，未发送（' + chatId + '；回复：' + String(reply).slice(0, 40) + '）')
    return false
  }
  logger?.info?.('[mira_bilibili] 弹幕 agent 通过工具发言 ' + sendCalls + ' 条（' + chatId + '）')
  return true
}

/* ── 弹幕自动应答：合并窗口 + 冷却（功能点5，原样保留） ────── */

export function enqueueDanmakuReply(room, mid, uname, text) {
  const chatId = 'live:' + room.realRoomId
  let p = danmakuPending.get(chatId)
  if (!p) {
    p = { items: [], timer: null }
    danmakuPending.set(chatId, p)
  }
  const who = String(uname || '未知用户') + (mid ? '(' + mid + ')' : '')
  p.items.push(who + '：' + text)
  if (p.timer) clearTimeout(p.timer)
  const win = (cfg.danmaku && cfg.danmaku.autoReply && cfg.danmaku.autoReply.mergeWindowMs) || 0
  p.timer = setTimeout(() => flushDanmakuReply(chatId, room), win)
  p.timer.unref?.()
}

function flushDanmakuReply(chatId, room) {
  const p = danmakuPending.get(chatId)
  if (!p) return
  danmakuPending.delete(chatId)
  if (p.timer) clearTimeout(p.timer)
  if (!room.queue) room.queue = []
  room.queue.push(p.items.join('\n'))
  if (room.busy) return
  const run = (async () => {
    const ar = (cfg.danmaku && cfg.danmaku.autoReply) || {}
    while (room.queue && room.queue.length) {
      // 冷却：距上次回复不足 minIntervalMs 时等待，期间继续积累
      const wait = (room.lastReplyAt + (ar.minIntervalMs || 30000)) - Date.now()
      if (wait > 0) await sleep(wait)
      if (!room.queue.length) break
      const text = room.queue.splice(0, room.queue.length).join('\n')
      try {
        await handleDanmakuAgentReply(room, text)
      } catch (e) {
        runtime.noteError(e && e.code ? e.code : 'live/autoReply',
          '弹幕自动回复失败：' + (e && e.message ? e.message : String(e)))
        logger?.warn?.('[mira_bilibili] 弹幕自动回复失败 ' + chatId + '：' + (e && e.message ? e.message : String(e)))
      }
      room.lastReplyAt = Date.now()
    }
    room.busy = false
  })()
  room.busy = run
}

/** 房间断开时取消还没到点的合并批。 */
export function cancelDanmakuReply(roomRealId) {
  const chatId = 'live:' + roomRealId
  const p = danmakuPending.get(chatId)
  if (!p) return false
  if (p.timer) clearTimeout(p.timer)
  danmakuPending.delete(chatId)
  return true
}

/* ── 私信入站：合并窗口 → mira_account 路由（契约 A） ─────── */

/** 识别名单里的 mid（支持 "mid:昵称" 或纯 mid）。 */
function trustedMidSet() {
  const set = new Set()
  for (const item of (cfg.autoReply.trustedUsers || [])) {
    const mid = String(item).split(':')[0].trim()
    if (mid) set.add(mid)
  }
  return set
}

/**
 * 这个 peer 允许路由/自动应答吗（功能点6「不回陌生人」）？
 *   · 有人显式 bind 了 taker 或 observer → 是（人的决定优先；observer 只旁听，不算自动应答）
 *   · autoReply.strangerPolicy === 'reply' → 是（旧行为）
 *   · 否则只有识别名单里的 mid 允许
 */
function peerAllowed(mid) {
  const peerId = String(mid)
  try {
    const resolved = miraAccount.resolve(cfg.accountId, 'user', peerId)
    if (resolved && (resolved.taker || (Array.isArray(resolved.observers) && resolved.observers.length > 0))) return true
  } catch { /* 账号没登记时交给 inbound 报错；这里不因此放行 */ }
  if ((cfg.autoReply.strangerPolicy || 'buffer') === 'reply') return true
  return trustedMidSet().has(peerId)
}

/** 私信文本提取（原样保留）。 */
export function extractMsgText(m) {
  if (!m) return ''
  const type = m.msg_type
  if (type === 1) {
    if (typeof m.content === 'string') {
      try {
        const p = JSON.parse(m.content)
        if (p && typeof p === 'object' && typeof p.content === 'string') return p.content
      } catch { /* 不是 JSON，直接用 */ }
      return m.content
    }
    if (m.content && typeof m.content === 'object' && typeof m.content.content === 'string') return m.content.content
    return ''
  }
  if (type === 2) return '[图片]'
  if (type === 5) return '[撤回消息]'
  if (type === 6) return '[文件]'
  if (type === 7) return '[表情]'
  if (type === 10) return '[视频]'
  if (type === 11) return '[语音]'
  if (type === 14) return '[语音]'
  return '[消息类型' + type + ']'
}

/** 交给 mira_account 路由：有 taker → steer；无绑定 → 按 inboundPolicy（可 create）。 */
async function deliverToAccount(peerId, text, msgKey) {
  const accountId = requireAccountId(cfg)
  let display = String(peerId)
  try { display = await api.getNickname(peerId) } catch { /* 拿不到昵称用 mid */ }
  // 正文按 qqbot 的口径拼好（安全规则/识别名单/消息来源/时间/行为规则/聊天消息）：
  // mira_account 只把 message.text 原样投出去，拼提示词这件事必须在这里做。
  const prompt = buildPrivatePrompt(peerId, display, text)
  let result
  try {
    result = await miraAccount.inbound({
      accountId,
      kind: 'user',
      peerId: String(peerId),
      display,
      message: {
        id: msgKey === undefined || msgKey === null ? '' : String(msgKey),
        text: prompt,
        sender: String(peerId),
      },
      // 来源：宿主读 source.kind，界面也靠它区分是哪个插件带来的消息
      source: { kind: 'mira_bilibili' },
    })
  } catch (e) {
    runtime.counters.bump('inbound.failed')
    runtime.noteError(e && e.code ? e.code : 'inbound/failed', '入站路由失败：' + (e && e.message ? e.message : String(e)))
    return { routed: 'error' }
  }
  const routed = (result && result.routed) || 'unknown'
  runtime.counters.bump('inbound.' + routed)
  if (routed === 'dropped' || routed === 'error') {
    runtime.noteError(
      (result && result.error && result.error.code) || 'inbound/dropped',
      '入站被丢弃：' + JSON.stringify((result && (result.reason || result.error)) || {}),
    )
  } else if (routed === 'dup') {
    runtime.counters.bump(result && result.echo ? 'inbound.echo' : 'inbound.duplicate')
  }
  return result
}

async function flushPrivateMerge(peerId) {
  const p = pendingMerge.get(peerId)
  if (!p) return
  pendingMerge.delete(peerId)
  if (p.timer) clearTimeout(p.timer)
  const text = p.items.map((i) => i.text).join('\n')
  const last = p.items[p.items.length - 1]
  await deliverToAccount(peerId, text, last.msgKey)
}

/** `/new`：解除该 peer 的绑定，下一条消息按 inboundPolicy 重新建会话。 */
export async function resetPeer(peerId) {
  const accountId = requireAccountId(cfg)
  cancelPrivateMerge(peerId)
  let removed = { removed: 0 }
  try {
    removed = miraAccount.unbind({ accountId, kind: 'user', peerId: String(peerId) })
  } catch (e) {
    runtime.noteError(e && e.code ? e.code : 'binding/not-found', '重置会话时解绑失败：' + (e && e.message ? e.message : String(e)))
  }
  logger?.info?.('[mira_bilibili] agent 会话已重置 user:' + peerId + '（解绑 ' + (removed.removed || 0) + ' 条）')
  try {
    await api.ensureLogin()
    await api.sendMsg(peerId, '新会话已开启~ 重新认识一下吧！(◕ᴗ◕✿)')
  } catch (e) {
    runtime.noteError(e && e.code ? e.code : 'delivery/failed', '重置会话后发送失败：' + (e && e.message ? e.message : String(e)))
  }
  return removed
}

export function cancelPrivateMerge(peerId) {
  const p = pendingMerge.get(String(peerId))
  if (!p) return false
  if (p.timer) clearTimeout(p.timer)
  pendingMerge.delete(String(peerId))
  return true
}

/** 一条私信（已进缓冲）的处理：/new → 陌生人策略 → 合并窗口 → 路由。 */
export async function handlePrivateMessage(ev) {
  requireConfigured()
  const ar = cfg.autoReply || {}
  if (!ar.enabled) return { routed: 'disabled' }
  const mid = ev && ev.talker_id
  if (mid === undefined || mid === null) return { routed: 'no-peer' }
  if (String(mid) === String(api.getSelfMid())) return { routed: 'self' } // 不回复自己
  const peerId = String(mid)
  const text = String(ev.text || '')
  logger?.info?.('[mira_bilibili] 收到私信 user:' + peerId + '：' + text.slice(0, 40))

  // 权限顺序：陌生人策略必须**先于**任何命令分支（否则陌生人一条 /new 就能解绑该 peer 的 taker）
  if (!peerAllowed(peerId)) {
    runtime.counters.bump('ignored.stranger')
    logger?.info?.('[mira_bilibili] 陌生人私信 user:' + peerId + ' 不自动应答（只进缓冲；要应答请绑定 taker 或配 trustedUsers）')
    return { routed: 'ignored', reason: 'stranger' }
  }

  if (ar.newCommand && text.trim() === ar.newCommand) {
    await resetPeer(peerId)
    return { routed: 'reset' }
  }

  const win = Number(ar.mergeWindowMs) || 0
  if (win > 0) {
    let p = pendingMerge.get(peerId)
    if (!p) {
      p = { items: [], timer: null }
      pendingMerge.set(peerId, p)
    }
    p.items.push({ text, msgKey: ev.msg_key })
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => { flushPrivateMerge(peerId).catch(() => {}) }, win)
    p.timer.unref?.()
    return { routed: 'merged' }
  }
  return deliverToAccount(peerId, text, ev.msg_key)
}

/* ── 轮询：私信未读 + @我（原样保留节奏） ──────────────────── */

export async function pollOnce() {
  requireConfigured()
  if (pollBusy || !api.isLoggedIn()) return { skipped: true }
  pollBusy = true
  try {
    // 1) 私信：会话列表里带未读数的会话逐个拉取
    const sessions = await api.getSessions()
    for (const s of sessions) {
      if (!s || s.session_type !== 1) continue
      const talkerId = s.talker_id
      const unread = Number(s.unread_count || 0)
      if (!talkerId || unread <= 0) continue
      let msgs
      try {
        msgs = await api.fetchSessionMsgs(talkerId, Math.min(Math.max(unread, 1), 20))
      } catch (e) {
        runtime.noteError(e && e.code ? e.code : 'inbound/fetch', '拉取私信失败（' + talkerId + '）：' + (e && e.message ? e.message : String(e)))
        continue
      }
      let maxSeqno = 0
      for (const m of msgs) {
        const seqno = Number(m.msg_seqno || 0)
        if (seqno > maxSeqno) maxSeqno = seqno
        if (String(m.sender_uid) === String(api.getSelfMid())) continue
        const key = String(talkerId) + '|' + String(m.msg_seqno)
        if (seenMsgKeys.has(key)) continue
        seenMsgKeys.add(key)
        if (seenMsgKeys.size > 5000) {
          const it = seenMsgKeys.values()
          for (let i = 0; i < 1000; i++) seenMsgKeys.delete(it.next().value)
        }
        const text = extractMsgText(m)
        if (!text) continue
        const ev = runtime.push({
          post_type: 'message',
          kind: 'private',
          talker_id: talkerId,
          mid: m.sender_uid,
          msg_key: m.msg_key,
          msg_seqno: m.msg_seqno,
          timestamp: m.timestamp,
          text,
        })
        handlePrivateMessage(ev).catch((e) => {
          runtime.noteError(e && e.code ? e.code : 'inbound/failed', '私信处理异常：' + (e && e.message ? e.message : String(e)))
        })
      }
      if (maxSeqno > 0) await api.updateAck(talkerId, maxSeqno)
    }

    // 2) @我 消息（只缓冲不自动应答；模型可用 bili_reply_comment 回复）
    const items = await api.getAtFeed()
    // 接口是「新 → 旧」：循环内只用**旧的** lastAtId 判重，循环结束再统一抬到本批 max(id)
    // （否则同批只留最新一条，其余被永久跳过）
    let batchMaxAtId = lastAtId
    for (const item of items) {
      const id = Number((item && item.id) || 0)
      if (!id || id <= lastAtId) continue
      if (id > batchMaxAtId) batchMaxAtId = id
      runtime.push({
        post_type: 'at',
        kind: 'at',
        at_id: id,
        mid: item.mid,
        user: item.user,
        type: item.type,
        business_id: item.business_id,
        source_id: item.source_id,
        item: item.item,
        uri: item.uri,
        source_content: item.source_content,
      })
    }
    lastAtId = batchMaxAtId
    return { ok: true }
  } catch (e) {
    runtime.noteError(e && e.code ? e.code : 'poll/failed', '轮询失败：' + (e && e.message ? e.message : String(e)))
    return { ok: false }
  } finally {
    pollBusy = false
  }
}

export function startPolling() {
  stopPolling()
  requireConfigured()
  pollTimer = setInterval(() => { pollOnce().catch(() => {}) }, cfg.pollIntervalMs)
  pollTimer.unref?.()
  return pollTimer
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function disposeAgent() {
  stopPolling()
  clearTimers()
  roomAgents.clear()
}

/* ── 观测 ─────────────────────────────────────────────────── */

export function statusView() {
  const counters = runtime ? runtime.counters.snapshot() : {}
  return {
    autoReplyEnabled: !!(cfg && cfg.autoReply && cfg.autoReply.enabled),
    strangerPolicy: (cfg && cfg.autoReply && cfg.autoReply.strangerPolicy) || 'buffer',
    mergeWindowMs: (cfg && cfg.autoReply && cfg.autoReply.mergeWindowMs) || 0,
    newCommand: (cfg && cfg.autoReply && cfg.autoReply.newCommand) || '',
    agentCwd: (cfg && cfg.autoReply && cfg.autoReply.agentCwd) || '',
    agentPreset: (cfg && cfg.autoReply && cfg.autoReply.agentPreset) || '',
    polling: !!pollTimer,
    pollIntervalMs: (cfg && cfg.pollIntervalMs) || 0,
    seenMsgKeys: seenMsgKeys.size,
    pendingMerges: pendingMerge.size,
    danmakuMerges: danmakuPending.size,
    ignoredStranger: counters['ignored.stranger'] || 0,
    inbound: Object.fromEntries(Object.entries(counters).filter(([k]) => k.startsWith('inbound.'))),
  }
}

/** 自检用（不是 DSH 接口）。 */
export const __testing = {
  promptLines,
  DEFAULT_RULES_PROMPT,
  DEFAULT_SECURITY_PROMPT,
  pendingMerge,
  danmakuPending,
  roomAgents,
  seenMsgKeys,
}
