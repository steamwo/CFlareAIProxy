<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import { NButton, NCard, NDataTable, NInput, NSpace, NTag, useMessage } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import { RefreshCw, Search } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { api } from "../api";
import type { DiscoveredModel, PublicModel } from "../types";
const discovered=ref<DiscoveredModel[]>([]),publicModels=ref<PublicModel[]>([]),loading=ref(false),query=ref(""),message=useMessage();
async function load(){loading.value=true;try{const result=await api<{data:DiscoveredModel[];public:PublicModel[]}>("/models");discovered.value=result.data;publicModels.value=result.public;}catch(e){message.error(e instanceof Error?e.message:String(e));}finally{loading.value=false;}}
async function refresh(){loading.value=true;try{await api("/models/refresh",{method:"POST"});message.success("所有账号的模型目录已刷新");await load();}catch(e){message.error(e instanceof Error?e.message:String(e));}finally{loading.value=false;}}
const rows=computed(()=>{const q=query.value.toLowerCase();return discovered.value.filter(r=>!q||`${r.provider_id} ${r.model_id} ${r.display_name}`.toLowerCase().includes(q));});
const columns:DataTableColumns<DiscoveredModel>=[{title:"公开模型 ID",key:"model_id",render:r=>h("div",[h("strong",`${r.provider_id}/${r.model_id}`),h("div",{class:"muted",style:"font-size:12px"},r.display_name)])},{title:"来源",key:"provider_id",render:r=>h(NTag,{size:"small"},{default:()=>r.provider_id})},{title:"端点",key:"endpoint",render:r=>h(NTag,{size:"small",type:"info"},{default:()=>r.endpoint})},{title:"账号",key:"credential_id",ellipsis:{tooltip:true}},{title:"发现时间",key:"discovered_at",render:r=>new Date(r.discovered_at*1000).toLocaleString()}];
onMounted(load);
</script>
<template><page-header title="实际模型" description="只展示上游账号真实返回的模型。公开 ID 使用 source/model，避免不同来源的同名模型冲突。"><n-button type="primary" :loading="loading" @click="refresh"><template #icon><refresh-cw/></template>刷新全部模型</n-button></page-header><div class="grid-stats"><n-card><div class="metric">{{publicModels.length}}</div><div class="metric-label">公开模型</div></n-card><n-card><div class="metric">{{discovered.length}}</div><div class="metric-label">账号模型记录</div></n-card><n-card><div class="metric">{{new Set(discovered.map(v=>v.provider_id)).size}}</div><div class="metric-label">有模型的来源</div></n-card><n-card><div class="metric">{{new Set(discovered.map(v=>v.credential_id)).size}}</div><div class="metric-label">已发现账号</div></n-card></div><n-card><div class="toolbar"><n-input v-model:value="query" clearable placeholder="搜索模型或来源" style="max-width:360px"><template #prefix><search/></template></n-input></div><n-data-table :columns="columns" :data="rows" :loading="loading" :row-key="r=>`${r.provider_id}:${r.credential_id}:${r.model_id}:${r.endpoint}`" :scroll-x="940"/></n-card></template>
