<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NCard, NEmpty, NProgress, NSkeleton, NTag, useMessage } from "naive-ui";
import { Activity, Clock3, Gauge, RefreshCw, Server, Users, Zap } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import { formatTokens } from "../utils/format";
import type { Overview } from "../types";

const data = ref<Overview | null>(null);
const loading = ref(false);
const message = useMessage();
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const formatRequests = (value: number): string => Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
const money = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
const percentOf = (value: number, maximum: number): number => maximum > 0 ? Math.max(3, Math.min(100, value / maximum * 100)) : 0;

async function load() {
  loading.value = true;
  try {
    data.value = await api<Overview>("/overview");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

const healthMeta = computed(() => {
  const rate = data.value?.usage24h.successRate ?? 0;
  if (rate >= 99) return { label: "运行稳定", type: "success" as const, copy: "主要线路运行正常，成功率保持稳定。" };
  if (rate >= 95) return { label: "轻微波动", type: "warning" as const, copy: "存在少量失败请求，建议关注异常来源。" };
  return { label: "需要关注", type: "error" as const, copy: "失败率偏高，请检查账号、路由和上游服务。" };
});
const providerLeaders = computed(() => [...(data.value?.providerUsage ?? [])].sort((left, right) => right.tokens - left.tokens || right.requests - left.requests).slice(0, 6));
const modelLeaders = computed(() => [...(data.value?.modelUsage ?? [])].sort((left, right) => right.tokens - left.tokens || right.requests - left.requests).slice(0, 6));
const maxProviderTokens = computed(() => Math.max(0, ...providerLeaders.value.map((item) => item.tokens)));
const maxModelTokens = computed(() => Math.max(0, ...modelLeaders.value.map((item) => item.tokens)));
const successStatus = computed(() => (data.value?.usage24h.successRate ?? 0) >= 95 ? "success" : "warning");
const heatmapRows = computed(() => {
  const source = new Map((data.value?.availability || []).map((item) => [item.bucket, item] as const));
  const rows: Array<{ key: string; label: string; cells: Array<{ key: string; requests: number; rate: number; latency: number; color: string; title: string }> }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const cells = hours.map((hour) => {
      const date = new Date(day);
      date.setHours(hour, 0, 0, 0);
      const bucket = Math.floor(date.getTime() / 1000 / 3600) * 3600;
      const item = source.get(bucket);
      const requests = item?.requests || 0;
      const rate = item?.successRate || 0;
      const latency = item?.averageLatencyMs || 0;
      const color = requests === 0 ? "var(--heat-empty)" : rate >= 99 ? "#16a34a" : rate >= 95 ? "#65a30d" : rate >= 80 ? "#d97706" : "#dc2626";
      return {
        key: `${bucket}`,
        requests,
        rate,
        latency,
        color,
        title: `${date.toLocaleString("zh-CN")} · ${requests ? `${requests} 次请求 · 成功率 ${rate.toFixed(1)}% · 平均 ${Math.round(latency)} ms` : "无请求数据"}`,
      };
    });
    rows.push({ key: day.toISOString(), label: day.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }), cells });
  }
  return rows;
});

onMounted(load);
</script>

