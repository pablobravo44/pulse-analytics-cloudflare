// The tracker in a simulated browser: pageview on load, custom events, tagged events on clicks and forms.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { enrich } from "../../src/worker/ingest/enrich.ts";
import { SITE, meta } from "./fixtures.ts";

// The jsdom window is used loosely (it has no lib.dom typings here).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
let code = "";
beforeAll(async () => {
  const out = await build({ entryPoints: ["src/tracker/pulse.ts"], bundle: true, minify: true, format: "iife", target: ["es2019"], write: false });
  code = out.outputFiles[0]!.text;
});

function page(html: string, attrs: Record<string, string> = {}, pre: (w: Win) => void = () => {}, url = "https://example.com/pricing") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: "outside-only" });
  const w = dom.window as unknown as Win;
  const sent: Record<string, unknown>[] = [];
  Object.defineProperty(w.navigator, "sendBeacon", {
    value: (_url: string, blob: Blob) => {
      void blob.text().then((t) => sent.push(JSON.parse(t)));
      return true;
    },
  });
  const script = w.document.createElement("script");
  script.src = "https://pulse.test/p.js";
  script.setAttribute("data-site", "test");
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  w.document.head.append(script);
  Object.defineProperty(w.document, "currentScript", { value: script, configurable: true });
  pre(w);
  w.eval(code);
  return { w, sent, flush: () => new Promise((r) => setTimeout(r, 20)) };
}

describe("tracker", () => {
  it("sends a pageview, then tagged events from clicks and form submits", async () => {
    const { w, sent, flush } = page(`<button id="b" data-pulse-event="signup" data-pulse-prop-plan="pro"><span id="inner">Go</span></button>
      <form id="f" data-pulse-event="contact" data-pulse-prop-form="footer"><input name="email" value="secret@example.com"></form>`);
    await flush();
    expect(sent[0]).toMatchObject({ s: "test", t: "pageview", u: "https://example.com/pricing" });
    w.document.getElementById("inner")!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    w.document.getElementById("f")!.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const events = sent.filter((x) => x.t === "event");
    expect(events.map((e) => [e.n, e.p])).toEqual([
      ["signup", { plan: "pro" }],
      ["contact", { form: "footer" }],
    ]);
    // Form field values are never sent.
    expect(JSON.stringify(sent)).not.toContain("secret@example.com");
  });

  it("data-forms sends form_submit for untagged forms, with the form's id and no field values", async () => {
    const html = `<form id="newsletter"><input name="email" value="secret@example.com"></form><form id="tagged" data-pulse-event="contact"></form>`;
    const off = page(html);
    off.w.document.getElementById("newsletter")!.dispatchEvent(new off.w.Event("submit", { bubbles: true, cancelable: true }));
    await off.flush();
    expect(off.sent.filter((x) => x.t === "event")).toEqual([]);
    const on = page(html, { "data-forms": "true" });
    on.w.document.getElementById("newsletter")!.dispatchEvent(new on.w.Event("submit", { bubbles: true, cancelable: true }));
    on.w.document.getElementById("tagged")!.dispatchEvent(new on.w.Event("submit", { bubbles: true, cancelable: true }));
    await on.flush();
    expect(on.sent.filter((x) => x.t === "event").map((e) => [e.n, e.p])).toEqual([
      ["form_submit", { form: "newsletter" }],
      ["contact", {}],
    ]);
    expect(JSON.stringify(on.sent)).not.toContain("secret@example.com");
  });

  it("custom events through the queue stub and pulse()", async () => {
    const { w, sent, flush } = page("");
    (w as unknown as { pulse: (n: string, p?: object) => void }).pulse("purchase", { revenue: 49.5 });
    await flush();
    expect(sent.find((x) => x.t === "event")).toMatchObject({ n: "purchase", p: { revenue: 49.5 } });
  });

  it("data-errors captures uncaught errors and unhandled promise rejections", async () => {
    const { w, sent, flush } = page("", { "data-errors": "true" });
    w.dispatchEvent(Object.assign(new w.Event("unhandledrejection"), { reason: new Error("fetch failed") }));
    await flush();
    expect(sent.find((x) => x.t === "error")).toMatchObject({ m: { msg: "fetch failed" } });
  });
});

type Entry = Record<string, unknown>;
const def = (o: object, k: string, value: unknown) => Object.defineProperty(o, k, { value, configurable: true, writable: true });

