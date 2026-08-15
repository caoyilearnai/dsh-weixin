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

## 安装

目标 profile 是 **`web`**（内置 `dsh-base` + `dsh-web-app`，提供 `webServer`/`agents` 服务）。

```sh
# 本地 checkout / tarball
dsh plugin --profile web add /path/to/dsh-weixin

# 或从 GitHub / npm（开源后的分发方式）
dsh plugin --profile web add github:you/dsh-weixin#<commit>
dsh plugin --profile web add dsh-weixin
```

启动（与平时一致，插件会随 web 组合自动加载）：

```sh
dsh web --port 3080
```

验证：

```sh
dsh web --dump-config          # 应看到 # == dsh-weixin 层
curl http://127.0.0.1:3080/weixin/status
```

卸载：

```sh
dsh plugin --profile web remove dsh-weixin
```

## 登录

手机端前置：微信「设置 → 插件 → ClawBot」（iOS ≥ 8.0.70；安卓灰度中，以微信实际为准）。

1. **面板**（推荐）：打开 `http://127.0.0.1:3080/weixin` → 「扫码登录」→ 必要时输入手机端数字验证码。
2. **CLI**：`dsh-weixin-login [stateDir]`（或 `node node_modules/dsh-weixin/bin/login.mjs`）。

登录后的凭据写入状态目录（见下），重启后自动读取，无需重新扫码。

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
| `cwd` | `process.cwd()` | 新会话的工作目录（绝对路径） |
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

## 已知限制

- 仅单聊、仅文本（图片/语音/文件回复"暂不支持"提示）。
- iLink 限流（`ret=-2`）已内置指数退避重试；连发仍可能被腾讯节流。
- ClawBot 处于灰度测试阶段，腾讯保留调整权利。

## License

MIT