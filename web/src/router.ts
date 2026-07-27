import { createRouter, createWebHistory } from "vue-router";
import { onUnauthorized } from "./api";
import { useSessionStore } from "./stores/session";
import LoginView from "./views/LoginView.vue";

const router = createRouter({
  history: createWebHistory("/admin/"),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    {
      path: "/", component: () => import("./layouts/AdminLayout.vue"),
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
  // TTL-bounded: re-probes at most once per TTL window rather than once per navigation,
  // while still noticing a session the server has since dropped.
  await store.ensureChecked();
  if (!to.meta.public && !store.authenticated) return { name: "login", query: { redirect: to.fullPath } };
  if (to.name === "login" && store.authenticated) return { name: "dashboard" };
  return true;
});

/**
 * Any 401 from a business request means the server-side session is gone. Drop the cached
 * session and send the user to the login page once, instead of leaving each view to surface
 * an isolated toast on a page that can no longer load data.
 */
onUnauthorized(() => {
  const store = useSessionStore();
  if (!store.authenticated) return;
  store.expire();
  const current = router.currentRoute.value;
  if (current.meta.public) return;
  void router.replace({ name: "login", query: { redirect: current.fullPath } });
});

export default router;
