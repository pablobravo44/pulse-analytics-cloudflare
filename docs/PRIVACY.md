# Privacy

Pulse is first-party, cookieless analytics. It is built so that no data identifies a person.

## What is collected per hit
- Page: hostname, path, title, and only these query parameters: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `ref`, `source` (per-site allowlist). Everything else in the query string is dropped on the server.
- Referrer: origin and path (never its query string). Referrers from the site's own domains are dropped.
- Derived from the request, then discarded: country, region, city and continent (from Cloudflare's request metadata); device type, browser and OS with major versions (from the user agent).
- From the page: screen size, browser language, engaged time, scroll depth, clicked outbound/download URL (origin + path), Core Web Vitals, and (only when enabled) error messages with the script file name.
- Custom events and their properties as sent by the site, including tagged elements (`data-pulse-event`) and, when the script has `data-forms="true"`, a `form_submit` event with the form's id or name. Field values are never read.
- Site search: the value of the site's declared search parameters (e.g. `q`), lowercased and capped at 100 characters.

## Identifiers
- `visitor_id` = first 16 bytes of HMAC-SHA256(daily salt, `site | IP | user agent`).
- The salt is random per day of the site's time zone (the days reports count in) and deleted by the hourly cron once that day is over, so it lives at most about 25 hours: ids can't be linked across days or reversed, and a visitor isn't split in two at UTC midnight.
- **The IP address is used only to compute that hash and the rate-limit key (a hash of the IPv4 address, or of the /64 prefix for IPv6). It is never stored, queued or logged.**
- Imported Rybbit history keeps Rybbit's pseudonymous `user_id`/`session_id` (prefixed `rb_`).

## Not collected
Cookies, browser storage (except the `pulse_ignore` opt-out flag, stored only when the site operator or a visitor asks not to be counted), fingerprinting beyond the daily hash above, session replay, form contents, IP addresses.

## Consent and the right to object
Pulse stores and reads nothing on the device, keeps first-party aggregate statistics, follows no one across sites and keeps raw data `retention_months` (default 25). It was designed to meet the Spanish DPA's (AEPD) conditions for audience measurement without consent (LSSI art. 22.2; guide on audience-measurement tools, January 2024), where a site can load it from the first page with no cookie banner and name legitimate interest (GDPR art. 6.1.f) as the legal basis for the pseudonymous daily visitor id. Those conditions include letting visitors object: offer a "don't count my visits" control (for example in your cookie policy) that sets `pulse_ignore` (docs/TRACKER.md), and add `data-respect-dnt="true"` to the script tag.

This is a description of the design, not legal advice: whether your sites need consent depends on your jurisdiction and on how you use the data, so check with your own adviser.

## Retention
Raw events and sessions: `retention_months` per site (default 25). Older days are aggregated into daily rollups (counts per page, channel, referrer host, country, device, browser, OS, event name) and the raw rows are deleted. Monitor checks are kept 90 days. Backups are kept 12 weeks.

## Processor and location
Cloudflare (Workers, D1, Queues, KV, R2). The setup guide creates the D1 database and R2 buckets with the **EU jurisdiction** by default (`PULSE_JURISDICTION` and `--jurisdiction` choose another or none; docs/SELF-HOSTING.md).

## Install diagnostics
- Hits whose hostname isn't one of the site's domains are counted (`ingest_stats.dropped_host`), and the last such hostname is kept per site (`kv_meta`). A hostname is not personal data.
- Hits dropped by the site's exclusion rules (paths, hostnames, countries, referrers) are only counted (`dropped_excluded`, `dropped_bot`); revenue sent in another currency is removed from the event and counted (`revenue_ignored`).
- Hits from hosting and cloud networks are dropped for sites with `block_hosting` (on by default) and counted in `dropped_hosting`. The request's network is looked up from Cloudflare's own metadata only to make that decision; it is never stored, queued or logged. Hits dropped for Do Not Track / Global Privacy Control are counted in `dropped_dnt`.
- The installation check fetches the site's own home page from the Worker to look for the snippet and its Content-Security-Policy. No visitor data is involved.

## Deleting data
- A date range for a site: site settings → "Export or delete data" (or `POST /api/v1/sites/{site}/delete-data` with `{from, to, confirm: true}`, admin scope).
- A whole site: site settings → "Delete site and data" (or `DELETE /api/v1/sites/{site}?purge=true&confirm=<site id>`, admin scope). Archiving instead stops collection and keeps the data.
- Backups age out after 12 weeks.

## Access
Dashboard: Cloudflare Access one-time codes, no passwords; only the first owners (`ACCESS_EMAILS`) and people an admin added in Settings → People can sign in. Share links are read-only, limited to one site (and, when bound to a saved view, to that view's filters), optionally password-protected and expiring; only the SHA-256 hash of the token is stored, share pages are `noindex`, and they can be framed only by origins listed on the link. The realtime feed and the sessions explorer show pages, events and times, never visitor ids or IPs. API: hashed keys with scopes and per-site limits, editable without re-issuing. Heartbeat check URLs carry a random token stored only as a SHA-256 hash. Every change to sites, keys, people, checks and settings is in `audit_log` (Settings → Audit log).
