<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NCard, NEmpty, NProgress, NSkeleton, NTag } from "naive-ui";
import { Activity, Clock3, Gauge, RefreshCw, Server, Users, Zap } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import { useApiRequest } from "../composables/useApiRequest";
import { formatTokens } from "../utils/format";
import type { Overview } from "../types";

const data = ref<Overview | null>(null);
const { loading, run } = useApiRequest();
const hours = Array.from({ length: 24 }, (_, hour) => hour);

const formatRequests = (value: number): string => Intl.NumberFormat("zh-CN", {
  notation: value >= 10_000 ? "compact" : "standard",
  maximumFractionDigits: 1,
}).format(value || 0);
const money = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
const percentOf = (value: number, maximum: number): number => maximum > 0
  ? Math.max(4, Math.min(100, value / maximum * 100))
  : 0;

async function load() {
  await run(async () => { data.value = await api<Overview>("/overview"); });
}

const healthMeta = computed(() => {
  const rate = data.value?.usage24h.successRate ?? 0;
  if (rate >= 99) return { label: "运行稳定", type: "success" as const, copy: "主要线路运行正常，过去 24 小时成功率稳定。" };
  if (rate >= 95) return { label: "轻微波动", type: "warning" as const, copy: "存在少量失败请求，建议留意异常来源。" };
  return { label: "需要关注", type: "error" as const, copy: "失败率偏高，请检查账号、路由和上游服务。" };
});

const providerLeaders = computed(() => [...(data.value?.providerUsage ?? [])]
  .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests)
  .slice(0, 5));
const modelLeaders = computed(() => [...(data.value?.modelUsage ?? [])]
  .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests)
  .slice(0, 5));
const maxProviderTokens = computed(() => Math.max(0, ...providerLeaders.value.map((item) => item.tokens)));
const maxModelTokens = computed(() => Math.max(0, ...modelLeaders.value.map((item) => item.tokens)));

const heatmapRows = computed(() => {
  const source = new Map((data.value?.availability || []).map((item) => [item.bucket, item] as const));
  const rows: Array<{
    key: string;
    label: string;
    cells: Array<{ key: string; requests: number; rate: number; latency: number; color: string; title: string }>;
  }> = [];
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
      const color = requests === 0
        ? "var(--heat-empty)"
        : rate >= 99 ? "#16a34a"
          : rate >= 95 ? "#65a30d"
            : rate >= 80 ? "#d97706"
              : "#dc2626";
      return {
        key: `${bucket}`,
        requests,
        rate,
        latency,
        color,
        title: `${date.toLocaleString("zh-CN")} · ${requests ? `${requests} 次请求 · 成功率 ${rate.toFixed(1)}% · 平均 ${Math.round(latency)} ms` : "无请求数据"}`,
      };
    });
    rows.push({
      key: day.toISOString(),
      label: day.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }),
      cells,
    });
  }
  return rows;
});

onMounted(load);
</script>

