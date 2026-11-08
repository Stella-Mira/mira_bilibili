# mira_bilibili

DSH 的**哔哩哔哩接管插件**：用浏览器 Cookie（`SESSDATA / bili_jct / buvid3`，手填）登录 B 站账号，
把私信、动态、评论、搜索、视频信息、直播间弹幕与录制等能力封装成 `bili_*` 工具，
并处理「入站私信 / 直播间弹幕 → 唤醒 DSH 会话 → 用工具回复」这条链路。

本轮（0.3.0）是重构后的版本：**账号池 / 绑定 / 去重归 `mira_account`，本插件只做 B 站协议层**；
读/写预算在插件内**权威生效且不可绕过**（`bili_api` 逃生舱也一样）。

> **前置：必须同时装 `mira_account`**（`inject: ['tools','agents','workspaceRegistry','miraAccount']`）。
> 少了它本插件不加载、工具全部消失 —— 这是刻意的硬依赖：比「起来了但发不出去 / 回不来」好排查。
> `mira_account_status` 能自证它在跑。

---

## 落盘与前置

```
$DSH_HOME                       := process.env.DSH_HOME（trim 后非空）else ~/.dsh
本插件配置/状态                  := $DSH_HOME/mira_config/mira_bilibili/
  budget.json                    : 四个桶的用量与 412/429 暂停状态（schemaVersion:1；正常退出时落盘）
账号池 / 绑定 / 去重             := $DSH_HOME/mira_config/mira_account/   （mira_account 管）
凭据（**手填**，600）             := $DSH_HOME/mira_config/mira_account/creds/<accountId>.json
```

本机实测 `DSH_HOME=$DSH_HOME` → 实际落 `$DSH_HOME/mira_config/...`。
**配置本身不写文件**：它来自 profile 里 `mira_bilibili` 插件行的 `config`（cordis patch），本插件只读不写。

---

## 模块

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 入口/装配/单实例/热加载；启动时读凭据 → `nav` 自检 → 起轮询 + 连白名单直播间 |
| `lib/config.js` | 默认值 + `schemaVersion` + 校验（**cookie 不再从 config 读**） |
| `lib/budget.js` | 读/写 × 小时/天 四个桶 + 412/429 全局暂停退避（**所有出口共用这一道闸**） |
| `lib/api.js` | 接口层：凭据装载、`biliFetch`、wbi 签名、私信/动态/评论/搜索/视频/用户 |
| `lib/live.js` | 直播间：REST（房间信息/弹幕 token/流地址/发弹幕）、WS 主通道 + gethistory 降级、录制/截图 |
| `lib/agent.js` | 入站路由（私信走 `miraAccount.inbound`）+ agent 会话装配 + 合并窗口/冷却 + `/new` |
| `lib/adapter.js` | `mira_account` 适配器契约（`platform:"bilibili"`，含 `createSession` / `send`） |
| `lib/tools.js` | 25 个 `bili_*` 工具 |
| `lib/runtime.js` | 共享进程内状态：消息缓冲、最后错误、计数器（避免功能模块互相反向依赖） |
| `lib/kit.mjs` | `tool_shared/kit/kit.mjs` 的**逐字节副本**（`check-kit.mjs` 校验） |

---

## 配置（profile → `mira_bilibili.config`）

`accountId` 是唯一必填项；其余都有默认值（下表「默认」列）。必填为空 → `config/missing`，**不自动探测**。

