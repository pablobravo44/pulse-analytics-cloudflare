import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = process.env.PULSE_DEV_API ?? "http://localhost:8787";

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../../dist/public", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    // No inline scripts: the dashboard CSP is script-src 'self'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  // `npm run dev:dashboard` proxies to a local `wrangler dev` (override with PULSE_DEV_API).
  server: {
    proxy: Object.fromEntries(
      [
        "/api",
        "/auth",
        "/mcp",
        "/oauth",
        "/docs",
        "/llms.txt",
        "/__dev",
        "/p.js",
        "/e",
        "/healthz",
        "/hb",
        "/l/",
        "/icons/",
        "/reports/",
      ].map((p) => [
        p,
        {
          target: api,
          // The API accepts writes only from its own origin (PUBLIC_ORIGIN), so writes from :5173 present as it.
          configure: (proxy) =>
            proxy.on("proxyReq", (req) => {
              if (req.getHeader("origin")) req.setHeader("origin", new URL(api).origin);
            }),
        },
      ]),
    ),
  },
});
