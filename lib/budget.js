/**
 * mira_bilibili / budget.js —— 读/写 × 小时/天 四个桶 + 412/429 全局暂停退避
 *
 * 任务书功能点4：读/写分别按小时与天设预算；撞 412/429 全局暂停并退避；
 * **预算值不许被单次调用绕过**。落地方式：
 *   · 所有 HTTP 出口（包括 `bili_api` 逃生舱、轮询、登录自检）都经过 `api.biliFetch`，
 *     而 `biliFetch` 的第一行就是 `budget.take(bucket)` —— 只有一道闸，没有第二条路。
 *   · 被拒时**不发请求**（闸门在前，fetch 在后）。
 *   · 配置里把预算填 0/负数不会变成「不限」，会回落到默认值（见 config.normalizeBudget）。
 *   · 没有「重置预算」「跳过预算」的工具 —— 想放宽只能改配置后重载（有记录、可审计）。
 *
 * 计数口径：滑动窗口。小时桶 = 最近 3600s 内的调用数，天桶 = 最近 24h 内的调用数
 * （不是按自然整点清零，避免「59 分打满、00 分再打满」的双倍峰值）。
 * 内存里滚动；进程正常退出时落盘一次，重启接着用（不让重启把配额清零）。
 *
 * 412/429：全局 pauseUntil 前进，连续撞墙按 2 倍退避（上限 riskPauseMaxMs）。
 * 暂停期内**所有**调用直接拒绝且不发请求。
 */

import { MiraError, fmtLocalHHMM, nowIso, readJson, writeJsonAtomic } from './kit.mjs'
import { BUDGET_DEFAULTS } from './config.js'

export const BUDGET_SCHEMA = 1

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function toMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function pruneBefore(marks, cutoff) {
  let drop = 0
  while (drop < marks.length && marks[drop] <= cutoff) drop++
  if (drop > 0) marks.splice(0, drop)
  return marks
}

function countAfter(marks, cutoff) {
  let count = 0
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i] > cutoff) count++
    else break
  }
  return count
}

export class Budget {
  /**
   * @param {object} options
   * @param {object} [options.limits]     已归一过的预算（config.budget）
   * @param {object} [options.logger]
   * @param {string} [options.stateFile]  `$DSH_HOME/mira_config/mira_bilibili/budget.json`
   * @param {() => number} [options.now]  注入时钟（自检用）
   */
  constructor({ limits = {}, logger = null, stateFile = '', now = () => Date.now() } = {}) {
    this.limits = { ...BUDGET_DEFAULTS, ...(limits || {}) }
    this.logger = logger
    this.stateFile = stateFile
    this.now = typeof now === 'function' ? now : () => Date.now()
    /** @type {{read:number[], write:number[]}} */
    this.marks = { read: [], write: [] }
    this.pauseUntil = 0
    this.riskCount = 0
    this.lastRisk = null
    this.lastRiskAt = 0
    /** kind -> { hour, day } 最近一次成功取用的余量（status 用；避免每次重算时语义漂移） */
    this.counters = { rejected: 0, paused: 0, risk: 0 }
    this.load()
  }

  /* ── 落盘（只存暂停与配额，不存任何凭据） ─────────────── */

  load() {
    if (!this.stateFile) return this
    const raw = readJson(this.stateFile, null)
    if (!raw || raw.schemaVersion !== BUDGET_SCHEMA) return this
    this.pauseUntil = Math.max(0, Number(raw.pauseUntil) || 0)
    this.riskCount = Math.max(0, Number(raw.riskCount) || 0)
    this.lastRisk = raw.lastRisk ?? null
    this.lastRiskAt = Math.max(0, Number(raw.lastRiskAt) || 0)
    for (const kind of ['read', 'write']) {
      const rows = Array.isArray(raw.marks?.[kind]) ? raw.marks[kind] : []
      this.marks[kind] = rows.map(toMs).filter((n) => n > 0).sort((a, b) => a - b)
    }
    this.#prune(this.now())
    // 过期的暂停不再生效，但保留 riskCount 让「连撞」的退避有意义
    if (this.pauseUntil && this.pauseUntil <= this.now()) this.pauseUntil = 0
    return this
  }

  save() {
    if (!this.stateFile) return false
    const now = this.now()
    this.#prune(now)
    return writeJsonAtomic(this.stateFile, {
      schemaVersion: BUDGET_SCHEMA,
      updatedAt: nowIso(now),
      pauseUntil: this.pauseUntil,
      riskCount: this.riskCount,
      lastRisk: this.lastRisk,
      lastRiskAt: this.lastRiskAt,
      marks: { read: this.marks.read, write: this.marks.write },
    })
  }

  /* ── 闸门 ─────────────────────────────────────────────── */

