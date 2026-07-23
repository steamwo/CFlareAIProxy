# 简化代理配置

管理台只要求填写一个 Proxy URL，不再依赖 Proxy Bridge。

## 优先级

```text
来源覆盖 Proxy URL
        ↓ 未设置
系统默认 Proxy URL
        ↓ 未设置
直接连接
```

“来源”同时包括内置渠道和 OpenAI-compatible 供应商。Codex OAuth 换取/刷新 Token、模型发现、额度读取与推理请求共用同一代理出口。

## 支持协议

```text
http://user:pass@host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

HTTPS 上游通过 HTTP CONNECT 或 SOCKS5 隧道传输，因此 HTTP 代理仍填写 `http://`，不要填写 `https://`。Proxy URL 使用 `MASTER_KEY` 加密存入 D1，管理端列表只返回协议和主机。

## 失败行为与出口验证

代理已启用时，连接失败会明确报错，不会静默回退到 Cloudflare Worker 的直连出口。渠道或供应商的“验证出口 IP”会同时显示 Worker 直连 IP 与代理出口 IP；两者相同时应检查代理是否真正改变了出口。

`proxy-bridge/` 目录仅为旧部署兼容保留，0.5.3 的 Worker 原生 HTTP/SOCKS 代理不需要 Bridge URL 或 Token。
