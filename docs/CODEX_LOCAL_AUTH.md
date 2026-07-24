# Codex 授权指南

CFlareAIProxy 支持三种 Codex 凭据接入方式：

1. 管理台 PKCE 授权；
2. 本地授权助手完成首次 token exchange；
3. 导入或持续同步官方 Codex CLI 的授权文件。

推荐先使用管理台授权；只有 Worker 出口在 token exchange 阶段持续返回 403 时，再使用本地助手。

## 为什么浏览器登录成功仍可能 403

Codex 浏览器授权、localhost 回调和 OAuth token exchange 是不同网络路径：

```text
浏览器登录成功
  ≠
Cloudflare Worker 出口被 token endpoint 接受
```

常见错误：

```text
OAuth token endpoint returned 403
```

可能原因包括：

- Worker 或代理出口不被上游接受；
- authorization code 已使用或已过期；
- PKCE verifier / state 与当前会话不匹配；
- Token 或账号策略限制；
- 代理只改变了部分请求的出口。

## 方式一：管理台 PKCE 授权

打开管理台“授权”页面，选择 Codex 并发起授权：

```text
管理台创建 PKCE 会话
  ↓
浏览器打开 OpenAI 授权页
  ↓
登录完成后跳转 localhost:1455
  ↓
复制地址栏完整回调 URL
  ↓
粘贴回管理台
  ↓
Worker 校验 state，使用原 verifier 换取 Token
  ↓
加密保存并加入账号池
```

Codex 注册回调地址是：

```text
http://localhost:1455/auth/callback
```

本机没有监听 1455 时，浏览器显示“无法访问”是正常现象。不要刷新或修改 URL，直接复制地址栏中的完整地址，例如：

```text
http://localhost:1455/auth/callback?code=...&state=...
```

管理台会使用创建该授权会话时保存的 PKCE verifier 和 state 完成交换。

授权成功后，Worker 会异步刷新模型与额度。

## Codex 请求使用哪个代理

Codex 的以下请求共享最终代理策略：

- code → token；
- refresh token → access token；
- 模型发现；
- 配额刷新；
- 推理请求。

优先级：

```text
账号级 proxy_url / proxyUrl
  ↓ 未设置
Codex 渠道 Proxy URL
  ↓ 未设置
系统默认 Proxy URL
  ↓ 未设置
Worker 直连
```

账号级值为 `direct` 或 `none` 时，会明确绕过渠道与系统代理。

代理启用后失败不会静默回退直连。详见 [代理与出口策略](PROVIDER_PROXY.md)。

## 管理台授权失败时

### state 或会话错误

出现会话不存在、过期或 state 不匹配：

1. 关闭旧授权弹窗；
2. 重新发起授权；
3. 只粘贴这次新流程产生的回调 URL；
4. 不要混用多个浏览器标签页中的 code。

### token endpoint 403

1. 在 Codex 渠道或账号上配置代理；
2. 使用“验证出口 IP”确认出口已改变；
3. 确认代理能访问 `auth.openai.com` 与 Codex 上游；
4. 重新发起授权，旧 code 不能复用；
5. 仍失败时改用本地授权助手。

## 方式二：localhost 自动回调

本地运行网关时，可以启动 loopback 助手：

```powershell
pnpm run oauth:loopback -- --provider codex --gateway http://127.0.0.1:8787
```

该命令监听 localhost 回调，并把回调提交给 CFlareAIProxy 的授权会话，省去手动复制 URL。

远程 Worker 也可以作为 gateway 参数，但本机必须能访问该 Worker 的管理 API，并提供正确鉴权。

## 方式三：本地授权助手

当 Worker 出口即使经过代理仍被 token endpoint 拒绝时，让本机完成首次交换：

```text
浏览器登录
  ↓
回调到本机 localhost
  ↓
本机完成 PKCE code → token
  ↓
本地助手上传最终 Token
  ↓
Worker 使用 MASTER_KEY 加密写入 D1
```

运行：

```powershell
pnpm run codex:login -- --gateway http://127.0.0.1:8787
```

默认从 `.dev.vars` 读取 `ADMIN_TOKEN`。

远程 Worker：

```powershell
$env:ADMIN_TOKEN="..."
pnpm run codex:login -- --gateway https://gateway.example.com
```

本地助手会尽量让 authorization code、PKCE verifier 和首次 token exchange 不经过 Worker。

## 本地助手代理

