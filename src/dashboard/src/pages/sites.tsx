import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, RefreshCw, X } from "../components/icons.tsx";
import { useEffect, useMemo, useState } from "react";
import { type SiteInfo } from "../components/Shell.tsx";
import { ago, CopyField, ErrorBox, Field, Section, Tabs, useToast } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";

export function cleanDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  const wild = d.startsWith("*.");
  if (wild) d = d.slice(2);
  d = d
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(d) || /^[\d.]+$/.test(d)) return null;
  return wild ? `*.${d}` : d;
}

export function slugFor(source: string): string {
  const base = source
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\.(com|org|net|io|dev|app|es|co|eu|info|me|site)$/, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base.length >= 2 ? base : "";
}

export function DomainsInput({
  value,
  onChange,
  onDraftChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  /** What's typed but not yet a chip, so a form can count it (typing a domain and pressing Add just works). */
  onDraftChange?: (draft: string) => void;
}) {
  const [draft, setDraftState] = useState("");
  const setDraft = (v: string) => {
    setDraftState(v);
    onDraftChange?.(v);
  };
  const [bad, setBad] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\s,]+/).filter(Boolean);
    const next = [...value];
    for (const p of parts) {
      const d = cleanDomain(p);
      if (!d) {
        setBad(p);
        return;
      }
      if (!next.includes(d)) next.push(d);
    }
    setBad(null);
    onChange(next);
    setDraft("");
  };
  const apex = value.find((d) => !d.startsWith("www.") && !d.startsWith("*.") && d.split(".").length === 2);
  const suggestWww = apex && !value.includes(`www.${apex}`) ? `www.${apex}` : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-[6px] border border-rule bg-sheet px-2 py-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]">
        {value.map((d) => (
          <span key={d} className="chip">
            {d}
            <button
              type="button"
              className="rounded-[4px] p-0.5 text-ink-2 hover:bg-bar"
              aria-label={t("Remove {d}", { d })}
              onClick={() => onChange(value.filter((x) => x !== d))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-ink-3"
          value={draft}
          placeholder={value.length ? t("Add another domain") : t("example.com or https://www.example.com")}
          aria-label={t("Domains")}
          onChange={(e) => {
            setBad(null);
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === " ") {
              if (draft.trim()) {
                e.preventDefault();
                add(draft);
              }
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[\s,]/.test(pasted.trim())) {
              e.preventDefault();
              add(pasted);
            }
          }}
        />
      </div>
      {bad && (
        <span className="text-xs text-down">
          {t("“{bad}” isn't a domain a site can be served from.", { bad })}
        </span>
      )}
      {suggestWww && (
        <button
          type="button"
          className="self-start text-xs text-ink-2 hover:text-ink"
          onClick={() => onChange([...value, suggestWww])}
        >
          {t("+ Also add {domain} (if the site is reachable with www)", { domain: suggestWww })}
        </button>
      )}
    </div>
  );
}

export function TimezoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      return ["UTC", "Europe/Madrid", "Europe/London", "America/New_York", "America/Mexico_City"];
    }
  }, []);
  return (
    <>
      <input
        className="input"
        list="tz-list"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("Time zone")}
      />
      <datalist id="tz-list">
        {["UTC", ...zones].map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

interface Finding {
  level: "ok" | "info" | "warn" | "error";
  code: string;
  message: string;
  fix?: string;
}
interface CheckRes {
  status: "receiving" | "installed" | "waiting";
  last_pageview_at: string | null;
  snippet: string;
  findings: Finding[];
}

const LEVEL: Record<Finding["level"], { g: string; cls: string }> = {
  ok: { g: "●", cls: "text-live" },
  info: { g: "○", cls: "text-ink-3" },
  warn: { g: "▲", cls: "text-warn" },
  error: { g: "✕", cls: "text-down" },
};

/** Polls the installation check until data arrives (or 2 minutes pass). */
export function InstallCheck({ site, auto = false }: { site: string; auto?: boolean }) {
  const [polling, setPolling] = useState(auto);
  const [started, setStarted] = useState(auto ? Date.now() : 0);
  const q = useQuery({
    queryKey: ["install", site],
    queryFn: () => api.get<{ data: CheckRes }>(`/api/v1/sites/${site}/install-check`),
    enabled: polling || started > 0,
    refetchInterval: (query) =>
      polling && query.state.data?.data.status !== "receiving" && Date.now() - started < 120_000
        ? 5000
        : false,
  });
  useEffect(() => {
    if (q.data?.data.status === "receiving") setPolling(false);
  }, [q.data]);
  const status = q.data?.data.status;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setStarted(Date.now());
            setPolling(true);
            void q.refetch();
          }}
          disabled={q.isFetching}
        >
          <RefreshCw size={14} className={q.isFetching ? "animate-spin" : ""} aria-hidden="true" />{" "}
          {t("Check installation")}
        </button>
        {status && (
          <span className={`text-sm font-medium ${status === "receiving" ? "text-live" : "text-ink-2"}`}>
            {status === "receiving"
              ? t("● Receiving data. Last pageview {ago}.", { ago: ago(q.data!.data.last_pageview_at) })
              : status === "installed"
                ? t("Snippet found; waiting for the first pageview.")
                : polling
                  ? t("Waiting for the first pageview… open the site in another tab.")
                  : t("Not receiving data yet.")}
          </span>
        )}
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <ul className="flex flex-col gap-2">
          {q.data.data.findings.map((f, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span className={`w-4 shrink-0 text-center ${LEVEL[f.level].cls}`} aria-hidden="true">
                {LEVEL[f.level].g}
              </span>
              <span>
                {f.message}
                {f.fix && <span className="block text-ink-2">{f.fix}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SnippetTabs({ site }: { site: string }) {
  const origin = location.origin;
  const [tab, setTab] = useState<"html" | "next" | "astro" | "events">("html");
  const code = {
    html: `<script defer src="${origin}/p.js" data-site="${site}"></script>`,
    next: `// app/layout.tsx\nimport Script from "next/script";\n\n<Script defer src="${origin}/p.js" data-site="${site}" strategy="afterInteractive" />`,
    astro: `<!-- src/layouts/Base.astro, inside <head> -->\n<script is:inline defer src="${origin}/p.js" data-site="${site}"></script>`,
    events: `window.pulse = window.pulse || function () { (window.pulse.q = window.pulse.q || []).push(arguments) };\npulse("signup", { plan: "pro" });   // a custom event\npulse("404");                        // on your not-found page`,
  }[tab];
  return (
    <div className="flex flex-col gap-2">
      <Tabs
        label={t("Snippet for")}
        value={tab}
        onChange={setTab}
        options={[
          { value: "html", label: "HTML" },
          { value: "next", label: "Next.js" },
          { value: "astro", label: "Astro" },
          { value: "events", label: t("Custom events") },
        ]}
      />
      <CopyField value={code} />
      <p className="text-xs text-ink-3">
        {tab === "events"
          ? t(
              "Event names up to 80 characters; up to 20 properties (text, numbers, true/false). Never send personal data.",
            )
          : t("Add it to the <head> of every page. No cookies, so no consent banner is needed for Pulse.")}
      </p>
    </div>
  );
}

export function AddSitePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [chips, setDomains] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  // A domain still being typed counts too: nobody should have to press Enter before Add site works.
  const pending = typed.trim() ? cleanDomain(typed.trim()) : null;
  const domains = pending && !chips.includes(pending) ? [...chips, pending] : chips;
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [created, setCreated] = useState<SiteInfo | null>(null);
  const autoId = slugFor(name || domains[0] || "");
  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: SiteInfo }>("/api/v1/sites", {
        domains,
        timezone: tz,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(idTouched && id ? { id } : {}),
      }),
    onSuccess: (r) => {
      setCreated(r.data);
      void qc.invalidateQueries({ queryKey: ["sites"] });
      toast(t("{name} added", { name: r.data.name }));
    },
  });
  const step = created ? 3 : 1;
  return (
    <div className="max-w-[720px]">
      <header className="mb-6">
        <h1 className="t-title">{t("Add a site")}</h1>
        <p className="text-sm text-ink-2">
          {t("Three steps: where it lives, its time zone, then the snippet.")}
        </p>
      </header>
      <ol className="flex flex-col gap-8">
        <li className={step === 3 ? "opacity-60" : ""}>
          <Section title={t("1. Name and domains")}>
            <div className="grid gap-4">
              <Field
                group
                label={t("Domains")}
                hint={t(
                  "Every hostname that serves the site. Full URLs are fine; *.example.com allows all subdomains.",
                )}
              >
                <DomainsInput value={chips} onChange={setDomains} onDraftChange={setTyped} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Name")} hint={t("How it appears in Pulse. Defaults to the first domain.")}>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={domains[0] ?? t("My site")}
                    disabled={!!created}
                  />
                </Field>
                <Field
                  label={t("Site id")}
                  hint={t("Used in the snippet and the API. Can't be changed later.")}
                >
                  <input
                    className="input"
                    value={idTouched ? id : autoId}
                    onChange={(e) => {
                      setIdTouched(true);
                      setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                    }}
                    placeholder={t("derived from the name")}
                    disabled={!!created}
                  />
                </Field>
              </div>
            </div>
          </Section>
        </li>
        <li>
          <Section title={t("2. Time zone")}>
            <Field label={t("Time zone")} hint={t("Decides where a day starts and ends in reports.")}>
              <TimezoneSelect value={tz} onChange={setTz} />
            </Field>
            {!created && (
              <div className="mt-5 flex items-center gap-3">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!domains.length || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {t("Add site")} <ArrowRight size={15} aria-hidden="true" />
                </button>
                {!domains.length && (
                  <span className="text-sm text-ink-3">{t("Add at least one domain first.")}</span>
                )}
              </div>
            )}
            {create.error && (
              <div className="mt-3">
                <ErrorBox error={create.error} />
              </div>
            )}
          </Section>
        </li>
        <li className={step < 3 ? "[&>.panel]:border-dashed" : ""}>
          <Section title={t("3. Install the snippet")}>
            {created ? (
              <div className="flex flex-col gap-6">
                <SnippetTabs site={created.id} />
                <InstallCheck site={created.id} auto />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void navigate({ to: "/sites/$site", params: { site: created.id } })}
                  >
                    {t("Open {name}", { name: created.name })}
                  </button>
                  <Link to="/sites/$site/settings" params={{ site: created.id }} className="btn">
                    {t("Site settings")}
                  </Link>
                  <Link to="/status" search={{ new: "1", site: created.id } as never} className="btn">
                    {t("Add a status check")}
                  </Link>
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-3">{t("The snippet appears here once the site is added.")}</p>
            )}
          </Section>
        </li>
      </ol>
    </div>
  );
}
