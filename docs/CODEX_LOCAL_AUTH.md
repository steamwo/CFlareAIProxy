# Codex 本地授权助手

## 问题

Codex 浏览器授权可以成功，但由 Cloudflare Worker 请求 OAuth token endpoint 时，可能返回：

```text
OAuth token endpoint returned 403
```

这通常与发起 token exchange 的网络路径有关。浏览器登录、回调成功并不代表 Worker 数据中心出口也会被 token endpoint 接受。

## 管理台直接授权（0.5.1）

管理台现在可以完整创建 PKCE 会话、打开官方授权页并换取 Token：

```text
管理台开始授权
  ↓
浏览器完成 OpenAI 登录
  ↓
跳转到 localhost 固定回调
  ↓
复制地址栏完整回调 URL 到管理台
  ↓
Worker 使用同一 PKCE verifier 换取并保存 Token
```

Codex 的注册回调仍是 localhost，远程 Worker 无法直接监听用户电脑的 1455 端口，因此管理台采用“粘贴完整回调 URL”的方式完成状态校验和 code exchange。换取 Token 会使用 Codex 渠道配置的代理。

若希望 localhost 回调自动完成，可运行：

```powershell
pnpm run oauth:loopback -- --provider codex --gateway http://127.0.0.1:8787
```

## 本地授权助手（兜底）

当 Worker 出口即使经过代理仍被 token endpoint 拒绝时，使用本地助手：

```text
浏览器登录
  ↓
回调到用户电脑 localhost
  ↓
用户电脑完成 PKCE code→token
  ↓
本地助手将最终 Token 上传给 CFlareAPI
  ↓
Worker 使用 MASTER_KEY 加密写入 D1
```

授权码、PKCE verifier 和首次 token exchange 不经过 Worker。

## 登录

```powershell
pnpm run codex:login -- --gateway http://127.0.0.1:8787
```

默认从 `.dev.vars` 读取 `ADMIN_TOKEN`。

远程 Worker：

```powershell
$env:ADMIN_TOKEN="..."
pnpm run codex:login -- --gateway https://gateway.example.com
```

## 代理

```powershell
pnpm run codex:login -- --proxy http://127.0.0.1:7890
```

也支持：

```text
HTTPS_PROXY
HTTP_PROXY
```

发现代理后会调用系统 curl 完成 token exchange。原因是 Node.js 原生 `fetch()` 不保证自动读取这些代理环境变量。

强制使用 curl：

```powershell
pnpm run codex:login -- --curl
```

## 导入官方 Codex CLI 授权

```powershell
pnpm run codex:sync
```

默认路径：

```text
~/.codex/auth.json
```

指定文件：

```powershell
pnpm run codex:sync -- --file D:\secure\auth.json
```

首次同步创建凭据，后续同步 PATCH 同一个 credential，不会重复创建账号。

## 持续同步 Token 轮换

```powershell
pnpm run codex:watch
```

默认每 60 秒检查一次。调整间隔：

```powershell
pnpm run codex:watch -- --interval 15
```

官方 Codex CLI 刷新或轮换 access/refresh token 后，变化会同步到 CFlareAPI。

## 本地刷新

```powershell
pnpm run codex:refresh
```

脚本会优先使用 `.cflare/auth/codex-sync.json`；若不存在，则自动选择唯一的 `codex-*.json`。存在多个本地账号时必须使用：

```powershell
pnpm run codex:refresh -- --file .cflare\auth\codex-user@example.com.json
```

## 文件安全

`.cflare/auth/` 中的文件包含 refresh token：

- 已加入 `.gitignore`；
- Unix 下写入时尝试设置 `0600`；
- 不要发送给他人或同步到公共云盘；
- 怀疑泄露时应撤销授权并删除网关凭据。

## Worker 换取 Token

管理台授权会由 Worker 换取 Token，并自动使用 Codex 渠道的代理覆盖或系统代理。

若返回 403，系统会提示改用：

```powershell
pnpm run codex:login
```

而不是无意义地反复轮询。

## 代理协议

本地授权助手支持：

```text
http://
https://
socks://
socks4://
socks4a://
socks5://
socks5h://
```

示例：

```powershell
pnpm run codex:login -- --proxy socks5h://127.0.0.1:1080
```

也会依次读取 `ALL_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY`。供应商日常推理与 Token 刷新使用管理台里的供应商级代理配置，两者互不覆盖。
