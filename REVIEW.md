# dsh-weixin 代码 Review 报告

> **给执行 Agent 的说明**：本文档是对 dsh-weixin 插件（微信 ClawBot / iLink 通道，DeepSeek Harness 的 Cordis bundle 插件）的全量代码 review。请按「修复优先级」顺序处理 Critical 与 Important 项；Suggestion 项尽量一并处理；**FYI 项明确无需改动，不要动**。所有修复必须保持现有测试通过，并按各项的「验证」说明补充/运行验证。

- **Review 日期**：2026-08-15
- **范围**：`index.mjs`、`src/`（index / ilink / creds / panel）、`bin/login.mjs`、`test/`、`.github/workflows/publish.yml`、`package.json`
- **基线状态**：`node --test` 8/8 通过；工作树干净（基于 commit `8b711b5`）
- **技术栈**：Node ≥ 20 ESM（`.mjs`），无构建步骤，测试用 `node:test`

---

## 修复优先级总览

| 级别 | 编号 | 摘要 |
|---|---|---|
| 🔴 Critical | C1 | bin/login.mjs 导入路径错误，CLI 登录启动即崩溃 |
| 🟠 Important | I1 | 回复超时后 turn 延迟结束会导致双重回复 |
| 🟠 Important | I2 | sendIntervalMs 限流间隔在消息分块之间不生效 |
| 🟠 Important | I3 | /weixin 面板所有路由无鉴权（至少补文档警示） |
| 🟠 Important | I4 | credentials.json 以 0644 写入，bot_token 全局可读 |
| 🟡 Suggestion | S1–S12 | 见下文逐项 |
| ⚪ FYI | F1–F3 | 无需改动 |

---

## 🔴 Critical

### C1. `bin/login.mjs` 导入路径错误，CLI 登录完全不可用

- **位置**：`bin/login.mjs:12-13`
- **问题**：

  ```js
  import * as ilink from './src/ilink.mjs'        // 相对 bin/ 解析为 bin/src/ilink.mjs —— 不存在
  import { createStore, resolveStateDir } from './src/creds.mjs'
  ```

  实测运行 `node bin/login.mjs /tmp/x` 立即抛：
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../bin/src/ilink.mjs'`。
  README 宣传的 `dsh-weixin-login` 与 `node node_modules/dsh-weixin/bin/login.mjs` 两种用法全部失效。
- **修复**：两处导入改为 `../src/ilink.mjs`、`../src/creds.mjs`。
- **根因与防回归**：`npm test`（`node --test`）不覆盖 `bin/`，而 `prepublishOnly` 只跑 `npm test`，坏 bin 会原样发布到 npm。请在 `test/` 增加一个导入冒烟测试，例如动态 `import('../bin/login.mjs')` 不可行（会执行 main），建议把 login.mjs 重构为「可导入的纯函数 + 仅当直接执行时跑 main」，或最简方案：测试中 spawn `node bin/login.mjs --help`/带参数干跑并断言不出现 `ERR_MODULE_NOT_FOUND`（允许网络错误，不允许模块解析错误）。选择最小改动即可，但必须有一个能在 CI 里拦住此类问题的测试。
- **验证**：`node bin/login.mjs /tmp/dsh-weixin-fix-check` 能走到「正在申请登录二维码」的网络阶段（报网络错可以，报 MODULE_NOT_FOUND 不行）；`npm test` 全绿。

---

## 🟠 Important

### I1. 回复超时后会「双重回复」

- **位置**：`src/index.mjs:261-276`（超时定时器）与 `src/index.mjs:321-334`（`turn/end` 分支）
- **问题**：超时定时器触发时发送「⏰ 处理超时，请稍后再试」并 resolve，但**没有清理 `this.collector`**。若该 turn 在超时之后才结束，`turn/end` 分支仍持有旧 collector 引用（其中保存着 pending 对象），会把完整回复**再发一遍**——用户先收到「超时请重试」，稍后又收到迟到的完整答案。
- **修复**：超时时把对应 collector 置空/标记为已废弃；或在 `turn/end` 分支发送前校验该 msgId 仍在 `this.pending` 中（超时已 `delete`）。两种方案择一，注意不要影响正常路径的 `pending.resolve()` 语义（Promise 多次 resolve 无害，但重复发消息有害）。
- **验证**：补一个单测——构造 pending + collector，手动触发超时路径（可用很小的 `replyTimeoutMs` 或抽出结算函数直接测），再投递 `turn/end`，断言只发送了一条消息。

### I2. 限流间隔（`sendIntervalMs`）只在回复之间生效，分块之间不生效

