/**
 * sendMessage 限流重试测试（review S10）：
 * 通过注入 post/backoffBaseMs 避免真实网络与真实退避等待。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { getUpdates, sendMessage, ILinkError } from '../src/ilink.mjs'

const BASE = { baseUrl: 'https://example.invalid', token: 't', to: 'u@im.wechat', text: 'hi' }

test('sendMessage 限流（ret=-2）指数退避重试后成功（review S10）', async () => {
  let calls = 0
  const post = async () => {
    calls += 1
    if (calls < 3) return { ret: -2, errmsg: 'rate limited' }
    return { ret: 0 }
  }
  const resp = await sendMessage({ ...BASE, post, backoffBaseMs: 1 })
  assert.equal(resp.ret, 0)
  assert.equal(calls, 3) // 前两次限流重试，第三次成功
})

test('sendMessage 非限流业务错误立即失败不重试（review S10）', async () => {
  let calls = 0
  const post = async () => { calls += 1; return { ret: -1001, errmsg: 'invalid token' } }
  await assert.rejects(() => sendMessage({ ...BASE, post, backoffBaseMs: 1 }), ILinkError)
  assert.equal(calls, 1)
})

test('sendMessage 网络错误重试至耗尽后抛出（review S10）', async () => {
  let calls = 0
  const post = async () => { calls += 1; throw new TypeError('fetch failed') }
  await assert.rejects(
    () => sendMessage({ ...BASE, post, backoffBaseMs: 1, maxAttempts: 2 }),
    /fetch failed/,
  )
  assert.equal(calls, 2)
})

test('getUpdates surfaces ret=-14 as a typed business error', async () => {
  const post = async () => ({ ret: -14, errmsg: 'session expired' })
  await assert.rejects(
    () => getUpdates({
      baseUrl: BASE.baseUrl,
      token: BASE.token,
      post,
    }),
    (err) => err instanceof ILinkError && err.ret === -14,
  )
})

test('getUpdates treats a non-zero errcode as a business error', async () => {
  const post = async () => ({ ret: 0, errcode: -14, errmsg: 'session expired' })
  await assert.rejects(
    () => getUpdates({
      baseUrl: BASE.baseUrl,
      token: BASE.token,
      post,
    }),
    (err) => err instanceof ILinkError && err.errcode === -14,
  )
})
