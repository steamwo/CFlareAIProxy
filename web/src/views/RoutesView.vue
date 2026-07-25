<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  NAlert, NButton, NCard, NForm, NFormItem, NInput, NInputNumber, NModal,
  NPopconfirm, NSelect, NSpace, NSwitch, NTag, useMessage,
} from "naive-ui";
import { ChevronDown, Plus, RefreshCw, Route as RouteIcon, SlidersHorizontal } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProviderIcon from "../components/ProviderIcon.vue";
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
interface RouteGroup {
  publicModel: string;
  routes: RouteDisplay[];
}
interface SourceMeta {
  label: string;
  kind: "channel" | "provider";
}

const rows = ref<ModelRoute[]>([]);
const sourceOptions = ref<Array<{ label: string; value: string }>>([]);
const sourceMap = ref(new Map<string, SourceMeta>());
const discoveredModels = ref<DiscoveredModel[]>([]);
const loading = ref(false);
const modal = ref(false);
const advanced = ref(false);
const editing = ref<RouteDisplay | null>(null);
const editingOptions = ref<Record<string, unknown>>({});
const query = ref("");
const message = useMessage();
const form = reactive({
  publicModel: "",
  providerId: "",
  upstreamModel: "",
  endpoint: "",
  enabled: true,
  priority: 100,
  weight: 1,
  codexMultiAgentV2: false,
});

const endpointOrder = new Map([["responses", 0], ["chat", 1], ["completions", 2]]);
const endpointLabels: Record<string, string> = {
  responses: "Responses",
  chat: "Chat Completions",
  completions: "Legacy Completions",
};
const endpointOptions = [
  { label: "Responses", value: "responses" },
  { label: "Chat Completions", value: "chat" },
  { label: "Legacy Completions", value: "completions" },
];

function sortEndpoint(left: string, right: string): number {
  return (endpointOrder.get(left) ?? 99) - (endpointOrder.get(right) ?? 99) || left.localeCompare(right);
}
function sourceLabel(providerId: string): string {
  return sourceMap.value.get(providerId)?.label ?? providerId;
}
function parseOptions(row: ModelRoute): Record<string, unknown> {
  try {
    return JSON.parse(row.options_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
function managed(row: ModelRoute): boolean {
  return parseOptions(row).managed_by === "provider-model-selection";
}
function multiAgentEnabled(row: ModelRoute): boolean {
  const options = parseOptions(row);
  return options.codex_multi_agent_v2 === true || options.codexMultiAgentV2 === true;
}

const upstreamOptions = computed(() => {
  const groups = new Map<string, Set<string>>();
  for (const item of discoveredModels.value) {
    if (item.provider_id !== form.providerId || item.enabled !== 1) continue;
    const modelEndpoints = groups.get(item.model_id) ?? new Set<string>();
    modelEndpoints.add(item.endpoint);
    groups.set(item.model_id, modelEndpoints);
  }
  return [...groups.entries()].map(([modelId, modelEndpoints]) => {
    const first = discoveredModels.value.find((item) => item.provider_id === form.providerId && item.model_id === modelId);
    const name = first?.display_name && first.display_name !== modelId ? `${first.display_name} · ${modelId}` : modelId;
    const protocols = [...modelEndpoints].sort(sortEndpoint).map((endpoint) => endpointLabels[endpoint] ?? endpoint).join(" / ");
    return { label: protocols ? `${name} · ${protocols}` : name, value: modelId };
  });
});

const availableEndpoints = computed(() => {
  const modelEndpoints = new Set(
    discoveredModels.value
      .filter((item) => item.provider_id === form.providerId && item.model_id === form.upstreamModel && item.enabled === 1)
      .map((item) => item.endpoint),
  );
  return [...modelEndpoints].sort(sortEndpoint);
});
const recommendedEndpoint = computed(() => availableEndpoints.value[0] ?? "chat");
const selectedEndpoint = computed(() => form.endpoint || recommendedEndpoint.value);

async function load() {
  loading.value = true;
  try {
    const [routeResult, channels, providers, models] = await Promise.all([
      api<{ data: ModelRoute[] }>("/routes"),
      api<{ data: Channel[] }>("/channels"),
      api<{ data: Provider[] }>("/providers"),
      api<{ data: DiscoveredModel[] }>("/models"),
    ]);
    rows.value = routeResult.data;
    discoveredModels.value = models.data;
    sourceOptions.value = [...channels.data, ...providers.data].map((item) => ({ label: item.name, value: item.id }));
    const nextSourceMap = new Map<string, SourceMeta>();
    for (const item of channels.data) nextSourceMap.set(item.id, { label: item.name, kind: "channel" });
    for (const item of providers.data) nextSourceMap.set(item.id, { label: item.name, kind: "provider" });
    sourceMap.value = nextSourceMap;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function create() {
  editing.value = null;
  editingOptions.value = {};
  advanced.value = false;
  Object.assign(form, {
    publicModel: "",
    providerId: "",
    upstreamModel: "",
    endpoint: "",
    enabled: true,
    priority: 100,
    weight: 1,
    codexMultiAgentV2: false,
  });
  modal.value = true;
}
function edit(row: RouteDisplay) {
  editing.value = row;
  editingOptions.value = parseOptions(row);
  advanced.value = true;
  Object.assign(form, {
    publicModel: row.public_model,
    providerId: row.provider_id,
    upstreamModel: row.upstream_model,
    endpoint: row.endpoint,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    codexMultiAgentV2: multiAgentEnabled(row),
  });
  modal.value = true;
}
function selectUpstream(value: string) {
  form.upstreamModel = value;
  if (!form.publicModel.trim()) form.publicModel = value;
  if (!advanced.value) form.endpoint = "";
}

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
    endpoints: [...row.endpoints].sort(sortEndpoint),
    endpointStates: [...row.endpointStates].sort((left, right) => sortEndpoint(left.endpoint, right.endpoint)),
  }));
});

