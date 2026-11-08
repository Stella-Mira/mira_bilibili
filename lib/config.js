/**
 * mira_bilibili / config.js —— 配置默认值 + schemaVersion + 校验
 *
 * 配置从 profile 的 cordis patch（`mira_bilibili` 插件行的 `config`）来，
 * 本插件**不写**自己的 config 文件；需要手填的东西只有两类：
 *   1. 这里的配置项（accountId / agentCwd / 预算 …）
 *   2. 凭据：`$DSH_HOME/mira_config/mira_account/creds/<accountId>.json`（600 权限）
 *      —— 旧版的 `config.cookie` / `config.csrf` 已废弃，**不再读取**（迁移见 README）。
 *
 * 约定7（配置版本）：`schemaVersion` 不匹配就拒绝使用，不静默兼容。
 * 约定2（显式优先）：必备项为空 → `config/missing`，禁止自动探测/猜默认。
 * 可选、只影响显示与性能的项才有默认值，且默认值必须在 README 的配置表里写明。
 */

import { deepMerge, isEmptyValue, MiraError } from './kit.mjs'

/** 本代码认识的配置版本（旧版没有 schemaVersion；带 1 或其它数字的按迁移提示拒绝）。 */
export const CONFIG_SCHEMA = 2

/** 浏览器 UA：B 站部分接口校验 UA/Referer（原样保留）。 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 预算默认值（任务书功能点4）。0/负数**不会**关闭预算，见 normalizeBudget()。 */
export const BUDGET_DEFAULTS = {
  readPerHour: 1200,
  readPerDay: 20000,
  writePerHour: 60,
  writePerDay: 300,
  // 撞 412/429 后的全局暂停：首撞 10 分钟，连续撞按 2 倍退避，上限 60 分钟
  riskPauseMs: 10 * 60 * 1000,
  riskPauseMaxMs: 60 * 60 * 1000,
}

export const DEFAULTS = {
  schemaVersion: CONFIG_SCHEMA,
  enabled: true,
  /**
   * B 站账号 id。必填（约定2：不自动探测）。
   * 它要同时对上三处：
   *   · mira_account/accounts.json 里的一行（platform:"bilibili"）
   *   · mira_account/creds/<accountId>.json（手填的 cookie）
   *   · 本插件里的 accountId
   */
  accountId: '',
  /** 加载后自动登录 + 起轮询 + 连白名单直播间；false = 只注册工具（排障/自检用） */
  autoStart: true,
  /** 轮询私信未读 / @我 的间隔（毫秒）。旧版 8000；默认改 15000 是为了让轮询本身落在读预算内（见 README 预算口径） */
  pollIntervalMs: 60000,
  callTimeoutMs: 10000,
  bufferSize: 500,
  userAgent: DEFAULT_USER_AGENT,
  /** 读/写 × 小时/天 四个桶 + 风控暂停退避；**所有** HTTP 出口都过这一道闸（含 bili_api） */
  budget: { ...BUDGET_DEFAULTS },
  /** 自动应答（私信）：本轮改为「路由交给 mira_account」，这里只留触发策略与提示词 */
  autoReply: {
    enabled: false,
    personaPrompt: '',
    rulesPrompt: [],
    securityPrompt: [],
    // 兼容旧字段：配置了 systemPrompt 且未配置 personaPrompt 时当作人设
    systemPrompt: '',
    /** 识别名单（可信任人员）：['mid:昵称', ...]；strangerPolicy=buffer 时名单内才自动应答 */
    trustedUsers: [],
    /**
     * 陌生人私信的自动应答策略：
     *   "buffer"（默认）= 不自动应答，只进消息缓冲并计数（功能点6「不回陌生人」）
     *   "reply"        = 旧版行为：任何人私信都自动建会话应答
     * 人已经手动 bind 了 taker 的 peer 不受此限制（那是人的显式决定）。
     */
    strangerPolicy: 'buffer',
    agentProvider: '',
    agentModel: '',
    /** agent 加入的预设 id（决定人设/工具/分组） */
    agentPreset: 'sylvia',
    /** 新建 agent 会话的工作目录（cwd）；inboundPolicy=create 时必填 */
    agentCwd: '',
    agentTimeoutMs: 180000,
    /** 重置会话的命令（精确匹配整条消息） */
    newCommand: '/new',
    /** 合并窗口（毫秒）：同一私信对象在此窗口内到达的多条消息合并成一条再路由 */
    mergeWindowMs: 3000,
  },
  /** 直播间弹幕 */
  danmaku: {
    enabled: true,
    /** 直播间白名单：插件启动后常驻监听；元素为房间号（短号/长号均可） */
    rooms: [],
    reconnectMinMs: 5000,
    reconnectMaxMs: 300000,
    /** WS 被踢/脱敏时降级 gethistory 轮询的间隔 */
    pollIntervalMs: 3000,
    /** 截图/录音/录视频/录播目录；留空 = autoReply.agentCwd/data/media，再不行用系统临时目录 */
    mediaDir: '',
    /** ffmpeg 可执行文件；留空 = PATH 里的 ffmpeg */
    ffmpegPath: '',
    autoReply: {
      /** 弹幕自动应答总开关（只对满足 scope 的房间生效） */
      enabled: false,
      /** 同一房间两次自动回复的最小间隔（毫秒，防刷屏） */
      minIntervalMs: 30000,
      /** 弹幕合并窗口（毫秒） */
      mergeWindowMs: 3000,
      /**
       * 哪些房间参与弹幕自动应答：
       *   "whitelist"（默认）= 只有 danmaku.rooms 白名单常驻房间（功能点6「白名单外不自动应答」）
       *   "listened"         = 白名单 + bili_live_join 临时进入的房间（旧版行为）
       */
      scope: 'whitelist',
    },
  },
}