| 键 | 默认 | 说明 |
|---|---|---|
| `schemaVersion` | `2` | 不匹配 → `config/schema` 拒绝加载（旧版无此字段，见「迁移」） |
| `enabled` | `true` | `false` = 不注册工具、不启服务（插件行仍在） |
| `accountId` | **空（必填）** | 账号 id。要同时对上：`accounts.json` 里的一行（`platform:"bilibili"`）、`creds/<accountId>.json`、本配置 |
| `autoStart` | `true` | 加载后自动登录 + 起轮询 + 连白名单直播间；`false` = 只注册工具（排障/自检） |
| `pollIntervalMs` | `60000` | 私信未读 / @我 的轮询间隔。旧版 8000 → 15000 → 60000：15 秒一次等于每天 5760 次读请求，光轮询就吃掉读预算并在 2026-11-06 触发过 -509 全局暂停；一分钟一次降到 1440/天 |
| `callTimeoutMs` | `10000` | 单次 HTTP 超时 |
| `bufferSize` | `500` | 消息缓冲条数；满了优先淘汰最旧的弹幕 |
| `userAgent` | 桌面 Chrome UA | B 站部分接口校验 UA/Referer |
| `budget.readPerHour` | `1200` | 读桶/小时（被拒时不发请求） |
| `budget.readPerDay` | `20000` | 读桶/天 |
| `budget.writePerHour` | `60` | 写桶/小时（发私信/动态/评论/弹幕） |
| `budget.writePerDay` | `300` | 写桶/天 |
| `budget.riskPauseMs` | `600000`（10 分钟） | 撞 412/429 后的首次全局暂停 |
| `budget.riskPauseMaxMs` | `3600000`（60 分钟） | 连续撞墙按 2 倍退避的上限 |
| `autoReply.enabled` | `false` | 私信自动应答总开关 |
| `autoReply.strangerPolicy` | `buffer` | `buffer` = 不回陌生人（只进缓冲 + 计数）；`reply` = 旧版行为（都回） |
| `autoReply.trustedUsers` | `[]` | 识别名单 `["mid:昵称", ...]`；`buffer` 策略下名单内的 mid 仍会应答 |
| `autoReply.mergeWindowMs` | `3000` | 同一私信对象的合并窗口（0 = 不合并） |
| `autoReply.newCommand` | `/new` | 重置该用户会话的命令（精确匹配整条消息） |
| `autoReply.agentCwd` | 空 | 新建会话的 cwd（`inboundPolicy=create` 时**必填**，空则 `config/missing`） |
| `autoReply.agentPreset` | `sylvia` | 会话挂载的预设 |
| `autoReply.agentProvider` / `agentModel` | 空 | 可选覆盖 |
| `autoReply.agentTimeoutMs` | `180000` | 弹幕 agent 回复超时（超时取消并记错） |
| `autoReply.personaPrompt` / `rulesPrompt` / `securityPrompt` | 内置 | 提示词；`rulesPrompt/securityPrompt` 支持数组或字符串 |
| `danmaku.enabled` | `true` | 弹幕总开关 |
| `danmaku.rooms` | `[]` | **白名单**直播间（房间号）；启动即常驻监听，自动应答只对它生效（默认 scope 下） |
| `danmaku.autoReply.enabled` | `false` | 弹幕自动应答开关 |
| `danmaku.autoReply.scope` | `whitelist` | `whitelist` = 只回白名单房间；`listened` = 白名单 + `bili_live_join` 临时房间（旧行为） |
| `danmaku.autoReply.minIntervalMs` | `30000` | 同房间两次自动回复的最小间隔（防刷屏） |
| `danmaku.autoReply.mergeWindowMs` | `3000` | 弹幕合并窗口 |
| `danmaku.reconnectMinMs` / `reconnectMaxMs` | `5000` / `300000` | WS 断线指数退避（高频重连会招风控） |
| `danmaku.pollIntervalMs` | `3000` | WS 被踢/脱敏时降级 gethistory 轮询的间隔 |
| `danmaku.mediaDir` | 空 | 截图/录音/录视频/录播目录；空 = `autoReply.agentCwd/data/media`，再不行用系统临时目录 |
| `danmaku.ffmpegPath` | 空 | ffmpeg 路径；空 = PATH 里的 `ffmpeg` |

> 旧字段 `config.cookie` / `config.csrf` **已废弃且不会被读取**（只打一条迁移提醒）。

---

## 预算口径（功能点4：写死，不可绕过）

四个桶：`read` / `write` × 小时 / 天。口径是**滑动窗口**（最近 3600s / 最近 24h），不是按整点清零 ——
避免「59 分打满、00 分再打满」的双倍峰值。

- **唯一闸门**：所有 B 站 HTTP 都走 `api.biliFetch`，它第一件事是 `budget.take(bucket)`。
  模型能调到的所有工具（含 `bili_api` 逃生舱）、登录自检、轮询、发送，没有第二条路。
- **被拒时不发请求**：闸门在前、`fetch` 在后。被拒也不消耗配额。
- **填 0 / 负数不会关闭预算**：非法值回落到默认值并打 warn（`budget` 不能靠填 0 绕过）。
- **没有重置预算的工具**：想放宽只能改配置后重载（有日志、可审计）。重载/重启**不会清零**用量
  （正常退出时用量落盘到 `budget.json`）。
- **桶归属**：GET → 读；POST → 写；轮询里的 `update_ack`（清未读）显式记**读**桶，
  否则轮询会把写预算吃光。对外写操作（私信/动态/评论/弹幕）一律记写桶。
