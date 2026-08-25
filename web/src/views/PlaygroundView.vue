<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { NButton, NCard, NCollapse, NCollapseItem, NFormItem, NInput, NInputNumber, NSelect, NSpace, NTag } from "naive-ui";
import { Bot, RefreshCw, Send, Settings2, Trash2, UserRound } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api, jsonBody } from "../api";
import { errorText, useApiRequest } from "../composables/useApiRequest";
import { publicModelOptions } from "../utils/model-selection";
import {
  buildPlaygroundRequest,
  extractPlaygroundText,
  gatewayKeyAllowedModelIds,
  parsePlaygroundAdvancedJson,
  playgroundEndpoints,
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
  latencyMs?: number;
  raw?: string;
}

const endpointLabels: Record<PlaygroundEndpoint, string> = {
  responses: "Responses",
  chat: "Chat Completions",
  completions: "Completions",
};

const keys = ref<GatewayKey[]>([]);
const models = ref<PublicModel[]>([]);
const selectedKeyId = ref("");
const modelId = ref("");
const endpoint = ref<PlaygroundEndpoint>("responses");
const temperature = ref<number | null>(null);
const maxTokens = ref<number | null>(1024);
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
    .map((entry) => ({ role: entry.role, content: entry.content }));
}

async function scrollToBottom() {
  await nextTick();
  if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
}

function clearConversation() {
  messages.value = [];
  composer.value = "";
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
  messages.value.push({ id: crypto.randomUUID(), role: "user", content });
  composer.value = "";
  testing.value = true;
  await scrollToBottom();

  const body = buildPlaygroundRequest({
    endpoint: currentEndpoint,
    model: currentModel,
    messages: requestHistory(),
    systemPrompt: systemPrompt.value,
    temperature: temperature.value,
    maxTokens: maxTokens.value,
    advanced,
  });
  const startedAt = performance.now();

  try {
    const payload = await api<unknown>(`/playground/${currentEndpoint}/${encodeURIComponent(currentKeyId)}`, {
      method: "POST",
      body: jsonBody(body),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    const text = extractPlaygroundText(payload) || raw || "模型返回了空响应";
    messages.value.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      model: currentModel,
      endpoint: currentEndpoint,
      latencyMs,
      raw,
    });
  } catch (error) {
    messages.value.push({
      id: crypto.randomUUID(),
      role: "error",
      content: errorText(error),
      model: currentModel,
      endpoint: currentEndpoint,
      latencyMs: Math.round(performance.now() - startedAt),
    });
  } finally {
    testing.value = false;
    await scrollToBottom();
  }
}

onMounted(load);
</script>

<template>
  <page-header title="模型操场" description="选择网关 Key 和模型后直接开始多轮对话；演练沿用该 Key 的权限、限流、路由与请求日志。">
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
        <div>
          <strong>聊天对话</strong>
          <span v-if="modelId" class="chat-subtitle">{{ modelId }} · {{ endpointLabels[endpoint] }}</span>
        </div>
        <n-button size="small" quaternary :disabled="!messages.length || testing" @click="clearConversation">
          <template #icon><trash2 /></template>清空会话
        </n-button>
      </div>
    </template>

    <div ref="chatBody" class="chat-body">
      <div v-if="!messages.length" class="chat-empty">
        <bot :size="34" />
        <strong>开始一次模型对话</strong>
        <span>选择上方基础配置，然后在下方输入消息。后续消息会自动携带本页会话历史。</span>
      </div>

      <div v-for="entry in messages" :key="entry.id" class="chat-row" :class="`chat-row--${entry.role}`">
        <div class="chat-avatar">
          <user-round v-if="entry.role === 'user'" :size="17" />
          <bot v-else :size="17" />
        </div>
        <div class="chat-message">
          <div class="message-meta">
            <strong>{{ entry.role === 'user' ? '你' : entry.role === 'assistant' ? '模型' : '请求失败' }}</strong>
            <n-space v-if="entry.role !== 'user'" :size="5" wrap>
              <n-tag v-if="entry.latencyMs !== undefined" size="small" :bordered="false">{{ entry.latencyMs }} ms</n-tag>
              <n-tag v-if="entry.endpoint" size="small" :bordered="false">{{ endpointLabels[entry.endpoint] }}</n-tag>
              <n-tag v-if="entry.model" size="small" :bordered="false" class="mono">{{ entry.model }}</n-tag>
            </n-space>
          </div>
          <div class="message-bubble">{{ entry.content }}</div>
          <details v-if="entry.role === 'assistant' && entry.raw" class="raw-details">
            <summary>原始响应</summary>
            <pre>{{ entry.raw }}</pre>
          </details>
        </div>
      </div>

      <div v-if="testing" class="chat-row chat-row--assistant">
        <div class="chat-avatar"><bot :size="17" /></div>
        <div class="chat-message">
          <div class="message-meta"><strong>模型</strong></div>
          <div class="message-bubble typing"><span></span><span></span><span></span></div>
        </div>
      </div>
    </div>

    <div class="composer-wrap">
      <n-input
        v-model:value="composer"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 7 }"
        placeholder="输入消息，Enter 发送，Shift + Enter 换行"
        @keydown.enter.exact.prevent="send"
      />
      <div class="composer-footer">
        <span class="muted">{{ selectedKey ? `${selectedKey.name} · ${keyScopeText}` : '先选择可用的网关 Key' }}</span>
        <n-button type="primary" :loading="testing" :disabled="!canSend" @click="send">
          <template #icon><send /></template>发送
        </n-button>
      </div>
    </div>
  </n-card>
