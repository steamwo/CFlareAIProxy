<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NCard, NEmpty, NInput, NSpace, NTag, useMessage } from "naive-ui";
import { Boxes, RefreshCw, Search, Server, Waypoints } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProviderIcon from "../components/ProviderIcon.vue";
import { api } from "../api";
import type { Channel, DiscoveredModel, Provider, PublicModel } from "../types";

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
const publicModels = ref<PublicModel[]>([]);
const sourceMap = ref<Map<string, SourceMeta>>(new Map());
const loading = ref(false);
const query = ref("");
const message = useMessage();
const endpointOrder = new Map([["responses", 0], ["chat", 1], ["completions", 2]]);
const endpointLabels: Record<string, string> = { responses: "Responses", chat: "Chat", completions: "Completions" };

async function load() {
  loading.value = true;
  try {
    const [modelResult, channelResult, providerResult] = await Promise.all([
      api<{ data: DiscoveredModel[]; public: PublicModel[] }>("/models"),
      api<{ data: Channel[] }>("/channels"),
      api<{ data: Provider[] }>("/providers"),
    ]);
    discovered.value = modelResult.data;
    publicModels.value = modelResult.public;
    const nextSourceMap = new Map<string, SourceMeta>();
    for (const item of channelResult.data) nextSourceMap.set(item.id, { label: item.name, kind: "channel" });
    for (const item of providerResult.data) nextSourceMap.set(item.id, { label: item.name, kind: "provider" });
    sourceMap.value = nextSourceMap;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  loading.value = true;
  try {
    await api("/models/refresh", { method: "POST" });
    message.success("所有来源的模型目录已刷新");
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
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

const availableModelCount = computed(() => groupedDiscovered.value.filter((model) => model.enabled === 1).length);
const protocolCount = computed(() => new Set(groupedDiscovered.value.flatMap((model) => model.endpoints)).size);
const sourceTypeLabel = (kind: SourceKind): string => kind === "channel" ? "内置渠道" : kind === "provider" ? "OpenAI 供应商" : "来源";
const formatDate = (value: number): string => new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });

onMounted(load);
</script>

<template>
  <page-header title="模型目录" description="按渠道和供应商分区查看上游模型，不再按账号重复展示。">
    <n-button type="primary" :loading="loading" @click="refresh"><template #icon><refresh-cw /></template>刷新全部模型</n-button>
  </page-header>

  <n-card class="catalog-overview" :bordered="false">
    <div class="catalog-overview__copy">
      <span class="catalog-kicker"><boxes :size="15" />模型能力目录</span>
      <h2>{{ groupedDiscovered.length }} 个实际模型，来自 {{ sourceGroups.length }} 个渠道 / 供应商</h2>
      <p>同一模型的支持端点会合并显示；账号数量不再影响目录行数。</p>
    </div>
    <div class="catalog-overview__metrics">
      <div><strong>{{ publicModels.length }}</strong><span>公开模型</span></div>
      <div><strong>{{ availableModelCount }}</strong><span>当前可用</span></div>
      <div><strong>{{ protocolCount }}</strong><span>支持端点类型</span></div>
    </div>
  </n-card>

  <div class="catalog-toolbar">
    <n-input v-model:value="query" clearable placeholder="搜索模型、渠道、供应商或端点">
      <template #prefix><search /></template>
    </n-input>
    <n-tag :bordered="false">{{ sourceGroups.length }} 个来源分区</n-tag>
  </div>

  <div v-if="sourceGroups.length" class="source-groups">
    <n-card v-for="group in sourceGroups" :key="group.providerId" class="source-card" :bordered="false">
      <div class="source-card__head">
        <div class="source-identity">
          <provider-icon :provider-id="group.providerId" :name="group.sourceLabel" :size="42" />
          <div>
            <div class="source-title">
              <strong>{{ group.sourceLabel }}</strong>
              <n-tag size="small" :bordered="false" :type="group.sourceKind === 'channel' ? 'info' : 'default'">{{ sourceTypeLabel(group.sourceKind) }}</n-tag>
            </div>
            <span class="mono muted">{{ group.providerId }}</span>
          </div>
        </div>
        <div class="source-summary">
          <span><server :size="14" /><b>{{ group.models.length }}</b> 个模型</span>
          <span><waypoints :size="14" /><b>{{ group.endpoints.length }}</b> 类端点</span>
          <span class="muted">最近刷新 {{ formatDate(group.latestDiscoveredAt) }}</span>
        </div>
      </div>

      <div class="model-lines">
        <div v-for="model in group.models" :key="model.model_id" class="model-line">
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
      </div>
    </n-card>
  </div>
  <n-card v-else><n-empty description="没有匹配的模型目录" /></n-card>
</template>

<style scoped>
.catalog-overview { margin-bottom:16px; border:1px solid var(--n-border-color); background:linear-gradient(120deg,rgba(99,102,241,.09),transparent 48%),var(--n-color); }
.catalog-overview :deep(.n-card__content) { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:28px; padding:22px 24px; }
.catalog-kicker { display:flex; align-items:center; gap:7px; color:#6366f1; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.catalog-overview h2 { margin:8px 0 6px; font-size:20px; line-height:1.35; }
.catalog-overview p { margin:0; color:var(--n-text-color-3); font-size:12px; }
.catalog-overview__metrics { display:grid; grid-template-columns:repeat(3,minmax(90px,1fr)); gap:10px; }
.catalog-overview__metrics>div { padding:12px 14px; border:1px solid var(--n-border-color); border-radius:12px; background:color-mix(in srgb,var(--n-color) 82%,transparent); text-align:center; }
.catalog-overview__metrics strong { display:block; font-size:20px; line-height:1.1; }
.catalog-overview__metrics span { display:block; margin-top:5px; color:var(--n-text-color-3); font-size:10px; }
.catalog-toolbar { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.catalog-toolbar :deep(.n-input) { max-width:440px; }
.source-groups { display:flex; flex-direction:column; gap:14px; }
.source-card { border:1px solid var(--n-border-color); box-shadow:0 8px 24px rgba(15,23,42,.04); }
.source-card :deep(.n-card__content) { padding:18px; }
.source-card__head { display:flex; align-items:center; justify-content:space-between; gap:18px; padding-bottom:14px; }
.source-identity { display:flex; align-items:center; gap:12px; min-width:0; }
.source-title { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:4px; }
.source-title strong { font-size:15px; }
.source-identity .mono { font-size:10px; }
.source-summary { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:16px; font-size:11px; }
.source-summary>span { display:flex; align-items:center; gap:5px; white-space:nowrap; }
.model-lines { border:1px solid var(--n-border-color); border-radius:12px; overflow:hidden; }
.model-line { display:grid; grid-template-columns:minmax(220px,1.15fr) minmax(260px,1fr) auto; align-items:center; gap:20px; min-height:66px; padding:12px 14px; }
.model-line + .model-line { border-top:1px solid var(--n-border-color); }
.model-line:hover { background:color-mix(in srgb,var(--n-color-embedded) 58%,transparent); }
.model-copy { min-width:0; display:flex; flex-direction:column; gap:3px; }
.model-copy strong { overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.model-copy span { overflow:hidden; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.model-endpoints { display:flex; align-items:center; gap:10px; min-width:0; }
.model-label { color:var(--n-text-color-3); font-size:10px; white-space:nowrap; }
.model-state { display:flex; align-items:flex-end; flex-direction:column; gap:5px; font-size:10px; white-space:nowrap; }
@media(max-width:900px) { .catalog-overview :deep(.n-card__content) { grid-template-columns:1fr; } .catalog-overview__metrics { width:100%; } .source-card__head { align-items:flex-start; flex-direction:column; } .source-summary { justify-content:flex-start; } .model-line { grid-template-columns:1fr auto; } .model-endpoints { grid-column:1; grid-row:2; } .model-state { grid-column:2; grid-row:1 / 3; } }
@media(max-width:620px) { .catalog-toolbar { align-items:stretch; flex-direction:column; } .catalog-toolbar :deep(.n-input) { max-width:none; } .catalog-overview__metrics { grid-template-columns:1fr; } .model-line { grid-template-columns:1fr; gap:10px; } .model-endpoints,.model-state { grid-column:auto; grid-row:auto; align-items:flex-start; } }
</style>
