# pi-feishu 🦞

[![CI](https://github.com/user-hw/pi-feishu/actions/workflows/ci.yml/badge.svg)](https://github.com/user-hw/pi-feishu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**把你的电脑变成一只随叫随到的 AI 助手——在飞书里发条消息，家里那台机器上的 [pi](https://pi.dev) 就替你干活。**

`pi-feishu` 是一层几百行的桥，把飞书聊天窗口接到本地运行的 pi coding agent 上。出门只带手机，也能让电脑读文件、改代码、跑命令，过程和结果**实时流式**推回聊天窗口。

```
你（手机，飞书）  →  飞书服务器  →  家里的电脑（pi-feishu + pi）  →  你的文件系统
                        ↑                        ↓
                   流式卡片（打字机效果）  工具调用实时可见
```

> 不是另一个 agent，也不是又一个 gateway 框架。**pi 才是 agent，这里只是一条信道。**

---

## 为什么不是 OpenClaw / 其他方案

| | OpenClaw | **pi-feishu** |
|---|---|---|
| 代码量 | 40 万行 | **约 1200 行** |
| 会话存储 | 自己的 sessions 目录 | **复用 `~/.pi/agent/sessions/`** |
| 模型配置 | 需重新配置一遍 | **沿用你现有的 pi 配置** |
| 渠道 | 30+ | 只有飞书，但这条路径打磨得更细 |
| 出问题时 | 在庞大代码库里找 | **你能读完整个代码库** |

**最大的价值是「会话共享」**：手机上和终端里是**同一份 JSONL 会话文件**，在家聊到一半，出门用手机接着聊，上下文完整无缺。

---

## 功能

- 💬 **流式输出** —— 基于飞书 CardKit 的原生打字机动画，由服务端渲染
- 🔧 **工具调用透明** —— 你能看到它正在跑什么命令、跑了多久、何时完成
- 🖼️ **图片理解** —— 拍纸质文件、报错截图直接发给它
- 🔄 **会话共享** —— 和终端里的 pi 共用同一份会话文件
- 🎛️ **斜杠命令** —— `/new` `/status` `/model` `/thinking` `/cwd` `/abort` `/whoami` `/help`
- 🔒 **白名单鉴权** —— 只有你指定的账号能驱动它
- 🧩 **多会话并行** —— 一个群 = 一个独立会话 + 独立工作目录 + 独立 pi 进程
- ♻️ **进程回收** —— 空闲 15 分钟自动回收 pi 子进程
- 🚀 **开机自启** —— 自带 launchd / systemd 部署脚本

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  飞书 App（手机 / 桌面）                                      │
└───────┬──────────────────────────────────────▲──────────────┘
        │                                      │
        │ ① 入站：im.v1.message.list            │ ② 出站：CardKit 流式卡片
        │    (轮询，默认每 3 秒)                  │     channel.stream()
        ▼                                      │
┌─────────────────────────────────────────────────────────────┐
│  pi-feishu（Node，跑在你的机器上）                            │
│                                                             │
│   polling.js ──► commands.js ──► pi-pool.js                 │
│                                      │                      │
│                       ③ RPC (JSONL over stdin/stdout)       │
└──────────────────────────────────────┼──────────────────────┘
                                       ▼
                        pi --mode rpc（每个会话一个子进程）
                                       │
                                       ▼
                            你的文件系统 / shell
```

**三个关键机制**

1. **入站用轮询而不是事件推送。** 飞书的事件推送依赖服务端配置，某些情况下（详见下方「踩过的坑」）可能推不过来。轮询是主动拉取，**完全自己掌控**，代价是最多 3 秒延迟。

2. **pi 通过 RPC 模式驱动。** `pi --mode rpc` 从 stdin 收 JSON 命令、向 stdout 吐 JSON 事件流（`text_delta` / `tool_execution_start` / `agent_settled`…）。桥把这些事件翻译成飞书卡片的增量文本。

3. **会话按 `chatId` 映射到 pi 的会话文件**，存在 `~/.pi-feishu/chats.json`。所以重启桥不影响对话——接回去还是同一个会话。

---

## 快速开始

### 前置条件

- **飞书企业/团队版**（个人版无法创建自建应用）
- Node.js **≥ 22.19**
- 已安装并配置好的 pi：`npm i -g @earendil-works/pi-coding-agent`

### 1. 创建飞书应用

1. [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. **添加应用能力** → 启用「**机器人**」
3. **权限管理** → 开通：

   | 权限 | 用途 |
   | --- | --- |
   | `im:message.p2p_msg:readonly` | 读取私聊消息 |
   | `im:message.group_at_msg:readonly` | 读取群里 @机器人 的消息 |
   | `im:message:send_as_bot` | 以机器人身份发消息 |
   | `cardkit:card:write` | **卡片流式更新（必须，否则没有打字机效果）** |
   | `im:resource` | 下载图片/文件 |
   | `im:chat:readonly` | 读取群信息 |

4. **事件与回调** → 订阅方式选「**使用长连接接收事件**」（或 Webhook，二选一）
   - 用轮询模式时，事件订阅**不是必须的**，但仍然建议配上，方便排查
5. 添加事件 `im.message.receive_v1`
6. **版本管理与发布** → 创建版本 → 发布 → 等待审批
7. 记下 **App ID / App Secret**

> ⚠️ **改完权限或事件订阅后必须重新发布版本才生效**，这是最常见的坑。
>
> ⚠️ **机器人不能主动发起私聊**（会返回 `230101`）。加上轮询模式拿不到私聊的 `chat_id`，所以**请用群聊**——建一个只有你和机器人的群，本质上就是私聊，还更好用。

### 2. 配置并运行

```bash
git clone <this-repo> pi-feishu
cd pi-feishu
npm install
cp .env.example .env
# 编辑 .env，填入 FEISHU_APP_ID / FEISHU_APP_SECRET
npm start
```

首次启动时白名单是空的，所以**没人能驱动它**。把你的 open_id 填进去：

```bash
# 1. 在飞书里给机器人发一条消息（会被拒绝，但你的 open_id 会打到日志里）
# 2. 从日志里找到它：
#    ┌─ 未授权的发送者 ─────────────────────
#    │ senderId : ou_xxxxxxxxxxxxxxxx
# 3. 填进 .env：
#    PI_FEISHU_DM_ALLOWLIST=ou_xxxxxxxxxxxxxxxx
```

重启后即可使用。

---

## 命令

在聊天里直接发消息就是和 pi 对话。以 `/` 开头的会被桥接管：

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示帮助 |
| `/new` | 开一个新会话（旧会话保留在磁盘上） |
| `/status` | 模型 / 思考等级 / 会话文件路径 / 工作目录 |
| `/model` | 列出可用模型 |
| `/model <provider/id>` | 切换模型（按会话生效并持久化） |
| `/thinking [level]` | 查看或设置思考等级 |
| `/cwd` | 查看工作目录 |
| `/cwd <绝对路径>` | 切换工作目录（会开新会话） |
| `/abort` | 中止当前任务 |
| `/whoami` | 显示你的 open_id / chat_id |
| 其他 `/xxx` | **原样交给 pi**（`/compact`、你装的扩展命令等） |

---

## 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | **必填** |
| `PI_FEISHU_TRANSPORT` | `poll` | `poll`（轮询）或 `events`（事件推送） |
| `PI_FEISHU_POLL_MS` | `3000` | 轮询间隔 |
| `PI_FEISHU_DM_MODE` | `allowlist` | `allowlist` / `open` / `disabled` |
| `PI_FEISHU_DM_ALLOWLIST` | 空 | 允许驱动 agent 的 open_id，逗号分隔 |
| `PI_FEISHU_GROUP_ALLOWLIST` | 空 | 允许的群 chat_id。**留空 = 自动信任机器人所在的所有群** |
| `PI_FEISHU_CHAT_IDS` | 空 | 额外监控的会话 ID |
| `PI_FEISHU_REQUIRE_MENTION` | `1` | 群里是否必须 @机器人 才响应 |
| `PI_FEISHU_CWD` | `~/pi-feishu/workspace` | agent 的默认工作目录，支持 `~` |
| `PI_FEISHU_MODEL` | pi 默认 | 覆盖模型 |
| `PI_FEISHU_THINKING` | pi 默认 | 思考等级 |
| `PI_FEISHU_IDLE_MS` | `900000` | 空闲多久回收 pi 子进程 |
| `PI_FEISHU_MAX_TURN_MS` | `1800000` | 单轮超时 |
| `PI_FEISHU_NOTIFY_ON_START` | `1` | 启动时是否发上线通知 |
| `PI_FEISHU_STATE_DIR` | `~/.pi-feishu` | 状态目录 |

### 关于「多个任务」

> **一个群 = 一个独立会话 + 独立工作目录 + 独立 pi 进程**

- **同一个群里**，任务**串行**（发第二条时第一条必须跑完）
- **不同群之间**，任务**真并行**

所以想同时干几件事，就建几个群，各自 `/cwd` 到不同项目：

```
群「写作」  →  /cwd ~/writing
群「代码」  →  /cwd ~/projects/foo
群「调研」  →  /cwd ~/notes
```

群白名单留空时，新建群 + 把机器人拉进去，**最多 15 秒后自动开始工作**，不用改配置或重启。

---

## 部署

### macOS（launchd）

```bash
bash scripts/install-launchd.sh

tail -f ~/.pi-feishu/server.log            # 日志
tail -f ~/.pi-feishu/server.err.log        # 错误
launchctl unload ~/Library/LaunchAgents/com.pi-feishu.plist   # 停止
launchctl kickstart -k gui/$(id -u)/com.pi-feishu             # 重启
```

装好后登录自启、崩溃自动拉起。

### Linux（systemd）

存为 `/etc/systemd/system/pi-feishu.service`：

```ini
[Unit]
Description=pi-feishu bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/pi-feishu
ExecStart=/usr/bin/node --env-file-if-exists=/home/YOUR_USER/pi-feishu/.env /home/YOUR_USER/pi-feishu/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pi-feishu
journalctl -u pi-feishu -f
```

### ⚠️ 关于常开

桥需要一台**常开的机器**。如果用笔记本当服务器，注意两件事：

1. **合盖休眠**会让它断线
   - macOS：`bash scripts/keep-awake.sh` （或改用「开盖 + `pmset -c sleep 0`」方案，脚本里都有）
   - Linux：`/etc/systemd/logind.conf` 里设 `HandleLidSwitch=ignore`
2. **电池鼓包**是长期插电的真正风险。锂电池在「长期满电 + 持续高温」下老化最快，建议：
   - 设置充电阈值到 50–80%（`tlp setcharge 60 80`，ThinkPad 支持最好）
   - 或者干脆拆掉电池
   - 每月检查一次机身有没有变形

**Mac mini / 迷你主机没有电池和盖子，不存在这两个问题。**

---

## 踩过的坑

这些都是在真实环境里踩出来并修掉的，写下来省得你重复：

### 1. `RpcClient` 的 `cliPath` 默认是相对路径

```js
// pi 的 dist/modes/rpc/rpc-client.js
const cliPath = this.options.cliPath ?? "dist/cli.js";
spawn("node", [cliPath, ...args], { cwd: this.options.cwd });   // ← cwd 是 agent 的工作目录
```

它 spawn 子进程时把 `cwd` 设成 agent 的工作目录，而 `cliPath` 是相对的——**必然解析失败**。必须用 `getPackageDir()` 算绝对路径。

### 2. 环境变量串味

pi 会把 `PI_SESSION_FILE` / `PI_PROVIDER` 等「会话元数据」注入给它启动的 shell 工具。如果桥是从另一个 pi 里启动的，这些值会串味给子进程，需要显式剔除。

### 3. launchd 的 PATH 里没有 node

**这个 bug 隐藏得最深。** launchd 启动服务时 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，没有 Homebrew 的 `/opt/homebrew/bin`。

服务本身能启动（plist 里写的是绝对路径），但 `RpcClient` 内部用**裸命令** `spawn("node", ...)` 起 pi 子进程 → `spawn node ENOENT` → 未捕获异常 → 进程以退出码 1 死掉 → launchd 反复重启。

修法：模块加载时把 `process.execPath` 所在目录补进 `PATH`（见 `src/pi-pool.js`），并在 plist 里显式声明 `EnvironmentVariables.PATH`。

### 4. SDK 的 `chatQueue` 会把 `/abort` 也排队

`@larksuiteoapi/node-sdk` 的 `safety.chatQueue` 按会话串行处理消息——听起来很好，但它会把 `/abort` 排在正在跑的任务**后面**，想打断得等它跑完。

修法：关掉它（`chatQueue: { enabled: false }`），自己只对 agent 轮次串行，让命令能插队。

### 5. 事件推送可能推不过来

有环境下飞书的事件推送会失败：长连接能建立、能收到 `pong` 心跳、所有权限 API 探测都通过、SDK 客户端也不存在任何「订阅」动作（订阅纯由服务端决定）——**但一个事件都收不到**。

所以默认走轮询模式。如果你的事件推送正常，把 `PI_FEISHU_TRANSPORT` 改成 `events` 即可获得毫秒级延迟。

---

## 已知限制

| 限制 | 说明 |
| --- | --- |
| **私聊不可用** | 飞书限制机器人主动发私聊（`230101`），轮询又拿不到私聊 `chat_id`。**用群聊代替** |
| **Extension UI 未实现** | 扩展若调用 `ctx.ui.confirm()` 会发出 `extension_ui_request` 并**阻塞等待**，桥没处理它，会静默卡到超时 |
| **图片输入未充分测试** | 代码已实现（`collectImages`），但缺少实际验证 |
| **无沙箱** | pi 拥有你账号的完整 shell 权限。**别用 `dmMode=open`** |
| **单轮 30 分钟上限** | 超时自动中止，可配置 |

---

## 安全须知

- **这个桥等于远程 shell。** 任何能驱动这个机器人的人，都能在你电脑上执行命令。
  - 不要用 `dmMode: open`
  - 保护好 `FEISHU_APP_SECRET`（`.env` 已在 `.gitignore` 里）
  - 建议 `PI_FEISHU_CWD` 指向专用目录
- 群白名单留空时**自动信任机器人所在的所有群**——别把机器人拉进任何公开群
- 需要更强隔离的话，见 pi 官方文档的 `docs/containerization.md`

### 防误提交密钥

仓库带了一个**为本项目定制的隐私扫描器**，它会检查飞书的 ID 格式（`cli_` / `ou_` / `oc_`）、通用密钥赋值、PEM 私钥、个人路径和邮箱：

```bash
bash scripts/check-privacy.sh            # 扫描所有已跟踪文件
bash scripts/check-privacy.sh --staged   # 只扫描暂存区
bash scripts/install-hooks.sh            # 装成 pre-commit hook，提交时自动拦截
```

> 这两个脚本都是**双向验证过的**：干净仓库通过，注入假密钥则 7 类全部拦截。
> 一个「永远通过」的扫描器是没有意义的。

### 凭据轮换

如果密钥已经泄漏过（比如不小心发到了聊天里／贴进了 issue），**真正管用的是轮换，而不是删除**。

```bash
bash scripts/set-secret.sh          # 更新 App Secret（read -s 隐藏输入）
bash scripts/set-secret.sh appid    # 更新 App ID
python3 scripts/redact-logs.py      # 把旧凭据从本机各类日志里清掉
```

`set-secret.sh` 用 `read -s` 读输入，密钥**不会进 shell 历史**；写完会自动调 `redact-logs.py` 清理日志，并可选重启服务。

> 一个容易忽略的点：**你排查问题的命令本身也会被记进对话日志**。如果命令里写了密钥字面量，脱敏工作就白做了。所以 `redact-logs.py` 是从 `.env` 读凭据，而不是从命令行参数。

CI（`.github/workflows/ci.yml`）里也跑同一套检查，包含三个 job：

| job | 内容 |
| --- | --- |
| **隐私与密钥扫描** | 拦截凭据泄漏（最重要的一个） |
| **语法检查** | `node --check` 全部 JS + `bash -n` 全部 shell 脚本 |
| **依赖安装** | `npm ci` 验证 lockfile 一致，并确认核心模块能被 import |

---

## 项目结构

```
src/
  index.js       入口：组装 channel / pool / 命令，处理入站消息
  bridge.js      pi RPC 事件流 → 卡片 markdown 增量（AsyncQueue + async generator）
  pi-pool.js     每个会话一个常驻 pi 子进程，空闲回收
  polling.js     轮询收件箱（不依赖事件推送的入站方案）
  commands.js    /help /new /status /model /thinking /cwd /abort /whoami
  config.js      环境变量读取 + 安全策略校验
  store.js       chatId → sessionFile/cwd 持久化，以及按会话串行
BRIDGE_PROMPT.md 桥专属系统提示词（用 --append-system-prompt 注入，不影响终端的 pi）
scripts/
  smoke-pi.js          冒烟测试：不连飞书，只验证 pi 这一侧
  test-commands.js     验证各命令背后的 API
  sessions.js          会话查看器：找到并恢复任意 pi 会话
  diagnose.js          诊断机器人是否收到过消息
  probe-events.js      原始事件探针（排查事件推送）
  probe-perms.js       反查哪些权限真的生效了
  check-privacy.sh     隐私 / 密钥扫描器
  install-hooks.sh     装成 git pre-commit hook
  set-secret.sh        安全录入新凭据（隐藏输入）
  redact-logs.py       从各类日志里清除凭据
  keep-awake.sh        笔记本合盖不休眠
  install-launchd.sh   macOS 开机自启
.github/workflows/ci.yml   隐私扫描 + 语法检查 + 依赖安装
```

---

## License

MIT
