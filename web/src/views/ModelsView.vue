<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NCard, NCollapse, NCollapseItem, NEmpty, NInput, NSpace, NTag } from "naive-ui";
import { RefreshCw, Search, Server, Waypoints } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProviderIcon from "../components/ProviderIcon.vue";
import { api } from "../api";
import { useApiRequest } from "../composables/useApiRequest";
import type { Channel, DiscoveredModel, Provider } from "../types";

type SourceKind = "channel" | "provider" | "unknown";
interface SourceMeta { label: string; kind: SourceKind }
interface DiscoveredModelGroup extends Omit<DiscoveredModel, "endpoint" | "credential_id"> {
  endpoints: string[];
  credentialIds: string[];
  sourceLabel: string;
  sourceKind: SourceKind;
}
interface SourceGroup {
  providerId: string;
  sourceLabel: string;
  sourceKind: SourceKind;
  models: DiscoveredModelGroup[];
  endpoints: string[];
  latestDiscoveredAt: number;
}

const discovered = ref<DiscoveredModel[]>([]);
const sourceMap = ref<Map<string, SourceMeta>>(new Map());
const query = ref("");
const expandedSources = ref<string[]>([]);
const { loading, run } = useApiRequest();
const endpointOrder = new Map([["responses", 0], ["chat", 1], ["completions", 2]]);
const endpointLabels: Record<string, string> = { responses: "Responses", chat: "Chat", completions: "Completions" };

async function load() {
  await run(async () => {
    const [modelResult, channelResult, providerResult] = await Promise.all([
      api<{ data: DiscoveredModel[] }>("/models"),
      api<{ data: Channel[] }>("/channels"),
      api<{ data: Provider[] }>("/providers"),
    ]);
    discovered.value = modelResult.data;
    const nextSourceMap = new Map<string, SourceMeta>();
    for (const item of channelResult.data) nextSourceMap.set(item.id, { label: item.name, kind: "channel" });
    for (const item of providerResult.data) nextSourceMap.set(item.id, { label: item.name, kind: "provider" });
    sourceMap.value = nextSourceMap;
  });
}

async function refresh() {
  // load() drives the shared loading ref, so the refresh call keeps it held until the
  // reload finishes instead of flickering back to idle between the two requests.
  const refreshed = await run(
    () => api("/models/refresh", { method: "POST" }),
    { success: "所有来源的模型目录已刷新" },
  );
  if (refreshed !== undefined) await load();
}

const groupedDiscovered = computed<DiscoveredModelGroup[]>(() => {
  const groups = new Map<string, DiscoveredModelGroup>();
  for (const row of discovered.value) {
    const key = `${row.provider_id}\u0000${row.model_id}`;
    const source = sourceMap.value.get(row.provider_id) ?? { label: row.provider_id, kind: "unknown" as const };
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        provider_id: row.provider_id,
        model_id: row.model_id,
        display_name: row.display_name,
        owned_by: row.owned_by,
        enabled: row.enabled,
        discovered_at: row.discovered_at,
        endpoints: [row.endpoint],
        credentialIds: [row.credential_id],
        sourceLabel: source.label,
        sourceKind: source.kind,
      });
      continue;
    }
    if (!existing.endpoints.includes(row.endpoint)) existing.endpoints.push(row.endpoint);
    if (!existing.credentialIds.includes(row.credential_id)) existing.credentialIds.push(row.credential_id);
    existing.discovered_at = Math.max(existing.discovered_at, row.discovered_at);
    existing.enabled = Math.max(existing.enabled, row.enabled);
    if (!existing.display_name && row.display_name) existing.display_name = row.display_name;
  }
  return [...groups.values()].map((row) => ({
    ...row,
    endpoints: [...row.endpoints].sort((left, right) => (endpointOrder.get(left) ?? 99) - (endpointOrder.get(right) ?? 99) || left.localeCompare(right)),
  }));
});