</template>

<style scoped>
.config-card { margin-bottom:18px; }
.config-grid { display:grid; grid-template-columns:minmax(180px,1.15fr) minmax(220px,1.35fr) minmax(150px,.8fr) minmax(130px,.65fr) minmax(150px,.75fr); gap:14px; align-items:start; }
.config-grid :deep(.n-form-item) { margin-bottom:0; }
.advanced-settings { margin-top:4px; border-top:1px solid var(--n-border-color); }
.advanced-settings :deep(.n-collapse-item__header) { padding-top:12px; }
.advanced-settings :deep(.n-collapse-item__content-inner) { padding-top:4px; }
.advanced-title { display:inline-flex; align-items:center; gap:7px; }
.advanced-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.chat-card { overflow:hidden; }
.chat-header { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.chat-header>div { min-width:0; display:flex; align-items:baseline; flex-wrap:wrap; gap:9px; }
.chat-subtitle { color:var(--n-text-color-3); font-size:12px; }
.chat-body { min-height:460px; max-height:62vh; overflow:auto; padding:24px; background:color-mix(in srgb,var(--n-color-embedded) 38%,transparent); scroll-behavior:smooth; }
.chat-empty { min-height:390px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px; color:var(--n-text-color-3); text-align:center; }
.chat-empty strong { color:var(--n-text-color-2); font-size:15px; }
.chat-empty span { max-width:470px; font-size:12px; line-height:1.65; }
.chat-row { display:flex; align-items:flex-start; gap:10px; max-width:920px; margin:0 auto 20px; }
.chat-row--user { flex-direction:row-reverse; }
.chat-avatar { width:32px; height:32px; flex:0 0 32px; display:flex; align-items:center; justify-content:center; border:1px solid var(--n-border-color); border-radius:9px; background:var(--n-color); color:var(--n-text-color-2); }
.chat-row--user .chat-avatar { background:var(--n-primary-color); color:#fff; border-color:transparent; }
.chat-row--error .chat-avatar { color:var(--n-error-color); }
.chat-message { min-width:0; max-width:min(78%,760px); }
.chat-row--user .chat-message { display:flex; align-items:flex-end; flex-direction:column; }
.message-meta { min-height:22px; display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:5px; color:var(--n-text-color-3); font-size:11px; }
.message-meta strong { color:var(--n-text-color-2); font-size:12px; }
.chat-row--user .message-meta { justify-content:flex-end; }
.message-bubble { padding:11px 14px; border:1px solid var(--n-border-color); border-radius:6px 14px 14px 14px; background:var(--n-color); white-space:pre-wrap; word-break:break-word; line-height:1.65; }
.chat-row--user .message-bubble { border-color:color-mix(in srgb,var(--n-primary-color) 28%,transparent); border-radius:14px 6px 14px 14px; background:color-mix(in srgb,var(--n-primary-color) 11%,var(--n-color)); }
.chat-row--error .message-bubble { border-color:color-mix(in srgb,var(--n-error-color) 35%,transparent); background:color-mix(in srgb,var(--n-error-color) 8%,var(--n-color)); color:var(--n-error-color); }
.raw-details { margin-top:7px; color:var(--n-text-color-3); font-size:11px; }
.raw-details summary { width:max-content; cursor:pointer; user-select:none; }
.raw-details pre { max-height:280px; overflow:auto; margin:8px 0 0; padding:12px; border:1px solid var(--n-border-color); border-radius:9px; background:var(--n-color); color:var(--n-text-color-2); font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; }
.typing { width:66px; display:flex; align-items:center; justify-content:center; gap:5px; }
.typing span { width:6px; height:6px; border-radius:50%; background:var(--n-text-color-3); animation:pulse 1.15s infinite ease-in-out; }
.typing span:nth-child(2) { animation-delay:.15s; }
.typing span:nth-child(3) { animation-delay:.3s; }
.composer-wrap { padding:16px 18px 18px; border-top:1px solid var(--n-border-color); background:var(--n-color); }
.composer-wrap :deep(textarea) { line-height:1.6; }
.composer-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:10px; font-size:11px; }
.composer-footer>span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@keyframes pulse { 0%,80%,100% { opacity:.32; transform:scale(.8); } 40% { opacity:1; transform:scale(1); } }
@media(max-width:1100px) { .config-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:760px) {
  .config-grid,.advanced-grid { grid-template-columns:1fr; gap:4px; }
  .chat-body { min-height:420px; padding:18px 12px; }
  .chat-message { max-width:86%; }
  .composer-wrap { padding:12px; }
}
@media(max-width:520px) {
  .config-grid { grid-template-columns:1fr; }
  .chat-message { max-width:calc(100% - 42px); }
  .composer-footer>span { display:none; }
  .composer-footer { justify-content:flex-end; }
}
</style>
