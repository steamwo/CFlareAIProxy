# 运维手册

面向已经部署完成的实例。部署本身见 [部署与升级指南](../DEPLOYMENT.md)。

- [管理台登录限流](#管理台登录限流)
- [故障告警](#故障告警)
- [配置备份与恢复](#配置备份与恢复)
- [轮换 MASTER_KEY](#轮换-master_key)
- [定时任务](#定时任务)

---

## 管理台登录限流

`/admin/api/login` 掌管着全部上游凭据的入口，因此失败尝试会被计数并锁定。

限流按两个作用域同时统计，任一触发即拒绝：

| 作用域 | 阈值 | 锁定时长 |
| --- | --- | --- |
| 单个 IP | 连续 5 次失败 | 60 秒起，每次继续失败翻倍，上限 30 分钟 |
| 全局 | 15 分钟内 50 次失败 | 5 分钟（不递增） |

全局作用域用于覆盖轮换 IP 的分布式尝试。它的代价是：持续的分布式攻击可以让密码登录不可用，因此锁定时长刻意保持恒定且较短。

### 被锁定时怎么办

锁定会自动过期，**不需要任何人工干预**。响应是 `429`，正文只说明"登录尝试过于频繁"，不透露剩余次数或锁定时长 —— 那些信息会直接帮助爆破方调整节奏。

如果需要在锁定期内进入管理台，有两条不受登录限流影响的通道：

- **已有的会话 Cookie** 仍然有效，换个已登录的浏览器标签即可。
- **`x-admin-token` 请求头** 走的是另一条鉴权路径，可以直接调用管理 API：

  ```bash
  curl -H "x-admin-token: $ADMIN_TOKEN" https://你的-worker地址/admin/api/session
  ```

### 关于阈值

阈值当前写在代码里（`src/rate-limiter.ts` 的 `LOGIN_IP_POLICY` 与 `LOGIN_GLOBAL_POLICY`），没有环境变量开关。计数保存在 `RateLimiter` Durable Object 中，重新部署不会清空；如果确实需要立即解锁，最直接的办法是等待锁定过期。

---

## 故障告警

熔断、账号耗尽、用量队列进入死信、定时清理失败这些事件默认只写运行日志。配置 webhook 后，它们会以一份固定结构的 JSON 推送出去。

### 配置

管理台「系统设置」页填入 webhook 地址即可，也可以直接调用 API：

```bash
curl -X PUT https://你的-worker地址/admin/api/settings/alerts \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"enabled": true, "webhookUrl": "https://你的中继地址/hook", "dedupeWindowMinutes": 15}'
```

保存后可以发一条测试告警确认链路通畅：

```bash
curl -X POST https://你的-worker地址/admin/api/settings/alerts/test \
  -H "x-admin-token: $ADMIN_TOKEN"
```

Webhook 地址必须是 HTTPS，保存后不会在任何接口中回显。

### Payload 结构

网关发送的是**厂商中立**的 JSON，不是任何 IM 的原生格式：

```json
{
  "schema": "cflare.alert.v1",
  "type": "provider_circuit_open",
  "severity": "warning",
  "target": "codex",
  "title": "上游 Codex 已熔断",
  "detail": "连续失败达到阈值，暂时停止向该供应商分发请求。",
  "service": "CFlareAIProxy",
  "timestamp": "2026-07-26T15:04:05.000Z",
  "timestampMs": 1785078245000,
  "context": { "providerId": "codex", "disabledUntil": 1785078845 }
}
```

`schema` 字段是稳定的版本标识；未来若需要不兼容的结构调整，会提升该值而不是就地改写字段含义。

要接入 Discord、Slack 或钉钉，在中间放一个自己控制的中继把这份 JSON 转成对应格式即可。网关刻意不内置任何厂商模板 —— 那会让每加一个平台就要改一次网关代码。

### 事件类型

| `type` | 触发时机 |
| --- | --- |
| `provider_circuit_open` | 某个供应商连续失败触发熔断 |
| `credentials_exhausted` | 某个渠道已无可用账号 |
| `usage_queue_dlq` | 用量写入重试耗尽，消息进入死信队列 |
| `cron_cleanup_failed` | 定时清理任务失败 |
| `alert_test` | 手动测试 |

### 去重

同一 `(type, target)` 组合在去重窗口内只发送一次，默认 15 分钟，可设为 1 分钟至 24 小时。这是必要的：熔断在持续故障期间会反复触发，逐次推送会把真正的新问题淹没。

去重状态保存在 KV 中，因此对多个 isolate 同时生效 —— 不会因为请求落到不同实例而重复投递。

告警发送失败（webhook 超时、返回错误）只记录日志，**不会影响网关的正常工作**，也不会重试。

---

## 配置备份与恢复

### 导出

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  https://你的-worker地址/admin/api/backup/export > backup.json
```

导出内容包含供应商、账号凭据、模型路由、网关密钥、模型价格、代理配置与系统设置。

**不包含**请求日志、用量聚合、已发现模型和配额快照 —— 这些是运行时数据，恢复后会自动重新累积。

### 关于安全性

凭据在备份文件中**保持密文原样**，不做解密。这意味着：

- 备份文件本身不含任何明文密钥；
- 恢复必须在**同一个 `MASTER_KEY`** 的实例上进行，否则密文无法解开。

网关密钥保存的是哈希值，因此恢复之后客户端手里原有的 Key **继续有效**，不需要重新分发。

### 恢复

```bash
curl -X POST https://你的-worker地址/admin/api/backup/import \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @backup.json
```

导入在单个事务中完成，要么整体成功要么整体不生效。格式版本不匹配的文件会被拒绝。

建议在每次重大配置变更前导出一份，并把文件存放在与 Cloudflare 账号相互独立的位置。

---

## 轮换 MASTER_KEY

`MASTER_KEY` 加密着全部上游凭据与代理地址。怀疑泄露时，可以在不停机的前提下更换。

### 步骤

1. 生成新密钥：

   ```bash
   openssl rand -base64 32
   ```

2. **先**把当前密钥保存为 `MASTER_KEY_PREVIOUS`，**再**把新密钥写入 `MASTER_KEY`：

   ```bash
   wrangler secret put MASTER_KEY_PREVIOUS   # 粘贴旧密钥
   wrangler secret put MASTER_KEY            # 粘贴新密钥
   ```

   顺序很重要。如果先换 `MASTER_KEY`，在设置 `MASTER_KEY_PREVIOUS` 之前的这段时间里，所有既有密文都解不开。

3. 此后新写入的密文使用新密钥；读取时若新密钥打不开，会自动回退到旧密钥。**服务全程可用**。

4. 用旧密钥加密的数据需要重新加密后才能移除 `MASTER_KEY_PREVIOUS`。最简单的做法是在管理台重新保存一次相关配置（供应商代理、系统代理），OAuth 账号则会在下次刷新 Token 时自然完成。

5. 确认无遗留后删除旧密钥：

   ```bash
   wrangler secret delete MASTER_KEY_PREVIOUS
   ```

### 注意

- 密文结构损坏（而非密钥不对）**不会**触发回退 —— 重试旧密钥不可能成功，那样只会让数据损坏伪装成"需要轮换"。
- 未配置 `MASTER_KEY_PREVIOUS` 时行为与轮换前完全一致，该变量是纯粹可选的。

---

## 定时任务

Worker 每小时执行一次定时任务，包含以下互相独立的工作：

| 任务 | 内容 |
| --- | --- |
| `request_log_cleanup` | 删除 24 小时前的请求明细 |
| `activity_cleanup` | 删除 90 天前的用量聚合 |
| `oauth_session_cleanup` | 删除已过期的 OAuth 会话 |
| `quota_refresh` | 刷新最久未检查的账号配额 |
| `model_refresh` | 刷新最久未发现的模型目录 |

各任务彼此隔离：其中一个失败不会阻止其余任务执行，失败项会单独记录日志并触发告警。

两个刷新任务单次最多处理 40 个账号，按"最久未刷新优先"排序。账号数超过单批上限时，连续几次执行会轮转覆盖整个账号池。管理台的刷新按钮同样遵守这个上限。

删除类任务分批执行，单次调用有批次上限。积压较多时（例如定时任务曾中断数日）会在后续几个小时内逐步清空，而不是在一次调用里尝试删除全部数据。