const sourceGroups = computed<SourceGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  const groups = new Map<string, SourceGroup>();
  for (const model of groupedDiscovered.value) {
    const sourceMatches = `${model.sourceLabel} ${model.provider_id}`.toLowerCase().includes(q);
    const modelMatches = `${model.model_id} ${model.display_name} ${model.endpoints.join(" ")}`.toLowerCase().includes(q);
    if (q && !sourceMatches && !modelMatches) continue;
    const existing = groups.get(model.provider_id);
    if (!existing) {
      groups.set(model.provider_id, {
        providerId: model.provider_id,
        sourceLabel: model.sourceLabel,
        sourceKind: model.sourceKind,
        models: [model],
        endpoints: [...model.endpoints],
        latestDiscoveredAt: model.discovered_at,
      });
      continue;
    }
    existing.models.push(model);
    for (const endpoint of model.endpoints) if (!existing.endpoints.includes(endpoint)) existing.endpoints.push(endpoint);
    existing.latestDiscoveredAt = Math.max(existing.latestDiscoveredAt, model.discovered_at);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      models: group.models.sort((left, right) => left.model_id.localeCompare(right.model_id)),
      endpoints: group.endpoints.sort((left, right) => (endpointOrder.get(left) ?? 99) - (endpointOrder.get(right) ?? 99)),
    }))
    .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel));
});

/**
 * A large upstream catalogue can hold hundreds of models for a single source. The collapse
 * already keeps them off the initial render, but an expanded source used to mount every row
 * at once; cap it and let the user opt into the rest per source.
 */
const MODEL_PREVIEW_LIMIT = 30;
const fullyShown = ref<string[]>([]);
// An active search means the user already narrowed the set on purpose, so show every match.
const visibleModels = (group: SourceGroup): DiscoveredModelGroup[] => query.value.trim() || fullyShown.value.includes(group.providerId)
  ? group.models
  : group.models.slice(0, MODEL_PREVIEW_LIMIT);
function showAll(providerId: string) {
  if (!fullyShown.value.includes(providerId)) fullyShown.value = [...fullyShown.value, providerId];
}

const sourceTypeLabel = (kind: SourceKind): string => kind === "channel" ? "内置渠道" : kind === "provider" ? "OpenAI 供应商" : "来源";
const formatDate = (value: number): string => new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });

onMounted(load);
</script>

<template>
  <page-header title="模型目录" description="按渠道和供应商折叠查看上游模型，不再按账号重复展示。">
    <n-button type="primary" :loading="loading" @click="refresh"><template #icon><refresh-cw /></template>刷新全部模型</n-button>
  </page-header>

  <div class="catalog-toolbar">
    <n-input v-model:value="query" clearable placeholder="搜索模型、渠道、供应商或端点">
      <template #prefix><search /></template>
    </n-input>
    <n-tag :bordered="false">{{ sourceGroups.length }} 个来源</n-tag>
  </div>

  <n-collapse v-if="sourceGroups.length" v-model:expanded-names="expandedSources" class="source-collapse">
    <n-collapse-item v-for="group in sourceGroups" :key="group.providerId" :name="group.providerId">
      <template #header>
        <div class="source-identity">
          <provider-icon :provider-id="group.providerId" :name="group.sourceLabel" :size="38" />
          <div class="source-copy">
            <div class="source-title">
              <strong>{{ group.sourceLabel }}</strong>
              <n-tag size="small" :bordered="false" :type="group.sourceKind === 'channel' ? 'info' : 'default'">{{ sourceTypeLabel(group.sourceKind) }}</n-tag>
            </div>
            <span class="mono muted">{{ group.providerId }}</span>
          </div>
        </div>
      </template>

      <template #header-extra>
        <div class="source-summary">
          <span><server :size="14" /><b>{{ group.models.length }}</b> 个模型</span>
          <span><waypoints :size="14" /><b>{{ group.endpoints.length }}</b> 类端点</span>
          <span class="muted">{{ formatDate(group.latestDiscoveredAt) }}</span>
        </div>
      </template>

      <div class="model-lines">
        <div v-for="model in visibleModels(group)" :key="model.model_id" class="model-line">
          <div class="model-copy">
            <strong class="mono">{{ model.model_id }}</strong>
            <span v-if="model.display_name && model.display_name !== model.model_id" class="muted">{{ model.display_name }}</span>
          </div>
          <div class="model-endpoints">
            <span class="model-label">支持端点</span>
            <n-space :size="5" wrap>
              <n-tag v-for="endpoint in model.endpoints" :key="endpoint" size="small" type="info" :bordered="false">
                {{ endpointLabels[endpoint] ?? endpoint }}
              </n-tag>
            </n-space>
          </div>
          <div class="model-state">
            <n-tag size="small" :type="model.enabled === 1 ? 'success' : 'default'">{{ model.enabled === 1 ? '可用' : '停用' }}</n-tag>
            <span class="muted">{{ formatDate(model.discovered_at) }}</span>
          </div>
        </div>
        <div v-if="group.models.length > visibleModels(group).length" class="model-more">
          <n-button size="small" quaternary @click="showAll(group.providerId)">
            显示全部 {{ group.models.length }} 个模型
          </n-button>
        </div>
      </div>
    </n-collapse-item>
  </n-collapse>

  <n-card v-else><n-empty description="没有匹配的模型目录" /></n-card>
