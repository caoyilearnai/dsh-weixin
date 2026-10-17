/**
 * dsh-weixin：微信 ClawBot (iLink) 通道插件（标准 cordis bundle 形态）。
 *
 * 数据流：
 *   iLink getupdates 长轮询收消息 → 按微信用户映射/创建 Harness 会话
 *   → agent.followup(userMessage) 原生注入
 *   → 订阅 session/event（user/message 按 id 关联 → assistant/message 收集
 *     → turn/end 结算）→ sendmessage 回微信（带 context_token）
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import * as ilink from './ilink.mjs'
import {
  DEFAULT_ACCOUNT_ID,
  assertAccountId,
  assertFolderName,
  createAccountStore,
  ensureAccountWorkspace,
  normalizeAccounts,
} from './accounts.mjs'
import { registerPanel } from './panel.mjs'

export const name = 'dsh-weixin'
/** 硬依赖：面板需要 webServer；通道需要 agents（查找/创建/恢复代理）；tools 用于注册主动推送工具；attachments 用于收图（存图喂视觉模型）。agentPresets 为可选探测。 */
export const inject = ['webServer', 'agents', 'tools', 'attachments']

/** 可配置参数（默认值即 schema 默认，可在 cordis.yml 覆盖）。 */
export const Config = Schema.object({
  // 多账号目录根；每个账号使用其直接子目录，不会自动注册成 DSH Workspace。
  accountRoot: Schema.string().default(''),
  // 可选的多账号配置；留空时自动创建向后兼容的 default 账号。
  accounts: Schema.array(Schema.object({
    id: Schema.string().required(),
    folder: Schema.string().default(''),
    cwd: Schema.string().default(''),
  })).default([]),
  // /weixin 与 ctx.weixin 的默认账号；留空取 accounts 第一项。
  defaultAccount: Schema.string().default(''),
  // 新会话的工作目录（绝对路径，决定会话持久化命名空间与文件工具根）；
  // 空 = 自动（stateDir/workspace，跨重启稳定）
  cwd: Schema.string().default(''),
  // 状态目录（凭证/会话映射/游标）；空 = 自动（$DSH_HOME/dsh-weixin 或 ~/.dsh/dsh-weixin）
  stateDir: Schema.string().default(''),
  // 回复风格：full 整轮文本 / last 只回最后一条
  replyMode: Schema.union(['full', 'last']).default('full'),
  // 单轮回复超时（毫秒）
  replyTimeoutMs: Schema.number().default(15 * 60_000),
  // 单条消息最大字符数（超出切分）
  maxChunk: Schema.number().default(1500),
  // 两条发送之间的最小间隔（毫秒，规避 iLink 限流）
  sendIntervalMs: Schema.number().default(2000),
  // 超过该时长没有发起新的 getupdates 请求时，管理页不再显示已连接
  pollStaleMs: Schema.number().default(75_000),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userTag = (userId) => createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 8)

/** 登录终态（confirmed/error/expired）后面板保留最终提示的时长，之后自动收起卡片（review S3）。 */
const LOGIN_DONE_GRACE_MS = 10_000

export function chunkText(text, max) {
  const limit = Math.max(1, Math.floor(max || 1500))
  const out = []
  let rest = text ?? ''
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    // 切点不得落在 UTF-16 代理对之间（emoji 占 2 码元）。优先左移一格，把整个字符留给
    // 下一块；若已顶到块首（如 maxChunk=1 且以 emoji 开头）无法左移，则右移一格把整个
    // 字符纳入本块——宁可本块超 1 码元，也不产出半个字符，并保证 rest 一定前进。
    if (cut > 0 && cut < rest.length) {
      const prev = rest.charCodeAt(cut - 1)
      const next = rest.charCodeAt(cut)
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        cut = cut - 1 > 0 ? cut - 1 : cut + 1
      }
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/** 等价 @deepseek-ai/dsh-llm 的 createUserMessage（避免依赖独立安装时版本漂移）。 */
function makeUserMessage(input) {
  return { ...input, role: 'user', id: `msg-${randomUUID()}` }
}

/** 单个 ClawBot 账号的通道。每个通道有独立轮询 loop、存储、发送队列与按用户隔离的会话。 */
export class WeixinChannel {
  constructor(ctx, config, store, { ilinkApi = ilink, autoStart = true } = {}) {
    this.ctx = ctx
    this.cfg = config
    this.store = store
    this.accountId = config.accountId
    this.accountRoot = config.accountRoot ?? ''
    const configuredFolder = config.folder || (config.cwd ? path.basename(config.cwd) : '')
    this.folder = configuredFolder
    this.ilink = ilinkApi
    this.log = ctx.logger ?? console
    this.creds = store.loadCredentials()
    this.sessionMap = store.loadSessionMap()
    this.buf = store.loadBuf()
    this.botAgent = 'DeepSeek Harness Weixin Channel'
    this.typingTickets = new Map()
    this.turns = new Map() // sessionId -> current turn
    this.pending = new Map() // userMessage.id -> {from, contextToken, sessionId, resolve, timer}
    this.collectors = new Map() // msgId -> { sessionId, turn, msgId, parts, pending }
    this.inbox = []
    this.processing = false
    this.workerPromise = null
    this.seenMessageOrder = store.loadSeenMessages?.() ?? []
    this.seenMessageIds = new Set(this.seenMessageOrder)
    this.processedMessageIds = new Set(this.seenMessageOrder)
    this.lastSendAt = 0
    this.sendQueue = Promise.resolve() // 发送调速队列（review S6）
    this.stopped = false
    this.monitorRunning = false
    this.monitorAbort = new AbortController()
    this.status = {
      baseUrl: null,
      lastEventAt: null,
      lastPollAt: null,
      lastInboundAt: null,
      lastError: null,
      pausedUntil: null,
      pauseReason: null,
      startedAt: Date.now(),
    }
    this.logs = [] // ring buffer
    this.login = null // 面板登录流程状态
    this.downloadImageBytes = this.ilink.downloadImageBytes // 测试注入点（默认走 CDN 下载解密）
    this.visionCache = new Map() // `provider:model` -> boolean（模型是否支持图片输入）

    const savedSettings = this.store.loadAccountSettings?.() ?? {}
    if (
      savedSettings.folder
      && savedSettings.accountRoot
      && this.accountRoot
      && path.resolve(savedSettings.accountRoot) === path.resolve(this.accountRoot)
    ) {
      try {
        this.folder = assertFolderName(savedSettings.folder)
        this.cfg.folder = this.folder
        this.cfg.cwd = ensureAccountWorkspace(this.accountRoot, this.folder)
      } catch (err) {
        this.folder = configuredFolder
        this.pushLog(`读取账号文件夹设置失败，沿用配置：${err?.message ?? err}`)
      }
    }

    this.ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event))
    this.ctx.on('dispose', () => this.stop())

    if (autoStart && this.creds?.bot_token) {
      this.startMonitor()
    } else if (autoStart) {
      this.pushLog('未配置微信凭据，等待扫码登录（面板 /weixin 或 bin/login.mjs）')
    }
  }

  pushLog(line) {
    const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    this.logs.push(entry)
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300)
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async startMonitor() {
    if (!this.cfg.cwd || !this.folder) {
      this.monitorRunning = false
      this.status.lastError = '账号未配置文件夹，暂不启动消息轮询'
      this.pushLog(this.status.lastError)
      return
    }
    const cred = this.creds
    cred.baseurl = cred.baseurl || this.ilink.DEFAULT_BASE_URL
    this.status.baseUrl = cred.baseurl
    this.monitorRunning = true
    // 本地捕获 controller：applyCredentials/clearCredentials 会替换 this.monitorAbort，
    // 当前循环必须持有旧引用，abort 旧 controller 才能停下本循环（否则会泄漏/重复轮询）。
    const aborter = this.monitorAbort
    this.pushLog('微信通道启动（iLink 长轮询）')
    try {
      await this.ilink.notifyStart({ baseUrl: cred.baseurl, token: cred.bot_token, botAgent: this.botAgent })
    } catch { /* 通知失败不阻塞 */ }

    let failures = 0
    while (!this.stopped && !aborter.signal.aborted) {
      const now = Date.now()
      if (this.status.pausedUntil != null) {
        if (now < this.status.pausedUntil) {
          await this.waitAbortable(this.status.pausedUntil - now, aborter.signal)
          continue
        }
        this.status.pausedUntil = null
        this.status.pauseReason = null
        failures = 0
        this.pushLog('微信通道暂停结束，恢复长轮询')
      }
      try {
        this.status.lastPollAt = Date.now()
        const resp = await this.ilink.getUpdates({
          baseUrl: cred.baseurl, token: cred.bot_token, buf: this.buf, botAgent: this.botAgent,
          signal: aborter.signal,
        })
        if (this.stopped || aborter.signal.aborted) break
        failures = 0
        this.status.lastEventAt = Date.now()
        this.status.lastError = null
        for (const msg of this.ilink.normalizeInboundMessages(resp)) {
          if (this.stopped || aborter.signal.aborted) break
          if (!this.acceptInbound(msg)) continue
          this.status.lastInboundAt = Date.now()
          this.enqueueInbound(msg)
        }
        if (typeof resp?.get_updates_buf === 'string' && resp.get_updates_buf) {
          this.buf = resp.get_updates_buf
          this.store.saveBuf(this.buf)
        }
      } catch (err) {
        if (err?.ret === -14 || err?.errcode === -14) {
          this.status.pausedUntil = Date.now() + 60 * 60_000
          this.status.pauseReason = `iLink 返回 ret=-14，账号暂停一小时：${err?.message ?? err}`
          this.status.lastError = this.status.pauseReason
          this.pushLog(this.status.pauseReason)
          continue
        }
        failures += 1
        this.status.lastError = err?.message ?? String(err)
        const wait = Math.min(1000 * failures, 15_000)
        this.pushLog(`长轮询异常（${failures}）：${err?.message ?? err}`)
        await this.waitAbortable(wait, aborter.signal)
      }
    }
  }

  waitAbortable(ms, signal) {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      signal.addEventListener('abort', done, { once: true })
    })
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.monitorAbort.abort()
    this.monitorRunning = false
    this.cancelPending()
    this.inbox.length = 0
    if (this.creds?.bot_token) {
      try {
        await this.ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.pushLog('微信通道已停止')
  }

  /** 登录成功后应用新凭证并重启监视循环。 */
  applyCredentials(cred) {
    if (!this.cfg.cwd || !this.folder) {
      throw new Error('请先填写账号文件夹名')
    }
    this.cancelPending()
    this.typingTickets.clear()
    this.inbox.length = 0
    this.status.pausedUntil = null
    this.status.pauseReason = null
    this.creds = { ...cred, baseurl: cred.baseurl || this.ilink.DEFAULT_BASE_URL }
    this.store.saveCredentials(this.creds)
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = false
    this.startMonitor()
  }

  /** 登出：清凭证 + 下线通知 + 停监视。 */
  async clearCredentials() {
    this.cancelPending()
    this.typingTickets.clear()
    this.inbox.length = 0
    if (this.creds?.bot_token) {
      try {
        await this.ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = true
    this.creds = null
    this.status.pausedUntil = null
    this.status.pauseReason = null
    this.store.saveCredentials(null)
    this.pushLog('已登出')
  }

  cancelPending() {
    for (const pending of this.pending.values()) {
      this.stopTypingOnce(pending)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve?.()
    }
    this.pending.clear()
    this.collectors.clear()
  }

  enqueueInbound(msg) {
    this.inbox.push(msg)
    this.kickWorker()
  }

  acceptInbound(msg) {
    const messageId = String(msg?.messageId ?? '').trim()
    if (!messageId) return true
    if (this.seenMessageIds.has(messageId)) return false
    this.seenMessageIds.add(messageId)
    return true
  }

  persistSeenMessage(msg) {
    const messageId = String(msg?.messageId ?? '').trim()
    if (!messageId || this.processedMessageIds.has(messageId)) return
    this.processedMessageIds.add(messageId)
    this.seenMessageOrder.push(messageId)
    if (this.seenMessageOrder.length > 1000) {
      const expired = this.seenMessageOrder.shift()
      this.processedMessageIds.delete(expired)
      this.seenMessageIds.delete(expired)
    }
    try {
      this.store.saveSeenMessages?.(this.seenMessageOrder)
    } catch (err) {
      this.pushLog(`保存消息去重状态失败：${err?.message ?? err}`)
    }
  }

  kickWorker() {
    if (this.processing || this.inbox.length === 0 || this.stopped) return
    this.processing = true
    this.workerPromise = this.drainInbox().finally(() => {
      this.processing = false
      this.workerPromise = null
      if (this.inbox.length > 0 && !this.stopped) this.kickWorker()
    })
  }

  async drainInbox() {
    while (!this.stopped && this.inbox.length > 0) {
      const msg = this.inbox.shift()
      try {
        await this.handleInbound(msg)
      } catch (err) {
        this.pushLog(`消息处理失败：${err?.message ?? err}`)
      } finally {
        this.persistSeenMessage(msg)
      }
    }
  }

  /* ------------------------------ 会话/代理 ------------------------------ */

  async composeSetup() {
    const presets = this.ctx.get('agentPresets')
    return async (agentCtx) => {
      // 通道指令：注册到 agent 作用域，只约束本微信会话、不污染网页端。
      // 关键：禁止 ask_user_question（它走网页 provider，微信端无法应答会卡住整轮）。
      try {
        agentCtx.systemPrompt.section({
          name: 'weixin:channel-instruction',
          order: 50,
          text: '你当前通过微信消息通道与用户交流，交流是异步、回合式的文字对话。'
            + '不要使用 ask_user_question 工具——它会在网页端阻塞等待回答，微信端无法响应会导致整轮卡住。'
            + '信息不足时：优先在回复正文里直接向用户反问，或采用合理默认值并简要说明你的假设。',
        })
      } catch (err) {
        this.pushLog(`注入通道指令失败：${err?.message ?? err}`)
      }
      if (!presets) return
      try {
        const resolved = await presets.resolve(undefined)
        if (resolved?.id) await presets.mount(agentCtx, resolved.id)
      } catch (err) {
        this.pushLog(`agentPresets 装配失败（用默认）：${err?.message ?? err}`)
      }
    }
  }

  /** 解析当前默认模型为 AgentOptions（provider + model）。harness 的人设里含 {{model}}/{{provider}} 模板变量，
   *  只有 agent.options 里显式给了模型才渲染得出来，否则首条消息就报「prompt variable has no value」。 */
  resolveDefaultAgentOptions() {
    try {
      const sel = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch (err) {
      this.pushLog(`解析默认模型失败：${err?.message ?? err}`)
    }
    return {}
  }

  /**
   * 在管理页绑定前设置账号文件夹。已登录账号不允许直接改目录，避免旧会话跨目录续用。
   * 登出后改目录会清空该账号的会话映射，但保留消息去重等账号状态。
   */
  setAccountFolder(value) {
    const folder = assertFolderName(value)
    if (!this.accountRoot) throw new Error('未配置 accountRoot，无法设置账号文件夹')
    if (folder === this.folder && this.cfg.cwd) return this.cfg.cwd
    if (this.creds?.bot_token) {
      throw new Error('已绑定账号不能直接更换文件夹，请先登出')
    }
    const cwd = ensureAccountWorkspace(this.accountRoot, folder)
    if (this.folder && folder !== this.folder) {
      this.sessionMap = {}
      this.store.saveSessionMap(this.sessionMap)
    }
    this.folder = folder
    this.cfg.folder = folder
    this.cfg.cwd = cwd
    this.store.saveAccountSettings?.({
      accountRoot: this.accountRoot,
      folder,
      updatedAt: Date.now(),
    })
    this.pushLog(`账号文件夹已设为 ${folder}`)
    return cwd
  }

  prepareLoginFolder(value) {
    const folder = String(value ?? '').trim()
    if (folder) this.setAccountFolder(folder)
    if (!this.folder || !this.cfg.cwd) {
      const err = new Error('请先填写账号文件夹名')
      err.statusCode = 400
      throw err
    }
  }

  /** 微信用户 → 会话/代理。已有则复用；持久化会话则恢复；否则新建。 */
  async ensureAgentFor(userId) {
    if (!this.cfg.cwd || !this.folder) throw new Error('账号未配置文件夹')
    const sessionId = this.sessionMap[userId]
    if (sessionId) {
      const live = this.ctx.agents.get(sessionId)
      if (live) return live
      try {
        const { agent } = await this.ctx.agents.resume({
          resumeSessionId: sessionId, agentOptions: this.resolveDefaultAgentOptions(), setup: await this.composeSetup(),
        })
        this.pushLog(`恢复持久化会话 ${sessionId}（用户 ${userTag(userId)}）`)
        return agent
      } catch (err) {
        this.pushLog(`恢复会话 ${sessionId} 失败：${err?.message ?? err}，将新建`)
      }
    }

    const newId = `session-${randomUUID()}`
    try {
      const { agent } = await this.ctx.agents.create({
        sessionId: newId,
        agentOptions: this.resolveDefaultAgentOptions(),
        meta: { cwd: this.cfg.cwd },
        setup: await this.composeSetup(),
      })
      this.sessionMap[userId] = newId
      this.store.saveSessionMap(this.sessionMap)
      this.pushLog(`为用户 ${userTag(userId)} 新建会话 ${newId}`)
      return agent
    } catch (err) {
      this.pushLog(`新建会话失败：${err?.message ?? err}`)
      throw err
    }
  }

  /* ------------------------------ 入站处理 ------------------------------ */

  async handleInbound(msg) {
    const { from, to, contextToken } = msg
    if (!to?.endsWith('@im.bot')) return

    // 正文：文本优先，其次语音转写（P1：腾讯服务端已 ASR，无需本地识别）
    const bodyText = (msg.text || msg.voiceText || '').trim()
    const hasImage = !!msg.image
    if (!bodyText && !hasImage) {
      await this.sendReply(from, contextToken, '这个格式暂不支持（目前支持文字 / 图片 / 语音）🙏')
      return
    }
    this.pushLog(`收：用户 ${userTag(from)}，${bodyText ? `文字 ${bodyText.length} 字` : '图片'}`)

    // 正在输入提示；发送失败视为 ticket 可能已失效，清缓存下次重建（review S12）
    const ticket = await this.getTypingTicket(from, contextToken)
    if (ticket) {
      await this.ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: from, typingTicket: ticket, status: 1, botAgent: this.botAgent })
        .catch(() => { this.typingTickets.delete(from) })
    }

    let agent
    try {
      agent = await this.ensureAgentFor(from)
    } catch (err) {
      await this.sendReply(from, contextToken, `😵 会话准备失败：${err?.message ?? err}`)
      return
    }

    // 图片：仅在模型确实支持视觉时注入 image 块。否则图片块会持久化进会话历史，
    // 导致后续每一轮都把图片重发给纯文本模型 → 每次都报错 → 整段会话「发什么都没反应」。
    let imageBlock = null
    if (hasImage) {
      if (await this.supportsVision(agent?.options)) {
        if (this.ctx.attachments) imageBlock = await this.resolveImageBlock(msg.image)
      } else if (!bodyText) {
        // 纯图片 + 模型不看图：不注入、不跑模型，直接友好提示，避免污染历史
        this.stopTypingOnce({ from, typingStopped: false })
        await this.sendReply(from, contextToken, '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述）')
        return
      }
      // 有文字 + 模型不看图：忽略图片，继续按纯文字处理
    }

    const content = []
    if (bodyText) content.push({ type: 'text', text: bodyText })
    if (imageBlock) content.push(imageBlock)

    const userMessage = makeUserMessage({
      content,
      source: { kind: 'plugin:dsh-weixin', plugin: 'dsh-weixin' },
    })

    await new Promise((resolve) => {
      const pend = { from, contextToken, sessionId: agent.id, resolve, timer: null, typingStopped: false }
      const timer = setTimeout(() => {
        this.pending.delete(userMessage.id)
        this.stopTypingOnce(pend)
        this.sendReply(from, contextToken, '⏰ 处理超时，请稍后再试').finally(resolve)
      }, this.cfg.replyTimeoutMs)
      pend.timer = timer
      this.pending.set(userMessage.id, pend)
      try {
        agent.followup(userMessage)
      } catch (err) {
        // followup 同步抛错（如代理已销毁）：清理 pending/timer 并回错误，避免挂起直到超时
        clearTimeout(timer)
        this.pending.delete(userMessage.id)
        this.pushLog(`followup 失败：${err?.message ?? err}`)
        this.stopTypingOnce(pend) // 同步失败也要取消「正在输入」，否则指示会一直挂着
        this.sendReply(from, contextToken, `😵 处理失败：${err?.message ?? err}`).finally(resolve)
      }
    })
  }

  /**
   * 判断会话所用模型是否支持图片输入（保守：无法判断/查不到一律视为不支持）。
   * 结果按 `provider:model` 缓存，避免每张图都请求模型元数据。
   */
  async supportsVision(agentOptions) {
    try {
      const llm = this.ctx.get?.('llm')
      const am = this.ctx.get?.('agentDefaultModel')
      if (!llm) return false
      const sel = am?.currentSelection?.() ?? {}
      const provider = agentOptions?.provider || sel.provider
      const model = agentOptions?.model || sel.model
      if (!provider || !model) return false
      const key = `${provider}:${model}`
      if (this.visionCache.has(key)) return this.visionCache.get(key)
      const info = await llm.resolveModelInfo(provider, model)
      const ok = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      this.visionCache.set(key, ok)
      return ok
    } catch {
      return false
    }
  }

  /** 把微信图片下载解密后存成 Harness 图片附件，返回 image 内容块；失败/超限降级为文本块。 */
  async resolveImageBlock(image) {
    const limits = this.ctx.attachments?.imageLimits
    const maxBytes = limits?.maxImageBytes ?? 0
    try {
      const bytes = await this.downloadImageBytes({
        encryptQueryParam: image.encrypt_query_param,
        fullUrl: image.full_url,
        aesKey: image.aesKey,
      })
      if (maxBytes && bytes.byteLength > maxBytes) {
        this.pushLog(`图片超限 ${bytes.byteLength}B > ${maxBytes}B，略过图片理解`)
        return { type: 'text', text: '[图片过大，未处理]' }
      }
      const attachment = await this.ctx.attachments.saveImage({
        data: bytes, // Buffer 即 Uint8Array
        mediaType: this.ilink.sniffImageMime(bytes),
      })
      return { type: 'image', attachment }
    } catch (err) {
      this.pushLog(`图片下载/解密/入库失败：${err?.message ?? err}`)
      return { type: 'text', text: '[图片处理失败]' }
    }
  }

  /** 取消「正在输入」指示（status=2），失败静默（review S12）。 */
  stopTyping(userId) {
    const ticket = this.typingTickets.get(userId)
    if (!this.creds?.bot_token || !ticket) return
    this.ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: userId, typingTicket: ticket, status: 2, botAgent: this.botAgent })
      .catch(() => {})
  }

  /** 幂等取消：同一轮只停一次「正在输入」，超时/同步失败/turn-end 多路共用，避免重复 status=2。 */
  stopTypingOnce(pend) {
    if (!pend || pend.typingStopped) return
    pend.typingStopped = true
    this.stopTyping(pend.from)
  }

  async getTypingTicket(userId, contextToken) {
    if (this.typingTickets.has(userId)) return this.typingTickets.get(userId)
    try {
      const resp = await this.ilink.getConfig({
        baseUrl: this.creds.baseurl, token: this.creds.bot_token,
        ilinkUserId: userId, contextToken, botAgent: this.botAgent,
      })
      const t = resp?.typing_ticket ?? ''
      this.typingTickets.set(userId, t)
      return t
    } catch {
      return ''
    }
  }

  /* ------------------------------ 事件→回复 ------------------------------ */

  handleSessionEvent(session, event) {
    const sessionId = session.id
    switch (event.type) {
      case 'turn/start':
        this.turns.set(sessionId, event.data?.turn)
        break
      case 'user/message': {
        const msgId = event.data?.id
        const pend = this.pending.get(msgId)
        if (pend) {
          const collector = {
            sessionId,
            turn: event.data?.turn ?? this.turns.get(sessionId),
            msgId,
            parts: [],
            pending: pend,
          }
          pend.turn = collector.turn
          this.collectors.set(msgId, collector)
        }
        break
      }
      case 'assistant/message': {
        const c = [...this.collectors.values()].find(
          (collector) => collector.sessionId === sessionId && event.data?.turn === collector.turn,
        )
        if (!c) break
        const blocks = event.data?.message?.content ?? []
        const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
        if (texts.length) {
          if (this.cfg.replyMode === 'last') c.parts.length = 0
          c.parts.push(texts.join('\n'))
        }
        break
      }
      case 'turn/end': {
        const c = [...this.collectors.values()].find(
          (collector) => collector.sessionId === sessionId && event.data?.turn === collector.turn,
        )
        if (!c) break
        this.collectors.delete(c.msgId)
        this.turns.delete(sessionId)
        const { pending, parts, msgId } = c
        // 已超时：pending 已被超时分支移除，说明「处理超时」已发出，勿重复发送完整回复（review I1）
        if (!this.pending.has(msgId)) {
          if (pending.timer) clearTimeout(pending.timer)
          this.stopTypingOnce(pending)
          pending.resolve()
          break
        }
        this.pending.delete(msgId)
        if (pending.timer) clearTimeout(pending.timer)
        const reply = parts.join('\n').trim()
        // 模型报错且无任何助手文本（如「模型不支持图片输入」）时，不再静默吞掉：
        // 给用户一个明确提示，避免像「图片发过去没反应」这种悬空体验。
        let outText = reply
        if (!outText && event.data?.reason?.kind === 'error') {
          const emsg = event.data.reason.error?.message ?? ''
          const ecode = event.data.reason.error?.code ?? ''
          outText = /image|UNSUPPORTED_CONTENT/i.test(`${emsg} ${ecode}`)
            ? '收到你的图片了，但当前模型是纯文本模型，不支持看图 🙏（可发文字描述）'
            : `😵 处理失败：${emsg || '未知错误'}`
        }
        const send = outText
          ? this.sendReply(pending.from, pending.contextToken, outText)
          : Promise.resolve()
        send.finally(() => {
          this.stopTypingOnce(pending) // 轮次结束取消输入指示（review S12）
          pending.resolve()
        })
        break
      }
      default:
        break
    }
  }

  /* ------------------------------ 发送 ------------------------------ */

  /** 调速排队：并发发送也按队列串行预约时间片，保证任意两次发送间隔 ≥ sendIntervalMs（review S6）。 */
  async paceSend() {
    const slot = this.sendQueue.then(async () => {
      const wait = this.lastSendAt + this.cfg.sendIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastSendAt = Date.now()
    })
    this.sendQueue = slot.catch(() => {}) // 单次失败不断链
    return slot
  }

  /** @returns {Promise<boolean>} 是否全部分块发送成功（review S5）。 */
  async sendReply(to, contextToken, text) {
    try {
      for (const piece of chunkText(text, this.cfg.maxChunk)) {
        await this.paceSend() // 每个分块发送前都调速（review I2）
        await this.sendChunk(to, contextToken, piece)
      }
      this.pushLog(`发：用户 ${userTag(to)}，${String(text ?? '').length} 字`)
      return true
    } catch (err) {
      this.pushLog(`发送失败：${err?.message ?? err}`)
      return false
    }
  }

  /** 发送单个分块；独立成方法便于测试打桩计时。 */
  async sendChunk(to, contextToken, piece) {
    await this.ilink.sendMessage({
      baseUrl: this.creds.baseurl, token: this.creds.bot_token,
      to, text: piece, contextToken, botAgent: this.botAgent,
      onWarn: (w) => this.pushLog(`发送 ${w}`),
    })
  }

  /**
   * 主动推送（无需入站 contextToken）。供 ctx.weixin 服务 / 面板 /weixin/send 路由调用。
   * @param {string} to 微信用户 id；'all' 广播给所有已建会话用户
   * @param {string} text 要发送的文本（超过 maxChunk 会自动切分）
   * @returns {Promise<{sent: number, failed: number, targets: string[]}>} sent/failed 为真实发送结果（而非目标数）
   */
  async push(to, text) {
    if (!this.creds?.bot_token) throw new Error('微信通道未登录，无法推送')
    const targets = to === 'all' ? Object.keys(this.sessionMap) : [to]
    if (targets.length === 0) throw new Error('没有可推送的目标用户')
    // sent/failed 为真实发送结果，而非目标数（review S5）
    let sent = 0
    let failed = 0
    for (const t of targets) {
      if (await this.sendReply(t, undefined, text)) sent += 1
      else failed += 1
    }
    const failNote = failed > 0 ? `（失败 ${failed}）` : ''
    this.pushLog(`主动推送完成：${String(text ?? '').length} 字 → 成功 ${sent}/${targets.length}${failNote}`)
    return { sent, failed, targets }
  }

  /* ------------------------------ 面板用状态 ------------------------------ */

  statusView() {
    this.pruneLogin() // 显式清理过期的登录终态：读路径本身无副作用（review S3 观察项）
    const now = Date.now()
    const polling = !!this.status.lastPollAt
      && now - this.status.lastPollAt <= (this.cfg.pollStaleMs ?? 75_000)
    const paused = this.status.pausedUntil != null && this.status.pausedUntil > now
    return {
      accountId: this.accountId,
      folder: this.folder,
      accountRoot: this.accountRoot,
      cwd: this.cfg.cwd,
      connected: this.monitorRunning && !!this.creds?.bot_token && polling && !paused,
      loggedInAt: this.creds?.loggedInAt ?? null,
      baseUrl: this.creds?.baseurl ?? null,
      sessionMap: { ...this.sessionMap },
      lastPollAt: this.status.lastPollAt,
      lastInboundAt: this.status.lastInboundAt,
      lastEventAt: this.status.lastEventAt,
      lastError: this.status.lastError,
      processing: this.processing,
      queued: this.inbox.length,
      pausedUntil: this.status.pausedUntil,
      pauseReason: this.status.pauseReason,
      login: this.loginView(),
    }
  }

  /** 登录卡片已到终态（confirmed/error/expired）并超过宽限期，就清空 login 状态（review S3）。 */
  pruneLogin(now = Date.now()) {
    const l = this.login
    if (l?.finishedAt && now - l.finishedAt > LOGIN_DONE_GRACE_MS) {
      this.login = null
    }
  }

  /** 纯读：登录卡片视图。不修改状态，清理由 pruneLogin 显式完成。 */
  loginView() {
    const l = this.login
    if (!l) return { active: false }
    return {
      active: true,
      status: l.status,
      hasQr: !!l.qrUrl && !l.finishedAt,
      message: l.message ?? '',
      startedAt: l.startedAt,
    }
  }
}

