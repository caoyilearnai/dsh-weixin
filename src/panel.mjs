/**
 * /weixin 网页面板：连接状态、扫码登录（含验证码）、会话映射、日志。
 * 由主机端插件提供（同一个 webserver），无需客户端插件构建。
 *
 * 路由（均挂在 /weixin 前缀下）：
 *   GET  /weixin         面板 HTML
 *   GET  /weixin/status  状态 JSON（含登录流程状态）
 *   GET  /weixin/qr.svg  登录二维码 SVG
 *   POST /weixin/login   发起扫码登录
 *   POST /weixin/verifycode  提交手机端验证码
 *   POST /weixin/logout  登出
 *   POST /weixin/send    主动推送（JSON: {to, text}，to 可用 'all' 广播）
 *   GET  /weixin/logs    最近日志
 */

import qrcode from 'qrcode-generator'
import * as ilink from './ilink.mjs'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_QR_REFRESH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ HTTP 工具 ------------------------------ */

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function sendText(res, text, contentType = 'text/plain; charset=utf-8', status = 200) {
  res.writeHead(status, { 'content-type': contentType })
  res.end(text)
}

const MAX_BODY_BYTES = 1024 * 1024 // 1MB 上限，防止超大请求体撑内存

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        const err = new Error('请求体过大，已拒绝')
        err.statusCode = 413 // 语义上应为 Payload Too Large 而非 500（review 二轮小疵）
        reject(err)
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', (err) => reject(err))
  })
}

