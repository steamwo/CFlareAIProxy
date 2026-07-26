<script setup lang="ts">
import { computed } from "vue";
import { NButton, NCard, NProgress, NSpace, NSwitch, NTag } from "naive-ui";
import { Activity, AlertTriangle, Clock, Download, Gauge, RefreshCw, Settings, Sparkles } from "@lucide/vue";
import ProviderIcon from "./ProviderIcon.vue";
import ConfirmDeleteButton from "./ConfirmDeleteButton.vue";
import { summarizeAccountError } from "../utils/account-error";
import { formatTokens } from "../utils/format";
import {
  accountState, parseQuota, quotaPercentage, quotaProgressStyle, type ParsedQuota,
} from "../utils/account-quota";
import {
  activityCellLabel, activityCells, activitySummary, emptyActivityRecord, successRateClass,
  type ActivityRecord,
} from "../utils/account-activity";
import type { Credential, QuotaSnapshot } from "../types";

const props = defineProps<{
  row: Credential;
  quota?: QuotaSnapshot;
  activity?: ActivityRecord;
  providerLabel: string;
  /** Injected so the card stays pure and tests can pin the clock. */
  nowMs: number;
}>();

const emit = defineEmits<{
  refresh: [id: string];
  download: [row: Credential];
  edit: [row: Credential];
  remove: [id: string];
  toggle: [row: Credential, enabled: boolean];
}>();

const parsedQuota = computed<ParsedQuota>(() => parseQuota(props.quota));
const record = computed<ActivityRecord>(() => props.activity ?? emptyActivityRecord());
const summary = computed(() => activitySummary(record.value));
const cells = computed(() => activityCells(record.value, props.nowMs));
const state = computed(() => accountState(props.row, props.quota));
const warning = computed(() => props.row.last_error || props.quota?.error_message || "");
const issue = computed(() => summarizeAccountError(warning.value));

const title = computed(() => {
  const metadata = props.row.metadata ?? {};
  const value = metadata.email ?? metadata.name ?? metadata.username ?? metadata.user_id ?? metadata.userId;
  return typeof value === "string" && value.trim() ? value.trim() : props.row.label || props.providerLabel;
});

const planLabel = computed(() => {
  const value = parsedQuota.value.plan;
  if (!value) return "未识别";
  return value.length <= 12 ? value.replace(/^./, (letter) => letter.toUpperCase()) : value;
});

const formatAmount = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) return formatTokens(value);
  return typeof value === "string" && value.trim() ? value : "—";
};

function formatTime(value?: number | null, short = false): string {
  if (!value) return short ? "从未调用" : "—";
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return short
    ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleString("zh-CN", { hour12: false });
}

const cellLabel = (cell: (typeof cells.value)[number]): string =>
  `${activityCellLabel(cell, formatTime(cell.bucket))} · ${formatTokens(cell.tokens)} Token`;
</script>

