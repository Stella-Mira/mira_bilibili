/**
 * mira_bilibili / api.js —— 接口层（从旧 2784 行 index.js 原样搬过来的 B 站 REST 封装）
 *
 * 搬运原则（PLAN §5 第 3 条）：**不改协议**。路径、参数名、表单字段、wbi 签名算法、
 * 错误文案、节流间隔、缓存 TTL 全部与旧实现一致。这一轮只做三件事：
 *   1. 凭据来源：不再读 `config.cookie/csrf`，改为读 mira_account 的
 *      `creds/<accountId>.json`（600，只写不回显，见 loadCredentials）；
 *   2. 所有请求经过 `biliFetch` 的**同一道预算闸**（budget.take）+ 412/429 全局暂停；
 *   3. 状态（selfMid / lastError / 缓冲）拆到 runtime，不再散落成模块级全局。
 *
 * 依赖：只 import `node:` 与相对路径（kit / config / budget / runtime）。
 */

import { basename, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { fileMode, fmtLocalHHMM, MiraError, miraConfigDir, readJsonStrict, sleep } from './kit.mjs'

const MIRA_ACCOUNT_DIR = () => miraConfigDir('mira_account')
const CREDS_SCHEMA = 1

/* ── 模块状态（由 configure() 装配/重置） ───────────────────── */

let cfg = null
let logger = null
let budget = null
let runtime = null
let fetchImpl = null

/** 当前凭据形态（**只留字段名与权限，值另存**） */
let credsMeta = null
let cookieHeader = ''
let csrf = ''
let buvid3 = ''

let selfMid = null
let selfUname = null
let loggedIn = false
let wbiKeys = null
let cachedBuvidB3 = ''
let accInfoBackoffUntil = 0

const userInfoCache = new Map()
const nameCache = new Map()
const NAME_TTL_MS = 10 * 60 * 1000
const USER_INFO_TTL_MS = 10 * 60 * 1000
const throttleState = new Map()

/**
 * 装配（由 index.js 的 apply 调；自检里也用同一套入口）。
 * 重置所有进程内缓存：重复 apply 不会带着上一个实例的 selfMid / wbi / 缓存跑。
 */
export function configure({ config, logger: loggerRef = null, budget: budgetRef, runtime: runtimeRef, fetch: fetchOverride = null } = {}) {
  cfg = config
  logger = loggerRef
  budget = budgetRef
  runtime = runtimeRef
  fetchImpl = typeof fetchOverride === 'function' ? fetchOverride : null
  credsMeta = null
  cookieHeader = ''
  csrf = ''
  buvid3 = ''
  selfMid = null
  selfUname = null
  loggedIn = false
  wbiKeys = null
  cachedBuvidB3 = ''
  accInfoBackoffUntil = 0
  userInfoCache.clear()
  nameCache.clear()
  throttleState.clear()
  return undefined
}

function requireConfigured() {
  if (!cfg) throw new MiraError('plugin/instance', 'api 未装配：index.js 没有调用 api.configure', '插件加载逻辑异常，看日志')
  if (!budget) throw new MiraError('budget/missing', '预算未装配（所有请求必须过预算闸）', '插件加载逻辑异常，看日志')
  if (!runtime) throw new MiraError('plugin/instance', 'runtime 未装配', '插件加载逻辑异常，看日志')
}

function doFetch(url, init) {
  const fn = fetchImpl || globalThis.fetch
  if (typeof fn !== 'function') throw new MiraError('api/network', '运行环境没有 fetch', 'Node 18+ 才有内置 fetch')
  // 绑定到 globalThis：部分实现（含测试替身）依赖 this
  return fetchImpl ? fn(url, init) : fn.call(globalThis, url, init)
}

/* ── 凭据（约定8：单独文件、600、永不回显、不进日志） ─────── */

/** `$DSH_HOME/mira_config/mira_account/creds/<accountId>.json` */
export function credentialsFile(accountId) {
  const id = String(accountId ?? '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new MiraError('account/invalid', '账号 id 非法：' + JSON.stringify(accountId),
      '账号 id 只允许字母数字与 . _ -（见 mira_account/accounts.json）')
  }
  return join(MIRA_ACCOUNT_DIR(), 'creds', id + '.json')
}

function credsHint(file) {
  return '手填 creds/' + basename(file) + '（完整路径 ' + file + '，权限 600）：'
    + '{"schemaVersion":1,"platform":"bilibili","kind":"cookie","fields":{"SESSDATA":"…","bili_jct":"…","buvid3":"…"}}'
}

