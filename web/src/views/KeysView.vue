<script setup lang="ts">
import { h, onMounted, reactive, ref } from "vue";
import { NAlert, NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputNumber, NModal, NPopconfirm, NSelect, NSpace, NSwitch, NTag, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { Copy, Plus, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api, jsonBody } from "../api";
import type { GatewayKey, PublicModel } from "../types";

const rows = ref<GatewayKey[]>([]);
const models = ref<PublicModel[]>([]);
const loading = ref(false);
const modal = ref(false);
const secretModal = ref(false);
const createdKey = ref("");
const editing = ref<GatewayKey | null>(null);
const message = useMessage();
const tablePagination = { pageSize: 10, pageSizes: [10, 20, 50], showSizePicker: true, showQuickJumper: true };
const form = reactive({ name: "", rpm: 60, maxConcurrency: 8, monthlyTokenLimit: 0, allowedModels: [] as string[], enabled: true });
async function load() {
  loading.value = true;
  try {
    const [keyResult, modelResult] = await Promise.all([api<{ data: GatewayKey[] }>("/keys"), api<{ public: PublicModel[] }>("/models")]);
    rows.value = keyResult.data;
    models.value = modelResult.public;
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function create() { editing.value = null; Object.assign(form, { name: "", rpm: 60, maxConcurrency: 8, monthlyTokenLimit: 0, allowedModels: [], enabled: true }); modal.value = true; }
function edit(row: GatewayKey) { editing.value = row; Object.assign(form, { name: row.name, rpm: row.rpm, maxConcurrency: row.max_concurrency, monthlyTokenLimit: row.monthly_token_limit, allowedModels: JSON.parse(row.allowed_models_json || "[]"), enabled: row.enabled === 1 }); modal.value = true; }
async function save() {
  try {
    if (editing.value) await api(`/keys/${editing.value.id}`, { method: "PATCH", body: jsonBody(form) });
    else {
      const result = await api<{ id: string; key: string }>("/keys", { method: "POST", body: jsonBody(form) });
      createdKey.value = result.key;
      secretModal.value = true;
    }
    message.success(editing.value ? "密钥设置已更新" : "密钥已创建");
    modal.value = false;
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function remove(id: string) { try { await api(`/keys/${id}`, { method: "DELETE" }); message.success("网关密钥已删除"); await load(); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } }
async function copy() { await navigator.clipboard.writeText(createdKey.value); message.success("已复制"); }
const columns: DataTableColumns<GatewayKey> = [
  { title: "名称", key: "name", render: (row) => h("div", [h("strong", row.name), h("div", { class: "mono muted", style: "font-size:12px" }, `${row.key_prefix}…`)]) },
  { title: "限制", key: "limits", render: (row) => `${row.rpm} RPM · ${row.max_concurrency} 并发` },
  { title: "月 Token", key: "monthly_token_limit", render: (row) => row.monthly_token_limit ? Intl.NumberFormat("zh-CN").format(row.monthly_token_limit) : "不限" },
  { title: "模型范围", key: "allowed_models_json", render: (row) => { const allowed = JSON.parse(row.allowed_models_json || "[]"); return h(NTag, { size: "small" }, { default: () => allowed.length ? `${allowed.length} 个模型` : "全部模型" }); } },
  { title: "启用", key: "enabled", render: (row) => h(NSwitch, { value: row.enabled === 1, onUpdateValue: (value: boolean) => api(`/keys/${row.id}`, { method: "PATCH", body: jsonBody({ enabled: value }) }).then(load) }) },
  { title: "操作", key: "actions", render: (row) => h(NSpace, null, { default: () => [h(NButton, { size: "small", onClick: () => edit(row) }, { default: () => "编辑" }), h(NPopconfirm, { onPositiveClick: () => remove(row.id) }, { trigger: () => h(NButton, { size: "small", type: "error", secondary: true }, { default: () => "删除" }), default: () => "删除后客户端将立即无法使用。" })] }) },
];
onMounted(load);
</script>

<template>
  <page-header title="网关密钥" description="客户端只使用网关 Key；上游账号密钥始终加密保存在服务端。">
    <n-button type="primary" @click="create"><template #icon><plus /></template>创建密钥</n-button><n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>
  <n-card><n-data-table :columns="columns" :data="rows" :loading="loading" :pagination="tablePagination" :scroll-x="960" /></n-card>
  <n-modal v-model:show="modal" preset="card" :title="editing ? '编辑网关密钥' : '创建网关密钥'" style="width:min(680px,calc(100vw - 32px))">
    <n-form label-placement="top"><n-form-item label="名称"><n-input v-model:value="form.name" /></n-form-item><div class="grid-stats" style="grid-template-columns:repeat(3,1fr)"><n-form-item label="RPM"><n-input-number v-model:value="form.rpm" :min="1" /></n-form-item><n-form-item label="最大并发"><n-input-number v-model:value="form.maxConcurrency" :min="1" /></n-form-item><n-form-item label="月 Token（0=不限）"><n-input-number v-model:value="form.monthlyTokenLimit" :min="0" /></n-form-item></div><n-form-item label="允许模型（空=全部）"><n-select v-model:value="form.allowedModels" multiple filterable clearable :options="models.map(model => ({ label: model.id, value: model.id }))" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="form.enabled" /></n-form-item><n-space justify="end"><n-button @click="modal = false">取消</n-button><n-button type="primary" @click="save">保存</n-button></n-space></n-form>
  </n-modal>
  <n-modal v-model:show="secretModal" preset="card" title="保存新密钥" style="width:min(640px,calc(100vw - 32px))"><n-alert type="warning" :bordered="false">完整密钥只显示这一次，请立即复制到安全位置。</n-alert><n-input :value="createdKey" readonly class="mono" style="margin:16px 0"><template #suffix><n-button text @click="copy"><copy /></n-button></template></n-input><n-button block type="primary" @click="secretModal = false">我已保存</n-button></n-modal>
</template>