- **撞 412 / 429**（HTTP 状态或业务码 `-412` / `-509`）→ **全局 `pauseUntil` 前进**，暂停期内所有调用
  直接拒（含逃生舱）且不发请求；连续撞墙按 2 倍退避（上限 `riskPauseMaxMs`），一次成功调用后回到基础时长。
- **默认值为什么这么大**：15s 轮询 ≈ 240 次/时 × 约 2.2 个请求 ≈ 530 读/时，`readPerHour:1200` 留了约 2 倍余量；
  想回到旧版 8s 轮询请同时把 `readPerHour` 调到 ≥ 1200（8s 轮询 ≈ 900+ 读/时）。
- `bili_status` 给出 `budget.used / remaining / paused / pauseUntil / rejected`。

**两层限流**：`mira_account` 的通用令牌桶（按账号，配置在它那边）也会过一遍；**B 站的读写预算以本插件为权威**
（PLAN §3.4 的口径）。

---

## 凭据（功能点1 / 约定8）：只能手填

Cookie 是 HttpOnly，脚本读不到，必须 F12 → Application → Cookies **手抄**。写入
`$DSH_HOME/mira_config/mira_account/creds/<accountId>.json`，**权限 600**：

```json
{
  "schemaVersion": 1,
  "platform": "bilibili",
  "kind": "cookie",
  "fields": {
    "SESSDATA": "……",
    "bili_jct": "……",
    "buvid3": "……"
  },
  "updatedAt": "2026-10-26T15:00:00.000Z"
}
```

- 必备字段：`SESSDATA`、`bili_jct`；`buvid3` 强烈建议（缺了部分 wbi 接口更容易 412）。
- **永不回显**：工具/日志/`bili_status` 只报「有没有 / 字段名 / 权限位」，不报值。
- 权限不是 600 时读取会顺手改回 600 并在状态里 `modeOk:true`。
- 登录自检 `bili_login_check` **真请求一次 `/x/web-interface/nav`**（读预算内）：
  成功 `{ok:true,mid,uname}`；失效 `{ok:false,error:{code:"creds/invalid",...}}` 并告诉你重抄哪个文件。
- 本插件**不提供写凭据的工具**（工具参数会进会话记录 = 回显）。

---

## 工具（25 个）

| 工具 | 说明 | 桶 |
|---|---|---|
| `bili_status` | 登录态 / 预算余量与暂停 / 监听房间 / 绑定数 / 最后错误（凭据只报字段名与权限） | 不请求 |
| `bili_login_check` | 登录自检（真请求 nav） | 读 |
| `bili_login_info` | nav 原始 data | 读 |
| `bili_get_user_info` | 用户公开信息（-799 会熔断降级） | 读 |
| `bili_get_relation_stat` | 关注/粉丝统计 | 读 |
| `bili_search_video` | 搜视频（wbi 签名 + 节流） | 读 |
| `bili_get_video_info` | 视频信息（bvid / av） | 读 |
| `bili_send_private_msg` | 发私信；**自动反向绑定当前会话为 taker**；`force` / `observer` 解冲突 | 写 |
| `bili_recv_messages` | 增量拉缓冲（私信 / @我 / 弹幕 / live_task / live_event） | 不请求 |
| `bili_get_sessions` | 私信会话列表 | 读 |
| `bili_fetch_session_msgs` | 私信历史 | 读 |
| `bili_send_dynamic` | 发纯文本动态 | 写 |
| `bili_article_draft` | 专栏/图文草稿：不传 article_id 新建，传则更新原草稿（正文纯文本，不认 markdown） | 写 |
| `bili_article_draft_view` | 读草稿：标题/正文/摘要/图片 | 读 |
| `bili_article_draft_delete` | 删草稿（不可恢复） | 写 |
| `bili_upload_image` | 上传本地图片到 B 站图片床，返回直链（`draw/upload_bfs`） | 写 |
| `bili_reply_comment` | 回复评论（1=视频 / 17=动态 / 11=专栏） | 写 |
| `bili_live_info` | 直播间信息（短号→长号） | 读 |
| `bili_live_join` / `bili_live_leave` | 临时进出直播间（白名单房间不允许临时进出） | 读 |
| `bili_live_status` | 监听房间 / 自动应答范围与冷却 / **被忽略的弹幕计数** | 不请求 |
| `bili_live_send_danmaku` | 发弹幕（≤30 字，超长截断） | 写 |
| `bili_live_screenshot` | 截一帧（ffmpeg） | 读 |
| `bili_live_record_audio` / `bili_live_record_video` | 录一段音/视频（异步，完成后进缓冲） | 读 |
| `bili_live_record_start` / `bili_live_record_stop` | 录播（持续录制 / 停止） | 读 |
| `bili_live_tasks` | 媒体任务清单 | 不请求 |
| `bili_api` | 通用 API 逃生舱（GET/POST）——**同样过预算闸，不可绕过** | 读/写 |