</template>

<style scoped>
.catalog-toolbar { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.catalog-toolbar :deep(.n-input) { max-width:440px; }
.source-collapse { display:flex; flex-direction:column; gap:12px; }
.source-collapse :deep(.n-collapse-item) { margin:0; overflow:hidden; border:1px solid var(--n-border-color); border-radius:14px; background:var(--n-color); box-shadow:0 6px 18px rgba(15,23,42,.035); }
.source-collapse :deep(.n-collapse-item__header) { padding:0; }
.source-collapse :deep(.n-collapse-item__header-main) { min-width:0; padding:15px 18px; }
.source-collapse :deep(.n-collapse-item__header-extra) { padding:15px 18px 15px 0; }
.source-collapse :deep(.n-collapse-item__content-wrapper) { border-top:1px solid var(--n-border-color); }
.source-collapse :deep(.n-collapse-item__content-inner) { padding:0; }
.source-identity { display:flex; align-items:center; gap:12px; min-width:0; }
.source-copy { min-width:0; }
.source-title { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:4px; }
.source-title strong { overflow:hidden; font-size:15px; text-overflow:ellipsis; white-space:nowrap; }
.source-copy .mono { display:block; overflow:hidden; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.source-summary { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:14px; font-size:11px; }
.source-summary>span { display:flex; align-items:center; gap:5px; white-space:nowrap; }
.model-lines { overflow:hidden; }
.model-more { display:flex; justify-content:center; padding:10px 0 2px; }
.model-line { display:grid; grid-template-columns:minmax(220px,1.15fr) minmax(260px,1fr) auto; align-items:center; gap:20px; min-height:66px; padding:12px 18px; }
.model-line + .model-line { border-top:1px solid var(--n-border-color); }
.model-line:hover { background:color-mix(in srgb,var(--n-color-embedded) 58%,transparent); }
.model-copy { min-width:0; display:flex; flex-direction:column; gap:3px; }
.model-copy strong { overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.model-copy span { overflow:hidden; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.model-endpoints { display:flex; align-items:center; gap:10px; min-width:0; }
.model-label { color:var(--n-text-color-3); font-size:10px; white-space:nowrap; }
.model-state { display:flex; align-items:flex-end; flex-direction:column; gap:5px; font-size:10px; white-space:nowrap; }
@media(max-width:900px) {
  .source-collapse :deep(.n-collapse-item__header-main) { padding:14px; }
  .source-collapse :deep(.n-collapse-item__header-extra) { padding:0 14px 14px 62px; }
  .source-summary { justify-content:flex-start; }
  .model-line { grid-template-columns:1fr auto; }
  .model-endpoints { grid-column:1; grid-row:2; }
  .model-state { grid-column:2; grid-row:1 / 3; }
}
@media(max-width:620px) {
  .catalog-toolbar { align-items:stretch; flex-direction:column; }
  .catalog-toolbar :deep(.n-input) { max-width:none; }
  .source-summary .muted { display:none; }
  .model-line { grid-template-columns:1fr; gap:10px; }
  .model-endpoints,.model-state { grid-column:auto; grid-row:auto; align-items:flex-start; }
}
</style>
