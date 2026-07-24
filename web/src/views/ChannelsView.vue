<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { NButton, NCard, NDescriptions, NDescriptionsItem, NPagination, NSelect, NSpace, NSwitch, NTag, useMessage } from "naive-ui";
import { KeyRound, RefreshCw, Route } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProviderIcon from "../components/ProviderIcon.vue";
import ProxyEditor from "../components/ProxyEditor.vue";
import { api, jsonBody } from "../api";
import type { Channel, PoolStrategy } from "../types";

const rows = ref<Channel[]>([]);
const loading = ref(false);
const proxyOpen = ref(false);
const selected = ref<Channel | null>(null);
const page = ref(1);
const pageSize = ref(6);
const message = useMessage();
const poolOptions = [
  { label: "轮询", value: "round_robin" },
  { label: "填满优先", value: "fill_first" },
  { label: "按权重", value: "weighted" },
  { label: "最少并发", value: "least_inflight" },
];
const pageCount = computed(() => Math.max(1, Math.ceil(rows.value.length / pageSize.value)));
const pagedRows = computed(() => rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch(pageCount, (count) => { if (page.value > count) page.value = count; });
async function load() {
  loading.value = true;
  try { rows.value = (await api<{ data: Channel[] }>("/channels")).data; }
  catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
async function update(row: Channel, patch: { enabled?: boolean; poolStrategy?: PoolStrategy }) {
  try {
    await api(`/channels/${row.id}`, { method: "PATCH", body: jsonBody(patch) });
    message.success("渠道设置已更新");
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
function editProxy(row: Channel) { selected.value = row; proxyOpen.value = true; }
onMounted(load);
</script>

<template>
  <page-header title="内置渠道" description="协议、端点和授权流程由 CFlareAIProxy 固定维护；你只管理账号、调度和代理。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>
  <div class="entity-grid">
    <n-card v-for="row in pagedRows" :key="row.id" class="entity-card">
      <div class="entity-card__head">
        <div>
          <div class="entity-card__title"><provider-icon :provider-id="row.id" :name="row.name" :size="30" /><span>{{ row.name }}</span><n-tag size="small" type="info">内置</n-tag></div>
          <p class="muted">{{ row.description }}</p>
        </div>
        <n-switch :value="row.enabled === 1" @update:value="value => update(row, { enabled: value })" />
      </div>
      <n-descriptions label-placement="top" :column="3" size="small" style="margin:14px 0">
        <n-descriptions-item label="授权方式">{{ row.authMode }}</n-descriptions-item>
        <n-descriptions-item label="账号">{{ row.enabledAccountCount }} / {{ row.accountCount }}</n-descriptions-item>
        <n-descriptions-item label="实际模型">{{ row.modelCount }}</n-descriptions-item>
      </n-descriptions>
      <n-space align="center" justify="space-between">
        <n-select style="width:150px" size="small" :value="row.pool_strategy" :options="poolOptions" @update:value="value => update(row, { poolStrategy: value })" />
        <n-space>
          <n-tag :type="row.proxy?.enabled ? 'success' : 'default'">{{ row.proxy?.source === 'provider' ? '覆盖代理' : row.proxy?.source === 'system' ? '系统代理' : '直连' }}</n-tag>
          <n-button size="small" @click="editProxy(row)"><template #icon><route /></template>代理</n-button>
          <n-button size="small" type="primary" @click="$router.push({ path: '/accounts', query: { source: row.id } })"><template #icon><key-round /></template>管理账号</n-button>
        </n-space>
      </n-space>
    </n-card>
  </div>
  <div v-if="rows.length > pageSize" class="pagination-row"><n-pagination v-model:page="page" v-model:page-size="pageSize" :item-count="rows.length" :page-sizes="[6, 12, 24]" show-size-picker /></div>
  <proxy-editor v-if="selected" v-model:show="proxyOpen" :provider-id="selected.id" :summary="selected.proxy" :title="`${selected.name} · 覆盖代理`" @changed="load" />
</template>
