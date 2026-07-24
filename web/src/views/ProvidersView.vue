<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from "vue";
import {
  NAlert, NButton, NCard, NCheckbox, NDataTable, NDivider, NEmpty, NForm, NFormItem,
  NInput, NInputNumber, NModal, NPagination, NPopconfirm, NSelect, NSpace, NSpin, NSwitch, NTag, useMessage,
} from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { Plus, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProxyEditor from "../components/ProxyEditor.vue";
import { api, jsonBody } from "../api";
import type { Provider } from "../types";

interface ModelSelection {
  upstreamModel: string;
  publicModel: string;
  endpoints?: string[];
}
interface FormState {
  id: string;
  name: string;
  baseUrl: string;
  apiMode: "chat" | "responses" | "both";
  poolStrategy: "round_robin" | "fill_first" | "weighted" | "least_inflight";
  routingWeight: number;
  enabled: boolean;
  apiKey: string;
  apiKeyLabel: string;
  modelSelections: ModelSelection[];
}

const rows = ref<Provider[]>([]);
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const modal = ref(false);
const editing = ref<Provider | null>(null);
const proxyOpen = ref(false);
const selected = ref<Provider | null>(null);
const discoveredModels = ref<string[]>([]);
const modelPage = ref(1);
const modelPageSize = ref(10);
const message = useMessage();
const tablePagination = { pageSize: 10, pageSizes: [10, 20, 50], showSizePicker: true, showQuickJumper: true };
const modelPageCount = computed(() => Math.max(1, Math.ceil(discoveredModels.value.length / modelPageSize.value)));
const pagedDiscoveredModels = computed(() => discoveredModels.value.slice((modelPage.value - 1) * modelPageSize.value, modelPage.value * modelPageSize.value));
watch(modelPageCount, (count) => { if (modelPage.value > count) modelPage.value = count; });
const form = reactive<FormState>({
  id: "", name: "", baseUrl: "", apiMode: "both", poolStrategy: "weighted",
  routingWeight: 1, enabled: true, apiKey: "", apiKeyLabel: "", modelSelections: [],
});
const apiModes = [
  { label: "Chat + Responses", value: "both" },
  { label: "仅 Chat Completions", value: "chat" },
  { label: "仅 Responses", value: "responses" },
];
const pools = [
  { label: "按权重（推荐）", value: "weighted" },
  { label: "轮询", value: "round_robin" },
  { label: "填满优先", value: "fill_first" },
  { label: "最少并发", value: "least_inflight" },
];
async function load() {
  loading.value = true;
  try { rows.value = (await api<{ data: Provider[] }>("/providers")).data; }
  catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function resetSecret() { form.apiKey = ""; form.apiKeyLabel = ""; }
function openCreate() {
  editing.value = null;
  discoveredModels.value = [];
  modelPage.value = 1;
  Object.assign(form, {
    id: "", name: "", baseUrl: "", apiMode: "both", poolStrategy: "weighted",
    routingWeight: 1, enabled: true, apiKey: "", apiKeyLabel: "默认 API Key", modelSelections: [],
  });
  modal.value = true;
}
function openEdit(row: Provider) {
  editing.value = row;
  const selections = (row.modelSelections ?? []).map((item) => ({ ...item, endpoints: item.endpoints ? [...item.endpoints] : undefined }));
  discoveredModels.value = [...new Set(selections.map((item) => item.upstreamModel))];
  modelPage.value = 1;
  Object.assign(form, {
    id: row.id, name: row.name, baseUrl: row.base_url, apiMode: row.apiMode,
    poolStrategy: row.pool_strategy, routingWeight: row.routingWeight ?? 1, enabled: row.enabled === 1,
    apiKey: "", apiKeyLabel: "新 API Key", modelSelections: selections,
  });
  modal.value = true;
}
function selectionFor(model: string): ModelSelection | undefined { return form.modelSelections.find((item) => item.upstreamModel === model); }
function selectedModel(model: string): boolean { return Boolean(selectionFor(model)); }
function toggleModel(model: string, enabled: boolean) {
  const index = form.modelSelections.findIndex((item) => item.upstreamModel === model);
  if (enabled && index < 0) form.modelSelections.push({ upstreamModel: model, publicModel: model });
  if (!enabled && index >= 0) form.modelSelections.splice(index, 1);
}
async function testAndFetchModels() {
  testing.value = true;
  try {
    const result = await api<{ models: string[]; latencyMs: number }>("/providers/test", {
      method: "POST",
      body: jsonBody({ providerId: editing.value?.id, baseUrl: form.baseUrl, apiKey: form.apiKey, apiMode: form.apiMode }),
    });
    const previous = new Map(form.modelSelections.map((item) => [item.upstreamModel, item]));
    const firstDiscovery = discoveredModels.value.length === 0 && !editing.value;
    discoveredModels.value = result.models;
    modelPage.value = 1;
    form.modelSelections = firstDiscovery
      ? result.models.map((model) => ({ upstreamModel: model, publicModel: model }))
      : result.models.flatMap((model) => { const existing = previous.get(model); return existing ? [existing] : []; });
    message.success(`API Key 可用，获取到 ${result.models.length} 个模型（${result.latencyMs} ms）`);
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { testing.value = false; }
}
async function save() {
  saving.value = true;
  try {
    const body = {
      ...form,
      routingWeight: Math.max(1, form.routingWeight || 1),
      modelSelections: form.modelSelections.map((item) => ({
        upstreamModel: item.upstreamModel,
        publicModel: item.publicModel.trim() || item.upstreamModel,
        endpoints: item.endpoints,
      })),
    };
    const result = editing.value
      ? await api<{ credentialId?: string | null }>(`/providers/${editing.value.id}`, { method: "PATCH", body: jsonBody(body) })
      : await api<{ credentialId?: string | null }>("/providers", { method: "POST", body: jsonBody(body) });
    message.success(result.credentialId
      ? (editing.value ? "供应商已更新，新 API Key 已加入账号池" : "供应商、API Key 和模型映射已创建")
      : (editing.value ? "供应商和模型映射已更新" : "供应商已创建"));
    modal.value = false;
    resetSecret();
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { saving.value = false; }
}
async function remove(id: string) {
  try { await api(`/providers/${id}`, { method: "DELETE" }); message.success("供应商已删除"); await load(); }
  catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
function proxy(row: Provider) { selected.value = row; proxyOpen.value = true; }
const columns: DataTableColumns<Provider> = [
  { title: "供应商", key: "name", render: (row) => h("div", [h("strong", row.name), h("div", { class: "mono muted", style: "font-size:12px" }, row.id)]) },
  { title: "Base URL", key: "base_url", ellipsis: { tooltip: true } },
  { title: "公开模型", key: "models", render: (row) => `${row.modelSelections?.length ?? 0} 个` },
  { title: "路由权重", key: "routingWeight", render: (row) => h(NTag, { size: "small", type: "info" }, { default: () => `W${row.routingWeight ?? 1}` }) },
  { title: "代理", key: "proxy", render: (row) => h(NTag, { size: "small", type: row.proxy?.enabled && row.proxy.runtimeReady !== false ? "success" : row.proxy?.enabled ? "error" : "default" }, { default: () => row.proxy?.source === "provider" ? "覆盖代理" : row.proxy?.source === "system" ? "系统代理" : "直连" }) },
  { title: "启用", key: "enabled", render: (row) => h(NSwitch, { value: row.enabled === 1, onUpdateValue: (value: boolean) => api(`/providers/${row.id}`, { method: "PATCH", body: jsonBody({ enabled: value }) }).then(load) }) },
  { title: "操作", key: "actions", render: (row) => h(NSpace, null, { default: () => [
    h(NButton, { size: "small", onClick: () => openEdit(row) }, { default: () => "配置" }),
    h(NButton, { size: "small", onClick: () => proxy(row) }, { default: () => "代理" }),
    h(NPopconfirm, { onPositiveClick: () => remove(row.id) }, { trigger: () => h(NButton, { size: "small", type: "error", secondary: true }, { default: () => "删除" }), default: () => "同时会删除该供应商的账号和路由，确定继续？" }),
  ] }) },
];
onMounted(load);
</script>

<template>
  <page-header title="OpenAI-compatible 供应商" description="测试 API Key、读取上游模型、选择要公开的模型并设置别名。相同别名可由多个供应商按权重分流。">
    <n-button type="primary" @click="openCreate"><template #icon><plus /></template>新增供应商</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>
  <n-card><n-data-table :columns="columns" :data="rows" :loading="loading" :pagination="tablePagination" :row-key="(row: Provider) => row.id" :scroll-x="1080" /></n-card>

  <n-modal v-model:show="modal" preset="card" :title="editing ? '配置供应商' : '新增 OpenAI-compatible 供应商'" style="width:min(860px,calc(100vw - 32px))" @after-leave="resetSecret">
    <n-form label-placement="top">
      <div class="grid-2">
        <n-form-item label="供应商 ID"><n-input v-model:value="form.id" :disabled="!!editing" placeholder="例如 openai-main" /></n-form-item>
        <n-form-item label="显示名称"><n-input v-model:value="form.name" placeholder="例如 OpenAI 主线路" /></n-form-item>
      </div>
      <n-form-item label="Base URL"><n-input v-model:value="form.baseUrl" placeholder="https://api.example.com/v1" /></n-form-item>
      <div class="grid-stats" style="grid-template-columns:repeat(3,1fr)">
        <n-form-item label="支持协议"><n-select v-model:value="form.apiMode" :options="apiModes" /></n-form-item>
        <n-form-item label="账号池策略"><n-select v-model:value="form.poolStrategy" :options="pools" /></n-form-item>
        <n-form-item label="供应商路由权重"><n-input-number v-model:value="form.routingWeight" :min="1" :max="10000" style="width:100%" /></n-form-item>
      </div>
      <n-alert type="info" :bordered="false" style="margin-bottom:14px">同一个公开模型有多个同优先级供应商时，按供应商权重分流。例如权重 3 和 1，流量约为 75% / 25%。上游熔断或账号额度耗尽时会自动跳过。</n-alert>
      <div class="grid-2">
        <n-form-item :label="editing ? 'API Key（留空则用已保存账号测试；填写则新增账号）' : '首个 API Key'"><n-input v-model:value="form.apiKey" type="password" show-password-on="click" placeholder="sk-..." autocomplete="new-password" /></n-form-item>
        <n-form-item label="Key 标签"><n-input v-model:value="form.apiKeyLabel" placeholder="例如 默认 Key / 线路 A" /></n-form-item>
      </div>
      <n-space align="center"><n-button type="primary" secondary :loading="testing" :disabled="!form.baseUrl" @click="testAndFetchModels">测试 API Key 并获取模型</n-button><span class="muted">测试会沿用该供应商设置的代理；编辑时 API Key 可留空。</span></n-space>
      <n-divider>公开模型与名称映射</n-divider>
      <n-spin :show="testing">
        <n-empty v-if="discoveredModels.length === 0" description="先测试 API Key 获取模型；也可以保存后再回来配置" />
        <div v-else style="display:grid;gap:10px;max-height:340px;overflow:auto;padding-right:4px">
          <n-card v-for="model in pagedDiscoveredModels" :key="model" size="small">
            <div style="display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr);gap:14px;align-items:center">
              <n-checkbox :checked="selectedModel(model)" @update:checked="(value: boolean) => toggleModel(model, value)"><span class="mono">{{ model }}</span></n-checkbox>
              <n-input v-if="selectionFor(model)" :value="selectionFor(model)?.publicModel" placeholder="客户端看到的模型名" @update:value="(value: string) => { const item = selectionFor(model); if (item) item.publicModel = value }"><template #prefix>映射为</template></n-input>
              <span v-else class="muted">不公开</span>
            </div>
          </n-card>
        </div>
        <div v-if="discoveredModels.length > modelPageSize" class="pagination-row"><n-pagination v-model:page="modelPage" v-model:page-size="modelPageSize" :item-count="discoveredModels.length" :page-sizes="[10, 20, 50]" show-size-picker /></div>
      </n-spin>
      <n-divider />
      <n-form-item label="启用"><n-switch v-model:value="form.enabled" /></n-form-item>
      <n-space justify="end"><n-button @click="modal = false">取消</n-button><n-button type="primary" :loading="saving" @click="save">保存</n-button></n-space>
    </n-form>
  </n-modal>
  <proxy-editor v-if="selected" v-model:show="proxyOpen" :provider-id="selected.id" :summary="selected.proxy" :title="`${selected.name} · 覆盖代理`" @changed="load" />
</template>
