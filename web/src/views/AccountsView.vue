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
interface ActivityBucket {
  day: number;
  requests: number;
  successes: number;
  failures: number;
  tokens: number;
}
interface HeatmapCell extends ActivityBucket {
  level: number;
  title: string;
}
interface CredentialPage {
  data: Credential[];
  quotas: QuotaSnapshot[];
  activity: Record<string, ActivityBucket[]>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

type AccountTagType = "success" | "error" | "warning" | "info" | "default";

const DAY_SECONDS = 24 * 60 * 60;
const HEATMAP_DAYS = 28;
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
const activity = ref<Record<string, ActivityBucket[]>>({});
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
function accountIdentity(row: Credential): string {
  const metadata = row.metadata ?? {};
  const value = metadata.email ?? metadata.name ?? metadata.username ?? metadata.user_id ?? metadata.userId;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function accountTitle(row: Credential): string {
  return accountIdentity(row) || row.label || sourceName(row.provider_id);
}
function secondaryLabel(row: Credential): string {
  const title = accountTitle(row).toLowerCase();
  return row.label.trim() && row.label.trim().toLowerCase() !== title ? row.label.trim() : "";
}
function authLabel(value: string): string {
  if (value.includes("oauth")) return "OAuth";
  if (value.includes("anonymous")) return "匿名";
  return "API Key";
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

  // Codex subscription windows are authoritative. A zero top-up credit balance or
  // one exhausted auxiliary window must not mark an otherwise usable account dead.
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
  if (row.last_error) return { text: "账号异常", type: "error" };
  const snapshot = quotaMap.value.get(row.id);
  const quota = quotaFor(row.id);
  if (snapshot?.status === "error") return { text: "额度刷新失败", type: "warning" };
  if (snapshot?.status === "ok" && quotaExhausted(row.provider_id, quota)) return { text: "额度耗尽", type: "error" };
  if (snapshot?.status === "unsupported") return { text: "额度未知", type: "warning" };
  return { text: "可用", type: "success" };
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
  if (!value) return "从未";
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function activityCells(credentialId: string): HeatmapCell[] {
  const rows = activity.value[credentialId] ?? [];
  const byDay = new Map(rows.map((row) => [row.day, row] as const));
  const today = Math.floor(Math.floor(Date.now() / 1000) / DAY_SECONDS) * DAY_SECONDS;
  const maxRequests = Math.max(0, ...rows.map((row) => row.requests));
  return Array.from({ length: HEATMAP_DAYS }, (_, index) => {
    const day = today - (HEATMAP_DAYS - 1 - index) * DAY_SECONDS;
    const row = byDay.get(day) ?? { day, requests: 0, successes: 0, failures: 0, tokens: 0 };
    const level = row.requests === 0 || maxRequests === 0
      ? 0
      : Math.max(1, Math.min(4, Math.ceil(Math.log1p(row.requests) / Math.log1p(maxRequests) * 4)));
    const date = new Date(day * 1000).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
    return {
      ...row,
      level,
      title: `${date} · ${row.requests} 次请求 · 成功 ${row.successes} · 失败 ${row.failures} · ${formatCompact(row.tokens)} Token`,
    };
  });
}
function activitySummary(credentialId: string): { requests: number; successes: number; failures: number; successRate: number } {
  const summary = (activity.value[credentialId] ?? []).reduce((result, row) => ({
    requests: result.requests + row.requests,
    successes: result.successes + row.successes,
    failures: result.failures + row.failures,
  }), { requests: 0, successes: 0, failures: 0 });
  return {
    ...summary,
    successRate: summary.requests > 0 ? summary.successes / summary.requests * 100 : 0,
  };
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
  <page-header title="账号池" description="集中查看账号健康、额度窗口和近 28 天调用活跃度。">
    <n-button type="primary" @click="router.push({ name: 'authorization' })"><template #icon><key-round /></template>发起授权</n-button>
    <n-button @click="router.push({ name: 'authorization', query: { import: '1' } })"><template #icon><file-json /></template>导入认证文件</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-spin :show="loading">
    <div v-if="credentials.length" class="account-grid">
      <n-card v-for="row in credentials" :key="row.id" class="account-card" size="small" :bordered="false">
        <div class="account-card__top">
          <div class="account-profile">
            <div class="provider-avatar"><provider-icon :provider-id="row.provider_id" :name="sourceName(row.provider_id)" :size="30" /></div>
            <div class="account-profile__copy">
              <div class="account-primary-row">
                <strong class="account-primary">{{ accountTitle(row) }}</strong>
                <n-tag size="small" :type="row.auth_type.includes('oauth') ? 'info' : 'default'">{{ authLabel(row.auth_type) }}</n-tag>
              </div>
              <div class="account-secondary">
                <span>{{ sourceName(row.provider_id) }}</span>
                <span v-if="secondaryLabel(row)">· {{ secondaryLabel(row) }}</span>
                <span class="mono">· {{ row.provider_id }}</span>
              </div>
            </div>
          </div>
          <div class="account-state">
            <n-tag size="small" round :type="accountState(row).type">{{ accountState(row).text }}</n-tag>
            <n-switch :value="row.enabled === 1" @update:value="value => toggleEnabled(row, value)" />
          </div>
        </div>

        <div class="account-stat-strip">
          <div class="account-stat"><span>套餐</span><strong>{{ planLabel(quotaFor(row.id).plan) }}</strong></div>
          <div class="account-stat"><span>优先级</span><strong>{{ row.priority }}</strong></div>
          <div class="account-stat"><span>权重 / 并发</span><strong>{{ row.weight }} / {{ row.max_concurrency }}</strong></div>
          <div class="account-stat"><span>最后调用</span><strong>{{ formatShortTime(row.last_used_at) }}</strong></div>
        </div>

        <section class="account-section quota-panel">
          <div class="section-heading">
            <strong>额度窗口</strong>
            <span class="muted">刷新于 {{ formatTime(quotaMap.get(row.id)?.fetched_at) }}</span>
          </div>
          <div v-if="quotaFor(row.id).windows.length" class="quota-grid">
            <div v-for="window in quotaFor(row.id).windows" :key="window.key" class="quota-item">
              <div class="quota-item__line">
                <span>{{ window.label }}</span>
                <strong>可用 {{ Math.round(quotaPercentage(window)) }}%</strong>
              </div>
              <n-progress type="line" :percentage="quotaPercentage(window)" :show-indicator="false" :height="7" :status="progressStatus(window)" />
              <div class="quota-item__meta muted">
                <span v-if="window.limit !== undefined || window.remaining !== undefined">{{ formatAmount(window.remaining) }} / {{ formatAmount(window.limit) }}</span>
                <span v-if="window.resetAt">{{ formatTime(window.resetAt) }} 重置</span>
              </div>
            </div>
          </div>
          <div v-else-if="quotaFor(row.id).credits" class="credit-balance">
            <span>可用余额</span>
            <strong>{{ quotaFor(row.id).credits?.unlimited ? "不限" : formatAmount(quotaFor(row.id).credits?.balance) }}</strong>
          </div>
          <n-empty v-else size="small" :description="quotaMap.get(row.id)?.error_message || '尚无可显示的额度数据'" />
        </section>

        <section class="account-section activity-panel">
          <div class="section-heading">
            <strong>近 28 天活跃度</strong>
            <span class="muted">
              {{ formatCompact(activitySummary(row.id).requests) }} 次
              <template v-if="activitySummary(row.id).requests">· 成功率 {{ Math.round(activitySummary(row.id).successRate) }}%</template>
            </span>
          </div>
          <div class="activity-row" aria-label="近 28 天账号请求热力图">
            <span
              v-for="cell in activityCells(row.id)"
              :key="cell.day"
              class="activity-cell"
              :class="[`activity-cell--${cell.level}`, { 'activity-cell--failure': cell.failures > 0 }]"
              :title="cell.title"
            />
          </div>
          <div class="activity-legend muted"><span>28 天前</span><span>请求越多颜色越深；橙色描边表示当天有失败</span><span>今天</span></div>
        </section>

        <n-alert v-if="row.last_error" type="error" :bordered="false" class="account-error">{{ row.last_error }}</n-alert>
        <n-alert v-else-if="quotaMap.get(row.id)?.error_message" type="warning" :bordered="false" class="account-error">{{ quotaMap.get(row.id)?.error_message }}</n-alert>

        <div class="account-actions">
          <n-button size="small" @click="refreshOne(row.id)"><template #icon><refresh-cw /></template>刷新</n-button>
          <n-button size="small" @click="downloadAuth(row)"><template #icon><download /></template>下载认证</n-button>
          <n-button size="small" @click="openEdit(row)">调度设置</n-button>
          <n-popconfirm @positive-click="remove(row.id)">
            <template #trigger><n-button size="small" type="error" secondary>删除</n-button></template>
            删除该授权账号、模型缓存和额度快照？
          </n-popconfirm>
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
.account-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 18px; align-items: stretch; }
.account-card { height: 100%; border: 1px solid var(--n-border-color); border-radius: 14px; box-shadow: 0 8px 26px rgba(15, 23, 42, .05); overflow: hidden; }
.account-card :deep(.n-card__content) { display: flex; flex-direction: column; height: 100%; padding: 18px; }
.account-card__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.account-profile { display: flex; align-items: center; gap: 12px; min-width: 0; }
.provider-avatar { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 42px; border-radius: 12px; background: var(--n-color-embedded); border: 1px solid var(--n-border-color); }
.account-profile__copy { min-width: 0; }
.account-primary-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.account-primary { max-width: min(42vw, 360px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.account-secondary { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; opacity: .62; }
.account-state { display: flex; align-items: center; gap: 10px; flex: none; }
.account-stat-strip { display: grid; grid-template-columns: 1.15fr .75fr 1fr 1.25fr; gap: 1px; margin-top: 16px; border: 1px solid var(--n-border-color); border-radius: 10px; overflow: hidden; background: var(--n-border-color); }
.account-stat { min-width: 0; padding: 10px 11px; background: var(--n-color); }
.account-stat span, .account-stat strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-stat span { margin-bottom: 3px; font-size: 11px; opacity: .58; }
.account-stat strong { font-size: 12px; font-weight: 600; }
.account-section { margin-top: 14px; padding: 13px; border: 1px solid var(--n-border-color); border-radius: 11px; background: var(--n-color-embedded); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 11px; font-size: 12px; }
.section-heading strong { font-size: 13px; }
.quota-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.quota-item { min-width: 0; }
.quota-item__line, .quota-item__meta, .credit-balance { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.quota-item__line { margin-bottom: 6px; font-size: 12px; }
.quota-item__line span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quota-item__line strong { flex: none; font-size: 12px; }
.quota-item__meta { margin-top: 5px; flex-wrap: wrap; font-size: 10px; }
.credit-balance { font-size: 13px; }
.activity-row { display: grid; grid-template-columns: repeat(28, minmax(5px, 1fr)); gap: 3px; }
.activity-cell { height: 11px; border-radius: 3px; background: rgba(148, 163, 184, .16); transition: transform .15s ease, filter .15s ease; }
.activity-cell:hover { transform: translateY(-2px) scale(1.08); filter: brightness(.95); }
.activity-cell--1 { background: #bbf7d0; }
.activity-cell--2 { background: #86efac; }
.activity-cell--3 { background: #4ade80; }
.activity-cell--4 { background: #16a34a; }
.activity-cell--failure { box-shadow: inset 0 0 0 1px #f97316; }
.activity-legend { display: flex; justify-content: space-between; gap: 10px; margin-top: 7px; font-size: 9px; }
.account-error { margin-top: 12px; }
.account-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 14px; }
.account-form-grid { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 1040px) {
  .account-grid { grid-template-columns: 1fr; }
  .account-primary { max-width: 60vw; }
}
@media (max-width: 720px) {
  .account-card__top { align-items: stretch; flex-direction: column; }
  .account-state { justify-content: space-between; }
  .account-stat-strip { grid-template-columns: repeat(2, 1fr); }
  .quota-grid { grid-template-columns: 1fr; }
  .account-primary { max-width: 68vw; }
  .account-form-grid { grid-template-columns: 1fr; }
  .activity-row { gap: 2px; }
  .activity-cell { height: 9px; }
  .activity-legend span:nth-child(2) { display: none; }
}
</style>
