/**
 * mira_bilibili / tools.js —— bili_* 工具集
 *
 * 搬运原则：工具名、参数名、描述文案、返回字段尽量保持旧版（模型已经学会怎么用了）。
 * 这一轮只做四类改动：
 *   1. 所有返回值套上约定4 的信封 `{ok:true,...}` / `{ok:false,error:{code,message,hint}}`
 *      （旧版逃生舱/查询类工具直接吐裸 JSON，与其它插件不一致）；
 *   2. 发送类工具走 `miraAccount.send()`（反向绑定，功能点3）；
 *   3. 预算闸统一在 `api.biliFetch` 里 —— 这里**不提供**任何跳过/重置预算的参数；
 *   4. 去掉送礼工具（功能点6 风控纪律「不花钱」；旧版有 4 个 gift 工具，默认也是关的）。
 *
 * 没有、也不会有：三连 / 投币 / 关注 / 群发 / 改资料 的工具。
 */

import { MiraError, textTool } from './kit.mjs'
import { requireAccountId } from './config.js'
import * as api from './api.js'
import * as live from './live.js'
import * as agent from './agent.js'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

/** 当前会话 id：在会话里调用工具时宿主会给 exec.agent。 */
function currentSessionId(exec) {
  const agent = exec && exec.agent
  if (!agent) return ''
  // **优先用活会话的 id**：resume / 克隆 / rekey 之后 `agent.id` 可能还是旧 id（实测：
  // 会话目录是 qq-mvpvzf70-01703d，而 exec.agent.id 报 qq-mvp8dqhy-smrami），拿它去绑定会让
  // taker 指向不存在的会话、每次发送都要 force、回信路由错位。`agent.session.id` 是会话日志的权威 id。
  const live = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  if (live) return live
  return typeof agent.id === 'string' ? agent.id : ''
}

