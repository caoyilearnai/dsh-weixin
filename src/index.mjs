/**
 * dsh-weixin：微信 ClawBot (iLink) 通道插件（标准 cordis bundle 形态）。
 *
 * 数据流：
 *   iLink getupdates 长轮询收消息 → 按微信用户映射/创建 Harness 会话
 *   → agent.followup(userMessage) 原生注入
 *   → 订阅 session/event（user/message 按 id 关联 → assistant/message 收集
 *     → turn/end 结算）→ sendmessage 回微信（带 context_token）
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import * as ilink from './ilink.mjs'
import { createStore, resolveStateDir } from './creds.mjs'
import { registerPanel } from './panel.mjs'

export const name = 'dsh-weixin'
/** 硬依赖：面板需要 webServer；通道需要 agents（查找/创建/恢复代理）。agentPresets 为可选探测。 */
export const inject = ['webServer', 'agents']

/** 可配置参数（默认值即 schema 默认，可在 cordis.yml 覆盖）。 */
export const Config = Schema.object({
  // 新会话的工作目录（绝对路径）
  cwd: Schema.string().default(process.cwd()),
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
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function chunkText(text, max) {
  const limit = Math.max(1, Math.floor(max || 1500))
  const out = []
  let rest = text ?? ''
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
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

/** 微信用户 → Harness 会话的通道。一个插件实例含一个长轮询 loop 与若干按用户隔离的会话。 */
export class WeixinChannel {
  constructor(ctx, config, store) {
    this.ctx = ctx
    this.cfg = config
    this.store = store
    this.log = ctx.logger ?? console
    this.creds = store.loadCredentials()
    this.sessionMap = store.loadSessionMap()
    this.buf = store.loadBuf()
    this.botAgent = 'DeepSeek Harness Weixin Channel'
    this.typingTickets = new Map()
    this.turns = new Map() // sessionId -> current turn
    this.pending = new Map() // userMessage.id -> {from, contextToken, sessionId, resolve, timer}
    this.collector = null // { sessionId, turn, msgId, parts, pending }
    this.lastSendAt = 0
    this.stopped = false
    this.monitorRunning = false
    this.monitorAbort = new AbortController()
    this.status = { baseUrl: null, lastEventAt: null, lastError: null, startedAt: Date.now() }
    this.logs = [] // ring buffer
    this.login = null // 面板登录流程状态

    this.ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event))
    this.ctx.on('dispose', () => this.stop())

    if (this.creds?.bot_token) {
      this.startMonitor()
    } else {
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
    const cred = this.creds
    cred.baseurl = cred.baseurl || ilink.DEFAULT_BASE_URL
    this.status.baseUrl = cred.baseurl
    this.monitorRunning = true
    this.pushLog('微信通道启动（iLink 长轮询）')
    try {
      await ilink.notifyStart({ baseUrl: cred.baseurl, token: cred.bot_token, botAgent: this.botAgent })
    } catch { /* 通知失败不阻塞 */ }

    let failures = 0
    while (!this.stopped && !this.monitorAbort.signal.aborted) {
      try {
        const resp = await ilink.getUpdates({
          baseUrl: cred.baseurl, token: cred.bot_token, buf: this.buf, botAgent: this.botAgent,
        })
        failures = 0
        this.status.lastEventAt = Date.now()
        if (typeof resp?.get_updates_buf === 'string' && resp.get_updates_buf) {
          this.buf = resp.get_updates_buf
          this.store.saveBuf(this.buf)
        }
        for (const msg of ilink.normalizeInboundMessages(resp)) {
          await this.handleInbound(msg)
        }
      } catch (err) {
        failures += 1
        this.status.lastError = err?.message ?? String(err)
        const wait = Math.min(1000 * failures, 15_000)
        this.pushLog(`长轮询异常（${failures}）：${err?.message ?? err}`)
        await sleep(wait)
      }
    }
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.monitorAbort.abort()
    this.monitorRunning = false
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.pushLog('微信通道已停止')
  }

  /** 登录成功后应用新凭证并重启监视循环。 */
  applyCredentials(cred) {
    this.creds = { ...cred, baseurl: cred.baseurl || ilink.DEFAULT_BASE_URL }
    this.store.saveCredentials(this.creds)
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.stopped = false
    this.startMonitor()
  }

  /** 登出：清凭证 + 下线通知 + 停监视。 */
  async clearCredentials() {
    if (this.creds?.bot_token) {
      try {
        await ilink.notifyStop({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, botAgent: this.botAgent })
      } catch { /* ignore */ }
    }
    this.monitorAbort.abort()
    this.monitorAbort = new AbortController()
    this.monitorRunning = false
    this.creds = null
    this.store.saveCredentials(null)
    this.pushLog('已登出')
  }

  /* ------------------------------ 会话/代理 ------------------------------ */

  async composeSetup() {
    const presets = this.ctx.get('agentPresets')
    if (!presets) return undefined
    return async (agentCtx) => {
      try {
        const resolved = await presets.resolve(undefined)
        if (resolved?.id) await presets.mount(agentCtx, resolved.id)
      } catch (err) {
        this.pushLog(`agentPresets 装配失败（用默认）：${err?.message ?? err}`)
      }
    }
  }

  /** 微信用户 → 会话/代理。已有则复用；持久化会话则恢复；否则新建。 */
  async ensureAgentFor(userId) {
    const sessionId = this.sessionMap[userId]
    if (sessionId) {
      const live = this.ctx.agents.get(sessionId)
      if (live) return live
      try {
        const { agent } = await this.ctx.agents.resume({
          resumeSessionId: sessionId, agentOptions: {}, setup: await this.composeSetup(),
        })
        this.pushLog(`恢复持久化会话 ${sessionId}（${userId.slice(0, 12)}…）`)
        return agent
      } catch (err) {
        this.pushLog(`恢复会话 ${sessionId} 失败：${err?.message ?? err}，将新建`)
      }
    }

    const newId = `session-${randomUUID()}`
    try {
      const { agent } = await this.ctx.agents.create({
        sessionId: newId,
        agentOptions: {},
        meta: { cwd: this.cfg.cwd },
        setup: await this.composeSetup(),
      })
      this.sessionMap[userId] = newId
      this.store.saveSessionMap(this.sessionMap)
      this.pushLog(`为 ${userId.slice(0, 12)}… 新建会话 ${newId}`)
      return agent
    } catch (err) {
      this.pushLog(`新建会话失败：${err?.message ?? err}`)
      throw err
    }
  }

  /* ------------------------------ 入站处理 ------------------------------ */

  async handleInbound(msg) {
    const { from, to, contextToken, text, hasText } = msg
    if (!to?.endsWith('@im.bot')) return

    if (!hasText) {
      await this.sendReply(from, contextToken, '当前仅支持文字消息，图片/语音/文件暂不支持 🙏')
      return
    }
    this.pushLog(`收：${from.slice(0, 12)}… ${text.slice(0, 60)}`)

    // 正在输入提示
    const ticket = await this.getTypingTicket(from, contextToken)
    if (ticket) {
      await ilink.sendTyping({ baseUrl: this.creds.baseurl, token: this.creds.bot_token, to: from, typingTicket: ticket, status: 1, botAgent: this.botAgent }).catch(() => {})
    }

    let agent
    try {
      agent = await this.ensureAgentFor(from)
    } catch (err) {
      await this.sendReply(from, contextToken, `😵 会话准备失败：${err?.message ?? err}`)
      return
    }

    const userMessage = makeUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-weixin' },
    })

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(userMessage.id)
        this.sendReply(from, contextToken, '⏰ 处理超时，请稍后再试').finally(resolve)
      }, this.cfg.replyTimeoutMs)
      this.pending.set(userMessage.id, { from, contextToken, sessionId: agent.id, resolve, timer })
      agent.followup(userMessage)
    })
  }

  async getTypingTicket(userId, contextToken) {
    if (this.typingTickets.has(userId)) return this.typingTickets.get(userId)
    try {
      const resp = await ilink.getConfig({
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
          this.collector = { sessionId, turn: this.turns.get(sessionId), msgId, parts: [], pending: pend }
        }
        break
      }
      case 'assistant/message': {
        const c = this.collector
        if (!c || c.sessionId !== sessionId || event.data?.turn !== c.turn) break
        const blocks = event.data?.message?.content ?? []
        const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
        if (texts.length) {
          if (this.cfg.replyMode === 'last') c.parts.length = 0
          c.parts.push(texts.join('\n'))
        }
        break
      }
      case 'turn/end': {
        const c = this.collector
        if (!c || c.sessionId !== sessionId || event.data?.turn !== c.turn) break
        this.collector = null
        const { pending, parts, msgId } = c
        this.pending.delete(msgId)
        if (pending.timer) clearTimeout(pending.timer)
        const reply = parts.join('\n').trim()
        const send = reply
          ? this.sendReply(pending.from, pending.contextToken, reply)
          : Promise.resolve()
        send.finally(() => pending.resolve())
        break
      }
      default:
        break
    }
  }

  /* ------------------------------ 发送 ------------------------------ */

  async paceSend() {
    const wait = this.lastSendAt + this.cfg.sendIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastSendAt = Date.now()
  }

  async sendReply(to, contextToken, text) {
    try {
      await this.paceSend()
      for (const piece of chunkText(text, this.cfg.maxChunk)) {
        await ilink.sendMessage({
          baseUrl: this.creds.baseurl, token: this.creds.bot_token,
          to, text: piece, contextToken, botAgent: this.botAgent,
          onWarn: (w) => this.pushLog(`发送 ${w}`),
        })
      }
      this.pushLog(`发：${to.slice(0, 12)}… ${text.slice(0, 60)}`)
    } catch (err) {
      this.pushLog(`发送失败：${err?.message ?? err}`)
    }
  }

  /* ------------------------------ 面板用状态 ------------------------------ */

  statusView() {
    return {
      connected: this.monitorRunning && !!this.creds?.bot_token,
      loggedInAt: this.creds?.loggedInAt ?? null,
      baseUrl: this.creds?.baseurl ?? null,
      sessionMap: { ...this.sessionMap },
      lastEventAt: this.status.lastEventAt,
      lastError: this.status.lastError,
      login: this.loginView(),
    }
  }

  loginView() {
    const l = this.login
    if (!l) return { active: false }
    return {
      active: true,
      status: l.status,
      hasQr: !!l.qrUrl,
      message: l.message ?? '',
      startedAt: l.startedAt,
    }
  }
}

export function apply(ctx, config) {
  const store = createStore(resolveStateDir(config.stateDir))
  const channel = new WeixinChannel(ctx, config, store)
  registerPanel(ctx, channel)
}