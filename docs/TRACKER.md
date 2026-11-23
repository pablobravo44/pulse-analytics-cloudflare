# Tracker

```html
<script defer src="https://pulse.example.com/p.js" data-site="example"></script>
```

`/p.js` is cached for an hour; `/p.v1.js` is the same file, immutable for a year.

## Attributes
| Attribute | Effect |
|---|---|
| `data-site` | Site id (required) |
| `data-api` | Ingest URL (default: the script's origin + `/e`) |
| `data-exclude` | Comma-separated path globs not to track, e.g. `/admin/*,/t/*` |
| `data-dev` | Allow `localhost` |
| `data-respect-dnt="true"` | Don't send when `navigator.doNotTrack === "1"` |
| `data-errors="true"` | Send uncaught JavaScript errors and unhandled promise rejections (max 5 per page). The site setting must allow errors too |
| `data-vitals="false"` | Don't send Core Web Vitals |
| `data-forms="true"` | Every form without `data-pulse-event` sends a `form_submit` event with the form's `id` or `name` (never field values) |

## API
```js
// Before the script loads (queue stub):
window.pulse = window.pulse || function () { (window.pulse.q = window.pulse.q || []).push(arguments) };

pulse("signup", { plan: "pro" });        // custom event
pulse.track("signup", { plan: "pro" });  // same
pulse.pageview("/virtual/path");         // manual pageview
pulse("404");                            // marks a not-found page (event "404" with the path)
```
Limits: names ≤ 80 characters; up to 20 props; values are strings (≤ 200), numbers or booleans.

### Tagged events (no JavaScript)
```html
<button data-pulse-event="signup" data-pulse-prop-plan="pro">Start</button>
<form data-pulse-event="contact" data-pulse-prop-form="footer">…</form>  <!-- sent on submit; field values never -->
```

### Revenue
Send a numeric `revenue` property (and optionally `currency`) on the event that completes a purchase:
```js
pulse("purchase", { revenue: 49.9, currency: "EUR" });
```
The query engine then has `revenue`, `average_revenue` and `revenue_per_visitor`; the site's `revenue_currency` setting is used for display. Revenue sent with a different `currency` is ignored (the event is kept) and counted in the install check, so totals never mix currencies.

### Not-found pages
Call `pulse("404")` from your 404 template; the overview's Pages panel has a "Not found" tab listing the paths.
- Next.js (app router): in `app/not-found.tsx`, a client component with `useEffect(() => window.pulse?.("404"), [])`.
- Astro: in `src/pages/404.astro`, `<script>window.pulse?.("404")</script>`.
- WordPress: in the theme's `404.php`, `<script>window.pulse && pulse("404")</script>`.
- Static hosts: add the same script tag to `404.html`.

### Site search
List your search query parameters in the site's settings (`search_params`, e.g. `q`). The term (lowercased, ≤ 100 characters) becomes the `search_term` dimension. Nothing else in the query string is kept.

### Short links
`/l/<slug>` links created in the site's settings (or `POST /api/v1/sites/{site}/links`) record a `link_click` event with `slug` and `campaign` and redirect.

- **Pageviews**, including SPA navigation (`pushState` and `popstate`, only when the path or query changed; `replaceState` and hash-only changes do not count; `pulse.pageview(path)` always does, except the same path within 500 ms). Prerendered pages count when they are activated, and pages restored from the back/forward cache count again. The referrer is sent with the first pageview only.
- **Engagement**: visible time and maximum scroll depth (100 when the page cannot scroll), sent with the page's own URL as an `engagement` hit when the page is hidden or on the next SPA navigation.
- **Outbound clicks** (left and middle click; `mailto:`/`tel:` record only the scheme; `www.` and subdomains of the same site are internal) and **downloads** (`a[download]` or `pdf zip docx xlsx csv mp4 ics apk`).
- **Web vitals**: LCP, INP (worst interaction of 16 ms or more), CLS (session windows), FCP, TTFB, once per page when it is hidden. LCP and INP from a page that loaded or was first hidden in the background are ignored; the server drops values above 60 s.

## Transport
`navigator.sendBeacon` with a `text/plain` Blob, falling back to `fetch(…, {keepalive: true, credentials: "omit"})`. Payload keys: `s t u r ti w h l n p pv e sc v b x m`.

## Privacy
No cookies, no `localStorage`/`sessionStorage`. The single exception is the opt-out flag `pulse_ignore=1` in the site's `localStorage`, stored only when someone asks not to be counted; while it is set the script sends nothing (read when the script starts, so it applies from the next page). Automated browsers (`navigator.webdriver`) are flagged and dropped.
- **You (site operator):** opening a site with `#pulse-ignore` sets it (`#pulse-unignore` removes it). Settings → Site has the links.
- **Visitors (right to object):** the site offers its own control, usually at the end of its cookie policy, that sets or removes the flag. Exemptions from consent for audience measurement (see docs/PRIVACY.md) usually expect visitors to be able to object:
```js
localStorage.setItem("pulse_ignore", "1");  // don't count my visits
localStorage.removeItem("pulse_ignore");    // count them again
```
Add `data-respect-dnt="true"` as well, so Do Not Track is honoured.

