/**
 * mira_bilibili / live.js —— 直播间弹幕 / 录制 / 截图（从旧 index.js 原样搬）
 *
 * 搬运原则：协议、重连退避、降级轮询、首轮静默、下播自动退出、弹幕合并/冷却、
 * ffmpeg 参数与「换 CDN 节点重试」逻辑全部与旧实现一致。这一轮只改三处：
 *   1. 状态从模块级全局变成 configure() 装配（便于自检与热加载）；
 *   2. 直播间 REST（room_init / getInfoByRoom / getDanmuInfo / 流地址 / 发弹幕）
 *      也搬到这里——它们和连接状态机是同一件事，放一起更好读；
 *   3. 新增「自动应答范围」口径（danmaku.autoReply.scope，默认 whitelist）与
 *      忽略计数（约定5：不静默丢弃，计数可见）。
 *
 * ⚠️ 旧版踩坑记录（原样保留，别再踩）：
 *   WS 弹幕流用匿名鉴权（uid=0）虽稳定但昵称被脱敏（mid=0，无法过滤自己）；
 *   带登录身份（uid/buvid）则可能被服务器踢（1006）。而 xlive gethistory 接口带
 *   Cookie 返回完整 uid/昵称且无 -352 风控，故设计为「WS 主通道 + gethistory 降级」。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { inflateSync, brotliDecompressSync } from 'node:zlib'
import * as api from './api.js'
import * as agent from './agent.js'
import { MiraError } from './kit.mjs'

/* ── 装配与状态 ─────────────────────────────────────────────── */

let cfg = null
let logger = null
let runtime = null

// realRoomId(字符串) -> room
const liveRooms = new Map()
// taskId -> { kind, roomid, url, file, proc, startAt, durSec, status, err }
const liveTasks = new Map()
let liveTaskSeq = 0

const DANMAKU_MAX_LEN = 30

export function configure({ config, logger: loggerRef = null, runtime: runtimeRef } = {}) {
  disconnectAllLiveRooms()
  stopAllLiveTasks()
  cfg = config
  logger = loggerRef
  runtime = runtimeRef
  return undefined
}

function requireConfigured() {
  if (!cfg || !runtime) throw new MiraError('plugin/instance', 'live 未装配', '插件加载逻辑异常，看日志')
}

/* ── 房间与白名单 ───────────────────────────────────────────── */

export function roomKey(realRoomId) {
  return String(realRoomId)
}

export function isWhitelistedRoom(realRoomId) {
  const wl = ((cfg && cfg.danmaku && cfg.danmaku.rooms) || []).map(String)
  return wl.includes(String(realRoomId))
}

/**
 * 是否对该房间做弹幕自动应答（功能点6：白名单外不自动应答）。
 * scope="whitelist"（默认）只认 danmaku.rooms；"listened" 恢复旧行为（白名单 + 临时 join）。
 */
export function roomAutoReply(room) {
  const dm = cfg && cfg.danmaku
  if (!dm || !dm.autoReply || !dm.autoReply.enabled) return false
  if (dm.autoReply.scope === 'listened') return !!(room && (room.whitelisted || room.joined))
  return !!(room && room.whitelisted)
}

/* ── 直播间 REST（原样搬） ──────────────────────────────────── */

/** 房间号归一：短号 → 真实房间号（room_init） */
export async function liveRoomInit(roomId) {
  const r = await api.biliFetch('https://api.live.bilibili.com/room/v1/Room/room_init' + api.qs({ id: roomId }))
  const d = r && r.data
  if (!d || d.room_id === undefined) throw new MiraError('live/room-not-found', '无效的房间号：' + roomId, '传短号或长号；确认直播间存在')
  return d // { room_id, short_id, uid, live_status, ... }
}

/**
 * 直播间信息（标题/主播/直播状态）
 * 主通道：xlive getInfoByRoom（信息最全）。被风控（-352，实测真实浏览器同样被拦）时，
 * 降级 getH5InfoByRoom——后者返回同构的 room_info / anchor_info.base_info，仅缺 short_id。
 */
export async function liveRoomInfo(realRoomId) {
  let d = null
  try {
    const r = await api.biliFetch('https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom' + api.qs({ room_id: realRoomId }))
    d = (r && r.data) || null
  } catch { /* 风控/失败 → 降级 */ }
  if (!d || !d.room_info) {
    const r2 = await api.biliFetch('https://api.live.bilibili.com/xlive/web-room/v1/index/getH5InfoByRoom' + api.qs({ room_id: realRoomId }))
    d = (r2 && r2.data) || null
  }
  const info = (d && d.room_info) || {}
  const anchor = (d && d.anchor_info && d.anchor_info.base_info) || {}
  return {
    room_id: info.room_id ?? realRoomId,
    short_id: info.short_id,
    uid: info.uid,
    title: info.title || '',
    live_status: info.live_status ?? 0,
    area_name: info.area_name || '',
    parent_area_name: info.parent_area_name || '',
    uname: anchor.uname || '',
    face: anchor.face || '',
  }
}

