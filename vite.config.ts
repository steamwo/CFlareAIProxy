import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { visualizer } from "rollup-plugin-visualizer";
import { fileURLToPath, URL } from "node:url";

// Set ANALYZE=1 to emit .wrangler/bundle-stats.html for chunk composition analysis.
const analyze = process.env.ANALYZE === "1";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [
    vue(),
    ...(analyze
      ? [visualizer({
          filename: fileURLToPath(new URL("./.wrangler/bundle-stats.html", import.meta.url)),
          template: "treemap",
          gzipSize: true,
        })]
      : []),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "admin/assets",
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        // Measured composition of the former single entry chunk (rollup-plugin-visualizer,
        // run with ANALYZE=1): naive-ui 44.5%, its runtime deps ~14%, the Vue family ~29%,
        // and only 2.3% application source.
        //
        // Splitting therefore does not shrink a cold first load — the bytes are the bytes.
        // What it buys is cache separation: shipping an admin-console change currently
        // invalidates ~950 kB of untouched third-party code. Pinning the vendor halves into
        // their own chunks lets a routine deploy re-download only the small app chunk, which
        // is the common case for a self-hosted gateway that updates far more often than it
        // bumps naive-ui.
        manualChunks(id: string): string | undefined {
          if (!id.includes("node_modules")) return undefined;
          // pnpm nests real packages under .pnpm/<name>@<version>/node_modules/<name>.
          const scoped = id.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
            ?? id.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
          const pkg = scoped?.[1];
          if (!pkg) return undefined;
          if (pkg === "vue" || pkg === "vue-router" || pkg === "pinia" || pkg.startsWith("@vue/")) return "vendor-vue";
          // Only naive-ui's shared substrate is pinned. Pulling naive-ui itself in here
          // would be a regression: Rollup already splits its heavy components (DataTable
          // 94 kB, Select 55 kB, Popover 44 kB) into route-level chunks, and forcing them
          // into one vendor file makes every visitor download the data grid to reach the
          // login page.
          const uiRuntime = new Set([
            "vueuc", "seemly", "vooks", "vdirs", "treemate", "evtd",
            "css-render", "@css-render/plugin-bem", "async-validator",
            "date-fns", "date-fns-tz", "lodash-es", "@juggle/resize-observer",
          ]);
          if (uiRuntime.has(pkg)) return "vendor-ui-runtime";
          return undefined;
        },
      },
    },
  },
});
