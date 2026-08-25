<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { NButton, NCard, NCollapse, NCollapseItem, NFormItem, NInput, NInputNumber, NSelect, NSpace, NSwitch, NTag } from "naive-ui";
import { Bot, MessageCircleMore, Radio, RefreshCw, Send, Settings2, Sparkles, Trash2, UserRound } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api, jsonBody } from "../api";
import { errorText, useApiRequest } from "../composables/useApiRequest";
import { publicModelOptions } from "../utils/model-selection";
import {
  buildPlaygroundRequest,
  extractPlaygroundText,
  gatewayKeyAllowedModelIds,
  parsePlaygroundAdvancedJson,
  parsePlaygroundResponsesStreamData,
  playgroundEndpoints,
  playgroundSseFrameData,
  type PlaygroundConversationMessage,
  type PlaygroundEndpoint,
} from "../utils/playground";
import type { GatewayKey, PublicModel } from "../types";

interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  model?: string;
  endpoint?: PlaygroundEndpoint;
  firstTokenMs?: number;
  latencyMs?: number;
  raw?: string;
  pending?: boolean;
  streaming?: boolean;
}

const endpointLabels: Record<PlaygroundEndpoint, string> = {
  responses: "Responses",
  chat: "Chat Completions",
  completions: "Completions",
};
const STREAM_RAW_LIMIT = 256_000;

const keys = ref<GatewayKey[]>([]);
const models = ref<PublicModel[]>([]);
const selectedKeyId = ref("");
const modelId = ref("");
const endpoint = ref<PlaygroundEndpoint>("responses");
const temperature = ref<number | null>(null);
const maxTokens = ref<number | null>(1024);
const streamResponses = ref(true);
const systemPrompt = ref("");
const advancedJson = ref("{}");
const composer = ref("");
const messages = ref<ChatEntry[]>([]);
const testing = ref(false);
const chatBody = ref<HTMLElement | null>(null);
const { loading, run } = useApiRequest();

const nowSeconds = () => Math.floor(Date.now() / 1000);
const keyUsable = (item: GatewayKey): boolean => item.enabled === 1 && (item.expires_at === null || item.expires_at > nowSeconds());
const selectedKey = computed(() => keys.value.find((item) => item.id === selectedKeyId.value));
const selectedAllowedModels = computed(() => gatewayKeyAllowedModelIds(selectedKey.value?.allowed_models_json ?? "[]"));
const availableModels = computed(() => {
  if (!selectedAllowedModels.value.length) return models.value;
  const allowed = new Set(selectedAllowedModels.value);
  return models.value.filter((model) => allowed.has(model.id));
});
const keyOptions = computed(() => keys.value.map((item) => ({
  label: `${item.name} · ${item.key_prefix}…${keyUsable(item) ? "" : " · 不可用"}`,
  value: item.id,
  disabled: !keyUsable(item),
})));
const modelOptions = computed(() => publicModelOptions(availableModels.value));
const selectedModel = computed(() => models.value.find((item) => item.id === modelId.value));
const supportedEndpoints = computed(() => playgroundEndpoints(selectedModel.value));
const endpointOptions = computed(() => supportedEndpoints.value.map((item) => ({ label: endpointLabels[item], value: item })));
const responsesStreaming = computed(() => endpoint.value === "responses" && streamResponses.value);
const conversationCount = computed(() => messages.value.filter((entry) => entry.role === "user" || entry.role === "assistant").length);
const canSend = computed(() => Boolean(
  selectedKey.value
  && keyUsable(selectedKey.value)
  && modelId.value
  && composer.value.trim()
  && supportedEndpoints.value.includes(endpoint.value)
  && !testing.value,
));
const keyScopeText = computed(() => selectedKey.value
  ? selectedAllowedModels.value.length ? `允许 ${selectedAllowedModels.value.length} 个模型` : "允许全部模型"
  : "请选择网关 Key");

function reconcileModel() {
  if (!availableModels.value.some((model) => model.id === modelId.value)) modelId.value = availableModels.value[0]?.id ?? "";
}

function reconcileEndpoint() {
  if (!supportedEndpoints.value.includes(endpoint.value)) endpoint.value = supportedEndpoints.value[0] ?? "responses";
}