/** 预算项归一：非正数/非数字一律回落到默认值（0 不能把预算关掉）。 */
export function normalizeBudget(input, warnings = []) {
  const raw = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of ['readPerHour', 'readPerDay', 'writePerHour', 'writePerDay']) {
    const value = Number(raw[key])
    if (!Number.isFinite(value) || value <= 0) {
      if (raw[key] !== undefined) {
        warnings.push('budget.' + key + '=' + JSON.stringify(raw[key]) + ' 非法（必须是正数）：'
          + '预算不能靠填 0 关掉，已按默认值 ' + BUDGET_DEFAULTS[key] + ' 处理')
      }
      out[key] = BUDGET_DEFAULTS[key]
    } else {
      out[key] = Math.floor(value)
    }
  }
  out.riskPauseMs = clampNumber(raw.riskPauseMs, BUDGET_DEFAULTS.riskPauseMs, 30 * 1000, 24 * 60 * 60 * 1000)
  out.riskPauseMaxMs = clampNumber(raw.riskPauseMaxMs, BUDGET_DEFAULTS.riskPauseMaxMs, out.riskPauseMs, 24 * 60 * 60 * 1000)
  return out
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function clampPositive(value, fallback, min) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.floor(n))
}

/**
 * 校验并归一配置。
 * @returns {{ok:true, config:object, warnings:string[]}|{ok:false, error:{code,message,hint}}}
 */