/**
 * 从 mira_account 的凭据文件读 cookie（SESSDATA / bili_jct / buvid3）。
 * 返回 { ok:true, status } 或 { ok:false, error:{code,message,hint} }。
 * 失败原因分得很细：文件缺 / 格式坏 / 版本不符 / 平台不符 / 字段缺 —— 每种都给下一步。
 */
export function loadCredentials(accountId) {
  requireConfigured()
  let file
  try {
    file = credentialsFile(accountId)
  } catch (error) {
    return { ok: false, error: { code: error.code || 'account/invalid', message: error.message, hint: error.hint } }
  }
  const read = readJsonStrict(file)
  if (!read.ok) {
    return {
      ok: false,
      error: {
        code: 'creds/missing',
        message: read.reason === 'missing'
          ? '凭据文件不存在：' + file
          : '凭据文件无法解析（' + read.reason + '）：' + file,
        hint: credsHint(file),
      },
    }
  }
  const value = read.value
  if (value.schemaVersion !== CREDS_SCHEMA) {
    return {
      ok: false,
      error: {
        code: 'config/schema',
        message: '凭据文件版本不匹配：' + file + ' 的 schemaVersion=' + JSON.stringify(value.schemaVersion)
          + '，要求 ' + CREDS_SCHEMA,
        hint: '按 README「迁移」重写一份凭据文件（' + credsHint(file) + '）',
      },
    }
  }
  if (value.platform !== 'bilibili') {
    return {
      ok: false,
      error: {
        code: 'creds/invalid',
        message: '凭据文件平台不符：' + file + ' 的 platform=' + JSON.stringify(value.platform) + '，本插件要 "bilibili"',
        hint: credsHint(file),
      },
    }
  }
  if (value.kind !== 'cookie') {
    return {
      ok: false,
      error: {
        code: 'creds/invalid',
        message: '凭据形态不符：' + file + ' 的 kind=' + JSON.stringify(value.kind) + '，B 站只支持 "cookie"',
        hint: credsHint(file),
      },
    }
  }
  const mode = fileMode(file)
  let modeOk = mode === 0o600
  if (!modeOk) {
    // 自愈：权限不对就改回 600（约定8），并在状态里如实回报
    try { chmodSync(file, 0o600); modeOk = true } catch { /* 平台不支持就交给 umask */ }
  }
  const applied = applyCredentialFields(value.fields, {
    file, mode: mode === 0o600 ? 0o600 : (modeOk ? 0o600 : mode), modeOk, updatedAt: value.updatedAt ?? null, kind: value.kind,
  })
  if (!applied.ok) return applied
  return { ok: true, status: credentialsStatus() }
}

/**
 * 用一份已校验/未校验的 fields 装配凭据（mira_account 的 connect 也会走这里）。
 * 必备字段：SESSDATA、bili_jct；buvid3 建议并警告（缺了搜索类 wbi 接口更容易 412）。
 */
export function applyCredentialFields(fields, meta = {}) {
  requireConfigured()
  const src = fields && typeof fields === 'object' ? fields : {}
  // 没有显式传权限时，按文件实际权限统计（并顺手修回 600，约定8）
  let mode = meta.mode
  let modeOk = meta.modeOk !== false
  if (meta.file && mode === undefined) {
    const actual = fileMode(meta.file)
    mode = actual
    modeOk = actual === 0o600
    if (!modeOk) {
      try { chmodSync(meta.file, 0o600); mode = 0o600; modeOk = true } catch { /* 平台不支持就交给 umask */ }
    }
  }
  const sessdata = String(src.SESSDATA ?? '').trim()
  const jct = String(src.bili_jct ?? '').trim()
  const buvid = String(src.buvid3 ?? '').trim()
  const missing = []
  if (!sessdata) missing.push('SESSDATA')
  if (!jct) missing.push('bili_jct')
  if (missing.length) {
    const file = meta.file || '(未知文件)'
    return {
      ok: false,
      error: {
        code: 'config/missing',
        message: '凭据文件缺少必备字段：' + missing.join(' / ') + '（' + file + '）',
        hint: credsHint(file) + '（SESSDATA 与 bili_jct 必填；buvid3 建议也填，缺了部分 wbi 接口更易 412）',
      },
    }
  }
  // DedeUserID / DedeUserID__ckMd5 也带上：专栏草稿这类写接口会校验 uid 与 csrf 是否同源
  const uid = String(src.DedeUserID ?? '').trim()
  const uidMd5 = String(src['DedeUserID__ckMd5'] ?? '').trim()
  cookieHeader = [
    'SESSDATA=' + sessdata,
    'bili_jct=' + jct,
    buvid ? 'buvid3=' + buvid : '',
    uid ? 'DedeUserID=' + uid : '',
    uidMd5 ? 'DedeUserID__ckMd5=' + uidMd5 : '',
  ].filter(Boolean).join('; ')
  csrf = jct
  buvid3 = buvid
  cachedBuvidB3 = ''
  credsMeta = {
    present: true,
    accountId: String(cfg?.accountId ?? '').trim(),
    file: meta.file || null,
    platform: 'bilibili',
    kind: meta.kind || 'cookie',
    fieldNames: Object.keys(src),
    mode: mode ?? null,
    modeOk,
    updatedAt: meta.updatedAt ?? null,
    // 注意：只报字段名，**不报任何值**（约定8）
    buvid3Present: !!buvid,
    warning: buvid ? null : '凭据里没有 buvid3：部分 wbi 接口（搜索/动态）更容易 412',
  }
  if (!buvid) logger?.warn?.('[mira_bilibili] 凭据里没有 buvid3：部分 wbi 接口更容易触发 412（建议补上）')
  return { ok: true, status: credentialsStatus() }
}

