import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  BellPlus,
  Download,
  Eye,
  FileText,
  Gauge,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  Send,
  UsersRound,
  type LucideIcon,
} from "../components/icons.tsx";
import { SavedNote, SideNav } from "../components/SideNav.tsx";
import { useEffect, useState } from "react";
import { ChannelPicker } from "../components/ChannelPicker.tsx";
import { useSites, type SiteInfo } from "../components/Shell.tsx";
import {
  ago,
  Confirm,
  CopyField,
  DataTable,
  Empty,
  ErrorBox,
  Field,
  Section,
  Sheet,
  Skeleton,
  Switch,
  useToast,
} from "../components/ui.tsx";
import { api, type Row } from "../lib/api.ts";
import { locale, t, tn } from "../lib/i18n.ts";
import { TimezoneSelect } from "./sites.tsx";

export const SCOPES: [string, string][] = [
  ["stats:read", t("Read analytics, goals, funnels, annotations, status checks and site settings")],
  ["sites:write", t("Add, edit and archive sites; create and edit goals and funnels")],
  ["ops:write", t("Add, edit, pause and test status checks; scheduled reports; the database size warning")],
  ["annotations:write", t("Add and delete annotations (change markers on charts)")],
  ["events:export", t("Export raw event rows")],
  ["admin", t("Everything, plus API keys, people, imports, data deletion and which databases are backed up")],
];

const SECTIONS = [
  ["keys", t("API keys & agents"), KeyRound],
  ["notifications", t("Notifications"), BellPlus],
  ["reports", t("Reports"), FileText],
  ["people", t("People"), UsersRound],
  ["ops", t("Backups"), RefreshCw],
  ["sites", t("Sites"), Globe],
  ["audit", t("Audit log"), Eye],
  ["imports", t("Imports"), Download],
  ["system", t("System"), Gauge],
] as const satisfies readonly (readonly [string, string, LucideIcon])[];
type SectionId = (typeof SECTIONS)[number][0];

// ---------- API keys ----------

interface Key {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  site_ids: string[] | null;
  created_by: string;
  created_at: number;
  updated_at: number | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  status: "active" | "revoked" | "expired";
}

function ScopePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const isAdmin = value.includes("admin");
  return (
    <fieldset className="flex flex-col divide-y divide-rule rounded-[6px] border border-line">
      <legend className="sr-only">{t("Scopes")}</legend>
      {SCOPES.map(([s, info]) => {
        const implied = isAdmin && s !== "admin";
        return (
          <label
            key={s}
            className={`flex cursor-pointer items-start gap-3 px-3 py-2.5 ${implied ? "opacity-60" : ""}`}
          >
            <input
              type="checkbox"
              className="check mt-0.5"
              checked={value.includes(s) || implied}
              disabled={implied}
              onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))}
            />
            <span className="flex flex-col">
              <code className="text-[13px] font-semibold">{s}</code>
              <span className="text-xs text-ink-2">{info}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function SitePicker({
  value,
  onChange,
  sites,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  sites: SiteInfo[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <Switch
        checked={value === null}
        onChange={(v) => onChange(v ? null : sites.slice(0, 1).map((s) => s.id))}
        label={t("All sites, including ones added later")}
      />
      {value !== null && (
        <div className="flex flex-col divide-y divide-rule rounded-[6px] border border-line">
          {sites.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                className="check"
                checked={value.includes(s.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))
                }
              />
              <span className="text-sm">{s.name}</span>
              <span className="ml-auto text-xs text-ink-3">{s.id}</span>
            </label>
          ))}
        </div>
      )}
      {value !== null && !value.length && (
        <span className="text-xs text-down">{t("Pick at least one site.")}</span>
      )}
    </div>
  );
}

function SecretPanel({ secret, onDone }: { secret: string; onDone: () => void }) {
  const origin = location.origin;
  return (
    <div className="flex flex-col gap-4">
      <p className="border-l-2 border-warn bg-mark-soft px-3 py-2 text-sm">
        {t("Copy the key now. Pulse only stores a hash of it, so it can't be shown again.")}
      </p>
      <Field label={t("API key")}>
        <CopyField value={secret} />
      </Field>
      <Field
        label={t("Claude Code (MCP)")}
        hint={t("Agents see only the tools this key's scopes allow; whoami and help explain the rest.")}
      >
        <CopyField
          value={`claude mcp add --transport http pulse ${origin}/mcp --header "Authorization: Bearer ${secret}"`}
        />
      </Field>
      <Field label={t("REST")}>
        <CopyField value={`curl -H "Authorization: Bearer ${secret}" ${origin}/api/v1/`} />
      </Field>
      <Field label=".env">
        <CopyField value={`PULSE_KEY=${secret}`} />
      </Field>
      <div className="flex justify-end">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          {t("I've copied it")}
        </button>
      </div>
    </div>
  );
}