<template>
  <page-header title="运行概览" description="快速确认服务状态、调用质量和主要流量去向。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <div v-if="loading && !data" class="overview-loading">
    <n-card><n-skeleton text :repeat="3" /></n-card>
    <div class="kpi-grid"><n-card v-for="index in 4" :key="index"><n-skeleton text :repeat="3" /></n-card></div>
    <div class="dashboard-grid"><n-card><n-skeleton text :repeat="8" /></n-card><n-card><n-skeleton text :repeat="8" /></n-card></div>
  </div>

  <template v-else-if="data">
    <n-card class="status-card" :bordered="false">
      <div class="status-card__summary">
        <span class="status-card__icon" :class="`status-card__icon--${healthMeta.type}`"><activity :size="20" /></span>
        <div class="status-card__copy">
          <div class="status-card__title">
            <h2>{{ healthMeta.label }}</h2>
            <n-tag :type="healthMeta.type" round :bordered="false">过去 24 小时</n-tag>
          </div>
          <p>{{ healthMeta.copy }}</p>
          <span class="service-address mono">{{ data.service }} · {{ data.publicBaseUrl }}</span>
        </div>
      </div>
      <div class="status-card__facts">
        <div><strong>{{ data.counts.providers?.enabled || 0 }} / {{ data.counts.providers?.total || 0 }}</strong><span>启用来源</span></div>
        <div><strong>{{ data.counts.credentials?.enabled || 0 }} / {{ data.counts.credentials?.total || 0 }}</strong><span>活跃账号</span></div>
        <div><strong>{{ money(data.usage24h.costMicros) }}</strong><span>估算成本</span></div>
      </div>
    </n-card>

    <div class="kpi-grid">
      <n-card class="kpi-card" :bordered="false">
        <div class="kpi-card__head"><span><zap :size="16" />请求量</span><small>24 小时</small></div>
        <strong class="kpi-card__value">{{ formatRequests(data.usage24h.requests) }}</strong>
        <p>{{ formatRequests(data.usage24h.successes) }} 次成功请求</p>
      </n-card>

      <n-card class="kpi-card kpi-card--success" :bordered="false">
        <div class="kpi-card__head"><span><activity :size="16" />成功率</span><small>请求质量</small></div>
        <strong class="kpi-card__value">{{ data.usage24h.successRate.toFixed(1) }}%</strong>
        <n-progress
          type="line"
          :percentage="data.usage24h.successRate"
          :show-indicator="false"
          :height="6"
          :border-radius="4"
          :status="data.usage24h.successRate >= 95 ? 'success' : 'warning'"
        />
      </n-card>

      <n-card class="kpi-card" :bordered="false">
        <div class="kpi-card__head"><span><gauge :size="16" />Token</span><small>输入与输出</small></div>
        <strong class="kpi-card__value">{{ formatTokens(data.usage24h.tokens) }}</strong>
        <p>过去 24 小时总用量</p>
      </n-card>

      <n-card class="kpi-card" :bordered="false">
        <div class="kpi-card__head"><span><clock3 :size="16" />响应速度</span><small>平均值</small></div>
        <strong class="kpi-card__value">{{ Math.round(data.usage24h.averageLatencyMs) }} ms</strong>
        <p>首 Token {{ Math.round(data.usage24h.averageFirstTokenMs) }} ms</p>
      </n-card>
    </div>

    <div class="dashboard-grid">
      <n-card class="panel-card heatmap-card" :bordered="false">
        <template #header>
          <div class="panel-heading">
            <div><strong>服务可用性热力图</strong><span>最近 7 天按小时观察成功率与请求量</span></div>
            <n-tag :bordered="false">168 小时</n-tag>
          </div>
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

      <n-card class="panel-card traffic-card" :bordered="false">
        <template #header>
          <div class="panel-heading"><div><strong>流量排行</strong><span>按 Token 使用量查看主要来源和模型</span></div></div>
        </template>

        <section class="ranking-section">
          <div class="ranking-section__title"><server :size="15" /><strong>来源</strong></div>
          <div v-if="providerLeaders.length" class="ranking-list">
            <div v-for="(item, index) in providerLeaders" :key="item.provider_id" class="ranking-row">
              <span class="ranking-index">{{ index + 1 }}</span>
              <div class="ranking-main">
                <div><strong>{{ item.provider_id }}</strong><span>{{ formatRequests(item.requests) }} 次</span></div>
                <div class="ranking-track"><i :style="{ width: `${percentOf(item.tokens, maxProviderTokens)}%` }"></i></div>
              </div>
              <b>{{ formatTokens(item.tokens) }}</b>
            </div>
          </div>
          <n-empty v-else size="small" description="暂无来源调用" />
        </section>

        <section class="ranking-section ranking-section--models">
          <div class="ranking-section__title"><users :size="15" /><strong>热门模型</strong></div>
          <div v-if="modelLeaders.length" class="ranking-list">
            <div v-for="(item, index) in modelLeaders" :key="item.public_model" class="ranking-row">
              <span class="ranking-index">{{ index + 1 }}</span>
              <div class="ranking-main">
                <div><strong class="mono">{{ item.public_model }}</strong><span>{{ formatRequests(item.requests) }} 次</span></div>
                <div class="ranking-track"><i :style="{ width: `${percentOf(item.tokens, maxModelTokens)}%` }"></i></div>
              </div>
              <b>{{ formatTokens(item.tokens) }}</b>
            </div>
          </div>
          <n-empty v-else size="small" description="暂无模型调用" />
        </section>
      </n-card>
    </div>
  </template>

  <n-empty v-else description="无法加载概览" />
</template>

