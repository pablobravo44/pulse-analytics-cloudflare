import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/unit/cloudflare-workers-stub.ts", import.meta.url)),
      "cloudflare:email": fileURLToPath(new URL("./test/unit/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