显式指定：

```powershell
pnpm run codex:login -- --proxy http://127.0.0.1:7890
```

支持 curl 可识别的常见协议：

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

环境变量读取顺序包含：

```text
ALL_PROXY
HTTPS_PROXY
HTTP_PROXY
```

发现代理后，本地助手会调用系统 curl 完成 token exchange，因为 Node.js 原生 `fetch()` 不保证自动读取这些代理变量。

强制使用 curl：

```powershell
pnpm run codex:login -- --curl
```

本地授权助手的代理只影响本机流程。账号导入网关后的模型、额度、刷新和推理仍使用管理台中的账号/渠道/系统代理策略。

## 导入官方 Codex CLI 授权

默认同步：

```powershell
pnpm run codex:sync
```

默认文件：

```text
~/.codex/auth.json
```

指定文件：

```powershell
pnpm run codex:sync -- --file D:\secure\auth.json
```

首次同步创建凭据，后续同步更新同一个 credential，不会每次创建重复账号。

管理台“授权”页面也支持直接粘贴授权 JSON。命令行同步更适合需要持续跟随官方 CLI Token 轮换的环境。

## 持续同步 Token 轮换

```powershell
pnpm run codex:watch
```

默认每 60 秒检查一次。调整间隔：

```powershell
pnpm run codex:watch -- --interval 15
```

当官方 Codex CLI 刷新 access token 或 refresh token 时，变化会更新到 CFlareAIProxy 中已关联的 credential。

不要把过短轮询间隔用于大量账号，避免不必要的磁盘和管理 API 请求。

## 本地刷新

```powershell
pnpm run codex:refresh
```

脚本优先使用：

```text
.cflare/auth/codex-sync.json
```

若不存在，则自动选择唯一的 `codex-*.json`。存在多个账号时必须显式指定：

```powershell
pnpm run codex:refresh -- --file .cflare\auth\codex-user@example.com.json
```

Worker 推理链路也会在 Token 即将过期时尝试刷新，并使用 Durable Object 刷新锁避免同一账号并发刷新。

如果刷新锁已被其他请求持有，而 Token 已经完全过期，请求可能暂时返回 `CREDENTIAL_REFRESH_BUSY`。稍后重试即可。

## 授权文件安全

`.cflare/auth/` 中的文件可能包含 refresh token：

- 已加入 `.gitignore`；
- Unix 下写入时尝试设置 `0600`；
- 不要发送给他人；
- 不要同步到公共云盘；
- 不要粘贴到 issue、CI 日志或截图；
- 怀疑泄漏时撤销上游授权，并删除网关中的 credential。

同样需要保护：

```text
.dev.vars
ADMIN_TOKEN
MASTER_KEY
完整管理台导出的授权 JSON
```

## 推理期刷新与账号冷却

请求开始后，如果 Codex access token 在 5 分钟内过期，网关会：

1. 为该 credential 获取刷新锁；
2. 使用最终代理策略刷新 Token；
3. 更新加密凭据；
4. 释放刷新锁；
5. 继续当前推理请求。

认证、权限或限额错误可能让账号进入冷却。冷却期间账号池会选择其他可用账号，而不是继续请求同一个失败凭据。

## Codex 响应适配

Codex 上游以 Responses 为主。网关会处理：

- Chat / Completions 到 Responses 的请求转换；
- tools 与 tool choice 归一化；
- Codex 会话 Header；
- `response.failed` / `error` 事件分类；
- 未收到完成事件的中断流检测；
- 从 `response.output_item.done` 重建缺失的最终 output；
- Responses 到 Chat 的流式与非流式转换；
- usage、错误码、账号冷却和供应商健康记录。

当前不提供 Responses WebSocket，也不宣称实现 Codex CLI 的全部本地状态能力。

## 排查清单

1. 管理台授权会话是否仍有效；
2. 回调 URL 中的 state 是否属于当前会话；
3. authorization code 是否已使用；
4. Codex 账号、渠道或系统代理最终选中了哪一个；
5. 出口 IP 是否真的变化；
6. Worker 是否能访问 OAuth token endpoint；
7. 本地助手是否能通过 curl 完成交换；
8. `MASTER_KEY` 是否稳定，是否发生了无法解密旧凭据的问题；
9. 账号是否冷却、禁用、额度耗尽或并发已满；
10. 请求日志中的 `error.code` 与 `x-request-id`。