export function clearCredentials() {
  credsMeta = null
  cookieHeader = ''
  csrf = ''
  buvid3 = ''
  cachedBuvidB3 = ''
  loggedIn = false
  selfMid = null
  selfUname = null
  wbiKeys = null
}

/** 只读凭据状态（有没有 / 字段名 / 权限位），**永远不含值**。 */
export function credentialsStatus() {
  if (!credsMeta) {
    const file = (() => {
      try { return credentialsFile(cfg?.accountId) } catch { return null }
    })()
    return {
      present: false,
      accountId: String(cfg?.accountId ?? '').trim(),
      file,
      fieldNames: [],
      mode: null,
      modeOk: false,
      hint: file ? credsHint(file) : '先配 accountId',
    }
  }
  const mode = credsMeta.mode
  return {
    ...credsMeta,
    // 权限位只报八进制文本（0o600），不报任何值
    mode: typeof mode === 'number' && mode >= 0 ? '0o' + mode.toString(8) : null,
  }
}

function ensureCredentialsLoaded() {
  requireConfigured()
  if (credsMeta) return
  const result = loadCredentials(cfg.accountId)
  if (!result.ok) throw new MiraError(result.error.code, result.error.message, result.error.hint)
}

export function hasCredentials() {
  return !!credsMeta
}

export function getCsrf() {
  return csrf
}

export function getBuvid3Field() {
  return buvid3
}

export function getUserAgent() {
  return cfg?.userAgent || ''
}

/* ── 登录态 ───────────────────────────────────────────────── */

export function isLoggedIn() {
  return loggedIn
}

export function getSelfMid() {
  return selfMid
}

export function getSelfUname() {
  return selfUname
}

export function selfStatus() {
  return {
    loggedIn,
    mid: selfMid,
    uname: selfUname,
    wbiReady: !!wbiKeys,
    accInfoBackoff: accInfoBackoffUntil > Date.now(),
    userInfoCacheSize: userInfoCache.size,
  }
}

/** 从 nav 响应里取 wbi 密钥（nav 已经返回 wbi_img，不必再请求一次）。 */
function applyWbiFromNav(nav) {
  const wbi = nav && nav.data && nav.data.wbi_img
  if (wbi && wbi.img_url && wbi.sub_url) {
    const imgKey = basename(wbi.img_url).split('.')[0]
    const subKey = basename(wbi.sub_url).split('.')[0]
    wbiKeys = getMixinKey(imgKey + subKey)
  }
}

/** 登录自检：真请求一次 nav（wbi 密钥从同一个响应里取）。失败 → creds/invalid。 */
export async function refreshLogin() {
  ensureCredentialsLoaded()
  // 入口先置 false：任何失败路径（网络/HTTP/超时）都不能留下“假在线”，
  // 否则 ensureLogin 短路、pollOnce 守卫失效（评审 P1-6）
  loggedIn = false
  let nav
  try {
    nav = await biliFetch('/x/web-interface/nav')
  } catch (error) {
    selfMid = null
    selfUname = null
    throw error
  }
  const d = nav && nav.data
  loggedIn = !!(d && d.isLogin)
  selfMid = (d && d.mid) ?? selfMid
  selfUname = (d && d.uname) ?? selfUname
  if (!loggedIn) {
    selfMid = null
    selfUname = null
    runtime.noteError('creds/invalid', 'Cookie 未登录或已过期（nav.isLogin=false）')
    throw new MiraError(
      'creds/invalid',
      'Cookie 未登录或已过期（nav.isLogin=false）',
      '重新从浏览器 F12 → Application → Cookies 抄 SESSDATA / bili_jct（HttpOnly，脚本读不到）到 '
        + 'creds/' + String(cfg?.accountId ?? '').trim() + '.json（600），然后重载插件',
    )
  }
  // 只清凭据类错误：别把无关的 lastError（轮询/弹幕/投递）一起抹掉（评审 P2-8）
  if (String(runtime.lastError?.code || '').startsWith('creds/')) runtime.clearError()
  applyWbiFromNav(nav)
  // 兜底：个别响应不带 wbi_img 时再单独取一次（正常不会走到）
  if (!wbiKeys) await refreshWbiKeys()
  return nav
}