<template>
  <n-card
    class="account-card"
    :class="[`account-card--${row.provider_id}`, { 'account-card--disabled': row.enabled !== 1 }]"
    :bordered="false"
    role="listitem"
    :aria-label="`账号 ${title}（${providerLabel}）· ${state.text}`"
  >
    <div class="card-header">
      <provider-icon :provider-id="row.provider_id" :name="providerLabel" :size="40" />
      <div class="header-text">
        <strong :title="title">{{ title }}</strong>
        <div class="badge-row">
          <n-tag size="small" :bordered="false" round type="info">{{ providerLabel }}</n-tag>
          <n-tag size="small" :bordered="false" round :type="state.type">{{ state.text }}</n-tag>
        </div>
      </div>
    </div>

    <div class="meta-row">
      <span>优先级 <b>{{ row.priority }}</b></span>
      <span>权重 <b>{{ row.weight }}</b></span>
      <span>并发 <b>{{ row.max_concurrency }}</b></span>
      <span class="meta-time" :aria-label="`最近调用 ${formatTime(row.last_used_at, true)}`">
        <clock :size="12" aria-hidden="true" />{{ formatTime(row.last_used_at, true) }}
      </span>
    </div>

    <div v-if="issue" class="account-issue" :class="`account-issue--${issue.tone}`" role="status">
      <alert-triangle :size="16" aria-hidden="true" />
      <div class="account-issue__copy">
        <strong>{{ issue.label }}</strong>
        <span>{{ issue.hint }}</span>
      </div>
      <n-tag size="small" :bordered="false" :type="issue.tone === 'error' ? 'error' : 'warning'">
        {{ issue.code }}
      </n-tag>
    </div>

    <section class="panel">
      <div class="panel-title"><activity :size="13" aria-hidden="true" />近 2 小时健康状态</div>
      <div class="usage-stats">
        <span class="stat-pill stat-pill--success">成功 <b>{{ formatTokens(summary.successes) }}</b></span>
        <span class="stat-pill stat-pill--failure">失败 <b>{{ formatTokens(summary.failures) }}</b></span>
        <span
          class="status-rate"
          :class="successRateClass(summary)"
          :aria-label="summary.requests ? `成功率 ${Math.round(summary.successRate)}%` : '暂无成功率数据'"
        >{{ summary.requests ? `${Math.round(summary.successRate)}%` : '--' }}</span>
      </div>
      <div class="status-blocks" role="img" :aria-label="`近 2 小时调用趋势，共 ${summary.requests} 次请求`">
        <span
          v-for="cell in cells"
          :key="cell.bucket"
          class="status-block"
          :class="[`status-block--${cell.status}`, `level-${cell.level}`]"
          :title="cellLabel(cell)"
        />
      </div>
      <div class="caption">近 2 小时共 {{ formatTokens(summary.requests) }} 次请求</div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><gauge :size="13" aria-hidden="true" />额度 · {{ planLabel }}</div>
        <span class="caption">刷新于 {{ formatTime(quota?.fetched_at) }}</span>
      </div>
      <div v-if="parsedQuota.windows.length" class="quota-list">
        <div v-for="window in parsedQuota.windows" :key="window.key" class="quota-row" :style="quotaProgressStyle(window)">
          <div class="quota-head"><span>{{ window.label }}</span><b>{{ Math.round(quotaPercentage(window)) }}%</b></div>
          <n-progress
            type="line"
            :percentage="quotaPercentage(window)"
            :show-indicator="false"
            :height="8"
            :border-radius="4"
            :aria-label="`${window.label} 剩余 ${Math.round(quotaPercentage(window))}%`"
          />
          <div class="caption">剩余 {{ formatAmount(window.remaining) }} / {{ formatAmount(window.limit) }}</div>
        </div>
      </div>
      <div v-else-if="parsedQuota.credits" class="credit">
        <span><sparkles :size="13" aria-hidden="true" />可用余额</span>
        <b>{{ parsedQuota.credits.unlimited ? '不限' : formatAmount(parsedQuota.credits.balance) }}</b>
      </div>
      <button v-else type="button" class="quota-refresh" @click="emit('refresh', row.id)">
        <refresh-cw :size="13" aria-hidden="true" />点击刷新额度
      </button>
    </section>

    <div class="card-actions">
      <n-space>
        <n-button quaternary circle size="small" title="刷新模型与额度" aria-label="刷新模型与额度" @click="emit('refresh', row.id)">
          <refresh-cw :size="15" />
        </n-button>
        <n-button quaternary circle size="small" title="下载认证文件" aria-label="下载认证文件" @click="emit('download', row)">
          <download :size="15" />
        </n-button>
        <n-button quaternary circle size="small" title="调度设置" aria-label="调度设置" @click="emit('edit', row)">
          <settings :size="15" />
        </n-button>
        <confirm-delete-button
          label=""
          aria-label="删除账号"
          content="删除该授权账号、模型缓存和额度快照？"
          @confirm="emit('remove', row.id)"
        />
      </n-space>
      <div class="toggle">
        <span :id="`account-toggle-${row.id}`">启用</span>
        <n-switch
          :value="row.enabled === 1"
          :aria-labelledby="`account-toggle-${row.id}`"
          @update:value="value => emit('toggle', row, value)"
        />
      </div>
    </div>
  </n-card>
</template>

