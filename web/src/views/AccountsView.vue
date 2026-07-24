<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NInputNumber, NModal,
  NPagination, NPopconfirm, NProgress, NSpace, NSpin, NSwitch, NTag, useMessage,
} from "naive-ui";
import { Download, FileJson, KeyRound, RefreshCw, Settings, Trash2 } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api, jsonBody } from "../api";
import type { Channel, Credential, QuotaSnapshot, QuotaWindow } from "../types";

interface ParsedQuota {
  plan?: string;
  windows: QuotaWindow[];
  credits?: { balance?: string | number; unlimited?: boolean; hasCredits?: boolean };
}
interface ActivityBucket {
  bucket: number;
  requests: number;
  successes: number;
  failures: number;
  tokens: number;
}
interface ActivityTotals {
  requests: number;
  successes: number;
  failures: number;
}
interface ActivityRecord {
  buckets: ActivityBucket[];
  totals: ActivityTotals;
}
interface StatusCell extends ActivityBucket {
  level: number;
  status: "idle" | "success" | "mixed" | "failure";
  title: string;
}
interface CredentialPage {
  data: Credential[];
  quotas: QuotaSnapshot[];
  activity: Record<string, ActivityRecord>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

type AccountTagType = "success" | "error" | "warning" | "info" | "default";

const ACTIVITY_BUCKET_SECONDS = 5 * 60;
const ACTIVITY_BUCKET_COUNT = 24;
const allowedPageSizes = [6, 12, 24];
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
const initialPageSize = queryInteger(route.query.pageSize, 6);
const pageSize = ref(allowedPageSizes.includes(initialPageSize) ? initialPageSize : 6);
const activeSource = ref(sourceQuery());

const credentials = ref<Credential[]>([]);
const channels = ref<Channel[]>([]);
const quotas = ref<QuotaSnapshot[]>([]);
const activity = ref<Record<string, ActivityRecord>>({});
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
  } catch {
    return { windows: [] };
  }
}
function quotaFor(credentialId: string): ParsedQuota {
  return parseQuota(quotaMap.value.get(credentialId));
}
function sourceName(providerId: string): string {
  return sourceNames.value.get(providerId) ?? providerId;
}
function providerLabel(providerId: string): string {
  return ({ codex: "Codex", qoder: "Qoder", kimi: "Kimi" } as Record<string, string>)[providerId]
    ?? sourceName(providerId);
}
function accountIdentity(row: Credential): string {
  const metadata = row.metadata ?? {};
  const value = metadata.email ?? metadata.name ?? metadata.username ?? metadata.user_id ?? metadata.userId;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function accountTitle(row: Credential): string {
  return accountIdentity(row) || row.label || providerLabel(row.provider_id);
}
function planLabel(value?: string): string {
  if (!value) return "未识别";
  return value.length <= 12 ? value.replace(/^./, (letter) => letter.toUpperCase()) : value;
}
function quotaPercentage(window: QuotaWindow): number {
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
function measurableWindows(quota: ParsedQuota): QuotaWindow[] {
  return quota.windows.filter((window) =>
    window.remaining !== undefined || window.remainingPercent !== undefined || window.usedPercent !== undefined,
  );
}
function quotaExhausted(providerId: string, quota: ParsedQuota): boolean {
  if (quota.credits?.unlimited) return false;
  const measurable = measurableWindows(quota);
  if (providerId === "codex" && measurable.length) {
    const core = measurable.filter((window) => window.key === "primary" || window.key === "secondary");
    const target = core.length ? core : measurable.filter((window) => !window.key.startsWith("additional_"));
    return target.length > 0 && target.every(exhaustedWindow);
  }
  if (providerId === "qoder" && measurable.length) {
    const pools = measurable.filter((window) => window.key === "user" || window.key === "organization");
    return pools.length > 0 && pools.every(exhaustedWindow);
  }
  if (measurable.length) return measurable.every(exhaustedWindow);
  const balance = numericAmount(quota.credits?.balance);
  return quota.credits?.hasCredits === false || (balance !== undefined && balance <= 0);
}
function accountState(row: Credential): { text: string; type: AccountTagType } {
  if (row.enabled !== 1) return { text: "已停用", type: "default" };
  const snapshot = quotaMap.value.get(row.id);
  const quota = quotaFor(row.id);
  if (snapshot?.status === "ok" && quotaExhausted(row.provider_id, quota)) return { text: "额度耗尽", type: "error" };
  if (row.last_error || snapshot?.status === "error") return { text: "警告", type: "warning" };
  if (snapshot?.status === "unsupported") return { text: "额度未知", type: "warning" };
  return { text: "启用", type: "success" };
}
function accountWarning(row: Credential): string {
  return row.last_error || quotaMap.value.get(row.id)?.error_message || "";
}
function formatAmount(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  if (typeof value === "string" && value.trim()) return value;
  return "—";
}
function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function formatTime(value?: number | null): string {
  if (!value) return "—";
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
}
function formatShortTime(value?: number | null): string {
  if (!value) return "从未调用";
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function activityRecord(credentialId: string): ActivityRecord {
  return activity.value[credentialId] ?? {
    buckets: [],
    totals: { requests: 0, successes: 0, failures: 0 },
  };
}
function activityCells(credentialId: string): StatusCell[] {
  const rows = activityRecord(credentialId).buckets;
  const byBucket = new Map(rows.map((row) => [row.bucket, row] as const));
  const currentBucket = Math.floor(Math.floor(Date.now() / 1000) / ACTIVITY_BUCKET_SECONDS) * ACTIVITY_BUCKET_SECONDS;
  const maxRequests = Math.max(0, ...rows.map((row) => row.requests));
  return Array.from({ length: ACTIVITY_BUCKET_COUNT }, (_, index) => {
    const bucket = currentBucket - (ACTIVITY_BUCKET_COUNT - 1 - index) * ACTIVITY_BUCKET_SECONDS;
    const row = byBucket.get(bucket) ?? { bucket, requests: 0, successes: 0, failures: 0, tokens: 0 };
    const level = row.requests === 0 || maxRequests === 0
      ? 0
      : Math.max(1, Math.min(4, Math.ceil(Math.log1p(row.requests) / Math.log1p(maxRequests) * 4)));
    const status = row.requests === 0
      ? "idle"
      : row.failures === 0
        ? "success"
        : row.successes === 0
          ? "failure"
          : "mixed";
    const from = new Date(bucket * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const to = new Date((bucket + ACTIVITY_BUCKET_SECONDS) * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      ...row,
      level,
      status,
      title: `${from}–${to} · 请求 ${row.requests} · 成功 ${row.successes} · 失败 ${row.failures}`,
    };
  });
}
function recentSummary(credentialId: string): ActivityTotals & { successRate: number } {
  const summary = activityRecord(credentialId).buckets.reduce((result, row) => ({
    requests: result.requests + row.requests,
    successes: result.successes + row.successes,
    failures: result.failures + row.failures,
  }), { requests: 0, successes: 0, failures: 0 });
  return {
    ...summary,
    successRate: summary.requests > 0 ? summary.successes / summary.requests * 100 : 0,
  };
}
function successRateClass(credentialId: string): string {
  const summary = recentSummary(credentialId);
  if (!summary.requests) return "status-rate--empty";
  if (summary.successRate >= 95) return "status-rate--high";
  if (summary.successRate >= 80) return "status-rate--medium";
  return "status-rate--low";
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
    activity.value = accountResult.activity ?? {};
    total.value = accountResult.total;
    page.value = accountResult.page;
    pageSize.value = accountResult.pageSize;
    await normalizePaginationQuery();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}
function openEdit(row: Credential) {
  editing.value = row;
  Object.assign(form, {
    label: row.label,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    maxConcurrency: row.max_concurrency,
  });
  modal.value = true;
}
async function save() {
  if (!editing.value) return;
  try {
    await api(`/credentials/${editing.value.id}`, { method: "PATCH", body: jsonBody(form) });
    message.success("账号已更新");
    modal.value = false;
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function remove(id: string) {
  try {
    await api(`/credentials/${id}`, { method: "DELETE" });
    message.success("账号已删除");
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function toggleEnabled(row: Credential, enabled: boolean) {
  try {
    await api(`/credentials/${row.id}`, { method: "PATCH", body: jsonBody({ enabled }) });
    row.enabled = enabled ? 1 : 0;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function refreshOne(id: string) {
  try {
    await Promise.all([
      api(`/models/refresh/credential/${id}`, { method: "POST" }),
      api(`/quotas/refresh/${id}`, { method: "POST" }),
    ]);
    message.success("模型与额度已刷新");
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
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
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}

watch(
  () => [route.query.page, route.query.pageSize, route.query.source] as const,
  () => {
    const nextPage = queryInteger(route.query.page, 1);
    const requestedPageSize = queryInteger(route.query.pageSize, 6);
    const nextPageSize = allowedPageSizes.includes(requestedPageSize) ? requestedPageSize : 6;
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
  <page-header title="账号池" description="集中查看账号状态、累计调用、近 2 小时健康度和额度窗口。">
    <n-button type="primary" @click="router.push({ name: 'authorization' })"><template #icon><key-round /></template>发起授权</n-button>
    <n-button @click="router.push({ name: 'authorization', query: { import: '1' } })"><template #icon><file-json /></template>导入认证文件</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-spin :show="loading">
    <div v-if="credentials.length" class="account-grid">
      <n-card
        v-for="row in credentials"
        :key="row.id"
        class="account-card"
        :class="`account-card--${row.provider_id}`"
        size="small"
        :bordered="false"
      >
        <div class="card-header">
          <div class="badge-row">
            <n-tag size="small" type="info">{{ providerLabel(row.provider_id) }}</n-tag>
            <n-tag size="small" :type="accountState(row).type">{{ accountState(row).text }}</n-tag>
          </div>
          <strong class="account-name" :title="accountTitle(row)">{{ accountTitle(row) }}</strong>
          <div class="account-meta muted">
            <span>优先级 {{ row.priority }}</span>
            <span>权重 {{ row.weight }}</span>
            <span>并发 {{ row.max_concurrency }}</span>
            <span>最近调用 {{ formatShortTime(row.last_used_at) }}</span>
          </div>
        </div>

        <n-alert
          v-if="accountWarning(row)"
          type="warning"
          :bordered="false"
          class="account-warning"
        >{{ accountWarning(row) }}</n-alert>

        <div class="card-insights">
          <div class="usage-stats">
            <span class="stat-pill stat-pill--success">成功 <strong>{{ formatCompact(activityRecord(row.id).totals.successes) }}</strong></span>
            <span class="stat-pill stat-pill--failure">失败 <strong>{{ formatCompact(activityRecord(row.id).totals.failures) }}</strong></span>
          </div>

          <div class="health-panel">
            <div class="health-label">近 2 小时健康状态</div>
            <div class="health-row">
              <div class="status-blocks" aria-label="近两小时账号请求状态">
                <span
                  v-for="cell in activityCells(row.id)"
                  :key="cell.bucket"
                  class="status-block"
                  :class="[`status-block--${cell.status}`, `status-block--level-${cell.level}`]"
                  :title="cell.title"
                />
              </div>
              <span class="status-rate" :class="successRateClass(row.id)">
                {{ recentSummary(row.id).requests ? `${Math.round(recentSummary(row.id).successRate)}%` : "--" }}
              </span>
            </div>
            <div class="health-caption muted">
              {{ recentSummary(row.id).requests }} 次请求 · 成功 {{ recentSummary(row.id).successes }} · 失败 {{ recentSummary(row.id).failures }}
            </div>
          </div>
        </div>

        <div class="quota-section">
          <div class="quota-plan-row">
            <span>套餐 <strong>{{ planLabel(quotaFor(row.id).plan) }}</strong></span>
            <span class="muted">刷新 {{ formatTime(quotaMap.get(row.id)?.fetched_at) }}</span>
          </div>
          <div v-if="quotaFor(row.id).windows.length" class="quota-list">
            <div v-for="window in quotaFor(row.id).windows" :key="window.key" class="quota-row">
              <div class="quota-row__header">
                <span>{{ window.label }}</span>
                <span><strong>{{ Math.round(quotaPercentage(window)) }}%</strong><span v-if="window.resetAt" class="muted"> · {{ formatShortTime(window.resetAt) }}</span></span>
              </div>
              <n-progress type="line" :percentage="quotaPercentage(window)" :show-indicator="false" :height="7" :status="progressStatus(window)" />
              <div v-if="window.limit !== undefined || window.remaining !== undefined" class="quota-row__amount muted">
                剩余 {{ formatAmount(window.remaining) }} / {{ formatAmount(window.limit) }}
              </div>
            </div>
          </div>
          <div v-else-if="quotaFor(row.id).credits" class="credit-balance">
            <span>可用余额</span>
            <strong>{{ quotaFor(row.id).credits?.unlimited ? "不限" : formatAmount(quotaFor(row.id).credits?.balance) }}</strong>
          </div>
          <button v-else type="button" class="quota-refresh-link" @click="refreshOne(row.id)">点击刷新额度</button>
        </div>

        <div class="card-actions">
          <div class="action-buttons">
            <n-button circle size="small" title="刷新模型与额度" @click="refreshOne(row.id)"><template #icon><refresh-cw /></template></n-button>
            <n-button circle size="small" title="下载认证文件" @click="downloadAuth(row)"><template #icon><download /></template></n-button>
            <n-button circle size="small" title="调度设置" @click="openEdit(row)"><template #icon><settings /></template></n-button>
            <n-popconfirm @positive-click="remove(row.id)">
              <template #trigger><n-button circle size="small" type="error" title="删除账号"><template #icon><trash-2 /></template></n-button></template>
              删除该授权账号、模型缓存和额度快照？
            </n-popconfirm>
          </div>
          <div class="status-toggle">
            <span class="muted">启用</span>
            <n-switch :value="row.enabled === 1" @update:value="value => toggleEnabled(row, value)" />
          </div>
        </div>
      </n-card>
    </div>
    <n-card v-else><n-empty description="账号池还是空的，请前往“授权”登录内置渠道或导入认证文件" /></n-card>
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
.account-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; align-items: stretch; }
.account-card { height: 100%; border: 1px solid var(--n-border-color); border-radius: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, .045); overflow: hidden; background: var(--n-color); }
.account-card--codex { background-image: linear-gradient(180deg, rgba(124, 101, 255, .045), transparent 120px); }
.account-card--qoder { background-image: linear-gradient(180deg, rgba(34, 197, 94, .035), transparent 120px); }
.account-card--kimi { background-image: linear-gradient(180deg, rgba(59, 130, 246, .035), transparent 120px); }
.account-card :deep(.n-card__content) { display: flex; flex-direction: column; min-height: 100%; padding: 16px; }
.card-header { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.badge-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.account-name { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 800; line-height: 1.45; }
.account-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 13px; font-size: 11px; }
.account-warning { margin-top: 10px; border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent); border-radius: 10px; font-size: 11px; }
.account-warning :deep(.n-alert-body__content) { max-height: 66px; overflow: auto; overflow-wrap: anywhere; }
.card-insights { display: flex; flex-direction: column; gap: 9px; margin-top: 11px; }
.usage-stats { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.stat-pill { display: inline-flex; align-items: baseline; gap: 5px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.stat-pill strong { font-size: 13px; font-variant-numeric: tabular-nums; }
.stat-pill--success { color: #15803d; background: rgba(34, 197, 94, .10); }
.stat-pill--failure { color: #dc2626; background: rgba(239, 68, 68, .08); }
.health-panel { display: flex; flex-direction: column; gap: 5px; }
.health-label { font-size: 10px; color: var(--n-text-color-3); }
.health-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.status-blocks { display: flex; align-items: center; gap: 3px; min-width: 0; }
.status-block { flex: 1 1 0; min-width: 4px; height: 6px; border-radius: 999px; background: rgba(148, 163, 184, .22); transition: transform .14s ease, opacity .14s ease; }
.status-block:hover { transform: scaleY(1.7); opacity: .88; }
.status-block--success.status-block--level-1 { background: rgba(34, 197, 94, .32); }
.status-block--success.status-block--level-2 { background: rgba(34, 197, 94, .50); }
.status-block--success.status-block--level-3 { background: rgba(34, 197, 94, .70); }
.status-block--success.status-block--level-4 { background: rgba(22, 163, 74, .92); }
.status-block--mixed.status-block--level-1 { background: rgba(245, 158, 11, .34); }
.status-block--mixed.status-block--level-2 { background: rgba(245, 158, 11, .52); }
.status-block--mixed.status-block--level-3 { background: rgba(245, 158, 11, .72); }
.status-block--mixed.status-block--level-4 { background: rgba(217, 119, 6, .94); }
.status-block--failure.status-block--level-1 { background: rgba(239, 68, 68, .34); }
.status-block--failure.status-block--level-2 { background: rgba(239, 68, 68, .52); }
.status-block--failure.status-block--level-3 { background: rgba(239, 68, 68, .72); }
.status-block--failure.status-block--level-4 { background: rgba(220, 38, 38, .94); }
.status-rate { display: inline-flex; align-items: center; justify-content: center; min-width: 54px; padding: 6px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.status-rate--empty { color: var(--n-text-color-3); background: var(--n-color-embedded); }
.status-rate--high { color: #15803d; background: rgba(34, 197, 94, .12); }
.status-rate--medium { color: #b45309; background: rgba(245, 158, 11, .13); }
.status-rate--low { color: #dc2626; background: rgba(239, 68, 68, .10); }
.health-caption { font-size: 10px; }
.quota-section { display: flex; flex-direction: column; gap: 10px; margin-top: 13px; padding-top: 12px; border-top: 1px dashed var(--n-border-color); }
.quota-plan-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 11px; }
.quota-plan-row strong { text-transform: capitalize; }
.quota-list { display: flex; flex-direction: column; gap: 10px; }
.quota-row { display: flex; flex-direction: column; gap: 5px; }
.quota-row__header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; font-size: 12px; }
.quota-row__header > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quota-row__header > span:last-child { flex: none; font-size: 11px; }
.quota-row__amount { font-size: 10px; }
.credit-balance { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.quota-refresh-link { width: 100%; padding: 8px; border: 0; background: transparent; color: var(--n-text-color-3); font-size: 11px; text-decoration: underline; cursor: pointer; }
.quota-refresh-link:hover { color: var(--n-text-color); }
.card-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--n-border-color); }
.action-buttons { display: flex; align-items: center; gap: 6px; }
.status-toggle { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.account-form-grid { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 820px) {
  .account-grid { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .account-meta span:last-child { flex-basis: 100%; }
  .health-row { grid-template-columns: 1fr; }
  .status-rate { justify-self: start; }
  .status-blocks { gap: 2px; }
  .card-actions { align-items: flex-end; }
  .account-form-grid { grid-template-columns: 1fr; }
}
</style>
