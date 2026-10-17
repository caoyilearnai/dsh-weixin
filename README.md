# dsh-weixin

微信 ClawBot 通道插件，把微信消息接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话。

一个插件实例可以连接多个 ClawBot 账号。每个账号有独立的凭据、轮询游标、会话映射、登录流程、发送队列和工作目录。

```text
微信账号 A ←→ 腾讯 iLink ←→ 账号 A 通道（独立轮询和文件夹）
微信账号 B ←→ 腾讯 iLink ←→ 账号 B 通道（独立轮询和文件夹）
                                  ↓
                         DeepSeek Harness 持久化会话
```

插件是 Cordis bundle，在 Harness 进程内运行，不需要独立桥接进程。

## 兼容性与账号能力

- 兼容 [DeepSeekHarness-NAS](https://github.com/EIGHTfs/DeepSeekHarness-NAS)：已针对群晖原生 DSH 包和会话格式 v4 处理消息 source kind。
- 支持多微信账号连接：同一个插件实例可以运行多个独立 ClawBot 账号，每个账号拥有自己的凭据、轮询、会话映射、发送队列和工作目录。

## 主要行为

- 每个微信发送者对应一个 Harness 会话，会话映射按 ClawBot 账号隔离。
- 每个账号使用 `accountRoot` 下的一个直接子文件夹；账号之间不能共享同一个目录。
- 账号文件夹可在管理页绑定前填写；缺失或不安全时不会开始扫码登录。
- 账号目录只作为文件工具和会话的工作目录，不会自动注册成 DSH 侧边栏 Workspace。
- 每个账号独立执行 `getupdates` 长轮询。一个账号处理长任务时，其他账号继续收消息。
- 长轮询与 AI 处理分开运行。AI 处理长任务时，当前账号仍持续发送 `getupdates` 心跳。
- 插件持久化最近的 `message_id`，腾讯重投积压消息时只处理一次。
- `getupdates` 返回 `ret=-14` 或 `errcode=-14` 时，账号暂停一小时，状态页显示暂停原因。
- 状态接口返回 `lastPollAt`、`lastInboundAt`、`processing`、`queued` 和 `pausedUntil`，并用最近轮询时间判断连接是否健康。
- 收到文字、语音转写或图片后，插件通过 `agent.followup()` 把消息注入会话。
- 助手回复通过收到消息时所属的 ClawBot 账号发回。
- 管理页支持每个账号独立扫码登录、验证码、登出、状态、日志和主动推送。
- Synology DSH `0.2.1-alpha.5` 的会话格式 v4 使用 `plugin:dsh-weixin` source kind。

## 快速开始

前提是 DSH 的 `web` profile 已提供 `webServer`、`agents`、`tools` 和 `attachments` 服务。

安装插件：

```sh
dsh plugin --profile web add github:caoyilearnai/dsh-weixin
```

启动 DSH：

```sh
dsh web --port 3080
```

打开 `http://127.0.0.1:3080/weixin` 登录默认账号。要登录第二个账号，打开对应账号页面。

手机微信需要先开通 ClawBot。入口通常在微信的“设置 > 插件 > ClawBot”。不同微信账号必须分别授权自己的 ClawBot 连接。

卸载插件：

```sh
dsh plugin --profile web remove dsh-weixin
```

### 其它安装方式

```sh
# 本地目录
dsh plugin --profile web add /path/to/dsh-weixin

# npm，发布后可用
dsh plugin --profile web add dsh-weixin

# 锁定 commit
dsh plugin --profile web add github:caoyilearnai/dsh-weixin#<commit>
```

### 从命令行登录

```sh
node node_modules/dsh-weixin/bin/login.mjs
node node_modules/dsh-weixin/bin/login.mjs "$DSH_HOME/dsh-weixin" family \
  /volume1/homes/example/Drive/dsh-workspace family
```

参数依次是状态根目录、账号 ID、账号目录根 `accountRoot`、单段文件夹名。省略 `accountRoot` 或文件夹时，CLI 会交互询问；缺少文件夹不会继续绑定。也可以设置环境变量 `DSH_WEIXIN_ACCOUNT_ROOT` 提供账号目录根。

## 配置多个账号

在用户 profile 的 `cordis.patch.yml` 中覆盖插件配置。示例中的账号 ID 和路径仅用于说明，请替换成你的值。

```yaml
- insert:
    - id: weixin
      name: dsh-weixin
      config:
        defaultAccount: primary
        accountRoot: /volume1/homes/example/Drive/dsh-workspace
        accounts:
          - id: primary
            folder: primary
          - id: family
            folder: family
        replyMode: full
        replyTimeoutMs: 900000
        maxChunk: 1500
        sendIntervalMs: 2000
        pollStaleMs: 75000
```

账号 ID 只能包含字母、数字、点、下划线和连字符。ID 不能以符号开头，不能以点结尾，不能是 `.` 或 `..`。ID 不能与 `status`、`logs`、`login`、`verifycode`、`logout`、`send`、`qr.svg` 这些路由名冲突。账号 ID 必须唯一，比较时不区分大小写。这些规则防止账号 ID 跳出状态目录，也避免路由和文件路径冲突。

如果没有配置 `accounts`，插件创建一个向后兼容的 `default` 账号。旧版根目录状态会迁移到这个账号。

新增账号时可以先只配置 `id`，再打开 `/weixin/<accountId>` 在登录前填写文件夹。文件夹必须位于 `accountRoot` 下，插件会自动创建目录；未填写文件夹时登录请求会被拒绝。

旧配置可以继续使用 `accounts[].cwd`。如果所有 `cwd` 都是同一个父目录的直接子目录，插件会自动推断 `accountRoot` 和文件夹名。已有账号首次打开管理页也会显示推断出的文件夹。

## 管理路由

旧版 `/weixin` 路由继续指向默认账号。

| 路由 | 作用 |
|---|---|
| `GET /weixin` | 默认账号管理页 |
| `GET /weixin/<accountId>` | 指定账号管理页 |
| `GET /weixin/status` | 默认账号状态 JSON |
| `GET /weixin/<accountId>/status` | 指定账号状态 JSON |
| `POST /weixin/login` | 默认账号开始扫码登录 |
| `POST /weixin/<accountId>/login` | 指定账号开始扫码登录 |
| `POST /weixin/verifycode` | 默认账号提交验证码 |
| `POST /weixin/<accountId>/verifycode` | 指定账号提交验证码 |
| `POST /weixin/logout` | 默认账号登出 |
| `POST /weixin/<accountId>/logout` | 指定账号登出 |
| `POST /weixin/send` | 默认账号主动推送 |
| `POST /weixin/<accountId>/send` | 指定账号主动推送 |
| `GET /weixin/logs` | 默认账号日志 |
| `GET /weixin/<accountId>/logs` | 指定账号日志 |

主动推送请求体为 `{"to":"user-id","text":"message"}`。`to` 使用 `all` 时，插件广播给该账号下所有已建会话用户。

## 插件服务

其他插件注入 `weixin` 服务后，可以按账号调用：

```js
ctx.weixin.push(to, '你好', 'family')
ctx.weixin.sendAll('通知', 'family')
ctx.weixin.status('family')
ctx.weixin.sessions('family')
ctx.weixin.accounts()
```

省略 `accountId` 时使用 `defaultAccount`。`ctx.weixin.accounts()` 返回所有账号的状态。

Agent 也可以调用 `push_weixin` 工具。工具支持可选的 `accountId` 和 `to`。省略 `to` 时，工具从触发会话所属账号找到微信用户。会话属于一个账号时，工具拒绝通过另一个账号发送。

## 配置参考

| 键 | 默认值 | 说明 |
|---|---|---|
| `accountRoot` | 从旧 `cwd` 推断 | 所有账号文件夹的共同父目录 |
| `accounts` | 空 | 账号列表。每一项包含 `id`，以及 `folder` 或兼容旧配置的 `cwd` |
| `defaultAccount` | 第一项 | `/weixin` 和省略账号参数的 API 使用的账号 |
| `accounts[].folder` | 空 | 单段文件夹名，解析为 `accountRoot/folder` |
| `accounts[].cwd` | 空 | 兼容旧配置的直接工作目录；必须与 `accountRoot` 一致 |
| `cwd` | 空 | 没有 `accounts` 时的默认账号工作目录 |
| `stateDir` | `$DSH_HOME/dsh-weixin` 或 `~/.dsh/dsh-weixin` | 凭据、会话映射和游标的根目录 |
| `replyMode` | `full` | `full` 回复整轮文本，`last` 只回复最后一条助手文本 |
| `replyTimeoutMs` | `900000` | 单轮回复超时，单位毫秒 |
| `maxChunk` | `1500` | 单条微信消息的最大字符数 |
| `sendIntervalMs` | `2000` | 同一账号两次发送之间的最小间隔，单位毫秒 |
| `pollStaleMs` | `75000` | 超过该时长未发起下一次轮询时，状态页不再显示已连接 |

`accounts[].folder` 必须是非空单段目录名，不能包含 `/`、`\`、`:` 或控制字符，不能是 `.`、`..`、Windows 设备名，也不能是符号链接。插件同时从字符串和实际路径两层校验目录仍在 `accountRoot` 内。

配置了 `accounts` 但某个新账号没有 `folder`/`cwd` 时，该账号保持未绑定状态，不能启动轮询或创建 Agent，直到在管理页填写合法文件夹。没有 `accounts` 的单账号旧配置仍回落到 `stateDir/workspace`。

## 状态目录

```text
stateDir/
└── accounts/
    ├── primary/
    │   ├── credentials.json
    │   ├── session-map.json
    │   ├── updates-buf.json
    │   ├── seen-messages.json
    │   └── account-settings.json
    └── family/
        ├── credentials.json
        ├── session-map.json
        ├── updates-buf.json
        ├── seen-messages.json
        └── account-settings.json
```

`credentials.json` 保存 ClawBot 凭据。`session-map.json` 保存该账号内微信用户到 Harness 会话的映射。`updates-buf.json` 保存该账号的轮询游标。`seen-messages.json` 保存最近 1000 个已处理消息 ID，用于跨重启去重。`account-settings.json` 保存管理页设置过的 `accountRoot` 和文件夹名；同一个 `accountRoot` 下，管理页保存的文件夹设置优先于启动配置。

Harness 会话由 DSH 的会话持久化服务保存，不在插件状态目录中。删除一个账号的 `session-map.json` 不会删除会话，只会让该账号下次收到消息时创建新会话。

## 从单账号升级

插件启动时检查状态根目录中的旧版文件：

- `credentials.json`
- `session-map.json`
- `updates-buf.json`

默认账号的状态目录为空时，插件把这些文件移入 `stateDir/accounts/<defaultAccountId>`。迁移可以重复执行。

如果默认账号目录已有同名文件，插件保留两边文件，不覆盖新状态。检查旧文件后再手动处理冲突。

## Synology 和会话格式

插件只使用 Node.js 内置模块和纯 ESM JavaScript，不增加原生依赖，也不依赖 `workspace-write` shell sandbox。可以在 Synology 原生 DSH 包提供的 Node 运行时中执行 `node --test`。

DSH `0.2.1-alpha.5` 要求消息 source 带生产者自己的 kind。插件发送：

```js
source: { kind: 'plugin:dsh-weixin', plugin: 'dsh-weixin' }
```

这个格式有回归测试。旧值 `kind: 'plugin'` 会在 format v4 中报 `message requires a producer-owned source kind`。

## 安全边界

- `stateDir` 保存 Bot token。不要把它放进 Drive 或其它同步目录。
- `cwd` 指向用户工作区时，可以放在 Drive 中。凭据和会话映射仍在 `stateDir`。
- 账号文件夹只能取 `accountRoot` 下的直接子目录，不能通过 `..`、路径分隔符或符号链接跳出。
- 账号 ID 经过白名单校验，不能包含路径分隔符。
- 同一个 `accountRoot` 下不能有两个账号使用同一个文件夹。
- 每个账号只读取自己的凭据、会话映射和游标。
- 每个账号只读取自己的消息去重记录，不与其他账号共享。
- 回复发送使用收到消息的账号通道，不使用默认账号代替。
- 日志不记录 token、二维码链接、完整微信用户 ID、Bot ID 或消息正文。
- 管理页目前没有独立鉴权。只在可信内网访问，不要绑定公网地址，不要做公网端口转发。
- 管理页只负责指定文件夹和文件工具根目录，不会为了让地址栏分组而调用 DSH Workspace 内部接口。

## 消息类型

| 类型 | 状态 | 行为 |
|---|---|---|
| 文字 | 支持 | 注入会话 |
| 语音 | 支持 | 使用腾讯服务端转写文本 |
| 图片 | 部分支持 | 模型支持图片输入时注入图片；纯文本模型返回提示，不污染历史 |
| 文件 | 不支持 | 返回格式不支持提示 |
| 视频 | 不支持 | 返回格式不支持提示 |

## 已知限制

- 只支持单聊，群聊未适配。
- 二维码通常在 5 分钟后过期。面板最多自动刷新 3 次。
- 同一账号内的 AI 回合进入串行处理队列。一个账号的长回合不会停止该账号的轮询心跳。
- 已绑定账号不能直接更换文件夹；登出后更换文件夹会清空该账号的旧会话映射，避免旧会话跨目录续用。
- iLink 返回限流 `ret=-2` 时，插件使用指数退避重试。腾讯仍可能继续节流。
- ClawBot 仍在逐步开放，腾讯可能调整协议。

## 开发

```sh
pnpm install
pnpm test
```

测试覆盖账号校验、路径隔离、旧状态迁移、轮询心跳、长任务并发、消息去重、`ret=-14` 暂停、回合隔离、发送账号选择、管理路由和 DSH format v4 source kind。

包结构：

```text
dsh-weixin/
├── package.json
├── cordis.patch.yml
├── index.mjs
├── bin/
│   └── login.mjs
├── src/
│   ├── accounts.mjs
│   ├── creds.mjs
│   ├── ilink.mjs
│   ├── index.mjs
│   └── panel.mjs
├── test/
└── README.md
```

## License

MIT
