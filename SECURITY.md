# Security Policy

## Reporting a vulnerability

If you find a security or privacy issue in Pulse (tenant isolation, authentication, OAuth, XSS, SSRF, secret handling, or IP/PII leakage), please do **not** open a public GitHub issue.

Report it privately through [GitHub Security Advisories](https://github.com/pablobravo44/pulse/security/advisories/new) with:

- A clear description of the issue and its impact
- Reproduction steps or a minimal proof of concept
- Any suggested fix if you have one

We aim to acknowledge reports within 72 hours and publish a fix before disclosure.

## Scope & security invariants

Pulse is self-hosted on your own Cloudflare account and enforces the following by design:

- **No stored IPs**: visitor IPs are used only in memory for HMAC-SHA256 daily visitor hashing and per-client rate-limit hashing, then discarded.
- **Scoped credentials**: API keys and OAuth grants are scoped (`stats:read`, `sites:write`, `ops:write`, `annotations:write`, `events:export`, `admin`) and optionally restricted to specific sites. Secrets are stored only as SHA-256 hashes (API keys, sessions, share tokens, heartbeat tokens) or AES-GCM encrypted with `PULSE_SECRET_KEY` (notification channel webhooks/tokens).
- **MCP credential boundary**: API keys cannot be created or rotated over MCP, preventing prompt injection via attacker-controlled analytics data (referrers, page titles, event properties) from minting credentials.
- **Dashboard authentication**: Cloudflare Access one-time email codes plus same-origin and `X-Pulse-Client: dashboard` CSRF checks on cookie-authenticated writes.
