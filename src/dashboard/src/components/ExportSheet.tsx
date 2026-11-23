// Export what the site view shows (a CSV over the query engine, with the view's range and filters) or the raw
// events behind it (CSV or NDJSON). Both go through the API, so agents get exactly the same files.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, rangeBody, type Filters } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";
import { Download } from "./icons.tsx";
import { useSites } from "./Shell.tsx";
import { explicitRange, rangeLabel } from "./Toolbar.tsx";
import { ErrorBox, Field, Segmented, Sheet, useToast } from "./ui.tsx";

const TRAFFIC = ["visitors", "sessions", "pageviews", "bounce_rate", "avg_session_duration"];

/** What the report CSV is broken down by, and the metrics that make sense for it. */
const REPORTS: { id: string; label: () => string; dimensions: string[]; metrics: string[] }[] = [
  { id: "day", label: () => t("Day by day"), dimensions: ["day"], metrics: TRAFFIC },
  { id: "page", label: () => t("Pages"), dimensions: ["page"], metrics: ["visitors", "pageviews", "entries", "exits", "avg_engaged_time"] },
  { id: "entry_page", label: () => t("Entry pages"), dimensions: ["entry_page"], metrics: TRAFFIC },
  { id: "channel", label: () => t("Channels"), dimensions: ["channel"], metrics: TRAFFIC },
  { id: "source_name", label: () => t("Sources"), dimensions: ["source_name"], metrics: TRAFFIC },
  { id: "referrer_host", label: () => t("Referrers"), dimensions: ["referrer_host"], metrics: TRAFFIC },
  { id: "utm_campaign", label: () => t("Campaigns"), dimensions: ["utm_source", "utm_medium", "utm_campaign"], metrics: TRAFFIC },
  { id: "country", label: () => t("Countries"), dimensions: ["country"], metrics: TRAFFIC },
  { id: "device", label: () => t("Devices"), dimensions: ["device", "browser", "os"], metrics: TRAFFIC },
  { id: "event_name", label: () => t("Events"), dimensions: ["event_name"], metrics: ["events", "visitors"] },
];

const TYPES: [string, () => string][] = [
  ["", () => t("Everything")],
  ["pageview", () => t("Pageviews")],
  ["event", () => t("Custom events")],
  ["outbound", () => t("Outbound clicks")],
  ["download", () => t("Downloads")],
  ["error", () => t("JavaScript errors")],
  ["vitals", () => t("Web vitals")],
];

const kb = (n: number) =>
  n > 1_048_576 ? `${(n / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export function ExportSheet({
  site,
  f,
  open,
  onOpenChange,
}: {
  site: string;
  f: Filters;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const toast = useToast();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ data: { email: string; role: string } }>("/auth/me"),
    retry: false,
    staleTime: 300_000,
  });
  // Viewers read reports; raw rows need events:export, which owners and admins have.
  const canRaw = me.data ? me.data.data.role !== "viewer" : true;
  const siteInfo = useSites().data?.data.find((s) => s.id === site);
  const [report, setReport] = useState("day");
  const [format, setFormat] = useState<"csv" | "ndjson">("csv");
  const [type, setType] = useState("");
  const [baseFrom, to] = explicitRange(f.range);
  const from =
    f.range === "all" && siteInfo?.data_range?.first_event
      ? siteInfo.data_range.first_event.slice(0, 10)
      : baseFrom;
  const done = (r: { name: string; bytes: number }) => toast(t("Saved {name} ({size})", { name: r.name, size: kb(r.bytes) }));
  const reportDl = useMutation({
    mutationFn: () => {
      const def = REPORTS.find((r) => r.id === report)!;
      const { compare: _c, ...body } = rangeBody(f);
      return api.download("POST", `/api/v1/sites/${site}/query?format=csv`, {
        ...body,
        dimensions: def.dimensions,
        metrics: def.metrics,
        ...(def.id === "day" ? {} : { order_by: [def.metrics[0], "desc"] }),
        limit: 1000,
      });
    },
    onSuccess: done,
  });
  const rawDl = useMutation({
    mutationFn: () =>
      api.download(
        "GET",
        `/api/v1/sites/${site}/export?${new URLSearchParams({ from, to, format, ...(type ? { type } : {}) }).toString()}`,
      ),
    onSuccess: done,
  });
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("Export data")}
      description={t("{range}, with this view's filters.", { range: rangeLabel(f.range) })}
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-[15px] font-semibold">{t("Report")}</h3>
            <p className="mt-0.5 text-sm text-ink-2">
              {t("The numbers in this view as a spreadsheet: up to 1,000 rows, the same as the API's query.")}
            </p>
          </div>
          <Field label={t("Broken down by")}>
            <select className="input" value={report} onChange={(e) => setReport(e.target.value)}>
              {REPORTS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label()}
                </option>
              ))}
            </select>
          </Field>
          {reportDl.error && <ErrorBox error={reportDl.error} />}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={reportDl.isPending}
              onClick={() => reportDl.mutate()}
            >
              <Download size={15} aria-hidden="true" /> {reportDl.isPending ? t("Preparing…") : t("Download CSV")}
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-4 border-t border-line pt-6">
          <div>
            <h3 className="text-[15px] font-semibold">{t("Raw events")}</h3>
            <p className="mt-0.5 text-sm text-ink-2">
              {t(
                "Every hit from {from} to {to} (the site's days), one row each: page, referrer, campaign, country, device, event properties. Filters don't apply here.",
                { from, to },
              )}
            </p>
          </div>
          {canRaw ? (
            <>
              <div className="flex flex-wrap items-start gap-4">
                <Field label={t("Format")}>
                  <Segmented
                    label={t("Format")}
                    value={format}
                    onChange={setFormat}
                    options={[
                      { value: "csv", label: "CSV" },
                      { value: "ndjson", label: "NDJSON" },
                    ]}
                  />
                </Field>
                <Field label={t("Hits")}>
                  <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                    {TYPES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l()}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {rawDl.error && <ErrorBox error={rawDl.error} />}
              <div>
                <button type="button" className="btn" disabled={rawDl.isPending} onClick={() => rawDl.mutate()}>
                  <Download size={15} aria-hidden="true" /> {rawDl.isPending ? t("Preparing…") : t("Download events")}
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-3">{t("Raw events need an owner or admin.")}</p>
          )}
          <p className="text-xs text-ink-3">
            {t("Agents and scripts: GET /api/v1/sites/{site}/export with a key that has events:export. See /docs.", { site })}
          </p>
        </section>
      </div>
    </Sheet>
  );
}