/** 发写操作前确保已登录（未登录就先做一次 nav 自检）。 */
export async function ensureLogin() {
  if (loggedIn) return
  await refreshLogin()
}

/* ── HTTP 基础（**唯一出口**：预算闸 + 风控暂停都在这里） ──── */

/** 允许携带 Cookie 的域名（bili_api 传完整 URL 时的白名单）。 */
const BILI_HOST_RE = /(^|\.)(bilibili\.com|bilibili\.tv|hdslb\.com|biliapi\.net)$/i

function resolveRequestUrl(path) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return 'https://api.bilibili.com' + path
  let parsed
  try {
    parsed = new URL(path)
  } catch {
    throw new MiraError('api/url', 'URL 无法解析：' + path, '传 / 开头的 api.bilibili.com 路径，或完整的 B 站 URL')
  }
  // 只放行 https：http 会把 Cookie 明文发出去（评审 P1-3）
  if (parsed.protocol !== 'https:') {
    throw new MiraError(
      'api/unsupported-host',
      '拒绝非 https 目标：' + path,
      '只允许 https://（http 会让 Cookie 明文上网）；传 / 开头的路径或 https:// 的 B 站 URL',
    )
  }
  if (!BILI_HOST_RE.test(parsed.hostname)) {
    throw new MiraError(
      'api/unsupported-host',
      '拒绝请求非 B 站域名：' + parsed.hostname,
      '逃生舱只允许 B 站域名（*.bilibili.com / *.bilibili.tv / *.hdslb.com / *.biliapi.net）'
        + '——否则 Cookie 会被发给第三方主机',
    )
  }
  return path
}

/**
 * 所有 B 站请求的唯一入口。
 * @param {string} path `/x/...` 或完整 URL
 * @param {object} [opts]
 * @param {'GET'|'POST'} [opts.method]
 * @param {object} [opts.form]           POST 表单（自动附 csrf）
 * @param {object} [opts.headers]
 * @param {'read'|'write'} [opts.budget] 显式指定桶（内部维护类 POST 记读桶）
 * @param {boolean} [opts.anonymous]     不带 Cookie
 */
