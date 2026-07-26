<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NButton, NCard, NEmpty, NForm, NFormItem, NInput, NInputNumber, NModal,
  NPagination, NSpace, NSpin, NSwitch,
} from "naive-ui";
import { FileJson, KeyRound, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import AccountCard from "../components/AccountCard.vue";
import { api, jsonBody } from "../api";
import { useApiRequest } from "../composables/useApiRequest";
import type { ActivityRecord } from "../utils/account-activity";
import type { Channel, Credential, QuotaSnapshot } from "../types";

interface CredentialPage {
  data: Credential[];
  quotas: QuotaSnapshot[];
  activity: Record<string, ActivityRecord>;
  total: number;
  page: number;
  pageSize: number;
  pageCount?: number;
}

const route = useRoute();
const router = useRouter();
const { loading, run } = useApiRequest();
const allowedPageSizes = [6, 12, 24];
const queryInteger = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const sourceQuery = (): string => typeof route.query.source === "string" ? route.query.source : "";
const page = ref(queryInteger(route.query.page, 1));
const requestedPageSize = queryInteger(route.query.pageSize, 6);
const pageSize = ref(allowedPageSizes.includes(requestedPageSize) ? requestedPageSize : 6);
const activeSource = ref(sourceQuery());
const credentials = ref<Credential[]>([]);
const channels = ref<Channel[]>([]);
const quotas = ref<QuotaSnapshot[]>([]);
const activity = ref<Record<string, ActivityRecord>>({});
const total = ref(0);
const modal = ref(false);
const editing = ref<Credential | null>(null);
const form = reactive({ label: "", enabled: true, priority: 100, weight: 1, maxConcurrency: 4 });
const sourceNames = computed(() => new Map(channels.value.map((channel) => [channel.id, channel.name] as const)));
const quotaMap = computed(() => new Map(quotas.value.map((quota) => [quota.credential_id, quota] as const)));

/**
 * Re-read on every load so activity strips advance with the clock instead of freezing on the
 * timestamp of the first render.
 */
const nowMs = ref(Date.now());

const sourceName = (id: string): string => sourceNames.value.get(id) ?? id;
const providerLabel = (id: string): string => ({ codex: "Codex", qoder: "Qoder", kimi: "Kimi" } as Record<string, string>)[id] ?? sourceName(id);

const paginationQuery = (nextPage = page.value, nextPageSize = pageSize.value) => ({ ...route.query, page: String(nextPage), pageSize: String(nextPageSize) });

async function load() {
  await run(async () => {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
    if (activeSource.value) params.set("provider", activeSource.value);
    const [channelResult, accountResult] = await Promise.all([
      channels.value.length ? Promise.resolve(null) : api<{ data: Channel[] }>("/channels"),
      api<CredentialPage>(`/credentials/paged?${params}`),
    ]);
    if (channelResult) channels.value = channelResult.data;
    credentials.value = accountResult.data;
    quotas.value = accountResult.quotas;
    activity.value = accountResult.activity ?? {};
    total.value = accountResult.total;
    page.value = accountResult.page;
    pageSize.value = accountResult.pageSize;
    nowMs.value = Date.now();
    await router.replace({ query: paginationQuery() });
  });
}

function openEdit(row: Credential) {
  editing.value = row;
  Object.assign(form, { label: row.label, enabled: row.enabled === 1, priority: row.priority, weight: row.weight, maxConcurrency: row.max_concurrency });
  modal.value = true;
}

async function save() {
  const target = editing.value;
  if (!target) return;
  await run(async () => {
    await api(`/credentials/${target.id}`, { method: "PATCH", body: jsonBody(form) });
    modal.value = false;
    await load();
  }, { success: "账号已更新", loading: null });
}

async function remove(id: string) {
  await run(async () => {
    await api(`/credentials/${id}`, { method: "DELETE" });
    await load();
  }, { success: "账号已删除", loading: null });
}

async function toggleEnabled(row: Credential, enabled: boolean) {
  await run(async () => {
    await api(`/credentials/${row.id}`, { method: "PATCH", body: jsonBody({ enabled }) });
    row.enabled = enabled ? 1 : 0;
  }, { loading: null });
}

async function refreshOne(id: string) {
  await run(async () => {
    await Promise.all([
      api(`/models/refresh/credential/${id}`, { method: "POST" }),
      api(`/quotas/refresh/${id}`, { method: "POST" }),
    ]);
    await load();
  }, { success: "模型与额度已刷新", loading: null });
}

async function downloadAuth(row: Credential) {
  await run(async () => {
    const payload = await api<Record<string, unknown>>(`/auth-files/${row.id}/export`);
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${row.label.replace(/[^a-zA-Z0-9._-]+/g, "_") || row.provider_id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, { loading: null });
}

watch(() => [route.query.page, route.query.pageSize, route.query.source] as const, () => {
  const nextPage = queryInteger(route.query.page, 1);
  const size = queryInteger(route.query.pageSize, 6);
  const nextSize = allowedPageSizes.includes(size) ? size : 6;
  const source = sourceQuery();
  const changed = nextPage !== page.value || nextSize !== pageSize.value || source !== activeSource.value;
  page.value = nextPage;
  pageSize.value = nextSize;
  activeSource.value = source;
  if (changed) void load();
});
onMounted(load);
</script>

<template>
  <page-header title="账号池" description="集中查看账号状态、近 2 小时调用健康度和额度窗口。">
    <n-button type="primary" @click="router.push({ name: 'authorization' })"><template #icon><key-round /></template>发起授权</n-button>
    <n-button @click="router.push({ name: 'authorization', query: { import: '1' } })"><template #icon><file-json /></template>导入认证文件</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-spin :show="loading">
    <div v-if="credentials.length" class="account-grid" role="list" aria-label="账号列表">
      <account-card
        v-for="row in credentials"
        :key="row.id"
        :row="row"
        :quota="quotaMap.get(row.id)"
        :activity="activity[row.id]"
        :provider-label="providerLabel(row.provider_id)"
        :now-ms="nowMs"
        @refresh="refreshOne"
        @download="downloadAuth"
        @edit="openEdit"
        @remove="remove"
        @toggle="toggleEnabled"
      />
    </div>
    <n-card v-else><n-empty description="账号池还是空的，请前往授权页添加账号" /></n-card>
  </n-spin>

  <div v-if="total" class="pagination-row">
    <n-pagination
      :page="page"
      :page-size="pageSize"
      :item-count="total"
      :page-sizes="allowedPageSizes"
      show-size-picker
      show-quick-jumper
      @update:page="value => router.push({ query: paginationQuery(value) })"
      @update:page-size="value => router.push({ query: paginationQuery(1, value) })"
    />
  </div>

  <n-modal v-model:show="modal" preset="card" title="编辑账号调度" style="width:min(680px,calc(100vw - 32px))">
    <n-form label-placement="top">
      <div class="grid-2">
        <n-form-item label="内置渠道"><n-input :value="editing ? sourceName(editing.provider_id) : ''" disabled /></n-form-item>
        <n-form-item label="账号标签"><n-input v-model:value="form.label" /></n-form-item>
      </div>
      <div class="grid-stats account-form-grid">
        <n-form-item label="优先级"><n-input-number v-model:value="form.priority" :min="1" /></n-form-item>
        <n-form-item label="权重"><n-input-number v-model:value="form.weight" :min="1" /></n-form-item>
        <n-form-item label="最大并发"><n-input-number v-model:value="form.maxConcurrency" :min="1" /></n-form-item>
      </div>
      <n-form-item label="启用"><n-switch v-model:value="form.enabled" /></n-form-item>
      <n-space justify="end"><n-button @click="modal = false">取消</n-button><n-button type="primary" @click="save">保存</n-button></n-space>
    </n-form>
  </n-modal>
</template>

<style scoped>
.account-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(380px,1fr)); gap:18px; }
.pagination-row { justify-content:center; margin-top:22px; }
.account-form-grid { grid-template-columns:repeat(3,1fr); }
@media(max-width:820px) { .account-grid { grid-template-columns:1fr; } }
@media(max-width:520px) { .account-form-grid { grid-template-columns:1fr; } }
</style>