/** qrcode-generator 矩阵 → SVG 字符串。 */
function qrSvg(text, size = 320) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const cell = size / (n + 2 * 4)
  let cells = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        cells += `<rect x="${(c + 4) * cell}" y="${(r + 4) * cell}" width="${cell + 0.4}" height="${cell + 0.4}"/>`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${cells}</svg>`
}

/* ------------------------------ 登录流程 ------------------------------ */

async function startLogin(channel, folder) {
  channel.prepareLoginFolder?.(folder)
  if (channel.login?.poller) {
    return { started: true, message: '登录流程已在运行' }
  }
  const localTokenList = channel.creds?.bot_token ? [channel.creds.bot_token] : []
  const qr = await ilink.fetchQRCode({ localTokenList })
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error(`get_bot_qrcode 响应缺少字段：${JSON.stringify(qr).slice(0, 200)}`)
  }
  const login = {
    status: 'wait',
    qrCode: qr.qrcode,
    qrUrl: qr.qrcode_img_content,
    apiBaseUrl: ilink.DEFAULT_BASE_URL,
    pendingVerifyCode: undefined,
    qrRefreshCount: 0,
    startedAt: Date.now(),
    message: '请用手机微信扫描二维码',
    poller: null,
  }
  channel.login = login
  channel.pushLog('面板发起扫码登录')
  login.poller = pollLogin(channel, login)
  return { started: true, message: '登录流程已启动' }
}

async function pollLogin(channel, login) {
  try {
    let failures = 0
    while (Date.now() - login.startedAt < LOGIN_TIMEOUT_MS) {
      let status
      try {
        status = await ilink.pollQRStatus({ baseUrl: login.apiBaseUrl, qrcode: login.qrCode, verifyCode: login.pendingVerifyCode })
        failures = 0
      } catch (err) {
        // 瞬时网络错误容忍：连续 3 次才终止登录，避免一次抖动废掉整个流程（review 二轮 N2）
        failures += 1
        if (failures >= 3) throw err
        channel.pushLog(`登录轮询瞬时错误（${failures}/3）：${err?.message ?? err}，稍后重试`)
        await sleep(1000 * failures)
        continue
      }
      switch (status.status) {
        case 'wait':
          break
        case 'scaned':
          if (login.pendingVerifyCode) login.pendingVerifyCode = undefined
          login.status = 'scaned'
          login.message = '已扫码，正在验证…'
          break
        case 'need_verifycode':
          login.status = 'need_verifycode'
          login.message = login.pendingVerifyCode
            ? '验证码不匹配，请在手机微信查看并重新输入'
            : '手机微信上显示了数字验证码，请在面板输入'
          return // 等待面板提交验证码（submitVerifyCode 会继续轮询）
        case 'expired': {
          login.qrRefreshCount += 1
          if (login.qrRefreshCount > MAX_QR_REFRESH) {
            login.status = 'expired'
            login.message = '二维码多次过期，请重新发起登录'
            return
          }
          const qr = await ilink.fetchQRCode({ localTokenList: channel.creds?.bot_token ? [channel.creds.bot_token] : [] })
          login.qrCode = qr?.qrcode ?? login.qrCode
          login.qrUrl = qr?.qrcode_img_content ?? login.qrUrl
          login.pendingVerifyCode = undefined
          login.message = '二维码已刷新，请重新扫描'
          break
        }
        case 'verify_code_blocked':
          login.pendingVerifyCode = undefined
          login.status = 'need_verifycode'
          login.message = '验证码错误次数过多，请重新扫描（二维码已刷新）'
          {
            const qr = await ilink.fetchQRCode({ localTokenList: channel.creds?.bot_token ? [channel.creds.bot_token] : [] })
            login.qrCode = qr?.qrcode ?? login.qrCode
            login.qrUrl = qr?.qrcode_img_content ?? login.qrUrl
          }
          break
        case 'binded_redirect':
          // 已有 token（重连）：沿用现有凭据视为成功；首次登录（无 token）则刷新二维码重试
          if (channel.creds?.bot_token) {
            login.status = 'confirmed'
            login.message = '该微信已绑定，沿用现有凭据'
            return
          }
          login.qrRefreshCount += 1
          if (login.qrRefreshCount > MAX_QR_REFRESH) {
            login.status = 'error'
            login.message = '该微信已绑定其它机器人，无法获取新凭据，请确认后重试'
            return
          }
          login.pendingVerifyCode = undefined
          login.message = '该微信已绑定其它机器人，刷新二维码…'
          {
            const qr = await ilink.fetchQRCode({ localTokenList: channel.creds?.bot_token ? [channel.creds.bot_token] : [] })
            login.qrCode = qr?.qrcode ?? login.qrCode
            login.qrUrl = qr?.qrcode_img_content ?? login.qrUrl
          }
          break
        case 'scaned_but_redirect':
          if (status.redirect_host) {
            login.apiBaseUrl = `https://${status.redirect_host}`
            channel.pushLog(`登录轮询切换节点：${status.redirect_host}`)
          }
          break
        case 'confirmed': {
          const token = status.bot_token ?? status.token
          const baseurl = status.baseurl ?? login.apiBaseUrl
          if (!token) {
            login.status = 'error'
            login.message = '服务器未返回 bot_token'
            return
          }
          login.status = 'confirmed'
          login.message = '登录成功！'
          channel.pushLog('扫码登录成功')
          channel.applyCredentials({ bot_token: token, baseurl, ilink_bot_id: status.ilink_bot_id, ilink_user_id: status.ilink_user_id, loggedInAt: Date.now() })
          return
        }
        default:
          break
      }
      await sleep(1000)
    }
    login.status = 'expired'
    login.message = '登录超时，请重新发起'
  } catch (err) {
    login.status = 'error'
    login.message = `登录失败：${err?.message ?? err}`
    channel.pushLog(`登录失败：${err?.message ?? err}`)
  } finally {
    login.poller = null
    // 终态记录完成时间：面板停止展示二维码，宽限后自动收起卡片（review S3）
    if (login.status === 'confirmed' || login.status === 'error' || login.status === 'expired') {
      login.finishedAt = Date.now()
    }
  }
}

/** 面板提交验证码后：存下并恢复轮询。 */
function submitVerifyCode(channel, code) {
  const login = channel.login
  if (!login) return { ok: false, message: '没有进行中的登录' }
  if (login.status !== 'need_verifycode') return { ok: false, message: `当前状态 ${login.status}，无需验证码` }
  login.pendingVerifyCode = String(code).trim()
  login.status = 'wait'
  login.message = '已提交验证码，继续验证…'
  if (!login.poller) login.poller = pollLogin(channel, login)
  return { ok: true, message: '验证码已提交' }
}

/* ------------------------------ 路由注册 ------------------------------ */

const PANEL_ACTIONS = new Set([
  'page', 'status', 'logs', 'qr.svg', 'login', 'verifycode', 'logout', 'send',
])
const LEGACY_ACTIONS = new Set([
  'status', 'logs', 'qr.svg', 'login', 'verifycode', 'logout', 'send',
])

export function parsePanelRoute(pathname) {
  const clean = String(pathname ?? '').replace(/\/+$/, '') || '/'
  if (clean !== '/weixin' && !clean.startsWith('/weixin/')) return null
  const parts = clean.slice('/weixin'.length).split('/').filter(Boolean)
  if (parts.length === 0) return { accountId: null, action: 'page' }
  if (parts.length === 1) {
    if (LEGACY_ACTIONS.has(parts[0])) return { accountId: null, action: parts[0] }
    return { accountId: parts[0], action: 'page' }
  }
  if (parts.length === 2 && PANEL_ACTIONS.has(parts[1])) {
    return { accountId: parts[0], action: parts[1] }
  }
  return null
}