<template>
  <page-header title="运行概览" description="先看服务是否稳定，再查看流量、资源与异常趋势。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <div v-if="loading && !data" class="overview-loading">
    <n-card><n-skeleton text :repeat="4" /></n-card>
    <div class="grid-2"><n-card><n-skeleton text :repeat="5" /></n-card><n-card><n-skeleton text :repeat="5" /></n-card></div>
  </div>

  <template v-else-if="data">
    <n-card class="overview-hero" :bordered="false">
      <div class="hero-status">
        <div class="status-icon" :class="`status-icon--${healthMeta.type}`"><activity :size="22" /></div>
        <div>
          <div class="status-title"><h2>{{ healthMeta.label }}</h2><n-tag :type="healthMeta.type" round :bordered="false">过去 24 小时</n-tag></div>
          <p>{{ healthMeta.copy }}</p>
          <span class="service-address mono">{{ data.service }} · {{ data.publicBaseUrl }}</span>
        </div>
      </div>

      <div class="hero-success">
        <n-progress type="circle" :percentage="data.usage24h.successRate" :status="successStatus" :stroke-width="9">
          <div class="success-value"><strong>{{ data.usage24h.successRate.toFixed(1) }}%</strong><span>请求成功率</span></div>
        </n-progress>
      </div>

      <div class="hero-metrics">
        <div><span><zap :size="14" />请求量</span><strong>{{ formatRequests(data.usage24h.requests) }}</strong><small>24 小时累计</small></div>
        <div><span><gauge :size="14" />Token</span><strong>{{ formatTokens(data.usage24h.tokens) }}</strong><small>输入与输出合计</small></div>
        <div><span><clock3 :size="14" />平均延迟</span><strong>{{ Math.round(data.usage24h.averageLatencyMs) }} ms</strong><small>完整响应</small></div>
        <div><span><activity :size="14" />首 Token</span><strong>{{ Math.round(data.usage24h.averageFirstTokenMs) }} ms</strong><small>流式首包</small></div>
      </div>
    </n-card>

    <n-card class="resource-strip" :bordered="false">
      <div class="resource-item"><span class="resource-icon"><server :size="17" /></span><div><strong>{{ data.counts.providers?.enabled || 0 }} / {{ data.counts.providers?.total || 0 }}</strong><span>启用来源</span></div></div>
      <div class="resource-item"><span class="resource-icon"><users :size="17" /></span><div><strong>{{ data.counts.credentials?.enabled || 0 }} / {{ data.counts.credentials?.total || 0 }}</strong><span>活跃账号</span></div></div>
      <div class="resource-item"><span class="resource-icon"><zap :size="17" /></span><div><strong>{{ formatRequests(data.usage24h.successes) }}</strong><span>成功请求</span></div></div>
      <div class="resource-item"><span class="resource-icon"><gauge :size="17" /></span><div><strong>{{ money(data.usage24h.costMicros) }}</strong><span>估算成本</span></div></div>
    </n-card>

    <div class="overview-grid">
      <n-card class="heatmap-card" :bordered="false">
        <template #header>
          <div class="card-heading"><div><strong>服务可用性热力图</strong><span>最近 7 天按小时观察成功率与请求量</span></div><n-tag :bordered="false">168 小时</n-tag></div>
        </template>
        <div class="heatmap-scroll">
          <div class="heatmap">
            <div class="heatmap-header"><span></span><span v-for="hour in hours" :key="hour">{{ hour % 3 === 0 ? hour : '' }}</span></div>
            <div v-for="row in heatmapRows" :key="row.key" class="heatmap-row">
              <span class="heatmap-label">{{ row.label }}</span>
              <span v-for="cell in row.cells" :key="cell.key" class="heatmap-cell" :style="{ background: cell.color }" :title="cell.title"></span>
            </div>
          </div>
        </div>
        <div class="heatmap-legend"><span>无数据</span><i style="background:var(--heat-empty)"></i><span>异常</span><i style="background:#dc2626"></i><span>80%+</span><i style="background:#d97706"></i><span>95%+</span><i style="background:#65a30d"></i><span>99%+</span><i style="background:#16a34a"></i></div>
      </n-card>

      <div class="leaderboards">
        <n-card class="ranking-card" :bordered="false">
          <template #header><div class="card-heading"><div><strong>来源流量</strong><span>按 Token 使用量排序</span></div></div></template>
          <div v-if="providerLeaders.length" class="ranking-list">
            <div v-for="(item, index) in providerLeaders" :key="item.provider_id" class="ranking-row">
              <span class="ranking-index">{{ index + 1 }}</span>
              <div class="ranking-main"><div><strong>{{ item.provider_id }}</strong><span>{{ formatRequests(item.requests) }} 次请求</span></div><div class="ranking-track"><i :style="{ width: `${percentOf(item.tokens, maxProviderTokens)}%` }"></i></div></div>
              <b>{{ formatTokens(item.tokens) }}</b>
            </div>
          </div>
          <n-empty v-else description="暂无来源调用" />
        </n-card>

        <n-card class="ranking-card" :bordered="false">
          <template #header><div class="card-heading"><div><strong>热门模型</strong><span>按 Token 使用量排序</span></div></div></template>
          <div v-if="modelLeaders.length" class="ranking-list">
            <div v-for="(item, index) in modelLeaders" :key="item.public_model" class="ranking-row">
              <span class="ranking-index">{{ index + 1 }}</span>
              <div class="ranking-main"><div><strong class="mono">{{ item.public_model }}</strong><span>{{ formatRequests(item.requests) }} 次请求</span></div><div class="ranking-track"><i :style="{ width: `${percentOf(item.tokens, maxModelTokens)}%` }"></i></div></div>
              <b>{{ formatTokens(item.tokens) }}</b>
            </div>
          </div>
          <n-empty v-else description="暂无模型调用" />
        </n-card>
      </div>
    </div>
  </template>

  <n-empty v-else description="无法加载概览" />
</template>