/** 弹幕 WebSocket 入口信息（token + host）；被风控时降级旧接口 getConf。 */
export async function liveDanmuInfo(realRoomId) {
  try {
    const r = await api.biliFetch('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo' + api.qs({ id: realRoomId, type: 0 }))
    const d = r && r.data
    const host = d && Array.isArray(d.host_list) && d.host_list.length ? d.host_list[0] : null
    if (host && host.host && d.token) {
      return { token: d.token, host: host.host, wssPort: (host.wss_port || host.port) || 443 }
    }
  } catch { /* 降级旧接口 */ }
  const r2 = await api.biliFetch('https://api.live.bilibili.com/room/v1/Danmu/getConf' + api.qs({ room_id: realRoomId, platform: 'pc', player: 'web' }))
  const d2 = r2 && r2.data
  const hosts = (d2 && (d2.host_server_list || d2.host_list)) || []
  const h = (Array.isArray(hosts) && hosts.find((x) => x && x.host)) || {}
  return {
    token: (d2 && d2.token) || '',
    host: h.host || 'broadcastlv.chat.bilibili.com',
    wssPort: (h.wss_port || h.port) || 443,
  }
}

// buvid（认证包 buvid 字段用）：finger/spi 接口的 b_3（参考 MagicalDanmaku）
let cachedBuvidB3 = ''
export async function getBuvidB3() {
  if (cachedBuvidB3) return cachedBuvidB3
  try {
    const r = await api.biliFetch('https://api.bilibili.com/x/frontend/finger/spi')
    const b = r && r.data && r.data.b_3
    if (b) cachedBuvidB3 = String(b)
  } catch { /* 拿不到时用 cookie 里的 buvid3 兜底 */ }
  if (!cachedBuvidB3) cachedBuvidB3 = api.getBuvid3Field()
  return cachedBuvidB3
}

/** 发送弹幕（需要登录；web 端单条最长 30 字，超长自动截断） */
export async function sendDanmaku(realRoomId, text) {
  const raw = String(text || '')
  const msg = Array.from(raw).slice(0, DANMAKU_MAX_LEN).join('')
  const csrf = api.getCsrf()
  const r = await api.biliFetch('https://api.live.bilibili.com/msg/send', {
    method: 'POST',
    headers: { Referer: 'https://live.bilibili.com/' + realRoomId },
    form: {
      bubble: 0,
      msg,
      color: 16777215,
      mode: 1,
      fontsize: 25,
      rnd: Math.round(Date.now() / 1000),
      roomid: realRoomId,
      csrf,
      csrf_token: csrf,
    },
  })
  return { ok: !!(r && r.code === 0), code: r && r.code, message: r && r.message, sent: msg, truncated: msg.length < raw.length }
}

/**
 * 获取直播流播放地址候选列表（按优先级排序、去重）。
 * 实测：B 站 CDN 部分节点会随机拒绝（403，与拉流方 IP 强绑定），
 * 所以返回全部候选地址，由下游失败自动换节点重试。
 */
export async function getLiveStreamUrls(realRoomId) {
  let data = null
  try {
    const r = await api.biliFetch('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo' + api.qs({
      room_id: realRoomId,
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      qn: 10000,
      platform: 'web',
      ptype: 8,
    }))
    data = r && r.data
  } catch (e) {
    runtime.noteError('live/stream', '获取直播流信息失败（roomid=' + realRoomId + '）：' + (e && e.message ? e.message : String(e)))
  }
  const playurl = data && data.playurl_info && data.playurl_info.playurl
  const streams = (playurl && Array.isArray(playurl.stream)) ? playurl.stream : []
  if (!streams.length) {
    throw new MiraError('live/stream', '未获取到直播流（房间可能未开播或接口被风控）',
      '确认直播间在播；持续失败看 bili_status 的暂停/预算状态')
  }
  const fmtRank = { flv: 0, fmp4: 1, ts: 2 }
  const candidates = []
  for (const s of streams) {
    const formats = (s && Array.isArray(s.format)) ? s.format : []
    for (const f of formats) {
      const rank = fmtRank[f.format_name] !== undefined ? fmtRank[f.format_name] : 9
      const codecs = (f && Array.isArray(f.codec)) ? f.codec : []
      for (const c of codecs) {
        const urls = (c && Array.isArray(c.url_info)) ? c.url_info : []
        const baseUrl = (c && c.base_url) || ''
        if (!baseUrl) continue
        for (const u of urls) {
          if (!u || !u.host) continue
          const qn = Number(c.accept_qn || s.qn || c.current_qn || 0)
          candidates.push({ url: u.host + baseUrl + (u.extra || ''), qn, rank })
        }
      }
    }
  }
  if (!candidates.length) throw new MiraError('live/stream', '直播流地址解析失败（roomid=' + realRoomId + '）', '稍后再试')
  candidates.sort((a, b) => (b.qn - a.qn) || (a.rank - b.rank))
  const urls = []
  const seen = new Set()
  for (const c of candidates) {
    if (!seen.has(c.url)) {
      seen.add(c.url)
      urls.push(c.url)
    }
  }
  return urls
}

/** 查询直播状态（room_init 抗风控，返回 live_status；getInfoByRoom 会被 -352） */
export async function fetchLiveStatus(realRoomId) {
  const init = await liveRoomInit(realRoomId)
  return { live_status: init.live_status ?? 1, uid: init.uid, room_id: init.room_id }
}

/* ── 媒体目录 / ffmpeg ─────────────────────────────────────── */

export function mediaDir() {
  const dm = (cfg && cfg.danmaku) || {}
  if (dm.mediaDir) return String(dm.mediaDir)
  const ar = (cfg && cfg.autoReply) || {}
  if (ar.agentCwd) return resolve(String(ar.agentCwd), 'data', 'media')
  return resolve(tmpdir(), 'mira_bilibili_media')
}

export function ffmpegBin() {
  const dm = (cfg && cfg.danmaku) || {}
  return dm.ffmpegPath || 'ffmpeg'
}

function nextLiveTaskId(kind) {
  liveTaskSeq++
  return kind + '-' + Date.now().toString(36) + '-' + liveTaskSeq
}