  /**
   * 取一次配额。被拒时抛 MiraError（预算/暂停），**不消耗配额、不发请求**。
   * @param {'read'|'write'} kind
   */
  take(kind) {
    const bucket = kind === 'write' ? 'write' : 'read'
    const now = this.now()

    if (now < this.pauseUntil) {
      this.counters.paused++
      throw new MiraError(
        'budget/paused',
        'B 站风控暂停中（' + (this.lastRisk ? 'HTTP ' + this.lastRisk : '412/429') + '），'
          + Math.max(1, Math.ceil((this.pauseUntil - now) / 1000)) + ' 秒后恢复',
        '暂停到 ' + this.#fmt(this.pauseUntil) + '；暂停期内所有调用直接拒绝且不发请求（含 bili_api）。'
          + '连续撞墙会按 2 倍退避，别硬试',
      )
    }

    this.#prune(now)
    const marks = this.marks[bucket]
    const hourLimit = bucket === 'read' ? this.limits.readPerHour : this.limits.writePerHour
    const dayLimit = bucket === 'read' ? this.limits.readPerDay : this.limits.writePerDay
    const hourCount = countAfter(marks, now - HOUR_MS)
    const dayCount = marks.length

    if (hourCount >= hourLimit) {
      this.counters.rejected++
      const resetAt = marks.length ? marks[Math.max(0, marks.length - hourLimit)] + HOUR_MS : now + HOUR_MS
      throw new MiraError(
        'budget/exceeded',
        (bucket === 'read' ? '读' : '写') + '预算用尽：本小时已 ' + hourCount + '/' + hourLimit + ' 次',
        '等 ' + fmtLocalHHMM(resetAt) + ' 或改 budget（预算写在插件里，单次调用无法绕过——bili_api 也一样）',
      )
    }
    if (dayCount >= dayLimit) {
      this.counters.rejected++
      const resetAt = marks.length ? marks[marks.length - dayLimit] + DAY_MS : now + DAY_MS
      throw new MiraError(
        'budget/exceeded',
        (bucket === 'read' ? '读' : '写') + '预算用尽：本天已 ' + dayCount + '/' + dayLimit + ' 次',
        '等 ' + fmtLocalHHMM(resetAt) + ' 或改 budget（预算写在插件里，单次调用无法绕过——bili_api 也一样）',
      )
    }

    marks.push(now)
    return { ok: true, remaining: this.remaining(bucket) }
  }

  /** 撞 412/429：全局暂停 + 退避。返回新的 pauseUntil（epoch ms）。 */
  noteRisk(statusCode) {
    const now = this.now()
    this.riskCount++
    this.counters.risk++
    const factor = Math.pow(2, Math.min(this.riskCount - 1, 6))
    const pauseMs = Math.min(this.limits.riskPauseMaxMs, this.limits.riskPauseMs * factor)
    this.pauseUntil = Math.max(this.pauseUntil, now + pauseMs)
    this.lastRisk = statusCode === undefined || statusCode === null ? null : String(statusCode)
    this.lastRiskAt = now
    this.save()
    this.logger?.warn?.('[mira_bilibili] 撞到风控 HTTP ' + this.lastRisk + '，全局暂停到 '
      + this.#fmt(this.pauseUntil) + '（第 ' + this.riskCount + ' 次，退避 ' + Math.round(pauseMs / 1000) + 's）')
    return this.pauseUntil
  }

  /** 一次成功调用：暂停期已过则清掉「连续撞墙」计数（下次回到基础暂停时长）。 */
  noteSuccess() {
    if (this.riskCount > 0 && this.now() >= this.pauseUntil) {
      this.riskCount = 0
      this.pauseUntil = 0
    }
  }

  /* ── 观测 ─────────────────────────────────────────────── */

  remaining(kind) {
    const bucket = kind === 'write' ? 'write' : 'read'
    const now = this.now()
    this.#prune(now)
    const marks = this.marks[bucket]
    const hourLimit = bucket === 'read' ? this.limits.readPerHour : this.limits.writePerHour
    const dayLimit = bucket === 'read' ? this.limits.readPerDay : this.limits.writePerDay
    const hourUsed = countAfter(marks, now - HOUR_MS)
    const dayUsed = marks.length
    const hourResetAt = hourUsed > 0 ? marks[Math.max(0, marks.length - hourUsed)] + HOUR_MS : now
    const dayResetAt = dayUsed > 0 ? marks[Math.max(0, marks.length - dayUsed)] + DAY_MS : now
    return {
      hour: Math.max(0, hourLimit - hourUsed),
      day: Math.max(0, dayLimit - dayUsed),
      hourResetAt: fmtLocalHHMM(hourResetAt),
      dayResetAt: fmtLocalHHMM(dayResetAt),
    }
  }

  status() {
    const now = this.now()
    this.#prune(now)
    const paused = now < this.pauseUntil
    return {
      limits: { ...this.limits },
      used: {
        readHour: countAfter(this.marks.read, now - HOUR_MS),
        readDay: this.marks.read.length,
        writeHour: countAfter(this.marks.write, now - HOUR_MS),
        writeDay: this.marks.write.length,
      },
      remaining: {
        read: this.remaining('read'),
        write: this.remaining('write'),
      },
      paused,
      pauseUntil: this.pauseUntil || null,
      pauseUntilIso: this.pauseUntil ? nowIso(this.pauseUntil) : null,
      pauseUntilText: this.pauseUntil ? this.#fmt(this.pauseUntil) : null,
      pauseRemainSec: paused ? Math.ceil((this.pauseUntil - now) / 1000) : 0,
      riskCount: this.riskCount,
      lastRisk: this.lastRisk,
      lastRiskAt: this.lastRiskAt ? nowIso(this.lastRiskAt) : null,
      rejected: this.counters.rejected,
      pausedRejects: this.counters.paused,
      stateFile: this.stateFile || null,
      note: '四个桶都写在插件里；所有出口（含 bili_api）走同一道闸，被拒时不发请求',
    }
  }

  /* ── 内部 ─────────────────────────────────────────────── */

  #prune(now) {
    pruneBefore(this.marks.read, now - DAY_MS)
    pruneBefore(this.marks.write, now - DAY_MS)
    // 兜底：日上限被手工改大后数组也不能无限长（正常不会触发）
    const cap = Math.max(this.limits.readPerDay, this.limits.writePerDay) * 2
    if (this.marks.read.length > cap) this.marks.read.splice(0, this.marks.read.length - cap)
    if (this.marks.write.length > cap) this.marks.write.splice(0, this.marks.write.length - cap)
  }

  #fmt(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  }
}

/** 供自检/工具用的四桶快照（不 new Budget 也能拿到口径说明）。 */
export function budgetDefaults() {
  return { ...BUDGET_DEFAULTS }
}
