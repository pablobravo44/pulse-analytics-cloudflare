// Server-rendered technical documentation (/docs, /docs/agents, /docs/api) + small enhancement script (/docs/app.js).
import { SCOPES, SCOPE_INFO } from "../auth/principal.ts";
import { CAPABILITIES } from "../catalog.ts";
import { fullGuide } from "../guide.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type DocsPage = "guide" | "agents" | "api";

interface TocItem {
  id: string;
  label: string;
  level: 2 | 3;
  badge?: string;
  method?: string;
}

interface SidebarGroup {
  title: string;
  items: { href: string; label: string; badge?: string; method?: string; sub?: boolean }[];
}

interface PageMeta {
  page: DocsPage;
  title: string;
  description: string;
  sidebar: SidebarGroup[];
  toc: TocItem[];
  rightPanel?: string;
  prev?: { href: string; label: string; hint: string };
  next?: { href: string; label: string; hint: string };
  filterPlaceholder: string;
}

function makeSlugger() {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base =
      text
        .toLowerCase()
        .replace(/[`*_~]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };
}

function codeBlock(code: string, lang = "text"): string {
  const label = lang || "text";
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(label)}</span><button type="button" class="copy-btn" data-copy aria-label="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></div><pre tabindex="0"><code>${esc(code)}</code></pre></div>`;
}

function heading(level: 2 | 3, id: string, labelHtml: string, extra = ""): string {
  return `<h${level} id="${esc(id)}" class="anchor-h"${extra}><a class="anchor-link" href="#${esc(id)}" aria-label="Link to section">#</a><span>${labelHtml}</span></h${level}>`;
}

function methodBadge(method: string, compact = false): string {
  const m = method.toUpperCase();
  const cls = m === "GET" ? "m-get" : m === "POST" ? "m-post" : m === "DELETE" ? "m-del" : "m-put";
  const text = compact && m === "DELETE" ? "DEL" : m;
  return `<span class="method ${cls}${compact ? " method-sm" : ""}">${esc(text)}</span>`;
}

function formatRestOp(op: string): string {
  const idx = op.indexOf(" ");
  if (idx === -1) return `<code>${esc(op)}</code>`;
  const m = op.slice(0, idx);
  const p = op.slice(idx + 1);
  return `<span class="rest-op">${methodBadge(m, true)}<code>${formatPath(p)}</code></span>`;
}

function formatPath(path: string): string {
  return esc(path).replace(/\{([^}]+)\}/g, '<span class="path-param">{$1}</span>');
}

const PULSE_MARK = `<svg class="brand-mark" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#18213a"/><path d="M4 18h6l3-9 4 15 3-8h8" fill="none" stroke="#f1f4f2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="26" cy="16" r="2.4" fill="#f6e58d"/></svg>`;

const CSS = `
:root{
  color-scheme:light;
  --fog:#f3f4f7;
  --surface:#ffffff;
  --raised:#fafbfc;
  --ink:#171a2e;
  --ink-2:#565b73;
  --ink-3:#676c83;
  --line:#e4e6ed;
  --line-2:#eef0f4;
  --line-strong:#cfd3df;
  --acc:#7357f6;
  --acc-ink:#5c3fe6;
  --acc-soft:rgba(115,87,246,.09);
  --acc-ring:rgba(115,87,246,.28);
  --code-bg:#f6f7fb;
  --inline-bg:#eef0f8;
  --hover:rgba(23,26,46,.04);
  --m-get-fg:#0d6e4c;--m-get-bg:rgba(16,143,98,.11);
  --m-post-fg:#2457c5;--m-post-bg:rgba(62,123,250,.11);
  --m-put-fg:#8a4f00;--m-put-bg:rgba(210,112,10,.12);
  --m-del-fg:#a92626;--m-del-bg:rgba(181,45,45,.11);
  --header-h:58px;
  --sidebar-w:260px;
  --toc-w:244px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    color-scheme:dark;
    --fog:#0f1120;
    --surface:#171a2c;
    --raised:#1c1f33;
    --ink:#edeef6;
    --ink-2:#a8acc2;
    --ink-3:#8d92ab;
    --line:#2a2e45;
    --line-2:#22253a;
    --line-strong:#383d58;
    --acc:#8a70ff;
    --acc-ink:#b4a2ff;
    --acc-soft:rgba(138,112,255,.15);
    --acc-ring:rgba(138,112,255,.35);
    --code-bg:#111424;
    --inline-bg:#232740;
    --hover:rgba(237,238,246,.05);
    --m-get-fg:#4cc584;--m-get-bg:rgba(76,197,132,.14);
    --m-post-fg:#78a4ff;--m-post-bg:rgba(90,139,245,.16);
    --m-put-fg:#f0b454;--m-put-bg:rgba(232,169,72,.16);
    --m-del-fg:#f58484;--m-del-bg:rgba(240,114,114,.16);
  }
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --fog:#0f1120;
  --surface:#171a2c;
  --raised:#1c1f33;
  --ink:#edeef6;
  --ink-2:#a8acc2;
  --ink-3:#8d92ab;
  --line:#2a2e45;
  --line-2:#22253a;
  --line-strong:#383d58;
  --acc:#8a70ff;
  --acc-ink:#b4a2ff;
  --acc-soft:rgba(138,112,255,.15);
  --acc-ring:rgba(138,112,255,.35);
  --code-bg:#111424;
  --inline-bg:#232740;
  --hover:rgba(237,238,246,.05);
  --m-get-fg:#4cc584;--m-get-bg:rgba(76,197,132,.14);
  --m-post-fg:#78a4ff;--m-post-bg:rgba(90,139,245,.16);
  --m-put-fg:#f0b454;--m-put-bg:rgba(232,169,72,.16);
  --m-del-fg:#f58484;--m-del-bg:rgba(240,114,114,.16);
}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
body{
  margin:0;
  background:var(--surface);
  color:var(--ink);
  font:15px/1.68 "Instrument Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  text-rendering:optimizeLegibility;
}
a{color:var(--acc-ink);text-decoration:none;text-underline-offset:3px}
a:hover{text-decoration:underline}
.content p a,.content li a,.callout a,.ep-note a{
  text-decoration:underline;
  text-decoration-color:color-mix(in oklab,var(--acc-ink) 45%,transparent);
  text-decoration-thickness:1px;
}
.content p a:hover,.content li a:hover,.callout a:hover,.ep-note a:hover{
  text-decoration-color:currentColor;
}
.content p,.content li,.content td,.callout{overflow-wrap:anywhere}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{
  outline:2px solid var(--acc);
  outline-offset:2px;
  border-radius:6px;
}
.skip{
  position:absolute;left:-9999px;top:8px;z-index:100;
  background:var(--ink);color:var(--surface);padding:8px 12px;border-radius:8px;font-size:13px;font-weight:600;
}
.skip:focus{left:12px}

/* Top navigation bar */
.topbar{
  position:sticky;top:0;z-index:40;height:var(--header-h);
  background:color-mix(in oklab,var(--surface) 88%,transparent);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);
}
.topbar-inner{
  max-width:1440px;margin:0 auto;height:100%;padding:0 20px;
  display:flex;align-items:center;justify-content:space-between;gap:16px;
}
.topbar-left{display:flex;align-items:center;gap:14px;min-width:0}
.brand{display:inline-flex;align-items:center;gap:9px;color:var(--ink);font-weight:700;font-size:15.5px;letter-spacing:-.02em;text-decoration:none}
.brand:hover{text-decoration:none}
.brand-mark{display:block;flex:none;border-radius:6px}
.brand-pill{
  font-size:11.5px;font-weight:600;color:var(--ink-2);
  background:var(--fog);border:1px solid var(--line);border-radius:999px;padding:1px 8px;line-height:1.5;
}
.menu-btn{
  display:none;align-items:center;justify-content:center;width:34px;height:34px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;padding:0;
}
.menu-btn:hover{background:var(--hover)}
.topnav{display:flex;align-items:center;gap:4px;margin-left:8px}
.topnav a{
  padding:6px 11px;border-radius:8px;font-size:13.5px;font-weight:500;color:var(--ink-2);
  text-decoration:none;transition:background 120ms ease,color 120ms ease;
}
.topnav a:hover{background:var(--hover);color:var(--ink);text-decoration:none}
.topnav a[aria-current="page"]{background:var(--acc-soft);color:var(--acc-ink);font-weight:600}
.topbar-right{display:flex;align-items:center;gap:10px;min-width:0}
.filter-box{position:relative;display:flex;align-items:center;width:248px}
.filter-box svg{position:absolute;left:10px;color:var(--ink-3);pointer-events:none}
.filter-box input{
  width:100%;height:34px;padding:0 34px 0 32px;border-radius:8px;
  border:1px solid var(--line);background:var(--fog);color:var(--ink);
  font:inherit;font-size:13px;transition:border-color 120ms ease,background 120ms ease;
}
.filter-box input::placeholder{color:var(--ink-3)}
.filter-box input:focus{background:var(--surface);border-color:var(--acc);outline:none;box-shadow:0 0 0 3px var(--acc-ring)}
.filter-kbd{
  position:absolute;right:8px;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--ink-3);background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:3px 5px;pointer-events:none;
}
.icon-btn{
  display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink-2);cursor:pointer;padding:0;
}
.icon-btn:hover{background:var(--hover);color:var(--ink)}
.icon-btn .sun{display:none}
:root[data-theme="dark"] .icon-btn .sun{display:block}
:root[data-theme="dark"] .icon-btn .moon{display:none}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]) .icon-btn .sun{display:block}
  :root:not([data-theme="light"]) .icon-btn .moon{display:none}
}
.dash-link{
  display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;flex:none;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);
  font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap;
}
.dash-link:hover{background:var(--fog);border-color:var(--line-strong);text-decoration:none}

/* Three-column docs shell */
.shell{
  max-width:1440px;margin:0 auto;
  display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr) var(--toc-w);
  min-height:calc(100vh - var(--header-h));
}
.sidebar{
  position:sticky;top:var(--header-h);height:calc(100vh - var(--header-h));overflow-y:auto;
  padding:22px 16px 36px;background:var(--fog);border-right:1px solid var(--line);
  scrollbar-width:thin;
}
.sb-group{margin-bottom:22px}
.sb-group:last-child{margin-bottom:0}
.sb-title{
  font-size:11.5px;font-weight:600;color:var(--ink-3);letter-spacing:.01em;
  padding:0 10px 6px;display:flex;align-items:center;justify-content:space-between;
}
.sb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.sb-link{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:6px 10px;border-radius:7px;font-size:13.5px;line-height:1.35;color:var(--ink-2);
  text-decoration:none;transition:background 100ms ease,color 100ms ease;
}
.sb-link:hover{background:var(--hover);color:var(--ink);text-decoration:none}
.sb-link.is-active,.sb-link[aria-current="page"]{background:var(--acc-soft);color:var(--acc-ink);font-weight:600}
.sb-link.sb-sub{padding-left:20px;font-size:12.5px;color:var(--ink-3)}
.sb-link.sb-sub:hover{color:var(--ink)}
.sb-link.sb-sub.is-active{color:var(--acc-ink);font-weight:500}
.sb-link-ep{justify-content:flex-start;gap:7px;padding:4px 10px 4px 14px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sb-ep-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-badge{
  font-size:11px;font-weight:600;color:var(--ink-3);background:var(--surface);
  border:1px solid var(--line);border-radius:999px;padding:0 6px;line-height:1.5;flex:none;font-variant-numeric:tabular-nums;
}
.sb-mobile-pages{display:none}
.sb-backdrop{display:none}

/* Main reading column */
.content-wrap{min-width:0;padding:34px 48px 80px}
.content{max-width:780px;margin:0 auto}
.page-head{padding-bottom:22px;border-bottom:1px solid var(--line);margin-bottom:28px}
.page-head h1{
  margin:0 0 10px;font-size:32px;line-height:1.15;letter-spacing:-.03em;font-weight:700;
}
.lead{margin:0;font-size:16px;line-height:1.6;color:var(--ink-2);max-width:66ch}
.meta-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.meta-chip{
  display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2);
  background:var(--fog);border:1px solid var(--line);border-radius:8px;padding:4px 10px;
}
.meta-chip code{background:transparent;padding:0;font-size:12px;color:var(--ink)}
a.meta-chip:hover{border-color:var(--line-strong);color:var(--ink);text-decoration:none}

/* Mobile inline TOC fallback */
.toc-mobile{
  display:none;margin:0 0 24px;border:1px solid var(--line);border-radius:10px;
  background:var(--raised);overflow:hidden;
}
.toc-mobile summary{
  padding:10px 14px;font-size:13.5px;font-weight:600;color:var(--ink);cursor:pointer;list-style:none;
  display:flex;align-items:center;justify-content:space-between;
}
.toc-mobile summary::-webkit-details-marker{display:none}
.toc-mobile ul{list-style:none;margin:0;padding:4px 14px 12px;border-top:1px solid var(--line-2);display:flex;flex-direction:column;gap:4px}
.toc-mobile a{font-size:13px;color:var(--ink-2);display:block;padding:3px 0}
.toc-mobile .toc-l3{padding-left:14px;font-size:12.5px;color:var(--ink-3)}

/* Prose & headings */
h2.anchor-h{
  margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line);
  font-size:21px;line-height:1.25;letter-spacing:-.02em;font-weight:650;
  scroll-margin-top:calc(var(--header-h) + 20px);display:flex;align-items:center;gap:8px;
}
h3.anchor-h{
  margin:28px 0 10px;font-size:16.5px;line-height:1.35;letter-spacing:-.015em;font-weight:600;
  scroll-margin-top:calc(var(--header-h) + 20px);display:flex;align-items:center;gap:6px;
}
h4{margin:20px 0 8px;font-size:14.5px;font-weight:600;color:var(--ink)}
.anchor-link{
  margin-left:-20px;width:16px;text-align:right;color:var(--ink-3);font-weight:500;
  opacity:0;text-decoration:none;flex:none;transition:opacity 120ms ease;
}
.anchor-h:hover .anchor-link,.anchor-link:focus{opacity:1;color:var(--acc-ink);text-decoration:none}
p{margin:0 0 14px;color:var(--ink)}
ul,ol{margin:0 0 16px;padding-left:22px}
li{margin:5px 0}
li > ul,li > ol{margin:6px 0 6px}
hr{border:0;border-top:1px solid var(--line);margin:36px 0}
.mut{color:var(--ink-2)}
.tag-count{
  margin-left:auto;font-size:12px;font-weight:500;color:var(--ink-3);
  background:var(--fog);border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-variant-numeric:tabular-nums;
}

/* Inline code & code blocks */
code{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-size:13px;background:var(--inline-bg);color:var(--ink);padding:1.5px 5.5px;border-radius:5px;
}
.code-block{
  margin:14px 0 18px;border:1px solid var(--line);border-radius:10px;
  background:var(--code-bg);overflow:hidden;
}
.code-head{
  display:flex;align-items:center;justify-content:space-between;padding:6px 12px;
  background:var(--raised);border-bottom:1px solid var(--line-2);min-height:34px;
}
.code-lang{
  font:500 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink-3);
}
.copy-btn{
  display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;
  border:1px solid transparent;background:transparent;color:var(--ink-2);
  font:500 12px/1 inherit;cursor:pointer;transition:background 120ms ease,color 120ms ease,border-color 120ms ease;
}
.copy-btn:hover{background:var(--hover);color:var(--ink);border-color:var(--line)}
.copy-btn.is-copied{color:var(--m-get-fg)}
.code-block pre{
  margin:0;padding:14px 16px;overflow-x:auto;font:13px/1.65 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
.code-block pre code{background:transparent;padding:0;border-radius:0;font-size:inherit;color:var(--ink)}

/* Quickstart cards */
.cards-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0 28px}
.qcard{
  display:flex;flex-direction:column;gap:6px;padding:15px 16px;
  border:1px solid var(--line);border-radius:12px;background:var(--raised);
  color:var(--ink);text-decoration:none;transition:border-color 120ms ease,background 120ms ease;
}
.qcard:hover{border-color:var(--acc);background:var(--surface);text-decoration:none}
.qcard-title{font-size:14.5px;font-weight:600;color:var(--ink);display:flex;align-items:center;justify-content:space-between;gap:8px}
.qcard-desc{font-size:13px;line-height:1.5;color:var(--ink-2)}
.qcard-code{margin-top:auto;padding-top:6px;font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--acc-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Callouts */
.callout{
  margin:18px 0;padding:13px 16px;border-radius:10px;
  border:1px solid var(--line);border-left:3px solid var(--acc);background:var(--raised);
  font-size:14px;line-height:1.6;color:var(--ink-2);
}
.callout strong{color:var(--ink)}
.callout p:last-child{margin-bottom:0}

/* Tables */
.table-wrap{
  margin:14px 0 22px;overflow-x:auto;border:1px solid var(--line);
  border-radius:10px;background:var(--surface);
}
table{border-collapse:collapse;width:100%;font-size:13.5px;line-height:1.5}
th{
  background:var(--raised);color:var(--ink-2);font-weight:600;font-size:12.5px;
  text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap;
}
td{
  padding:9px 12px;border-bottom:1px solid var(--line-2);vertical-align:top;color:var(--ink);
}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--hover)}
td code{font-size:12.5px;word-break:break-word}

/* HTTP method badges & REST endpoints */
.method{
  display:inline-flex;align-items:center;justify-content:center;min-width:54px;
  padding:2.5px 7px;border-radius:6px;font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.03em;flex:none;
}
.method-sm{min-width:40px;padding:1.5px 5px;font-size:10px;border-radius:5px}
.m-get{color:var(--m-get-fg);background:var(--m-get-bg)}
.m-post{color:var(--m-post-fg);background:var(--m-post-bg)}
.m-put{color:var(--m-put-fg);background:var(--m-put-bg)}
.m-del{color:var(--m-del-fg);background:var(--m-del-bg)}
.rest-op{display:inline-flex;align-items:center;gap:6px;margin:2px 0;white-space:nowrap}
.rest-op code{background:transparent;padding:0;font-size:12.5px}
.path-param{color:var(--acc-ink);font-weight:600}

.endpoint{
  margin:14px 0 18px;border:1px solid var(--line);border-radius:12px;
  background:var(--surface);overflow:hidden;scroll-margin-top:calc(var(--header-h) + 20px);
}
.endpoint-head{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:11px 14px;background:var(--raised);border-bottom:1px solid var(--line-2);
}
.endpoint-path{
  font:600 13.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
  word-break:break-all;margin-right:auto;
}
.scope-pill{
  font:500 11.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink-2);
  background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:2px 8px;white-space:nowrap;
}
.ep-anchor{color:var(--ink-3);font-weight:600;padding:0 4px;text-decoration:none}
.ep-anchor:hover{color:var(--acc-ink);text-decoration:none}
.endpoint-body{padding:14px 16px}
.endpoint-body > p{margin:0 0 12px;font-size:14px;color:var(--ink-2)}
.endpoint-body > p:last-child{margin-bottom:0}
.ep-sub{font-size:12px;font-weight:600;color:var(--ink-3);margin:14px 0 6px}
.endpoint-body .table-wrap{margin:6px 0 4px}
.req-tag{
  display:inline-block;margin-left:5px;font-size:11px;font-weight:600;
  color:var(--m-del-fg);background:var(--m-del-bg);padding:0 5px;border-radius:4px;
}

/* Filter banner / empty state */
.filter-status{
  display:none;align-items:center;justify-content:space-between;gap:12px;
  padding:10px 14px;margin-bottom:18px;border-radius:10px;
  background:var(--acc-soft);border:1px solid var(--acc-ring);font-size:13.5px;color:var(--ink);
}
.filter-status.is-visible{display:flex}
.filter-clear{
  border:1px solid var(--line);background:var(--surface);color:var(--ink);
  border-radius:6px;padding:4px 10px;font:500 12.5px/1.2 inherit;cursor:pointer;
}
.filter-clear:hover{border-color:var(--line-strong)}
.is-filtered-out{display:none!important}

/* Page pager */
.pager{
  display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;
  margin-top:48px;padding-top:24px;border-top:1px solid var(--line);
}
.pager-card{
  display:flex;flex-direction:column;gap:3px;padding:13px 16px;
  border:1px solid var(--line);border-radius:10px;background:var(--raised);text-decoration:none;
}
.pager-card:hover{border-color:var(--acc);background:var(--surface);text-decoration:none}
.pager-next{text-align:right;grid-column:2}
.pager-dir{font-size:12px;color:var(--ink-3)}
.pager-label{font-size:14.5px;font-weight:600;color:var(--ink)}
.pager-hint{font-size:12.5px;color:var(--ink-2)}
.ep-note{font-size:13px;color:var(--ink-2);margin:0}
.quick-groups{margin-top:20px}

/* Right rail (On this page / Quick reference) */
.toc-rail{
  position:sticky;top:var(--header-h);height:calc(100vh - var(--header-h));overflow-y:auto;
  padding:26px 20px 36px 14px;scrollbar-width:thin;
}
.toc-title{font-size:12px;font-weight:600;color:var(--ink);margin:0 0 10px;padding-left:12px}
.toc-list{
  list-style:none;margin:0;padding:0;border-left:1px solid var(--line);
  display:flex;flex-direction:column;gap:2px;
}
.toc-link{
  display:block;padding:4px 0 4px 12px;margin-left:-1px;border-left:2px solid transparent;
  font-size:12.5px;line-height:1.4;color:var(--ink-3);text-decoration:none;
  transition:color 100ms ease,border-color 100ms ease;
}
.toc-link:hover{color:var(--ink);text-decoration:none}
.toc-link.is-active{color:var(--acc-ink);border-left-color:var(--acc);font-weight:500}
.toc-link.toc-l3{padding-left:22px;font-size:12px}
.quick-box{
  border:1px solid var(--line);border-radius:10px;background:var(--raised);padding:14px;font-size:12.5px;
}
.quick-box h2{margin:0 0 10px;font-size:12.5px;font-weight:600;color:var(--ink)}
.quick-kv{display:flex;flex-direction:column;gap:9px}
.quick-k{display:block;font-size:11.5px;color:var(--ink-3);margin-bottom:2px}
.quick-v{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.45;color:var(--ink);overflow-wrap:anywhere}
.quick-links{margin-top:12px;padding-top:10px;border-top:1px solid var(--line-2);display:flex;flex-direction:column;gap:5px}
.quick-links a{font-size:12.5px;color:var(--acc-ink)}

/* Responsive breakpoints */
@media (max-width:1240px){
  .shell{grid-template-columns:var(--sidebar-w) minmax(0,1fr)}
  .toc-rail{display:none}
  .content-wrap{padding:30px 36px 72px}
}
@media (max-width:1024px){
  .shell{grid-template-columns:minmax(0,1fr)}
  .menu-btn{display:inline-flex}
  .topnav{display:none}
  .sb-mobile-pages{display:block}
  .toc-mobile{display:block}
  .sidebar{
    position:fixed;top:var(--header-h);left:0;bottom:0;width:min(300px,86vw);z-index:50;
    height:auto;transform:translateX(-100%);transition:transform 180ms ease;box-shadow:0 20px 50px rgba(0,0,0,.25);
  }
  body.nav-open .sidebar{transform:translateX(0)}
  body.nav-open .sb-backdrop{
    display:block;position:fixed;inset:var(--header-h) 0 0 0;z-index:45;background:rgba(15,17,32,.48);
  }
  .content-wrap{padding:24px 20px 64px}
  .anchor-link{display:none}
}
@media (max-width:720px){
  .cards-3,.pager{grid-template-columns:minmax(0,1fr)}
  .pager-next{text-align:left;grid-column:auto}
  .filter-box{width:156px}
  .filter-kbd{display:none}
  .dash-link span{display:none}
  .page-head h1{font-size:26px}
}
@media (max-width:480px){
  .topbar-inner{padding:0 12px;gap:8px}
  .brand-pill{display:none}
  .filter-box{width:140px}
}
`;

export const DOCS_SCRIPT = `(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("pulse-theme");
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch {}

  const prefersDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const currentTheme = () => root.getAttribute("data-theme") || (prefersDark() ? "dark" : "light");

  document.addEventListener("DOMContentLoaded", () => {
    const themeBtn = document.querySelector("[data-theme-toggle]");
    if (themeBtn) {
      const syncLabel = () => {
        const dark = currentTheme() === "dark";
        themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
        themeBtn.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
      };
      syncLabel();
      themeBtn.addEventListener("click", () => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try { localStorage.setItem("pulse-theme", next); } catch {}
        syncLabel();
      });
    }

    const menuBtn = document.querySelector("[data-menu-toggle]");
    const backdrop = document.querySelector("[data-nav-backdrop]");
    const setNav = (open) => {
      document.body.classList.toggle("nav-open", open);
      if (menuBtn) menuBtn.setAttribute("aria-expanded", String(open));
    };
    if (menuBtn) menuBtn.addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
    if (backdrop) backdrop.addEventListener("click", () => setNav(false));
    document.querySelectorAll(".sidebar a").forEach((a) => a.addEventListener("click", () => setNav(false)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setNav(false); });

    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const block = btn.closest(".code-block");
        const explicit = btn.getAttribute("data-copy-text");
        const text = explicit || (block && block.querySelector("pre") ? block.querySelector("pre").textContent : "");
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          const span = btn.querySelector("span");
          const prev = span ? span.textContent : "";
          btn.classList.add("is-copied");
          if (span) span.textContent = "Copied";
          setTimeout(() => {
            btn.classList.remove("is-copied");
            if (span) span.textContent = prev || "Copy";
          }, 1500);
        } catch {}
      });
    });

    const input = document.querySelector("[data-filter]");
    const statusEl = document.querySelector("[data-filter-status]");
    const statusText = document.querySelector("[data-filter-text]");
    const clearBtn = document.querySelector("[data-filter-clear]");
    if (input) {
      const filterables = [...document.querySelectorAll("[data-filter-item]")];
      const groups = [...document.querySelectorAll("[data-filter-group]")];
      const applyFilter = () => {
        const q = input.value.trim().toLowerCase();
        if (!q) {
          filterables.forEach((el) => el.classList.remove("is-filtered-out"));
          groups.forEach((el) => el.classList.remove("is-filtered-out"));
          if (statusEl) statusEl.classList.remove("is-visible");
          return;
        }
        let shown = 0;
        filterables.forEach((el) => {
          const hay = (el.getAttribute("data-filter-text") || el.textContent || "").toLowerCase();
          const hit = hay.includes(q);
          el.classList.toggle("is-filtered-out", !hit);
          if (hit) shown++;
        });
        groups.slice().reverse().forEach((g) => {
          const children = [...g.querySelectorAll("[data-filter-item]")];
          const any = children.length ? children.some((c) => !c.classList.contains("is-filtered-out")) : (g.textContent || "").toLowerCase().includes(q);
          g.classList.toggle("is-filtered-out", !any);
        });
        if (statusEl && statusText) {
          statusEl.classList.add("is-visible");
          statusText.textContent = shown === 0 ? 'No matches for "' + input.value.trim() + '".' : shown + (shown === 1 ? " match" : " matches") + ' for "' + input.value.trim() + '".';
        }
      };
      input.addEventListener("input", applyFilter);
      if (clearBtn) clearBtn.addEventListener("click", () => { input.value = ""; applyFilter(); input.focus(); });
      document.addEventListener("keydown", (e) => {
        if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const tag = document.activeElement && document.activeElement.tagName;
          if (tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); input.focus(); input.select(); }
        } else if (e.key === "Escape" && document.activeElement === input) {
          input.value = ""; applyFilter(); input.blur();
        }
      });
    }

    const headings = [...document.querySelectorAll("main h2[id], main h3[id], main section.endpoint[id]")];
    const tocLinks = [...document.querySelectorAll('.toc-rail a[href^="#"], .sidebar a[href^="#"]')];
    if (headings.length && tocLinks.length && "IntersectionObserver" in window) {
      const byId = new Map();
      tocLinks.forEach((a) => {
        const id = a.getAttribute("href").slice(1);
        const arr = byId.get(id) || [];
        arr.push(a);
        byId.set(id, arr);
      });
      const tracked = headings.filter((h) => byId.has(h.id));
      let activeId = "";
      const setActive = (id) => {
        if (!id || id === activeId) return;
        activeId = id;
        tocLinks.forEach((a) => a.classList.remove("is-active"));
        (byId.get(id) || []).forEach((a) => a.classList.add("is-active"));
      };
      const io = new IntersectionObserver(
        (entries) => {
          const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible.length) setActive(visible[0].target.id);
        },
        { rootMargin: "-72px 0px -70% 0px", threshold: 0 },
      );
      tracked.forEach((el) => io.observe(el));
      if (tracked[0]) setActive(tracked[0].id);
    }
  });
})();
`;

export function layout(title: string, body: string, meta?: Partial<PageMeta>): string {
  const page = meta?.page ?? "guide";
  const sidebar = meta?.sidebar ?? [];
  const toc = meta?.toc ?? [];
  const filterPlaceholder = meta?.filterPlaceholder ?? "Filter page…";

  const pagesNav: { id: DocsPage; href: string; label: string }[] = [
    { id: "guide", href: "/docs", label: "Guide" },
    { id: "agents", href: "/docs/agents", label: "Agent guide" },
    { id: "api", href: "/docs/api", label: "API reference" },
  ];

  const sidebarHtml = `
    <div class="sb-group sb-mobile-pages">
      <div class="sb-title">Documentation</div>
      <ul class="sb-list">
        ${pagesNav
          .map((p) => `<li><a class="sb-link" href="${p.href}"${p.id === page ? ' aria-current="page"' : ""}><span>${esc(p.label)}</span></a></li>`)
          .join("")}
      </ul>
    </div>
    ${sidebar
      .map(
        (g) => `<div class="sb-group"><div class="sb-title">${esc(g.title)}</div><ul class="sb-list">${g.items
          .map((item) => {
            if (item.method) {
              return `<li><a class="sb-link sb-link-ep" href="${esc(item.href)}">${methodBadge(item.method, true)}<span class="sb-ep-path">${esc(item.label)}</span></a></li>`;
            }
            return `<li><a class="sb-link${item.sub ? " sb-sub" : ""}" href="${esc(item.href)}"><span>${esc(item.label)}</span>${item.badge ? `<span class="sb-badge">${esc(item.badge)}</span>` : ""}</a></li>`;
          })
          .join("")}</ul></div>`,
      )
      .join("")}
    <div class="sb-group">
      <div class="sb-title">Machine formats</div>
      <ul class="sb-list">
        <li><a class="sb-link" href="/api/v1/openapi.json"><span>OpenAPI 3.1 JSON</span></a></li>
        <li><a class="sb-link" href="/docs/agents.md"><span>Agent guide (.md)</span></a></li>
        <li><a class="sb-link" href="/llms.txt"><span>llms.txt</span></a></li>
      </ul>
    </div>`;

  const tocHtml = meta?.rightPanel
    ? meta.rightPanel
    : toc.length
      ? `<div class="toc-title">On this page</div><ul class="toc-list">${toc
          .map((t) => `<li><a class="toc-link${t.level === 3 ? " toc-l3" : ""}" href="#${esc(t.id)}">${esc(t.label)}</a></li>`)
          .join("")}</ul>`
      : "";

  const mobileTocHtml = toc.length
    ? `<details class="toc-mobile"><summary><span>On this page</span><span class="mut">${toc.length}</span></summary><ul>${toc
        .map((t) => `<li><a class="${t.level === 3 ? "toc-l3" : ""}" href="#${esc(t.id)}">${esc(t.label)}</a></li>`)
        .join("")}</ul></details>`
    : "";

  const pagerHtml =
    meta?.prev || meta?.next
      ? `<nav class="pager" aria-label="Adjacent documentation pages">${
          meta.prev
            ? `<a class="pager-card" href="${esc(meta.prev.href)}"><span class="pager-dir">← Previous</span><span class="pager-label">${esc(meta.prev.label)}</span><span class="pager-hint">${esc(meta.prev.hint)}</span></a>`
            : ""
        }${
          meta.next
            ? `<a class="pager-card pager-next" href="${esc(meta.next.href)}"><span class="pager-dir">Next →</span><span class="pager-label">${esc(meta.next.label)}</span><span class="pager-hint">${esc(meta.next.hint)}</span></a>`
            : ""
        }</nav>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="${esc(meta?.description ?? "Pulse cookieless analytics, uptime checks, REST API and MCP documentation.")}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>${esc(title)}</title>
  <style>${CSS}</style>
  <script src="/docs/app.js"></script>
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="topbar-left">
        <button type="button" class="menu-btn" data-menu-toggle aria-label="Toggle documentation navigation" aria-expanded="false">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
        <a class="brand" href="/docs">${PULSE_MARK}<span>Pulse</span><span class="brand-pill">Docs</span></a>
        <nav class="topnav" aria-label="Documentation sections">
          ${pagesNav
            .map((p) => `<a href="${p.href}"${p.id === page ? ' aria-current="page"' : ""}>${esc(p.label)}</a>`)
            .join("")}
        </nav>
      </div>
      <div class="topbar-right">
        <label class="filter-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" data-filter placeholder="${esc(filterPlaceholder)}" aria-label="${esc(filterPlaceholder)}">
          <span class="filter-kbd" aria-hidden="true">/</span>
        </label>
        <button type="button" class="icon-btn" data-theme-toggle aria-label="Switch color theme" title="Switch color theme">
          <svg class="moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          <svg class="sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        </button>
        <a class="dash-link" href="/"><span>Dashboard</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></a>
      </div>
    </div>
  </header>
  <div class="sb-backdrop" data-nav-backdrop></div>
  <div class="shell">
    <aside class="sidebar" aria-label="Documentation index">${sidebarHtml}</aside>
    <div class="content-wrap">
      <main id="content" class="content">
        <div class="filter-status" data-filter-status role="status" aria-live="polite">
          <span data-filter-text></span>
          <button type="button" class="filter-clear" data-filter-clear>Clear</button>
        </div>
        ${body.includes("<!--MOBILE_TOC-->") ? body.replace("<!--MOBILE_TOC-->", mobileTocHtml) : `${mobileTocHtml}${body}`}
        ${pagerHtml}
      </main>
    </div>
    <aside class="toc-rail" aria-label="On this page">${tocHtml}</aside>
  </div>
</body>
</html>`;
}

/** Markdown → structured HTML with deterministic heading anchors, copyable code blocks, callouts, nested lists, and tables. */
export function renderMarkdown(md: string): { html: string; toc: TocItem[] } {
  const slug = makeSlugger();
  const toc: TocItem[] = [];
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>');

  const out: string[] = [];
  const lines = md.split("\n");
  let openSection = false;
  const closeSection = () => {
    if (openSection) {
      out.push("</section>");
      openSection = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const lang = l.slice(3).trim() || "text";
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      out.push(codeBlock(code.join("\n"), lang));
    } else if (/^#{1,3} /.test(l)) {
      const hashes = l.indexOf(" ");
      const rawText = l.slice(hashes + 1).trim();
      const level = Math.min(hashes + 1, 4) as 2 | 3 | 4;
      const id = slug(rawText);
      if (level === 2) {
        closeSection();
        out.push(`<section data-filter-item>`);
        openSection = true;
        toc.push({ id, label: rawText, level: 2 });
        out.push(heading(2, id, inline(rawText)));
      } else if (level === 3) {
        toc.push({ id, label: rawText, level: 3 });
        out.push(heading(3, id, inline(rawText)));
      } else {
        out.push(`<h4 id="${esc(id)}">${inline(rawText)}</h4>`);
      }
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) {
        if (!/^\|[\s:-]+(?:\|[\s:-]+)*\|$/.test(lines[i]!)) {
          rows.push(
            lines[i]!
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim()),
          );
        }
      }
      i--;
      const [head, ...bodyRows] = rows;
      if (head) {
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${bodyRows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`,
        );
      }
    } else if (/^\s*(-|\d+\.) /.test(l)) {
      const ordered = /^\s*\d+\. /.test(l);
      const tag = ordered ? "ol" : "ul";
      const items: string[] = [];
      for (; i < lines.length && /^\s*(-|\d+\.) /.test(lines[i]!); i++) {
        const line = lines[i]!;
        const indent = line.search(/\S/);
        const text = inline(line.replace(/^\s*(-|\d+\.) /, ""));
        if (indent >= 2 && items.length > 0) {
          const prev = items.pop()!;
          const withSub = prev.endsWith("</ul></li>")
            ? prev.slice(0, -10) + `<li>${text}</li></ul></li>`
            : prev.slice(0, -5) + `<ul><li>${text}</li></ul></li>`;
          items.push(withSub);
        } else {
          items.push(`<li>${text}</li>`);
        }
      }
      i--;
      out.push(`<${tag}>${items.join("")}</${tag}>`);
    } else if (l.startsWith("> ")) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith("> "); i++) quote.push(inline(lines[i]!.slice(2)));
      i--;
      out.push(`<div class="callout"><p>${quote.join(" ")}</p></div>`);
    } else if (l === "---") {
      // Section headings already carry crisp hairline rules.
    } else if (l.trim()) {
      out.push(`<p>${inline(l)}</p>`);
    }
  }
  closeSection();
  return { html: out.join("\n"), toc };
}

/** Compatibility wrapper returning HTML only. */
export function markdown(md: string): string {
  return renderMarkdown(md).html;
}

export function guide(origin: string): string {
  const slug = makeSlugger();
  const groups = [...new Set(CAPABILITIES.map((c) => c.group))];
  const groupSlugs = new Map(groups.map((g) => [g, slug(`cap-${g}`)]));

  const toc: TocItem[] = [
    { id: "quickstart", label: "Quickstart", level: 2 },
    { id: "tracker", label: "Tracker", level: 2 },
    { id: "tracker-attributes", label: "Script attributes", level: 3 },
    { id: "events", label: "Tagged & custom events", level: 3 },
    { id: "mcp", label: "AI agents & MCP", level: 2 },
    { id: "mcp-clients", label: "Connect an agent", level: 3 },
    { id: "rest-api", label: "REST API", level: 2 },
    { id: "scopes", label: "Scopes", level: 2 },
    { id: "capabilities", label: "Capabilities", level: 2 },
    ...groups.map((g) => ({ id: groupSlugs.get(g)!, label: g, level: 3 as const })),
    { id: "privacy", label: "Privacy & data model", level: 2 },
  ];

  const sidebar: SidebarGroup[] = [
    {
      title: "Getting started",
      items: [
        { href: "#quickstart", label: "Quickstart" },
        { href: "#tracker", label: "Tracker" },
        { href: "#tracker-attributes", label: "Script attributes", sub: true },
        { href: "#events", label: "Tagged & custom events", sub: true },
      ],
    },
    {
      title: "Agents & API",
      items: [
        { href: "#mcp", label: "AI agents & MCP" },
        { href: "#mcp-clients", label: "Connect an agent", sub: true },
        { href: "#rest-api", label: "REST API" },
        { href: "#scopes", label: "Scopes", badge: String(SCOPES.length) },
      ],
    },
    {
      title: "Reference",
      items: [
        { href: "#capabilities", label: "Capabilities", badge: String(CAPABILITIES.length) },
        { href: "#privacy", label: "Privacy & data model" },
      ],
    },
  ];

  const trackerAttrs = [
    ["data-site", "required", "Site ID created in Pulse (e.g. my-app)."],
    ["data-api", "script origin", "Override the ingest endpoint URL if you proxy /e."],
    ["data-exclude", "none", 'Comma-separated path globs ignored by the tracker, e.g. "/admin/*,/preview/*".'],
    ["data-dev", "false", "Allow tracking on localhost / 127.0.0.1 for local testing."],
    ["data-respect-dnt", "false", 'Skip tracking when navigator.doNotTrack is "1".'],
    ["data-errors", "false", "Capture uncaught JS errors and unhandled promise rejections (enable Errors on the site too)."],
    ["data-vitals", "true", 'Set to "false" to turn off Core Web Vitals (LCP, INP, CLS).'],
    ["data-forms", "false", 'Automatically track untagged form submissions as form_submit using the form id or name.'],
  ];

  const body = `
    <div class="page-head">
      <h1>Pulse Documentation</h1>
      <p class="lead">Cookieless, privacy-first web analytics and uptime monitoring on Cloudflare Workers and D1 — with a typed REST API and a Streamable HTTP MCP server for AI agents.</p>
      <div class="meta-row">
        <span class="meta-chip">Tracker <code>&lt; 2.5 KB gzip</code></span>
        <span class="meta-chip">REST <code>${esc(origin)}/api/v1</code></span>
        <span class="meta-chip">MCP <code>${esc(origin)}/mcp</code></span>
        <a class="meta-chip" href="/docs/agents.md">Markdown guide</a>
      </div>
    </div>
    <!--MOBILE_TOC-->

    <section data-filter-group>
      ${heading(2, "quickstart", "Quickstart")}
      <div class="cards-3">
        <a class="qcard" href="#tracker" data-filter-item>
          <span class="qcard-title"><span>1. Track a website</span><span aria-hidden="true">→</span></span>
          <span class="qcard-desc">Add one deferred script tag to collect pageviews, SPA navigation, outbound clicks, downloads and Web Vitals.</span>
          <span class="qcard-code">&lt;script defer src="${esc(origin)}/p.js"&gt;</span>
        </a>
        <a class="qcard" href="#mcp" data-filter-item>
          <span class="qcard-title"><span>2. Connect an AI agent</span><span aria-hidden="true">→</span></span>
          <span class="qcard-desc">Give Claude Code, Cursor or claude.ai direct access to create sites, inspect traffic and manage checks via MCP.</span>
          <span class="qcard-code">${esc(origin)}/mcp</span>
        </a>
        <a class="qcard" href="#rest-api" data-filter-item>
          <span class="qcard-title"><span>3. Query the REST API</span><span aria-hidden="true">→</span></span>
          <span class="qcard-desc">Run composable metrics × dimensions × filters queries or pull OpenAPI 3.1 typed presets with a Bearer key.</span>
          <span class="qcard-code">GET /api/v1/sites/{site}/summary</span>
        </a>
      </div>
    </section>

    <section data-filter-item>
      ${heading(2, "tracker", "Tracker")}
      <p>Add one line inside the <code>&lt;head&gt;</code> of every page you want to measure. The script is deferred, sets no cookies or storage, and automatically tracks pageviews (including SPA route changes), engaged time, scroll depth, outbound links, file downloads and Core Web Vitals.</p>
      ${codeBlock(`<script defer src="${origin}/p.js" data-site="your-site-id"></script>`, "html")}
      <div class="callout">
        <p><strong>Content-Security-Policy:</strong> if your site sends a CSP header, add <code>${esc(origin)}</code> to <code>script-src</code> (and <code>script-src-elem</code> if present) and <code>connect-src</code>. Verify the live install anytime with <code>install_check</code> in MCP or Site settings → Verify install.</p>
      </div>

      ${heading(3, "tracker-attributes", "Script attributes")}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Attribute</th><th>Default</th><th>Behavior</th></tr></thead>
          <tbody>
            ${trackerAttrs
              .map(([a, d, b]) => `<tr><td><code>${esc(a)}</code></td><td><span class="mut">${esc(d)}</span></td><td>${esc(b)}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>

      ${heading(3, "events", "Tagged & custom events")}
      <p>Track clicks and form submissions without writing JavaScript by adding <code>data-pulse-event</code> and optional <code>data-pulse-prop-*</code> attributes (form field values are never collected):</p>
      ${codeBlock(`<button data-pulse-event="signup" data-pulse-prop-plan="pro">Start free</button>\n<form data-pulse-event="contact" data-pulse-prop-source="footer">…</form>`, "html")}
      <p>For programmatic events, revenue attribution, virtual pageviews or 404 tracking, use the lightweight queue snippet (safe to call before <code>p.js</code> finishes loading):</p>
      ${codeBlock(
        `window.pulse = window.pulse || function () { (window.pulse.q = window.pulse.q || []).push(arguments); };\n\npulse("signup", { plan: "pro" });                      // or pulse.track(name, props)\npulse("purchase", { revenue: 49.9, currency: "EUR" }); // numeric revenue in site currency\npulse("404");                                          // mark a not-found page\npulse.pageview("/virtual/checkout");                   // manual pageview`,
        "js",
      )}
      <p class="mut">Exclude your own browser by opening any tracked page once with <code>#pulse-ignore</code> (undo with <code>#pulse-unignore</code>), or expose an opt-out toggle that sets <code>localStorage.setItem("pulse_ignore", "1")</code>.</p>
    </section>

    <section data-filter-item>
      ${heading(2, "mcp", "AI agents & MCP")}
      <p>Pulse exposes a Streamable HTTP MCP server at <code>${esc(origin)}/mcp</code>. Agents only see the tools permitted by their key's scopes; <code>whoami</code> reports active scopes and sites, and <code>help</code> returns detailed guides for every topic. See the full <a href="/docs/agents">Agent guide</a> or <a href="/llms.txt">llms.txt</a>.</p>

      ${heading(3, "mcp-clients", "Connect an agent")}
      <h4>Claude Code</h4>
      ${codeBlock(`claude mcp add --transport http pulse ${origin}/mcp \\\n  --header "Authorization: Bearer $PULSE_KEY"`, "bash")}

      <h4>Cursor, VS Code &amp; JSON MCP clients</h4>
      ${codeBlock(
        JSON.stringify(
          {
            mcpServers: {
              pulse: {
                url: `${origin}/mcp`,
                headers: { Authorization: "Bearer pulse_sk_..." },
              },
            },
          },
          null,
          2,
        ),
        "json",
      )}

      <h4>claude.ai &amp; Claude Desktop (OAuth 2.1)</h4>
      <p>Add a custom connector with URL <code>${esc(origin)}/mcp</code>. You will sign in to your Pulse instance and pick the exact sites and scopes to grant — no static API key required.</p>

      <div class="callout">
        <p><strong>Connecting a new site with an agent:</strong> with a key that has <code>sites:write</code>, <code>definitions:write</code> and <code>ops:write</code> (or <code>admin</code>), an agent can call <code>save_site</code> → embed the returned <code>&lt;script&gt;</code> snippet → verify traffic with <code>install_check</code> → add goals (<code>save_goal</code>) and uptime monitors (<code>save_check</code>) end to end.</p>
      </div>
    </section>

    <section data-filter-item>
      ${heading(2, "rest-api", "REST API")}
      <p>Base URL <code>${esc(origin)}/api/v1</code> with header <code>Authorization: Bearer pulse_sk_…</code>. Call <code>GET /api/v1/</code> to inspect your key's scopes, allowed sites, and unlocked capabilities. Browse every endpoint in the <a href="/docs/api">API reference</a> or download <a href="/api/v1/openapi.json">openapi.json</a>.</p>
      ${codeBlock(`curl -H "Authorization: Bearer $PULSE_KEY" \\\n  "${origin}/api/v1/sites/example-site/summary?date_range=28d&compare=previous_period"`, "bash")}
      <ul>
        <li><strong>Conventions:</strong> JSON payloads, <code>snake_case</code> keys, ISO dates in the site's time zone (unless <code>timezone=UTC</code>).</li>
        <li><strong>Caching &amp; limits:</strong> Read endpoints return <code>ETag</code>. Rate limit is <strong>600 requests/min</strong> per API key (shared between REST and MCP).</li>
        <li><strong>Errors:</strong> Consistent envelope <code>{"error":{"code","message","details"}}</code>.</li>
      </ul>
    </section>

    <section data-filter-group>
      ${heading(2, "scopes", "Scopes")}
      <p>API keys and OAuth grants follow least privilege. Keys can also be restricted to specific site IDs.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Scope</th><th>Allows</th></tr></thead>
          <tbody>
            ${SCOPES.map((s) => `<tr data-filter-item><td><code>${esc(s)}</code></td><td>${esc(SCOPE_INFO[s])}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>

    <section data-filter-group>
      ${heading(2, "capabilities", "Capabilities")}
      <p>Every Pulse feature mapped across MCP tools, REST endpoints and required scopes. Use the top filter (<code>/</code>) to search by tool, path or scope.</p>
      ${groups
        .map((g) => {
          const items = CAPABILITIES.filter((c) => c.group === g);
          return `<div data-filter-group>${heading(3, groupSlugs.get(g)!, `${esc(g)} <span class="tag-count">${items.length}</span>`)}<div class="table-wrap"><table><thead><tr><th>Capability</th><th>MCP tool</th><th>REST</th><th>Scope</th></tr></thead><tbody>${items
            .map(
              (c) =>
                `<tr data-filter-item data-filter-text="${esc(`${g} ${c.summary} ${c.mcp ?? ""} ${c.rest.join(" ")} ${c.scope ?? "any"}`)}"><td>${esc(c.summary)}</td><td>${c.mcp ? `<code>${esc(c.mcp)}</code>` : `<span class="mut">${esc(c.mcpExclusion ?? "")}</span>`}</td><td>${c.rest.length ? c.rest.map(formatRestOp).join("<br>") : '<span class="mut">MCP only</span>'}</td><td>${c.scope ? `<code>${esc(c.scope)}</code>` : '<span class="mut">any</span>'}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`;
        })
        .join("")}
    </section>

    <section data-filter-item>
      ${heading(2, "privacy", "Privacy & data model")}
      <ul>
        <li><strong>Zero cookies or client storage:</strong> visitors are hashed via <code>HMAC(daily_salt, site | IP | user_agent)</code>. Salts rotate every UTC day and expire after 48 hours; IP addresses are never written to disk.</li>
        <li><strong>Session model:</strong> consecutive hits within 30 minutes form a session; single-pageview sessions with under 10 seconds of engaged time count as bounces.</li>
        <li><strong>Storage &amp; retention:</strong> all data lives in your own Cloudflare D1 database (EU jurisdiction by default). Raw events stay for each site's retention window (default 25 months) before rolling up into compact daily aggregates.</li>
      </ul>
    </section>
  `;

  return layout("Pulse Documentation", body, {
    page: "guide",
    description: "Pulse cookieless web analytics tracker, MCP server, REST API and scopes guide.",
    sidebar,
    toc,
    filterPlaceholder: "Filter guide…",
    next: { href: "/docs/agents", label: "Agent guide", hint: "Metrics, dimensions, filters, checks & recipes" },
  });
}

export function agentGuide(origin: string): string {
  const { html, toc } = renderMarkdown(fullGuide(origin));
  const topics = toc.filter((t) => t.level === 2);

  const sidebar: SidebarGroup[] = [
    {
      title: `Topics (${topics.length})`,
      items: topics.map((t) => ({ href: `#${t.id}`, label: t.label })),
    },
  ];

  const body = `
    <div class="page-head">
      <h1>Agent Guide</h1>
      <p class="lead">Complete reference for AI agents working with Pulse over MCP or REST — the exact specification served by the <code>help</code> tool, <code>pulse://guide</code> resource and <code>/docs/agents.md</code>.</p>
      <div class="meta-row">
        <a class="meta-chip" href="/docs/agents.md">Download raw Markdown</a>
        <a class="meta-chip" href="/llms.txt">View /llms.txt</a>
        <span class="meta-chip">MCP <code>${esc(origin)}/mcp</code></span>
      </div>
    </div>
    <!--MOBILE_TOC-->
    ${html}
  `;

  return layout("Pulse Agent Guide", body, {
    page: "agents",
    description: "Complete Pulse MCP & REST agent handbook covering metrics, dimensions, filters, tracker, checks and recipes.",
    sidebar,
    toc,
    filterPlaceholder: "Filter topics…",
    prev: { href: "/docs", label: "Guide", hint: "Quickstart, tracker setup & capabilities" },
    next: { href: "/docs/api", label: "API reference", hint: "Every REST endpoint, parameter & schema" },
  });
}

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
}

interface OpenApiParam {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface OpenApiOp {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  "x-required-scope"?: string | null;
  parameters?: OpenApiParam[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOp>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

function resolveSchema(schema: JsonSchema | undefined, schemas?: Record<string, JsonSchema>, depth = 0): JsonSchema | undefined {
  if (!schema || depth > 4) return schema;
  if (schema.$ref?.startsWith("#/components/schemas/")) {
    const name = schema.$ref.slice("#/components/schemas/".length);
    return resolveSchema(schemas?.[name], schemas, depth + 1);
  }
  return schema;
}

function summarizeType(raw?: JsonSchema, schemas?: Record<string, JsonSchema>, depth = 0): string {
  const schema = resolveSchema(raw, schemas, depth);
  if (!schema) return "any";
  if (schema.enum?.length) {
    const vals = schema.enum.slice(0, 6).map((v) => JSON.stringify(v)).join(" | ");
    return schema.enum.length > 6 ? `${vals} | …` : vals;
  }
  if (schema.anyOf?.length || schema.oneOf?.length) {
    const parts = (schema.anyOf ?? schema.oneOf ?? []).map((s) => summarizeType(s, schemas, depth + 1));
    return [...new Set(parts)].slice(0, 3).join(" | ");
  }
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") return `array<${summarizeType(schema.items, schemas, depth + 1)}>`;
  if (schema.type === "object" && schema.properties) return "object";
  return schema.type ?? "any";
}

function extractBodyFields(raw?: JsonSchema, schemas?: Record<string, JsonSchema>): { name: string; type: string; required: boolean; description: string }[] {
  const schema = resolveSchema(raw, schemas);
  if (!schema) return [];
  const obj = schema.properties ? schema : (schema.anyOf ?? schema.oneOf ?? []).map((s) => resolveSchema(s, schemas)).find((s) => s?.properties);
  if (!obj?.properties) return [];
  const req = new Set(obj.required ?? []);
  return Object.entries(obj.properties).map(([name, prop]) => {
    const resolved = resolveSchema(prop, schemas);
    return {
      name,
      type: summarizeType(resolved, schemas),
      required: req.has(name),
      description: resolved?.description ?? prop.description ?? "",
    };
  });
}

export function apiReference(doc: OpenApiDoc, origin = ""): string {
  const slug = makeSlugger();
  const base = origin ? `${origin}/api/v1` : "/api/v1";

  interface EndpointEntry {
    id: string;
    method: string;
    path: string;
    shortPath: string;
    scope: string | null;
    html: string;
  }

  const byTag = new Map<string, EndpointEntry[]>();
  let totalEndpoints = 0;

  const schemas = doc.components?.schemas;

  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      totalEndpoints++;
      const tag = op.tags?.[0] ?? "Other";
      const m = method.toUpperCase();
      const id = slug(op.operationId ?? `${m}-${path}`);
      const scope = op["x-required-scope"] ?? null;
      const params = (op.parameters ?? [])
        .map((p) => {
          const typeStr = summarizeType(p.schema, schemas);
          return `<tr><td><code>${esc(p.name)}</code>${p.required ? '<span class="req-tag">required</span>' : ""}</td><td><span class="mut">${esc(p.in)}</span></td><td><code>${esc(typeStr)}</code></td><td>${esc(p.description ?? "")}</td></tr>`;
        })
        .join("");

      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const bodyFields = extractBodyFields(bodySchema, schemas);
      const bodyHtml = bodyFields.length
        ? `<div class="ep-sub">JSON body</div><div class="table-wrap"><table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${bodyFields
            .map(
              (f) =>
                `<tr><td><code>${esc(f.name)}</code>${f.required ? '<span class="req-tag">required</span>' : ""}</td><td><code>${esc(f.type)}</code></td><td>${esc(f.description)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : op.requestBody
          ? `<div class="ep-sub">JSON body</div><p class="ep-note">Accepts a JSON payload — see <a href="/api/v1/openapi.json">openapi.json</a> for the full schema.</p>`
          : "";

      const filterText = `${tag} ${m} /api/v1${path} ${op.summary ?? ""} ${op.description ?? ""} ${scope ?? "any"}`;
      const cardHtml = `
        <section id="${esc(id)}" class="endpoint" data-filter-item data-filter-text="${esc(filterText)}">
          <div class="endpoint-head">
            ${methodBadge(m)}
            <span class="endpoint-path">/api/v1${formatPath(path)}</span>
            <span class="scope-pill">${scope ? `scope: ${esc(scope)}` : "any key"}</span>
            <a class="ep-anchor" href="#${esc(id)}" aria-label="Link to ${esc(m)} /api/v1${esc(path)}">#</a>
          </div>
          <div class="endpoint-body">
            <p>${esc(op.description ?? op.summary ?? "")}</p>
            ${
              params
                ? `<div class="ep-sub">Parameters</div><div class="table-wrap"><table><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>${params}</tbody></table></div>`
                : ""
            }
            ${bodyHtml}
          </div>
        </section>`;

      const shortPath = path === "/" ? "/" : path.replace(/^\/sites\/\{site\}/, "…");
      byTag.set(tag, [...(byTag.get(tag) ?? []), { id, method: m, path, shortPath, scope, html: cardHtml }]);
    }
  }

  const tagSlugs = new Map([...byTag.keys()].map((t) => [t, slug(`tag-${t}`)]));

  const sidebar: SidebarGroup[] = [
    ...[...byTag.entries()].map(([tag, items]) => ({
      title: `${tag} (${items.length})`,
      items: items.map((ep) => ({
        href: `#${ep.id}`,
        label: ep.shortPath,
        method: ep.method,
      })),
    })),
  ];

  const toc: TocItem[] = [...byTag.entries()].map(([tag, items]) => ({
    id: tagSlugs.get(tag)!,
    label: `${tag} (${items.length})`,
    level: 2,
  }));

  const rightPanel = `
    <div class="quick-box">
      <h2>API quick reference</h2>
      <div class="quick-kv">
        <div>
          <span class="quick-k">Base URL</span>
          <span class="quick-v">${esc(base)}</span>
        </div>
        <div>
          <span class="quick-k">Authentication</span>
          <span class="quick-v">Authorization: Bearer pulse_sk_…</span>
        </div>
        <div>
          <span class="quick-k">Rate limit</span>
          <span class="quick-v">600 requests / min per key</span>
        </div>
        <div>
          <span class="quick-k">Error shape</span>
          <span class="quick-v">{"error":{"code","message"}}</span>
        </div>
      </div>
      <div class="quick-links">
        <a href="/api/v1/openapi.json">Download openapi.json</a>
        <a href="/docs/agents">Agent guide (MCP)</a>
      </div>
    </div>
    <div class="quick-groups">
      <div class="toc-title">Resource groups</div>
      <ul class="toc-list">
        ${toc.map((t) => `<li><a class="toc-link" href="#${esc(t.id)}">${esc(t.label)}</a></li>`).join("")}
      </ul>
    </div>
  `;

  const body = `
    <div class="page-head">
      <h1>API Reference</h1>
      <p class="lead">Generated directly from Pulse's live OpenAPI 3.1 schema (${totalEndpoints} endpoints). Every read endpoint returns an <code>ETag</code> and every write endpoint enforces its listed scope.</p>
      <div class="meta-row">
        <span class="meta-chip">Base <code>${esc(base)}</code></span>
        <span class="meta-chip">Rate limit <code>600 req/min</code></span>
        <a class="meta-chip" href="/api/v1/openapi.json">OpenAPI 3.1 JSON</a>
      </div>
    </div>
    <!--MOBILE_TOC-->
    <div class="callout">
      <p><strong>Authentication:</strong> pass <code>Authorization: Bearer pulse_sk_…</code> on every call (or a dashboard session cookie plus <code>X-Pulse-Client: dashboard</code>). Call <code>GET /api/v1/</code> to verify your key's identity, scopes and accessible sites.</p>
    </div>
    ${[...byTag.entries()]
      .map(
        ([tag, items]) =>
          `<div data-filter-group>${heading(2, tagSlugs.get(tag)!, `${esc(tag)} <span class="tag-count">${items.length}</span>`)}${items.map((x) => x.html).join("")}</div>`,
      )
      .join("")}
  `;

  return layout("Pulse API Reference", body, {
    page: "api",
    description: "Pulse REST API v1 reference generated from OpenAPI 3.1.",
    sidebar,
    toc,
    rightPanel,
    filterPlaceholder: "Filter endpoints…",
    prev: { href: "/docs/agents", label: "Agent guide", hint: "MCP tools, metrics, filters & recipes" },
  });
}