/** 任务结果通知：进消息缓冲（post_type=live_task），智能体用 bili_recv_messages 增量拉取 */
function notifyLiveTask(task, status, extra) {
  const detail = extra || {}
  runtime.push({
    post_type: 'live_task',
    kind: 'live_task',
    task_kind: task.kind,
    task_id: task.id,
    status, // done | error | stopped
    room_id: task.roomid,
    file: task.file || '',
    duration_sec: task.durSec || 0,
    message: detail.message || '',
    error: detail.error || '',
  })
  logger?.info?.('[mira_bilibili] 直播媒体任务 ' + task.id + ' ' + status + (task.file ? '：' + task.file : ''))
}

/**
 * 启动 ffmpeg 任务（返回 liveTasks 条目；onExit 自动通知智能体）。
 * opts.urls 为候选流地址列表：拉流失败（403/网络错误）自动换下一个节点重试。
 */
export function spawnLiveTask(opts) {
  const { kind, roomid, file, durSec, stopAfter } = opts
  const urls = (opts.urls && opts.urls.length) ? opts.urls : (opts.url ? [opts.url] : [])
  const id = nextLiveTaskId(kind)
  const task = {
    id,
    kind, // audio | video | record
    roomid: Number(roomid),
    url: urls[0] || '',
    file,
    proc: null,
    startAt: Date.now(),
    durSec: durSec || 0,
    status: 'running',
    err: '',
    stopAfter: stopAfter || 0,
  }
  liveTasks.set(id, task)

  let urlIndex = 0
  const startWith = (idx) => {
    if (task.status !== 'running' || idx >= urls.length) return
    urlIndex = idx
    task.url = urls[idx]
    const args = ['-hide_banner', '-loglevel', 'warning', '-y']
    if (opts.userAgent) args.push('-user_agent', opts.userAgent)
    // B 站 CDN 校验 Referer/Origin；-headers 与 -user_agent 都是输入选项，必须在 -i 之前
    const hdrs = ['Origin: https://live.bilibili.com']
    if (opts.referer) hdrs.unshift('Referer: ' + opts.referer)
    args.push('-headers', hdrs.join('\r\n') + '\r\n')
    args.push('-i', urls[idx])
    if (durSec) args.push('-t', String(durSec))
    args.push(...opts.outArgs)
    args.push(file)
    let proc
    try {
      proc = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      task.status = 'error'
      task.err = 'ffmpeg 启动失败：' + (e && e.message ? e.message : String(e))
      notifyLiveTask(task, 'error', { error: task.err })
      return
    }
    task.proc = proc
    let stderr = ''
    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        stderr += String(d)
        if (stderr.length > 8000) stderr = stderr.slice(-8000)
      })
    }
    const finish = (status) => {
      if (task.status !== 'running') return
      task.status = status
      task.err = stderr ? stderr.slice(-1500) : task.err
      if (stopAfter && task.stopTimer) clearTimeout(task.stopTimer)
      if (task.stopTimer2) clearTimeout(task.stopTimer2)
      notifyLiveTask(task, status, status === 'error' ? { error: task.err } : {})
      if (status !== 'running') {
        const cleanup = setTimeout(() => liveTasks.delete(id), 10 * 60 * 1000)
        cleanup.unref?.()
      }
    }
    proc.on('error', (e) => {
      task.err = String(e && e.message ? e.message : e)
      finish('error')
    })
    proc.on('exit', (code) => {
      if (task.status === 'stopped') return
      if (task.stopRequested) {
        finish('stopped')
        return
      }
      if (code === 0) {
        finish('done')
        return
      }
      if (urlIndex + 1 < urls.length) {
        logger?.warn?.('[mira_bilibili] 直播流节点失败（' + task.id + ' #' + (urlIndex + 1) + '/' + urls.length + '，'
          + stderr.slice(-160).replace(/\n/g, ' ') + '），换下一个节点')
        startWith(urlIndex + 1)
        return
      }
      finish('error')
    })
    if (stopAfter) {
      task.stopTimer = setTimeout(() => {
        if (task.status === 'running') {
          try { proc.kill('SIGTERM') } catch { /* 忽略 */ }
          task.stopTimer2 = setTimeout(() => {
            if (task.status === 'running') {
              try { proc.kill('SIGKILL') } catch { /* 忽略 */ }
            }
          }, 5000)
        }
      }, stopAfter)
    }
  }
  startWith(0)
  return task
}

/** 开始录播（无时长，返回 taskId；用 bili_live_record_stop 停止） */
export function startLiveRecord(realRoomId, urls, file) {
  const task = spawnLiveTask({ kind: 'record', roomid: realRoomId, urls, file, durSec: 0, outArgs: ['-c', 'copy'] })
  if (task.status === 'running') logger?.info?.('[mira_bilibili] 开始录播 ' + task.id + ' → ' + file)
  return task
}

/** 停止录播（优雅 SIGTERM 让 ffmpeg 写文件尾；5 秒后未退出强制 SIGKILL） */
export function stopLiveRecord(taskId) {
  const task = liveTasks.get(taskId)
  if (!task) return { ok: false, error: '任务不存在：' + taskId }
  if (task.kind !== 'record') return { ok: false, error: '该任务不是录播：' + taskId }
  if (task.status !== 'running') return { ok: true, taskId, status: task.status, file: task.file }
  task.stopRequested = true
  try { task.proc.kill('SIGTERM') } catch (e) {
    return { ok: false, error: '停止失败：' + (e && e.message ? e.message : String(e)) }
  }
  setTimeout(() => {
    const t = liveTasks.get(taskId)
    if (t && t.status === 'running') {
      try { t.proc.kill('SIGKILL') } catch { /* 忽略 */ }
    }
  }, 5000)
  return { ok: true, taskId, status: 'stopping', file: task.file }
}

