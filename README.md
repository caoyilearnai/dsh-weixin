# dsh-weixin

微信 ClawBot（iLink）通道插件：把微信消息接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话。

它是一个标准的 **Cordis 组合包（bundle）**，在 Harness 进程内运行，**无需独立桥接进程**：

```
手机微信 ClawBot ←→ 腾讯 iLink ←→ 【本插件（Harness 进程内）】
                                   ├─ getupdates 长轮询收消息
                                   ├─ agent.followup() 原生注入会话
                                   └─ session/event → sendmessage 回发
```

- **每用户一个会话**：微信用户 id → Harness 会话的映射持久化，会话有独立上下文。
- **原生注入**：消息通过 `agent.followup()` 进入会话，参与历史、标题、持久化。
- **网页面板**：`/weixin` 提供连接状态、扫码登录、会话映射、日志。
- **主动推送**：`ctx.weixin` 服务 + `/weixin/send` 路由，可供其它插件/脚本主动推消息。

## 快速开始

> 前提：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，`dsh` 命令可用。

**1. 安装**（装到 `web` profile，插件依赖它提供的 `webServer`/`agents`）：

```sh
dsh plugin --profile web add github:caoyilearnai/dsh-weixin
```

**2. 启动**（与平时启动 Harness 一致，插件随 web 组合自动加载）：

```sh
dsh web --port 3080
```

**3. 扫码登录**：

手机微信先开通 ClawBot（「设置 → 插件 → ClawBot」，iOS ≥ 8.0.70），然后打开
`http://127.0.0.1:3080/weixin` → 点「扫码登录」→ 手机微信扫码（若提示数字验证码，照输即可）。

**4. 开始对话**：微信里给机器人发消息即可，每个微信用户自动对应一个独立会话。

登录凭据会写入状态目录，重启后免扫码。

> 卸载：`dsh plugin --profile web remove dsh-weixin`

### 其它安装方式

```sh
# 本地目录
dsh plugin --profile web add /path/to/dsh-weixin
# npm（发布后）
dsh plugin --profile web add dsh-weixin
# 锁定 commit（更稳）
dsh plugin --profile web add github:caoyilearnai/dsh-weixin#<sha>
```

### 命令行扫码登录（可选）

不用面板也可以用 CLI 登录：

```sh
dsh-weixin-login
# 或：node node_modules/dsh-weixin/bin/login.mjs
```

## 主动推送

除「微信来消息 → 回复」外，插件暴露两种主动推送方式（无需入站 `context_token`）：

**1. Cordis 服务**（其它插件调用）：`inject: ['weixin']` 后通过 `ctx.weixin` 使用：

```js
export const inject = ['weixin']
export function apply(ctx) {
  ctx.weixin.push('your-user@im.wechat', '你好')  // 推给单个微信用户
  ctx.weixin.sendAll('全员通知')                 // 广播给所有已建会话用户
  ctx.weixin.status()                            // 连接状态快照
  ctx.weixin.sessions()                          // 用户 id → sessionId 映射
}
```

**2. HTTP 路由**（脚本 / 调度器调用）：

```sh
curl -X POST http://127.0.0.1:3080/weixin/send \
  -H 'content-type: application/json' \
  -d '{"to":"your-user@im.wechat","text":"你好"}'
# 广播：{"to":"all", "text":"..."}
```

目标用户 id 可在 `/weixin/status` 的 `sessionMap` 里查到。

## 配置

通过 Cordis 配置覆盖默认值。在用户 profile 的 `cordis.patch.yml`（或 `--patch` overlay）重述本行，仅写要改的键（未写的键由 schema 填充默认值）：

```yaml
- insert:
    - id: weixin
      name: dsh-weixin
      config:
        replyMode: last       # full | last
        maxChunk: 1200
```

| 键 | 默认 | 说明 |
|---|---|---|
| `cwd` | `stateDir/workspace`（空则自动，可显式覆盖） | 新会话工作目录 / 会话持久化命名空间（绝对路径） |
| `stateDir` | `$DSH_HOME/dsh-weixin`（无则 `~/.dsh/dsh-weixin`） | 凭证/会话映射/游标的目录 |
| `replyMode` | `full` | `full` 整轮文本 / `last` 只回最后一条 |
| `replyTimeoutMs` | `900000` | 单轮回复超时（毫秒） |
| `maxChunk` | `1500` | 单条消息最大字符数（超出切分） |
| `sendIntervalMs` | `2000` | 两次发送最小间隔（规避 iLink 限流） |

> 若在 bundle 层已经写了 `config`，覆盖时必须重述整行（后层会替换整行 `config` 值，不与前层深度合并）。

## 状态目录

```
stateDir/
├── credentials.json    # bot_token / baseurl / ilink_bot_id / ilink_user_id / loggedInAt
├── session-map.json    # 微信用户 id → Harness 会话 id
└── updates-buf.json    # getupdates 长轮询游标
```

会话本身由 Harness 的 sessionPersistence 持久化，与插件状态目录无关；删除 `session-map.json` 只会让下次消息新建会话。

## 开发

```sh
pnpm install
pnpm test        # node --test（核心关联/切分逻辑）
```

包结构遵循官方「打包与安装插件」规范：

```
dsh-weixin/
├── package.json       # dsh.bundle manifest + exports + files
├── cordis.patch.yml   # 按包名引用插件（非路径）
├── index.mjs          # 组合包入口（re-export name/inject/Config/apply）
├── src/               # index / ilink / creds / panel
├── bin/login.mjs      # CLI 扫码登录
└── test/              # node:test 单元测试
```

## 安全注意事项

`/weixin` 面板（`/status`、`/login`、`/verifycode`、`/logout`、`/send`）目前 **没有鉴权**：任何能访问该地址的人都可以登出机器人、以机器人身份向任意/全体用户发消息、查看会话映射与日志。

- **仅在可信环境使用**：只在本机或可信内网运行 `dsh web`，不要把 `webServer` 绑定到 `0.0.0.0`、不要做公网端口转发、不要部署到公网服务器。
- 若确需远程管理，请自建反向代理 + 鉴权层（或 VPN）后再暴露，不要直接裸奔公网。
- 为 `/weixin/*` 写操作加鉴权是本项目的 TODO，欢迎贡献。

## 已知限制

- 仅单聊、仅文本（图片/语音/文件回复"暂不支持"提示）。
- **单轮串行**：一条微信消息会阻塞整个通道直到该轮结束，多用户场景后面的消息会排队等待（单用户无感）。
- iLink 限流（`ret=-2`）已内置指数退避重试；连发仍可能被腾讯节流。
- ClawBot 处于灰度测试阶段，腾讯保留调整权利。

## License

MIT