<style scoped>
.overview-loading { display:flex; flex-direction:column; gap:14px; }
.status-card,.kpi-card,.panel-card { border:1px solid var(--n-border-color); box-shadow:0 6px 20px rgba(15,23,42,.035); }
.status-card { margin-bottom:14px; }
.status-card :deep(.n-card__content) { display:flex; align-items:center; justify-content:space-between; gap:28px; min-height:104px; padding:18px 20px; }
.status-card__summary { display:flex; align-items:center; gap:13px; min-width:0; }
.status-card__icon { display:grid; place-items:center; flex:none; width:42px; height:42px; border-radius:12px; color:#16a34a; background:rgba(34,197,94,.11); }
.status-card__icon--warning { color:#d97706; background:rgba(245,158,11,.12); }
.status-card__icon--error { color:#dc2626; background:rgba(239,68,68,.1); }
.status-card__copy { min-width:0; }
.status-card__title { display:flex; align-items:center; flex-wrap:wrap; gap:9px; }
.status-card__title h2 { margin:0; font-size:18px; line-height:1.25; }
.status-card__copy p { margin:5px 0 4px; color:var(--n-text-color-2); font-size:13px; }
.service-address { display:block; max-width:560px; overflow:hidden; color:var(--n-text-color-3); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.status-card__facts { display:grid; grid-template-columns:repeat(3,minmax(100px,1fr)); flex:none; }
.status-card__facts>div { min-width:112px; padding:4px 20px; border-left:1px solid var(--n-border-color); }
.status-card__facts strong { display:block; font-size:17px; font-variant-numeric:tabular-nums; }
.status-card__facts span { display:block; margin-top:3px; color:var(--n-text-color-3); font-size:11px; }
.kpi-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:14px; }
.kpi-card :deep(.n-card__content) { display:flex; flex-direction:column; min-height:126px; padding:17px 18px; }
.kpi-card__head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.kpi-card__head span { display:flex; align-items:center; gap:7px; color:var(--n-text-color-2); font-size:13px; font-weight:600; }
.kpi-card__head small { color:var(--n-text-color-3); font-size:11px; }
.kpi-card__value { display:block; margin-top:17px; font-size:28px; line-height:1; letter-spacing:-.035em; font-variant-numeric:tabular-nums; }
.kpi-card p { margin:10px 0 0; color:var(--n-text-color-3); font-size:12px; }
.kpi-card--success :deep(.n-progress) { margin-top:auto; padding-top:14px; }
.dashboard-grid { display:grid; grid-template-columns:minmax(0,1.55fr) minmax(360px,.85fr); align-items:start; gap:14px; }
.panel-card :deep(.n-card-header) { padding:17px 18px 12px; }
.panel-card :deep(.n-card__content) { padding:14px 18px 18px; }
.panel-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.panel-heading strong { display:block; font-size:15px; }
.panel-heading span { display:block; margin-top:4px; color:var(--n-text-color-3); font-size:11px; font-weight:400; }
.heatmap-card { min-width:0; }
.traffic-card { min-width:0; }
.ranking-section + .ranking-section { margin-top:20px; padding-top:18px; border-top:1px solid var(--n-border-color); }
.ranking-section__title { display:flex; align-items:center; gap:7px; margin-bottom:13px; color:var(--n-text-color-2); }
.ranking-section__title strong { font-size:13px; }
.ranking-list { display:flex; flex-direction:column; gap:13px; }
.ranking-row { display:grid; grid-template-columns:24px minmax(0,1fr) auto; align-items:center; gap:10px; }
.ranking-index { display:grid; place-items:center; width:24px; height:24px; border-radius:7px; color:var(--n-text-color-3); background:var(--n-color-embedded); font-size:10px; font-weight:700; }
.ranking-main { min-width:0; }
.ranking-main>div:first-child { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.ranking-main strong { overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.ranking-main span { flex:none; color:var(--n-text-color-3); font-size:10px; }
.ranking-track { height:5px; margin-top:6px; overflow:hidden; border-radius:999px; background:var(--n-color-embedded); }
.ranking-track i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#6366f1,#38bdf8); }
.ranking-row>b { font-size:11px; font-variant-numeric:tabular-nums; }
@media(max-width:1120px) { .status-card :deep(.n-card__content) { align-items:flex-start; flex-direction:column; } .status-card__facts { width:100%; } .status-card__facts>div:first-child { border-left:0; padding-left:0; } .dashboard-grid { grid-template-columns:1fr; } }
@media(max-width:900px) { .kpi-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:620px) { .status-card__facts { grid-template-columns:1fr; gap:10px; } .status-card__facts>div { padding:0; border-left:0; } .kpi-grid { grid-template-columns:1fr; } .dashboard-grid { grid-template-columns:1fr; } }
</style>
