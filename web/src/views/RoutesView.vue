<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from "vue";
import {
  NAlert, NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputNumber,
  NModal, NPopconfirm, NSelect, NSpace, NSwitch, NTag, useMessage,
} from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { Plus, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api, jsonBody } from "../api";
import type { Channel, DiscoveredModel, ModelRoute, Provider } from "../types";

interface EndpointState {
  endpoint: string;
  availability?: ModelRoute["availability"];
}
interface RouteDisplay extends ModelRoute {
  endpoints: string[];
  routeIds: string[];
  endpointStates: EndpointState[];
}

const rows = ref<ModelRoute[]>([]);
const sources = ref<Array<{ label: string; value: string }>>([]);
const discoveredModels = ref<DiscoveredModel[]>([]);
const loading = ref(false);
const modal = ref(false);
const editing = ref<ModelRoute | null>(null);
const editingOptions = ref<Record<string, unknown>>({});
const message = useMessage();
const tablePagination = { pageSize: 10, pageSizes: [10, 20, 50], showSizePicker: true, showQuickJumper: true };
const form = reactive({ publicModel: "", providerId: "", upstreamModel: "", endpoint: "chat", enabled: true, priority: 100, weight: 1, codexMultiAgentV2: false });
const endpointOrder = new Map([["responses", 0], ["chat", 1], ["completions", 2]]);
const endpointLabels: Record<string, string> = { responses: "Responses", chat: "Chat", completions: "Completions" };
const upstreamOptions = computed(() => {
  const seen = new Set<string>();
  return discoveredModels.value
    .filter((item) => item.provider_id === form.providerId && item.endpoint === form.endpoint && item.enabled === 1)
    .filter((item) => !seen.has(item.model_id) && Boolean(seen.add(item.model_id)))
    .map((item) => ({ label: item.display_name && item.display_name !== item.model_id ? `${item.display_name} · ${item.model_id}` : item.model_id, value: item.model_id }));
});
function selectUpstream(value: string) { form.upstreamModel = value; if (!form.publicModel.trim()) form.publicModel = value; }
const endpoints = [
  { label: "Chat Completions", value: "chat" },
  { label: "Responses", value: "responses" },
  { label: "Legacy Completions", value: "completions" },
];
function parseOptions(row: ModelRoute): Record<string, unknown> {
  try { return JSON.parse(row.options_json || "{}"); } catch { return {}; }
}
function multiAgentEnabled(row: ModelRoute): boolean {
  const options = parseOptions(row);
  return options.codex_multi_agent_v2 === true || options.codexMultiAgentV2 === true;
}
async function load() {
  loading.value = true;
  try {
    const [routeResult, channels, providers, models] = await Promise.all([
      api<{ data: ModelRoute[] }>("/routes"), api<{ data: Channel[] }>("/channels"), api<{ data: Provider[] }>("/providers"), api<{ data: DiscoveredModel[] }>("/models"),
    ]);
    rows.value = routeResult.data;
    discoveredModels.value = models.data;
    sources.value = [...channels.data, ...providers.data].map((item) => ({ label: item.name, value: item.id }));
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function create() {
  editing.value = null;
  editingOptions.value = {};
  Object.assign(form, { publicModel: "", providerId: "", upstreamModel: "", endpoint: "chat", enabled: true, priority: 100, weight: 1, codexMultiAgentV2: false });
  modal.value = true;
}
function edit(row: ModelRoute) {
  editing.value = row;
  editingOptions.value = parseOptions(row);
  Object.assign(form, {
    publicModel: row.public_model, providerId: row.provider_id, upstreamModel: row.upstream_model, endpoint: row.endpoint,
    enabled: row.enabled === 1, priority: row.priority, weight: row.weight, codexMultiAgentV2: multiAgentEnabled(row),
  });
  modal.value = true;
}
function managed(row: ModelRoute): boolean { return parseOptions(row).managed_by === "provider-model-selection"; }
const displayRows = computed<RouteDisplay[]>(() => {
  const output: RouteDisplay[] = [];
  const managedGroups = new Map<string, RouteDisplay>();
  for (const row of rows.value) {
    const display: RouteDisplay = {
      ...row,
      endpoints: [row.endpoint],
      routeIds: [row.id],
      endpointStates: [{ endpoint: row.endpoint, availability: row.availability }],
    };
    if (!managed(row)) {
      output.push(display);
      continue;
    }
    const key = [row.public_model, row.provider_id, row.upstream_model, row.priority, row.weight, row.enabled, row.options_json].join("\u0000");
    const existing = managedGroups.get(key);
    if (!existing) {
      managedGroups.set(key, display);
      output.push(display);
      continue;
    }
    if (!existing.endpoints.includes(row.endpoint)) existing.endpoints.push(row.endpoint);
    existing.routeIds.push(row.id);
    existing.endpointStates.push({ endpoint: row.endpoint, availability: row.availability });
  }
  return output.map((row) => ({
    ...row,
    endpoints: [...row.endpoints].sort((left, right) => (endpointOrder.get(left) ?? 99) - (endpointOrder.get(right) ?? 99) || left.localeCompare(right)),
    endpointStates: [...row.endpointStates].sort((left, right) => (endpointOrder.get(left.endpoint) ?? 99) - (endpointOrder.get(right.endpoint) ?? 99) || left.endpoint.localeCompare(right.endpoint)),
  }));
});
async function save() {
  try {
    const options = { ...editingOptions.value };
    delete options.codexMultiAgentV2;
    if (form.codexMultiAgentV2 && form.endpoint === "responses") options.codex_multi_agent_v2 = true;
    else delete options.codex_multi_agent_v2;
    const body = {
      publicModel: form.publicModel,
      providerId: form.providerId,
      upstreamModel: form.upstreamModel,
      endpoint: form.endpoint,
      enabled: form.enabled,
      priority: form.priority,
      weight: form.weight,
      options,
    };
    if (editing.value) await api(`/routes/${editing.value.id}`, { method: "PATCH", body: jsonBody(body) });
    else await api("/routes", { method: "POST", body: jsonBody(body) });
    message.success("路由已保存"); modal.value = false; await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function remove(id: string) { try { await api(`/routes/${id}`, { method: "DELETE" }); message.success("路由已删除"); await load(); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } }
async function recover(providerId: string) { try { await api(`/routes/provider/${providerId}/recover`, { method: "POST" }); message.success("已清除该供应商的熔断状态"); await load(); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } }
function formatRetry(value?: number): string { return value ? new Date(value * 1000).toLocaleString() : ""; }
function statusRank(status?: string): number { return status === "unavailable" ? 2 : status === "degraded" ? 1 : 0; }
function combinedStatus(row: RouteDisplay): "ready" | "degraded" | "unavailable" {
  const worst = row.endpointStates.reduce((current, item) => Math.max(current, statusRank(item.availability?.status)), 0);
  return worst === 2 ? "unavailable" : worst === 1 ? "degraded" : "ready";
}
function availabilityDetail(row: RouteDisplay): string {
  const problems = row.endpointStates.filter((item) => item.availability?.status && item.availability.status !== "ready");
  if (problems.length) {
    return problems.map((item) => `${endpointLabels[item.endpoint] ?? item.endpoint}：${item.availability?.reason || (item.availability?.status === "degraded" ? "部分可用" : "不可用")}`).join("；");
  }
  const values = row.endpointStates.map((item) => item.availability).filter((value): value is NonNullable<ModelRoute["availability"]> => Boolean(value));
  if (!values.length) return `${row.endpoints.length} 个端点`;
  const available = Math.min(...values.map((value) => value.availableCredentials));
  const total = Math.max(...values.map((value) => value.totalCredentials));
  return row.endpoints.length > 1 ? `${row.endpoints.length} 个端点，${available}/${total} 个账号可覆盖` : `${available}/${total} 个账号可用`;
}
const columns: DataTableColumns<RouteDisplay> = [
  { title: "客户端模型名", key: "public_model", render: (row) => h("div", [h("strong", row.public_model), managed(row) ? h(NTag, { size: "tiny", style: "margin-left:8px" }, { default: () => "供应商自动管理" }) : null, multiAgentEnabled(row) ? h(NTag, { size: "tiny", type: "success", style: "margin-left:8px" }, { default: () => "Multi-Agent V2" }) : null]) },
  { title: "实际上游", key: "target", render: (row) => h("div", [h(NTag, { size: "small" }, { default: () => row.provider_id }), h("span", { class: "mono", style: "margin-left:8px" }, row.upstream_model)]) },
  { title: "支持端点", key: "endpoints", render: (row) => h(NSpace, { size: 5, wrap: true }, { default: () => row.endpoints.map((endpoint) => h(NTag, { size: "small", type: "info" }, { default: () => endpointLabels[endpoint] ?? endpoint })) }) },
  { title: "分流规则", key: "priority", render: (row) => h("div", [h("strong", `优先级 ${row.priority}`), h("div", { class: "muted", style: "font-size:12px" }, `同级权重 ${row.weight}`)]) },
  { title: "可用状态", key: "availability", render: (row) => {
    const state = combinedStatus(row);
    const type = state === "ready" ? "success" : state === "degraded" ? "warning" : "error";
    const label = state === "ready" ? "可用" : state === "degraded" ? "部分可用" : "已摘除";
    const retryAt = Math.max(...row.endpointStates.map((item) => item.availability?.retryAt ?? 0));
    return h("div", [h(NTag, { size: "small", type }, { default: () => label }), h("div", { class: "muted", style: "font-size:12px;margin-top:4px;max-width:320px" }, availabilityDetail(row)), retryAt ? h("div", { class: "muted", style: "font-size:12px" }, `预计恢复：${formatRetry(retryAt)}`) : null]);
  } },
  { title: "启用", key: "enabled", render: (row) => h(NSwitch, { value: row.enabled === 1, disabled: managed(row), onUpdateValue: (value: boolean) => api(`/routes/${row.id}`, { method: "PATCH", body: jsonBody({ enabled: value }) }).then(load) }) },
  { title: "操作", key: "actions", render: (row) => h(NSpace, null, { default: () => [
    h(NButton, { size: "small", disabled: managed(row), onClick: () => edit(row) }, { default: () => managed(row) ? "在供应商配置" : "编辑" }),
    row.health?.disabledUntil && row.health.disabledUntil > Date.now() ? h(NButton, { size: "small", type: "warning", secondary: true, onClick: () => recover(row.provider_id) }, { default: () => "立即恢复" }) : null,
    !managed(row) ? h(NPopconfirm, { onPositiveClick: () => remove(row.id) }, { trigger: () => h(NButton, { size: "small", type: "error", secondary: true }, { default: () => "删除" }), default: () => "确定删除该路由？" }) : null,
  ] }) },
];
onMounted(load);
</script>

<template>
  <page-header title="模型路由" description="把客户端模型名指向一个或多个上游；同一供应商模型的多协议端点会合并展示。"><n-button type="primary" @click="create"><template #icon><plus /></template>新增手动路由</n-button><n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button></page-header>
  <n-alert type="info" :bordered="false" style="margin-bottom:16px"><strong>怎么用：</strong>相同“客户端模型名”的线路会组成一个路由池。数字更小的优先级先用；只有主线路不可用时才切到更大的优先级。同一优先级按权重分流。OpenAI 供应商的模型勾选与别名建议直接在“OpenAI-compatible 供应商”里配置，这里只做高级主备覆盖。</n-alert>
  <n-card><n-data-table :columns="columns" :data="displayRows" :loading="loading" :pagination="tablePagination" :row-key="row => row.routeIds.join(':')" :scroll-x="1320" /></n-card>
  <n-modal v-model:show="modal" preset="card" :title="editing ? '编辑手动路由' : '新增手动路由'" style="width:min(720px,calc(100vw - 32px))">
    <n-form label-placement="top"><n-form-item label="客户端看到的模型名"><n-input v-model:value="form.publicModel" placeholder="例如 coding-fast" /></n-form-item><div class="grid-2"><n-form-item label="供应商 / 渠道"><n-select v-model:value="form.providerId" :options="sources" filterable /></n-form-item><n-form-item label="实际上游模型"><n-select :value="form.upstreamModel" :options="upstreamOptions" filterable tag placeholder="选择已发现模型，或直接输入模型 ID" @update:value="selectUpstream" /></n-form-item></div><div class="grid-stats" style="grid-template-columns:repeat(3,1fr)"><n-form-item label="端点"><n-select v-model:value="form.endpoint" :options="endpoints" /></n-form-item><n-form-item label="优先级（越小越先）"><n-input-number v-model:value="form.priority" :min="1" style="width:100%" /></n-form-item><n-form-item label="同级权重"><n-input-number v-model:value="form.weight" :min="1" style="width:100%" /></n-form-item></div><n-form-item label="Codex Multi-Agent V2"><n-space align="center"><n-switch v-model:value="form.codexMultiAgentV2" :disabled="form.endpoint !== 'responses'" /><span class="muted">默认关闭；仅 Codex Desktop / codex-tui 的 Responses 请求触发。</span></n-space></n-form-item><n-form-item label="启用"><n-switch v-model:value="form.enabled" /></n-form-item><n-space justify="end"><n-button @click="modal = false">取消</n-button><n-button type="primary" @click="save">保存</n-button></n-space></n-form>
  </n-modal>
</template>