export async function biliFetch(path, opts) {
  requireConfigured()
  ensureCredentialsLoaded()
  const o = opts || {}
  const method = String(o.method || 'GET').toUpperCase()
  const bucket = o.budget === 'read' || o.budget === 'write'
    ? o.budget
    : (method === 'POST' ? 'write' : 'read')

  // ⓪ 先校验目标（非法/非 B 站域名直接拒，**不占配额、不发请求**）
  let url = resolveRequestUrl(String(path))
  // JSON 写接口（专栏草稿等）要求 csrf 在 query 上：调用方在拼 URL 时 csrf 可能还没装载，
  // 这里在凭据就位后补一次（不改表单分支的行为）
  if (method === 'POST' && o.json !== undefined && csrf && !/[?&]csrf=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'csrf=' + encodeURIComponent(csrf)
  }

  // ① 预算闸：被拒时抛错，**不发请求**（含 bili_api 逃生舱）
  budget.take(bucket)

  const headers = {
    'User-Agent': cfg.userAgent,
    Referer: 'https://www.bilibili.com/',
    ...(o.headers || {}),
  }
  if (cookieHeader && !o.anonymous) headers.Cookie = cookieHeader

  let body
  if (method === 'POST' && o.json !== undefined) {
    // 部分新接口（专栏/opus）要 JSON body 而不是表单；csrf 由 cookie 承担
    body = JSON.stringify(o.json)
    headers['Content-Type'] = 'application/json'
  } else if (method === 'POST') {
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(o.form || {})) form.append(k, v === undefined ? '' : String(v))
    if (csrf && !form.has('csrf')) form.append('csrf', csrf)
    if (csrf && !form.has('csrf_token')) form.append('csrf_token', csrf)
    body = form.toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  // ② 请求
  let resp
  try {
    resp = await doFetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(cfg.callTimeoutMs),
    })
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    runtime.noteError('api/network', 'B站请求失败（' + method + ' ' + url + '）：' + message)
    throw new MiraError('api/network', 'B站请求失败：' + message, '检查网络/代理；bili_status 看预算与暂停状态')
  }

  // ③ 风控：412/429 → 全局暂停 + 退避（这一条请求确实发出去了）
  if (resp.status === 412 || resp.status === 429) {
    const until = budget.noteRisk(resp.status)
    runtime.noteError('budget/risk', 'B站风控拦截 HTTP ' + resp.status + '（' + method + ' ' + url + '）')
    throw new MiraError(
      'budget/risk',
      'B站风控拦截 HTTP ' + resp.status + '：已全局暂停所有调用',
      '暂停到 ' + fmtLocalHHMM(until) + '（连续撞墙会 2 倍退避）；期间所有调用直接拒绝（含 bili_api），'
        + '别换接口硬试',
    )
  }
  if (!resp.ok) {
    runtime.noteError('api/http', 'HTTP ' + resp.status + '（' + method + ' ' + url + '）')
    throw new MiraError('api/http', 'HTTP ' + resp.status, 'B 站接口异常；稍后再试，持续失败看 README 错误码')
  }

  // ④ 业务码
  let data
  try {
    data = await resp.json()
  } catch (error) {
    runtime.noteError('api/parse', '返回不是 JSON（' + method + ' ' + url + '）')
    throw new MiraError('api/parse', 'B站返回不是 JSON：' + (error && error.message ? error.message : String(error)), '可能是风控页/登录页；检查 Cookie')
  }
  if (data && typeof data === 'object' && data.code !== undefined && data.code !== 0) {
    if (data.code === -412 || data.code === -509) {
      const until = budget.noteRisk(data.code)
      runtime.noteError('budget/risk', 'B站风控拦截 code=' + data.code + '（' + method + ' ' + url + '）')
      throw new MiraError(
        'budget/risk',
        'B站风控拦截 code=' + data.code + '：已全局暂停所有调用',
        '暂停到 ' + fmtLocalHHMM(until) + '；期间所有调用直接拒绝（含 bili_api）',
      )
    }
    budget.noteSuccess()
    const message = 'B站接口 code=' + data.code + (data.message ? '：' + data.message : '')
    runtime.noteError('api/code', message)
    throw new MiraError('api/code', message, '-799 是请求过于频繁、-352 是风控、-101 是未登录；稍后再试或换接口')
  }
  budget.noteSuccess()
  return data
}

// 拼接 query（值统一 encodeURIComponent，原样保留）
export function qs(params) {
  const parts = []
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
  }
  return parts.length ? '?' + parts.join('&') : ''
}

/* ── 节流（原样保留：同域最小间隔，防连打触发 -799 / 412） ── */

async function throttle(key, minMs) {
  const last = throttleState.get(key) || 0
  const wait = last + minMs - Date.now()
  if (wait > 0) await sleep(wait)
  throttleState.set(key, Date.now())
}

/* ── wbi 签名（搜索等接口需要；算法来自 bilibili-API-collect，原样保留） ── */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

async function refreshWbiKeys() {
  try {
    const nav = await biliFetch('/x/web-interface/nav')
    const wbi = nav && nav.data && nav.data.wbi_img
    if (wbi && wbi.img_url && wbi.sub_url) {
      const imgKey = basename(wbi.img_url).split('.')[0]
      const subKey = basename(wbi.sub_url).split('.')[0]
      wbiKeys = getMixinKey(imgKey + subKey)
    }
  } catch { /* wbi 刷新失败不影响其他功能（旧行为） */ }
}

