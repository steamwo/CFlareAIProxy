# CFlareAPI Proxy Bridge

CFlareAPI 供应商级代理桥接服务。Cloudflare Worker 将签名后的 HTTP 请求发送到 Bridge，Bridge 再通过指定的 HTTP、HTTPS 或 SOCKS 代理访问供应商，并把响应流原样转回 Worker。

## 支持的代理 URL

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

## 启动

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
|---|---:|---|
| `PORT` | `9090` | 监听端口 |
| `CFLARE_PROXY_TOKEN` | 无 | 必填，和管理台中的 Bridge Token 一致 |
| `CFLARE_PROXY_TOKENS` | 无 | 可选，逗号分隔的多 Token，用于轮换 |
| `CFLARE_PROXY_ALLOWED_HOSTS` | 所有 | 可选，允许访问的上游域名列表，例如 `auth.openai.com,chatgpt.com,api.openai.com` |
| `CFLARE_PROXY_MAX_BODY_BYTES` | `16777216` | 最大请求体大小 |
| `CFLARE_PROXY_MAX_CLOCK_SKEW_SECONDS` | `300` | 签名时间允许偏差 |

## 生产部署

Bridge 是 Node.js 服务，不运行在 Workers 中。部署到带 HTTPS 的 VPS、容器平台或内网机器，并通过反向代理或 Cloudflare Tunnel 暴露 HTTPS 地址。管理台填写的是 Bridge 基址，例如：

```text
https://proxy-bridge.example.com
```

也可以填写完整路径：

```text
https://proxy-bridge.example.com/v1/forward
```

本地 Worker 开发可以使用：

```text
http://127.0.0.1:9090
```

## 安全建议

- Bridge 必须使用强随机 Token；
- 生产环境必须使用 HTTPS；
- 尽量设置 `CFLARE_PROXY_ALLOWED_HOSTS`；
- 不要在日志中输出代理 URL，其中可能包含用户名和密码；
- Bridge 不接受任意客户端请求，所有转发请求都必须通过 HMAC 签名验证。
