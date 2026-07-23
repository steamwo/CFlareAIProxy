<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NCard, NDataTable, NEmpty, NProgress, NSkeleton, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import type { Overview } from "../types";

const data=ref<Overview|null>(null),loading=ref(false),message=useMessage();
const fmt=(n:number)=>Intl.NumberFormat("zh-CN",{notation:n>9999?"compact":"standard",maximumFractionDigits:1}).format(n||0);
const money=(micros:number)=>`$${(micros/1_000_000).toFixed(4)}`;
const providerColumns:DataTableColumns<any>=[{title:"供应来源",key:"provider_id"},{title:"请求",key:"requests",render:r=>fmt(r.requests)},{title:"Token",key:"tokens",render:r=>fmt(r.tokens)}];
const modelColumns:DataTableColumns<any>=[{title:"模型",key:"public_model",ellipsis:{tooltip:true}},{title:"请求",key:"requests",render:r=>fmt(r.requests)},{title:"Token",key:"tokens",render:r=>fmt(r.tokens)}];
async function load(){loading.value=true;try{data.value=await api<Overview>("/overview");}catch(e){message.error(e instanceof Error?e.message:String(e));}finally{loading.value=false;}}
const successType=computed(()=>data.value && data.value.usage24h.successRate>=95?"success":"warning");
const hours=Array.from({length:24},(_,hour)=>hour);
const heatmapRows=computed(()=>{
 const source=new Map((data.value?.availability||[]).map(item=>[item.bucket,item]));
 const rows:Array<{key:string;label:string;cells:Array<{key:string;requests:number;rate:number;latency:number;color:string;title:string}>}>=[];
 const today=new Date();today.setHours(0,0,0,0);
 for(let offset=6;offset>=0;offset--){
  const day=new Date(today);day.setDate(today.getDate()-offset);
  const cells=hours.map(hour=>{
   const date=new Date(day);date.setHours(hour,0,0,0);
   const bucket=Math.floor(date.getTime()/1000/3600)*3600;
   const item=source.get(bucket);const requests=item?.requests||0;const rate=item?.successRate||0;const latency=item?.averageLatencyMs||0;
   const color=requests===0?"var(--heat-empty)":rate>=99?"#16a34a":rate>=95?"#65a30d":rate>=80?"#d97706":"#dc2626";
   return {key:`${bucket}`,requests,rate,latency,color,title:`${date.toLocaleString("zh-CN")} · ${requests?`${requests} 次请求 · 成功率 ${rate.toFixed(1)}% · 平均 ${Math.round(latency)} ms`:"无请求数据"}`};
  });
  rows.push({key:day.toISOString(),label:day.toLocaleDateString("zh-CN",{month:"numeric",day:"numeric",weekday:"short"}),cells});
 }
 return rows;
});
onMounted(load);
</script>
<template><page-header title="运行概览" description="过去 24 小时的网关状态、调用量与账号资源。"><n-button :loading="loading" @click="load"><template #icon><refresh-cw/></template>刷新</n-button></page-header>
<div v-if="loading&&!data" class="grid-stats"><n-card v-for="i in 4" :key="i"><n-skeleton text :repeat="2" /></n-card></div>
<template v-else-if="data"><div class="grid-stats">
<n-card><div class="metric">{{fmt(data.usage24h.requests)}}</div><div class="metric-label">24 小时请求</div></n-card>
<n-card><div class="metric">{{data.usage24h.successRate.toFixed(1)}}%</div><div class="metric-label">成功率</div><n-progress type="line" :percentage="data.usage24h.successRate" :status="successType" :show-indicator="false" style="margin-top:10px"/></n-card>
<n-card><div class="metric">{{fmt(data.usage24h.tokens)}}</div><div class="metric-label">Token 使用量</div></n-card>
<n-card><div class="metric">{{money(data.usage24h.costMicros)}}</div><div class="metric-label">估算成本</div></n-card>
</div><div class="grid-stats"><n-card><div class="metric">{{data.counts.providers?.enabled||0}} / {{data.counts.providers?.total||0}}</div><div class="metric-label">启用来源</div></n-card><n-card><div class="metric">{{data.counts.credentials?.enabled||0}} / {{data.counts.credentials?.total||0}}</div><div class="metric-label">活跃账号</div></n-card><n-card><div class="metric">{{Math.round(data.usage24h.averageLatencyMs)}} ms</div><div class="metric-label">平均延迟</div></n-card><n-card><div class="metric">{{Math.round(data.usage24h.averageFirstTokenMs)}} ms</div><div class="metric-label">平均首 Token</div></n-card></div>
<n-card title="服务可用性热力图" style="margin-bottom:16px"><div class="heatmap-scroll"><div class="heatmap"><div class="heatmap-header"><span></span><span v-for="hour in hours" :key="hour">{{hour%3===0?hour:''}}</span></div><div v-for="row in heatmapRows" :key="row.key" class="heatmap-row"><span class="heatmap-label">{{row.label}}</span><span v-for="cell in row.cells" :key="cell.key" class="heatmap-cell" :style="{background:cell.color}" :title="cell.title"></span></div></div></div><div class="heatmap-legend"><span>无数据</span><i style="background:var(--heat-empty)"></i><span>异常</span><i style="background:#dc2626"></i><span>80%+</span><i style="background:#d97706"></i><span>95%+</span><i style="background:#65a30d"></i><span>99%+</span><i style="background:#16a34a"></i></div><div class="muted" style="font-size:12px;margin-top:8px">按最近 7 天、每小时请求成功率计算。没有请求的时段显示为无数据，不会被误判为故障。</div></n-card>
<div class="grid-2"><n-card title="来源调用"><n-data-table v-if="data.providerUsage.length" :columns="providerColumns" :data="data.providerUsage" :bordered="false"/><n-empty v-else description="暂无调用记录"/></n-card><n-card title="热门模型"><n-data-table v-if="data.modelUsage.length" :columns="modelColumns" :data="data.modelUsage" :bordered="false"/><n-empty v-else description="暂无调用记录"/></n-card></div></template>
<n-empty v-else description="无法加载概览"/></template>