// 给参数附加 wts / w_rid（buvid3 参与签名，与官方 web 行为一致），返回完整 query 串（含 ?）
export function encWbi(params) {
  const out = { ...(params || {}), wts: Math.round(Date.now() / 1000) }
  if (buvid3 && out.buvid3 === undefined) out.buvid3 = buvid3
  const query = Object.keys(out)
    .sort()
    .map((k) => {
      const v = String(out[k])
      const clean = encodeURIComponent(v).replace(/[!'()*]/g, '')
      return encodeURIComponent(k) + '=' + clean
    })
    .join('&')
  if (wbiKeys) {
    const wRid = createHash('md5').update(query + wbiKeys).digest('hex')
    return '?' + query + '&w_rid=' + wRid
  }
  return '?' + query
}

/* ── 私信 / 动态 / 评论 / 搜索 / 视频（路径与参数原样保留） ── */

/** 私信会话列表（含未读数） */
export async function getSessions() {
  const r = await biliFetch('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions' + qs({
    session_type: 1,
    group_fold: 1,
    unfollow_fold: 0,
    sort_rule: 2,
    build: 0,
    mobi_app: 'web',
  }))
  return (r && r.data && r.data.session_list) || []
}

/** 拉取与某用户（talker_id）的私信消息 */
export async function fetchSessionMsgs(talkerId, size) {
  const r = await biliFetch('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs' + qs({
    talker_id: talkerId,
    session_type: 1,
    size: size || 20,
    sender_device_id: 1,
    build: 0,
    mobi_app: 'web',
  }))
  return (r && r.data && r.data.messages) || []
}

/**
 * 标记某会话已读到 seqno（清除未读，重启后不会重复处理）。
 * 口径：这是轮询的维护动作（读路径），显式记读桶 —— 否则轮询会把写预算吃光。
 */
export async function updateAck(talkerId, ackSeqno) {
  try {
    await biliFetch('https://api.vc.bilibili.com/session_svr/v1/session_svr/update_ack', {
      method: 'POST',
      budget: 'read',
      form: {
        talker_id: talkerId,
        session_type: 1,
        ack_seqno: ackSeqno,
        build: 0,
        mobi_app: 'web',
      },
    })
  } catch { /* ack 失败不致命（旧行为） */ }
}

/** 发送私信文本（写操作；csrf 由 biliFetch 自动附加） */
export async function sendMsg(receiverId, text) {
  const stamp = Math.round(Date.now() / 1000)
  const r = await biliFetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    form: {
      'msg[sender_uid]': selfMid ?? '',
      'msg[receiver_id]': receiverId,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content: String(text) }),
      'msg[timestamp]': stamp,
      'msg[dev_id]': randomUUID(),
      'msg[new_face_version]': 0,
      build: 0,
      mobi_app: 'web',
    },
  })
  return r
}

/** 发私信的 message_id（B 站回 msg_key；没有就退 msg_seqno）。 */
export function messageIdOf(response) {
  const d = response && response.data
  if (!d || typeof d !== 'object') return null
  const id = d.msg_key ?? d.msg_seqno ?? d.msgKey
  return id === undefined || id === null || id === '' ? null : String(id)
}

/** 发布纯文本动态 */
export async function createDynamic(text) {
  return biliFetch('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create', {
    method: 'POST',
    form: {
      dynamic_id: 0,
      type: 4,
      rid: 0,
      content: String(text),
      extension: JSON.stringify({ emoji_type: 1, from: { emoji_type: 1 }, flag_cfg: {} }),
      at_uids: '',
      ctrl: JSON.stringify([]),
      csrf_token: csrf,
      platform: 'web',
    },
  })
}

/**
 * 创作中心图片上传（biz=draw 动态配图 / article 专栏图）。
 * 走 multipart，所以不走 biliFetch 的 urlencoded 分支；**预算与风控照旧**：
 * 先 take 写预算，412/429 触发全局暂停。
 * 返回值：{ url, width, height }（url 是 bili 的图片直链，写进动态/专栏正文时用）。
 */
export async function uploadImage(filePath, opts = {}) {
  requireConfigured()
  ensureCredentialsLoaded()
  const { readFileSync } = await import('node:fs')
  const { basename: base } = await import('node:path')

  const url = resolveRequestUrl('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs')
  budget.take('write')

  const buf = readFileSync(filePath)
  const form = new FormData()
  form.append('file_up', new Blob([buf]), base(filePath))
  form.append('biz', String(opts.biz || 'draw'))
  form.append('category', String(opts.category || 'daily'))
  form.append('csrf', csrf)

  let resp
  try {
    resp = await doFetch(url, {
      method: 'POST',
      headers: { 'User-Agent': cfg.userAgent, Referer: 'https://www.bilibili.com/', Cookie: cookieHeader },
      body: form,
      signal: AbortSignal.timeout(Math.max(cfg.callTimeoutMs, 60000)),
    })
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    runtime.noteError('api/network', '图片上传失败：' + message)
    throw new MiraError('api/network', '图片上传失败：' + message, '检查网络/代理与文件大小')
  }
  if (resp.status === 412 || resp.status === 429) {
    const until = budget.noteRisk(resp.status)
    throw new MiraError('budget/risk', 'B站风控拦截 HTTP ' + resp.status + '：已全局暂停所有调用（暂停到 ' + fmtLocalHHMM(until) + '）')
  }
  const data = await resp.json().catch(() => null)
  if (!data || data.code !== 0) {
    const code = data && data.code
    const message = data && data.message
    runtime.noteError('api/code', '图片上传 code=' + code + (message ? '：' + message : ''))
    throw new MiraError('api/code', '图片上传失败 code=' + code + (message ? '：' + message : ''), '-101 未登录 / -400 参数 / 403 权限不足')
  }
  budget.noteSuccess()
  const d = data.data || {}
  return { url: d.image_url || d.url || '', width: d.image_width || 0, height: d.image_height || 0 }
}

