# OpenCode Zen 上游适配

## 定位

这里的 OpenCode 指 **OpenCode Zen AI Gateway 作为 CFlareAIProxy 的内置上游渠道**。

它与 OpenCode 客户端接入网关是两个方向：

```text
OpenCode Zen 上游：CFlareAIProxy → OpenCode Zen
OpenCode 客户端接入：OpenCode 客户端 → CFlareAIProxy
```

CFlareAIProxy 对外仍提供 OpenAI-compatible API；Zen 的多种上游协议由 `opencode` adapter 在内部处理。

## 官方端点差异

Zen 模型不会全部使用 Chat Completions：

| 模型类型 | 上游端点 |
| --- | --- |
| GPT / Responses 类 | `/zen/v1/responses` |
| Claude / Qwen 类 | `/zen/v1/messages` |
| Gemini 类 | `/zen/v1/models/{model}:generateContent` 或 `:streamGenerateContent` |
| 其他模型 | `/zen/v1/chat/completions` |
| 模型目录 | `/zen/v1/models` |

因此不能只把 Zen Base URL 填进普通 OpenAI-compatible 转发器。专用 adapter 负责请求、工具、流事件、usage 和错误语义转换。

## 协议选择

默认按模型名前缀选择：

```json
{
  "model_protocol_prefixes": {
    "gpt-": "responses",
    "claude-": "anthropic",
    "qwen": "anthropic",
    "gemini-": "google"
  }
}
```

可选值：

```text
responses
anthropic
google
chat
```

精确规则优先于前缀规则：

```json
{
  "model_protocols": {
    "special-model": "anthropic"
  }
}
```

规则应根据 Zen 实时目录和实际协议更新，不要仅凭模型厂商名称猜测。

## 转换行为

### Responses 类模型

- Chat 请求转换为 Responses 输入；
- `/v1/responses` 尽量保留原生语义；
- Responses JSON / SSE 可转换回 Chat；
- 公开模型名可按路由设置回写到最终响应。

### Anthropic Messages 类模型

- system / developer / user / assistant 消息转换为 Messages；
- OpenAI function tools 转换为 Anthropic tools；
- `tool_calls` 与 tool result 双向转换；
- JSON 与 SSE 转换回 OpenAI Chat 或 Responses 风格。

这只是 Zen 上游内部适配，不代表 CFlareAIProxy 对外提供完整 Claude 原生 API。

### Google GenerateContent 类模型

- 消息转换为 `contents` 与 `systemInstruction`；
- OpenAI function tools 转换为 function declarations；
- 非流式使用 `generateContent`；
- 流式使用 `streamGenerateContent?alt=sse`；
- candidates、functionCall 和 usageMetadata 转换回 OpenAI 风格。

这不等同于对外提供完整 Gemini API。

### Chat 类模型

通过 `/chat/completions` 转发，并统一认证、代理、错误、账号调度和日志。

## 动态模型发现

配置 API Key 后，每个启用账号读取自己的 `/models`，因此不同账号可以拥有不同模型权限。

没有 API Key 时，网关可以刷新匿名免费目录，只保留实时目录中明确符合免费规则的模型，例如：

```text
big-pickle
*-free
```

公共模型通常使用：

```text
opencode/<上游原始模型 ID>
```

也可以通过模型路由改成自定义公开别名。

模型新增、删除或权限变化后，应刷新账号模型。项目不维护永久静态 Zen 模型名单，客户端以 `/v1/models` 为准。

## 模型能力

发现记录可以附加：

```json
{
  "inputModalities": ["text", "image"],
  "outputModalities": ["text"],
  "reasoningLevels": ["low", "medium", "high"],
  "supportsTools": true,
  "supportsImages": true
}
```

公开模型会通过 `x_cflare_capabilities` 暴露可用能力。网关在转发前会校验明确不支持的 tools、图片和 reasoning level。

当 Zen 目录信息不完整时，可以在路由 options 中覆盖能力；路由级配置优先。

## API Key 与匿名凭据

