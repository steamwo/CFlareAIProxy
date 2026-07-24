# CFlareAIProxy Proxy Bridge（旧部署兼容）

> [!WARNING]
> 当前 `dev` 分支的 Cloudflare Worker 已原生支持 HTTP CONNECT 与 SOCKS5 代理。**新部署不需要 Proxy Bridge，也不应默认配置 `PROXY_BRIDGE_URL` / `PROXY_BRIDGE_TOKEN`。**

本目录只为仍在维护旧版本 Worker 的用户保留。旧 Worker 会把签名后的 HTTP 请求发送到 Bridge，Bridge 再通过指定的 HTTP、HTTPS 或 SOCKS 代理访问上游，并把响应流转回 Worker。

当前原生代理文档见：

- [代理与出口策略](../docs/PROVIDER_PROXY.md)
- [部署与升级指南](../DEPLOYMENT.md)

## 什么时候才需要使用

仅在以下情况考虑 Bridge：

- 仍运行不支持 Worker 原生 Socket 代理的旧版本；
- 旧部署配置和运维流程暂时无法升级；
- 已明确确认当前 Worker 代码仍会读取并调用 Bridge。

不要为了普通 HTTP / SOCKS5 代理在新版本中新增一个 Node.js 转发服务。它会增加凭据、网络、部署、监控和攻击面。

## 旧版支持的代理 URL

```text
http://user:pass@host:port
https://user:pass@host:port
socks://user:pass@host:port
socks4://host:port
socks4a://host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

推荐远程 DNS 解析时使用 `socks5h://`。

## 启动旧 Bridge

```bash
npm install
CFLARE_PROXY_TOKEN="replace-with-a-long-random-secret" npm start
```

Windows PowerShell：

```powershell
$env:CFLARE_PROXY_TOKEN="replace-with-a-long-random-secret"
npm install
npm start
```

健康检查：

```bash
curl http://127.0.0.1:9090/health
```

Docker Compose：

```bash
cp .env.example .env
# 编辑 .env 中的 CFLARE_PROXY_TOKEN
docker compose up -d --build
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `PORT` | `9090` | 监听端口。 |
| `CFLARE_PROXY_TOKEN` | 无 | 必填，和旧 Worker 中的 Bridge Token 一致。 |
| `CFLARE_PROXY_TOKENS` | 无 | 可选，逗号分隔的多 Token，用于轮换。 |
| `CFLARE_PROXY_ALLOWED_HOSTS` | 所有 | 可选，允许访问的上游域名列表。 |
| `CFLARE_PROXY_MAX_BODY_BYTES` | `16777216` | 最大请求体大小。 |
| `CFLARE_PROXY_MAX_CLOCK_SKEW_SECONDS` | `300` | 签名时间允许偏差。 |

## 旧版生产部署

Bridge 是 Node.js 服务，不运行在 Workers 中。应部署到带 HTTPS 的 VPS、容器平台或内网机器，并通过反向代理或 Cloudflare Tunnel 暴露 HTTPS 地址。

旧 Worker 中的 Bridge 基址示例：

```text
https://proxy-bridge.example.com
```

或完整路径：

```text
https://proxy-bridge.example.com/v1/forward
```

本地旧 Worker 开发可以使用：

```text
http://127.0.0.1:9090
```

## 安全建议

- Bridge 必须使用强随机 Token；
- 生产环境必须使用 HTTPS；
- 尽量设置 `CFLARE_PROXY_ALLOWED_HOSTS`；
- 不要在日志中输出代理 URL；
- 所有转发请求必须通过 HMAC 签名验证；
- 不再需要 Bridge 后，应删除 Worker 变量、关闭服务并撤销 Token；
- 升级到原生代理后，使用管理台“验证出口 IP”确认新链路再下线旧 Bridge。