/** Stubs PerformanceObserver: records observe() options per entry type and lets the test deliver entries. */
function vitals(hidden = false) {
  const obs: Record<string, { cb: (l: { getEntries: () => Entry[] }) => void; opts: Record<string, unknown> }> = {};
  const pre = (w: Win) => {
    def(
      w,
      "PerformanceObserver",
      class {
        cb: (l: { getEntries: () => Entry[] }) => void;
        constructor(cb: (l: { getEntries: () => Entry[] }) => void) {
          this.cb = cb;
        }
        observe(o: Record<string, unknown>) {
          obs[o.type as string] = { cb: this.cb, opts: o };
        }
      },
    );
    if (hidden) def(w.document, "visibilityState", "hidden");
  };
  const feed = (type: string, e: Entry) => obs[type]!.cb({ getEntries: () => [e] });
  return { obs, pre, feed };
}

describe("tracker web vitals", () => {
  it("bug 1: ignores LCP and INP from a page that loaded hidden", async () => {
    const v = vitals(true);
    const { w, sent, flush } = page("", {}, v.pre);
    v.feed("largest-contentful-paint", { startTime: 120000 });
    v.feed("event", { startTime: 5000, duration: 27936, interactionId: 1 });
    v.feed("paint", { name: "first-contentful-paint", startTime: 300 });
    w.dispatchEvent(new w.Event("pagehide"));
    await flush();
    const vit = sent.find((x) => x.t === "vitals")!.v as Record<string, number>;
    expect(vit.fcp).toBe(300);
    expect(vit.lcp).toBeUndefined();
    expect(vit.inp).toBeUndefined();
  });

  it("bug 1: keeps LCP and INP from a page that was visible", async () => {
    const v = vitals();
    const { w, sent, flush } = page("", {}, v.pre);
    v.feed("largest-contentful-paint", { startTime: 1200 });
    v.feed("event", { startTime: 1500, duration: 240, interactionId: 1 });
    w.dispatchEvent(new w.Event("pagehide"));
    await flush();
    expect(sent.find((x) => x.t === "vitals")!.v).toMatchObject({ lcp: 1200, inp: 240 });
  });

  it("bug 2: observes events from 16 ms", () => {
    const v = vitals();
    page("", {}, v.pre);
    expect(v.obs.event!.opts).toMatchObject({ type: "event", durationThreshold: 16 });
  });

  it("bug 1 (server): LCP and INP above 60000 ms are dropped, not stored", async () => {
    const e = async (v: Record<string, number>) =>
      (await enrich({ s: SITE.id, t: "vitals", u: "https://example.com/", v } as never, SITE, meta(Date.UTC(2026, 9, 12, 10)), "salt-1")) as { lcp: number | null; inp: number | null; fcp: number | null };
    expect(await e({ lcp: 120000, inp: 27936 + 40000, fcp: 900 })).toMatchObject({ lcp: null, inp: null, fcp: 900 });
    expect(await e({ lcp: 60000, inp: 300 })).toMatchObject({ lcp: 60000, inp: 300 });
  });
});

describe("tracker outbound links and downloads", () => {
  const links = `<a id="sub" href="https://blog.example.com/a">s</a><a id="www" href="https://www.example.com/b">w</a>
    <a id="ext" href="https://other.org/c">e</a><a id="dl" href="/files/report" download>d</a><a id="pdf" href="/x.pdf">p</a>
    <a id="up" href="https://example.com/z">same</a>`;
  const hits = (sent: Record<string, unknown>[]) => sent.filter((x) => x.t === "outbound" || x.t === "download").map((x) => [x.t, x.x]);

  it("bug 5: www and subdomain links of the same site are internal; other hosts are outbound", async () => {
    const { w, sent, flush } = page(links);
    for (const id of ["sub", "www", "up", "ext"]) w.document.getElementById(id)!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(hits(sent)).toEqual([["outbound", "https://other.org/c"]]);
  });

  it("bug 5: www on the page itself is stripped too", async () => {
    const { w, sent, flush } = page(`<a id="a" href="https://example.com/q">x</a>`, {}, undefined, "https://www.example.com/");
    w.document.getElementById("a")!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(hits(sent)).toEqual([]);
  });

  it("bug 5: a[download] counts as a download", async () => {
    const { w, sent, flush } = page(links);
    w.document.getElementById("dl")!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    w.document.getElementById("pdf")!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(hits(sent)).toEqual([
      ["download", "https://example.com/files/report"],
      ["download", "https://example.com/x.pdf"],
    ]);
  });

  it("bug 5: middle-click (auxclick button 1) counts once; other buttons do not", async () => {
    const { w, sent, flush } = page(links);
    const ext = w.document.getElementById("ext")!;
    ext.dispatchEvent(new w.MouseEvent("auxclick", { bubbles: true, button: 1 }));
    ext.dispatchEvent(new w.MouseEvent("auxclick", { bubbles: true, button: 2 }));
    await flush();
    expect(hits(sent)).toEqual([["outbound", "https://other.org/c"]]);
  });
});

