/**
 * mira_bilibili / adapter.js —— mira_account 的平台适配器（platform:"bilibili"）
 *
 * 契约（任务书 §mira_account 功能点2 + README「给 bot 插件的契约」）：
 *   adapter = { platform, connect(account, creds), disconnect(account),
 *               send(account, kind, peerId, payload), onMessage(account, cb),
 *               status(account), createSession?(...) }
 *
 * 分工：
 *   · 账号池 / 绑定 / 入站路由 / message_id 去重 / 通用限流 → mira_account
 *   · 协议编解码（B 站私信 API）、cookie、读写预算（权威）、风控暂停 → 本插件
 *   · 出站一律走 miraAccount.send()（它先 bind 或复用 binding，再调这里的 send）
 *
 * 注意 `send()` 里**不**再做预算判断 —— 预算是 `api.biliFetch` 的唯一闸门，
 * 这里只是协议层；重复判一次会让「谁拒的」变成两套口径。
 */

import { isEmptyValue, MiraError, toError } from './kit.mjs'
import { requireAccountId } from './config.js'
import * as api from './api.js'
import * as agent from './agent.js'
import * as live from './live.js'

export const PLATFORM = 'bilibili'

export function createAdapter({ config, logger = null, runtime, budget = null }) {
  /** account.id -> Set<cb>（onMessage 的订阅者；只旁听，不改变路由） */
  const inboundListeners = new Map()

  function ensureAccountMatch(account) {
    const cfgId = requireAccountId(config)
    if (account && account.id && account.id !== cfgId) {
      logger?.warn?.('[mira_bilibili] mira_account 传进来的账号是 ' + account.id + '，但配置里 accountId=' + cfgId
        + '：凭据将按传进来的账号读；建议把两边改成同一个 id（见 README 配置表）')
    }
    return cfgId
  }

  function notifyInbound(account, message) {
    const set = inboundListeners.get(account && account.id)
    if (!set || set.size === 0) return 0
    let n = 0
    for (const cb of [...set]) {
      try {
        cb(message)
        n++
      } catch (e) {
        logger?.warn?.('[mira_bilibili] onMessage 订阅者抛错：' + (e && e.message ? e.message : String(e)))
      }
    }
    return n
  }

  const adapter = {
    platform: PLATFORM,
    name: 'mira_bilibili',

    /**
     * 连接 = 装凭据 + 真请求一次 nav 自检 + 起轮询 + 连白名单直播间。
     * 失败时返回 {ok:false,error}（mira_account 会把账号 state 置 error 并记进 status）。
     */
    async connect(account, creds) {
      try {
        ensureAccountMatch(account)
        let applied
        if (creds && creds.fields && typeof creds.fields === 'object') {
          // mira_account 已经读过凭据文件：直接用，避免为了同一份文件再读一次
          applied = api.applyCredentialFields(creds.fields, {
            file: api.credentialsFile(account.id),
            kind: creds.kind,
            updatedAt: creds.updatedAt,
          })
        } else {
          applied = api.loadCredentials(account ? account.id : config.accountId)
        }
        if (!applied.ok) return { ok: false, error: applied.error }

        await api.refreshLogin()
        if (config.autoStart !== false) {
          agent.startPolling()
          agent.pollOnce().catch(() => {})
          live.connectWhitelistRooms().catch(() => {})
        }
        runtime.counters.bump('adapter.connect')
        logger?.info?.('[mira_bilibili] 已连接：' + String(api.getSelfUname() || '')
          + '(' + String(api.getSelfMid() || '') + ')，轮询 ' + config.pollIntervalMs + 'ms')
        return { ok: true, selfMid: api.getSelfMid(), uname: api.getSelfUname() }
      } catch (error) {
        const normalized = toError(error, 'delivery/failed')
        runtime.noteError(normalized.error.code, '连接失败：' + normalized.error.message)
        // 契约：失败必须是 {ok:false, error}。裸返回 {code,message,hint} 会被连通器当成成功（假在线）。
        return { ok: false, error: normalized.error }
      }
    },

    async disconnect(account) {
      agent.stopPolling()
      live.disconnectAllLiveRooms()
      try { live.stopAllLiveTasks() } catch { /* 退订不因任务失败而失败 */ }
      api.clearCredentials()
      inboundListeners.delete(account && account.id)
      runtime.counters.bump('adapter.disconnect')
      logger?.info?.('[mira_bilibili] 已断开 ' + (account && account.id ? account.id : ''))
      return { ok: true }
    },

    /** 出站：B 站只支持私信（kind=user）；payload.text 必填。 */
    async send(account, kind, peerId, payload) {
      if (String(kind) !== 'user') {
        throw new MiraError('platform/unsupported',
          'B 站适配器只支持 kind="user"（私信），收到：' + JSON.stringify(kind),
          '群/直播间不是私信通道：直播间发言用 bili_live_send_danmaku；评论用 bili_reply_comment')
      }
      const body = payload && typeof payload === 'object' ? payload : { text: payload }
      const text = body.text ?? body.content
      if (isEmptyValue(text)) {
        throw new MiraError('config/missing', 'payload.text 是空的：B 站私信必须有文本', '给 text；图片/表情暂不支持')
      }
      await api.ensureLogin()
      const response = await api.sendMsg(peerId, String(text))
      const messageId = api.messageIdOf(response)
      runtime.counters.bump('outbound.sent')
      logger?.info?.('[mira_bilibili] 已发送私信 user:' + peerId + '「' + String(text).slice(0, 60) + '」'
        + (messageId ? ' id=' + messageId : ''))
      return { ok: true, messageId }
    },

    /**
     * 入站订阅（契约要求的方法）。
     * mira_account 目前不调用它；本插件轮询收到消息时会 notifyInbound，
     * **路由仍然走 miraAccount.inbound()**（契约 A 不能被订阅者改变）。
     */
    onMessage(account, cb) {
      if (typeof cb !== 'function') throw new MiraError('platform/unsupported', 'onMessage 需要一个回调函数', '按 adapter 契约传 cb(account, message)')
      const id = account && account.id
      if (!inboundListeners.has(id)) inboundListeners.set(id, new Set())
      inboundListeners.get(id).add(cb)
      return () => { inboundListeners.get(id)?.delete(cb) }
    },

    /** 只读状态：连接/登录/预算/房间/最后错误（**不含凭据值**）。 */
    status() {
      let budgetStatus = null
      try { budgetStatus = budget ? budget.status() : null } catch { budgetStatus = null }
      return {
        ok: true,
        platform: PLATFORM,
        accountId: String(config.accountId || ''),
        connected: api.isLoggedIn(),
        self: api.selfStatus(),
        credentials: api.credentialsStatus(),
        budget: budgetStatus,
        rooms: live.roomsView().length,
        lastError: runtime.lastError,
      }
    },

    /** inboundPolicy=create 时由 mira_account 调用：建会话并返回 sessionId。 */
    async createSession(info) {
      return agent.createSession(info)
    },

    /** 本插件内部用：把一条入站消息交给订阅者（只旁听）。 */
    notifyInbound,
  }

  return adapter
}