watch(selectedKeyId, reconcileModel);
watch(modelId, reconcileEndpoint);

async function load() {
  await run(async () => {
    const [keyResult, modelResult] = await Promise.all([
      api<{ data: GatewayKey[] }>("/keys"),
      api<{ public: PublicModel[] }>("/models"),
    ]);
    keys.value = keyResult.data;
    models.value = modelResult.public;
    if (!keys.value.some((item) => item.id === selectedKeyId.value && keyUsable(item))) {
      selectedKeyId.value = keys.value.find(keyUsable)?.id ?? "";
    }
    reconcileModel();
    reconcileEndpoint();
  });
}

function requestHistory(): PlaygroundConversationMessage[] {
  return messages.value
    .filter((entry): entry is ChatEntry & { role: "user" | "assistant" } => entry.role === "user" || entry.role === "assistant")
    .filter((entry) => entry.content.length > 0)
    .map((entry) => ({ role: entry.role, content: entry.content }));
}

async function scrollToBottom(force = true) {
  await nextTick();
  const target = chatBody.value;
  if (!target) return;
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 150;
  if (force || nearBottom) target.scrollTop = target.scrollHeight;
}

function clearConversation() {
  messages.value = [];
  composer.value = "";
}

function formatDuration(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function entryById(id: string): ChatEntry | undefined {
  return messages.value.find((entry) => entry.id === id);
}

function responseFailureMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
      const message = (record.error as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message;
    }
    if (typeof record.message === "string" && record.message) return record.message;
  }
  return `请求失败 (${status})`;
}

async function streamingResponseError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  let payload: unknown = text;
  try { payload = text ? JSON.parse(text) as unknown : {}; } catch { /* keep text */ }
  return new Error(responseFailureMessage(payload, response.status));
}

function cappedRaw(value: string): string {
  if (value.length <= STREAM_RAW_LIMIT) return value;
  return `${value.slice(0, STREAM_RAW_LIMIT)}\n\n…原始 SSE 已截断…`;
}

