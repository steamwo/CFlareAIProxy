# OpenCode Zen 上游适配

## 定位

这里的 OpenCode 指 **OpenCode Zen AI Gateway 作为 CFlareAPI 的内置上游渠道**。

它与管理台“客户端集成”页面生成的 `opencode.json` 是两个方向：

```text
OpenCode Zen 上游：CFlareAPI → OpenCode Zen
OpenCode 客户端接入：OpenCode 客户端 → CFlareAPI
```

## 官方端点差异

Zen 的模型并不全部使用 Chat Completions：

| 类型 | 端点 |
|---|---|
| GPT | `/zen/v1/responses` |
| Claude / Qwen | `/zen/v1/messages` |
| Gemini | `/zen/v1/models/{model}:generateContent` 或 `:streamGenerateContent` |
| 其他 | `/zen/v1/chat/completions` |
| 模型目录 | `/zen/v1/models` |

因此，CFlareAPI 使用单独的 `opencode` adapter，而不是简单复用普通 OpenAI-compatible 转发器。

## 转换行为

### GPT

- Chat 请求转换为 Responses 请求；
- `/v1/responses` 可直接使用；
- Responses JSON/SSE 可转换回 OpenAI Chat 格式。

### Claude / Qwen

- `messages`、system/developer 消息转换为 Anthropic Messages；
- OpenAI function tools 转换为 Anthropic tools；
- `tool_calls` / tool result 双向转换；
- JSON 和 SSE 转换回 OpenAI Chat。

### Gemini

- 消息转换为 Google `contents` / `systemInstruction`；
- OpenAI function tools 转换为 Google function declarations；
- 非流调用使用 `generateContent`；
- 流式调用使用 `streamGenerateContent?alt=sse`；
- candidates、functionCall 和 usageMetadata 转换为 OpenAI Chat。

### 其他模型

通过 `/chat/completions` 透传。

## 动态模型发现

配置 API Key 时，每个启用账号单独请求 `/models`。此外，0.5.1 会在没有账号时每小时匿名读取实时目录，并仅保存 `big-pickle` 与当前 ID 以 `-free` 结尾的免费模型。成功结果写入 `discovered_models`，并记录可用网关接口。

公共模型 ID：

```text
opencode/<上游原始模型ID>
```

模型新增或删除后，刷新账号模型即可同步；项目不内置静态 Zen 模型名单。

## 自定义协议规则

若 Zen 修改分类或新增模型，可以覆盖：

```json
{
  "model_protocols": {
    "special-model": "anthropic"
  },
  "model_protocol_prefixes": {
    "gpt-": "responses",
    "claude-": "anthropic",
    "qwen": "anthropic",
    "gemini-": "google"
  }
}
```

可用值：

```text
responses
anthropic
google
chat
```

精确 `model_protocols` 优先于前缀规则。

## API Key 与匿名免费模型

匿名免费模型不发送 Authorization 请求头。要使用完整 Zen 目录，请在管理台账号池中为 `opencode` 添加 API Key。默认请求头：

```http
Authorization: Bearer <ZEN_API_KEY>
```

CFlareAPI 将凭据加密存入 D1。

## 已知边界

- Zen 的模型与协议可能随服务更新，应以实时 `/models` 和官方 Zen 文档为准。
- 匿名资格以实时目录中的 `big-pickle` / `*-free` 标识为准；付费模型绝不在无 Key 时尝试。
- 某些模型可能有专属 beta header 或参数；可以通过供应商 headers/options 覆盖。
- CFlareAPI 不伪造 Zen 余额；若没有稳定公开额度 API，只显示从响应头或已配置端点得到的数据。
