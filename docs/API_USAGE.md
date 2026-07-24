# API 与客户端接入

CFlareAIProxy 对外提供 OpenAI-compatible HTTP API。客户端只需要网关地址和在管理台创建的网关 Key，不需要接触任何上游 Token 或 API Key。

## 基础配置

```bash
export CFLARE_BASE_URL="https://你的-worker地址/v1"
export CFLARE_API_KEY="cfp_xxx"
```

所有 `/v1/*` 请求都使用 Bearer 鉴权：

```http
Authorization: Bearer cfp_xxx
```

管理台中的网关 Key 可以独立限制：

- 每分钟请求数（RPM）；
- 最大并发；
- 每月 Token；
- 允许使用的公开模型；
- 启用或禁用状态。

## API 一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/models` | 获取当前 Key 可见的公开模型与能力元数据。 |
| `POST` | `/v1/responses` | OpenAI Responses 风格请求。 |
| `POST` | `/v1/chat/completions` | Chat Completions 风格请求。 |
| `POST` | `/v1/completions` | 旧版 Completions 兼容入口。 |

网关会根据公开模型路由选择真实供应商、上游模型和账号。客户端不应依赖内部 provider ID 或 credential ID。

## 获取模型

```bash
curl "$CFLARE_BASE_URL/models" \
  -H "Authorization: Bearer $CFLARE_API_KEY"
```

典型响应：

```json
{
  "object": "list",
  "data": [
    {
      "id": "coding-fast",
      "object": "model",
      "created": 0,
      "owned_by": "cflare"
    }
  ]
}
```

部分模型会附加 `x_cflare_capabilities` 扩展字段，详见“模型能力元数据”。

## Chat Completions

### 非流式

```bash
curl "$CFLARE_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coding-fast",
    "messages": [
      {"role": "system", "content": "回答要简洁。"},
      {"role": "user", "content": "解释 Cloudflare Durable Objects。"}
    ],
    "stream": false
  }'
```

### 流式

```bash
curl -N "$CFLARE_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coding-fast",
    "messages": [{"role": "user", "content": "写一个 TypeScript hello world"}],
    "stream": true
  }'
```

不同上游可能使用 Responses、Anthropic Messages、Google GenerateContent 或专用 SSE。Provider adapter 会把请求和响应转换回客户端请求的 OpenAI 风格。

## Responses

```bash
curl "$CFLARE_BASE_URL/responses" \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coding-fast",
    "input": "给出一个 D1 查询示例",
    "stream": false
  }'
```

Codex 等 Responses 原生上游会优先保留 Responses 语义；Kimi、OpenCode 等渠道会按 adapter 支持范围完成转换。

## OpenAI Python SDK

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["CFLARE_API_KEY"],
    base_url=os.environ["CFLARE_BASE_URL"],
)

response = client.chat.completions.create(
    model="coding-fast",
    messages=[
        {"role": "user", "content": "用 Python 写一个快速排序"},
    ],
)

print(response.choices[0].message.content)
```

流式：

```python
stream = client.chat.completions.create(
    model="coding-fast",
    messages=[{"role": "user", "content": "逐步解释这段算法"}],
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

## OpenAI JavaScript SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CFLARE_API_KEY,
  baseURL: process.env.CFLARE_BASE_URL,
});

const response = await client.chat.completions.create({
  model: "coding-fast",
  messages: [{ role: "user", content: "生成一个 Hono 路由示例" }],
});