export function stopAllLiveTasks() {
  for (const [, task] of liveTasks) {
    if (task.proc && task.status === 'running') {
      try { task.proc.kill('SIGTERM') } catch { /* 忽略 */ }
    }
  }
}

export function listLiveTasks() {
  const tasks = []
  for (const [, t] of liveTasks) {
    tasks.push({
      task_id: t.id,
      kind: t.kind,
      roomid: t.roomid,
      status: t.status,
      file: t.file,
      duration_sec: t.durSec,
      elapsed_sec: t.startAt ? Math.round((Date.now() - t.startAt) / 1000) : 0,
      err: t.err ? t.err.slice(0, 300) : '',
    })
  }
  return tasks
}

/* ── 截图 / 录音 / 录视频（工具调用体，原样搬） ────────────── */

export async function screenshotLiveRoom(realRoomId, savePath) {
  requireConfigured()
  const urls = await getLiveStreamUrls(realRoomId)
  const dir = mediaDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  const file = savePath
    ? String(savePath)
    : resolve(dir, 'bili_live_screenshot_' + realRoomId + '_' + Date.now() + '.jpg')
  // 依次尝试候选流地址，第一个成功的节点返回
  let code = -1
  for (const url of urls) {
    code = await new Promise((res) => {
      const proc = spawn(ffmpegBin(), [
        '-hide_banner', '-loglevel', 'warning', '-y',
        '-user_agent', cfg.userAgent,
        '-referer', 'https://live.bilibili.com/' + realRoomId,
        '-i', url,
        '-frames:v', '1',
        '-q:v', '2',
        file,
      ])
      const killer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* 忽略 */ }
        res(-1)
      }, 30000)
      proc.on('exit', (c) => {
        clearTimeout(killer)
        res(c ?? -1)
      })
    })
    if (code === 0) break
  }
  const okFile = code === 0 && existsSync(file)
  return {
    ok: okFile,
    code,
    file: okFile ? file : '',
    error: okFile ? '' : 'ffmpeg 退出码 ' + code + '（房间可能未开播或流被风控）',
  }
}

export async function recordAudio(realRoomId, durationSec, savePath) {
  requireConfigured()
  const urls = await getLiveStreamUrls(realRoomId)
  const dur = Math.min(Math.max(1, Number(durationSec || 30)), 600)
  const dir = mediaDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  const file = savePath
    ? String(savePath)
    : resolve(dir, 'bili_live_audio_' + realRoomId + '_' + Date.now() + '.m4a')
  const task = spawnLiveTask({
    kind: 'audio',
    roomid: realRoomId,
    urls,
    file,
    durSec: dur,
    stopAfter: (dur + 30) * 1000,
    userAgent: cfg.userAgent,
    referer: 'https://live.bilibili.com/' + realRoomId,
    outArgs: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  })
  return task
}

export async function recordVideo(realRoomId, durationSec, savePath) {
  requireConfigured()
  const urls = await getLiveStreamUrls(realRoomId)
  const dur = Math.min(Math.max(1, Number(durationSec || 30)), 600)
  const dir = mediaDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  const file = savePath
    ? String(savePath)
    : resolve(dir, 'bili_live_video_' + realRoomId + '_' + Date.now() + '.mp4')
  return spawnLiveTask({
    kind: 'video',
    roomid: realRoomId,
    urls,
    file,
    durSec: dur,
    stopAfter: (dur + 30) * 1000,
    userAgent: cfg.userAgent,
    referer: 'https://live.bilibili.com/' + realRoomId,
    outArgs: ['-c', 'copy'],
  })
}

export async function startRecord(realRoomId, savePath) {
  requireConfigured()
  const urls = await getLiveStreamUrls(realRoomId)
  const dir = mediaDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  const file = savePath
    ? String(savePath)
    : resolve(dir, 'bili_live_record_' + realRoomId + '_' + Date.now() + '.mp4')
  return startLiveRecord(realRoomId, urls, file)
}

/* ── 弹幕接收：HTTP gethistory（降级通道） ──────────────────── */

/** 拉取直播间最近弹幕（带 Cookie：完整 uid/昵称；返回新→旧） */
export async function fetchDanmakuHistory(realRoomId) {
  const r = await api.biliFetch('https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory' + api.qs({ roomid: realRoomId, room_type: 0 }))
  const d = r && r.data
  const list = []
  if (d) {
    for (const key of ['admin', 'room']) {
      if (Array.isArray(d[key])) for (const m of d[key]) list.push(m)
    }
  }
  return list
}

/** 弹幕计数：自动应答入队 / 被忽略（白名单外或未开自动应答）。 */
function markDanmakuVerdict(room, eligible) {
  const counters = runtime.counters
  if (eligible) {
    counters.bump('danmaku.autoReplyQueued')
    room.autoReplied = (room.autoReplied || 0) + 1
  } else {
    counters.bump('danmaku.ignored')
    room.ignoredCount = (room.ignoredCount || 0) + 1
  }
}