<style scoped>
.overview-loading { display:flex; flex-direction:column; gap:16px; }
.overview-hero { margin-bottom:14px; border:1px solid var(--n-border-color); background:radial-gradient(circle at 8% 10%,rgba(99,102,241,.13),transparent 30%),linear-gradient(120deg,rgba(14,165,233,.06),transparent 50%),var(--n-color); box-shadow:0 12px 32px rgba(15,23,42,.05); }
.overview-hero :deep(.n-card__content) { display:grid; grid-template-columns:minmax(260px,1.25fr) auto minmax(420px,1.4fr); align-items:center; gap:28px; padding:24px; }
.hero-status { display:flex; align-items:flex-start; gap:14px; min-width:0; }
.status-icon { display:grid; place-items:center; flex:none; width:46px; height:46px; border-radius:14px; background:rgba(34,197,94,.11); color:#16a34a; }
.status-icon--warning { background:rgba(245,158,11,.12); color:#d97706; }
.status-icon--error { background:rgba(239,68,68,.1); color:#dc2626; }
.status-title { display:flex; align-items:center; flex-wrap:wrap; gap:9px; }
.status-title h2 { margin:0; font-size:21px; }
.hero-status p { margin:6px 0; color:var(--n-text-color-2); font-size:12px; line-height:1.55; }
.service-address { display:block; overflow:hidden; color:var(--n-text-color-3); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.hero-success { padding:0 8px; }
.success-value { display:flex; align-items:center; flex-direction:column; }
.success-value strong { font-size:20px; line-height:1.1; }
.success-value span { margin-top:4px; color:var(--n-text-color-3); font-size:9px; }
.hero-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.hero-metrics>div { padding:12px 14px; border:1px solid var(--n-border-color); border-radius:12px; background:color-mix(in srgb,var(--n-color) 86%,transparent); }
.hero-metrics span { display:flex; align-items:center; gap:6px; color:var(--n-text-color-3); font-size:10px; }
.hero-metrics strong { display:block; margin-top:7px; font-size:19px; letter-spacing:-.02em; }
.hero-metrics small { display:block; margin-top:2px; color:var(--n-text-color-3); font-size:9px; }
.resource-strip { margin-bottom:14px; border:1px solid var(--n-border-color); }
.resource-strip :deep(.n-card__content) { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); padding:0; }
.resource-item { display:flex; align-items:center; gap:11px; min-height:76px; padding:14px 18px; }
.resource-item + .resource-item { border-left:1px solid var(--n-border-color); }
.resource-icon { display:grid; place-items:center; width:34px; height:34px; border-radius:10px; background:var(--n-color-embedded); color:#6366f1; }
.resource-item strong { display:block; font-size:16px; }
.resource-item div>span { display:block; margin-top:3px; color:var(--n-text-color-3); font-size:10px; }
.overview-grid { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(330px,.8fr); align-items:start; gap:14px; }
.heatmap-card,.ranking-card { border:1px solid var(--n-border-color); box-shadow:0 8px 24px rgba(15,23,42,.035); }
.card-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.card-heading strong { display:block; font-size:14px; }
.card-heading span { display:block; margin-top:4px; color:var(--n-text-color-3); font-size:10px; }
.leaderboards { display:flex; flex-direction:column; gap:14px; }
.ranking-list { display:flex; flex-direction:column; gap:13px; }
.ranking-row { display:grid; grid-template-columns:22px minmax(0,1fr) auto; align-items:center; gap:9px; }
.ranking-index { display:grid; place-items:center; width:22px; height:22px; border-radius:7px; background:var(--n-color-embedded); color:var(--n-text-color-3); font-size:9px; font-weight:700; }
.ranking-main { min-width:0; }
.ranking-main>div:first-child { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ranking-main strong { overflow:hidden; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.ranking-main span { color:var(--n-text-color-3); font-size:9px; white-space:nowrap; }
.ranking-track { height:4px; margin-top:6px; overflow:hidden; border-radius:999px; background:var(--n-color-embedded); }
.ranking-track i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#6366f1,#38bdf8); }
.ranking-row>b { font-size:10px; }
@media(max-width:1180px) { .overview-hero :deep(.n-card__content) { grid-template-columns:minmax(0,1fr) auto; } .hero-metrics { grid-column:1 / 3; } .overview-grid { grid-template-columns:1fr; } .leaderboards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:760px) { .overview-hero :deep(.n-card__content) { grid-template-columns:1fr; } .hero-success { justify-self:start; } .hero-metrics { grid-column:auto; width:100%; } .resource-strip :deep(.n-card__content) { grid-template-columns:repeat(2,minmax(0,1fr)); } .resource-item:nth-child(3) { border-left:0; border-top:1px solid var(--n-border-color); } .resource-item:nth-child(4) { border-top:1px solid var(--n-border-color); } .leaderboards { grid-template-columns:1fr; } }
@media(max-width:480px) { .hero-metrics { grid-template-columns:1fr; } .resource-strip :deep(.n-card__content) { grid-template-columns:1fr; } .resource-item + .resource-item { border-top:1px solid var(--n-border-color); border-left:0; } }
</style>
