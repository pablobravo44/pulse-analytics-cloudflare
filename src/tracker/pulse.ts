/* Pulse tracker — cookieless. Docs: docs/TRACKER.md. Keep under 2.5 KB gzipped. */
type Props = Record<string, string | number | boolean>;
type Fn = ((...a: unknown[]) => void) & { q?: unknown[][]; track?: (n: string, p?: Props) => void; pageview?: (p?: string) => void };
interface W extends Window {
  pulse?: Fn;
}

((w: W, d: Document) => {
  const sc = d.currentScript as HTMLScriptElement | null;
  if (!sc || (w as unknown as { __pulse?: 1 }).__pulse) return;
  (w as unknown as { __pulse?: 1 }).__pulse = 1;
  const attr = (k: string) => sc.getAttribute("data-" + k);
  const site = attr("site") || "";
  const api = attr("api") || new URL(sc.src).origin + "/e";
  const loc = w.location;
  const nav = navigator;
  let ignored = false;
  try {
    // Opt-out, set only at the person's request: the owner's "ignore this browser" link (#pulse-ignore) or a site's visitor control.
    if (loc.hash === "#pulse-ignore") localStorage.setItem("pulse_ignore", "1");
    if (loc.hash === "#pulse-unignore") localStorage.removeItem("pulse_ignore");
    ignored = localStorage.getItem("pulse_ignore") === "1";
  } catch {
    /* storage blocked */
  }
  const off =
    !site ||
    ignored ||
    (attr("respect-dnt") === "true" && nav.doNotTrack === "1") ||
    (/^(localhost|127\.|\[::1\])/.test(loc.hostname) && attr("dev") === null) ||
    loc.protocol === "file:";
  const excl = (attr("exclude") || "")
    .split(",")
    .filter(Boolean)
    .map((g) => new RegExp("^" + g.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
  const rid = () => Math.random().toString(36).slice(2, 10);

  let pv = "";
  let path = "";
  let url = "";
  let last = 0;
  let shown = 0;
  let engaged = 0;
  let scroll = 0;
  const vit: Record<string, number> = {};
  let vitSent = false;
  let errs = 0;
  let ref = d.referrer;

  const send = (t: string, extra: Record<string, unknown> = {}, url = loc.href) => {
    if (off || excl.some((r) => r.test(loc.pathname))) return;
    const body = JSON.stringify({
      s: site,
      t,
      u: url,
      r: ref || undefined,
      ti: d.title,
      w: screen.width,
      h: screen.height,
      l: nav.language,
      pv,
      b: nav.webdriver ? 1 : undefined,
      ...extra,
    });
    if (!(nav.sendBeacon && nav.sendBeacon(api, new Blob([body], { type: "text/plain" }))))
      fetch(api, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } }).catch(() => {});
  };

  const flush = () => {
    if (shown) engaged += Date.now() - shown;
    shown = d.visibilityState === "visible" ? Date.now() : 0;
    if (pv && (engaged > 500 || scroll)) send("engagement", { e: engaged, sc: d.documentElement.scrollHeight <= w.innerHeight ? 100 : scroll }, url);
    engaged = 0;
    scroll = 0;
  };

  const pageview = (p?: string) => {
    const cur = p || loc.pathname + loc.search;
    const now = Date.now();
    if (cur === path && now - last < 500) return;
    if (pv) flush();
    path = cur;
    last = now;
    pv = rid();
    scroll = 0;
    shown = d.visibilityState === "visible" ? now : 0;
    url = p ? loc.origin + p : loc.href;
    send("pageview", {}, url);
    ref = "";
  };

  const track = (n: string, p?: Props) => send("event", { n: String(n).slice(0, 80), p });

  const pulse: Fn = (...a: unknown[]) => (a[0] === "404" ? track("404", { path: loc.pathname }) : track(a[0] as string, a[1] as Props));
  pulse.track = track;
  pulse.pageview = pageview;
  const q = w.pulse?.q || [];
  w.pulse = pulse;

  // SPA navigation
  const h = history;
  const spa = () => loc.pathname + loc.search !== path && pageview();
  const o = h.pushState;
  h.pushState = function (this: History, ...a: Parameters<History["pushState"]>) {
    o.apply(this, a);
    spa();
  };
  w.addEventListener("popstate", spa);

  // Engagement + scroll
  w.addEventListener(
    "scroll",
    () => {
      const el = d.documentElement;
      const max = el.scrollHeight - w.innerHeight;
      scroll = Math.max(scroll, max > 0 ? Math.min(100, Math.round((100 * w.scrollY) / max)) : 100);
    },
    { passive: true },
  );
  const hide = () => {
    hid = Math.min(hid, performance.now());
    flush();
    if (!vitSent && Object.keys(vit).length && attr("vitals") !== "false") {
      vitSent = true;
      send("vitals", { v: vit });
    }
  };
  d.addEventListener("visibilitychange", () => (d.visibilityState === "hidden" ? hide() : (shown = Date.now())));
  w.addEventListener("pagehide", hide);

  // Tagged events: data-pulse-event="name" (+ data-pulse-prop-<key>="value") on any element; forms send on submit.
  const tagged = (el: Element | null) => {
    if (!el) return;
    const p: Props = {};
    for (const at of el.attributes) if (at.name.startsWith("data-pulse-prop-")) p[at.name.slice(16)] = at.value;
    track(el.getAttribute("data-pulse-event") || "", p);
  };
  // data-forms="true" on the script: every other form sends form_submit with its id or name (never field values).
  d.addEventListener(
    "submit",
    (e) => {
      const f = e.target as HTMLFormElement;
      const t = f.closest?.("form[data-pulse-event]");
      if (t) tagged(t);
      else if (attr("forms") === "true") track("form_submit", { form: f.id || f.getAttribute("name") || "" });
    },
    true,
  );

  // Outbound links and downloads
  const www = (s: string) => s.replace(/^www\./, "");
  const click = (e: Event) => {
    const m = e as MouseEvent;
    if (m.type !== "click" && m.button !== 1) return; // auxclick: middle button only
    const t = (e.target as Element).closest?.("[data-pulse-event]");
    if (t && t.tagName !== "FORM" && m.type === "click") tagged(t);
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.href;
    if (/^(mailto|tel):/i.test(href)) return send("outbound", { x: href.split(":")[0] + ":" });
    if (a.hasAttribute("download") || /\.(pdf|zip|docx|xlsx|csv|mp4|ics|apk)(\?|#|$)/i.test(a.pathname)) return send("download", { x: href });
    const x = www(a.hostname);
    const y = www(loc.hostname);
    if (/^https?:/.test(href) && x !== y && !x.endsWith("." + y) && !y.endsWith("." + x)) send("outbound", { x: href });
  };
  d.addEventListener("click", click, true);
  d.addEventListener("auxclick", click, true);

  // Web vitals
  const po = (type: string, cb: (e: PerformanceEntry & Record<string, number>) => void, durationThreshold?: number) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((x) => cb(x as PerformanceEntry & Record<string, number>))).observe({ type, buffered: true, durationThreshold } as PerformanceObserverInit);
    } catch {
      /* unsupported */
    }
  };
  let hid = d.visibilityState === "hidden" ? 0 : 1 / 0; // when the page was first hidden: later LCP/INP are background noise
  let cls = 0;
  let win = 0;
  let wStart = 0;
  let wLast = 0;
  po("largest-contentful-paint", (x) => x.startTime <= hid && (vit.lcp = Math.round(x.startTime)));
  po("paint", (x) => x.name === "first-contentful-paint" && (vit.fcp = Math.round(x.startTime)));
  po("event", (x) => x.interactionId && x.startTime <= hid && (vit.inp = Math.max(vit.inp || 0, x.duration)), 16);
  po("layout-shift", (x) => {
    if (x.hadRecentInput) return;
    if (x.startTime - wLast > 1000 || x.startTime - wStart > 5000) {
      wStart = x.startTime;
      win = 0;
    }
    wLast = x.startTime;
    win += x.value || 0;
    cls = Math.max(cls, win);
    vit.cls = Math.round(cls * 1000) / 1000;
  });
  po("navigation", (x) => (vit.ttfb = Math.round(x.responseStart || 0)));

  // JS errors (opt-in)
  if (attr("errors") === "true") {
    const err = (msg: unknown, src = "", line = 0) => errs++ < 5 && send("error", { m: { msg: String(msg).slice(0, 200), src: src.split("?")[0], line } });
    w.addEventListener("error", (e) => err(e.message, e.filename, e.lineno));
    w.addEventListener("unhandledrejection", (e) => {
      const r = e.reason as { message?: string } | string | undefined;
      err(r && typeof r === "object" && "message" in r ? r.message : r || "Unhandled rejection");
    });
  }

  w.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      last = 0; // restored from the back/forward cache: a new view, even on the same path
      pageview();
    }
  });
  if ((d as { prerendering?: boolean }).prerendering) d.addEventListener("prerenderingchange", () => pageview(), { once: true });
  else pageview();
  for (const a of q) pulse(...a);
})(window as W, document);
