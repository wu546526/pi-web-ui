# 🔗 tunnel —— pi-web-ui 网络隧道插件

反向隧道：你的其他设备（笔记本/台式机/手机终端）**主动连入** pi-web-ui 所在机器，
AI 由此以「设备所在网络」为出口做网络巡检与访问——**零公网暴露、天然穿 NAT**，
DNS 在出口设备侧解析，测得即该设备所在网络的真实结果。

## 更新日志

### 1.1.1（2026-10-22）
断线自愈三层修复（实战连环排查）：
- 服务端 isAlive 心跳单 miss 误杀 → 连续 3 miss（≈90s）宽限
- ver 握手 p7≠p8 阻塞自更新 → 服务端下发与 CLI 版本号同步改
- 同名设备「能力相同拒新连接」→ 新连接必胜（twin 接管，双进程互踢收敛）
- CLI 重连 connect 无响应挂死（SYN 黑洞）→ 10s 兕底废弃重来（已实战验证）

### 1.1.0（2026-10-20）
- 心跳保活 + 僵尸连接判定强制重连；连接/断开日志带时间戳
- spawn 替代 execFile（路径含空格）；双 label 卸载与配置热更

## 工作原理

```
[pi-web-ui 内的 AI] --SOCKS5(127.0.0.1:<socksPort>)--> [tunnel 插件] --WebSocket--> [你的设备: cli] --> 目标
```

- 设备侧 CLI 为单文件 Node 脚本（≥22），**主动出站**连宿主，无需公网 IP / 端口映射
- 多设备共存：所有在线设备互不干扰，SOCKS 流量走「当前出口设备」；出口掉线**自动切换**
- 服务端随宿主进程常驻（launchd/服务托管），面板可随时启停

## 功能

- **面板**（独立视图 tab）：隧道状态三态灯、出口设备列表（在线状态/系统/一键切换）、
  服务启停、接入令牌查看与重置、三平台（macOS/Windows/Linux）常驻安装命令一键复制
- **AI 工具 `tunnel_fetch`**：经隧道发 HTTP 请求（数据面在出口设备网络执行），
  对话里直接说「用隧道看下我的出口 IP」即可
- **CLI 一键分发**：面板下载已注入令牌的 CLI；设备接入后出现在设备列表
- **多平台常驻化**：macOS(launchd) / Windows(schtasks) / Linux(systemd --user) 安装命令
  按 OS 页签展示，装一次开机自启 + 掉线自愈
- **通知**：设备连入/断开、出口切换、令牌重置经 `host.notify` 推送

## 安装

面板「插件」→ 安装 → 填入本仓库插件目录：

```
xing-shuyin/pi-web-ui/tree/main/plugins/tunnel
```

或 CLI：`pi-web-ui install xing-shuyin/pi-web-ui/tree/main/plugins/tunnel`

## 设备接入

1. 面板「设备常驻化」选你的系统页签，复制命令到该设备终端执行
   （或先「下载 CLI」再手动运行：`node pi-tunnel-cli.mjs`）
2. 设备出现在「出口设备」列表后，即可被 AI 使用；多台设备可点「设为出口」切换

## AI 侧用法

```
tunnel_fetch {url: "http://myip.ipip.net"}          # 查出口设备网络的真实出口 IP
tunnel_fetch {url: "http://192.168.x.1/", timeout: 5}  # 探测出口设备所在内网的网关
```

## 安全

- SOCKS5 仅监听 `127.0.0.1`，宿主本机之外的进程不可用
- WS 隧道与面板路由均要求宿主令牌（`PI_WEB_TOKEN`）鉴权
- 接入令牌首次运行自动生成（不硬编码），可随时在面板重置
- 单条连接粒度的审计计数（面板可见累计连接数）

## 设置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| wsPort | 8765 | WS 隧道端口（全网卡，设备连入） |
| socksPort | 1080 | SOCKS5 端口（仅 127.0.0.1） |

## 开发

- 源码结构：`manifest.json` + `index.mjs`（服务端，全内联）+ `client/entry.mjs`（面板）
  + `assets/cli.mjs`（设备侧 CLI 模板，`/cli` 下载时注入令牌与地址）+ `client/sdk/`（SDK 拷贝）
- 服务端改动后需向宿主发 `plugins_reload`（浏览器刷新只更新面板，不重载服务端）
