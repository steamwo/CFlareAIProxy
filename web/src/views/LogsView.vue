<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import { NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent, NInput, NSelect, NTag, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { RefreshCw, Search } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import type { RequestLog } from "../types";

const rows = ref<RequestLog[]>([]);
const loading = ref(false);
const query = ref("");
const status = ref("all");
const drawer = ref(false);
const selected = ref<RequestLog | null>(null);
const message = useMessage();
const tablePagination = { pageSize: 20, pageSizes: [20, 50, 100], showSizePicker: true, showQuickJumper: true };
async function load() { loading.value = true; try { rows.value = (await api<{ data: RequestLog[] }>("/logs?limit=500")).data; } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } finally { loading.value = false; } }
const filtered = computed(() => rows.value.filter((row) => {
  const statusMatch = status.value === "all" || (status.value === "ok" ? row.status_code < 400 : row.status_code >= 400);
  const q = query.value.toLowerCase();
  return statusMatch && (!q || `${row.request_id} ${row.provider_id} ${row.public_model} ${row.error_code}`.toLowerCase().includes(q));
}));
const columns: DataTableColumns<RequestLog> = [
  { title: "时间", key: "created_at", render: (row) => new Date(row.created_at * 1000).toLocaleString() },
  { title: "状态", key: "status_code", render: (row) => h(NTag, { size: "small", type: row.status_code < 400 ? "success" : "error" }, { default: () => String(row.status_code) }) },
  { title: "模型", key: "public_model", ellipsis: { tooltip: true } },
  { title: "来源", key: "provider_id" },
  { title: "Token", key: "total_tokens" },
  { title: "延迟", key: "latency_ms", render: (row) => `${row.latency_ms} ms` },
  { title: "操作", key: "actions", render: (row) => h(NButton, { size: "small", onClick: () => { selected.value = row; drawer.value = true; } }, { default: () => "详情" }) },
];
onMounted(load);
</script>

<template>
  <page-header title="请求日志" description="默认不保存完整提示词与输出，只记录路由、用量、延迟和错误。"><n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button></page-header>
  <n-card><div class="toolbar"><n-input v-model:value="query" clearable placeholder="搜索请求、模型或错误" style="max-width:360px"><template #prefix><search /></template></n-input><n-select v-model:value="status" style="width:140px" :options="[{ label: '全部状态', value: 'all' }, { label: '成功', value: 'ok' }, { label: '失败', value: 'error' }]" /></div><n-data-table :columns="columns" :data="filtered" :loading="loading" :pagination="tablePagination" :scroll-x="1020" /></n-card>
  <n-drawer v-model:show="drawer" placement="right" :width="520"><n-drawer-content title="请求详情" closable><n-descriptions v-if="selected" label-placement="top" :column="2" bordered><n-descriptions-item label="Request ID" :span="2"><span class="mono">{{ selected.request_id }}</span></n-descriptions-item><n-descriptions-item label="状态">{{ selected.status_code }}</n-descriptions-item><n-descriptions-item label="接口">{{ selected.endpoint }}</n-descriptions-item><n-descriptions-item label="公开模型">{{ selected.public_model }}</n-descriptions-item><n-descriptions-item label="上游模型">{{ selected.upstream_model }}</n-descriptions-item><n-descriptions-item label="来源">{{ selected.provider_id }}</n-descriptions-item><n-descriptions-item label="账号"><span class="mono">{{ selected.credential_id }}</span></n-descriptions-item><n-descriptions-item label="Token">输入 {{ selected.prompt_tokens }}（缓存 {{ selected.cached_tokens || 0 }}）+ 输出 {{ selected.completion_tokens }} = {{ selected.total_tokens }}</n-descriptions-item><n-descriptions-item label="延迟">{{ selected.latency_ms }} ms</n-descriptions-item><n-descriptions-item label="首 Token">{{ selected.first_token_ms ?? '-' }} ms</n-descriptions-item><n-descriptions-item label="成本">${{ (selected.cost_micros / 1_000_000).toFixed(6) }}</n-descriptions-item><n-descriptions-item v-if="selected.error_message" label="错误" :span="2"><n-tag type="error">{{ selected.error_code }}</n-tag><p>{{ selected.error_message }}</p></n-descriptions-item></n-descriptions></n-drawer-content></n-drawer>
</template>
