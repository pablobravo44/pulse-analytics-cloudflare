import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { Field } from "./ui.tsx";

// Where a check or traffic alert sends its messages. null means every enabled channel.
export function ChannelPicker({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (ids: string[] | null) => void;
}) {
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: () =>
      api.get<{ data: { id: string; name: string; kind: string; enabled: boolean }[] }>(
        "/api/v1/ops/channels",
      ),
  });
  return (
    <Field
      group
      label={t("Send to")}
      hint={
        channels.data?.data.length
          ? undefined
          : t("Add Slack, Discord, Telegram, ntfy or webhooks in Settings → Notifications")
      }
    >
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="check"
            checked={value == null}
            onChange={(e) => onChange(e.target.checked ? null : [])}
          />{" "}
          {t("Every notification channel")}
        </label>
        {value != null &&
          (channels.data?.data ?? []).map((c) => (
            <label
              key={c.id}
              className={`flex items-center gap-2 pl-6 text-sm ${c.enabled ? "" : "text-ink-3"}`}
            >
              <input
                type="checkbox"
                className="check"
                checked={value.includes(c.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))
                }
              />{" "}
              {c.name}
              <span className="chip">{c.kind}</span>
              {!c.enabled && t("(off)")}
            </label>
          ))}
        {value != null && value.length === 0 && (
          <p className="pl-6 text-xs text-warn">{t("Pick at least one channel, or send to every channel.")}</p>
        )}
      </div>
    </Field>
  );
}