describe("tracker engagement and lifecycle", () => {
  const visible = (w: Win) => def(w.document, "visibilityState", "visible");
  const hideAt = (w: Win, t: number) => {
    w.Date.now = () => t;
    def(w.document, "visibilityState", "hidden");
    w.document.dispatchEvent(new w.Event("visibilitychange"));
  };

  it("bug 6: a page with nothing to scroll reports 100 % scroll depth", async () => {
    const { w, sent, flush } = page("", {}, (w) => {
      visible(w);
      w.Date.now = () => 1000;
    });
    hideAt(w, 4000);
    await flush();
    expect(sent.find((x) => x.t === "engagement")).toMatchObject({ e: 3000, sc: 100 });
  });

  it("bug 6: no engagement beacon when engaged <= 500 ms and no scroll", async () => {
    const { w, sent, flush } = page("", {}, (w) => {
      visible(w);
      w.Date.now = () => 1000;
    });
    hideAt(w, 1400);
    await flush();
    expect(sent.filter((x) => x.t === "engagement")).toEqual([]);
  });

  it("flush resets scroll so a second hide without activity does not send a duplicate e=0 engagement beacon", async () => {
    const { w, sent, flush } = page("", {}, (w) => {
      visible(w);
      w.Date.now = () => 1000;
    });
    w.dispatchEvent(new w.Event("scroll"));
    hideAt(w, 2500);
    hideAt(w, 2600);
    await flush();
    expect(sent.filter((x) => x.t === "engagement")).toHaveLength(1);
  });

  it("bug 7: a prerendered page counts on prerenderingchange, not at load", async () => {
    const { w, sent, flush } = page("", {}, (w) => def(w.document, "prerendering", true));
    await flush();
    expect(sent.filter((x) => x.t === "pageview")).toEqual([]);
    w.document.dispatchEvent(new w.Event("prerenderingchange"));
    await flush();
    expect(sent.filter((x) => x.t === "pageview")).toHaveLength(1);
  });

  it("bug 7: a page restored from the bfcache counts again with a new pageview id", async () => {
    const { w, sent, flush } = page("");
    const pageshow = (persisted: boolean) => w.dispatchEvent(Object.assign(new w.Event("pageshow"), { persisted }));
    pageshow(false);
    await flush();
    expect(sent.filter((x) => x.t === "pageview")).toHaveLength(1);
    pageshow(true);
    await flush();
    const pvs = sent.filter((x) => x.t === "pageview");
    expect(pvs).toHaveLength(2);
    expect(pvs[1]!.pv).not.toBe(pvs[0]!.pv);
    expect(pvs[1]!.u).toBe(pvs[0]!.u);
  });
});

describe("tracker SPA navigation", () => {
  const views = (sent: Record<string, unknown>[]) => sent.filter((x) => x.t === "pageview").map((x) => x.u);

  it("bug 3: replaceState never counts", async () => {
    const { w, sent, flush } = page("");
    w.history.replaceState(null, "", "/replaced");
    await flush();
    expect(views(sent)).toEqual(["https://example.com/pricing"]);
  });

  it("bug 3: pushState counts only when path or query changed, not for a hash", async () => {
    const { w, sent, flush } = page("");
    let t = 1e12;
    w.Date.now = () => (t += 1000); // beyond the 500 ms same-path dedup, so only the path check can suppress
    w.history.pushState(null, "", "/pricing#faq");
    w.history.pushState(null, "", "/pricing?tab=2");
    w.history.pushState(null, "", "/pricing?tab=2#x");
    w.history.pushState(null, "", "/docs");
    await flush();
    expect(views(sent)).toEqual(["https://example.com/pricing", "https://example.com/pricing?tab=2", "https://example.com/docs"]);
  });

  it("bug 3: pulse.pageview(path) still always counts", async () => {
    const { w, sent, flush } = page("");
    (w as unknown as { pulse: { pageview: (p: string) => void } }).pulse.pageview("/virtual");
    await flush();
    expect(views(sent)).toEqual(["https://example.com/pricing", "https://example.com/virtual"]);
  });

  it("bug 4: the engagement beacon of page A carries page A's URL", async () => {
    const { w, sent, flush } = page("");
    w.dispatchEvent(new w.Event("scroll"));
    w.history.pushState(null, "", "/next");
    await flush();
    expect(sent.find((x) => x.t === "engagement")!.u).toBe("https://example.com/pricing");
    expect(views(sent)).toEqual(["https://example.com/pricing", "https://example.com/next"]);
  });
});