/** 处理一条历史弹幕记录（gethistory 条目：text/uid/nickname/id_str 等） */
export function handleHistoryDanmaku(room, m) {
  requireConfigured()
  const text = String((m.text || '')).trim()
  if (!text) return false
  const mid = m.uid ?? 0
  const uname = String(m.nickname || '').trim() || '未知用户'
  if (String(mid) === String(api.getSelfMid())) return false // 不处理自己的弹幕（gethistory 有完整 uid，过滤可靠）
  runtime.push({
    post_type: 'danmaku',
    kind: 'danmaku',
    room_id: room.realRoomId,
    room_title: room.title || '',
    anchor: room.uname || '',
    mid,
    uname,
    text,
    dm_type: m.dm_type ?? 0,
    isadmin: m.isadmin ?? 0,
    timeline: m.timeline || '',
    id_str: m.id_str || '',
  })
  const eligible = roomAutoReply(room)
  markDanmakuVerdict(room, eligible)
  if (eligible) agent.enqueueDanmakuReply(room, mid, uname, text)
  return eligible
}

/** 临时 join 房间自动退出（直播间下播等场景），并进消息缓冲通知智能体（post_type=live_event） */
function autoLeaveRoom(room, reason) {
  if (!room || room.leaveRequested) return
  logger?.info?.('[mira_bilibili] 临时直播间自动退出 roomid=' + room.realRoomId + '（' + reason + '）')
  disconnectLiveRoom(room.realRoomId)
  runtime.push({
    post_type: 'live_event',
    kind: 'live_event',
    event: 'auto_leave',
    room_id: room.realRoomId,
    room_title: room.title || '',
    reason,
  })
}

/* ── 弹幕接收：HTTP 轮询 ───────────────────────────────────── */

async function pollDanmakuOnce(room) {
  if (room.leaveRequested) return
  try {
    const list = await fetchDanmakuHistory(room.realRoomId)
    const firstPoll = !room.firstPollDone
    let newCount = 0
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      const id = m && m.id_str
      if (!id) continue
      if (room.seenIds.has(id)) continue
      room.seenIds.add(id)
      if (room.seenIds.size > 2000) {
        const it = room.seenIds.values()
        for (let k = 0; k < 1000; k++) room.seenIds.delete(it.next().value)
      }
      // 首次轮询静默：只灌 seenIds 去重，不处理历史缓存弹幕（避免 join 时旧弹幕触发自动应答/刷缓冲）
      if (firstPoll) continue
      handleHistoryDanmaku(room, m)
      newCount++
    }
    room.firstPollDone = true
    room.status = 'polling'
    room.retryCount = 0
    room.lastPollAt = Date.now()
    // 临时 join 房间的下播检测：连续 5 次轮询（约 15 秒）无「新弹幕」→ 用 room_init 查直播状态
    if (room.joined) {
      if (newCount === 0 && !firstPoll) {
        room.idlePolls++
        if (room.idlePolls >= 5) {
          room.idlePolls = 0
          try {
            const st = await fetchLiveStatus(room.realRoomId)
            room.liveStatus = st.live_status
            if ((st.live_status ?? 1) === 0) {
              autoLeaveRoom(room, '直播间已下播')
              return
            }
          } catch { /* 查不到状态时继续监听 */ }
        }
      } else {
        room.idlePolls = 0
      }
    }
    // 每 20 轮（约 1 分钟）用 room_init 刷新直播状态显示
    if (room.pollCount % 20 === 19) {
      fetchLiveStatus(room.realRoomId).then((st) => {
        if (!room.leaveRequested) room.liveStatus = st.live_status
      }).catch(() => {})
    }
    // 轮询模式下每约 10 分钟（≈200 次 × 3s）尝试切回 WS 主通道
    room.pollCount++
    if (room.pollCount >= 200) {
      room.pollCount = 0
      stopRoomPolling(room)
      room.mode = 'ws'
      room.retryCount = 0
      logger?.info?.('[mira_bilibili] 重试弹幕 WS 主通道 roomid=' + room.realRoomId)
      openLiveWs(room).catch(() => {})
    }
  } catch (e) {
    // 降级轮询撞预算：**不能每 3 秒重试**（1200 次/时正好等于默认读预算，会把私信轮询饿死）。
    // 停掉本房间 interval 并尝试切回 WS 主通道；被挡住的入站计数在 bili_status.danmaku 可见（评审 P1-4）
    if (e && typeof e.code === 'string' && e.code.startsWith('budget/')) {
      room.status = 'budget-blocked'
      room.budgetBlockedAt = Date.now()
      runtime.counters.bump('live.budgetBlocked')
      runtime.noteError(e.code, '弹幕降级轮询被预算挡住（roomid=' + room.realRoomId + '），停止轮询并尝试切回 WS')
      logger?.warn?.('[mira_bilibili] 弹幕降级轮询被预算挡住（roomid=' + room.realRoomId + '）：' + (e.message || e.code)
        + '；停止 3s 轮询，尝试切回 WS 主通道')
      stopRoomPolling(room)
      room.mode = 'ws'
      room.retryCount = 0
      if (liveRooms.has(roomKey(room.realRoomId))) {
        try { openLiveWs(room).catch(() => {}) } catch { /* noop */ }
      }
      return
    }
    room.status = 'disconnected'
    room.retryCount++
    runtime.noteError('live/poll', '弹幕轮询失败（roomid=' + room.realRoomId + '）：' + (e && e.message ? e.message : String(e)))
  }
}

function startRoomPolling(room) {
  stopRoomPolling(room)
  const interval = (cfg.danmaku && cfg.danmaku.pollIntervalMs) || 3000
  room.status = 'connecting'
  pollDanmakuOnce(room)
  room.pollTimer = setInterval(() => {
    pollDanmakuOnce(room).catch(() => {})
  }, interval)
  room.pollTimer.unref?.()
}

