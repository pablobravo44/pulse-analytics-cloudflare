// Public, read-only view of one site's overview, opened from a share link (/share/<token>).
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorBox, Field, Skeleton } from "../components/ui.tsx";
import { setFaviconsAllowed } from "../components/icons.tsx";
import { api, HttpError, setShare } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { ReadOnly } from "../lib/state.ts";
import { OverviewPage } from "./overview.tsx";

export function SharePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState("");
  setShare(token, submitted || null);
  setFaviconsAllowed(false);
  useEffect(() => {
    setShare(token, submitted || null);
    setFaviconsAllowed(false);
    return () => {
      setShare(null);
      setFaviconsAllowed(true);
    };
  }, [token, submitted]);
  const q = useQuery({
    queryKey: ["share-site", token, submitted],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>("/api/v1/sites"),
    retry: false,
  });
  const err = q.error as HttpError | null;
  if (err && (err.code === "password_required" || err.code === "password_wrong")) {
    return (
      <main className="grid min-h-screen place-items-center bg-fog px-4">
        <form
          className="panel w-full max-w-sm px-7 py-8"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(password);
          }}
        >
          <img src="/favicon.svg" alt="" width={36} height={36} className="mb-4" />
          <h1 className="t-heading mb-1 text-[20px] leading-7">{t("Shared report")}</h1>
          <p className="mb-4 text-sm text-ink-2">
            {t("This link is protected. Enter the password you were given.")}
          </p>
          <Field label={t("Password")}>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </Field>
          {err.code === "password_wrong" && (
            <p className="mt-2 text-sm text-bad">{t("That password isn't right.")}</p>
          )}
          <button className="btn btn-primary mt-4 w-full" type="submit">
            {t("Open report")}
          </button>
        </form>
      </main>
    );
  }
  if (err) {
    return (
      <main className="grid min-h-screen place-items-center bg-fog px-4">
        <div className="max-w-sm text-center">
          <h1 className="t-heading mb-2 text-[20px] leading-7">{t("This link doesn't work")}</h1>
          <ErrorBox error={err} />
        </div>
      </main>
    );
  }
  const site = q.data?.data[0] as { id: string; name: string; color?: string } | undefined;
  return (
    <ReadOnly.Provider value={true}>
      <div className="min-h-screen" data-site={site?.color}>
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-2.5 sm:px-8">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="swatch" aria-hidden="true" />
            <span className="t-heading truncate">{site?.name ?? t("Shared report")}</span>
            <span className="chip chip-mark shrink-0">{t("Read-only")}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
            <img src="/favicon.svg" alt="" width={16} height={16} />{" "}
            {t("Cookieless analytics by Pulse")}
          </span>
        </header>
        <main className="w-full max-w-none px-4 py-6 sm:px-8">
          {site ? <OverviewPage siteId={site.id} /> : <Skeleton h={400} />}
        </main>
      </div>
    </ReadOnly.Provider>
  );
}