export function createPanelHandler(manager) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const route = parsePanelRoute(url.pathname)
    if (!route) return sendText(res, 'not found', 'text/plain', 404)

    let channel
    try {
      channel = manager.account(route.accountId ?? '')
    } catch (err) {
      return sendJson(res, { error: err?.message ?? String(err) }, 404)
    }

    try {
      if (route.action === 'page') {
        sendHtml(res, manager, channel.accountId)
      } else if (route.action === 'status') {
        sendJson(res, channel.statusView())
      } else if (route.action === 'logs') {
        sendJson(res, { logs: channel.logs.slice(-200) })
      } else if (route.action === 'qr.svg') {
        const l = channel.login
        if (!l?.qrUrl) return sendText(res, 'no qr', 'text/plain', 404)
        sendText(res, qrSvg(l.qrUrl), 'image/svg+xml')
      } else if (route.action === 'login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        sendJson(res, await startLogin(channel, body?.folder))
      } else if (route.action === 'verifycode' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        sendJson(res, submitVerifyCode(channel, body?.code ?? ''))
      } else if (route.action === 'send' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const to = String(body?.to ?? '')
        const text = String(body?.text ?? '')
        if (!to || !text) throw new Error('缺少参数：to / text')
        sendJson(res, await channel.push(to, text))
      } else if (route.action === 'logout' && req.method === 'POST') {
        await channel.clearCredentials()
        sendJson(res, { ok: true })
      } else {
        sendText(res, 'not found', 'text/plain', 404)
      }
    } catch (err) {
      sendJson(res, { error: err?.message ?? String(err) }, err?.statusCode ?? 500)
    }
  }
}

export function registerPanel(ctx, manager) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/weixin',
      handler: createPanelHandler(manager),
    }),
    'dsh-weixin: /weixin panel',
  )
}

/* ------------------------------ 面板 HTML ------------------------------ */