function stopRoomPolling(room) {
  if (room.pollTimer) {
    clearInterval(room.pollTimer)
    room.pollTimer = null
  }
}

/* ── 弹幕包编解码（B 站直播弹幕 WebSocket 协议，参考 bilibili-API-collect） ── */
// 包结构：4B 总长 + 2B 头长 + 2B protover + 4B op + 4B seq + body

export function encodeDanmakuPacket(op, body, protover = 1) {
  const raw = Buffer.from(String(body), 'utf8')
  const buf = Buffer.alloc(16 + raw.length)
  buf.writeUInt32BE(16 + raw.length, 0)
  buf.writeUInt16BE(16, 4)
  buf.writeUInt16BE(protover, 6)
  buf.writeUInt32BE(op, 8)
  buf.writeUInt32BE(1, 12)
  raw.copy(buf, 16)
  return buf
}

export function decodeDanmakuPackets(buf) {
  const out = []
  let offset = 0
  while (offset + 16 <= buf.length) {
    const packetLen = buf.readUInt32BE(offset)
    if (packetLen < 16 || offset + packetLen > buf.length) break
    out.push({
      packetLen,
      protover: buf.readUInt16BE(offset + 6),
      op: buf.readUInt32BE(offset + 8),
      body: buf.subarray(offset + 16, offset + packetLen),
    })
    offset += packetLen
  }
  return out
}

/** 把单个业务包解析成 JSON 数组（protover 2=zlib / 3=brotli 压缩，0/1=明文可能多包拼接） */
export function parseDanmakuPacket(packet) {
  let raw = packet.body
  if (packet.protover === 2) {
    try { raw = inflateSync(raw) } catch { return [] }
  } else if (packet.protover === 3) {
    try { raw = brotliDecompressSync(raw) } catch { return [] }
  }
  const subs = decodeDanmakuPackets(raw)
  const bodies = subs.length ? subs.map((s) => s.body) : [raw]
  const out = []
  for (const b of bodies) {
    try { out.push(JSON.parse(b.toString('utf8'))) } catch { /* 忽略非 JSON 包 */ }
  }
  return out
}

/* ── 弹幕接收：WS 主通道 ───────────────────────────────────── */

/** 处理 WS 收到的弹幕（DANMU_MSG 的 info 结构） */
export function handleWsDanmaku(room, body) {
  requireConfigured()
  const info = body && body.info
  if (!Array.isArray(info)) return false
  const text = String((info[1] || '')).trim()
  if (!text) return false
  const mid = info[2] && info[2][0]
  const uname = String((info[2] && info[2][1]) || '').trim() || '未知用户'
  // 脱敏检测：游客视角时 mid=0 且昵称打码；降级轮询拿完整数据
  if (room.mode === 'ws' && (!mid || Number(mid) === 0 || uname.includes('*') || uname.includes('…'))) {
    logger?.warn?.('[mira_bilibili] 弹幕数据脱敏（roomid=' + room.realRoomId + ' mid=' + mid + ' uname=' + uname + '），降级 gethistory 轮询')
    switchToPolling(room)
    return false
  }
  if (String(mid) === String(api.getSelfMid())) return false // 不处理自己的弹幕
  runtime.push({
    post_type: 'danmaku',
    kind: 'danmaku',
    room_id: room.realRoomId,
    room_title: room.title || '',
    anchor: room.uname || '',
    mid: mid ?? 0,
    uname,
    text,
  })
  const eligible = roomAutoReply(room)
  markDanmakuVerdict(room, eligible)
  if (eligible) agent.enqueueDanmakuReply(room, mid ?? 0, uname, text)
  return eligible
}

function onLivePacket(room, packet) {
  const bodies = parseDanmakuPacket(packet)
  for (const b of bodies) {
    if (!b || typeof b !== 'object') continue
    if (b.cmd === 'DANMU_MSG') handleWsDanmaku(room, b)
    else if (b.cmd === 'LIVE') room.liveStatus = 1
    else if (b.cmd === 'PREPARING') {
      room.liveStatus = 0
      // 临时 join 的房间：主播下播后自动退出（等效调用 bili_live_leave）
      if (room.joined && !room.leaveRequested) autoLeaveRoom(room, '主播下播（PREPARING）')
    }
    // 其他事件（礼物/进场/SC 等）暂不处理
  }
}

function scheduleLiveReconnect(room) {
  if (room.leaveRequested || room.mode !== 'ws') return
  const dm = cfg.danmaku || {}
  const delay = Math.min(dm.reconnectMaxMs || 300000, (dm.reconnectMinMs || 5000) * Math.pow(2, Math.min(room.retryCount, 6)))
  room.retryCount++
  room.status = 'reconnecting'
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer)
  room.reconnectTimer = setTimeout(() => {
    openLiveWs(room).catch(() => {})
  }, delay)
  room.reconnectTimer.unref?.()
}

/** 降级到 gethistory 轮询（WS 连续被踢 / 数据脱敏时）；轮询约 10 分钟后自动重试 WS */
function switchToPolling(room) {
  if (room.leaveRequested || room.mode === 'poll') return
  room.mode = 'poll'
  room.status = 'polling'
  room.pollCount = 0
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer)
  if (room.heartbeatTimer) clearInterval(room.heartbeatTimer)
  room.ws = null
  startRoomPolling(room)
  logger?.warn?.('[mira_bilibili] 弹幕降级轮询模式 roomid=' + room.realRoomId)
}