所有工具返回 JSON 文本：`{ok:true,...}` 或 `{ok:false,error:{code,message,hint}}`。
「桶=不请求」的工具不碰网络，因此即使凭据缺失也能用（`bili_status` 除外：它需要先确认凭据就位，缺了报 `creds/missing`）。

**没有、也不会有**：三连 / 投币 / 关注 / 改资料 / 群发 / 送礼（花钱）的工具。旧版有 4 个送礼工具（默认关闭），
本轮按功能点6「不做花钱」一并移除（见「迁移」）。

---

## 反向绑定与绑定表（功能点3）

- 任意会话调 `bili_send_private_msg` → 走 `miraAccount.send({..., sessionId: 当前会话})`：
  **首次自动登记该会话为该用户（`kind:"user"`, `peerId:mid`）的 taker**，对端回私信会回到这个会话。
- 同 peer 已有别的 taker → `binding/conflict`，**不发出去**；`force:true` 抢（原 taker 降级 observer），
  `observer:true` 只旁听。
- 绑定表是 `mira_config/mira_account/bindings.json`（**不再有 `bili_meta.json`**）。
  用 `mira_account_bindings` 可以双向查；`bili_status.bindings` 给本账号的摘要。

## 自动应答（功能点5）

**私信**：按对象独立会话（交互逻辑仍是「一个 peer 一个 taker 会话」，但账在 `mira_account`）：
1. 轮询到新私信 → 去重（本地 `talker|seqno` + `mira_account` 的 `message_id`）→ 进消息缓冲；
2. `/new` → 解除该 peer 绑定（下一条消息按 `inboundPolicy` 重新建会话）并回一句；
3. 陌生人策略：`strangerPolicy:"buffer"`（默认）时**不回陌生人**、只计数；
   已有人显式 bind 了 taker 的 peer 不受限；`trustedUsers` 名单内的 mid 也放行；
4. 合并窗口：窗口内的多条合并成一条 → **按 qqbot 的口径拼好正文** → `miraAccount.inbound()`
   → 有 taker 就 **steer（插话）**，没有就按账号的 `inboundPolicy`（`create` 时用本插件的
   `adapter.createSession` 新建会话）。**本插件不再自己维护会话映射、不再自己 followup 等待。**

私信正文（`buildPrivatePrompt`）六段，和 QQ 那边一致 —— `mira_account` 只会把 `message.text`
原样投出去，提示词必须插件自己拼：

```
【安全规则】  ← autoReply.securityPrompt（数组或字符串）
【识别名单】  ← autoReply.trustedUsers
【消息来源】  工具：mira_bilibili / 平台：哔哩哔哩私信（一对一） / 用户：昵称 / ID号：mid
             回复工具：bili_send_private_msg（peerId=…）
【当前时间】
【行为规则】  ← autoReply.rulesPrompt + 一条私信场景补充（普通文字回复不会发给对方）
【聊天消息】  ← 原文（合并窗口时是多条换行拼接）
```

同时入站带 `source: { kind: 'mira_bilibili' }`（宿主 `RuntimeContextProjection` 读它；
界面靠它区分消息是谁带来的）。弹幕那条走的是 `buildDanmakuPrompt`，本来就带这些块，
`agentReply()` 的 `source.kind` 也改成了 `mira_bilibili`。

**直播间弹幕**：白名单房间常驻监听；临时房间用工具进出。
自动应答范围 `danmaku.autoReply.scope`：默认 `whitelist`（**白名单外不自动应答**，被忽略的弹幕计数在
`bili_live_status.ignored` 里可见）；`listened` 恢复旧行为（临时房间也回）。
弹幕有合并窗口 + 同房间冷却；agent 只有显式调用 `bili_live_send_danmaku` 才会真的发出去
（它的普通文字回复不会变成弹幕）。房间 ↔ 会话的对应关系存在 `mira_account` 绑定（`kind:"room"`）里，重启自动续上。

