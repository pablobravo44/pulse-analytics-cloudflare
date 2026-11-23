import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "src/worker/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" }, // top level = local config, never production
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_PEPPER: "test-pepper",
            ENVIRONMENT: "test",
            PUBLIC_ORIGIN: "https://pulse.test",
            RP_ID: "pulse.test",
          },
        },
      }),
    ],
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["test/integration/setup.ts"],
    },
  };
});
