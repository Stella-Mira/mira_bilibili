/**
 * mira_bilibili / runtime.js —— 进程内共享状态（消息缓冲 / 最后错误 / 计数器 / 配置）
 *
 * 为什么单独一个模块：api / live / agent / tools 都要用到「入站缓冲」和「最后错误」，
 * 谁都不是它的主人。放进任何一个功能模块都会让另外三个反向依赖它，形成坏循环；
 * 抽成 runtime 之后依赖是单向的（runtime ← api ← live ← agent ← tools ← index）。
 *
 * 缓冲语义原样保留旧版：
 *   · seq 以 `Date.now()*1000` 为起点，进程重启后仍递增（agent 记的 since 不会失效）；
 *   · 写满时优先淘汰最旧的弹幕/super_chat，保护私信与 @我（弹幕流量大得多）。
 */

import { makeCounters } from './kit.mjs'

export function createRuntime({ config, logger = null } = {}) {
  const counters = makeCounters()
  counters.pluginName = 'mira_bilibili'
  let configRef = config
  let lastError = null
  let messageSeq = Date.now() * 1000
  /** @type {object[]} */
  const buffer = []

  function push(event) {
    const ev = { ts: Date.now(), ...(event || {}) }
    messageSeq++
    ev.seq = messageSeq
    buffer.push(ev)
    const cap = Math.max(10, Number(configRef?.bufferSize) || 500)
    if (buffer.length <= cap) return ev
    const idx = buffer.findIndex((m) => m.post_type === 'danmaku' || m.post_type === 'super_chat')
    if (idx >= 0) buffer.splice(idx, 1)
    else buffer.splice(0, buffer.length - cap)
    return ev
  }

  function read({ since = 0, limit = 50, types = [] } = {}) {
    const want = Array.isArray(types) ? types.filter(Boolean) : []
    let list = buffer.filter((m) => m.seq > Number(since || 0))
    if (want.length) {
      const allowed = new Set(want)
      list = list.filter((m) => allowed.has(m.post_type))
    }
    list = list.slice(-Math.min(Math.max(1, Number(limit) || 50), 500))
    const maxSeq = list.length ? list[list.length - 1].seq : Number(since || 0)
    return { since: Number(since || 0), maxSeq, count: list.length, totalBuffered: buffer.length, messages: list }
  }

  /** 记一条归一错误：不进凭据、只留 code + message。 */
  function noteError(code, message) {
    const entry = { code: String(code || 'unknown/error'), message: String(message ?? ''), at: new Date().toISOString() }
    lastError = entry
    counters.bump('error.' + entry.code)
    return entry
  }

  function clearError() {
    lastError = null
  }

  function setConfig(next) {
    configRef = next
    return configRef
  }

  function status() {
    return {
      bufferSize: buffer.length,
      lastSeq: messageSeq,
      counters: counters.snapshot(),
      lastError,
    }
  }

  return {
    get config() { return configRef },
    logger,
    counters,
    push,
    read,
    noteError,
    clearError,
    setConfig,
    status,
    get lastError() { return lastError },
    clear() {
      buffer.length = 0
      lastError = null
    },
  }
}