/* ── 专栏（read-editor / eva3）：草稿与段落结构 ─────────────────
 * 抓包自 2026-11-04：编辑器 iframe 为 member.bilibili.com/york/read-editor，
 * 存草稿 = POST /x/dynamic/feed/article/draft/add，body 是 JSON {arg:{...}}，
 * 正文按 paragraphs 存，每段 {para_type:1, format:{indent:{0,0}}, text:{nodes:[…]}}。
 */

/** 纯文本 → eva3 段落数组（空行保留为空段） */
export function textToParagraphs(text) {
  const lines = String(text ?? '').split('\n')
  return lines.map((line) => {
    const t = line.trim()
    if (!t) {
      return { para_type: 1, format: { indent: { first_line_indent: 0, indent: 0 } }, text: { nodes: [] } }
    }
    return {
      para_type: 1,
      format: { indent: { first_line_indent: 0, indent: 0 } },
      text: {
        nodes: [{
          node_type: 1,
          word: { words: t, font_size: 17, color: '', dark_color: '', style: {}, font_level: 'regular' },
        }],
      },
    }
  })
}

/**
 * 保存专栏草稿（不会公开）。返回 article_id。
 * opts: { title, text, categoryId=15, summary, privatePub=2, original=0, listId=0 }
 */
export async function saveArticleDraft(opts = {}) {
  const title = String(opts.title || '').trim()
  if (!title) throw new MiraError('arg/invalid', '标题不能为空', '专栏标题 1–50 字')
  const text = String(opts.text || '')
  const arg = {
    ...(opts.articleId ? { article_id: opts.articleId } : {}),
    type: 4,
    template_id: 1,
    category_id: opts.categoryId ?? 15,
    title,
    private_pub: opts.privatePub ?? 2,
    reprint: 1,
    original: opts.original ?? 0,
    list_id: opts.listId ?? 0,
    comment_selected: 0,
    up_closed_reply: 0,
    timer_pub_time: 0,
    only_fans_level: 0,
    only_fans_dnd: 0,
    summary: opts.summary ?? ('\n\n' + text.slice(0, 120)),
    // 封面 / 正文配图：传进来就带上（浏览器上传图片床拿到的直链）
    ...(opts.bannerUrl ? { banner_url: String(opts.bannerUrl) } : {}),
    ...(Array.isArray(opts.imageUrls) && opts.imageUrls.length
      ? { image_urls: opts.imageUrls.map(String) } : {}),
    opus: {
      opus_source: 2,
      title,
      content: { paragraphs: textToParagraphs(text) },
      pub_info: { editor_version: 'eva3-4.0.0' },
      attachments: { is_aigc: 0 },
    },
  }
  // csrf 必须放在 query（实测：放 body 或不带都回 -111 CSRF 校验失败）
  const r = await biliFetch('https://api.bilibili.com/x/dynamic/feed/article/draft/add', {
    method: 'POST',
    json: { arg, csrf },
    // 创作中心接口会看 Referer 归属；用 www 域会回 -111
    headers: { Referer: 'https://member.bilibili.com/' },
  })
  return { articleId: r && r.data && r.data.article_id, raw: r }
}

/** 删除专栏草稿（article_id 来自草稿列表或 saveArticleDraft 返回值） */
export async function deleteArticleDraft(articleId) {
  const r = await biliFetch('/x/dynamic/feed/article/draft/delete', {
    method: 'POST',
    form: { article_id: articleId },
    headers: { Referer: 'https://member.bilibili.com/' },
  })
  return { ok: !!(r && r.code === 0), code: r && r.code, raw: r }
}

/** 读取专栏草稿（article_id 来自 saveArticleDraft 或创作中心） */
export async function getArticleDraft(articleId) {
  const r = await biliFetch('/x/dynamic/feed/article/draft/view' + qs({ article_id: articleId }))
  return r && r.data && r.data.draft
}

/** @我 的消息流（新→旧） */
export async function getAtFeed() {
  const r = await biliFetch('/x/msgfeed/at' + qs({ platform: 'web', build: 0, mobi_app: 'web' }))
  const d = r && r.data
  return (d && Array.isArray(d.items) && d.items) || []
}