export function registerTools(ctx, deps) {
  const { config, runtime, budget, miraAccount, baseDir, bootWarnings = [] } = deps
  const accountId = () => requireAccountId(config)

  /** 凭据必须就位：没有就抛精确错误（文件缺 / 字段缺 / 版本不符）。 */
  function requireCreds() {
    if (api.hasCredentials()) return
    const id = accountId()
    const result = api.loadCredentials(id)
    if (!result.ok) throw new MiraError(result.error.code, result.error.message, result.error.hint)
  }

  /** 只读状态（功能点7）：登录态 / 预算余量 / 暂停 / 监听房间 / 最后错误。 */
  function statusView() {
    const id = String(config.accountId || '').trim()
    const warnings = []
    let accounts = null
    let bindings = null
    try { accounts = miraAccount.listAccounts() } catch (e) { warnings.push({ code: e.code || 'account/invalid', message: e.message || String(e) }) }
    try { bindings = miraAccount.bindings() } catch (e) { warnings.push({ code: e.code || 'binding/not-found', message: e.message || String(e) }) }
    const mine = (accounts || []).filter((a) => a.platform === 'bilibili')
    const account = mine.find((a) => a.id === id) || null
    const myBindings = (bindings || []).filter((b) => b.accountId === id)
    if (accounts && !account) {
      warnings.push({
        code: 'account/not-found',
        message: 'mira_account/accounts.json 里没有 ' + (id || '(accountId 未配置)') + '（platform:"bilibili"）',
        hint: '先 mira_account_add {id:"' + (id || 'bili-main') + '", platform:"bilibili"}，再把 cookie 手填到 creds/' + (id || 'bili-main') + '.json',
      })
    }
    for (const warning of bootWarnings) {
      warnings.push(typeof warning === 'string' ? { code: 'config/warn', message: warning } : warning)
    }
    const budgetStatus = budget.status()
    return {
      ok: true,
      plugin: { name: 'mira_bilibili', baseDir, processPid: process.pid },
      account: {
        id,
        registered: !!account,
        state: account ? account.state : null,
        enabled: account ? account.enabled : null,
        inboundPolicy: account ? account.inboundPolicy : null,
        adapterRegistered: !!miraAccount.adapterFor('bilibili'),
        accountError: account ? account.error : null,
      },
      login: {
        loggedIn: api.isLoggedIn(),
        mid: api.getSelfMid(),
        uname: api.getSelfUname(),
        ...api.selfStatus(),
      },
      // 只报「有没有 / 字段名 / 权限位」——**绝不回显凭据值**（约定8）
      credentials: api.credentialsStatus(),
      budget: budgetStatus,
      paused: budgetStatus.paused,
      autoReply: agent.statusView(),
      danmaku: live.statusView(),
      bindings: {
        total: myBindings.length,
        taker: myBindings.filter((b) => b.mode === 'taker').length,
        observer: myBindings.filter((b) => b.mode === 'observer').length,
        peers: myBindings.map((b) => ({ sessionId: b.sessionId, kind: b.kind, peerId: b.peerId, mode: b.mode, updatedAt: b.updatedAt })),
      },
      buffer: runtime.status(),
      lastError: runtime.lastError,
      warnings,
    }
  }

  const defs = []

  /* ── 状态 / 登录 ─────────────────────────────────────────── */

  defs.push(textTool(
    'bili_status',
    '查看 B 站接管状态：登录态（mid/昵称）、凭据是否就位（只报字段名与权限，不回显凭据）、'
    + '读/写 × 小时/天 预算余量、412/429 全局暂停状态、监听中的直播间、反向绑定数量、最后错误。'
    + '凭据没手填时返回 creds/missing 并给出文件路径。',
    obj({}),
    async () => {
      requireCreds()
      return statusView()
    },
  ))

  defs.push(textTool(
    'bili_login_check',
    '登录自检：真请求一次 nav 接口验证 Cookie 是否还有效（HttpOnly 的 SESSDATA 只能手抄，会过期）。'
    + '成功返回 {ok:true,mid,uname}；失效返回 creds/invalid 并告诉你去哪个文件重抄。'
    + '这一次 nav 请求也计入读预算。',
    obj({}),
    async () => {
      const nav = await api.refreshLogin()
      return { ok: true, isLogin: true, mid: api.getSelfMid(), uname: api.getSelfUname(), nav: nav && nav.data ? { level_info: nav.data.level_info } : undefined }
    },
  ))

  defs.push(textTool(
    'bili_login_info',
    '获取当前登录账号的原始信息（nav 接口的 data：mid、uname、等级、硬币、大会员等）。',
    obj({}),
    async () => {
      requireCreds()
      const nav = await api.biliFetch('/x/web-interface/nav')
      return { ok: true, data: (nav && nav.data) || null }
    },
  ))

  /* ── 用户 / 视频 / 搜索 ──────────────────────────────────── */

  defs.push(textTool(
    'bili_get_user_info',
    '查询某个 B 站用户的公开信息（昵称、头像、签名等）。mid 为数字用户 ID。'
    + '该接口按账号/IP 限频（连打会报 -799），插件已做节流，请勿高频连打。',
    obj({ mid: int('用户 mid（数字 ID）') }, ['mid']),
    async (args) => ({ ok: true, data: await api.getUserInfo(args.mid) }),
  ))

  defs.push(textTool(
    'bili_get_relation_stat',
    '查询用户的关注/粉丝统计数据（relation/stat 接口，频率限制宽松，随时可用）。vmid 为用户 mid。',
    obj({ vmid: int('用户 mid') }, ['vmid']),
    async (args) => ({ ok: true, data: await api.getRelationStat(args.vmid) }),
  ))

  defs.push(textTool(
    'bili_search_video',
    '搜索 B 站视频。keyword 为关键词；page 页码（从 1 开始）；page_size 每页条数（默认 20，上限 50）。'
    + '返回含 bvid、标题、作者、播放量等。走 wbi 签名接口，已节流（连打会 412）。',
    obj({
      keyword: str('搜索关键词'),
      page: int('页码，默认 1'),
      page_size: int('每页条数，默认 20，上限 50'),
    }, ['keyword']),
    async (args) => ({
      ok: true,
      data: await api.searchVideos(args.keyword, Number(args.page || 1), Math.min(Number(args.page_size || 20), 50)),
    }),
  ))

  defs.push(textTool(
    'bili_get_video_info',
    '获取视频详细信息（标题、简介、UP主、播放/点赞/投币/收藏等数据）。传 bvid（如 BV1xx411c7mD）或纯数字 av 号。',
    obj({ id: str('bvid 或 av 号') }, ['id']),
    async (args) => {
      const r = await api.getVideoInfo(args.id)
      if (!r || Object.keys(r).length === 0) {
        throw new MiraError('video/not-found', '未找到视频：' + args.id, '确认 bvid/av 号正确；接口 code!=0 会先报 api/code')
      }
      return { ok: true, bvid: r.bvid, aid: r.aid, title: r.title, desc: r.desc, owner: r.owner, stat: r.stat }
    },
  ))

  /* ── 私信（收发 / 会话 / 反向绑定） ──────────────────────── */

  defs.push(textTool(
    'bili_send_private_msg',
    '给指定 B 站用户发送私信文本。receiver_id 为用户 mid（数字 ID）。仅文本，不支持图片/表情。'
    + '发出后会把**当前会话**自动登记为该用户的 taker（反向绑定），对方回复会回到这个会话；'
    + '同一用户已有别的会话在应答时报 binding/conflict，要抢加 force:true，只旁听加 observer:true。'
    + '预算（写）不足时直接拒绝且不发请求。',
    obj({
      receiver_id: int('对方用户 mid'),
      text: str('要发送的文本'),
      force: bool('抢走别的会话对这个用户的 taker（原 taker 降级 observer）'),
      observer: bool('只把这层关系登记成旁听（不自动应答）'),
      sessionId: str('发起方会话 id（可选；不给就用当前会话，用于反向绑定）'),
    }, ['receiver_id', 'text']),
    async (args, exec) => {
      const id = accountId()
      const sessionId = String(args.sessionId || '').trim() || currentSessionId(exec)
      if (!sessionId) {
        throw new MiraError('config/missing', '拿不到当前会话 id：无法登记反向绑定',
          '在会话里调用本工具（宿主会给 exec.agent），或显式传 sessionId')
      }
      const result = await miraAccount.send({
        accountId: id,
        kind: 'user',
        peerId: args.receiver_id,
        payload: { text: String(args.text) },
        sessionId,
        force: args.force === true,
        observer: args.observer === true,
      })
      return {
        ok: true,
        receiver_id: args.receiver_id,
        message_id: result && result.messageId !== undefined ? result.messageId : null,
        binding: result ? result.binding ?? null : null,
      }
    },
  ))

  defs.push(textTool(
    'bili_recv_messages',
    '增量拉取自上次以来收到的 B 站消息（私信、@我 通知、直播间弹幕与直播媒体任务结果）。'
    + '传 since 为上次返回的最大 seq，首次传 0；types 为可选过滤：message=私信，at=@我，danmaku=弹幕，'
    + 'live_task=直播媒体任务结果，live_event=直播间事件（如临时房间下播自动退出）（逗号分隔，默认全部）。'
    + '私信可据此用 bili_send_private_msg 应答；@我 消息可结合 bili_reply_comment 回复；'
    + '弹幕可用 bili_live_send_danmaku 回复。',
    obj({
      since: int('上次返回的最大 seq，首次 0'),
      limit: int('最多返回条数，默认 50，上限 500'),
      types: str('可选过滤：message,at,danmaku,live_task,live_event（逗号分隔）'),
    }),
    async (args) => {
      const want = String(args.types || '').split(',').map((s) => s.trim()).filter(Boolean)
      return { ok: true, ...runtime.read({
        since: Number(args.since || 0),
        limit: Number(args.limit || 50),
        types: want,
      }) }
    },
  ))

  defs.push(textTool(
    'bili_get_sessions',
    '获取私信会话列表（含每个会话的未读数、最后消息等）。',
    obj({}),
    async () => {
      const sessions = await api.getSessions()
      return { ok: true, count: sessions.length, sessions }
    },
  ))

  defs.push(textTool(
    'bili_fetch_session_msgs',
    '拉取与某个用户的私信历史。talker_id 为用户 mid；size 为条数（默认 20）。',
    obj({ talker_id: int('用户 mid'), size: int('条数，默认 20') }, ['talker_id']),
    async (args) => {
      const messages = await api.fetchSessionMsgs(args.talker_id, Number(args.size || 20))
      return { ok: true, count: messages.length, messages }
    },
  ))

  /* ── 动态 / 评论 ─────────────────────────────────────────── */

  defs.push(textTool(
    'bili_send_dynamic',
    '发布一条纯文本动态（到当前登录账号的动态页）。写操作，计入写预算。',
    obj({ text: str('动态文本内容') }, ['text']),
    async (args) => {
      const r = await api.createDynamic(args.text)
      return {
        ok: !!(r && r.code === 0),
        code: r && r.code,
        dynamic_id: r && r.data && r.data.dynamic_id,
        message: r && r.message,
      }
    },
  ))

  defs.push(textTool(
    'bili_article_draft',
    '专栏/图文草稿：不传 article_id = 新建草稿，传 article_id = 更新原草稿（不会产生副本）。'
    + '正文按纯文本写，段落用换行分隔；B 站编辑器不认 markdown，表格与 LaTeX 会原样显示，别写。'
    + '写操作，计入写预算。返回 article_id。',
    obj({
      title: str('标题（1–50 字）'),
      text: str('正文纯文本，换行分段'),
      article_id: int('要更新的草稿 id（可选）'),
      summary: str('摘要（可选，默认取正文前 120 字）'),
    }, ['title', 'text']),
    async (args) => {
      const r = await api.saveArticleDraft({
        title: args.title, text: args.text, articleId: args.article_id, summary: args.summary,
      })
      return { ok: !!r.articleId, article_id: r.articleId, updated: !!args.article_id }
    },
  ))

  defs.push(textTool(
    'bili_article_draft_view',
    '读取一篇专栏/图文草稿：标题、正文纯文本、摘要、图片地址。只读，计入读预算。',
    obj({ article_id: int('草稿 id') }, ['article_id']),
    async (args) => {
      const d = await api.getArticleDraft(args.article_id)
      return {
        ok: !!d, article_id: args.article_id,
        title: (d && d.title) || '', summary: (d && d.summary) || '',
        text: (d && d.content) || '', images: (d && d.image_urls) || [],
      }
    },
  ))

  defs.push(textTool(
    'bili_article_draft_delete',
    '删除一篇专栏/图文草稿。写操作，计入写预算。删除不可恢复，调用前先确认这是草稿而不是已发布内容。',
    obj({ article_id: int('草稿 id') }, ['article_id']),
    async (args) => {
      const r = await api.deleteArticleDraft(args.article_id)
      return { ok: r.ok, code: r.code }
    },
  ))

  defs.push(textTool(
    'bili_upload_image',
    '上传一张本地图片到 B 站（创作中心图片床），返回可直接写进动态/专栏正文的图片直链。写操作，计入写预算。'
    + 'biz: draw（动态配图，默认）/ article（专栏）等。',
    obj({ file_path: str('本地图片绝对路径（png/jpg/webp）'), biz: str('业务类型，默认 draw') }, ['file_path']),
    async (args) => {
      const r = await api.uploadImage(args.file_path, { biz: args.biz || 'draw' })
      return { ok: !!r.url, url: r.url, width: r.width, height: r.height }
    },
  ))

  defs.push(textTool(
    'bili_reply_comment',
    '回复一条评论（可用于回复 @我 的评论）。type=1 视频评论（oid 用 av 号）、17 动态评论（oid 用 dynamic_id）、'
    + '11 专栏评论（oid 用 cv 号）等；root 为根评论 rpid（回复楼中楼时填，直接回复根评论可省略）；'
    + 'parent 为父评论 rpid（楼中楼时填）。oid/type 可以从 bili_recv_messages 的 at 消息 item 里解析。',
    obj({
      oid: str('评论区主体 ID：视频=av号，动态=dynamic_id，专栏=cv号'),
      type: int('评论区类型：1=视频，17=动态，11=专栏 等'),
      root: int('根评论 rpid（可选，楼中楼时填）'),
      parent: int('父评论 rpid（可选，楼中楼时填）'),
      message: str('回复内容'),
    }, ['oid', 'type', 'message']),
    async (args) => {
      const r = await api.replyComment(args)
      return { ok: !!(r && r.code === 0), code: r && r.code, rpid: r && r.data && r.data.rpid, message: r && r.message }
    },
  ))

  /* ── 直播间：信息 / 进出 / 状态 / 发言 ─────────────────────── */

  defs.push(textTool(
    'bili_live_info',
    '查询直播间信息：房间号（短号自动转真实房间号）、标题、主播、直播状态等。roomid 传短号或长号均可。',
    obj({ roomid: int('直播间房间号（短号/长号均可）') }, ['roomid']),
    async (args) => {
      const init = await live.liveRoomInit(args.roomid)
      const info = await live.liveRoomInfo(init.room_id)
      return {
        ok: true,
        ...info,
        whitelisted: live.isWhitelistedRoom(init.room_id),
        listening: live.getRooms().has(live.roomKey(init.room_id)),
      }
    },
  ))

  defs.push(textTool(
    'bili_live_join',
    '临时加入直播间：连接该房间的弹幕流，弹幕会进消息缓冲（bili_recv_messages，post_type=danmaku）；'
    + '可以用 bili_live_leave 退出；直播间下播后会自动退出（等效 bili_live_leave）并通过消息缓冲通知（post_type=live_event）。'
    + '白名单（配置 danmaku.rooms）中的直播间插件已常驻监听，不能临时进入。'
    + '是否参与自动应答由 danmaku.autoReply.scope 决定（默认 whitelist，即临时房间只监听不应答）。',
    obj({ roomid: int('直播间房间号（短号/长号均可）') }, ['roomid']),
    async (args) => {
      const room = await live.joinLiveRoom(args.roomid)
      return {
        ok: true,
        roomid: room.realRoomId,
        title: room.title,
        anchor: room.uname,
        liveStatus: room.liveStatus,
        status: room.status,
        autoReply: live.roomAutoReply(room),
        note: '下播自动退出并通知（post_type=live_event）；要它参与自动应答把 autoReply.scope 改成 listened',
      }
    },
  ))

  defs.push(textTool(
    'bili_live_leave',
    '临时退出直播间：断开该房间的弹幕流。白名单（配置 danmaku.rooms）中的直播间为常驻监听，不能退出。',
    obj({ roomid: int('直播间房间号（短号/长号均可）') }, ['roomid']),
    async (args) => {
      const done = await live.leaveLiveRoom(args.roomid)
      return { ok: true, left: done, message: done ? '已退出直播间' : '该直播间未在监听' }
    },
  ))

  defs.push(textTool(
    'bili_live_status',
    '查看直播间弹幕监听状态：白名单、哪些房间白名单常驻/临时、连接状态、自动应答范围与冷却、'
    + '待处理弹幕数、以及被忽略的弹幕计数（白名单外不自动应答，但计数可见）。',
    obj({}),
    async () => live.statusView(),
  ))

  defs.push(textTool(
    'bili_live_send_danmaku',
    '给指定直播间发送弹幕（需要登录）。roomid 为直播间房间号（短号/长号均可，自动转换）；'
    + 'text 为弹幕内容，最长 30 字，超长自动截断。写操作，计入写预算。',
    obj({
      roomid: int('直播间房间号（短号/长号均可）'),
      text: str('弹幕内容（最长 30 字，超长自动截断）'),
    }, ['roomid', 'text']),
    async (args) => {
      const init = await live.liveRoomInit(args.roomid)
      const r = await live.sendDanmaku(init.room_id, args.text)
      return { ok: r.ok, code: r.code, message: r.message, roomid: init.room_id, sent: r.sent, truncated: r.truncated }
    },
  ))

  /* ── 直播间：截图 / 录音 / 录视频 / 录播 ──────────────────── */

  defs.push(textTool(
    'bili_live_screenshot',
    '截取直播间当前画面一帧（即时，同步等待完成）。roomid 为直播间房间号（短号/长号均可）；'
    + 'save_path 可选，留空自动保存到媒体目录。返回截图文件路径。',
    obj({
      roomid: int('直播间房间号（短号/长号均可）'),
      save_path: str('保存路径（可选，留空自动生成到媒体目录）'),
    }, ['roomid']),
    async (args) => {
      const init = await live.liveRoomInit(args.roomid)
      const r = await live.screenshotLiveRoom(init.room_id, args.save_path)
      if (!r.ok) {
        throw new MiraError('live/ffmpeg', '截图失败：' + (r.error || ('ffmpeg 退出码 ' + r.code)),
          '房间可能未开播或流被风控；先 bili_live_info 看 live_status，或稍后重试')
      }
      return { ok: true, roomid: init.room_id, file: r.file, code: r.code }
    },
  ))

  defs.push(textTool(
    'bili_live_record_audio',
    '录制直播间一段音频（异步）：调用后立即返回 task_id，录制完成后通过消息缓冲通知智能体'
    + '（bili_recv_messages 拉取 post_type=live_task 的记录）。duration_sec 默认 30、上限 600；'
    + 'save_path 可选，留空自动保存到媒体目录（.m4a）。',
    obj({
      roomid: int('直播间房间号（短号/长号均可）'),
      duration_sec: int('录制时长（秒，默认 30，上限 600）'),
      save_path: str('保存路径（可选，留空自动生成到媒体目录）'),
    }, ['roomid']),
    async (args) => {
      const init = await live.liveRoomInit(args.roomid)
      const task = await live.recordAudio(init.room_id, args.duration_sec, args.save_path)
      if (!task.proc) throw new MiraError('live/ffmpeg', '启动录音失败：' + (task.err || 'ffmpeg 未启动'), '看宿主日志；确认 PATH 里有 ffmpeg 或配 danmaku.ffmpegPath')
      return {
        ok: true, task_id: task.id, kind: task.kind, duration_sec: task.durSec, file: task.file, status: task.status,
        note: '录制完成后通过 bili_recv_messages（post_type=live_task）通知',
      }
    },
  ))

  defs.push(textTool(
    'bili_live_record_video',
    '录制直播间一段视频（异步）：调用后立即返回 task_id，录制完成后通过消息缓冲通知智能体'
    + '（bili_recv_messages 拉取 post_type=live_task 的记录）。duration_sec 默认 30、上限 600；'
    + 'save_path 可选，留空自动保存到媒体目录（.mp4）。',
    obj({
      roomid: int('直播间房间号（短号/长号均可）'),
      duration_sec: int('录制时长（秒，默认 30，上限 600）'),
      save_path: str('保存路径（可选，留空自动生成到媒体目录）'),
    }, ['roomid']),
    async (args) => {
      const init = await live.liveRoomInit(args.roomid)
      const task = await live.recordVideo(init.room_id, args.duration_sec, args.save_path)
      if (!task.proc) throw new MiraError('live/ffmpeg', '启动录视频失败：' + (task.err || 'ffmpeg 未启动'), '看宿主日志；确认 PATH 里有 ffmpeg 或配 danmaku.ffmpegPath')
      return {
        ok: true, task_id: task.id, kind: task.kind, duration_sec: task.durSec, file: task.file, status: task.status,
        note: '录制完成后通过 bili_recv_messages（post_type=live_task）通知',
      }
    },
  ))

  defs.push(textTool(
    'bili_live_record_start',
    '开始录播（持续录制直到停止）：调用后立即返回 task_id，录播在后台持续进行；'
    + '用 bili_live_record_stop 停止（停止完成后通过消息缓冲通知，post_type=live_task）。'
    + 'save_path 可选，留空自动保存到媒体目录（.mp4）。',
    obj({
      roomid: int('直播间房间号（短号/长号均可）'),
      save_path: str('保存路径（可选，留空自动生成到媒体目录）'),
    }, ['roomid']),
    async (args) => {
      const init = await live.liveRoomInit(args.roomid)
      const task = await live.startRecord(init.room_id, args.save_path)
      if (task.status !== 'running') throw new MiraError('live/ffmpeg', '启动录播失败：' + (task.err || task.status), '看宿主日志；确认直播间在播且 ffmpeg 可用')
      return {
        ok: true, task_id: task.id, kind: task.kind, file: task.file, status: task.status,
        note: '用 bili_live_record_stop(task_id) 停止录播',
      }
    },
  ))

  defs.push(textTool(
    'bili_live_record_stop',
    '停止录播（bili_live_record_start 返回的 task_id）：优雅停止 ffmpeg（写文件尾），'
    + '停止完成后通过消息缓冲通知智能体（post_type=live_task）。',
    obj({ task_id: str('录播任务 ID（bili_live_record_start 返回的）') }, ['task_id']),
    async (args) => {
      const r = live.stopLiveRecord(String(args.task_id))
      if (!r.ok) throw new MiraError('live/task-not-found', r.error || '停止失败', '先 bili_live_tasks 看任务 id 与状态')
      return { ok: true, ...r }
    },
  ))

  defs.push(textTool(
    'bili_live_tasks',
    '查看直播媒体任务状态：录音/录视频/录播任务的 task_id、状态（running/done/error/stopped）、'
    + '文件路径、已运行时长等。',
    obj({}),
    async () => {
      const tasks = live.listLiveTasks()
      return { ok: true, count: tasks.length, tasks }
    },
  ))

  /* ── 通用 API 逃生舱（**同样受预算闸约束**） ──────────────── */

  defs.push(textTool(
    'bili_api',
    '通用 B 站 API 逃生舱：直接指定 HTTP 方法与路径调用 B 站接口，仅用于上面工具覆盖不到的接口。'
    + 'path 传完整 URL 或以 / 开头的 api.bilibili.com 路径（vc 域请传完整 URL）；form 为 POST 表单对象（自动附带 csrf）。'
    + '⚠️ 逃生舱**不绕过预算**：GET 计读桶、POST 计写桶，被拒时不发请求；撞 412/429 同样触发全局暂停。',
    obj({
      method: str('GET / POST'),
      path: str('API 路径或完整 URL'),
      form: obj({}),
    }, ['method', 'path']),
    async (args) => {
      const method = String(args.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'POST') {
        throw new MiraError('config/missing', 'method 只支持 GET / POST，收到：' + JSON.stringify(args.method), '逃生舱只放行 GET 与 POST')
      }
      const r = await api.biliFetch(String(args.path), {
        method,
        form: (args.form && typeof args.form === 'object') ? args.form : {},
      })
      return { ok: true, data: r }
    },
  ))

  const disposers = defs.map((d) => ctx.tools.register(d))
  return () => disposers.forEach((d) => { try { d() } catch { /* noop */ } })
}

/** 工具清单（README 与自检共用；顺序即注册顺序）。 */
export const TOOL_NAMES = [
  'bili_status',
  'bili_login_check',
  'bili_login_info',
  'bili_get_user_info',
  'bili_get_relation_stat',
  'bili_search_video',
  'bili_get_video_info',
  'bili_send_private_msg',
  'bili_recv_messages',
  'bili_get_sessions',
  'bili_fetch_session_msgs',
  'bili_send_dynamic',
  'bili_article_draft',
  'bili_article_draft_view',
  'bili_article_draft_delete',
  'bili_upload_image',
  'bili_reply_comment',
  'bili_live_info',
  'bili_live_join',
  'bili_live_leave',
  'bili_live_status',
  'bili_live_send_danmaku',
  'bili_live_screenshot',
  'bili_live_record_audio',
  'bili_live_record_video',
  'bili_live_record_start',
  'bili_live_record_stop',
  'bili_live_tasks',
  'bili_api',
]