- **位置**：`src/index.mjs:348-357`（`sendReply`）
- **问题**：`paceSend()` 只在 chunk 循环**前**调用一次，随后 N 个分块背靠背连发。长回复切成多块时正面冲击 iLink 限流（`ret=-2`），与配置项「两次发送最小间隔」的语义不符，也让 `sendMessage` 的指数退避从兜底变成常态路径。
- **修复**：把 `await this.paceSend()` 移入 chunk 循环内（每个分块发送前都等待）。注意 S6 提到的并发问题可一并考虑，但本项只要求循环内调速即可。
- **验证**：补单测：`sendIntervalMs` 设为可观测值（如 50ms），发送一条会切成 2+ 块的文本，断言两次 `ilink.sendMessage` 调用间隔 ≥ 设定值（可通过替换/打桩 sendMessage 记录时间戳）。

### I3. 面板所有路由无鉴权

- **位置**：`src/panel.mjs:186-228`（`registerPanel` 全部路由）
- **问题**：`/weixin/logout`、`/weixin/login`、`/weixin/send`（可向任意用户/全员发消息）、`/weixin/status`（泄露 sessionMap、日志）全部无鉴权开放。安全边界完全依赖宿主 webServer 的监听地址；一旦 `dsh web` 绑定 0.0.0.0、端口转发或部署到服务器，任何可达端口者都能登出机器人、以机器人身份向任意用户发消息。
- **修复（最低要求）**：README「快速开始」与「已知限制」之间新增「安全注意事项」小节，明确说明 `/weixin` 面板无鉴权，**必须**仅在本机/可信网络使用，不要将 webServer 暴露公网。
- **修复（更佳，若能低成本实现）**：调研 Harness webServer 是否提供现成鉴权/中间件机制（`ctx.webServer.register` 的选项）；若有则复用，为 `/weixin/*` 写操作（login/logout/verifycode/send）加鉴权。若宿主无现成机制，不要自行造复杂鉴权，做文档警示即可并在 README 记一个 TODO。
- **验证**：README 渲染检查；若实现了鉴权，补相应路由测试。

### I4. `credentials.json` 默认 0644，bot_token 全局可读

- **位置**：`src/creds.mjs:32-35`（`saveJson`）
- **问题**：`fs.writeFileSync` 使用默认权限，实测 umask 022 下文件为 0644，同机任何用户可读 `bot_token`。
- **修复**：凭据文件写入后 `fs.chmodSync(file, 0o600)`。可以只对 credentials.json 收紧（`saveCredentials` 路径），也可统一收紧三个状态文件——凭据必须收紧，session-map/updates-buf 收紧无副作用，建议统一收紧。注意 mkdirSync 创建的目录也可考虑 0o700（可选）。
- **验证**：补单测：createStore 指向临时目录，saveCredentials 后断言 `fs.statSync(file).mode & 0o777 === 0o600`。

---

## 🟡 Suggestions

### S1. 面板会话表格存在 XSS 注入面
- **位置**：`src/panel.mjs:290`
- **问题**：会话表格用 `innerHTML` 拼接未转义的微信用户 id（来自外部 iLink API 的数据）。
- **修复**：改为 DOM API + `textContent` 构建行，或对插入值做 HTML 转义。

### S2. `readBody` 无大小上限
- **位置**：`src/panel.mjs:35-42`
- **问题**：请求体无限累积，可被大请求体耗尽内存。
- **修复**：加约 1MB 上限，超限截断或提前 resolve 并由调用方按 400 处理。

### S3. 登录成功后面板登录卡片永不消失
- **位置**：`src/panel.mjs:142-155`（confirmed 分支）+ `src/index.mjs:393-403`（`loginView`）
- **问题**：confirmed 后 `channel.login` 不清理，`loginView()` 永远 `active: true`，面板永久显示二维码卡片并每 2s 轮询 `qr.svg`。
- **修复**：confirmed/出错终态后延迟若干秒清空 `channel.login`，或 `loginView()` 对终态返回 `active: false`（保留 message 供最后一次展示也可，自行权衡，以不再无限轮询 qr.svg 为准）。

### S4. `chunkText` 会劈开 emoji 的代理对
- **位置**：`src/index.mjs:40-52`
- **问题**：按 UTF-16 code unit 切分，emoji 跨边界时产生孤立代理位（实测块尾出现 `d83d`）。微信文本 emoji 密集。
- **修复**：切点若落在高代理位（`0xD800-0xDBFF`）上，回退一个 code unit 再切。
- **验证**：补用例：`'a'.repeat(1499) + '😀' + 'b'.repeat(10)` 按 1500 切分，断言两块均不含孤立代理位且拼接后等于原文。

### S5. `push()` 返回的 `sent` 是目标数而非成功数
- **位置**：`src/index.mjs:368-377` 与 `src/index.mjs:348-362`（`sendReply` 吞错）
- **问题**：`sendReply` 内部 catch 吞掉发送失败，`push` 仍返回 `sent: targets.length`，调用方（其它插件 / `/weixin/send` 脚本）无法得知推送是否真成功。
- **修复**：让 `sendReply` 返回成功与否（或抛给 push 层统计），`push` 返回 `{ sent, failed, targets }`。注意保持现有 `turn/end` 结算处对 sendReply 的调用语义不变。

