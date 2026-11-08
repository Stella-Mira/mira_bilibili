/**
 * mira_bilibili — 入口 / 装配 / 单实例 / 热加载
 *
 * 模块划分（PLAN §1.4）：
 *   config.js   默认值 + schemaVersion + 校验（cookie 不再从 config 读）
 *   budget.js   读/写 × 小时/天 四个桶 + 412/429 全局暂停退避（所有出口共用这一道闸）
 *   api.js      接口层（B 站 REST / 凭据 / 登录自检）
 *   live.js     直播间弹幕 / 录制 / 截图
 *   agent.js    入站路由 + agent 会话装配（私信走 mira_account 绑定）
 *   adapter.js  mira_account 适配器（platform:"bilibili"，含 createSession / send）
 *   tools.js    bili_* 工具
 *   runtime.js  共享进程内状态（消息缓冲 / 最后错误 / 计数器）
 *   kit.mjs     共享小工具（`tool_shared/kit/kit.mjs` 的逐字节副本）
 *
 * 依赖契约：`inject: ['tools','agents','workspaceRegistry','miraAccount']`。
 * mira_account 是**硬依赖**（PLAN §3.5）：缺了本插件不加载、工具全消失 ——
 * 比「起来了但发不出去/回不来」容易排查得多。
 *
 * 只依赖 Node 内置能力（零第三方运行时依赖）。
 */

import { join } from 'node:path'
import { claimInstance, ensureDir, fail, miraConfigDir } from './kit.mjs'
import { CONFIG_SCHEMA, DEFAULTS, loadConfig, requireAccountId } from './config.js'
import { Budget } from './budget.js'
import { createRuntime } from './runtime.js'
import * as api from './api.js'
import * as live from './live.js'
import * as agent from './agent.js'
import { createAdapter } from './adapter.js'
import { registerTools, TOOL_NAMES } from './tools.js'

export const name = 'mira_bilibili'

/**
 * 投递/建会话需要宿主能力，路由需要 mira_account：
 * 缺任何一项都不加载（硬依赖，失败显式）。mira_account 是账号池/绑定/去重的唯一真身。
 */
export const inject = ['tools', 'agents', 'workspaceRegistry', 'miraAccount']

const INSTANCE_ID = 'mira_bilibili'

/** 当前实例（自检用；单实例保护保证最多一份）。 */
let current = null

