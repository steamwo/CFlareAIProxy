<script setup lang="ts">
import { h, onMounted, reactive, ref } from "vue";
import { NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputNumber, NModal, NPopconfirm, NSelect, NSpace, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { Plus, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api, jsonBody } from "../api";
import type { Channel, Price, Provider } from "../types";

const rows = ref<Price[]>([]);
const sources = ref<Array<{ label: string; value: string }>>([]);
const loading = ref(false);
const modal = ref(false);
const message = useMessage();
const form = reactive({ providerId: "", model: "", input: 0, output: 0, cache: 0 });

async function load() {
  loading.value = true;
  try {
    const [prices, channels, providers] = await Promise.all([
      api<{ data: Price[] }>("/prices"), api<{ data: Channel[] }>("/channels"), api<{ data: Provider[] }>("/providers"),
    ]);
    rows.value = prices.data;
    sources.value = [...channels.data, ...providers.data].map((item) => ({ label: item.name, value: item.id }));
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function open(row?: Price) {
  Object.assign(form, row ? {
    providerId: row.provider_id, model: row.model, input: row.input_micros_per_million,
    output: row.output_micros_per_million, cache: row.cache_micros_per_million ?? 0,
  } : { providerId: "", model: "", input: 0, output: 0, cache: 0 });
  modal.value = true;
}
async function save() {
  try {
    await api("/prices", { method: "PUT", body: jsonBody({
      providerId: form.providerId, model: form.model,
      inputMicrosPerMillion: form.input, outputMicrosPerMillion: form.output, cacheMicrosPerMillion: form.cache,
    }) });
    message.success("价格已保存"); modal.value = false; await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function remove(row: Price) {
  try {
    await api(`/prices?provider=${encodeURIComponent(row.provider_id)}&model=${encodeURIComponent(row.model)}`, { method: "DELETE" });
    message.success("价格已删除"); await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
const usd = (value: number) => `$${(value / 1_000_000).toFixed(4)}`;
const columns: DataTableColumns<Price> = [
  { title: "来源", key: "provider_id" },
  { title: "模型", key: "model", ellipsis: { tooltip: true } },
  { title: "输入 / 1M Token", key: "input", render: (row) => usd(row.input_micros_per_million) },
  { title: "输出 / 1M Token", key: "output", render: (row) => usd(row.output_micros_per_million) },
  { title: "缓存命中 / 1M Token", key: "cache", render: (row) => usd(row.cache_micros_per_million ?? 0) },
  { title: "操作", key: "actions", render: (row) => h(NSpace, null, { default: () => [
    h(NButton, { size: "small", onClick: () => open(row) }, { default: () => "编辑" }),
    h(NPopconfirm, { onPositiveClick: () => remove(row) }, {
      trigger: () => h(NButton, { size: "small", type: "error", secondary: true }, { default: () => "删除" }),
      default: () => "确定删除该价格？",
    }),
  ] }) },
];
onMounted(load);
</script>

<template>
  <page-header title="模型价格" description="分别设置输入、输出和缓存命中 Token 的成本，单位均为每百万 Token。">
    <n-button type="primary" @click="open()"><template #icon><plus /></template>添加价格</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>
  <n-card><n-data-table :columns="columns" :data="rows" :loading="loading" :scroll-x="900" /></n-card>
  <n-modal v-model:show="modal" preset="card" title="模型价格" style="width:min(720px,calc(100vw - 32px))">
    <n-form label-placement="top">
      <div class="grid-2">
        <n-form-item label="来源"><n-select v-model:value="form.providerId" :options="sources" filterable /></n-form-item>
        <n-form-item label="上游模型"><n-input v-model:value="form.model" /></n-form-item>
      </div>
      <div class="grid-stats" style="grid-template-columns:repeat(3,1fr)">
        <n-form-item label="输入（微美元 / 1M）"><n-input-number v-model:value="form.input" :min="0" style="width:100%" /></n-form-item>
        <n-form-item label="输出（微美元 / 1M）"><n-input-number v-model:value="form.output" :min="0" style="width:100%" /></n-form-item>
        <n-form-item label="缓存命中（微美元 / 1M）"><n-input-number v-model:value="form.cache" :min="0" style="width:100%" /></n-form-item>
      </div>
      <n-space justify="end"><n-button @click="modal = false">取消</n-button><n-button type="primary" @click="save">保存</n-button></n-space>
    </n-form>
  </n-modal>
</template>
