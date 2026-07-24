<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NModal, NPagination, NSelect, NSpace, NSpin, NTag, useMessage } from "naive-ui";
import { FileJson, KeyRound, RefreshCw } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProviderIcon from "../components/ProviderIcon.vue";
import { api, jsonBody } from "../api";
import type { Channel } from "../types";

const route = useRoute();
const channels = ref<Channel[]>([]);
const loading = ref(false);
const importModal = ref(false);
const oauthModal = ref(false);
const page = ref(1);
const pageSize = ref(6);
const message = useMessage();
const importForm = reactive({ providerId: "", label: "", json: "", filename: "" });
const oauth = reactive({
  providerId: "",
  providerName: "",
  sessionId: "",
  flow: "",
  authorizeUrl: "",
  verificationUri: "",
  userCode: "",
  redirectUri: "",
  callbackUrl: "",
  message: "",
  polling: false,
  exchanging: false,
  expiresAt: 0,
  retryCount: 0,
});
let pollTimer: number | undefined;
let pollInFlight = false;

const authChannels = computed(() => channels.value.filter((channel) => channel.authMode !== "api-key"));
const pageCount = computed(() => Math.max(1, Math.ceil(authChannels.value.length / pageSize.value)));
const pagedChannels = computed(() => authChannels.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
const channelOptions = computed(() => authChannels.value.map((channel) => ({ label: channel.name, value: channel.id })));

watch(pageCount, (count) => { if (page.value > count) page.value = count; });
async function load() {
  loading.value = true;
  try { channels.value = (await api<{ data: Channel[] }>("/channels")).data; }
  catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function stopPolling() {
  oauth.polling = false;
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
}
function schedulePoll(seconds = 2) {
  if (!oauth.polling) return;
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => void pollOauth(), Math.max(1500, seconds * 1000));
}
async function startOauth(channel: Channel) {
  stopPolling();
  try {
    const result = await api<any>(`/oauth/${channel.id}/start`, { method: "POST" });
    const authorizationCode = result.flow === "authorization_code_pkce";
    Object.assign(oauth, {
      providerId: channel.id,
      providerName: channel.name,
      sessionId: result.sessionId,
      flow: result.flow,
      authorizeUrl: result.verificationUriComplete || result.authorizeUrl || result.verificationUri || "",
      verificationUri: result.verificationUri || "",
      userCode: result.userCode || "",
      redirectUri: result.redirectUri || "",
      callbackUrl: "",
      message: authorizationCode
        ? (channel.id === "codex" ? "请在新窗口完成 Codex 登录，再粘贴地址栏中的完整回调 URL。" : "完成登录后粘贴完整回调 URL。")
        : "授权页面已打开，正在等待账号确认…",
      polling: !authorizationCode,
      exchanging: false,
      expiresAt: Number(result.expiresAt) || Math.floor(Date.now() / 1000) + 600,
      retryCount: 0,
    });
    oauthModal.value = true;
    if (oauth.authorizeUrl) window.open(oauth.authorizeUrl, "_blank", "noopener,noreferrer");
    if (!authorizationCode) schedulePoll(Number(result.intervalSeconds) || 2);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
async function pollOauth() {
  if (!oauth.sessionId || !oauth.polling) return;
  if (pollInFlight) { schedulePoll(1); return; }
  const sessionId = oauth.sessionId;
  const providerId = oauth.providerId;
  if (oauth.expiresAt && Date.now() / 1000 >= oauth.expiresAt) {
    stopPolling();
    oauth.message = "授权等待已超时，请重新发起授权。";
    return;
  }
  pollInFlight = true;
  try {
    const result = await api<any>(`/oauth/${providerId}/poll`, { method: "POST", body: jsonBody({ sessionId }) });
    if (oauth.sessionId !== sessionId || oauth.providerId !== providerId) return;
    oauth.retryCount = 0;
    if (result.status === "complete") {
      stopPolling();
      oauth.message = "授权完成，账号已加入账号池。";
      message.success("授权完成，账号已导入");
      await load();
      return;
    }
    oauth.message = result.message || "仍在等待授权确认…";
    schedulePoll(Number(result.retryAfterSeconds) || 2);
  } catch (error) {
    if (oauth.sessionId !== sessionId || oauth.providerId !== providerId) return;
    const detail = error instanceof Error ? error.message : String(error);
    const terminal = /OAUTH_SESSION_(?:EXPIRED|NOT_FOUND|INVALID)|授权会话.*(?:过期|不存在)|session.*(?:expired|not found)/i.test(detail);
    if (terminal) {
      stopPolling();
      oauth.message = detail;
    } else {
      oauth.retryCount += 1;
      oauth.message = `授权状态查询暂时失败，正在自动重试（${oauth.retryCount}）：${detail}`;
      schedulePoll(Math.min(8, 2 + oauth.retryCount));
    }
  } finally {
    pollInFlight = false;
  }
}
async function exchangeOauth() {
  if (!oauth.sessionId || !oauth.callbackUrl.trim()) {
    message.warning("请粘贴完整回调 URL");
    return;
  }
  oauth.exchanging = true;
  try {
    const result = await api<any>(`/oauth/${oauth.providerId}/exchange`, { method: "POST", body: jsonBody({ sessionId: oauth.sessionId, callbackUrl: oauth.callbackUrl.trim() }) });
    oauth.message = result.message || "授权完成，账号已加入账号池。";
    message.success("授权完成，账号已导入");
    await load();
  } catch (error) {
    oauth.message = error instanceof Error ? error.message : String(error);
    message.error(oauth.message);
  } finally {
    oauth.exchanging = false;
  }
}
function parsedImport(): { auth: Record<string, unknown>; providerId: string; label: string } {
  const parsed = JSON.parse(importForm.json) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("认证文件必须是 JSON 对象");
  const nested = parsed.auth && typeof parsed.auth === "object" && !Array.isArray(parsed.auth)
    ? parsed.auth as Record<string, unknown>
    : parsed;
  const detectedProvider = [
    importForm.providerId,
    parsed.providerId,
    parsed.provider_id,
    nested.providerId,
    nested.provider_id,
    nested.type,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
  const detectedLabel = importForm.label.trim()
    || (typeof parsed.label === "string" ? parsed.label.trim() : "")
    || importForm.filename.replace(/\.json$/i, "")
    || "导入授权文件";
  return { auth: nested, providerId: detectedProvider, label: detectedLabel };
}
async function readImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    importForm.filename = file.name;
    importForm.json = await file.text();
    const parsed = parsedImport();
    if (!importForm.providerId && authChannels.value.some((channel) => channel.id === parsed.providerId)) {
      importForm.providerId = parsed.providerId;
    }
    if (!importForm.label) importForm.label = parsed.label;
    message.success(`已读取 ${file.name}`);
  } catch (error) {
    importForm.json = "";
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    input.value = "";
  }
}
async function importJson() {
  try {
    const parsed = parsedImport();
    if (!parsed.providerId) throw new Error("请选择内置渠道，或使用包含 type/provider_id 的认证文件");
    await api("/auth-files/import", {
      method: "POST",
      body: jsonBody({ providerId: parsed.providerId, label: parsed.label, auth: parsed.auth }),
    });
    message.success("授权文件已导入账号池");
    importModal.value = false;
    Object.assign(importForm, { providerId: "", label: "", json: "", filename: "" });
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
watch(oauthModal, (open) => { if (!open) stopPolling(); });
onMounted(async () => {
  await load();
  if (route.query.import === "1") importModal.value = true;
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <page-header title="授权" description="集中完成内置渠道 OAuth 和授权文件导入；授权成功后账号会自动进入账号池。">
    <n-button @click="importModal = true"><template #icon><file-json /></template>导入认证文件</n-button>
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-alert type="info" :bordered="false" style="margin-bottom:16px">账号池只展示内置渠道授权账号；OpenAI-compatible 供应商 API Key 请在“供应商”配置中添加和管理。</n-alert>
  <n-spin :show="loading">
    <div v-if="pagedChannels.length" class="entity-grid">
      <n-card v-for="channel in pagedChannels" :key="channel.id" class="entity-card">
        <div class="auth-card__head">
          <div class="entity-card__title"><provider-icon :provider-id="channel.id" :name="channel.name" :size="34" /><div><strong>{{ channel.name }}</strong><div class="muted auth-card__id">{{ channel.id }}</div></div></div>
          <n-tag size="small" type="info">{{ channel.authMode }}</n-tag>
        </div>
        <p class="muted auth-card__description">{{ channel.description }}</p>
        <div class="auth-card__footer"><span class="muted">已有账号 {{ channel.accountCount }}</span><n-button type="primary" @click="startOauth(channel)"><template #icon><key-round /></template>发起授权</n-button></div>
      </n-card>
    </div>
    <n-card v-else><n-empty description="当前没有需要 OAuth 的内置渠道" /></n-card>
  </n-spin>
  <div v-if="authChannels.length > pageSize" class="pagination-row"><n-pagination v-model:page="page" v-model:page-size="pageSize" :item-count="authChannels.length" :page-sizes="[6, 12, 24]" show-size-picker /></div>

  <n-modal v-model:show="importModal" preset="card" title="导入认证文件" style="width:min(680px,calc(100vw - 32px))">
    <n-form label-placement="top">
      <n-alert type="warning" :bordered="false" style="margin-bottom:16px">认证文件包含可登录账号的敏感 Token。仅导入可信文件，导入后不要上传到代码仓库或公开分享。</n-alert>
      <n-form-item label="选择 JSON 文件">
        <input class="auth-file-input" type="file" accept=".json,application/json" @change="readImportFile" />
      </n-form-item>
      <n-form-item label="内置渠道"><n-select v-model:value="importForm.providerId" :options="channelOptions" filterable placeholder="可从文件的 type/provider_id 自动识别" /></n-form-item>
      <n-form-item label="标签"><n-input v-model:value="importForm.label" placeholder="例如 工作账号 / 组织账号" /></n-form-item>
      <n-form-item label="JSON 内容"><n-input v-model:value="importForm.json" type="textarea" :rows="10" placeholder='选择 JSON 文件，或粘贴 {"access_token":"...","refresh_token":"..."}' /></n-form-item>
      <n-space justify="end"><n-button @click="importModal = false">取消</n-button><n-button type="primary" :disabled="!importForm.json.trim()" @click="importJson">导入</n-button></n-space>
    </n-form>
  </n-modal>

  <n-modal v-model:show="oauthModal" preset="card" :title="`${oauth.providerName || oauth.providerId || '渠道'} 授权`" style="width:min(680px,calc(100vw - 32px))">
    <n-alert :type="oauth.message.includes('完成') ? 'success' : oauth.message.includes('失败') || oauth.message.includes('拒绝') || oauth.message.includes('超时') ? 'error' : 'info'" :bordered="false">{{ oauth.message }}</n-alert>
    <n-space vertical style="margin-top:16px;width:100%">
      <div v-if="oauth.userCode">验证码：<n-tag type="warning" size="large" class="mono">{{ oauth.userCode }}</n-tag></div>
      <n-button v-if="oauth.authorizeUrl" tag="a" :href="oauth.authorizeUrl" target="_blank" type="primary">打开授权页面</n-button>
      <template v-if="oauth.flow === 'authorization_code_pkce'">
        <n-alert type="warning" :bordered="false">授权服务会跳转到 <span class="mono">{{ oauth.redirectUri || "localhost 回调地址" }}</span>。页面无法访问时，复制地址栏中的完整 URL 即可。</n-alert>
        <n-form-item label="完整回调 URL" style="width:100%;margin-bottom:0"><n-input v-model:value="oauth.callbackUrl" type="textarea" :rows="3" placeholder="http://localhost:1455/auth/callback?code=...&state=..." /></n-form-item>
        <n-button type="primary" :loading="oauth.exchanging" :disabled="!oauth.callbackUrl.trim()" @click="exchangeOauth">完成回调并换取 Token</n-button>
      </template>
      <n-button v-if="oauth.polling" :loading="true">持续等待授权</n-button>
    </n-space>
  </n-modal>
</template>

<style scoped>
.auth-card__head, .auth-card__footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.auth-card__head { align-items: flex-start; }
.auth-card__id { margin-top: 2px; font-size: 12px; font-family: "SFMono-Regular", Consolas, monospace; }
.auth-card__description { min-height: 42px; margin: 16px 0 20px; }
.auth-card__footer { padding-top: 14px; border-top: 1px solid var(--n-border-color); }
.auth-file-input { width: 100%; padding: 10px 12px; border: 1px dashed var(--n-border-color); border-radius: 8px; background: var(--n-color); color: var(--n-text-color); }
</style>