## 风控纪律（功能点6）

写进代码也是写进契约：

- **不做三连 / 投币 / 关注 / 花钱。** 没有对应工具，也没有对应配置开关（旧版送礼工具本轮移除）。
- **不群发。** 没有广播工具；发私信只能一个一个 mid 发，且受写预算限制。
- **不回陌生人。** 默认 `strangerPolicy:"buffer"`：陌生人私信只进缓冲 + 计数，不自动应答；
  要应答就先显式 bind taker，或把 mid 放进 `trustedUsers`。
- 轮询/重连都按预算与退避走；撞 412/429 就**全局停**，不换接口硬试。
- 凭据只在本进程内用于拼 Cookie 头，不进日志、不进工具返回值、不进提交。

## 已知取舍

1. **陌生人默认不回**：这是相对旧版的行为变化（旧版 `autoReply.enabled=true` 就都回）。要旧行为设 `strangerPolicy:"reply"`。
2. **弹幕默认只回白名单房间**：旧版临时 `bili_live_join` 的房间也回；要旧行为设 `danmaku.autoReply.scope:"listened"`。
3. **轮询默认 15s**（旧版 8s）：为了不超过读预算；要更快就一起调大 `budget.readPerHour`。
4. **预算计数重启后接着用**（正常退出落盘；崩溃丢了则从头计）。暂停状态同样落盘，重启不会立刻再撞 412。
5. **`/new` 现在是「解绑」而不是「销毁会话」**：会话本身留在宿主里（本插件不拥有它），只是不再是该 peer 的 taker。
6. **`update_ack` 记读桶**：它是轮询的维护动作；不改这个口径，轮询会把写预算吃光。
7. **没有送礼**：功能点6 要求不花钱。若确实需要，恢复路径是把旧版 `sendGift` 段搬回来并重新加限额配置（不建议）。
8. **`bili_api` 的返回值被套上 `{ok:true,data}`**：旧版直接吐裸 JSON；为了全插件统一的返回约定改成信封，
   协议与字段没变（`data` 里就是原始响应）。
9. **弹幕 agent 会话仍在进程内缓存**：binding 负责持久化，但「agent 句柄」每次重载会重新 resume。
10. **长连接不计入 HTTP 预算**：弹幕 WebSocket 与 ffmpeg 拉流都是一条长连接，不是一次性 API 请求，
    因此不走 `budget`（它们的风险由重连退避、录制时长上限与 `bili_live_tasks` 可见性约束）。
    并发录制任务数没有硬上限（旧版也没有），别同时开一堆录播。
11. **`bili_api` 只允许 B 站域名**：传完整 URL 时校验 `*.bilibili.com` / `*.bilibili.tv` / `*.hdslb.com` /
    `*.biliapi.net`，其它域名直接 `api/unsupported-host` 且不发请求 —— 否则会把 Cookie 发给第三方主机
    （旧版没有这道校验；这是本轮补的凭据安全约束，协议本身没变）。

## 迁移（旧版 0.2.0 → 0.3.0）

旧版的 cookie 在插件配置里、会话映射在 `autoReply.agentCwd/data/bili_meta.json`、绑定靠自建表。按下面四步走：

1. **登记账号行**（不含凭据）：
   ```json
   // $DSH_HOME/mira_config/mira_account/accounts.json
   { "schemaVersion": 1, "accounts": [{
       "id": "bili-main", "platform": "bilibili", "label": "主号",
       "enabled": true, "inboundPolicy": "create"
   }] }
   ```
   或者用工具：`mira_account_add {id:"bili-main", platform:"bilibili"}`。
2. **手抄 cookie 到凭据文件**（600）：把旧 `config.cookie` 里的 `SESSDATA` / `bili_jct` / `buvid3` 填进
   `$DSH_HOME/mira_config/mira_account/creds/bili-main.json`（格式见「凭据」）。然后把旧配置里的
   `cookie` / `csrf` **清空**（不清空也不会被读取，只会每次加载打一条提醒）。
3. **改插件配置**：加 `schemaVersion: 2` 与 `accountId: "bili-main"`；`autoReply.agentCwd` 保留；
   新增项按需（预算、`strangerPolicy`、`danmaku.autoReply.scope`）。
