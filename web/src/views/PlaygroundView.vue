<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NInputNumber, NSelect, NSpace, NTag } from "naive-ui";
import { KeyRound, Play, RefreshCw, Trash2 } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import { useApiRequest } from "../composables/useApiRequest";
import { publicModelOptions } from "../utils/model-selection";
import {
  buildPlaygroundRequest,
  extractPlaygroundText,
  gatewayKeyAllowedModelIds,
  parsePlaygroundAdvancedJson,
  playgroundEndpoints,
  type PlaygroundEndpoint,
} from "../utils/playground";
import type { GatewayKey, PublicModel } from "../types";

const endpointLabels: Record<PlaygroundEndpoint, string> = {
  responses: "Responses API",
  chat: "Chat Completions",
  completions: "Completions",
};
const endpointPaths: Record<PlaygroundEndpoint, string> = {
  responses: "/v1/responses",
  chat: "/v1/chat/completions",
  completions: "/v1/completions",
};

const keys = ref<GatewayKey[]>([]);
const models = ref<PublicModel[]>([]);
const selectedKeyId = ref("");
const apiKey = ref("");
const modelId = ref("");
const endpoint = ref<PlaygroundEndpoint>("responses");
const systemPrompt = ref("");
const prompt = ref("");
const temperature = ref<number | null>(null);
const maxTokens = ref<number | null>(1024);
const advancedJson = ref("{}");
const testing = ref(false);
const responseStatus = ref<number | null>(null);
const responseLatencyMs = ref<number | null>(null);
const responseText = ref("");
const responseRaw = ref("");
const responseError = ref("");
const { loading, run } = useApiRequest();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const selectedKey = computed(() => keys.value.find((item) => item.id === selectedKeyId.value));
const selectedAllowedModels = computed(() => gatewayKeyAllowedModelIds(selectedKey.value?.allowed_models_json ?? "[]"));
const availableModels = computed(() => {
  if (!selectedAllowedModels.value.length) return models.value;
  const allowed = new Set(selectedAllowedModels.value);
  return models.value.filter((model) => allowed.has(model.id));
});
const keyOptions = computed(() => keys.value.map((item) => ({
  label: `${item.name} · ${item.key_prefix}…${item.enabled === 1 ? "" : " · 已停用"}`,
  value: item.id,
  disabled: item.enabled !== 1,
})));
const modelOptions = computed(() => publicModelOptions(availableModels.value));
const selectedModel = computed(() => models.value.find((item) => item.id === modelId.value));
const supportedEndpoints = computed(() => playgroundEndpoints(selectedModel.value));
const endpointOptions = computed(() => supportedEndpoints.value.map((item) => ({ label: endpointLabels[item], value: item })));
const keyPrefixMatches = computed(() => !selectedKey.value || !apiKey.value || apiKey.value.startsWith(selectedKey.value.key_prefix));
const canSend = computed(() => Boolean(
  selectedKey.value?.enabled === 1
  && apiKey.value.trim()
  && keyPrefixMatches.value
  && modelId.value
  && prompt.value.trim()
  && supportedEndpoints.value.includes(endpoint.value),
));

function reconcileModel() {
  if (!availableModels.value.some((model) => model.id === modelId.value)) modelId.value = availableModels.value[0]?.id ?? "";
}

function reconcileEndpoint() {
  if (!supportedEndpoints.value.includes(endpoint.value)) endpoint.value = supportedEndpoints.value[0] ?? "responses";
}

watch(selectedKeyId, () => {
  apiKey.value = "";
  reconcileModel();
});
watch(modelId, reconcileEndpoint);

async function load() {
  await run(async () => {
    const [keyResult, modelResult] = await Promise.all([
      api<{ data: GatewayKey[] }>("/keys"),
      api<{ public: PublicModel[] }>("/models"),
    ]);
    keys.value = keyResult.data;
    models.value = modelResult.public;
    if (!keys.value.some((item) => item.id === selectedKeyId.value && item.enabled === 1)) {
      selectedKeyId.value = keys.value.find((item) => item.enabled === 1)?.id ?? "";
    }
    reconcileModel();
    reconcileEndpoint();
  });
}

function clearResult() {
  responseStatus.value = null;
  responseLatencyMs.value = null;
  responseText.value = "";
  responseRaw.value = "";
  responseError.value = "";
}

function errorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
    if (typeof payload.message === "string") return payload.message;
  }
  return `请求失败 (${status})`;
}