const routeGroups = computed<RouteGroup[]>(() => {
  const normalizedQuery = query.value.trim().toLowerCase();
  const groups = new Map<string, RouteDisplay[]>();
  for (const row of displayRows.value) {
    const searchable = `${row.public_model} ${row.provider_id} ${sourceLabel(row.provider_id)} ${row.upstream_model} ${row.endpoints.join(" ")}`.toLowerCase();
    if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
    const routes = groups.get(row.public_model) ?? [];
    routes.push(row);
    groups.set(row.public_model, routes);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([publicModel, routes]) => ({
      publicModel,
      routes: routes.sort((left, right) => left.priority - right.priority || right.weight - left.weight),
    }));
});

async function save() {
  try {
    const endpoint = advanced.value ? (form.endpoint || recommendedEndpoint.value) : recommendedEndpoint.value;
    const options = { ...editingOptions.value };
    delete options.codexMultiAgentV2;
    if (form.codexMultiAgentV2 && endpoint === "responses") options.codex_multi_agent_v2 = true;
    else delete options.codex_multi_agent_v2;
    const body = {
      publicModel: form.publicModel.trim(),
      providerId: form.providerId,
      upstreamModel: form.upstreamModel,
      endpoint,
      enabled: form.enabled,
      priority: form.priority,
      weight: form.weight,
      options,
    };
    if (!body.publicModel || !body.providerId || !body.upstreamModel) {
      message.warning("请完整选择客户端模型名、来源和上游模型");
      return;
    }
    if (editing.value) await api(`/routes/${editing.value.id}`, { method: "PATCH", body: jsonBody(body) });
    else await api("/routes", { method: "POST", body: jsonBody(body) });
    message.success("路由策略已保存");
    modal.value = false;
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function remove(id: string) {
  try {
    await api(`/routes/${id}`, { method: "DELETE" });
    message.success("路由已删除");
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function recover(providerId: string) {
  try {
    await api(`/routes/provider/${providerId}/recover`, { method: "POST" });
    message.success("已清除该来源的熔断状态");
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
function formatRetry(value?: number): string {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "";
}
function statusRank(status?: string): number {
  return status === "unavailable" ? 2 : status === "degraded" ? 1 : 0;
}
function combinedStatus(row: RouteDisplay): "ready" | "degraded" | "unavailable" {
  const worst = row.endpointStates.reduce((current, item) => Math.max(current, statusRank(item.availability?.status)), 0);
  return worst === 2 ? "unavailable" : worst === 1 ? "degraded" : "ready";
}
function availabilityDetail(row: RouteDisplay): string {
  const problems = row.endpointStates.filter((item) => item.availability?.status && item.availability.status !== "ready");
  if (problems.length) {
    return problems.map((item) => `${endpointLabels[item.endpoint] ?? item.endpoint}：${item.availability?.reason || (item.availability?.status === "degraded" ? "部分可用" : "不可用")}`).join("；");
  }
  const values = row.endpointStates
    .map((item) => item.availability)
    .filter((value): value is NonNullable<ModelRoute["availability"]> => Boolean(value));
  if (!values.length) return "等待运行数据";
  const available = Math.min(...values.map((value) => value.availableCredentials));
  const total = Math.max(...values.map((value) => value.totalCredentials));
  return `${available}/${total} 个账号可用`;
}
function statusMeta(row: RouteDisplay) {
  const state = combinedStatus(row);
  if (state === "ready") return { type: "success" as const, label: "可用" };
  if (state === "degraded") return { type: "warning" as const, label: "部分可用" };
  return { type: "error" as const, label: "已摘除" };
}
function retryAt(row: RouteDisplay): number {
  return Math.max(...row.endpointStates.map((item) => item.availability?.retryAt ?? 0));
}

watch(() => [form.providerId, form.upstreamModel] as const, () => {
  if (!advanced.value) form.endpoint = "";
});
watch(advanced, (value) => {
  if (!value) form.endpoint = "";
  else if (!form.endpoint) form.endpoint = recommendedEndpoint.value;
});
onMounted(load);
</script>

<template>
  <page-header title="模型路由" description="用清晰的主备顺序和权重管理模型流量；协议默认根据上游能力自动选择。">
    <n-button type="primary" @click="create"><template #icon><plus /></template>新增路由策略</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-alert type="info" :bordered="false" class="route-help">
    相同客户端模型名下，优先级数字越小越先使用；同一优先级按权重分流。协议默认根据已发现模型能力自动选择，只有特殊兼容需求才需要展开高级设置。
  </n-alert>

  <div class="route-toolbar">
    <n-input v-model:value="query" clearable placeholder="搜索客户端模型、来源或上游模型" />
    <n-tag :bordered="false">{{ routeGroups.length }} 个客户端模型</n-tag>
  </div>

  <div v-if="routeGroups.length" class="route-groups">
    <n-card v-for="group in routeGroups" :key="group.publicModel" class="route-card" :bordered="false">
      <div class="route-card__header">
        <div>
          <div class="route-card__title"><route-icon :size="16" /><strong>{{ group.publicModel }}</strong></div>
          <div class="muted route-card__subtitle">{{ group.routes.length }} 条线路，按优先级自动主备切换</div>
        </div>
        <n-tag round :bordered="false" type="info">客户端模型</n-tag>
      </div>

      <div class="route-list">
        <div v-for="row in group.routes" :key="row.routeIds.join(':')" class="route-line">
          <div class="route-source">
            <provider-icon :provider-id="row.provider_id" :name="sourceLabel(row.provider_id)" :size="34" />
            <div>
              <strong>{{ sourceLabel(row.provider_id) }}</strong>
              <div class="muted mono route-upstream">{{ row.upstream_model }}</div>
            </div>
          </div>

          <div class="route-protocols">
            <span class="route-label">协议</span>
            <n-space :size="5" wrap>
              <n-tag v-for="endpoint in row.endpoints" :key="endpoint" size="small" type="info" :bordered="false">
                {{ endpointLabels[endpoint] ?? endpoint }}
              </n-tag>
            </n-space>
          </div>

          <div class="route-policy">
            <span class="route-label">分流</span>
            <strong>优先级 {{ row.priority }}</strong>
            <span class="muted">同级权重 {{ row.weight }}</span>
          </div>

          <div class="route-status">
            <span class="route-label">状态</span>
            <n-tag size="small" :type="statusMeta(row).type">{{ statusMeta(row).label }}</n-tag>
            <span class="muted">{{ availabilityDetail(row) }}</span>
            <span v-if="retryAt(row)" class="muted">恢复于 {{ formatRetry(retryAt(row)) }}</span>
          </div>

          <div class="route-actions">
            <n-button size="small" :disabled="managed(row)" @click="edit(row)">{{ managed(row) ? '供应商管理' : '编辑' }}</n-button>
            <n-button v-if="row.health?.disabledUntil && row.health.disabledUntil > Date.now()" size="small" type="warning" secondary @click="recover(row.provider_id)">立即恢复</n-button>
            <n-popconfirm v-if="!managed(row)" @positive-click="remove(row.id)">
              <template #trigger><n-button size="small" type="error" secondary>删除</n-button></template>
              确定删除该路由？
            </n-popconfirm>
          </div>
        </div>
      </div>
    </n-card>
  </div>
  <n-card v-else class="empty-route-card">没有匹配的路由策略</n-card>

  <n-modal v-model:show="modal" preset="card" :title="editing ? '编辑路由策略' : '新增路由策略'" style="width:min(760px,calc(100vw - 32px))">
    <n-form label-placement="top">
      <n-form-item label="客户端看到的模型名">
        <n-input v-model:value="form.publicModel" placeholder="例如 coding-fast" />
      </n-form-item>

      <div class="grid-2">
        <n-form-item label="渠道 / 供应商">
          <n-select v-model:value="form.providerId" :options="sourceOptions" filterable placeholder="选择请求来源" />
        </n-form-item>
        <n-form-item label="实际上游模型">
          <n-select
            :value="form.upstreamModel"
            :options="upstreamOptions"
            filterable
            tag
            placeholder="选择已发现模型，或直接输入模型 ID"
            @update:value="selectUpstream"
          />
        </n-form-item>
      </div>

      <div class="protocol-panel">
        <div class="protocol-panel__head">
          <div>
            <strong>请求协议</strong>
            <p>默认使用该上游模型支持的首选协议，无需三选一。</p>
          </div>
          <n-tag v-if="form.upstreamModel" type="success" :bordered="false" round>
            自动：{{ endpointLabels[selectedEndpoint] ?? selectedEndpoint }}
          </n-tag>
        </div>
        <div v-if="availableEndpoints.length" class="protocol-capabilities">
          <span class="muted">已发现能力</span>
          <n-tag v-for="endpoint in availableEndpoints" :key="endpoint" size="small" :bordered="false">
            {{ endpointLabels[endpoint] ?? endpoint }}
          </n-tag>
        </div>
        <button type="button" class="advanced-toggle" @click="advanced = !advanced">
          <sliders-horizontal :size="14" />
          <span>高级设置</span>
          <chevron-down :size="14" :class="{ 'advanced-toggle__icon--open': advanced }" />
        </button>
        <n-form-item v-if="advanced" label="手动指定协议" :show-feedback="false" class="advanced-endpoint">
          <n-select v-model:value="form.endpoint" :options="endpointOptions" />
        </n-form-item>
      </div>

      <div class="grid-2 policy-fields">
        <n-form-item label="优先级（越小越先）"><n-input-number v-model:value="form.priority" :min="1" style="width:100%" /></n-form-item>
        <n-form-item label="同级权重"><n-input-number v-model:value="form.weight" :min="1" style="width:100%" /></n-form-item>
      </div>

      <n-form-item label="Codex Multi-Agent V2">
        <n-space align="center">
          <n-switch v-model:value="form.codexMultiAgentV2" :disabled="selectedEndpoint !== 'responses'" />
          <span class="muted">仅 Responses 协议可用，默认关闭。</span>
        </n-space>
      </n-form-item>
      <n-form-item label="启用"><n-switch v-model:value="form.enabled" /></n-form-item>
      <n-space justify="end"><n-button @click="modal = false">取消</n-button><n-button type="primary" @click="save">保存策略</n-button></n-space>
    </n-form>
  </n-modal>
</template>

<style scoped>
.route-help { margin-bottom: 14px; }
.route-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.route-toolbar :deep(.n-input) { max-width: 420px; }
.route-groups { display: flex; flex-direction: column; gap: 14px; }
.route-card { border: 1px solid var(--n-border-color); border-radius: 15px; box-shadow: 0 8px 24px rgba(15, 23, 42, .04); }
.route-card :deep(.n-card__content) { padding: 18px; }
.route-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
.route-card__title { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.route-card__subtitle { margin-top: 4px; font-size: 11px; }
.route-list { border: 1px solid var(--n-border-color); border-radius: 12px; overflow: hidden; }
.route-line { display: grid; grid-template-columns: minmax(190px, 1.25fr) minmax(170px, .9fr) minmax(120px, .65fr) minmax(180px, 1fr) auto; align-items: center; gap: 18px; padding: 14px; }
.route-line + .route-line { border-top: 1px solid var(--n-border-color); }
.route-line:hover { background: color-mix(in srgb, var(--n-color-embedded) 58%, transparent); }
.route-source { display: flex; align-items: center; gap: 10px; min-width: 0; }
.route-source strong { font-size: 12px; }
.route-upstream { margin-top: 3px; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.route-protocols, .route-policy, .route-status { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; min-width: 0; font-size: 11px; }
.route-policy strong { font-size: 12px; }
.route-label { color: var(--n-text-color-3); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.route-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.empty-route-card { text-align: center; color: var(--n-text-color-3); }
.protocol-panel { margin-bottom: 18px; padding: 14px; border: 1px solid var(--n-border-color); border-radius: 12px; background: color-mix(in srgb, var(--n-color-embedded) 52%, transparent); }
.protocol-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.protocol-panel__head p { margin: 4px 0 0; color: var(--n-text-color-3); font-size: 11px; }
.protocol-capabilities { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 12px; font-size: 11px; }
.advanced-toggle { display: flex; align-items: center; gap: 7px; width: 100%; margin-top: 12px; padding: 10px 0 0; border: 0; border-top: 1px solid var(--n-border-color); background: transparent; color: var(--n-text-color-2); font: inherit; font-size: 11px; cursor: pointer; }
.advanced-toggle svg:last-child { margin-left: auto; transition: transform .18s ease; }
.advanced-toggle__icon--open { transform: rotate(180deg); }
.advanced-endpoint { margin: 12px 0 0; }
.policy-fields { margin-top: 4px; }
@media (max-width: 1100px) {
  .route-line { grid-template-columns: minmax(180px, 1fr) minmax(160px, 1fr) minmax(130px, .7fr); }
  .route-status { grid-column: 1 / 3; }
  .route-actions { grid-column: 3; grid-row: 2; }
}
@media (max-width: 720px) {
  .route-toolbar { align-items: stretch; flex-direction: column; }
  .route-toolbar :deep(.n-input) { max-width: none; }
  .route-line { grid-template-columns: 1fr; gap: 12px; }
  .route-status, .route-actions { grid-column: auto; grid-row: auto; }
  .route-actions { justify-content: flex-start; }
  .protocol-panel__head { align-items: flex-start; flex-direction: column; }
}
</style>