### 配置 API Key

官方请求默认使用：

```http
Authorization: Bearer <ZEN_API_KEY>
```

CFlareAIProxy 使用 `MASTER_KEY` 加密保存凭据。

### 匿名免费模型

匿名免费请求不会把真实账号 API Key 发给镜像，而是使用公共凭据标识。付费模型不会在无 Key 时尝试。

匿名资格由实时目录决定；模型曾经免费不代表之后仍免费。

## 官方线路与镜像故障转移

配置 API Key 时，请求顺序：

```text
官方 Zen
  ↓ 非成功响应或传输失败
镜像候选（轮换起点）
  ↓
下一个镜像
```

默认镜像：

```text
https://opencode.ai.cmliussss.net/zen/v1
https://opencode.fastly.cmliussss.net/zen/v1
https://opencode.gcore.cmliussss.net/zen/v1
```

可以追加：

```json
{
  "mirror_urls": [
    "https://mirror-a.example/zen/v1",
    "https://mirror-b.example/zen/v1"
  ]
}
```

或设置 Worker 变量：

```text
OPENCODE_MIRRORS_URL=https://mirror-a.example/zen/v1,https://mirror-b.example/zen/v1
```

镜像 URL 会去重，只接受 HTTP / HTTPS。

为了避免所有请求固定压在第一个镜像上，网关会随机选择一个镜像作为本次遍历起点，然后依次尝试。

## 认证失败与镜像成功

官方线路可能返回 401、403 或 429，而镜像仍成功。此时：

- 客户端可以收到镜像成功结果；
- 官方失败会保留为账号健康信息；
- 认证或限额错误可触发账号冷却；
- 后续请求仍可能优先尝试其他健康账号。

镜像成功不应被解释为官方 API Key 正常。

## 请求 Header

镜像请求会补充 OpenCode 客户端相关 Header，包括请求 ID、会话 ID、客户端类型和项目标识。每次请求生成独立的 message/session ID，避免不同请求共享固定标识。

用户自定义 Header 应谨慎覆盖，特别是 Authorization、User-Agent 和 OpenCode 会话字段。

## 代理

官方 Zen 与镜像请求都使用最终代理策略：

```text
账号级代理
  ↓
OpenCode 渠道代理
  ↓
系统默认代理
  ↓
Worker 直连
```

账号级 `direct` / `none` 会显式跳过后续代理。镜像改变的是上游地址，代理改变的是网络出口，两者可以同时使用。

详见 [代理与出口策略](PROVIDER_PROXY.md)。

## 配额与 usage

CFlareAIProxy 不伪造 Zen 余额。只有在存在稳定来源时才展示配额，例如：

- 官方额度 API；
- 配置的 quota endpoint；
- 推理响应 Header。

Responses、Anthropic、Google 和 Chat 的 usage 会尽量归一化到 prompt、completion、cached 与 total Token。不同模型的统计完整度可能不同，费用仍以供应商账单为准。

## 已知边界

- Zen 模型、端点和免费资格可能随服务更新；
- 某些模型可能要求专属 beta Header 或参数；
- Anthropic / Google 转换覆盖主路径，但不代表所有原生字段完全等价；
- 镜像是可用性补充，不是官方服务承诺；
- 镜像可能有独立限流、地区和数据处理策略；
- 当前网关对外不提供 Responses WebSocket；
- 模型能力元数据可能来自推断或上游目录，客户端仍应处理能力变化。

## 排查清单

1. `/v1/models` 是否包含目标公开模型；
2. 实际模型记录的 endpoint 与 protocol 是否正确；
3. API Key 账号是否启用、冷却或额度耗尽；
4. 官方失败时请求日志是否显示镜像成功；
5. `mirror_urls` / `OPENCODE_MIRRORS_URL` 是否为合法 Base URL；
6. 账号、渠道和系统代理是否存在覆盖；
7. tools、图片或 reasoning 是否被模型能力校验拒绝；
8. Zen 实时目录是否已经移除或重命名该模型。