### S6. `paceSend` 并发下不串行
- **位置**：`src/index.mjs:342-346`
- **问题**：两个并发 `sendReply`（如主动推送撞上入站回复）同时读旧 `lastSendAt`，会一起放行。
- **修复**：用一个串行队列（promise chain）或「预定时隙」方式让调速真正全局串行。若与 I2 修复合并实现更自然，可合并。

### S7. `apiGet` 吞掉所有错误为 `wait`，含死分支
- **位置**：`src/ilink.mjs:94-98`
- **问题**：`if (err?.name === 'AbortError') return { status: 'wait' }; return { status: 'wait' }` 两分支相同（死代码）；且服务端 5xx/业务错误也被吞成 `wait`，登录轮询会静默空转到 5 分钟超时，用户看不到真实错误。
- **修复**：合并分支；对非 AbortError 的 `ILinkError`/网络错误，返回如 `{ status: 'error', message }` 或直接抛出，并在 `panel.mjs` / `bin/login.mjs` 的轮询循环里展示该错误（至少 pushLog/打印）。

### S8. `fetchQRCode` 无超时
- **位置**：`src/ilink.mjs:105-115`
- **问题**：未传 `timeoutMs`，fetch 可能无限挂起（面板与 CLI 登录均受影响）。
- **修复**：传 `timeoutMs: API_TIMEOUT_MS`，与其它接口一致。

### S9. `saveJson` 非原子写
- **位置**：`src/creds.mjs:32-35`
- **问题**：写一半崩溃会损坏 JSON（当前 `loadJson` 回退默认值，后果是静默丢凭据/映射）。
- **修复**：写入 `file + '.tmp'` 后 `fs.renameSync` 覆盖。

### S10. 测试覆盖缺口
- **位置**：`test/`
- **问题**：`bin/` 无任何测试（C1 因此漏网）；`ilink.mjs` 的 `sendMessage` 限流重试、`normalizeInboundMessages`，以及面板登录状态机无测试。
- **修复**：至少补——① bin 导入冒烟（见 C1）；② `normalizeInboundMessages` 纯函数用例（含非文本消息 → `hasText:false`）；③ `sendMessage` 的 ret=-2 重试路径（打桩 apiPost 或用真实函数注入失败响应）。其余量力而行。

### S11. CI 依赖安装与锁文件不一致
- **位置**：`.github/workflows/publish.yml:23`
- **问题**：CI 用 `npm install`，仓库锁文件是 `pnpm-lock.yaml`，发布时的依赖解析与本地开发不一致。
- **修复**：加 `pnpm/action-setup` 后 `pnpm install --frozen-lockfile`；或改用 npm 并提交 `package-lock.json`。二选一，与项目实际使用的包管理器（README 写的是 pnpm）保持一致。

### S12. typing 状态只开不关、ticket 永久缓存
- **位置**：`src/index.mjs:243-246`、`src/index.mjs:279-292`
- **问题**：只发 `status: 1`（开始输入），从不在回复完成后发 `status: 2`（取消）；`typingTickets` 缓存永不过期，ticket 失效后静默无效。
- **修复**：在 `turn/end` 结算发送完成后补发 `status: 2`（失败静默即可）；typing 请求失败且疑似 ticket 失效时清除缓存项下次重建（可选，低成本即可，不要过度设计）。

---

## ⚪ FYI（无需改动，仅供知悉——请勿修改）

- **F1**：事件关联假设 `turn/start → user/message` 的先后顺序（`src/index.mjs:298-308`）。测试固化了该假设，但未对真实 Harness 运行时验证；若实际顺序颠倒回复会静默丢失。若未来出现「收到消息但微信无回复」，先查这里。
- **F2**：单 collector 槽 + 单轮串行是 README 已声明的设计限制。若有人同时在 Web UI 操作同一个被映射的会话，collector 可能被覆盖——已知边界，不属于缺陷。
- **F3**：`stop()` 时若正卡在 `await handleInbound`，监视循环要等该轮结束（最长 `replyTimeoutMs` = 15 分钟）才真正退出。属串行设计的自然结果，暂不处理。

---

## 验收清单（全部完成才算修完）

- [ ] `node bin/login.mjs /tmp/any-dir` 不再报 `ERR_MODULE_NOT_FOUND`（C1）
- [ ] 新增测试覆盖：bin 导入冒烟、超时不双重回复、分块间调速、凭据文件权限、chunkText emoji 边界（C1/I1/I2/I4/S4）
- [ ] `npm test` 全绿
- [ ] README 含 `/weixin` 面板安全注意事项（I3）
- [ ] 未改动 FYI 三项；未引入新的外部依赖（如确需依赖请先说明理由）
- [ ] 每个修复独立成 commit，信息说明对应本文档编号（如 `fix: 超时后避免双重回复（review I1）`）