/** 一个插件实例内的多账号运行时：每个账号拥有独立通道、轮询、存储和 cwd。 */
export class WeixinManager {
  constructor(ctx, config, {
    ilinkApi = ilink,
    autoStart = true,
    channelFactory = (channelCtx, channelConfig, store) => (
      new WeixinChannel(channelCtx, channelConfig, store, { ilinkApi, autoStart })
    ),
  } = {}) {
    this.ctx = ctx
    this.config = config
    this.log = ctx.logger ?? console
    const normalized = normalizeAccounts(config)
    this.stateDir = normalized.stateDir
    this.accountRoot = normalized.accountRoot
    this.defaultAccountId = normalized.defaultAccountId
    this.channels = new Map()

    for (const account of normalized.accounts) {
      if (account.cwd) {
        if (this.accountRoot) ensureAccountWorkspace(this.accountRoot, account.folder)
        else fs.mkdirSync(account.cwd, { recursive: true })
      }
      const store = createAccountStore(this.stateDir, account.id, {
        migrateLegacy: account.id === this.defaultAccountId,
      })
      const channelConfig = {
        ...config,
        accountId: account.id,
        accountRoot: this.accountRoot,
        stateDir: account.stateDir,
        folder: account.folder,
        cwd: account.cwd,
      }
      this.channels.set(account.id, channelFactory(ctx, channelConfig, store))
    }
    ctx.on?.('dispose', () => this.stop())
  }