export function apply(ctx, config) {
  const logger = ctx.logger || null

  // ① 配置（schemaVersion / 废弃字段提醒 / 预算归一）
  const loaded = loadConfig(config)
  if (!loaded.ok) {
    logger?.warn?.('[mira_bilibili] 配置不可用（' + loaded.error.code + '）：' + loaded.error.message)
    return loaded
  }
  const cfg = loaded.config
  for (const warning of loaded.warnings) logger?.warn?.('[mira_bilibili] ' + warning)

  if (cfg.enabled === false) {
    logger?.info?.('[mira_bilibili] 已禁用（config.enabled = false），不注册工具、不起轮询')
    return fail('plugin/disabled', 'mira_bilibili 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // ② 单实例（约定6）：两个实例 = 两套轮询 + 两套弹幕连接 + 重复应答
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_bilibili] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '两个实例会各起一套轮询与弹幕连接，同一条私信会被应答两次。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'mira_bilibili 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_bilibili 挂了两遍；一个进程只允许一个实例')
  }

  // claim 之后任何一步抛错都必须归还认领：否则认领永久泄漏，进程内再也装不上（评审 P1-1）
  let claimReleased = false
  const releaseClaim = () => {
    if (claimReleased) return
    claimReleased = true
    try { claim.release() } catch { /* noop */ }
  }

  try {
    // ③ 依赖：mira_account 是账号池/绑定/去重的唯一真身
    const miraAccount = ctx.miraAccount || null
    if (!miraAccount) {
      releaseClaim()
      logger?.warn?.('[mira_bilibili] 缺少 miraAccount 服务：本插件不注册工具（inject 未满足）')
      return fail('platform/unsupported', 'miraAccount 服务不可用（mira_bilibili 需要它做账号/绑定/路由）',
        '先装并启用 mira_account 插件，再重载 DSH；mira_account_status 可自证它在跑')
    }

    const agentsSvc = ctx.agents || null
    const workspaceSvc = ctx.workspaceRegistry || null
    const baseDir = miraConfigDir('mira_bilibili')
    ensureDir(baseDir)

    // ④ 装配
    const runtime = createRuntime({ config: cfg, logger })
    const budget = new Budget({ limits: cfg.budget, logger, stateFile: join(baseDir, 'budget.json') })
    api.configure({ config: cfg, logger, budget, runtime })
    agent.configure({ config: cfg, logger, runtime, miraAccount, agents: agentsSvc, workspaceRegistry: workspaceSvc })
    live.configure({ config: cfg, logger, runtime })
    const adapter = createAdapter({ config: cfg, logger, runtime, budget, miraAccount })

    // ⑤ 注册适配器（同一平台已有实现时 mira_account 会拒绝；不静默，但也不让工具消失）
    let disposeAdapter = () => {}
    let adapterError = null
    try {
      disposeAdapter = miraAccount.registerAdapter(adapter)
    } catch (error) {
      adapterError = { code: error?.code ?? 'platform/duplicate', message: error?.message ?? String(error) }
      runtime.noteError(adapterError.code, '注册 bilibili 适配器失败：' + adapterError.message)
      logger?.warn?.('[mira_bilibili] 注册 bilibili 适配器失败（' + adapterError.code + '）：' + adapterError.message)
    }

    // ⑥ 工具（把装配阶段的告警带进 bili_status.warnings，避免「只进日志」）
    const bootWarnings = [...loaded.warnings.map((message) => ({ code: 'config/warn', message }))]
    if (adapterError) bootWarnings.push({ code: adapterError.code, message: '适配器注册失败：' + adapterError.message })
    const disposeTools = registerTools(ctx, { config: cfg, runtime, budget, miraAccount, baseDir, bootWarnings })

    // ⑦ 启动：读凭据 → 真请求一次 nav 自检 → 起轮询 + 连白名单直播间
    function startup() {
      if (cfg.autoStart === false) {
        logger?.info?.('[mira_bilibili] autoStart=false：不自动登录、不自动起轮询、不自动连白名单直播间（工具照常可用）')
        return
      }
      try {
        requireAccountId(cfg)
      } catch (error) {
        runtime.noteError(error.code ?? 'config/missing', error.message)
        logger?.warn?.('[mira_bilibili] 未配置 accountId：工具可用，但登录/轮询/发送都不会工作')
        return
      }
      const creds = api.loadCredentials(cfg.accountId)
      if (!creds.ok) {
        runtime.noteError(creds.error.code, creds.error.message)
        logger?.warn?.('[mira_bilibili] 凭据不可用（' + creds.error.code + '）：' + creds.error.message)
        return
      }
      api.refreshLogin().then(async () => {
        try { miraAccount.setState(cfg.accountId, 'online', null) } catch { /* 账号可能还没登记 */ }
        logger?.info?.('[mira_bilibili] 登录自检通过：' + String(api.getSelfUname() || '')
          + '(' + String(api.getSelfMid() || '') + ')；读预算余量 '
          + budget.status().remaining.read.hour + '/h，写 ' + budget.status().remaining.write.hour + '/h')
        agent.startPolling()
        agent.pollOnce().catch(() => {})
        await live.connectWhitelistRooms()
      }).catch((error) => {
        const code = error?.code ?? 'creds/invalid'
        runtime.noteError(code, '登录失败：' + (error?.message ?? String(error)))
        try { miraAccount.setState(cfg.accountId, 'error', { code, message: error?.message ?? String(error) }) } catch { /* 账号可能还没登记 */ }
        logger?.warn?.('[mira_bilibili] 登录自检失败（' + code + '）：' + (error?.message ?? String(error)))
      })
    }

    // 卸载：先摘工具 → 退订适配器 → 停轮询/弹幕 → 预算落盘 → 最后放实例认领
    // （约定9：放认领放最后，保证新实例 load 到的永远是最新文件）
    ctx.effect(() => () => {
      try { disposeTools?.() } catch { /* noop */ }
      try { disposeAdapter?.() } catch { /* noop */ }
      try { agent.disposeAgent() } catch { /* noop */ }
      try { live.disposeLive() } catch { /* noop */ }
      try { budget.save() } catch { /* noop */ }
      // 卸载即退登：Cookie 不在内存里留到进程结束（评审 P2-9）
      try { api.clearCredentials() } catch { /* noop */ }
      releaseClaim()
      if (current && current.claim === claim) current = null
    })

    const apiStatus = api.apiStatus()
    logger?.info?.('[mira_bilibili] 已加载：accountId=' + (cfg.accountId || '(未配置)')
      + '，工具 ' + TOOL_NAMES.length + ' 个，预算 读 ' + cfg.budget.readPerHour + ' 次/时 / '
      + cfg.budget.readPerDay + ' 次/天、写 ' + cfg.budget.writePerHour + ' 次/时 / ' + cfg.budget.writePerDay + ' 次/天'
      + '，弹幕 ' + (cfg.danmaku.enabled ? ('开（白名单 ' + cfg.danmaku.rooms.length + ' 间，自动应答 '
        + (cfg.danmaku.autoReply.enabled ? cfg.danmaku.autoReply.scope : '关') + '）') : '关')
      + '，自动应答 ' + (cfg.autoReply.enabled ? ('开（陌生人策略 ' + cfg.autoReply.strangerPolicy + '）') : '关')
      + '，配置目录 ' + baseDir)

    startup()

    current = {
      claim, config: cfg, baseDir, runtime, budget, adapter, adapterError, apiStatus,
      modules: { api, live, agent },
    }

    return { ok: true, baseDir, accountId: cfg.accountId, tools: TOOL_NAMES.length, adapterRegistered: !adapterError }
  } catch (error) {
    releaseClaim()
    throw error
  }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  CONFIG_SCHEMA,
  DEFAULTS,
  TOOL_NAMES,
  loadConfig,
  Budget,
  createRuntime,
  createAdapter,
  getCurrent: () => current,
  configDir: () => miraConfigDir('mira_bilibili'),
}