async function consumeResponsesStream(
  currentKeyId: string,
  body: Record<string, unknown>,
  assistantId: string,
  startedAt: number,
): Promise<void> {
  const response = await fetch(`/admin/api/playground/responses/${encodeURIComponent(currentKeyId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: jsonBody(body),
  });
  if (!response.ok) throw await streamingResponseError(response);
  if (!response.body) throw new Error("流式响应没有可读取的响应体");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";

  const applyFrame = async (frame: string) => {
    if (!frame.trim()) return;
    const data = playgroundSseFrameData(frame);
    if (!data) return;
    const update = parsePlaygroundResponsesStreamData(data);
    if (update.error) throw new Error(update.error);

    const entry = entryById(assistantId);
    if (!entry) return;
    if (update.delta) {
      entry.content += update.delta;
      entry.firstTokenMs ??= Math.round(performance.now() - startedAt);
      await scrollToBottom(false);
    }
    if (update.completedText && !entry.content) entry.content = update.completedText;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw = cappedRaw(raw + chunk);
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      buffer = buffer.slice(boundary + separator.length);
      await applyFrame(frame);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) await applyFrame(buffer);
  const entry = entryById(assistantId);
  if (entry) {
    entry.raw = raw;
    entry.pending = false;
    entry.streaming = false;
    entry.latencyMs = Math.round(performance.now() - startedAt);
    if (!entry.content) entry.content = "模型返回了空响应";
  }
}

async function send() {
  if (!canSend.value || !selectedKey.value) return;

  let advanced: Record<string, unknown>;
  try {
    advanced = parsePlaygroundAdvancedJson(advancedJson.value);
  } catch (error) {
    messages.value.push({ id: crypto.randomUUID(), role: "error", content: errorText(error) });
    await scrollToBottom();
    return;
  }

  const content = composer.value.trim();
  const currentModel = modelId.value;
  const currentEndpoint = endpoint.value;
  const currentKeyId = selectedKeyId.value;
  const useStream = currentEndpoint === "responses" && streamResponses.value;
  messages.value.push({ id: crypto.randomUUID(), role: "user", content });
  composer.value = "";
  const history = requestHistory();
  const assistantId = crypto.randomUUID();
  messages.value.push({
    id: assistantId,
    role: "assistant",
    content: "",
    model: currentModel,
    endpoint: currentEndpoint,
    pending: true,
    streaming: useStream,
  });
  testing.value = true;
  await scrollToBottom();

  const body = buildPlaygroundRequest({
    endpoint: currentEndpoint,
    model: currentModel,
    messages: history,
    systemPrompt: systemPrompt.value,
    temperature: temperature.value,
    maxTokens: maxTokens.value,
    advanced,
    stream: useStream,
  });
  const startedAt = performance.now();

  try {
    if (useStream) {
      await consumeResponsesStream(currentKeyId, body, assistantId, startedAt);
    } else {
      const payload = await api<unknown>(`/playground/${currentEndpoint}/${encodeURIComponent(currentKeyId)}`, {
        method: "POST",
        body: jsonBody(body),
      });
      const entry = entryById(assistantId);
      if (entry) {
        const raw = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
        entry.content = extractPlaygroundText(payload) || raw || "模型返回了空响应";
        entry.latencyMs = Math.round(performance.now() - startedAt);
        entry.raw = raw;
        entry.pending = false;
      }
    }
  } catch (error) {
    const entry = entryById(assistantId);
    const message = errorText(error);
    if (entry?.content) {
      entry.pending = false;
      entry.streaming = false;
      entry.latencyMs = Math.round(performance.now() - startedAt);
      messages.value.push({
        id: crypto.randomUUID(),
        role: "error",
        content: `流式响应中断：${message}`,
        model: currentModel,
        endpoint: currentEndpoint,
      });
    } else if (entry) {
      entry.role = "error";
      entry.content = message;
      entry.pending = false;
      entry.streaming = false;
      entry.latencyMs = Math.round(performance.now() - startedAt);
    }
  } finally {
    testing.value = false;
    await scrollToBottom();
  }
}

onMounted(load);
</script>

<template>
  <page-header title="模型操场" description="选择网关 Key 和模型后直接开始多轮对话；Responses 支持 SSE 实时流式输出。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新配置</n-button>
  </page-header>

  <n-card title="基础配置" class="config-card">
    <div class="config-grid">
      <n-form-item label="网关 Key" :show-feedback="true">
        <n-select v-model:value="selectedKeyId" filterable :options="keyOptions" placeholder="选择 Key" />
        <template #feedback><span class="muted">{{ keyScopeText }}</span></template>
      </n-form-item>
      <n-form-item label="模型">
        <n-select v-model:value="modelId" filterable :options="modelOptions" placeholder="选择模型" />
      </n-form-item>
      <n-form-item label="接口">
        <n-select v-model:value="endpoint" :options="endpointOptions" placeholder="选择接口" />
      </n-form-item>
      <n-form-item label="Temperature">
        <n-input-number v-model:value="temperature" clearable :min="0" :max="2" :step="0.1" placeholder="默认" />
      </n-form-item>
      <n-form-item :label="endpoint === 'responses' ? 'Max output tokens' : 'Max tokens'">
        <n-input-number v-model:value="maxTokens" clearable :min="1" :step="128" placeholder="默认" />
      </n-form-item>
      <n-form-item v-if="endpoint === 'responses'" label="流式输出">
        <div class="stream-setting">
          <n-switch v-model:value="streamResponses" />
          <span>{{ streamResponses ? 'SSE 实时输出' : '等待完整响应' }}</span>
        </div>
      </n-form-item>
    </div>

    <n-collapse class="advanced-settings">
      <n-collapse-item name="advanced">
        <template #header><span class="advanced-title"><settings2 :size="15" />高级设置</span></template>
        <div class="advanced-grid">
          <n-form-item label="System Prompt">
            <n-input v-model:value="systemPrompt" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="可选，应用到整个会话" />
          </n-form-item>
          <n-form-item label="高级参数 JSON">
            <n-input v-model:value="advancedJson" type="textarea" class="mono" :autosize="{ minRows: 3, maxRows: 8 }" placeholder='例如 {"reasoning":{"effort":"high"}}' />
          </n-form-item>
        </div>
      </n-collapse-item>
    </n-collapse>
  </n-card>

  <n-card class="chat-card" content-style="padding:0">
    <template #header>
      <div class="chat-header">
        <div class="chat-identity">
          <div class="chat-mark"><message-circle-more :size="20" /></div>
          <div class="chat-heading">
            <div class="chat-title-row">
              <strong>模型对话</strong>
              <n-tag v-if="responsesStreaming" size="small" type="success" :bordered="false">
                <template #icon><radio :size="12" /></template>实时流式
              </n-tag>
            </div>
            <div class="chat-subtitle">
              <span v-if="modelId" class="mono">{{ modelId }}</span>
              <span v-if="modelId">·</span>
              <span>{{ endpointLabels[endpoint] }}</span>
              <span>·</span>
              <span>{{ conversationCount }} 条上下文</span>
            </div>
          </div>
        </div>
        <n-button size="small" quaternary :disabled="!messages.length || testing" @click="clearConversation">
          <template #icon><trash2 /></template>清空会话
        </n-button>
      </div>
    </template>

    <div ref="chatBody" class="chat-body">
      <div v-if="!messages.length" class="chat-empty">
        <div class="empty-orbit"><sparkles :size="28" /></div>
        <strong>开始一次真实模型对话</strong>
        <span>消息会沿用所选 Key 的权限、限流和路由策略；使用 Responses 时可实时看到 SSE 输出。</span>
        <div class="empty-features">
          <span>多轮上下文</span>
          <span>真实 Key 策略</span>
          <span>Responses SSE</span>
        </div>
      </div>

      <div v-for="entry in messages" :key="entry.id" class="chat-row" :class="`chat-row--${entry.role}`">
        <div class="chat-avatar">
          <user-round v-if="entry.role === 'user'" :size="17" />
          <bot v-else :size="17" />
        </div>
        <div class="chat-message">
          <div class="message-meta">
            <div class="message-role">
              <strong>{{ entry.role === 'user' ? '你' : entry.role === 'assistant' ? '模型' : '请求失败' }}</strong>
              <span v-if="entry.streaming && entry.pending" class="streaming-label"><i></i>正在输出</span>
            </div>
            <n-space v-if="entry.role !== 'user'" :size="5" wrap>
              <n-tag v-if="entry.firstTokenMs !== undefined" size="small" :bordered="false">首字 {{ formatDuration(entry.firstTokenMs) }}</n-tag>
              <n-tag v-if="entry.latencyMs !== undefined" size="small" :bordered="false">总耗时 {{ formatDuration(entry.latencyMs) }}</n-tag>
              <n-tag v-if="entry.endpoint" size="small" :bordered="false">{{ endpointLabels[entry.endpoint] }}</n-tag>
            </n-space>
          </div>
          <div class="message-bubble" :class="{ 'message-bubble--streaming': entry.streaming && entry.pending }">
            <span v-if="entry.content">{{ entry.content }}</span>
            <span v-if="entry.streaming && entry.pending && entry.content" class="stream-cursor"></span>
            <span v-if="entry.pending && !entry.content" class="typing"><i></i><i></i><i></i></span>
          </div>
          <details v-if="entry.role === 'assistant' && entry.raw" class="raw-details">
            <summary>查看原始{{ entry.streaming ? ' SSE' : '响应' }}</summary>
            <pre>{{ entry.raw }}</pre>
          </details>
        </div>
      </div>
    </div>

    <div class="composer-wrap">
      <div class="composer-shell">
        <n-input
          v-model:value="composer"
          class="composer-input"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 7 }"
          placeholder="给模型发送消息…"
          @keydown.enter.exact.prevent="send"
        />
        <div class="composer-footer">
          <div class="composer-hints">
            <span>Enter 发送 · Shift + Enter 换行</span>
            <n-tag v-if="responsesStreaming" size="small" type="success" :bordered="false">SSE</n-tag>
          </div>
          <n-button type="primary" size="large" :loading="testing" :disabled="!canSend" @click="send">
            <template #icon><send /></template>发送
          </n-button>
        </div>
      </div>
      <div class="composer-context">
        <span>{{ selectedKey ? `${selectedKey.name} · ${keyScopeText}` : '先选择可用的网关 Key' }}</span>
      </div>
    </div>
  </n-card>
</template>

<style scoped>
.config-card { margin-bottom:18px; }
.config-grid { display:grid; grid-template-columns:minmax(180px,1.15fr) minmax(220px,1.35fr) minmax(150px,.8fr) minmax(130px,.65fr) minmax(150px,.75fr) minmax(145px,.72fr); gap:14px; align-items:start; }
.config-grid :deep(.n-form-item) { margin-bottom:0; }
.stream-setting { min-height:34px; display:flex; align-items:center; gap:9px; color:var(--n-text-color-3); font-size:12px; }
.advanced-settings { margin-top:4px; border-top:1px solid var(--n-border-color); }
.advanced-settings :deep(.n-collapse-item__header) { padding-top:12px; }
.advanced-settings :deep(.n-collapse-item__content-inner) { padding-top:4px; }
.advanced-title { display:inline-flex; align-items:center; gap:7px; }
.advanced-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.chat-card { overflow:hidden; border-radius:14px; }
.chat-header { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.chat-identity { min-width:0; display:flex; align-items:center; gap:11px; }
.chat-mark { width:38px; height:38px; flex:0 0 38px; display:grid; place-items:center; border-radius:11px; background:color-mix(in srgb,var(--n-primary-color) 12%,var(--n-color)); color:var(--n-primary-color); }
.chat-heading { min-width:0; }
.chat-title-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.chat-title-row strong { font-size:15px; }
.chat-subtitle { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:3px; color:var(--n-text-color-3); font-size:11px; }
.chat-body { min-height:500px; max-height:64vh; overflow:auto; padding:28px 22px 22px; background:linear-gradient(180deg,color-mix(in srgb,var(--n-primary-color) 3%,var(--n-color-embedded)),var(--n-color-embedded) 170px); scroll-behavior:smooth; }
.chat-empty { min-height:420px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:11px; color:var(--n-text-color-3); text-align:center; }
.empty-orbit { width:64px; height:64px; display:grid; place-items:center; border:1px solid color-mix(in srgb,var(--n-primary-color) 26%,var(--n-border-color)); border-radius:20px; background:color-mix(in srgb,var(--n-primary-color) 8%,var(--n-color)); color:var(--n-primary-color); box-shadow:0 14px 36px color-mix(in srgb,var(--n-primary-color) 10%,transparent); }
.chat-empty strong { margin-top:4px; color:var(--n-text-color-1); font-size:16px; }
.chat-empty>span { max-width:520px; font-size:12px; line-height:1.7; }
.empty-features { display:flex; flex-wrap:wrap; justify-content:center; gap:7px; margin-top:4px; }
.empty-features span { padding:5px 9px; border:1px solid var(--n-border-color); border-radius:999px; background:var(--n-color); color:var(--n-text-color-3); font-size:10px; }
.chat-row { display:flex; align-items:flex-start; gap:11px; max-width:980px; margin:0 auto 22px; }
.chat-row--user { flex-direction:row-reverse; }
.chat-avatar { width:34px; height:34px; flex:0 0 34px; display:flex; align-items:center; justify-content:center; border:1px solid var(--n-border-color); border-radius:11px; background:var(--n-color); color:var(--n-text-color-2); box-shadow:0 4px 14px rgba(0,0,0,.04); }
.chat-row--assistant .chat-avatar { border-color:color-mix(in srgb,var(--n-primary-color) 22%,var(--n-border-color)); background:color-mix(in srgb,var(--n-primary-color) 7%,var(--n-color)); color:var(--n-primary-color); }
.chat-row--user .chat-avatar { background:var(--n-primary-color); color:#fff; border-color:transparent; }
.chat-row--error .chat-avatar { color:var(--n-error-color); }
.chat-message { min-width:0; max-width:min(80%,790px); }
.chat-row--user .chat-message { display:flex; align-items:flex-end; flex-direction:column; }
.message-meta { min-height:23px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:6px; color:var(--n-text-color-3); font-size:11px; }
.message-role { display:flex; align-items:center; gap:8px; }
.message-meta strong { color:var(--n-text-color-2); font-size:12px; }
.chat-row--user .message-meta { justify-content:flex-end; }
.streaming-label { display:inline-flex; align-items:center; gap:5px; color:var(--n-primary-color); font-size:10px; }
.streaming-label i { width:6px; height:6px; border-radius:50%; background:currentColor; box-shadow:0 0 0 4px color-mix(in srgb,var(--n-primary-color) 12%,transparent); animation:streamPulse 1.2s infinite ease-in-out; }
.message-bubble { padding:13px 15px; border:1px solid var(--n-border-color); border-radius:8px 16px 16px 16px; background:var(--n-color); box-shadow:0 5px 18px rgba(0,0,0,.035); white-space:pre-wrap; word-break:break-word; line-height:1.72; }
.chat-row--assistant .message-bubble { border-color:color-mix(in srgb,var(--n-primary-color) 14%,var(--n-border-color)); }
.chat-row--user .message-bubble { border-color:color-mix(in srgb,var(--n-primary-color) 35%,var(--n-border-color)); border-radius:16px 8px 16px 16px; background:color-mix(in srgb,var(--n-primary-color) 9%,var(--n-color)); }
.chat-row--error .message-bubble { border-color:color-mix(in srgb,var(--n-error-color) 48%,var(--n-border-color)); background:color-mix(in srgb,var(--n-error-color) 6%,var(--n-color)); color:var(--n-error-color); }
.message-bubble--streaming { min-width:84px; }
.stream-cursor { display:inline-block; width:2px; height:1.05em; margin-left:3px; border-radius:2px; background:var(--n-primary-color); vertical-align:-.14em; animation:cursorBlink .8s infinite; }
.raw-details { margin-top:8px; color:var(--n-text-color-3); font-size:11px; }
.raw-details summary { width:max-content; cursor:pointer; user-select:none; }
.raw-details pre { max-height:300px; overflow:auto; margin:8px 0 0; padding:12px; border:1px solid var(--n-border-color); border-radius:10px; background:var(--n-color); color:var(--n-text-color-2); font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; }
.typing { min-width:52px; display:inline-flex; align-items:center; justify-content:center; gap:5px; }
.typing i { width:6px; height:6px; border-radius:50%; background:var(--n-text-color-3); animation:typingPulse 1.15s infinite ease-in-out; }
.typing i:nth-child(2) { animation-delay:.15s; }
.typing i:nth-child(3) { animation-delay:.3s; }
.composer-wrap { padding:15px 18px 12px; border-top:1px solid var(--n-border-color); background:var(--n-color); }
.composer-shell { border:1px solid var(--n-border-color); border-radius:14px; padding:4px 5px 6px; background:var(--n-color); box-shadow:0 8px 28px rgba(0,0,0,.045); transition:border-color .2s,box-shadow .2s; }
.composer-shell:focus-within { border-color:color-mix(in srgb,var(--n-primary-color) 58%,var(--n-border-color)); box-shadow:0 8px 30px color-mix(in srgb,var(--n-primary-color) 8%,transparent); }
.composer-input :deep(.n-input__border),.composer-input :deep(.n-input__state-border) { display:none; }
.composer-input :deep(.n-input) { background:transparent; }
.composer-input :deep(textarea) { padding:10px 11px 5px; line-height:1.65; }
.composer-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:4px 4px 0 10px; }
.composer-hints { min-width:0; display:flex; align-items:center; gap:8px; color:var(--n-text-color-3); font-size:10px; }
.composer-context { padding:8px 6px 0; color:var(--n-text-color-3); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@keyframes typingPulse { 0%,80%,100% { opacity:.28; transform:translateY(0); } 40% { opacity:1; transform:translateY(-2px); } }
@keyframes streamPulse { 0%,100% { opacity:.45; } 50% { opacity:1; } }
@keyframes cursorBlink { 0%,45% { opacity:1; } 46%,100% { opacity:.18; } }
@media(max-width:1250px) { .config-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:760px) {
  .config-grid,.advanced-grid { grid-template-columns:1fr; gap:4px; }
  .chat-body { min-height:440px; padding:20px 12px; }
  .chat-message { max-width:87%; }
  .composer-wrap { padding:12px; }
  .composer-hints>span { display:none; }
}
@media(max-width:520px) {
  .chat-header { align-items:flex-start; }
  .chat-subtitle span:nth-last-child(-n+2) { display:none; }
  .chat-message { max-width:calc(100% - 44px); }
  .chat-avatar { width:31px; height:31px; flex-basis:31px; }
  .message-meta :deep(.n-space) { display:none; }
  .composer-context { display:none; }
}
</style>
