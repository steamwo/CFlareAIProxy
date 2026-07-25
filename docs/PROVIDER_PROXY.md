# 代理与出口策略

CFlareAIProxy 在 Cloudflare Worker 内使用原生 TCP Socket 实现 HTTP CONNECT 与 SOCKS5 代理。当前版本不依赖 Proxy Bridge，并且在选中代理后失败时不会静默回退到 Worker 直连出口。

## 代理优先级

```text
账号 metadata.proxy_url / metadata.proxyUrl
        ↓ 未设置
供应商或内置渠道 Proxy URL
        ↓ 未设置
系统默认 Proxy URL
        ↓ 未设置
Worker 直连
```

### 账号级代理

账号级代理优先级最高，适合：

- 某个 OAuth 账号必须使用固定地区出口；
- 同一供应商的不同账号使用不同代理；
- 为单个账号绕过供应商代理；
- 隔离发生风控或限流的出口。

账号 metadata 中使用：

```json
{
  "proxy_url": "socks5h://user:pass@host:1080"
}
```

兼容驼峰字段：

```json
{
  "proxyUrl": "http://user:pass@host:8080"
}
```

账号级值设为以下任一字符串时，会明确使用 Worker 直连并跳过供应商与系统代理：

```text
direct
none
```

这不是“未设置”。它是显式覆盖。

### 供应商或内置渠道代理

渠道级代理覆盖系统默认代理，通常用于让一个 provider 的所有账号共用出口。

它会用于该 provider 的日常上游请求，包括：

- 推理请求；
- OAuth Token 换取与刷新；
- 模型发现；
- 配额刷新；
- 出口 IP 验证。

当账号配置了自己的代理时，账号配置优先。

### 系统默认代理

系统代理作为没有账号级或供应商级配置时的默认出口。适合所有外部上游都需要同一个代理的部署。

## 支持协议

```text
http://user:pass@host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

说明：

- HTTPS 上游通过 HTTP CONNECT 或 SOCKS5 隧道建立 TLS；
- 使用 HTTP 代理访问 HTTPS 上游时，Proxy URL 仍填写 `http://`，不是 `https://`；
- `socks5h://` 与 `socks5://` 在 Worker 实现中都由代理连接目标主机；建议使用 `socks5h://` 明确表达远端解析意图；
- 代理用户名和密码支持 URL 编码。

示例：

```text
http://proxy.example.com:8080
http://alice:p%40ss@proxy.example.com:8080
socks5h://alice:secret@127.0.0.1:1080
```

## 请求链路

### HTTP 代理 + HTTPS 上游

```text
Worker
  └─ TCP → HTTP Proxy
       └─ CONNECT api.example.com:443
            └─ TLS → api.example.com
```

### SOCKS5 + HTTPS 上游

```text
Worker
  └─ TCP → SOCKS5 Proxy
       └─ SOCKS5 CONNECT api.example.com:443
            └─ TLS → api.example.com
```

Worker 会校验代理握手、CONNECT 状态、SOCKS5 认证结果、TLS 握手和上游 HTTP 响应头。

## 失败行为

选中代理后，以下问题会明确返回错误：

- 代理连接超时；
- HTTP CONNECT 被拒绝；
- SOCKS5 不支持所需认证方式；
- SOCKS5 用户名或密码错误；
- 代理无法连接目标主机；
- 隧道建立后 TLS 握手失败；
- 上游响应头无效或过大；
- 代理链路中途关闭。

**不会自动改用 Cloudflare 直连。** 这是为了避免在用户以为请求经过固定出口时发生隐蔽泄漏。

需要直连时，请删除代理配置，或在账号级显式设置 `direct` / `none`。

## 出口 IP 验证

管理台的代理编辑器会对比：

```text
Worker 直连 IP
代理出口 IP
```

判断：

- 两个 IP 不同：代理已改变出口；
- 两个 IP 相同：代理可能未改变出口、与 Worker 位于同一出口，或代理服务做了透明转发；
- 代理请求失败：优先检查协议、端口、认证、Cloudflare Socket 限制和目标可达性。

出口 IP 不同并不保证上游一定接受该出口。Codex 等服务仍可能基于 IP 信誉、区域、Token 状态或账号策略返回 403。

## Codex 授权与 403

Codex 的以下请求使用最终代理策略：

- PKCE code → token；
- refresh token → access token；
- 模型目录；
- 配额；
- 推理请求。

如果浏览器登录成功，但 Worker 换取 Token 返回 403：

1. 验证 Codex 渠道或账号代理出口；
2. 确认代理出口与 Worker 直连 IP 不同；
3. 检查代理是否允许访问 `auth.openai.com` 与 Codex 上游；
4. 尝试 [Codex 本地授权助手](CODEX_LOCAL_AUTH.md)，让首次 token exchange 在本机完成；
5. 不要反复提交同一个已使用或已过期的 authorization code。

## OpenCode 官方与镜像线路

OpenCode Zen 的官方请求和镜像故障转移都通过该账号的最终代理策略执行。

配置 API Key 时，网关先尝试官方线路；官方失败后可以尝试镜像。匿名免费模型直接使用镜像候选。镜像列表不等于代理列表：

- **代理**改变网络出口；
- **镜像**改变上游 Base URL。

二者可以同时生效。

## 安全存储

供应商和系统 Proxy URL 使用 `MASTER_KEY` 进行 AES-GCM 加密后写入 D1。管理 API 不应回显完整认证信息，界面只展示必要的协议和主机提示。

账号级代理位于加密凭据 metadata 的运行时配置中，也应视为敏感信息。

安全建议：

- 使用独立代理账号和最小权限；
- 不在 issue、截图或日志中粘贴完整 Proxy URL；
- 密码含特殊字符时进行 URL 编码；
- 怀疑泄漏时同时轮换代理密码和相关上游 Token；
- 不把 `.dev.vars` 或账号授权 JSON 提交到 Git。

## 超时

推理请求默认上游超时为 120 秒，provider 可以通过 `timeout_ms` 调整。代理 TCP 建连阶段最多使用请求超时与 20 秒中的较小值。

连接超时通常表示：

- 代理主机或端口不可达；
- Cloudflare 到代理的网络路径受限；
- 代理没有监听公网地址；
- 防火墙拒绝 Worker 出口；
- DNS 或目标主机解析异常。

## 常见错误定位

| 现象 | 优先检查 |
| --- | --- |
| `CONNECT_REJECTED` | HTTP 代理是否允许 CONNECT、认证是否正确。 |
| `AUTH_FAILED` | SOCKS5 用户名、密码和 URL 编码。 |
| `TLS_HANDSHAKE_FAILED` | 代理是否透明篡改 TLS、目标 SNI 是否可达。 |
| 连接超时 | 代理公网可达性、防火墙、端口和 Cloudflare Socket 支持。 |
| 出口 IP 未变化 | 是否配置到了正确层级、账号是否有 `direct` 覆盖。 |
| Codex 仍返回 403 | 出口信誉、Token、账号策略或首次 token exchange 路径。 |
| 模型发现能用但推理失败 | 账号级代理、请求超时、上游特定端点或协议差异。 |

## Proxy Bridge

`proxy-bridge/` 和以下变量仅为旧部署兼容保留：

```text
PROXY_BRIDGE_URL
PROXY_BRIDGE_TOKEN
```

新部署不需要安装、启动或暴露 Proxy Bridge。除非正在维护旧环境，否则不要新增这两个变量。