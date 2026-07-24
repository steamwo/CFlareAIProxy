import { createRouter, createWebHistory } from "vue-router";
import { useSessionStore } from "./stores/session";
import LoginView from "./views/LoginView.vue";
import AdminLayout from "./layouts/AdminLayout.vue";

const router = createRouter({
  history: createWebHistory("/admin/"),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    {
      path: "/", component: AdminLayout,
      children: [
        { path: "", name: "dashboard", component: () => import("./views/DashboardView.vue") },
        { path: "channels", name: "channels", component: () => import("./views/ChannelsView.vue") },
        { path: "providers", name: "providers", component: () => import("./views/ProvidersView.vue") },
        { path: "authorization", name: "authorization", component: () => import("./views/AuthorizationView.vue") },
        { path: "accounts", name: "accounts", component: () => import("./views/AccountsView.vue") },
        { path: "models", name: "models", component: () => import("./views/ModelsView.vue") },
        { path: "routes", name: "routes", component: () => import("./views/RoutesView.vue") },
        { path: "keys", name: "keys", component: () => import("./views/KeysView.vue") },
        { path: "prices", name: "prices", component: () => import("./views/PricesView.vue") },
        { path: "logs", name: "logs", component: () => import("./views/LogsView.vue") },
        { path: "settings", name: "settings", component: () => import("./views/SettingsView.vue") },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  const store = useSessionStore();
  if (!store.checked) await store.check();
  if (!to.meta.public && !store.authenticated) return { name: "login", query: { redirect: to.fullPath } };
  if (to.name === "login" && store.authenticated) return { name: "dashboard" };
  return true;
});

export default router;