async function openLiveWs(room) {
  if (room.leaveRequested || room.mode !== 'ws') return
  room.status = 'connecting'
  let info, buvid
  try {
    info = await liveDanmuInfo(room.realRoomId)
  } catch (e) {
    runtime.noteError('live/ws', '弹幕入口信息获取失败（roomid=' + room.realRoomId + '）：' + (e && e.message ? e.message : String(e)))
    room.status = 'disconnected'
    scheduleLiveReconnect(room)
    return
  }
  try { buvid = await getBuvidB3() } catch { buvid = '' }
  if (typeof WebSocket === 'undefined') {
    logger?.warn?.('[mira_bilibili] 运行环境没有全局 WebSocket，直播间弹幕改用 gethistory 轮询')
    switchToPolling(room)
    return
  }
  const url = 'wss://' + info.host + ':' + info.wssPort + '/sub'
  let ws
  try {
    ws = new WebSocket(url)
  } catch (e) {
    runtime.noteError('live/ws', '弹幕 WS 创建失败（roomid=' + room.realRoomId + '）：' + (e && e.message ? e.message : String(e)))
    room.status = 'disconnected'
    scheduleLiveReconnect(room)
    return
  }
  room.ws = ws
  ws.binaryType = 'arraybuffer'
  let closed = false
  const doClose = (why) => {
    if (closed) return
    closed = true
    const aliveMs = room.openAt ? Date.now() - room.openAt : -1
    if (room.openAt && aliveMs < 5000 && room.authOk !== true) {
      room.shortLived++
      if (room.shortLived >= 3) {
        room.shortLived = 0
        logger?.warn?.('[mira_bilibili] 弹幕 WS 连续 3 次被踢（roomid=' + room.realRoomId + '），降级 gethistory 轮询')
        if (room.heartbeatTimer) clearInterval(room.heartbeatTimer)
        room.ws = null
        try { ws.close() } catch { /* 忽略 */ }
        switchToPolling(room)
        return
      }
    }
    if (room.heartbeatTimer) clearInterval(room.heartbeatTimer)
    room.ws = null
    try { ws.close() } catch { /* 忽略 */ }
    if (room.leaveRequested || room.mode !== 'ws') return
    logger?.warn?.('[mira_bilibili] 弹幕连接断开 roomid=' + room.realRoomId + '（' + why + '），将重连')
    scheduleLiveReconnect(room)
  }
  ws.onopen = () => {
    if (room.leaveRequested || room.mode !== 'ws') {
      try { ws.close() } catch { /* 忽略 */ }
      return
    }
    room.status = 'connected'
    room.retryCount = 0
    room.openAt = Date.now()
    room.authOk = false
    if (room.heartbeatTimer) clearInterval(room.heartbeatTimer)
    room.heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) {
        try { ws.send(encodeDanmakuPacket(2, '[object Object]')) } catch { /* 忽略 */ }
      }
    }, 30000)
    room.heartbeatTimer.unref?.()
    const auth = {
      uid: Number(api.getSelfMid()) || 0,
      roomid: Number(room.realRoomId),
      protover: 2,
      platform: 'web',
      clientver: '1.14.3',
      type: 2,
      key: info.token,
      buvid,
    }
    setTimeout(() => {
      try { ws.send(encodeDanmakuPacket(7, JSON.stringify(auth))) } catch { /* 忽略 */ }
    }, 100)
    logger?.info?.('[mira_bilibili] 直播间弹幕 WS 已连接 roomid=' + room.realRoomId + (room.whitelisted ? '（白名单常驻）' : '（临时）'))
  }
  ws.onmessage = (ev) => {
    try {
      const buf = Buffer.from(ev.data)
      for (const p of decodeDanmakuPackets(buf)) {
        if (p.op === 8) {
          try {
            const r = JSON.parse(p.body.toString('utf8'))
            room.authOk = !!(r && r.code === 0)
            if (!room.authOk) {
              runtime.noteError('live/ws', '弹幕认证失败（roomid=' + room.realRoomId + '）：' + p.body.toString('utf8'))
            }
          } catch { /* 忽略 */ }
          continue
        }
        if (p.op === 3) continue // 心跳回复（人气值）
        if (p.op !== 5) continue
        onLivePacket(room, p)
      }
    } catch (e) {
      logger?.warn?.('[mira_bilibili] 弹幕包解析失败：' + (e && e.message ? e.message : String(e)))
    }
  }
  ws.onclose = () => doClose('close')
  ws.onerror = () => {
    setTimeout(() => doClose('error'), 3000)
  }
}

/* ── 房间连接管理 ───────────────────────────────────────────── */

export async function connectLiveRoom(realRoomId, opts) {
  requireConfigured()
  const key = roomKey(realRoomId)
  const existing = liveRooms.get(key)
  if (existing && !existing.leaveRequested) return existing
  // 房间信息仅用于展示；-352 风控等失败时降级为空值，不阻塞弹幕连接
  let info = { short_id: undefined, title: '', uname: '', live_status: 0 }
  try { info = await liveRoomInfo(realRoomId) } catch { /* 降级 */ }
  let liveStatus = info.live_status ?? 0
  if (liveStatus === 0) {
    try { liveStatus = (await fetchLiveStatus(realRoomId)).live_status } catch { /* 保持 0 */ }
  }
  const room = {
    realRoomId: Number(realRoomId),
    shortId: info.short_id,
    whitelisted: !!(opts && opts.whitelisted),
    joined: !!(opts && opts.joined),
    createdAt: Date.now(),
    title: info.title || '',
    uname: info.uname || '',
    liveStatus,
    mode: 'ws',
    status: 'connecting',
    ws: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    pollTimer: null,
    seenIds: new Set(),
    retryCount: 0,
    leaveRequested: false,
    openAt: 0,
    shortLived: 0,
    authOk: false,
    lastPollAt: 0,
    pollCount: 0,
    idlePolls: 0,
    firstPollDone: false,
    queue: [],
    lastReplyAt: 0,
    busy: false,
    ignoredCount: 0,
    autoReplied: 0,
  }
  liveRooms.set(key, room)
  openLiveWs(room)
  return room
}

