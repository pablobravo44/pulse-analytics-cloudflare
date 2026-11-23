import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", ".wrangler/", "node_modules/", ".data/", "coverage/", "site/", "worker-configuration.d.ts"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error", "log"] }],
    },
  },
);
