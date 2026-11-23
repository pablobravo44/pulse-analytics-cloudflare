# Contributing to Pulse

Issues and pull requests are welcome. Pulse is kept small, fast, and self-contained on purpose — prefer simple fixes over new dependencies or configuration flags.

## Local setup

Requires Node 22 or newer. No Cloudflare account or `workerd` is needed for local development or unit tests (works on Linux, macOS, and Windows).

```sh
npm ci
npm run dev:seed       # creates .data/dev.sqlite with realistic demo sites, goals, funnels and checks
npm run build          # builds dashboard + tracker into dist/public
npm run dev            # Node Worker on :8787 + Vite HMR on :5173
```

Open `http://localhost:5173/__dev/login` to sign in locally.

## Checks before opening a PR

Run all five checks locally:

```sh
npm run typecheck
npm run lint
npm test
npm run tracker:size
npm run build
```

On Linux or macOS (and in GitHub Actions CI), also run `npm run test:integration` to test against `workerd`.

## Non-negotiable rules

The rules in [AGENTS.md](AGENTS.md) apply to humans and agents alike:

1. **Privacy invariants**: never store, queue, log, or return visitor IP addresses; never set cookies or storage in `p.js` (except the user-requested `pulse_ignore` opt-out); never log API keys, session cookies, or tokens; daily salts expire within 48 hours.
2. **Tenant isolation**: every site-scoped route goes through `requireSite` (and `canAccessSite`); all SQL is parameterized.
3. **Never edit an applied migration**: add a new numbered file in `migrations/` instead. Migrations must be additive so Worker rollbacks remain safe.
4. **Tracker size budget**: `dist/public/p.js` must stay at or below 2.5 KB gzipped (`npm run tracker:size`).
5. **One query engine**: every read endpoint is a preset over `src/worker/query/` so dashboard, REST, and MCP numbers always agree.
6. **REST + MCP parity**: every new capability lands with its REST route, MCP tool (or explicit `mcpExclusion` in `src/worker/catalog.ts`), catalog entry, `docs/API.md` and `docs/MCP.md` entries, and tests (`test/unit/catalog.test.ts` enforces this).
7. **Bilingual dashboard**: every UI string passed to `t()` or `tn()` in `src/dashboard/src` must have a Spanish entry in `src/dashboard/src/lib/i18n/es-*.ts` (`test/unit/i18n.test.ts` enforces this).
