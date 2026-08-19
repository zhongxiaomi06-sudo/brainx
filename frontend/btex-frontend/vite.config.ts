import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// The supplied archive does not include deployment metadata. The prototype is
// intentionally local-only, so optional D1/R2 bindings stay disabled.
const d1 = null;
const r2 = null;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    build: {
      // 2026-08-19：WorkBuddy 沙箱下 vite 的 prepare-out-dir（emptyDir 清空 ≥50 文件的目录）
      // 会被 safe-delete 守卫拦截（SAFE_DELETE_BULK_CONFIRM_REQUIRED）。多阶段 build
      // （client → rsc → ssr）中途清空必然触发 → 关闭自动清空。
      // 产物 hash 命名，残留旧 chunk 无害；需要干净构建时手动 rm -rf dist。
      emptyOutDir: false,
    },
    server: {
      host: "0.0.0.0",
      port: 4320,
      strictPort: true,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      // Brain X 后端（node src/server.js → http://127.0.0.1:3100）。
      // /api 经代理同源转发：无 CORS，会话 Cookie 自然透传。
      proxy: {
        "/api": {
          target: process.env.BRAINX_PROXY_TARGET || "http://127.0.0.1:3100",
          changeOrigin: false,
        },
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
