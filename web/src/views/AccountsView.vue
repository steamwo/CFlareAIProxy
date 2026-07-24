<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NInputNumber, NModal,
  NPagination, NPopconfirm, NProgress, NSpace, NSpin, NSwitch, NTag, useMessage,
} from "naive-ui";
import { Download, FileJson, KeyRound, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProviderIcon from "../components/ProviderIcon.vue";
import { api, jsonBody } from "../api";
import type { Channel, Credential, QuotaSnapshot, QuotaWindow } from "../types";

interface ParsedQuota {
  plan?: string;
  windows: QuotaWindow[];
  credits?: { balance?: string | number; unlimited?: boolean; hasCredits?: boolean };
}
interface CredentialPage {
  data: Credential[];
  quotas: QuotaSnapshot[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const allowedPageSizes = [9, 18, 36];
const route = useRoute();
const router = useRouter();
const message = useMessage();
const queryInteger = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const sourceQuery = (): string => typeof route.query.source === "string" ? route.query.source : "";
const page = ref(queryInteger(route.query.page, 1));
const initialPageSize = queryInteger(route.query.pageSize, 9);
const pageSize = ref(allowedPageSizes.includes(initialPageSize) ? initialPageSize : 9);
const activeSource = ref(sourceQuery());

const credentials = ref<Credential[]>([]);
const channels = ref<Channel[]>([]);
const quotas = ref<QuotaSnapshot[]>([]);
const total = ref(0);
const loading = ref(false);
const modal = ref(false);
const editing = ref<Credential | null>(null);
const form = reactive({ label: "", enabled: true, priority: 100, weight: 1, maxConcurrency: 4 });

const sourceNames = computed(() => new Map(channels.value.map((channel) => [channel.id, channel.name] as const)));
const quotaMap = computed(() => new Map(quotas.value.map((quota) => [quota.credential_id, quota])));

function parseQuota(row?: QuotaSnapshot): ParsedQuota {
  if (row?.snapshot) return { plan: row.snapshot.plan, windows: row.snapshot.windows ?? [], credits: row.snapshot.credits };
  try {
    const parsed = JSON.parse(row?.quota_json || "{}") as Partial<ParsedQuota>;
    return { plan: parsed.plan, windows: Array.isArray(parsed.windows) ? parsed.windows : [], credits: parsed.credits };
  } catch { return { windows: [] }; }
}
function quotaFor(credentialId: string): ParsedQuota { return parseQuota(quotaMap.value.get(credentialId)); }
function sourceName(providerId: string): string { return sourceNames.value.get(providerId) ?? providerId; }
function accountIdentity(row: Credential): string {
  const metadata = row.metadata ?? {};
  const value = metadata.email ?? metadata.name ?? metadata.username ?? metadata.user_id ?? metadata.userId;
  return typeof value === "string" && value.trim() ? value : "";
}
function authLabel(value: string): string {
  if (value.includes("oauth")) return "OAuth";
  if (value.includes("anonymous")) return "匿名";
  return "API Key";
}
function quotaPercentage(window: QuotaWindow): number {
  // Defensive handling for old snapshots created before the backend 0/0 fix.
  if (window.limit === 0 && window.remaining === 0) return 0;
  if (typeof window.remainingPercent === "number") return Math.max(0, Math.min(100, window.remainingPercent));
  if (typeof window.usedPercent === "number") return Math.max(0, Math.min(100, 100 - window.usedPercent));
  if (typeof window.limit === "number" && window.limit > 0 && typeof window.remaining === "number") {
    return Math.max(0, Math.min(100, window.remaining / window.limit * 100));
  }
  return 0;
}
function progressStatus(window: QuotaWindow): "success" | "warning" | "error" | "default" {
  const remaining = quotaPercentage(window);
  if (remaining <= 10) return "error";
  if (remaining <= 30) return "warning";
  return "success";
}
function numericAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
function exhaustedWindow(window: QuotaWindow): boolean {
  if (window.limit === 0 && window.remaining === 0) return true;
  return (typeof window.remaining === "number" && window.remaining <= 0)
    || (typeof window.remainingPercent === "number" && window.remainingPercent <= 0)
    || (typeof window.usedPercent === "number" && window.usedPercent >= 100);
}
function quotaExhausted(providerId: string, quota: ParsedQuota): boolean {
  if (quota.credits?.unlimited) return false;
  const balance = numericAmount(quota.credits?.balance);
  if (quota.credits?.hasCredits === false || (balance !== undefined && balance <= 0)) return true;

  const measurable = quota.windows.filter((window) =>
    window.remaining !== undefined || window.remainingPercent !== undefined || window.usedPercent !== undefined,
  );
  if (!measurable.length) return false;
  if (providerId === "qoder") {
    const pools = measurable.filter((window) => window.key === "user" || window.key === "organization");
    return pools.length > 0 && pools.every(exhaustedWindow);
  }
  return measurable.some(exhaustedWindow);
}
function formatAmount(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  if (typeof value === "string" && value.trim()) return value;
  return "—";
}
function formatTime(value?: number | null): string {
  if (!value) return "—";
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
}
function quotaStatusText(status: string | undefined, providerId: string, quota: ParsedQuota): string {
  if (status === "ok" && quotaExhausted(providerId, quota)) return "额度耗尽";
  return ({ ok: "额度正常", error: "刷新失败", unsupported: "暂不支持", unknown: "等待刷新" } as Record<string, string>)[status ?? ""] ?? "未刷新";
}
function quotaStatusType(
  status: string | undefined,
  providerId: string,
  quota: ParsedQuota,
): "success" | "error" | "warning" | "default" {
  if (status === "ok") return quotaExhausted(providerId, quota) ? "error" : "success";
  if (status === "error") return "error";
  if (status === "unsupported") return "warning";
  return "default";
}
function paginationQuery(nextPage = page.value, nextPageSize = pageSize.value) {
  return { ...route.query, page: String(nextPage), pageSize: String(nextPageSize) };
}
async function changePage(value: number) {
  await router.push({ query: paginationQuery(value, pageSize.value) });
}
async function changePageSize(value: number) {
  await router.push({ query: paginationQuery(1, value) });
}
async function normalizePaginationQuery() {
  const currentPage = typeof route.query.page === "string" ? route.query.page : "";
  const currentPageSize = typeof route.query.pageSize === "string" ? route.query.pageSize : "";
  if (currentPage !== String(page.value) || currentPageSize !== String(pageSize.value)) {
    await router.replace({ query: paginationQuery() });
  }
}
async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
    if (activeSource.value) params.set("provider", activeSource.value);
    const [channelResult, accountResult] = await Promise.all([
      api<{ data: Channel[] }>("/channels"),
      api<CredentialPage>(`/credentials/paged?${params.toString()}`),
    ]);
    channels.value = channelResult.data;
    credentials.value = accountResult.data;
    quotas.value = accountResult.quotas;
    total.value = accountResult.total;
    page.value = accountResult.page;
    pageSize.value = accountResult.pageSize;
    await normalizePaginationQuery();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally { loading.value = false; }
}
function openEdit(row: Credential) {
  editing.value = row;
  Object.assign(form, { label: row.label, enabled: row.enabled === 1, priority: row.priority, weight: row.weight, maxConcurrency: row.max_concurrency });
  modal.value = true;
}
async function save() {
  if (!editing.value) return;
  try {
    await api(`/credentials/${editing.value.id}`, { method: "PATCH", body: jsonBody(form) });
    message.success("账号已更新");
    modal.value = false;
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function remove(id: string) {
  try {
    await api(`/credentials/${id}`, { method: "DELETE" });
    message.success("账号已删除");
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function toggleEnabled(row: Credential, enabled: boolean) {
  try {
    await api(`/credentials/${row.id}`, { method: "PATCH", body: jsonBody({ enabled }) });
    row.enabled = enabled ? 1 : 0;
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function refreshOne(id: string) {
  try {
    await Promise.all([
      api(`/models/refresh/credential/${id}`, { method: "POST" }),
      api(`/quotas/refresh/${id}`, { method: "POST" }),
    ]);
    message.success("模型与额度已刷新");
    await load();
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}
async function downloadAuth(row: Credential) {
  try {
    const payload = await api<Record<string, unknown>>(`/auth-files/${row.id}/export`);
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const label = row.label.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || row.provider_id;
    anchor.href = url;
    anchor.download = `${label}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    message.success("认证文件已下载，请妥善保管");
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
}

watch(
  () => [route.query.page, route.query.pageSize, route.query.source] as const,
  () => {
    const nextPage = queryInteger(route.query.page, 1);
    const requestedPageSize = queryInteger(route.query.pageSize, 9);
    const nextPageSize = allowedPageSizes.includes(requestedPageSize) ? requestedPageSize : 9;
    const nextSource = sourceQuery();
    const changed = nextPage !== page.value || nextPageSize !== pageSize.value || nextSource !== activeSource.value;
    page.value = nextPage;
    pageSize.value = nextPageSize;
    activeSource.value = nextSource;
    if (changed) void load();
  },
);
onMounted(load);
</script>

<template>
  <page-header title="账号池" description="只展示通过内置渠道 OAuth 或授权文件加入的账号；OpenAI-compatible 供应商 API Key 请在供应商配置中管理。">
    <n-button type="primary" @click="router.push({ name: 'authorization' })"><template #icon><key-round /></template>发起授权</n-button>
    <n-button @click="router.push({ name: 'authorization', query: { import: '1' } })"><template #icon><file-json /></template>导入认证文件</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-spin :show="loading">
    <div v-if="credentials.length" class="account-grid">
      <n-card v-for="row in credentials" :key="row.id" class="account-card" size="small">
        <template #header>
          <div class="account-card__heading">
            <div class="account-card__title-row">
              <provider-icon :provider-id="row.provider_id" :name="sourceName(row.provider_id)" :size="26" />
              <strong>{{ row.label }}</strong>
              <n-tag size="small" :type="row.auth_type.includes('oauth') ? 'info' : 'default'">{{ authLabel(row.auth_type) }}</n-tag>
            </div>
            <div class="account-card__source">{{ sourceName(row.provider_id) }} · <span class="mono">{{ row.provider_id }}</span></div>
          </div>
        </template>
        <template #header-extra><n-switch :value="row.enabled === 1" @update:value="value => toggleEnabled(row, value)" /></template>

        <div v-if="accountIdentity(row)" class="account-identity">{{ accountIdentity(row) }}</div>
        <div class="schedule-row"><n-tag size="small">优先级 {{ row.priority }}</n-tag><n-tag size="small">权重 {{ row.weight }}</n-tag><n-tag size="small">并发 {{ row.max_concurrency }}</n-tag></div>

        <div class="quota-section">
          <div class="quota-section__head">
            <div><strong>{{ quotaFor(row.id).plan || "当前额度" }}</strong><div class="muted quota-caption">刷新于 {{ formatTime(quotaMap.get(row.id)?.fetched_at) }}</div></div>
            <n-tag
              size="small"
              :type="quotaStatusType(quotaMap.get(row.id)?.status, row.provider_id, quotaFor(row.id))"
            >{{ quotaStatusText(quotaMap.get(row.id)?.status, row.provider_id, quotaFor(row.id)) }}</n-tag>
          </div>
          <div v-if="quotaFor(row.id).windows.length" class="quota-windows">
            <div v-for="window in quotaFor(row.id).windows" :key="window.key" class="quota-window">
              <div class="quota-window__line"><span>{{ window.label }}</span><strong>{{ Math.round(quotaPercentage(window)) }}%</strong></div>
              <n-progress type="line" :percentage="quotaPercentage(window)" :show-indicator="false" :height="8" :status="progressStatus(window)" />
              <div class="quota-window__details muted"><span v-if="window.limit !== undefined || window.remaining !== undefined">剩余 {{ formatAmount(window.remaining) }} / {{ formatAmount(window.limit) }}</span><span v-if="window.resetAt">重置 {{ formatTime(window.resetAt) }}</span></div>
            </div>
          </div>
          <div v-else-if="quotaFor(row.id).credits" class="credit-balance"><span>可用余额</span><strong>{{ quotaFor(row.id).credits?.unlimited ? "不限" : formatAmount(quotaFor(row.id).credits?.balance) }}</strong></div>
          <n-empty v-else size="small" :description="quotaMap.get(row.id)?.error_message || '尚无可显示的额度数据'" />
        </div>

        <n-alert v-if="row.last_error" type="error" :bordered="false" class="account-error">{{ row.last_error }}</n-alert>
        <n-alert v-else-if="quotaMap.get(row.id)?.error_message" type="warning" :bordered="false" class="account-error">{{ quotaMap.get(row.id)?.error_message }}</n-alert>
        <div class="account-actions">
          <n-button size="small" @click="refreshOne(row.id)"><template #icon><refresh-cw /></template>刷新模型与额度</n-button>
          <n-button size="small" @click="downloadAuth(row)"><template #icon><download /></template>下载认证文件</n-button>
          <n-button size="small" @click="openEdit(row)">编辑调度</n-button>
          <n-popconfirm @positive-click="remove(row.id)"><template #trigger><n-button size="small" type="error" secondary>删除</n-button></template>删除该授权账号、模型缓存和额度快照？</n-popconfirm>
        </div>
      </n-card>
    </div>
    <n-card v-else><n-empty description="账号池还是空的，请前往“授权”登录内置渠道或导入授权文件" /></n-card>
  </n-spin>
  <div v-if="total > 0" class="pagination-row">
    <n-pagination
      :page="page"
      :page-size="pageSize"
      :item-count="total"
      :page-sizes="allowedPageSizes"
      show-size-picker
      show-quick-jumper
      @update:page="changePage"
      @update:page-size="changePageSize"
    />
  </div>

  <n-modal v-model:show="modal" preset="card" title="编辑账号调度" style="width:min(680px,calc(100vw - 32px))">
    <n-form label-placement="top">
      <div class="grid-2">
        <n-form-item label="内置渠道"><n-input :value="editing ? sourceName(editing.provider_id) : ''" disabled /></n-form-item>
        <n-form-item label="账号标签"><n-input v-model:value="form.label" placeholder="例如 工作账号 / 组织账号" /></n-form-item>
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
.account-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; align-items: stretch; }
.account-card { height: 100%; }
.account-card__heading { min-width: 0; }
.account-card__title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.account-card__title-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-card__source { margin-top: 4px; margin-left: 34px; font-size: 12px; opacity: .62; }
.account-identity { margin-bottom: 12px; padding: 9px 11px; border-radius: 8px; background: var(--n-color-embedded); font-size: 13px; overflow-wrap: anywhere; }
.schedule-row { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
.quota-section { padding: 13px; border: 1px solid var(--n-border-color); border-radius: 10px; background: var(--n-color-embedded); }
.quota-section__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.quota-caption { margin-top: 3px; font-size: 11px; }
.quota-windows { display: grid; gap: 13px; }
.quota-window__line, .quota-window__details, .credit-balance { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.quota-window__line { margin-bottom: 6px; font-size: 13px; }
.quota-window__details { margin-top: 5px; flex-wrap: wrap; font-size: 11px; }
.credit-balance { font-size: 14px; }
.account-error { margin-top: 12px; }
.account-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.account-form-grid { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 720px) { .account-grid { grid-template-columns: 1fr; } .account-form-grid { grid-template-columns: 1fr; } }
</style>
