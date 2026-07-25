<script setup lang="ts">
import { computed, h } from "vue";
import { useRouter, useRoute } from "vue-router";
import { NAvatar, NButton, NDrawer, NDrawerContent, NDropdown, NIcon, NLayout, NLayoutContent, NLayoutHeader, NLayoutSider, NMenu, NSpace, NText, useDialog } from "naive-ui";
import type { MenuOption } from "naive-ui";
import { BadgeCheck, Boxes, Cable, CircleDollarSign, Gauge, KeyRound, ListTree, Menu as MenuIcon, Moon, Network, ScrollText, Settings, Sun, UsersRound } from "@lucide/vue";
import SystemLogo from "../components/SystemLogo.vue";
import { useSessionStore } from "../stores/session";
import { useUiStore } from "../stores/ui";

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const ui = useUiStore();
const dialog = useDialog();
const icon = (component: unknown) => () => h(NIcon, null, { default: () => h(component as never) });
const items: MenuOption[] = [
  { label: "概览", key: "/", icon: icon(Gauge) },
  { label: "内置渠道", key: "/channels", icon: icon(Cable) },
  { label: "OpenAI 供应商", key: "/providers", icon: icon(Network) },
  { label: "授权", key: "/authorization", icon: icon(BadgeCheck) },
  { label: "账号池", key: "/accounts", icon: icon(UsersRound) },
  { label: "实际模型", key: "/models", icon: icon(Boxes) },
  { label: "模型路由", key: "/routes", icon: icon(ListTree) },
  { label: "网关密钥", key: "/keys", icon: icon(KeyRound) },
  { label: "模型价格", key: "/prices", icon: icon(CircleDollarSign) },
  { label: "请求日志", key: "/logs", icon: icon(ScrollText) },
  { label: "系统设置", key: "/settings", icon: icon(Settings) },
];
const active = computed(() => route.path === "/" ? "/" : `/${route.path.split("/")[1]}`);
function navigate(key: string) { ui.mobileMenu = false; void router.push(key); }
async function logout() {
  dialog.warning({
    title: "退出登录",
    content: "确定退出管理台吗？",
    positiveText: "退出",
    negativeText: "取消",
    onPositiveClick: async () => { await session.logout(); await router.replace("/login"); },
  });
}
const accountOptions = [
  { label: `已登录：${session.session?.username || "admin"}`, key: "user", disabled: true },
  { label: "退出登录", key: "logout" },
];
function onAccount(key: string) { if (key === "logout") void logout(); }
</script>

<template>
  <n-layout has-sider class="admin-shell">
    <n-layout-sider bordered collapse-mode="width" :collapsed-width="72" :width="244" show-trigger="bar" class="desktop-sider">
      <div class="side-brand">
        <system-logo :size="38" />
        <div class="side-brand__copy"><strong>CFlareAIProxy</strong><span>AI Gateway on Cloudflare</span></div>
      </div>
      <n-menu :value="active" :options="items" :collapsed-width="72" :collapsed-icon-size="20" @update:value="navigate" />
    </n-layout-sider>

    <n-drawer v-model:show="ui.mobileMenu" placement="left" :width="280">
      <n-drawer-content closable>
        <template #header><div class="drawer-brand"><system-logo :size="32" /><strong>CFlareAIProxy</strong></div></template>
        <n-menu :value="active" :options="items" @update:value="navigate" />
      </n-drawer-content>
    </n-drawer>

    <n-layout class="workspace-layout">
      <n-layout-header bordered class="topbar">
        <n-space align="center">
          <n-button quaternary circle class="mobile-menu" @click="ui.mobileMenu = true"><template #icon><menu-icon /></template></n-button>
          <n-text depth="3">一个 Worker · 动态模型 · 多账号池</n-text>
        </n-space>
        <n-space align="center">
          <n-button quaternary circle @click="ui.toggleTheme"><template #icon><sun v-if="ui.dark" /><moon v-else /></template></n-button>
          <n-dropdown :options="accountOptions" @select="onAccount"><n-avatar round size="small">{{ (session.session?.username || 'A').slice(0, 1).toUpperCase() }}</n-avatar></n-dropdown>
        </n-space>
      </n-layout-header>
      <n-layout-content class="content"><div class="page"><router-view /></div></n-layout-content>
    </n-layout>
  </n-layout>
</template>

<style scoped>
.admin-shell { height: 100vh; overflow: hidden; }
.admin-shell :deep(> .n-layout-scroll-container) { display: flex; height: 100%; min-width: 0; overflow: hidden; }
.desktop-sider { height: 100%; flex: none; }
.side-brand { height: 64px; display: flex; align-items: center; gap: 11px; padding: 0 16px; border-bottom: 1px solid var(--n-border-color); overflow: hidden; }
.side-brand__copy { min-width: 0; white-space: nowrap; }
.side-brand strong { display: block; font-size: 16px; }
.side-brand span { display: block; font-size: 11px; opacity: .58; }
.drawer-brand { display: flex; align-items: center; gap: 10px; }
.workspace-layout { flex: 1; min-width: 0; height: 100%; overflow: hidden; }
.workspace-layout :deep(> .n-layout-scroll-container) { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.topbar { position: sticky; top: 0; z-index: 20; flex: 0 0 64px; height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; backdrop-filter: blur(12px); }
.content { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 24px; overscroll-behavior: contain; }
.mobile-menu { display: none; }
@media (max-width: 820px) {
  .desktop-sider { display: none; }
  .mobile-menu { display: inline-flex; }
  .content { padding: 18px 14px; }
  .topbar { padding: 0 14px; }
}
</style>
