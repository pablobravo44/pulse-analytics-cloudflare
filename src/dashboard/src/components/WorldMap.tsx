// Choropleth of visitors by country in ink opacity steps. Loaded lazily (d3-geo + world-atlas 110m).
import { geoEqualEarth, geoPath } from "d3-geo";
import countriesLib from "i18n-iso-countries";
import { useMemo, useState } from "react";
import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import { fmt, type Row } from "../lib/api.ts";
import { locale, t } from "../lib/i18n.ts";

type Geo = GeoJSON.Feature<GeoJSON.Geometry, { name: string }> & { id?: string | number };

const names =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(locale, { type: "region" })
    : null;
/** Country name in the interface language (the atlas has English names only). */
function countryName(id: string | number | undefined, fallback: string): string {
  try {
    const code = id === undefined ? undefined : countriesLib.numericToAlpha2(String(id).padStart(3, "0"));
    return (code && names?.of(code)) || fallback;
  } catch {
    return fallback;
  }
}

const W = 800;
const H = 400;

export default function WorldMap({
  rows,
  metric = "visitors",
  onSelect,
}: {
  rows: Row[];
  metric?: string;
  onSelect?: (code: string) => void;
}) {
  const [hover, setHover] = useState<{ name: string; value: number; code: string } | null>(null);
  const shapes = useMemo(() => {
    const topo = world as unknown as Parameters<typeof feature>[0] & {
      objects: { countries: Parameters<typeof feature>[1] };
    };
    const fc = feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection<
      GeoJSON.Geometry,
      { name: string }
    >;
    const projection = geoEqualEarth().fitSize([W, H], fc);
    const path = geoPath(projection);
    return (fc.features as Geo[])
      .filter((f) => f.properties.name !== "Antarctica")
      .map((f) => ({ f, d: path(f) ?? "" }));
  }, []);
  const byNumeric = useMemo(() => {
    const m = new Map<string, { code: string; value: number }>();
    for (const r of rows) {
      const code = String(r.country ?? "");
      const num = code ? countriesLib.alpha2ToNumeric(code) : undefined;
      if (num) m.set(String(Number(num)), { code, value: Number(r[metric] ?? 0) });
    }
    return m;
  }, [rows, metric]);
  const max = Math.max(1, ...[...byNumeric.values()].map((x) => x.value));
  const level = (v: number) => (v <= 0 ? 0 : 0.2 + 0.8 * Math.sqrt(v / max));
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={t("Map of {metric} by country", { metric: t(metric.replace(/_/g, " ")) })}
      >
        {shapes.map(({ f, d }, i) => {
          const hit = byNumeric.get(String(Number(f.id)));
          const v = hit?.value ?? 0;
          return (
            <path
              key={i}
              d={d}
              fill={v ? "var(--site, var(--ink))" : "var(--line-2)"}
              fillOpacity={v ? level(v) : 1}
              stroke="var(--sheet)"
              strokeWidth={0.6}
              className={hit && onSelect ? "cursor-pointer" : ""}
              onMouseEnter={() =>
                setHover({ name: countryName(f.id, f.properties.name), value: v, code: hit?.code ?? "" })
              }
              onMouseLeave={() => setHover(null)}
              onClick={() => hit && onSelect?.(hit.code)}
            />
          );
        })}
      </svg>
      <div
        className="pointer-events-none absolute left-2 top-2 rounded-[6px] bg-sheet/90 px-2 py-1 text-[13px]"
        aria-live="polite"
      >
        {hover ? (
          <>
            {hover.name}: <strong className="tabular">{fmt(hover.value, metric)}</strong>
          </>
        ) : (
          <span className="text-ink-3">{t("Point at a country")}</span>
        )}
      </div>
    </div>
  );
}