  account(accountId = '') {
    const id = accountId ? assertAccountId(accountId) : this.defaultAccountId
    const channel = this.channels.get(id)
    if (!channel) throw new Error(`账号不存在：${id}`)
    return channel
  }

  accountIds() {
    return [...this.channels.keys()]
  }

  async stop() {
    await Promise.allSettled([...this.channels.values()].map((channel) => channel.stop()))
  }
}

export function apply(ctx, config) {
  const manager = new WeixinManager(ctx, config)
  registerPanel(ctx, manager)
  // 对外暴露主动推送能力：其它插件 inject ['weixin'] 后用 ctx.weixin.push / sendAll
  ctx.provide('weixin', {
    push: (to, text, accountId) => manager.account(accountId).push(to, text),
    sendAll: (text, accountId) => manager.account(accountId).push('all', text),
    status: (accountId) => manager.account(accountId).statusView(),
    sessions: (accountId) => ({ ...manager.account(accountId).sessionMap }),
    accounts: () => manager.accountIds().map((id) => ({
      id,
      ...manager.account(id).statusView(),
    })),
  })
  registerPushTool(ctx, manager)
}

/** 注册 push_weixin 主动推送工具：把 channel.push 暴露给任意 agent（含 DSH schedule 定时触发回合）。 */
export function registerPushTool(ctx, source) {
  const isManager = typeof source?.account === 'function' && typeof source?.accountIds === 'function'
  const accountIds = () => (isManager ? source.accountIds() : [source?.accountId ?? DEFAULT_ACCOUNT_ID])
  const account = (accountId = '') => (isManager ? source.account(accountId) : source)
  const ownerAccount = (sessionId) => {
    for (const id of accountIds()) {
      const channel = account(id)
      const owner = Object.keys(channel.sessionMap ?? {}).find(
        (userId) => channel.sessionMap[userId] === sessionId,
      )
      if (owner) return { accountId: id, userId: owner }
    }
    return null
  }

  return ctx.tools.register({
    name: 'push_weixin',
    description: '主动发送一条文本消息到微信。可按 accountId 选择微信账号；to 为微信用户 id；"all" = 广播给该账号所有已建会话用户；省略 = 发给触发本工具的会话所属微信用户。适合定时任务、告警等主动触达场景。',
    parameters: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '微信账号 ID；省略时按会话归属或默认账号自动选择' },
        to: { type: 'string', description: '微信用户 id（如 user@im.wechat）；"all" 广播所有已建会话；省略 = 触发本工具的会话所属用户' },
        text: { type: 'string', description: '要发送的文本（超过 maxChunk 自动切分）' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'number' },
          failed: { type: 'number' },
          targets: { type: 'array', items: { type: 'string' } },
        },
        required: ['sent', 'failed', 'targets'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `微信推送结果：成功 ${value?.sent ?? 0}，失败 ${value?.failed ?? 0}（目标 ${value?.targets?.length ?? 0}）`,
      }],
    },
    async execute(args, exec) {
      const explicit = args.to && String(args.to).trim()
      const requestedAccount = args.accountId && String(args.accountId).trim()
      const sid = exec?.agent?.id
      const owner = sid ? ownerAccount(sid) : null
      if (requestedAccount && owner && owner.accountId !== requestedAccount) {
        throw new Error(`会话属于账号 ${owner.accountId}，不能通过账号 ${requestedAccount} 发送`)
      }
      const channel = account(requestedAccount || owner?.accountId || '')
      let to = explicit || null
      if (!to) {
        // 缺省时优先发给触发本工具的会话所属微信用户（schedule 到点醒来正好对应该用户），否则该账号广播
        to = owner?.userId || 'all'
      }
      return channel.push(to, String(args.text ?? ''))
    },
  })
}