console.log(response.choices[0].message.content);
```

浏览器环境不应直接保存长期网关 Key。推荐由自己的后端调用 CFlareAIProxy，或创建限制严格、可随时吊销的专用 Key。

## 会话亲和

启用会话亲和的渠道会尽量让同一会话复用相同账号。可使用以下任一 Header：

```http
X-Session-Id: conversation-123
X-Conversation-Id: conversation-123
```

也可以使用请求体中的 `previous_response_id` 或 `user`。网关会将会话标识与 provider、网关 Key 组合后交给账号池，不会把原值直接当作全局账号选择键。

会话亲和是“尽量复用”，不是强制绑定。账号冷却、额度耗尽、并发已满或路由熔断时仍会切换。

## 模型能力元数据

`GET /v1/models` 可能返回：

```json
{
  "id": "coding-fast",
  "object": "model",
  "x_cflare_capabilities": {
    "inputModalities": ["text", "image"],
    "outputModalities": ["text"],
    "reasoningLevels": ["low", "medium", "high"],
    "supportsTools": true,
    "supportsImages": true
  }
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `inputModalities` | 已知支持的输入模态，例如 `text`、`image`。 |
| `outputModalities` | 已知支持的输出模态。 |
| `reasoningLevels` | 可接受的 reasoning effort。 |
| `supportsTools` | 是否支持工具调用。 |
| `supportsImages` | 是否支持图片输入。 |

这些字段是 CFlareAIProxy 扩展，不属于 OpenAI 标准字段。不了解扩展字段的客户端可以安全忽略。

当能力被明确标记为不支持时，网关会在请求进入上游前返回 `400`，常见错误码包括：

```text
MODEL_TOOLS_UNSUPPORTED
MODEL_IMAGE_INPUT_UNSUPPORTED
MODEL_REASONING_LEVEL_UNSUPPORTED
```

## 模型名称与路由

客户端只提交“公开模型名”，例如：

```json
{"model": "coding-fast"}
```

该名称可以对应：

- 一个供应商的一条固定模型；
- 多个同优先级供应商的加权聚合；
- 主线路和备用线路；
- OpenAI-compatible 上游模型的别名；
- 内置渠道动态发现的模型。

`/v1/models` 是当前 Key 的权威模型列表。未公开、未路由或不在 Key 允许范围内的模型不能调用。

## 请求大小、超时与重试

默认最大 JSON 请求体为 8 MiB，由 `MAX_BODY_BYTES` 控制。

Provider 可配置上游超时；未配置时推理默认使用 120 秒。网关会对可重试的网络错误、认证/限额故障和部分 5xx 尝试切换账号或线路，但客户端仍应实现有限次数的指数退避。

不建议对明显的 `400` 参数错误或 `403 MODEL_NOT_ALLOWED` 自动重试。

## 错误格式

错误响应保持统一结构：

```json
{
  "error": {
    "message": "No route is configured for model coding-fast",
    "type": "invalid_request_error",
    "code": "MODEL_NOT_FOUND",
    "request_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

响应 Header 也会包含：

```http
X-Request-Id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

排查问题时请同时记录 HTTP 状态码、`error.code` 和 `x-request-id`。

常见状态：

| 状态 | 常见含义 |
| --- | --- |
| `400` | 请求体、模型能力或参数不合法。 |
| `401` | 缺少或无效的网关 Key。 |
| `402` | 网关 Key 的月 Token 配额耗尽。 |
| `403` | Key 不允许访问该模型，或上游权限被拒绝。 |
| `404` | 没有该公开模型或没有对应路由。 |
| `429` | RPM、并发或上游限额触发。 |
| `502` | 上游协议、响应流或代理链路失败。 |
| `503` | 没有可用账号、供应商熔断、数据库未初始化等暂时不可用状态。 |
| `504` | 上游或代理连接超时。 |

## 用量与费用

成功响应中的 usage 会尽量归一化为：

```text
prompt_tokens
completion_tokens
cached_tokens
 total_tokens
```

不同上游提供的统计粒度不同。管理台中的费用由模型价格表按输入、输出和缓存命中 Token 计算；它是网关侧估算，不替代供应商账单。

请求日志默认保存模型、供应商、账号引用、状态码、Token、延迟、首 Token 延迟、错误码和费用，不保存完整提示词与输出。

## 接入检查

首次接入建议按顺序验证：

1. `GET /health` 返回 `status: ok` 与 `database: ok`；
2. `GET /v1/models` 能使用网关 Key 返回模型；
3. 用一个非流式 Chat 请求验证模型与路由；
4. 再测试流式、tools、图片或 reasoning；
5. 在“请求日志”中确认 provider、账号、usage 和错误信息符合预期。