<style scoped>
.account-card { height:100%; border:1px solid var(--n-border-color); border-radius:16px; background:linear-gradient(180deg,rgba(148,163,184,.045),transparent 140px),var(--n-color); box-shadow:0 10px 28px rgba(15,23,42,.045); transition:transform .18s ease,box-shadow .18s ease; }
.account-card:hover { transform:translateY(-2px); box-shadow:0 18px 34px rgba(15,23,42,.075); }
.account-card--disabled { opacity:.68; filter:grayscale(.25); }
.account-card--codex { background:linear-gradient(180deg,rgba(124,101,255,.055),transparent 140px),var(--n-color); }
.account-card--qoder { background:linear-gradient(180deg,rgba(34,197,94,.05),transparent 140px),var(--n-color); }
.account-card--kimi { background:linear-gradient(180deg,rgba(59,130,246,.05),transparent 140px),var(--n-color); }
.account-card :deep(.n-card__content) { display:flex; flex-direction:column; min-height:100%; padding:18px; }
.card-header { display:flex; align-items:center; gap:12px; }
.header-text { min-width:0; display:flex; flex-direction:column; gap:6px; }
.header-text>strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:650; }
.badge-row,.meta-row,.usage-stats,.panel-title,.panel-head,.credit,.toggle { display:flex; align-items:center; }
.badge-row { gap:6px; }
.meta-row { flex-wrap:wrap; gap:10px; margin-top:12px; padding-top:12px; border-top:1px solid var(--n-border-color); font-size:11px; color:var(--n-text-color-3); }
.meta-row b { color:var(--n-text-color-1); }
.meta-time { display:inline-flex; align-items:center; gap:4px; margin-left:auto; }
.account-issue { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:10px; min-height:54px; margin-top:12px; padding:10px 11px; border:1px solid rgba(245,158,11,.22); border-radius:11px; background:rgba(245,158,11,.07); color:#b45309; }
.account-issue--error { border-color:rgba(239,68,68,.2); background:rgba(239,68,68,.065); color:#dc2626; }
.account-issue__copy { min-width:0; display:flex; flex-direction:column; gap:2px; }
.account-issue__copy strong { color:var(--n-text-color-1); font-size:11px; }
.account-issue__copy span { overflow:hidden; color:var(--n-text-color-3); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.panel { margin-top:14px; padding-top:13px; border-top:1px dashed var(--n-border-color); }
.panel-title { gap:5px; font-size:11px; font-weight:700; }
.panel-head { justify-content:space-between; gap:8px; margin-bottom:9px; }
.usage-stats { gap:7px; margin:8px 0; }
.stat-pill { padding:4px 9px; border-radius:999px; font-size:11px; }
.stat-pill--success { color:#15803d; background:rgba(34,197,94,.1); }
.stat-pill--failure { color:#dc2626; background:rgba(239,68,68,.08); }
.status-rate { margin-left:auto; padding:5px 9px; border-radius:999px; font-size:11px; font-weight:700; }
.status-rate--empty { background:var(--n-color-embedded); }
.status-rate--high { color:#15803d; background:rgba(34,197,94,.12); }
.status-rate--medium { color:#b45309; background:rgba(245,158,11,.13); }
.status-rate--low { color:#dc2626; background:rgba(239,68,68,.1); }
.status-blocks { display:flex; gap:3px; }
.status-block { flex:1; height:7px; border-radius:999px; background:rgba(148,163,184,.2); }
.status-block--success.level-1 { background:rgba(34,197,94,.32); }
.status-block--success.level-2 { background:rgba(34,197,94,.5); }
.status-block--success.level-3 { background:rgba(34,197,94,.7); }
.status-block--success.level-4 { background:#16a34a; }
.status-block--mixed { background:#f59e0b; }
.status-block--failure { background:#dc2626; }
.caption { margin-top:6px; color:var(--n-text-color-3); font-size:10px; }
.quota-list { display:flex; flex-direction:column; gap:12px; }
.quota-row { display:flex; flex-direction:column; gap:5px; }
.quota-row :deep(.n-progress-graph-line-fill) { background:var(--quota-gradient)!important; box-shadow:0 0 8px color-mix(in srgb,var(--quota-color) 24%,transparent); }
.quota-head { display:flex; justify-content:space-between; font-size:12px; }
.credit { justify-content:space-between; padding:10px 12px; border-radius:10px; background:var(--n-color-embedded); font-size:12px; }
.credit span { display:flex; align-items:center; gap:6px; }
.quota-refresh { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; padding:9px; border:1px dashed var(--n-border-color); border-radius:10px; background:transparent; color:var(--n-text-color-3); cursor:pointer; }
.card-actions { display:flex; align-items:center; justify-content:space-between; margin-top:auto; padding-top:15px; border-top:1px solid var(--n-border-color); }
.toggle { gap:8px; font-size:11px; color:var(--n-text-color-3); }
@media(max-width:520px) { .meta-time { margin-left:0; flex-basis:100%; } .account-issue { grid-template-columns:auto minmax(0,1fr); } .account-issue>.n-tag { grid-column:2; justify-self:start; } }
</style>
