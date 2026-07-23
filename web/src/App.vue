<script setup lang="ts">
import { computed } from "vue";
import { darkTheme, NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, NNotificationProvider, zhCN, dateZhCN } from "naive-ui";
import { useUiStore } from "./stores/ui";
const ui = useUiStore();
const theme = computed(() => ui.dark ? darkTheme : null);
</script>
<template>
  <n-config-provider :theme="theme" :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="ui.themeOverrides">
    <n-global-style />
    <n-dialog-provider><n-notification-provider><n-message-provider>
      <router-view />
    </n-message-provider></n-notification-provider></n-dialog-provider>
  </n-config-provider>
</template>
