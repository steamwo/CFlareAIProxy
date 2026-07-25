<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import { NButton, NCard, NDataTable, NInput, NSpace, NTag, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { RefreshCw, Search } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import type { DiscoveredModel, PublicModel } from "../types";

type DiscoveredModelGroup = Omit<DiscoveredModel, "endpoint"> & { endpoints: string[] };

const discovered = ref<DiscoveredModel[]>([]);
const publicModels = ref<PublicModel[]>([]);
const loading = ref(false);
const query = ref("");
const message = useMessage();
const tablePagination = { pageSize: 10, pageSizes: [10, 20, 50], showSizePicker: true, showQuickJumper: true };
const endpointOrder = new Map([["responses", 0], ["chat", 1], ["completions", 2]]);

async function load() {
  loading.value = true;
  try {
    const result = await api<{ data: DiscoveredModel[]; public: PublicModel[] }>("/models");
    discovered.value = result.data;
    publicModels.value = result.public;
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
async function refresh() {
  loading.value = true;
  try {
    await api("/models/refresh", { method: "POST" });
    message.success("所有账号的模型目录已刷新");
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
const groupedDiscovered = computed<DiscoveredModelGroup[]>(() => {
  const groups = new Map<string, DiscoveredModelGroup>();
  for (const row of discovered.value) {
    const key = `${row.provider_id}\u0000${row.credential_id}\u0000${row.model_id}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, endpoints: [row.endpoint] });
      continue;
    }
    if (!existing.endpoints.includes(row.endpoint)) existing.endpoints.push(row.endpoint);
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
  const q = query.value.toLowerCase();
  return groupedDiscovered.value.filter((row) => !q || `${row.provider_id} ${row.model_id} ${row.display_name} ${row.endpoints.join(" ")}`.toLowerCase().includes(q));
});
const columns: DataTableColumns<DiscoveredModelGroup> = [
  { title: "公开模型 ID", key: "model_id", render: (row) => h("div", [h("strong", `${row.provider_id}/${row.model_id}`), h("div", { class: "muted", style: "font-size:12px" }, row.display_name)]) },
  { title: "来源", key: "provider_id", render: (row) => h(NTag, { size: "small" }, { default: () => row.provider_id }) },
  { title: "支持端点", key: "endpoints", render: (row) => h(NSpace, { size: 5, wrap: true }, { default: () => row.endpoints.map((endpoint) => h(NTag, { size: "small", type: "info" }, { default: () => endpoint })) }) },
  { title: "账号", key: "credential_id", ellipsis: { tooltip: true } },
  { title: "发现时间", key: "discovered_at", render: (row) => new Date(row.discovered_at * 1000).toLocaleString() },
];
onMounted(load);
</script>

<template>
  <page-header title="实际模型" description="按来源、账号和模型合并展示；同一模型支持的 Chat、Responses、Completions 端点集中显示。">
    <n-button type="primary" :loading="loading" @click="refresh"><template #icon><refresh-cw /></template>刷新全部模型</n-button>
  </page-header>
  <div class="grid-stats">
    <n-card><div class="metric">{{ publicModels.length }}</div><div class="metric-label">公开模型</div></n-card>
    <n-card><div class="metric">{{ groupedDiscovered.length }}</div><div class="metric-label">账号模型</div></n-card>
    <n-card><div class="metric">{{ new Set(groupedDiscovered.map(value => value.provider_id)).size }}</div><div class="metric-label">有模型的来源</div></n-card>
    <n-card><div class="metric">{{ new Set(groupedDiscovered.map(value => value.credential_id)).size }}</div><div class="metric-label">已发现账号</div></n-card>
  </div>
  <n-card>
    <div class="toolbar"><n-input v-model:value="query" clearable placeholder="搜索模型、来源或端点" style="max-width:360px"><template #prefix><search /></template></n-input></div>
    <n-data-table :columns="columns" :data="rows" :loading="loading" :pagination="tablePagination" :row-key="row => `${row.provider_id}:${row.credential_id}:${row.model_id}`" :scroll-x="980" />
  </n-card>
</template>
