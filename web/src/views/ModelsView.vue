<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import { NButton, NCard, NDataTable, NInput, NSpace, NTag, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { RefreshCw, Search } from "@lucide/vue";
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

const discovered = ref<DiscoveredModel[]>([]);
const publicModels = ref<PublicModel[]>([]);
const sourceMap = ref(new Map<string, SourceMeta>());
const loading = ref(false);
const query = ref("");
const message = useMessage();
const tablePagination = { pageSize: 10, pageSizes: [10, 20, 50], showSizePicker: true, showQuickJumper: true };
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

const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  return groupedDiscovered.value.filter((row) => !q || `${row.sourceLabel} ${row.provider_id} ${row.model_id} ${row.display_name} ${row.endpoints.join(" ")}`.toLowerCase().includes(q));
});

const columns: DataTableColumns<DiscoveredModelGroup> = [
  {
    title: "实际模型",
    key: "model_id",
    render: (row) => h("div", [
      h("strong", { class: "model-id" }, row.model_id),
      row.display_name && row.display_name !== row.model_id
        ? h("div", { class: "muted model-name" }, row.display_name)
        : null,
    ]),
  },
  {
    title: "渠道 / 供应商",
    key: "provider_id",
    render: (row) => h("div", { class: "source-cell" }, [
      h(ProviderIcon, { providerId: row.provider_id, name: row.sourceLabel, size: 30 }),
      h("div", [
        h("strong", row.sourceLabel),
        h("div", { class: "source-meta" }, [
          h(NTag, { size: "tiny", bordered: false, type: row.sourceKind === "channel" ? "info" : "default" }, {
            default: () => row.sourceKind === "channel" ? "内置渠道" : row.sourceKind === "provider" ? "OpenAI 供应商" : "来源",
          }),
          h("span", { class: "muted mono" }, row.provider_id),
        ]),
      ]),
    ]),
  },
  {
    title: "支持端点 / 协议",
    key: "endpoints",
    render: (row) => h(NSpace, { size: 5, wrap: true }, {
      default: () => row.endpoints.map((endpoint) => h(NTag, { size: "small", type: "info", bordered: false }, { default: () => endpointLabels[endpoint] ?? endpoint })),
    }),
  },
  { title: "状态", key: "enabled", render: (row) => h(NTag, { size: "small", type: row.enabled === 1 ? "success" : "default" }, { default: () => row.enabled === 1 ? "可用" : "停用" }) },
  { title: "最近发现", key: "discovered_at", render: (row) => new Date(row.discovered_at * 1000).toLocaleString("zh-CN", { hour12: false }) },
];

onMounted(load);
</script>

<template>
  <page-header title="实际模型" description="按模型与渠道/供应商去重展示，同一来源支持的端点集中显示，不再因多个账号产生重复行。">
    <n-button type="primary" :loading="loading" @click="refresh"><template #icon><refresh-cw /></template>刷新全部模型</n-button>
  </page-header>

  <div class="grid-stats">
    <n-card><div class="metric">{{ publicModels.length }}</div><div class="metric-label">公开模型</div></n-card>
    <n-card><div class="metric">{{ groupedDiscovered.length }}</div><div class="metric-label">实际模型来源组合</div></n-card>
    <n-card><div class="metric">{{ new Set(groupedDiscovered.map(value => value.provider_id)).size }}</div><div class="metric-label">有模型的渠道 / 供应商</div></n-card>
    <n-card><div class="metric">{{ new Set(groupedDiscovered.flatMap(value => value.endpoints)).size }}</div><div class="metric-label">支持端点类型</div></n-card>
  </div>

  <n-card class="models-card">
    <div class="toolbar">
      <n-input v-model:value="query" clearable placeholder="搜索模型、渠道、供应商或端点" style="max-width:420px">
        <template #prefix><search /></template>
      </n-input>
    </div>
    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :pagination="tablePagination"
      :row-key="row => `${row.provider_id}:${row.model_id}`"
      :scroll-x="980"
    />
  </n-card>
</template>

<style scoped>
.models-card { border-radius: 14px; }
.model-id { font-size: 13px; }
.model-name { margin-top: 3px; font-size: 11px; }
.source-cell { display: flex; align-items: center; gap: 10px; min-width: 220px; }
.source-cell strong { font-size: 12px; }
.source-meta { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 10px; }
</style>
