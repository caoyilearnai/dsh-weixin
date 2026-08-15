/**
 * 核心关联逻辑测试：不依赖真实微信，用合成 session 事件验证
 * pending 关联 → assistant/message 收集 → turn/end 结算 → sendReply。
 *
 * 运行：node --test（或 npm test）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinChannel, chunkText } from '../src/index.mjs'
import { resolveWorkspaceDir } from '../src/creds.mjs'
import { normalizeInboundMessages } from '../src/ilink.mjs'

function makeStore() {
  return {
    loadCredentials: () => null,
    loadSessionMap: () => ({}),
    loadBuf: () => '',
    saveBuf: () => {},
    saveSessionMap: () => {},
    saveCredentials: () => {},
  }
}

function makeCtx() {
  return { on: () => {}, get: () => undefined, logger: console }
}

function makeChannel(config = {}) {
  const cfg = {
    cwd: '/tmp',
    stateDir: '',
    replyMode: 'full',
    replyTimeoutMs: 60_000,
    maxChunk: 1500,
    sendIntervalMs: 0,
    ...config,
  }
  const ch = new WeixinChannel(makeCtx(), cfg, makeStore())
  const sent = []
  ch.sendReply = async (to, contextToken, text) => { sent.push({ to, text }) }
  ch.sent = sent
  return ch
}

const FROM = 'wechat-user-1@im.wechat'
const SESSION = 'session-test-1'
const tick = () => new Promise((r) => setTimeout(r, 0))

test('整轮助手文本合并回复，并正确关联用户', async () => {
  const ch = makeChannel()
  const msgId = 'msg-1'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })

  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 1 } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先查一下…' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '最终回复内容' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 1)
  assert.equal(ch.sent[0].to, FROM)
  assert.equal(ch.sent[0].text, '我先查一下…\n最终回复内容')
  assert.equal(ch.pending.has(msgId), false)
  assert.equal(ch.collector, null)
})

test('错误会话的事件不触发回复，也不清理 pending', async () => {
  const ch = makeChannel()
  const msgId = 'msg-2'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })

  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 2 } })
  ch.handleSessionEvent({ id: 'session-other' }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '不该发' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 0)
  assert.equal(ch.pending.has(msgId), true)
})

test('replyMode=last 只回最后一条助手文本', async () => {
  const ch = makeChannel({ replyMode: 'last' })
  const msgId = 'msg-3'
  ch.pending.set(msgId, { from: FROM, contextToken: 'tok', sessionId: SESSION, resolve: () => {}, timer: null })

  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/start', data: { turn: 3 } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'user/message', data: { id: msgId } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '中间过程' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'assistant/message', data: { turn: 3, step: 2, message: { content: [{ type: 'text', text: '结论' }] } } })
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(ch.sent.length, 1)
  assert.equal(ch.sent[0].text, '结论')
})

test('长文本按 maxChunk 切分', () => {
  assert.deepEqual(chunkText('x'.repeat(1600), 1500), ['x'.repeat(1500), 'x'.repeat(100)])
  assert.deepEqual(chunkText('短文本', 1500), ['短文本'])
  // 在换行处切分：第一块在行边界干净结束，换行落在第二块开头
  const s = 'a'.repeat(800) + '\n' + 'b'.repeat(800)
  const parts = chunkText(s, 1500)
  assert.equal(parts.length, 2)
  assert.equal(parts[0], 'a'.repeat(800))
  assert.equal(parts[1].startsWith('\n'), true)
  // max<=0 保护
  assert.equal(chunkText('abc', 0).length, 1)
})

test('followup 同步抛错：清理 pending 并回错误提示', async () => {
  const ch = makeChannel()
  ch.getTypingTicket = async () => '' // 跳过 typing，避免网络
  ch.ensureAgentFor = async () => ({
    id: 'session-throw',
    followup() { throw new Error('boom') },
  })

  await ch.handleInbound({ from: FROM, to: 'bot@im.bot', contextToken: 'tok', text: 'hi', hasText: true })

  assert.equal(ch.sent.length, 1)
  assert.match(ch.sent[0].text, /处理失败/)
  assert.match(ch.sent[0].text, /boom/)
  assert.equal(ch.pending.size, 0)
})

test('push 主动推送：未登录时抛错', async () => {
  const ch = makeChannel()
  await assert.rejects(() => ch.push('u1@im.wechat', 'hi'), /未登录/)
})

test('push 主动推送：单用户与 all 广播', async () => {
  const ch = makeChannel()
  ch.creds = { bot_token: 'tok', baseurl: 'https://ilinkai.weixin.qq.com' }
  ch.sessionMap = { 'u1@im.wechat': 's1', 'u2@im.wechat': 's2' }

  const r1 = await ch.push('u1@im.wechat', '你好')
  assert.equal(r1.sent, 1)
  assert.deepEqual(r1.targets, ['u1@im.wechat'])
  assert.equal(ch.sent.length, 1)
  assert.equal(ch.sent[0].to, 'u1@im.wechat')
  assert.equal(ch.sent[0].text, '你好')

  ch.sent.length = 0
  const r2 = await ch.push('all', '广播')
  assert.equal(r2.sent, 2)
  assert.equal(ch.sent.length, 2)
})

test('resolveWorkspaceDir：空值回落到 stateDir/workspace，显式值用显式', () => {
  assert.equal(resolveWorkspaceDir('', '/tmp/state'), '/tmp/state/workspace')
  assert.equal(resolveWorkspaceDir('/custom/ws', '/tmp/state'), '/custom/ws')
})

test('超时后 turn/end 不重复发送（review I1）', async () => {
  const ch = makeChannel()
  let resolved = false
  // 模拟超时已发生：pending 已从 map 移除，collector 仍残留旧引用
  ch.collector = {
    sessionId: SESSION,
    turn: 9,
    msgId: 'msg-timeout',
    parts: ['迟到的完整回复'],
    pending: { from: FROM, contextToken: 'tok', resolve: () => { resolved = true }, timer: null },
  }
  ch.handleSessionEvent({ id: SESSION }, { type: 'turn/end', data: { turn: 9 } })
  await tick()

  assert.equal(ch.sent.length, 0) // 不重复发送完整回复
  assert.equal(resolved, true)    // 仍 resolve，避免 handleInbound 悬挂
  assert.equal(ch.collector, null)
})

test('sendReply 分块之间也执行调速（review I2）', async () => {
  const ch = makeChannel({ sendIntervalMs: 40, maxChunk: 10 })
  const times = []
  ch.sendChunk = async () => { times.push(Date.now()) }
  ch.sendReply = WeixinChannel.prototype.sendReply // makeChannel 覆盖过，换回真实实现
  await ch.sendReply(FROM, undefined, 'x'.repeat(15)) // 切成 10 + 5 两块

  assert.equal(times.length, 2)
  assert.ok(times[1] - times[0] >= 30, `分块间隔应 ≥ sendIntervalMs，实际 ${times[1] - times[0]}ms`)
})

test('chunkText 不切开 emoji 代理对（review S4）', () => {
  const parts = chunkText('a'.repeat(4) + '😀' + 'a'.repeat(4), 5)
  assert.ok(parts.length >= 2)
  assert.equal(parts[0], 'aaaa') // 修复后 cut 退到 emoji 前，emoji 完整进入下一块
  for (const p of parts) {
    assert.doesNotMatch(p, /[\ud800-\udbff]$/, `以高位代理结尾（半个字符）：${JSON.stringify(p)}`)
    assert.doesNotMatch(p, /^[\udc00-\udfff]/, `以低位代理开头（半个字符）：${JSON.stringify(p)}`)
  }
})

test('normalizeInboundMessages：文本/非文本/空响应（review S10）', () => {
  assert.deepEqual(normalizeInboundMessages({}), [])
  assert.deepEqual(normalizeInboundMessages(null), [])
  const out = normalizeInboundMessages({
    msgs: [
      { from_user_id: 'u1', to_user_id: 'bot', context_token: 'c1', item_list: [{ type: 1, text_item: { text: '你好' } }] },
      { from_user_id: 'u2', to_user_id: 'bot', context_token: 'c2', item_list: [{ type: 3, text_item: {} }] },
      { from_user_id: '', item_list: [{ type: 1, text_item: { text: '无 from 忽略' } }] },
    ],
  })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { from: 'u1', to: 'bot', contextToken: 'c1', text: '你好', hasText: true, nonTextTypes: [] })
  assert.deepEqual(out[1], { from: 'u2', to: 'bot', contextToken: 'c2', text: '', hasText: false, nonTextTypes: [3] })
})