function sendHtml(res, manager, activeAccountId) {
  const accountLinks = manager.accountIds().map((id) => {
    const active = id === activeAccountId ? ' aria-current="page"' : ''
    const href = `/weixin/${encodeURIComponent(id)}`
    return `<a href="${href}"${active}>${id}</a>`
  }).join('')
  const basePath = `/weixin/${encodeURIComponent(activeAccountId)}`
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>微信通道 · dsh-weixin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #1f2328; background: #fff; }
  h1 { font-size: 20px; }
  .card { border: 1px solid #e2e5e9; border-radius: 10px; padding: 16px; margin: 12px 0; }
  .row { margin: 6px 0; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; } .muted { color: #656d76; }
  button { background: #0969da; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 14px; cursor: pointer; }
  button.secondary { background: #656d76; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 8px; font-size: 12px; overflow-x: auto; max-height: 320px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e2e5e9; padding: 6px 8px; text-align: left; word-break: break-all; }
  img.qr { width: 260px; height: 260px; border: 1px solid #e2e5e9; border-radius: 8px; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; }
  nav a { border: 1px solid #d0d7de; border-radius: 999px; padding: 5px 10px; color: #0969da; text-decoration: none; }
  nav a[aria-current="page"] { color: #fff; background: #0969da; border-color: #0969da; }
  #verify { display: none; }
</style>
</head>
<body>
<h1>📱 微信通道 <span class="muted">${activeAccountId}</span></h1>
<div class="card">
  <b>账号</b>
  <nav>${accountLinks}</nav>
</div>
<div class="card">
  <div class="row"><b>账号文件夹</b></div>
  <div class="row">
    <input id="folder" placeholder="填写单段文件夹名" autocomplete="off" style="padding:6px 8px;font-size:14px;min-width:260px">
  </div>
  <div class="row muted">绑定账号前必须填写；插件会在 accountRoot 下自动创建，不会自动生成 DSH 侧边栏工作区。</div>
</div>
<div class="card">
  <div class="row">状态：<b id="conn" class="bad">未知</b></div>
  <div class="row muted" id="meta"></div>
  <div class="row">
    <button onclick="login()">扫码登录</button>
    <button class="secondary" onclick="logout()">登出</button>
  </div>
</div>
<div class="card" id="loginCard" style="display:none">
  <div class="row" id="loginMsg"></div>
  <img class="qr" id="qr" alt="二维码" style="display:none">
  <div id="verify">
    <input id="code" placeholder="输入手机微信显示的数字" style="padding:6px 8px;font-size:14px">
    <button onclick="submitCode()">提交验证码</button>
  </div>
</div>
<div class="card">
  <b>会话映射</b>（微信用户 → Harness 会话）
  <table id="sessions"><tr><th>微信用户</th><th>会话</th></tr></table>
</div>
<div class="card">
  <b>最近日志</b>
  <pre id="logs"></pre>
</div>
<script>
const BASE = ${JSON.stringify(basePath)};
const $ = (id) => document.getElementById(id);
let folderDirty = false;
$('folder').addEventListener('input', () => { folderDirty = true; });
async function j(url, opts) { const r = await fetch(url, opts); return r.json(); }
function render(s) {
  const on = s.connected;
  $('conn').textContent = on
    ? (s.processing ? '已连接，正在处理' : '已连接')
    : (s.pausedUntil ? '已暂停' : '未连接');
  $('conn').className = on ? 'ok' : 'bad';
  const meta = [];
  if (s.folder) meta.push('文件夹：' + s.folder);
  if (s.cwd) meta.push('目录：' + s.cwd);
  if (s.loggedInAt) meta.push('登录时间：' + new Date(s.loggedInAt).toLocaleString());
  if (s.lastPollAt) meta.push('最近轮询：' + new Date(s.lastPollAt).toLocaleString());
  if (s.lastInboundAt) meta.push('最近来消息：' + new Date(s.lastInboundAt).toLocaleString());
  if (s.processing || s.queued) meta.push('处理中：' + (s.processing ? '是' : '否') + '，排队：' + (s.queued || 0));
  if (s.pausedUntil) meta.push('暂停至：' + new Date(s.pausedUntil).toLocaleString() + (s.pauseReason ? '，' + s.pauseReason : ''));
  if (s.lastError && !s.pauseReason) meta.push('最近错误：' + s.lastError);
  if (!s.loggedInAt && !s.lastError) meta.push('未登录');
  $('meta').textContent = meta.join(' · ');
  if (!folderDirty) $('folder').value = s.folder || '';
  const rows = Object.entries(s.sessionMap || {});
  const tbl = $('sessions');
  tbl.replaceChildren();
  {
    const tr = tbl.insertRow(), th1 = document.createElement('th'), th2 = document.createElement('th');
    th1.textContent = '微信用户'; th2.textContent = '会话';
    tr.append(th1, th2);
  }
  if (rows.length) {
    for (const [u, sid] of rows) {
      const tr = tbl.insertRow(), td1 = document.createElement('td'), td2 = document.createElement('td');
      td1.textContent = u.slice(0, 18) + '…'; td2.textContent = sid;
      tr.append(td1, td2);
    }
  } else {
    const tr = tbl.insertRow(), td = document.createElement('td');
    td.colSpan = 2; td.className = 'muted'; td.textContent = '（暂无映射）';
    tr.append(td);
  }
  const l = s.login;
  if (l && l.active) {
    $('loginCard').style.display = 'block';
    $('loginMsg').textContent = l.message || l.status;
    $('qr').style.display = l.hasQr ? 'block' : 'none';
    if (l.hasQr) $('qr').src = BASE + '/qr.svg?t=' + Date.now();
    $('verify').style.display = l.status === 'need_verifycode' ? 'block' : 'none';
  } else {
    $('loginCard').style.display = 'none';
  }
  if (on) setTimeout(tick, 2000); else setTimeout(tick, 5000);
}
async function tick() { try { render(await j(BASE + '/status')); } catch { /* 重试 */ } }
async function login() {
  const folder = $('folder').value.trim();
  if (!folder) { alert('请先填写账号文件夹名'); return; }
  const r = await j(BASE + '/login', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ folder }),
  });
  if (r.error) alert(r.error); else folderDirty = false;
  tick();
}
async function logout() { if (!confirm('确定登出该微信账号？')) return; await j(BASE + '/logout', { method: 'POST' }); tick(); }
async function submitCode() { const r = await j(BASE + '/verifycode', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ code: $('code').value }) }); if (!r.ok) alert(r.message || r.error); tick(); }
async function logs() { try { const r = await j(BASE + '/logs'); $('logs').textContent = r.logs.join('\\n'); } catch {} }
setInterval(logs, 3000);
tick(); logs();
</script>
</body>
</html>`
  sendText(res, html, 'text/html; charset=utf-8')
}