function KeyForm({
  initial,
  sites,
  onSubmit,
  pending,
  submitLabel,
  error,
}: {
  initial: { name: string; scopes: string[]; site_ids: string[] | null; expires_at: string | null };
  sites: SiteInfo[];
  onSubmit: (v: typeof initial) => void;
  pending: boolean;
  submitLabel: string;
  error: unknown;
}) {
  const [v, setV] = useState(initial);
  const valid = v.name.trim() && v.scopes.length && (v.site_ids === null || v.site_ids.length);
  return (
    <form
      id="key-form"
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ ...v, scopes: v.scopes.includes("admin") ? ["admin"] : v.scopes });
      }}
    >
      <Field label={t("Name")} hint={t("Who or what uses it, e.g. claude-code or deploy-annotations")}>
        <input
          className="input"
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
          required
          autoFocus
        />
      </Field>
      <Field group label={t("What it can do")}>
        <ScopePicker value={v.scopes} onChange={(scopes) => setV({ ...v, scopes })} />
      </Field>
      <Field group label={t("Sites")}>
        <SitePicker value={v.site_ids} onChange={(site_ids) => setV({ ...v, site_ids })} sites={sites} />
      </Field>
      <Field label={t("Expires")} hint={t("Leave empty for a key that doesn't expire")}>
        <input
          className="input w-auto"
          type="date"
          value={v.expires_at?.slice(0, 10) ?? ""}
          onChange={(e) =>
            setV({
              ...v,
              expires_at: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null,
            })
          }
        />
      </Field>
      {error ? <ErrorBox error={error} /> : null}
      <div className="flex justify-end">
        <button className="btn btn-primary" type="submit" disabled={!valid || pending}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Keys() {
  const qc = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { new?: string };
  const navigate = useNavigate();
  const sites = useSites();
  const siteList = sites.data?.data ?? [];
  const [showRevoked, setShowRevoked] = useState(false);
  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () => api.get<{ data: Key[] }>("/api/v1/keys?status=all"),
  });
  const [creating, setCreating] = useState(search.new === "1");
  const [editing, setEditing] = useState<Key | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "rotate" | "revoke">(null);
  useEffect(() => {
    if (search.new === "1") void navigate({ to: ".", search: {}, replace: true } as never);
  }, [search.new, navigate]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["keys"] });
  const create = useMutation({
    mutationFn: (v: {
      name: string;
      scopes: string[];
      site_ids: string[] | null;
      expires_at: string | null;
    }) =>
      api.post<{ data: { key: string } }>("/api/v1/keys", {
        name: v.name,
        scopes: v.scopes,
        site_ids: v.site_ids,
        ...(v.expires_at
          ? { expires_in_days: Math.max(1, Math.ceil((Date.parse(v.expires_at) - Date.now()) / 86_400_000)) }
          : {}),
      }),
    onSuccess: (r) => {
      setSecret(r.data.key);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: {
      name: string;
      scopes: string[];
      site_ids: string[] | null;
      expires_at: string | null;
    }) => api.patch<{ data: Key }>(`/api/v1/keys/${editing!.id}`, v),
    onSuccess: () => {
      toast(t("Key updated. It applies on its next request."));
      setEditing(null);
      refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: () => api.post<{ data: { key: string } }>(`/api/v1/keys/${editing!.id}/rotate`),
    onSuccess: (r) => {
      setSecret(r.data.key);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.del(`/api/v1/keys/${editing!.id}`),
    onSuccess: () => {
      toast(t("Key revoked"));
      setEditing(null);
      refresh();
    },
  });
  const all = keys.data?.data ?? [];
  const shown = all.filter((k) => showRevoked || k.status !== "revoked");
  const siteName = (id: string) => siteList.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("API keys")}
        actions={
          <>
            <label className="mr-2 flex items-center gap-2 text-[13px] text-ink-2">
              <input
                type="checkbox"
                className="check"
                checked={showRevoked}
                onChange={(e) => setShowRevoked(e.target.checked)}
              />{" "}
              {t("Show revoked")}
            </label>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} aria-hidden="true" /> {t("Create key")}
            </button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-2">
          {t(
            "Keys let agents and scripts use the REST API and the MCP server. Click a key to change its name, what it can do or which sites it covers; the change applies on its next request, so connected agents keep working.",
          )}
        </p>
        {keys.isLoading ? (
          <Skeleton h={160} />
        ) : keys.error ? (
          <ErrorBox error={keys.error} />
        ) : !shown.length ? (
          <Empty
            action={
              <button className="btn" onClick={() => setCreating(true)}>
                {t("Create a key")}
              </button>
            }
          >
            {t("No API keys yet.")}
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {shown.map((k) => (
              <li key={k.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => setEditing(k)}
                  disabled={k.status === "revoked"}
                  className={`row-hover grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-1 px-2 py-3 text-left sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1fr)_auto] ${k.status === "revoked" ? "opacity-55" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                      <KeyRound size={14} aria-hidden="true" className="text-ink-3" />
                      <span className="truncate">{k.name}</span>
                    </span>
                    <code className="text-xs text-ink-3">pulse_sk_{k.prefix}…</code>
                  </span>
                  <span className="order-3 col-span-2 flex flex-wrap gap-1 sm:order-none sm:col-span-1">
                    {k.scopes.map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))}
                  </span>
                  <span className="order-4 col-span-2 truncate text-[13px] text-ink-2 sm:order-none sm:col-span-1">
                    {k.site_ids ? k.site_ids.map(siteName).join(", ") : t("All sites")}
                  </span>
                  <span className="text-right text-xs text-ink-3">
                    {k.status === "revoked" ? (
                      t("revoked")
                    ) : k.status === "expired" ? (
                      <span className="text-down">{t("expired")}</span>
                    ) : (
                      t("used {ago}", { ago: ago(k.last_used_at) })
                    )}
                    {k.expires_at && k.status === "active" && (
                      <span className="block">{t("expires {ago}", { ago: ago(k.expires_at) })}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Sheet
        open={creating}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setSecret(null);
            create.reset();
          }
        }}
        title={secret ? t("Your new key") : t("Create an API key")}
        description={secret ? undefined : t("Give an agent or a script access to Pulse.")}
      >
        {secret ? (
          <SecretPanel
            secret={secret}
            onDone={() => {
              setCreating(false);
              setSecret(null);
            }}
          />
        ) : (
          <KeyForm
            initial={{ name: "", scopes: ["stats:read"], site_ids: null, expires_at: null }}
            sites={siteList}
            onSubmit={(v) => create.mutate(v)}
            pending={create.isPending}
            submitLabel={t("Create key")}
            error={create.error}
          />
        )}
      </Sheet>

      <Sheet
        open={!!editing}
        onOpenChange={(v) => {
          if (!v) {
            setEditing(null);
            setSecret(null);
            update.reset();
          }
        }}
        title={secret ? t("New secret for this key") : t("Edit {name}", { name: editing?.name ?? t("key") })}
        description={
          secret
            ? undefined
            : t("pulse_sk_{prefix}…, created by {by} {created}, last used {used}", {
                prefix: editing?.prefix ?? "",
                by: editing?.created_by ?? "",
                created: ago(editing?.created_at),
                used: ago(editing?.last_used_at, t("never")),
              })
        }
        footer={
          secret ? undefined : (
            <>
              <button type="button" className="btn btn-danger mr-auto" onClick={() => setConfirm("revoke")}>
                {t("Revoke key")}
              </button>
              <button type="button" className="btn" onClick={() => setConfirm("rotate")}>
                {t("Rotate secret")}
              </button>
            </>
          )
        }
      >
        {editing && secret ? (
          <SecretPanel
            secret={secret}
            onDone={() => {
              setSecret(null);
              setEditing(null);
            }}
          />
        ) : editing ? (
          <KeyForm
            key={editing.id}
            initial={{
              name: editing.name,
              scopes: editing.scopes,
              site_ids: editing.site_ids,
              expires_at: editing.expires_at ? new Date(editing.expires_at).toISOString() : null,
            }}
            sites={siteList}
            onSubmit={(v) => update.mutate(v)}
            pending={update.isPending}
            submitLabel={t("Save changes")}
            error={update.error}
          />
        ) : null}
        {/* Inside the sheet so the confirmation stacks on it instead of dismissing it. */}
        <Confirm
          open={confirm === "rotate"}
          onOpenChange={(v) => !v && setConfirm(null)}
          title={t("Rotate this key's secret?")}
          body={t(
            "You get a new secret for the same key. The old one stops working right away, so update every agent or script that uses it.",
          )}
          confirm={t("Rotate secret")}
          danger={false}
          onConfirm={() => rotate.mutate()}
        />
        <Confirm
          open={confirm === "revoke"}
          onOpenChange={(v) => !v && setConfirm(null)}
          title={t("Revoke {name}?", { name: editing?.name ?? t("this key") })}
          body={t("Anything using it loses access immediately. This can't be undone.")}
          confirm={t("Revoke key")}
          onConfirm={() => revoke.mutate()}
        />
      </Sheet>
    </div>
  );
}

// ---------- Connected apps ----------

interface ConnectedApp {
  id: string;
  user_id: string;
  user: string;
  client_id: string;
  client_name: string | null;
  scopes: string[];
  created_at: string;
}

function ConnectedApps() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["connected"],
    queryFn: () => api.get<{ data: ConnectedApp[] }>("/api/v1/connected-apps"),
  });
  const [revoke, setRevoke] = useState<ConnectedApp | null>(null);
  const del = useMutation({
    mutationFn: (a: ConnectedApp) =>
      api.del(`/api/v1/connected-apps/${a.id}?user_id=${encodeURIComponent(a.user_id)}`),
    onSuccess: () => {
      toast(t("App disconnected"));
      void qc.invalidateQueries({ queryKey: ["connected"] });
    },
  });
  return (
    <Section title={t("Connected apps")}>
      <p className="mb-3 text-sm text-ink-2">
        {t(
          "Apps you connected with OAuth, like a claude.ai or Claude Desktop connector. They use your sign-in, not an API key.",
        )}
      </p>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : q.isLoading ? (
        <Skeleton h={60} />
      ) : !q.data?.data.length ? (
        <Empty>
          {t("No connected apps. Add Pulse as a custom connector in claude.ai with {url}.", {
            url: `${location.origin}/mcp`,
          })}
        </Empty>
      ) : (
        <ul className="flex flex-col">
          {q.data.data.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-2 py-3 text-sm last:border-0"
            >
              <span className="min-w-0">
                <span className="font-medium">{a.client_name ?? a.client_id}</span>
                <span className="block text-[13px] text-ink-2">
                  {t("connected by {user} {ago}", { user: a.user, ago: ago(a.created_at) })}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {a.scopes.map((s) => (
                  <span key={s} className="chip">
                    {s}
                  </span>
                ))}
                <button className="btn btn-sm btn-danger ml-2" onClick={() => setRevoke(a)}>
                  {t("Disconnect")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Confirm
        open={!!revoke}
        onOpenChange={(v) => !v && setRevoke(null)}
        title={t("Disconnect {name}?", { name: revoke?.client_name ?? t("this app") })}
        body={t("It loses access now. Connecting it again needs a new sign-in.")}
        confirm={t("Disconnect")}
        onConfirm={() => revoke && del.mutate(revoke)}
      />
    </Section>
  );
}

// ---------- Notifications ----------

interface Channel {
  id: string;
  kind: string;
  name: string;
  target: string | null;
  enabled: boolean;
  last_sent_at: string | null;
  last_error: string | null;
}
const CHANNEL_KINDS: [string, string][] = [
  ["slack", "Slack"],
  ["discord", "Discord"],
  ["telegram", "Telegram"],
  ["ntfy", t("ntfy (phone push)")],
  ["webhook", t("Webhook (JSON, signed)")],
  ["email", t("Email")],
];

function Notifications() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<{ data: Channel[]; secret_key_configured: boolean }>("/api/v1/ops/channels"),
  });
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState("slack");
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [signing, setSigning] = useState<string | null>(null);
  const [del, setDel] = useState<Channel | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["channels"] });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: { signing_secret?: string } }>("/api/v1/ops/channels", {
        name,
        kind,
        config: Object.fromEntries(Object.entries(cfg).filter(([, v]) => v)),
      }),
    onSuccess: (r) => {
      refresh();
      toast(t("Channel added"));
      if (r.data.signing_secret) setSigning(r.data.signing_secret);
      else setAdding(false);
      setName("");
      setCfg({});
    },
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { sent: boolean; error: string | null } }>(`/api/v1/ops/channels/${id}/test`),
    onSuccess: (r) => (
      toast(
        r.data.sent ? t("Test message sent") : t("Not sent: {error}", { error: r.data.error ?? "" }),
        r.data.sent ? "ok" : "error",
      ),
      refresh()
    ),
  });
  const toggle = useMutation({
    mutationFn: (c: Channel) => api.patch(`/api/v1/ops/channels/${c.id}`, { enabled: !c.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/ops/channels/${id}`),
    onSuccess: () => (toast(t("Channel deleted")), refresh()),
  });
  const secretOk = q.data?.secret_key_configured ?? true;
  const field = (k: string, label: string, hint?: string, type = "text") => (
    <Field label={label} hint={hint}>
      <input
        className="input"
        type={type}
        value={cfg[k] ?? ""}
        onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}
        required={k !== "token"}
      />
    </Field>
  );
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("Where alerts go")}
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={15} aria-hidden="true" /> {t("Add channel")}
          </button>
        }
      >
        <p className="mb-3 text-sm text-ink-2">
          {t(
            "Status checks and traffic alerts are sent to every enabled channel, unless a check or alert picks specific ones.",
          )}
        </p>
        {!secretOk && (
          <p className="mb-3 border-l-2 border-warn bg-mark-soft px-3 py-2 text-sm">
            {t(
              "Slack, Discord, Telegram, ntfy and webhooks need the {key} Worker secret, which encrypts their URLs and tokens. Email works without it.",
              { key: "PULSE_SECRET_KEY" },
            )}
          </p>
        )}
        {q.error ? (
          <ErrorBox error={q.error} />
        ) : q.isLoading ? (
          <Skeleton h={80} />
        ) : (
          <ul className="flex flex-col">
            {(q.data?.data ?? []).map((c) => (
              <li
                key={c.id}
                className={`flex flex-wrap items-center justify-between gap-3 border-b border-line px-2 py-3 text-sm last:border-0 ${c.enabled ? "" : "opacity-60"}`}
              >
                <span className="min-w-0">
                  <span className="font-medium">{c.name}</span> <span className="chip ml-1">{c.kind}</span>
                  <span className="block text-[13px] text-ink-2">
                    {c.target}
                    {c.last_error ? (
                      <span className="text-down">
                        {t("; last attempt failed: {error}", { error: c.last_error })}
                      </span>
                    ) : c.last_sent_at ? (
                      t("; last sent {ago}", { ago: ago(c.last_sent_at) })
                    ) : (
                      ""
                    )}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <button className="btn btn-sm" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                    <Send size={13} aria-hidden="true" /> {t("Test")}
                  </button>
                  <button className="btn btn-sm btn-quiet" onClick={() => toggle.mutate(c)}>
                    {c.enabled ? t("Turn off") : t("Turn on")}
                  </button>
                  <button className="btn btn-sm btn-quiet btn-danger" onClick={() => setDel(c)}>
                    {t("Delete")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Sheet
        open={adding}
        onOpenChange={(v) => {
          if (!v) {
            setAdding(false);
            setSigning(null);
            create.reset();
          }
        }}
        title={signing ? t("Your webhook signing secret") : t("Add a notification channel")}
      >
        {signing ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-2">
              {t("Pulse signs every webhook body: {sig}. Copy the secret now; it isn't shown again.", {
                sig: "X-Pulse-Signature: sha256=HMAC(secret, body)",
              })}
            </p>
            <CopyField value={signing} />
            <button className="btn btn-primary self-end" onClick={() => (setAdding(false), setSigning(null))}>
              {t("I've copied it")}
            </button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label={t("Kind")}>
              <select
                className="input"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setCfg({});
                }}
              >
                {CHANNEL_KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Name")}>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="#alerts"
                required
              />
            </Field>
            {kind === "slack" &&
              field(
                "url",
                t("Incoming webhook URL"),
                t("Slack → Apps → Incoming Webhooks; starts with https://hooks.slack.com/"),
              )}
            {kind === "discord" &&
              field("url", t("Webhook URL"), t("Channel settings → Integrations → Webhooks"))}
            {kind === "webhook" &&
              field("url", t("URL"), t("Pulse POSTs JSON: title, text, url, severity, data, at"))}
            {kind === "ntfy" && (
              <>
                {field("url", t("Topic URL"), t("e.g. https://ntfy.sh/your-secret-topic"))}
                {field("token", t("Access token (optional)"), t("For protected topics"), "password")}
              </>
            )}
            {kind === "telegram" && (
              <>
                {field("bot_token", t("Bot token"), t("From @BotFather, like 123456:ABC…"), "password")}
                {field("chat_id", t("Chat id"), t("Your chat or group id"))}
              </>
            )}
            {kind === "email" && (
              <p className="text-sm text-ink-2">
                {t(
                  "Sends to the ALERT_EMAIL address, which must be a verified Email Routing destination in your Cloudflare account.",
                )}
              </p>
            )}
            {create.error && <ErrorBox error={create.error} />}
            <div className="flex justify-end">
              <button className="btn btn-primary" type="submit" disabled={create.isPending}>
                {t("Add channel")}
              </button>
            </div>
          </form>
        )}
      </Sheet>
      <Confirm
        open={!!del}
        onOpenChange={(v) => !v && setDel(null)}
        title={t("Delete {name}?", { name: del?.name ?? t("this channel") })}
        body={t("Checks and alerts that picked it stop sending there.")}
        confirm={t("Delete channel")}
        onConfirm={() => del && remove.mutate(del.id)}
      />
    </div>
  );
}

// ---------- People ----------

interface User {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "viewer";
  site_ids: string[] | null;
  disabled_at: number | null;
}

function People() {
  const qc = useQueryClient();
  const toast = useToast();
  const sites = useSites();
  const siteList = sites.data?.data ?? [];
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ data: User[] }>("/api/v1/users") });
  // "new" opens the same sheet to add someone.
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [draft, setDraft] = useState<{ email: string; role: User["role"]; site_ids: string[] | null } | null>(null);
  const isNew = editing === "new";
  const current = editing && editing !== "new" ? editing : null;
  const save = useMutation({
    mutationFn: () => {
      const body = { role: draft!.role, site_ids: draft!.role === "viewer" ? draft!.site_ids : null };
      return isNew
        ? api.post("/api/v1/users", { ...body, email: draft!.email.trim() })
        : api.patch(`/api/v1/users/${current!.id}`, body);
    },
    onSuccess: () => {
      toast(isNew ? t("Added. They can sign in with a code sent to their email.") : t("Access updated. They'll sign in again."));
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const toggle = useMutation({
    mutationFn: (u: User) =>
      u.disabled_at ? api.post(`/api/v1/users/${u.id}/enable`) : api.del(`/api/v1/users/${u.id}`),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const open = (u: User | "new") => {
    save.reset();
    setEditing(u);
    setDraft(u === "new" ? { email: "", role: "viewer", site_ids: null } : { email: u.email, role: u.role, site_ids: u.site_ids });
  };
  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t("People with access")}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => open("new")}>
            <Plus size={14} aria-hidden="true" /> {t("Add person")}
          </button>
        }
      >
        {users.error ? (
          <ErrorBox error={users.error} />
        ) : (
          <ul className="flex flex-col">
            {(users.data?.data ?? []).map((u) => (
              <li key={u.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  className={`row-hover grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-2 py-3 text-left ${u.disabled_at ? "opacity-55" : ""}`}
                  onClick={() => open(u)}
                >
                  <span className="min-w-0 truncate font-medium">{u.email}</span>
                  <span className="text-[13px] text-ink-2">
                    {u.disabled_at
                      ? t("disabled")
                      : u.role === "owner"
                        ? t("owner")
                        : u.role === "admin"
                          ? t("admin")
                          : t("viewer")}
                    {u.role === "viewer" && (
                      <span className="ml-2 text-ink-3">
                        {u.site_ids ? u.site_ids.join(", ") : t("all sites")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("Sign-in")}>
        <p className="max-w-[68ch] px-2 text-sm text-ink-2">
          {t(
            "People sign in with a one-time code sent to their email through Cloudflare Access. The addresses in ACCESS_EMAILS become owners on their first sign-in; anyone else needs to be added here, and your Access policy must let their address request a code.",
          )}
        </p>
      </Section>
      <Sheet
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        title={isNew ? t("Add person") : (current?.email ?? "")}
        description={isNew ? t("They sign in with a one-time code sent to this email.") : t("Changing access ends their current sessions.")}
        footer={
          editing && (
            <>
              {current && (
                <button
                  type="button"
                  className={`btn mr-auto ${current.disabled_at ? "" : "btn-danger"}`}
                  onClick={() => toggle.mutate(current)}
                >
                  {current.disabled_at ? t("Enable") : t("Disable")}
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => save.mutate()}
                disabled={save.isPending || (isNew && !/^\S+@\S+\.\S+$/.test(draft?.email.trim() ?? ""))}
              >
                {isNew ? t("Add person") : t("Save changes")}
              </button>
            </>
          )
        }
      >
        {draft && (
          <div className="flex flex-col gap-5">
            {isNew && (
              <Field label={t("Email")}>
                <input
                  className="input"
                  type="email"
                  autoComplete="off"
                  autoFocus
                  placeholder="name@example.com"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                />
              </Field>
            )}
            <Field label={t("Role")}>
              <select
                className="input"
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value as User["role"] })}
              >
                <option value="viewer">{t("Viewer: reads reports")}</option>
                <option value="admin">{t("Admin: changes everything")}</option>
                <option value="owner">{t("Owner")}</option>
              </select>
            </Field>
            {draft.role === "viewer" && (
              <Field group label={t("Sites they can see")}>
                <SitePicker
                  value={draft.site_ids}
                  onChange={(site_ids) => setDraft({ ...draft, site_ids })}
                  sites={siteList}
                />
              </Field>
            )}
            {save.error && <ErrorBox error={save.error} />}
            {toggle.error && <ErrorBox error={toggle.error} />}
          </div>
        )}
      </Sheet>
    </div>
  );
}

// ---------- Reports ----------

interface Report {
  id: string;
  name: string;
  site_ids: string[] | null;
  frequency: "weekly" | "monthly";
  weekday: number;
  day_of_month: number;
  hour: number;
  timezone: string;
  sections: string[];
  include_ops: boolean;
  channel_ids: string[] | null;
  enabled: boolean;
  last_sent_at: string | null;
  last_error: string | null;
}
const WEEKDAYS = [
  t("Sunday"),
  t("Monday"),
  t("Tuesday"),
  t("Wednesday"),
  t("Thursday"),
  t("Friday"),
  t("Saturday"),
];
const WEEKDAYS_EVERY = [
  t("Sundays"),
  t("Mondays"),
  t("Tuesdays"),
  t("Wednesdays"),
  t("Thursdays"),
  t("Fridays"),
  t("Saturdays"),
];
const REPORT_SECTIONS: [string, string][] = [
  ["kpis", t("Visitors, pageviews and bounce rate, with the change")],
  ["pages", t("Top pages")],
  ["sources", t("Top channels")],
  ["ai", t("Visits from AI assistants")],
  ["goals", t("Goal conversions")],
  ["movers", t("Pages rising and falling")],
];
const schedule = (r: Pick<Report, "frequency" | "weekday" | "day_of_month" | "hour" | "timezone">) =>
  t("{when} at {time} {tz}", {
    when:
      r.frequency === "monthly"
        ? t("Monthly on day {day}", { day: r.day_of_month })
        : (WEEKDAYS_EVERY[r.weekday] ?? ""),
    time: `${String(r.hour).padStart(2, "0")}:00`,
    tz: r.timezone,
  });

function Reports() {
  const qc = useQueryClient();
  const toast = useToast();
  const sites = useSites();
  const q = useQuery({
    queryKey: ["reports"],
    queryFn: () => api.get<{ data: Report[] }>("/api/v1/ops/reports"),
  });
  const [edit, setEdit] = useState<Partial<Report> | null>(null);
  const [del, setDel] = useState(false);
  const [preview, setPreview] = useState<Report | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["reports"] });
  const save = useMutation({
    mutationFn: (r: Partial<Report>) => {
      const { id, last_sent_at: _s, last_error: _e, ...body } = r;
      return id ? api.patch(`/api/v1/ops/reports/${id}`, body) : api.post("/api/v1/ops/reports", body);
    },
    onSuccess: () => (toast(t("Report saved")), setEdit(null), refresh()),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/ops/reports/${id}`),
    onSuccess: () => (toast(t("Report deleted")), setEdit(null), refresh()),
  });
  const send = useMutation({
    mutationFn: (id: string) => api.post<{ data: { delivered: number } }>(`/api/v1/ops/reports/${id}/send`),
    onSuccess: (r) => (
      toast(
        r.data.delivered
          ? tn(r.data.delivered, "Report sent to {n} channel", "Report sent to {n} channels")
          : t("No channel accepted the report"),
        r.data.delivered ? "ok" : "error",
      ),
      refresh()
    ),
  });
  const blank: Partial<Report> = {
    name: "",
    site_ids: null,
    frequency: "weekly",
    weekday: 1,
    day_of_month: 1,
    hour: 8,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sections: REPORT_SECTIONS.map(([k]) => k),
    include_ops: false,
    channel_ids: null,
    enabled: true,
  };
  const siteList = sites.data?.data ?? [];
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("Scheduled reports")}
        actions={
          <button className="btn btn-primary" onClick={() => setEdit(blank)}>
            <Plus size={15} aria-hidden="true" /> {t("New report")}
          </button>
        }
      >
        <p className="mb-3 text-sm text-ink-2">
          {t(
            "A summary of your sites, sent weekly or monthly to your notification channels. Email gets the full layout; chat channels get the text.",
          )}
        </p>
        {q.error ? (
          <ErrorBox error={q.error} />
        ) : q.isLoading ? (
          <Skeleton h={80} />
        ) : !q.data?.data.length ? (
          <Empty
            action={
              <button className="btn btn-primary" onClick={() => setEdit(blank)}>
                {t("New report")}
              </button>
            }
          >
            {t("No reports yet.")}
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {q.data.data.map((r) => (
              <li
                key={r.id}
                className={`flex flex-wrap items-center justify-between gap-3 border-b border-line px-2 py-3 text-sm last:border-0 ${r.enabled ? "" : "opacity-60"}`}
              >
                <button type="button" className="min-w-0 text-left" onClick={() => setEdit(r)}>
                  <span className="font-medium">{r.name}</span>
                  <span className="block text-[13px] text-ink-2">
                    {schedule(r)};{" "}
                    {r.site_ids
                      ? r.site_ids.map((id) => siteList.find((s) => s.id === id)?.name ?? id).join(", ")
                      : t("all sites in reports")}
                    {r.include_ops ? t(", with ops") : ""}
                  </span>
                  <span className="block text-xs text-ink-3">
                    {r.last_error ? (
                      <span className="text-down">
                        {t("Last attempt failed: {error}", { error: r.last_error })}
                      </span>
                    ) : r.last_sent_at ? (
                      t("Last sent {ago}", { ago: ago(r.last_sent_at) })
                    ) : (
                      t("Not sent yet")
                    )}
                  </span>
                </button>
                <span className="flex items-center gap-1">
                  <button className="btn btn-sm" onClick={() => setPreview(r)}>
                    <Eye size={13} aria-hidden="true" /> {t("Preview")}
                  </button>
                  <button className="btn btn-sm" onClick={() => send.mutate(r.id)} disabled={send.isPending}>
                    <Send size={13} aria-hidden="true" /> {t("Send now")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Sheet
        open={!!edit}
        onOpenChange={(v) => !v && setEdit(null)}
        title={edit?.id ? t("Edit {name}", { name: edit.name ?? "" }) : t("New report")}
        wide
      >
        {edit && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(edit);
            }}
          >
            <Field label={t("Name")}>
              <input
                className="input"
                value={edit.name ?? ""}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder={t("Monday summary")}
                required
                autoFocus
              />
            </Field>
            <Field
              group
              label={t("Sites")}
              hint={
                edit.site_ids
                  ? undefined
                  : t("Every site that has “Include in reports” on in its settings, including future ones")
              }
            >
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="check"
                    checked={edit.site_ids == null}
                    onChange={(e) => setEdit({ ...edit, site_ids: e.target.checked ? null : [] })}
                  />{" "}
                  {t("All sites in reports")}
                </label>
                {edit.site_ids != null &&
                  siteList.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 pl-6 text-sm">
                      <input
                        type="checkbox"
                        className="check"
                        checked={edit.site_ids!.includes(s.id)}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            site_ids: e.target.checked
                              ? [...edit.site_ids!, s.id]
                              : edit.site_ids!.filter((x) => x !== s.id),
                          })
                        }
                      />{" "}
                      {s.name}
                    </label>
                  ))}
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label={t("Every")}>
                <select
                  className="input"
                  value={edit.frequency}
                  onChange={(e) => setEdit({ ...edit, frequency: e.target.value as Report["frequency"] })}
                >
                  <option value="weekly">{t("Week")}</option>
                  <option value="monthly">{t("Month")}</option>
                </select>
              </Field>
              {edit.frequency === "monthly" ? (
                <Field label={t("On day")}>
                  <select
                    className="input"
                    value={edit.day_of_month}
                    onChange={(e) => setEdit({ ...edit, day_of_month: Number(e.target.value) })}
                  >
                    {Array.from({ length: 28 }, (_, i) => (
                      <option key={i} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field label={t("On")}>
                  <select
                    className="input"
                    value={edit.weekday}
                    onChange={(e) => setEdit({ ...edit, weekday: Number(e.target.value) })}
                  >
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={t("At")}>
                <select
                  className="input"
                  value={edit.hour}
                  onChange={(e) => setEdit({ ...edit, hour: Number(e.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Time zone")}>
                <TimezoneSelect
                  value={edit.timezone ?? "UTC"}
                  onChange={(timezone) => setEdit({ ...edit, timezone })}
                />
              </Field>
            </div>
            <p className="-mt-2 text-xs text-ink-3">
              {edit.frequency === "monthly"
                ? t("Covers the last full calendar month, compared with the one before.")
                : t("Covers the last full week, Monday to Sunday, compared with the one before.")}
            </p>
            <Field group label={t("What it includes")}>
              <div className="flex flex-col gap-1.5">
                {REPORT_SECTIONS.map(([k, l]) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="check"
                      checked={edit.sections?.includes(k) ?? false}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          sections: e.target.checked
                            ? [...(edit.sections ?? []), k]
                            : (edit.sections ?? []).filter((x) => x !== k),
                        })
                      }
                    />{" "}
                    {l}
                  </label>
                ))}
              </div>
            </Field>
            <Switch
              checked={!!edit.include_ops}
              onChange={(include_ops) => setEdit({ ...edit, include_ops })}
              label={t("Add status checks, incidents, backups and database sizes")}
            />
            <ChannelPicker
              value={edit.channel_ids ?? null}
              onChange={(channel_ids) => setEdit({ ...edit, channel_ids })}
            />
            <Switch
              checked={edit.enabled !== false}
              onChange={(enabled) => setEdit({ ...edit, enabled })}
              label={t("Send on schedule")}
            />
            {save.error && <ErrorBox error={save.error} />}
            <div className="flex justify-end gap-2">
              {edit.id && (
                <button type="button" className="btn btn-danger mr-auto" onClick={() => setDel(true)}>
                  {t("Delete report")}
                </button>
              )}
              <button
                className="btn btn-primary"
                type="submit"
                disabled={
                  save.isPending || !edit.sections?.length || (edit.site_ids != null && !edit.site_ids.length)
                }
              >
                {edit.id ? t("Save changes") : t("Create report")}
              </button>
            </div>
          </form>
        )}
        <Confirm
          open={del}
          onOpenChange={setDel}
          title={t("Delete {name}?", { name: edit?.name ?? t("this report") })}
          body={t("It stops being sent. Past sends aren't affected.")}
          confirm={t("Delete report")}
          onConfirm={() => edit?.id && remove.mutate(edit.id)}
        />
      </Sheet>
      <Sheet
        open={!!preview}
        onOpenChange={(v) => !v && setPreview(null)}
        title={preview ? t("Preview: {name}", { name: preview.name }) : t("Preview")}
        description={t("What the email looks like for the last complete period. Nothing was sent.")}
        wide
      >
        {preview && (
          <iframe
            title={t("Report preview")}
            sandbox="allow-same-origin"
            src={`/reports/${encodeURIComponent(preview.id)}/preview`}
            className="h-[70vh] w-full rounded-[6px] border border-line bg-white"
          />
        )}
      </Sheet>
    </div>
  );
}

// ---------- Backups ----------

interface OpsSettings {
  backup_databases: string[];
  drill_databases: string[];
  d1_warn_gb: number;
  email_only_errors: boolean;
}

function DbPicker({
  value,
  onChange,
  available,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  available: string[] | null;
}) {
  if (!available)
    return (
      <input
        className="input"
        value={value.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    );
  const names = [...new Set([...available, ...value])];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {names.map((n) => (
        <label key={n} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="check"
            checked={value.includes(n)}
            onChange={(e) => onChange(e.target.checked ? [...value, n] : value.filter((x) => x !== n))}
          />
          {n}
          {!available.includes(n) && <span className="text-xs text-down">{t("not found")}</span>}
        </label>
      ))}
    </div>
  );
}

function Ops() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["ops-settings"],
    queryFn: () => api.get<{ data: OpsSettings }>("/api/v1/ops/settings"),
  });
  const dbs = useQuery({
    queryKey: ["ops-dbs"],
    queryFn: () => api.get<{ data: { name: string }[]; available: boolean }>("/api/v1/ops/databases"),
    retry: false,
  });
  const [v, setV] = useState<OpsSettings | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    // A toggle saved on its own must not discard edits still pending in the form below.
    if (q.data)
      setV((prev) => (prev ? { ...prev, email_only_errors: q.data.data.email_only_errors } : q.data.data));
  }, [q.data]);
  const toggleEmail = useMutation({
    mutationFn: (email_only_errors: boolean) =>
      api.patch("/api/v1/ops/settings", { ...q.data!.data, email_only_errors }),
    onSuccess: () => {
      setSavedAt(Date.now());
      void qc.invalidateQueries({ queryKey: ["ops-settings"] });
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch("/api/v1/ops/settings", { ...v, email_only_errors: q.data!.data.email_only_errors }),
    onSuccess: () => {
      toast(t("Settings saved"));
      void qc.invalidateQueries({ queryKey: ["ops-settings"] });
    },
  });
  if (!v) return q.error ? <ErrorBox error={q.error} /> : <Skeleton h={300} />;
  const available = dbs.data?.available ? dbs.data.data.map((d) => d.name) : null;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-sm text-ink-2">
        {t("The weekly digest is now a scheduled report: change it under")}{" "}
        <Link to="/settings/$section" params={{ section: "reports" }} className="underline">
          {t("Reports")}
        </Link>
        .
      </p>
      <Section title={t("Email")}>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="check mt-0.5"
            checked={v.email_only_errors}
            onChange={(e) => (
              setV({ ...v, email_only_errors: e.target.checked }),
              toggleEmail.mutate(e.target.checked)
            )}
          />
          <span>
            {t("Email only for errors")}
            <span className="block text-xs text-ink-3">
              {t(
                "New JavaScript errors and failed or out-of-date backups. Other alerts, status checks and warnings stay in Pulse and still reach your other channels. Scheduled reports follow their own settings in Reports.",
              )}
            </span>
          </span>
        </label>
        <div className="mt-2 flex items-center gap-2 pl-6">
          <SavedNote at={savedAt} />
          {toggleEmail.error && <ErrorBox error={toggleEmail.error} />}
        </div>
      </Section>
      <Section title={t("Database backups")}>
        <div className="flex flex-col gap-5">
          <Field
            group
            label={t("Back up every Sunday")}
            hint={t("SQL exports of these D1 databases go to the ops-backups bucket and are kept 12 weeks.")}
          >
            <DbPicker
              value={v.backup_databases}
              onChange={(backup_databases) => setV({ ...v, backup_databases })}
              available={available}
            />
          </Field>
          <Field
            group
            label={t("Restore drill on the 1st of each month")}
            hint={t("The latest backup is restored into a scratch database and row counts are compared.")}
          >
            <DbPicker
              value={v.drill_databases}
              onChange={(drill_databases) => setV({ ...v, drill_databases })}
              available={available}
            />
          </Field>
          <Field label={t("Warn when a database reaches")} hint={t("D1's hard limit is 10 GB")}>
            <div className="flex items-center gap-2">
              <input
                className="input w-24"
                type="number"
                step="0.5"
                min={0.1}
                max={10}
                value={v.d1_warn_gb}
                onChange={(e) => setV({ ...v, d1_warn_gb: Number(e.target.value) })}
              />
              <span className="text-sm text-ink-2">GB</span>
            </div>
          </Field>
          {(dbs.error || dbs.data?.available === false) && (
            <p className="text-xs text-ink-3">
              {t("Database names can't be listed here (the ops token isn't configured), so type them.")}
            </p>
          )}
        </div>
      </Section>
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            save.isPending ||
            JSON.stringify({ ...v, email_only_errors: 0 }) ===
              JSON.stringify({ ...q.data?.data, email_only_errors: 0 })
          }
        >
          {t("Save changes")}
        </button>
        {save.error && <ErrorBox error={save.error} />}
      </div>
    </form>
  );
}

// ---------- Sites (incl. archived) ----------

function AllSites() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["sites-all"],
    queryFn: () =>
      api.get<{ data: (SiteInfo & { archived_at: number | null })[] }>("/api/v1/sites?include_archived=true"),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/sites/${id}/restore`),
    onSuccess: () => {
      toast(t("Site restored"));
      void qc.invalidateQueries({ queryKey: ["sites-all"] });
      void qc.invalidateQueries({ queryKey: ["sites"] });
    },
  });
  return (
    <Section
      title={t("All sites")}
      actions={
        <Link to="/add-site" className="btn btn-primary">
          <Plus size={15} aria-hidden="true" /> {t("Add site")}
        </Link>
      }
    >
      {q.isLoading ? (
        <Skeleton h={120} />
      ) : (
        <ul className="flex flex-col">
          {(q.data?.data ?? []).map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-2 py-3 last:border-0"
            >
              <span className="min-w-0">
                <span className="font-medium">{s.name}</span>{" "}
                <span className="text-xs text-ink-3">{s.id}</span>
                <span className="block truncate text-[13px] text-ink-2">{s.domains.join(", ")}</span>
              </span>
              <span className="flex items-center gap-2 text-[13px] text-ink-2">
                {s.archived_at ? (
                  <>
                    {t("archived")}
                    <button className="btn btn-sm" onClick={() => restore.mutate(s.id)}>
                      {t("Restore")}
                    </button>
                  </>
                ) : (
                  <>
                    {s.settings.hidden && <span className="chip">{t("internal")}</span>}
                    <Link to="/sites/$site/settings" params={{ site: s.id }} className="btn btn-sm">
                      {t("Settings")}
                    </Link>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Audit() {
  const [action, setAction] = useState("");
  const q = useQuery({
    queryKey: ["audit", action],
    queryFn: () =>
      api.get<{ data: Row[] }>(
        `/api/v1/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ""}`,
      ),
  });
  return (
    <Section
      title={t("Audit log")}
      actions={
        <select
          className="input w-auto"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label={t("Filter by area")}
        >
          <option value="">{t("Everything")}</option>
          <option value="key.">{t("API keys")}</option>
          <option value="site.">{t("Sites")}</option>
          <option value="monitor.">{t("Status checks")}</option>
          <option value="user.">{t("People")}</option>
          <option value="goal.">{t("Goals")}</option>
          <option value="settings.">{t("Settings")}</option>
          <option value="login">{t("Sign-ins")}</option>
        </select>
      }
    >
      <DataTable
        rows={q.data?.data ?? []}
        empty={t("Nothing recorded yet.")}
        columns={[
          {
            key: "ts",
            label: t("When"),
            render: (r) => (
              <span className="whitespace-nowrap text-ink-2">
                {new Date(Number(r.ts)).toLocaleString(locale)}
              </span>
            ),
          },
          { key: "actor", label: t("Who") },
          {
            key: "action",
            label: t("What"),
            render: (r) => <code className="text-[13px]">{String(r.action)}</code>,
          },
          {
            key: "target",
            label: t("On"),
            render: (r) => <span className="text-ink-2">{String(r.target ?? "")}</span>,
          },
        ]}
      />
    </Section>
  );
}

function Imports() {
  const q = useQuery({ queryKey: ["imports"], queryFn: () => api.get<{ data: Row[] }>("/api/v1/imports") });
  return (
    <Section title={t("Imports")}>
      <DataTable
        rows={q.data?.data ?? []}
        empty={t("No imports.")}
        columns={[
          { key: "site_id", label: t("Site") },
          { key: "source", label: t("Source") },
          { key: "range_from", label: t("From") },
          { key: "range_to", label: t("To") },
          { key: "rows_events", label: t("Events"), metric: "n" },
          { key: "rows_sessions", label: t("Sessions"), metric: "n" },
          { key: "status", label: t("Status") },
        ]}
      />
    </Section>
  );
}

interface HealthRes {
  version: string;
  environment: string;
  ingest: {
    last_event_per_site: Record<string, string>;
    seconds_since_last_event: number | null;
    today: Row[];
  };
  queue: { dlq_depth: number | null };
  d1: { size_mb: number | null };
  backups: { last: { at: string; ok: boolean } | null; fresh: boolean };
}

function System() {
  const q = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HealthRes>("/api/v1/health"),
    refetchInterval: 30_000,
  });
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Skeleton h={200} />;
  const h = q.data;
  const facts: [string, string][] = [
    [t("Version"), `${h.version} (${h.environment})`],
    [
      t("Last event"),
      h.ingest.seconds_since_last_event === null
        ? t("none in 30 days")
        : ago(Date.now() - h.ingest.seconds_since_last_event * 1000),
    ],
    [
      t("Failed hits (dead letters)"),
      h.queue.dlq_depth === null ? t("none recorded") : String(h.queue.dlq_depth),
    ],
    [t("Database size"), h.d1.size_mb === null ? t("unknown") : `${h.d1.size_mb} MB`],
    [
      t("Last Pulse backup"),
      h.backups.last
        ? `${ago(h.backups.last.at)}${h.backups.last.ok ? "" : ` ${t("(failed)")}`}`
        : t("none yet"),
    ],
  ];
  return (
    <div className="flex flex-col gap-6">
      <Section title={t("System")}>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {facts.map(([k, val]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-line py-2">
              <dt className="text-ink-2">{k}</dt>
              <dd className="t-num text-right text-[15px]">{val}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title={t("Ingest today")}>
        <DataTable
          rows={h.ingest.today}
          empty={t("No hits today.")}
          columns={[
            { key: "site_id", label: t("Site") },
            { key: "accepted", label: t("Accepted"), metric: "n" },
            { key: "dropped_bot", label: t("Bots"), metric: "n" },
            { key: "dropped_hosting", label: t("Hosting"), metric: "n" },
            { key: "dropped_dnt", label: t("DNT"), metric: "n" },
            { key: "dropped_host", label: t("Wrong host"), metric: "n" },
            { key: "dropped_excluded", label: t("Excluded"), metric: "n" },
            { key: "dropped_invalid", label: t("Invalid"), metric: "n" },
            { key: "dropped_rate", label: t("Rate limited"), metric: "n" },
          ]}
        />
      </Section>
    </div>
  );
}

export function SettingsPage() {
  const { section = "keys" } = useParams({ strict: false }) as { section?: SectionId };
  const navigate = useNavigate();
  const current = SECTIONS.find(([k]) => k === section)?.[0] ?? "keys";
  const items = SECTIONS.map(([id, label, icon]) => ({ id, label, icon }));
  return (
    <div>
      <h1 className="t-title mb-6">{t("Settings")}</h1>
      <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
        <SideNav
          items={items}
          active={current}
          label={t("Settings sections")}
          onSelect={(k) => void navigate({ to: "/settings/$section", params: { section: k } })}
          item={(it, cls, content, cur) => (
            <Link
              key={it.id}
              to="/settings/$section"
              params={{ section: it.id }}
              aria-current={cur ? "page" : undefined}
              className={cls}
            >
              {content}
            </Link>
          )}
        />
        <div className="min-w-0 max-w-[1180px]">
          {current === "keys" && (
            <div className="flex flex-col gap-6">
              <Keys />
              <ConnectedApps />
            </div>
          )}
          {current === "notifications" && <Notifications />}
          {current === "reports" && <Reports />}
          {current === "people" && <People />}
          {current === "ops" && <Ops />}
          {current === "sites" && <AllSites />}
          {current === "audit" && <Audit />}
          {current === "imports" && <Imports />}
          {current === "system" && <System />}
        </div>
      </div>
    </div>
  );
}