4. **迁移会话绑定**（可选）：旧的 `data/bili_meta.json`（`"user:<mid>" → sessionId`）用
   `migrate/bindings.mjs` 转成 `bindings.json`（默认 dry-run，先备份）：
   ```bash
   node tool_shared/migrate/bindings.mjs --from <agentCwd>/data/bili_meta.json --platform bilibili --account bili-main
   node tool_shared/migrate/bindings.mjs --from ... --write
   ```
   迁完后旧文件改名成 `.bak.<时间戳>` 保留，可手工删。

**不兼容项**：`config.cookie/csrf`（忽略）、`bili_meta.json`（改用绑定表）、送礼配置与工具（移除）。

## 错误码

| code | 场景 |
|---|---|
| `config/missing` | 必备项为空（`accountId` / `agentCwd` / 凭据字段 / `payload.text`） |
| `config/schema` | 插件配置或凭据文件的 `schemaVersion` 不匹配（拒绝该文件，不静默兼容） |
| `creds/missing` | 凭据文件缺 / 坏 |
| `creds/invalid` | 凭据平台/形态不符，或 `nav.isLogin=false`（Cookie 过期） |
| `account/invalid` | 账号 id 非法（不能用作文件名） |
| `budget/exceeded` | 读或写桶用尽（**不发请求**，hint 给恢复时刻） |
| `budget/paused` | 412/429 全局暂停中（**不发请求**），hint 给暂停到期时间 |
| `budget/risk` | 本次请求撞 412/429（请求已发出，随后进入全局暂停） |
| `budget/missing` | 预算未装配（插件内部错误） |
| `api/http` / `api/network` / `api/parse` / `api/code` | B 站 HTTP / 网络 / 解析 / 业务码错误（`-799`、`-352`、`-101` 看 hint） |
| `api/unsupported-host` / `api/url` | 逃生舱传了非 B 站域名 / 无法解析的 URL（拒绝且不发请求） |
| `live/room-not-found` / `live/stream` / `live/ffmpeg` / `live/task-not-found` / `live/whitelisted` | 直播间/流/ffmpeg/任务/白名单相关 |
| `video/not-found` | 视频不存在 |
| `binding/conflict` / `binding/not-found` | 来自 `mira_account`：同 peer 已有 taker / 查不到绑定 |
| `account/not-found` / `account/disabled` / `platform/unsupported` | 来自 `mira_account`：账号没登记/停用/没有适配器 |
| `plugin/instance` / `plugin/disabled` | 单实例保护 / `enabled:false` |
| `delivery/failed` / `delivery/timeout` | 投递会话失败 / agent 回复超时（已取消） |

## 自检

```bash
cd mira_bilibili
node test/smoke.mjs                              # 末行 ==== ALL PASS（N 项断言）====，退出码 0
node test/integration-mira-account.mjs           # 可选：与真实 mira_account 的契约联调（需同仓库有 mira_account/）
cd ..
node tool_shared/tools/check-zero-dep.mjs mira_bilibili   # 只许 node: 与相对 import
node tool_shared/tools/check-kit.mjs                      # lib/kit.mjs 与规范源逐字节一致
```

`test/integration-mira-account.mjs` 另外用**真实的 `mira_account` 插件**跑一遍契约：
适配器注册、`inboundPolicy=create` → `createSession` → `bindings.json` → steer、同 id 去重、
反向绑定冲突/`force`、`msg_key` 记 self。它需要同仓库的 `mira_account/`（开发/验收用，不随包发布）。

`test/smoke.mjs` **只用假 fetch / 假 miraAccount / 假 agent**，全部在临时 `DSH_HOME` 里跑：
不发真实 B 站请求，也不碰你的真实配置。覆盖 PLAN §1.4 的 D2–D9（含「被预算拒绝时 fetch 未被调用」
「412 后 pauseUntil 前进且暂停期内不请求」「同 msg_key 二次轮询不重复投递」「白名单外不自动应答且计数可见」）。

## 与 mira_account 的契约

- **A** 入站一律交给 `miraAccount.inbound()`（本插件不维护 session 映射）。
- **B** 出站一律走 `miraAccount.send()`（先 bind 或复用 binding，再调 `adapter.send`）。
- **C** 错误码统一（上表）。
- `adapter.onMessage(account, cb)` 只做**旁听订阅**（收到入站时额外投给订阅者），**不改变路由**；
  `mira_account` 目前不调用它。
- `adapter.createSession({account,kind,peerId,display,text})` 在 `inboundPolicy=create` 时由路由调用，
  返回 sessionId；需要的 `agentCwd` / `agentPreset` 来自本插件配置。