async function send() {
  if (!canSend.value || !selectedKey.value) return;
  clearResult();
  testing.value = true;
  const startedAt = performance.now();
  try {
    const advanced = parsePlaygroundAdvancedJson(advancedJson.value);
    const body = buildPlaygroundRequest({
      endpoint: endpoint.value,
      model: modelId.value,
      prompt: prompt.value,
      systemPrompt: endpoint.value === "completions" ? undefined : systemPrompt.value,
      temperature: temperature.value,
      maxTokens: maxTokens.value,
      advanced,
    });
    const response = await fetch(endpointPaths[endpoint.value], {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey.value.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    responseStatus.value = response.status;
    const raw = await response.text();
    let payload: unknown = raw;
    try {
      payload = raw ? JSON.parse(raw) as unknown : {};
    } catch {
      payload = raw;
    }
    responseRaw.value = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    responseText.value = extractPlaygroundText(payload);
    if (!response.ok) responseError.value = errorMessage(payload, response.status);
  } catch (error) {
    responseError.value = error instanceof Error ? error.message : String(error);
  } finally {
    responseLatencyMs.value = Math.round(performance.now() - startedAt);
    testing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <page-header title="模型操场" description="使用真实网关 API Key 直接调用现有 /v1 接口，验证模型、路由、鉴权和限流的实际行为。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新配置</n-button>
  </page-header>

  <div class="playground-grid">
    <n-card title="请求配置" class="request-card">
      <n-alert type="info" :bordered="false" class="key-note">
        服务端只保存网关 Key 的哈希和前缀。选择 Key 用于读取其模型范围与状态；完整 Key 仅在本页用于请求，不会写入配置或浏览器存储。
      </n-alert>

      <n-form label-placement="top">
        <n-form-item label="网关 API Key">
          <n-select v-model:value="selectedKeyId" filterable :options="keyOptions" placeholder="选择网关 Key" />
        </n-form-item>
        <n-form-item label="完整 Key">
          <n-input v-model:value="apiKey" type="password" show-password-on="click" placeholder="粘贴 sk_cfapi_...">
            <template #prefix><key-round :size="16" /></template>
          </n-input>
          <template #feedback>
            <span v-if="selectedKey && !keyPrefixMatches" class="feedback-error">完整 Key 与所选 Key 前缀不匹配</span>
            <span v-else-if="selectedKey" class="muted">{{ selectedAllowedModels.length ? `允许 ${selectedAllowedModels.length} 个模型` : '允许全部模型' }}</span>
          </template>
        </n-form-item>

        <div class="field-grid">
          <n-form-item label="模型">
            <n-select v-model:value="modelId" filterable :options="modelOptions" placeholder="选择模型" />
          </n-form-item>
          <n-form-item label="接口">
            <n-select v-model:value="endpoint" :options="endpointOptions" placeholder="选择接口" />
          </n-form-item>
        </div>

        <n-form-item v-if="endpoint !== 'completions'" label="System Prompt">
          <n-input v-model:value="systemPrompt" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="可选" />
        </n-form-item>
        <n-form-item label="Prompt">
          <n-input v-model:value="prompt" type="textarea" :autosize="{ minRows: 6, maxRows: 14 }" placeholder="输入要发送给模型的内容" />
        </n-form-item>

        <div class="field-grid">
          <n-form-item label="Temperature（可选）">
            <n-input-number v-model:value="temperature" clearable :min="0" :max="2" :step="0.1" placeholder="不传" />
          </n-form-item>
          <n-form-item :label="endpoint === 'responses' ? 'Max output tokens' : 'Max tokens'">
            <n-input-number v-model:value="maxTokens" clearable :min="1" :step="128" placeholder="不传" />
          </n-form-item>
        </div>

        <n-form-item label="高级参数 JSON">
          <n-input v-model:value="advancedJson" type="textarea" class="mono" :autosize="{ minRows: 3, maxRows: 10 }" placeholder='例如 {"reasoning":{"effort":"high"}}' />
          <template #feedback><span class="muted">会合并到请求体；模型、输入内容和 stream=false 由操场固定。</span></template>
        </n-form-item>

        <n-space justify="end">
          <n-button :disabled="!responseRaw && !responseError" @click="clearResult"><template #icon><trash2 /></template>清空结果</n-button>
          <n-button type="primary" :loading="testing" :disabled="!canSend" @click="send"><template #icon><play /></template>发送请求</n-button>
        </n-space>
      </n-form>
    </n-card>

    <n-card title="响应结果" class="response-card">
      <div v-if="responseStatus !== null || responseLatencyMs !== null" class="response-meta">
        <n-tag v-if="responseStatus !== null" :type="responseStatus >= 200 && responseStatus < 400 ? 'success' : 'error'">HTTP {{ responseStatus }}</n-tag>
        <n-tag v-if="responseLatencyMs !== null" :bordered="false">{{ responseLatencyMs }} ms</n-tag>
        <n-tag v-if="modelId" :bordered="false" class="mono">{{ modelId }}</n-tag>
      </div>

      <n-alert v-if="responseError" type="error" :bordered="false" class="response-error">{{ responseError }}</n-alert>

      <div v-if="responseText" class="result-section">
        <div class="section-title">模型输出</div>
        <div class="model-output">{{ responseText }}</div>
      </div>

      <div v-if="responseRaw" class="result-section raw-section">
        <div class="section-title">原始响应</div>
        <n-input :value="responseRaw" type="textarea" readonly class="mono raw-output" :autosize="{ minRows: 12, maxRows: 28 }" />
      </div>

      <div v-if="!responseRaw && !responseError" class="empty-result">
        <play :size="28" />
        <strong>等待演练请求</strong>
        <span>请求会直接发送到 {{ endpointPaths[endpoint] }}，与外部客户端使用同一套网关逻辑。</span>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.playground-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px; align-items:start; }
.request-card,.response-card { min-width:0; }
.key-note { margin-bottom:18px; }
.field-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.feedback-error { color:var(--n-feedback-text-color-error); }
.response-meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.response-error { margin-bottom:14px; }
.result-section + .result-section { margin-top:18px; }
.section-title { margin-bottom:8px; color:var(--n-text-color-3); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
.model-output { min-height:120px; padding:14px 16px; border:1px solid var(--n-border-color); border-radius:10px; background:var(--n-color-embedded); white-space:pre-wrap; word-break:break-word; line-height:1.65; }
.raw-output :deep(textarea) { font-size:12px; line-height:1.55; }
.empty-result { min-height:360px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px; color:var(--n-text-color-3); text-align:center; }
.empty-result strong { color:var(--n-text-color-2); }
.empty-result span { max-width:420px; font-size:12px; line-height:1.6; }
@media(max-width:980px) { .playground-grid { grid-template-columns:1fr; } }
@media(max-width:620px) { .field-grid { grid-template-columns:1fr; gap:0; } }
</style>
