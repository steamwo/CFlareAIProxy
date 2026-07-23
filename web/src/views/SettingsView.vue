<script setup lang="ts">
import { onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NSpace, NTag, useMessage } from "naive-ui";
import { RefreshCw, Route } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProxyEditor from "../components/ProxyEditor.vue";
import { api } from "../api";
import type { ProxySummary } from "../types";
const proxy=ref<ProxySummary|null>(null),loading=ref(false),modal=ref(false),message=useMessage();
async function load(){loading.value=true;try{proxy.value=(await api<{data:ProxySummary}>("/settings/proxy")).data;}catch(e){message.error(e instanceof Error?e.message:String(e));}finally{loading.value=false;}}
onMounted(load);
</script>
<template><page-header title="系统设置" description="系统级配置为所有来源提供默认值；单个渠道或供应商可覆盖。"><n-button :loading="loading" @click="load"><template #icon><refresh-cw/></template>刷新</n-button></page-header><n-card title="系统默认代理"><template #header-extra><n-tag :type="proxy?.enabled?'success':'default'">{{proxy?.enabled?`${proxy.proxyProtocol}://${proxy.proxyHost}`:'直连'}}</n-tag></template><n-alert type="info" :bordered="false" style="margin-bottom:18px">只需要设置一个 Proxy URL。未设置覆盖代理的内置渠道和 OpenAI-compatible 供应商会继承它。</n-alert><n-alert v-if="proxy?.enabled && proxy.runtimeReady === false" type="warning" :bordered="false">该代理协议无法由当前 Worker 原生处理。请改用 http://、socks5:// 或 socks5h://；系统不会静默回退直连。</n-alert><n-space style="margin-top:18px"><n-button type="primary" @click="modal=true"><template #icon><route/></template>设置 Proxy URL</n-button></n-space></n-card><proxy-editor v-model:show="modal" :summary="proxy||undefined" title="系统默认代理" @changed="load"/></template>
