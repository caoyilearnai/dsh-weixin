import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WeixinManager } from '../src/index.mjs'
import { createAccountStore } from '../src/accounts.mjs'
import * as realILink from '../src/ilink.mjs'

function makeCtx() {
  return {
    on: () => {},
    effect: () => {},
    get: () => undefined,
    logger: console,
  }
}

function waitFor(predicate, label, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待条件超时（${label}, ${timeoutMs}ms）`))
      }
    }, 10)
  })
}

test('manager isolates credentials, sessions, cursors, and cwd per account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-manager-'))
  try {
    for (const id of ['primary', 'family']) {
      const store = createAccountStore(root, id)
      store.saveCredentials({ bot_token: `token-${id}`, baseurl: 'https://example.invalid' })
      store.saveSessionMap({ [`${id}@im.wechat`]: `session-${id}` })
      store.saveBuf(`cursor-${id}`)
    }

    const manager = new WeixinManager(
      makeCtx(),
      {
        stateDir: root,
        accountRoot: root,
        replyMode: 'full',
        replyTimeoutMs: 60_000,
        maxChunk: 1500,
        sendIntervalMs: 0,
        accounts: [
          { id: 'primary', folder: 'alice' },
          { id: 'family', folder: 'bob' },
        ],
      },
      { autoStart: false },
    )

    const primary = manager.account('primary')
    const family = manager.account('family')
    assert.notEqual(primary, family)
    assert.equal(manager.account(), primary)
    assert.equal(primary.accountId, 'primary')
    assert.equal(primary.folder, 'alice')
    assert.equal(family.folder, 'bob')
    assert.equal(primary.cfg.cwd, path.join(root, 'alice'))
    assert.equal(family.cfg.cwd, path.join(root, 'bob'))
    assert.equal(fs.statSync(primary.cfg.cwd).isDirectory(), true)
    assert.equal(fs.statSync(family.cfg.cwd).isDirectory(), true)
    assert.deepEqual(primary.sessionMap, { 'primary@im.wechat': 'session-primary' })
    assert.deepEqual(family.sessionMap, { 'family@im.wechat': 'session-family' })
    assert.equal(primary.buf, 'cursor-primary')
    assert.equal(family.buf, 'cursor-family')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('one account can finish while another account is still processing a turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-concurrent-'))
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    get: () => undefined,
    logger: console,
    agents: {
      get: () => undefined,
      async create({ sessionId: id, meta }) {
        return {
          agent: {
            id,
            followup(message) {
              followups.push({
                account: path.basename(meta.cwd).replace(/^work-/, ''),
                sessionId: id,
                message,
              })
            },
          },
        }
      },
      async resume() {
        throw new Error('unexpected resume')
      },
    },
  }
  const followups = []
  const sent = []
  const queues = new Map([
    ['token-primary', [{
      from_user_id: 'shared-user@im.wechat',
      to_user_id: 'primary-bot@im.bot',
      context_token: 'ctx-primary',
      item_list: [{ type: 1, text_item: { text: 'primary message' } }],
    }]],
    ['token-family', [{
      from_user_id: 'shared-user@im.wechat',
      to_user_id: 'family-bot@im.bot',
      context_token: 'ctx-family',
      item_list: [{ type: 1, text_item: { text: 'family message' } }],
    }]],
  ])
  const api = {
    ...realILink,
    async notifyStart() {},
    async notifyStop() {},
    async getConfig() { return { typing_ticket: '' } },
    async sendTyping() { return { ret: 0 } },
    async sendMessage({ token, to, text }) {
      sent.push({ token, to, text })
      return { ret: 0 }
    },
    getUpdates({ token, signal }) {
      const queue = queues.get(token) ?? []
      if (queue.length) return Promise.resolve({ ret: 0, msgs: [queue.shift()] })
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ret: 0, msgs: [] }), { once: true })
      })
    },
  }

  let manager
  try {
    for (const id of ['primary', 'family']) {
      const store = createAccountStore(root, id)
      store.saveCredentials({ bot_token: `token-${id}`, baseurl: 'https://example.invalid' })
    }
    manager = new WeixinManager(
      ctx,
      {
        stateDir: root,
        replyMode: 'full',
        replyTimeoutMs: 60_000,
        maxChunk: 1500,
        sendIntervalMs: 0,
        accounts: [
          { id: 'primary', cwd: path.join(root, 'work-primary') },
          { id: 'family', cwd: path.join(root, 'work-family') },
        ],
      },
      { ilinkApi: api },
    )

    await waitFor(() => followups.length === 2, 'both accounts receive a message')
    assert.deepEqual(followups.map((item) => item.account).sort(), ['family', 'primary'])

    const family = followups.find((item) => item.account === 'family')
    const emit = (session, event) => {
      for (const handler of handlers.get('session/event') ?? []) handler(session, event)
    }
    emit({ id: family.sessionId }, { type: 'turn/start', data: { turn: 1 } })
    emit({ id: family.sessionId }, { type: 'user/message', data: { id: family.message.id } })
    emit({ id: family.sessionId }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'family reply' }] } },
    })
    emit({ id: family.sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    await waitFor(() => sent.length === 1, 'family reply is sent')
    assert.deepEqual(sent[0], {
      token: 'token-family',
      to: 'shared-user@im.wechat',
      text: 'family reply',
    })
    assert.equal(manager.account('primary').pending.size, 1)

    await manager.stop()
    manager = new WeixinManager(
      ctx,
      {
        stateDir: root,
        accounts: [
          { id: 'primary', cwd: path.join(root, 'work-primary') },
          { id: 'family', cwd: path.join(root, 'work-family') },
        ],
      },
      { autoStart: false },
    )
    assert.deepEqual(manager.account('primary').sessionMap, {
      'shared-user@im.wechat': followups.find((item) => item.account === 'primary').sessionId,
    })
    assert.deepEqual(manager.account('family').sessionMap, {
      'shared-user@im.wechat': family.sessionId,
    })
    assert.notEqual(
      manager.account('primary').sessionMap['shared-user@im.wechat'],
      manager.account('family').sessionMap['shared-user@im.wechat'],
    )
  } finally {
    await manager?.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a failing account polling loop does not stop another account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-failure-'))
  const followups = []
  const ctx = {
    on: () => {},
    get: () => undefined,
    logger: console,
    agents: {
      get: () => undefined,
      async create({ sessionId, meta }) {
        return {
          agent: {
            id: sessionId,
            followup(message) { followups.push({ cwd: meta.cwd, message }) },
          },
        }
      },
      async resume() { throw new Error('unexpected resume') },
    },
  }
  const familyMessage = {
    from_user_id: 'shared-user@im.wechat',
    to_user_id: 'family-bot@im.bot',
    context_token: 'ctx-family',
    item_list: [{ type: 1, text_item: { text: 'family survives' } }],
  }
  let familyDelivered = false
  const api = {
    ...realILink,
    async notifyStart() {},
    async notifyStop() {},
    async getConfig() { return { typing_ticket: '' } },
    getUpdates({ token, signal }) {
      if (token === 'token-primary') throw new Error('primary polling failed')
      if (!familyDelivered) {
        familyDelivered = true
        return Promise.resolve({ ret: 0, msgs: [familyMessage] })
      }
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ret: 0, msgs: [] }), { once: true })
      })
    },
  }

  let manager
  try {
    for (const id of ['primary', 'family']) {
      const store = createAccountStore(root, id)
      store.saveCredentials({ bot_token: `token-${id}`, baseurl: 'https://example.invalid' })
    }
    manager = new WeixinManager(
      ctx,
      {
        stateDir: root,
        replyMode: 'full',
        replyTimeoutMs: 60_000,
        maxChunk: 1500,
        sendIntervalMs: 0,
        accounts: [
          { id: 'primary', cwd: path.join(root, 'work-primary') },
          { id: 'family', cwd: path.join(root, 'work-family') },
        ],
      },
      { ilinkApi: api },
    )

    await waitFor(
      () => followups.some((item) => item.cwd === path.join(root, 'work-family')),
      'healthy account keeps polling after the other fails',
      500,
    )
    assert.equal(followups.length, 1)
    assert.equal(followups[0].message.content[0].text, 'family survives')
  } finally {
    await manager?.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