/** 回复评论：type=1 视频评论（oid=av号）/ 17 动态评论（oid=dynamic_id）等 */
export async function replyComment(args) {
  return biliFetch('/x/v2/reply/add', {
    method: 'POST',
    form: {
      oid: args.oid,
      type: args.type,
      root: args.root ?? 0,
      parent: args.parent ?? 0,
      message: String(args.message),
      plat: 1,
    },
  })
}

/** 搜索视频（wbi 签名接口；节流防连打触发风控 412） */
export async function searchVideos(keyword, page, pageSize) {
  await throttle('wbi-search', 800)
  const r = await biliFetch('/x/web-interface/wbi/search/type' + encWbi({
    search_type: 'video',
    keyword: String(keyword),
    page: page || 1,
    page_size: pageSize || 20,
  }))
  const d = r && r.data
  return d || {}
}

/** 视频信息（bvid 或 aid） */
export async function getVideoInfo(id) {
  await throttle('view', 600)
  const p = /^\d+$/.test(String(id)) ? { aid: id } : { bvid: id }
  const r = await biliFetch('/x/web-interface/view' + qs(p))
  return r && r.data ? r.data : {}
}

/**
 * 用户信息（昵称 / 头像 / 签名）。
 * 实测经验（原样保留）：
 *   - acc/info 带 jsonp 参数会走旧版 JSONP 通道，限频更狠，连打报 -799；不带则与普通 REST 一致
 *   - 账号/IP 级限频触发后一段时间内连打必败，需熔断 + 缓存 + 降级 card 接口
 */
export async function getUserInfo(mid) {
  const hit = userInfoCache.get(mid)
  if (hit && Date.now() - hit.at < USER_INFO_TTL_MS) return hit.data

  let data = null
  if (Date.now() >= accInfoBackoffUntil) {
    await throttle('acc-info', 3000)
    try {
      const r = await biliFetch('/x/space/acc/info' + qs({ mid }))
      data = r && r.data
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      if (/-799/.test(msg)) {
        accInfoBackoffUntil = Date.now() + 90 * 1000
        logger?.warn?.('[mira_bilibili] acc/info 触发 -799 限频（mid=' + mid + '），熔断 90 秒并降级 card 接口')
      } else {
        logger?.warn?.('[mira_bilibili] acc/info 失败（mid=' + mid + '）：' + msg)
      }
    }
  }
  if (!data) {
    await throttle('card', 1500)
    try {
      const r = await biliFetch('/x/web-interface/card' + qs({ mid, photo: true }))
      const card = r && r.data && r.data.card
      if (card) {
        data = {
          mid: card.mid,
          name: card.name,
          face: card.face,
          sign: card.sign,
          official: card.official,
          fans: card.fans,
          friend: card.friend,
          attention: card.attention,
        }
      }
    } catch (e) {
      logger?.warn?.('[mira_bilibili] card 接口失败（mid=' + mid + '）：' + (e && e.message ? e.message : String(e)))
    }
  }

  if (data) {
    userInfoCache.set(mid, { data, at: Date.now() })
    return data
  }
  const stale = userInfoCache.get(mid)
  if (stale) return { ...stale.data, _note: '接口限频/失败，返回旧缓存' }
  return {}
}

/** 关注/粉丝统计（relation/stat 接口：频率限制宽松，随时可用） */
export async function getRelationStat(vmid) {
  const r = await biliFetch('/x/relation/stat' + qs({ vmid }))
  return r && r.data ? r.data : {}
}

/** 取昵称（TTL 缓存 + 节流，避免高频打空间详情接口）；拿不到就用 mid 当名字。 */
export async function getNickname(mid) {
  const key = String(mid)
  const hit = nameCache.get(key)
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name
  let name = ''
  try {
    const info = await getUserInfo(mid)
    name = (info && info.name) || ''
  } catch { /* 拿不到昵称时降级 */ }
  nameCache.set(key, { name: name || key, at: Date.now() })
  return nameCache.get(key).name
}

/** 供 bili_status 用（不暴露缓存内容）。 */
export function apiStatus() {
  return {
    self: selfStatus(),
    csrfConfigured: !!csrf,
    cookieConfigured: !!cookieHeader,
    buvid3Configured: !!buvid3,
    accInfoBackoff: accInfoBackoffUntil > Date.now(),
    userInfoCacheSize: userInfoCache.size,
    nameCacheSize: nameCache.size,
    callTimeoutMs: cfg?.callTimeoutMs ?? null,
  }
}

