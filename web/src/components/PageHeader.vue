<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template><div class="page-header"><div><h1>{{ title }}</h1><p v-if="description">{{ description }}</p></div><div class="header-actions"><slot /></div></div></template>