export function loadConfig(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const warnings = []

  // 约定7：版本不匹配拒绝使用（不静默兼容）
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CONFIG_SCHEMA) {
    return {
      ok: false,
      error: {
        code: 'config/schema',
        message: '配置版本不匹配：schemaVersion=' + JSON.stringify(raw.schemaVersion)
          + '，本代码要求 ' + CONFIG_SCHEMA,
        hint: '按 README「迁移」一节改配置后重载；旧版配置没有 schemaVersion，新写法见 README 配置表',
      },
    }
  }
  if (raw.schemaVersion === undefined) {
    warnings.push('配置里没有写 schemaVersion：按当前版本 ' + CONFIG_SCHEMA + ' 处理（建议显式写上）')
  }

  // 旧凭据字段：**不读**，只提醒迁移
  if (!isEmptyValue(raw.cookie) || !isEmptyValue(raw.csrf)) {
    warnings.push('config.cookie / config.csrf 已废弃且不会被读取：凭据只从 '
      + 'mira_account/creds/<accountId>.json（600）读；迁移步骤见 README')
  }

  const config = deepMerge(structuredClone(DEFAULTS), raw)
  config.schemaVersion = CONFIG_SCHEMA
  config.accountId = String(config.accountId ?? '').trim()
  config.pollIntervalMs = clampPositive(config.pollIntervalMs, DEFAULTS.pollIntervalMs, 1000)
  config.callTimeoutMs = clampPositive(config.callTimeoutMs, DEFAULTS.callTimeoutMs, 1000)
  config.bufferSize = clampPositive(config.bufferSize, DEFAULTS.bufferSize, 10)
  config.budget = normalizeBudget(config.budget, warnings)

  const ar = config.autoReply
  if (!['buffer', 'reply'].includes(ar.strangerPolicy)) {
    warnings.push('autoReply.strangerPolicy=' + JSON.stringify(ar.strangerPolicy)
      + ' 非法（可选 buffer / reply），按 buffer 处理')
    ar.strangerPolicy = 'buffer'
  }
  ar.mergeWindowMs = Math.max(0, Number(ar.mergeWindowMs) || 0)
  ar.agentTimeoutMs = clampPositive(ar.agentTimeoutMs, DEFAULTS.autoReply.agentTimeoutMs, 1000)
  ar.trustedUsers = Array.isArray(ar.trustedUsers) ? ar.trustedUsers.map((v) => String(v)) : []
  ar.agentPreset = String(ar.agentPreset ?? '').trim() || DEFAULTS.autoReply.agentPreset
  ar.agentCwd = String(ar.agentCwd ?? '').trim()

  const dm = config.danmaku
  dm.rooms = (Array.isArray(dm.rooms) ? dm.rooms : [])
    .map((v) => String(v).trim())
    .filter(Boolean)
  dm.reconnectMinMs = clampPositive(dm.reconnectMinMs, DEFAULTS.danmaku.reconnectMinMs, 1000)
  dm.reconnectMaxMs = clampPositive(dm.reconnectMaxMs, DEFAULTS.danmaku.reconnectMaxMs, dm.reconnectMinMs)
  dm.pollIntervalMs = clampPositive(dm.pollIntervalMs, DEFAULTS.danmaku.pollIntervalMs, 1000)
  if (!['whitelist', 'listened'].includes(dm.autoReply.scope)) {
    warnings.push('danmaku.autoReply.scope=' + JSON.stringify(dm.autoReply.scope)
      + ' 非法（可选 whitelist / listened），按 whitelist 处理')
    dm.autoReply.scope = 'whitelist'
  }
  dm.autoReply.mergeWindowMs = Math.max(0, Number(dm.autoReply.mergeWindowMs) || 0)
  dm.autoReply.minIntervalMs = Math.max(0, Number(dm.autoReply.minIntervalMs) || 0)

  config.userAgent = String(config.userAgent ?? '').trim() || DEFAULT_USER_AGENT

  return { ok: true, config, warnings }
}

/** 取 accountId；为空 → config/missing（不猜、不自动探测）。 */
export function requireAccountId(config) {
  const id = String(config?.accountId ?? '').trim()
  if (id) return id
  throw new MiraError(
    'config/missing',
    'accountId 为空：本插件不知道用哪个 B 站账号',
    '在 profile 的 cordis patch 里给 mira_bilibili 配 accountId（例如 "bili-main"），'
    + '并在 mira_account/accounts.json 里登记同 id、platform:"bilibili" 的账号，'
    + '再把 cookie 手填到 mira_account/creds/<accountId>.json（600）',
  )
}

/** 会话/自动应答需要的工作目录；为空 → config/missing。 */
export function requireAgentCwd(config) {
  const cwd = String(config?.autoReply?.agentCwd ?? '').trim()
  if (cwd) return cwd
  throw new MiraError(
    'config/missing',
    'autoReply.agentCwd 为空：无法为私信对象创建独立会话',
    '在配置里给 autoReply.agentCwd 指向你的 DSH 工作空间目录（新建会话的 cwd）',
  )
}