/** 断开直播间（临时房间退出用；白名单房间不允许调用） */
export function disconnectLiveRoom(realRoomId) {
  const room = liveRooms.get(roomKey(realRoomId))
  if (!room) return false
  room.leaveRequested = true
  room.queue = [] // 丢弃未处理的弹幕批
  stopRoomPolling(room)
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer)
  if (room.heartbeatTimer) clearInterval(room.heartbeatTimer)
  try { room.ws && room.ws.close() } catch { /* 忽略 */ }
  liveRooms.delete(roomKey(realRoomId))
  // 取消该房间还没到点的弹幕合并批（合并窗口在 agent.js）
  try { agent.cancelDanmakuReply(realRoomId) } catch { /* 退场不抛 */ }
  return true
}

export function disconnectAllLiveRooms() {
  for (const key of [...liveRooms.keys()]) disconnectLiveRoom(key)
}

export function disposeLive() {
  disconnectAllLiveRooms()
  stopAllLiveTasks()
}

/** 白名单直播间：插件启动后常驻监听（任务书功能点5） */
export async function connectWhitelistRooms() {
  requireConfigured()
  const dm = cfg.danmaku || {}
  if (!dm.enabled) return []
  const connected = []
  for (const rid of (dm.rooms || [])) {
    if (rid === undefined || rid === null || rid === '') continue
    try {
      const init = await liveRoomInit(rid)
      if (!liveRooms.has(roomKey(init.room_id))) {
        const room = await connectLiveRoom(init.room_id, { whitelisted: true })
        connected.push(room.realRoomId)
      }
    } catch (e) {
      runtime.noteError('live/connect', '白名单直播间 ' + rid + ' 连接失败：' + (e && e.message ? e.message : String(e)))
      logger?.warn?.('[mira_bilibili] 白名单直播间 ' + rid + ' 连接失败：' + (e && e.message ? e.message : String(e)))
    }
  }
  return connected
}

/** 工具 bili_live_join：临时进入（白名单房间不允许临时进出） */
export async function joinLiveRoom(roomid) {
  const init = await liveRoomInit(roomid)
  if (isWhitelistedRoom(init.room_id)) {
    throw new MiraError('live/whitelisted',
      '该直播间在 danmaku.rooms 白名单中，插件已常驻监听，不能临时进入',
      '白名单房间由配置管理：改 danmaku.rooms 后重载插件')
  }
  const room = await connectLiveRoom(init.room_id, { whitelisted: false, joined: true })
  return room
}

/** 工具 bili_live_leave：临时退出（白名单房间不允许退出） */
export async function leaveLiveRoom(roomid) {
  const init = await liveRoomInit(roomid)
  if (isWhitelistedRoom(init.room_id)) {
    throw new MiraError('live/whitelisted',
      '该直播间在 danmaku.rooms 白名单中（常驻监听），不能退出',
      '白名单房间由配置管理：改 danmaku.rooms 后重载插件')
  }
  return disconnectLiveRoom(init.room_id)
}

/* ── 观测（约定5 / 功能点7） ───────────────────────────────── */

export function roomsView() {
  const rooms = []
  for (const [key, room] of liveRooms) {
    rooms.push({
      roomid: key,
      shortId: room.shortId,
      whitelisted: room.whitelisted,
      joined: !!room.joined,
      createdAt: room.createdAt || 0,
      createdAtText: room.createdAt ? new Date(room.createdAt).toLocaleString('zh-CN', { hour12: false }) : '',
      title: room.title,
      anchor: room.uname,
      liveStatus: room.liveStatus,
      status: room.status,
      mode: room.mode || '',
      retryCount: room.retryCount,
      autoReply: roomAutoReply(room),
      queuedReplies: (room.queue || []).length,
      lastReplyAt: room.lastReplyAt || 0,
      ignored: room.ignoredCount || 0,
      autoReplied: room.autoReplied || 0,
    })
  }
  return rooms
}

export function statusView() {
  const dm = (cfg && cfg.danmaku) || {}
  const ar = dm.autoReply || {}
  const counters = runtime ? runtime.counters.snapshot() : {}
  return {
    ok: true,
    enabled: !!dm.enabled,
    whitelist: dm.rooms || [],
    autoReplyEnabled: !!ar.enabled,
    scope: ar.scope || 'whitelist',
    minIntervalMs: ar.minIntervalMs || 0,
    mergeWindowMs: ar.mergeWindowMs || 0,
    // 功能点6「白名单外不自动应答」：被忽略的弹幕不静默丢弃，计数可见
    ignored: counters['danmaku.ignored'] || 0,
    // 被预算挡住的降级轮询次数（>0 说明有房间的入站弹幕被挡过，评审 P1-4）
    budgetBlocked: counters['live.budgetBlocked'] || 0,
    autoReplyQueued: counters['danmaku.autoReplyQueued'] || 0,
    tasks: listLiveTasks(),
    rooms: roomsView(),
  }
}

/** 供测试/内部使用的当前房间表。 */
export function getRooms() {
  return liveRooms
}

/** 自检用（不是 DSH 接口）。 */
export const __testing = {
  pollDanmakuOnce,
  startRoomPolling,
  stopRoomPolling,
  liveTasks,
}

