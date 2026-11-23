import {
  ArrowRight,
  DeviceIcon,
  EnvelopeSimple,
  Flag,
  Link2,
  MagnifyingGlass,
  Megaphone,
  MousePointerClick,
  Robot,
  SourceIcon,
  TechIcon,
  UsersRound,
  type LucideIcon,
} from "./icons.tsx";

/** One glyph per channel, so a list of channels reads at a glance. */
const CHANNEL_ICONS: Record<string, LucideIcon> = {
  "AI Assistants": Robot,
  "Paid Search": Megaphone,
  "Paid Social": Megaphone,
  Email: EnvelopeSimple,
  "Organic Search": MagnifyingGlass,
  "Organic Social": UsersRound,
  Referral: Link2,
  Direct: ArrowRight,
};

const box = "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center text-ink-2";

/**
 * A small mark in front of a row label: the country's flag, the source's logo (or its favicon), the browser's or
 * system's logo, an icon for channels and devices. Identity never rests on it alone: the label is always there.
 */
export function RowGlyph({ dimension, value }: { dimension: string; value: string | number | null }) {
  if (value === null || value === "") return null;
  const v = String(value);
  switch (dimension) {
    case "channel": {
      const Icon = CHANNEL_ICONS[v];
      return Icon ? (
        <span className={box} aria-hidden="true">
          <Icon size={15} />
        </span>
      ) : null;
    }
    case "device":
      return (
        <span className={box} aria-hidden="true">
          <DeviceIcon value={v.toLowerCase()} size={15} />
        </span>
      );
    case "event_name":
      return (
        <span className={box} aria-hidden="true">
          <MousePointerClick size={15} />
        </span>
      );
    case "country":
      return /^[A-Z]{2}$/.test(v) ? <Flag code={v} /> : null;
    case "source_name":
    case "referrer_host":
    case "utm_source":
      return (
        <span className={box} aria-hidden="true">
          <SourceIcon value={v} size={15} />
        </span>
      );
    case "browser":
    case "os":
      return (
        <span className={box} aria-hidden="true">
          <TechIcon value={v} size={15} />
        </span>
      );
    default:
      return null;
  }
}
