import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { sameOriginPath } from "../lib/next.ts";

function safeNext(): string {
  // Only paths on this origin ("/\evil.com" is another host to a browser).
  return sameOriginPath(new URLSearchParams(location.search).get("next"), location.origin);
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-fog px-4">
      <div className="panel w-full max-w-sm px-7 py-8 text-center">
        <img src="/favicon.svg" alt="" width={44} height={44} className="mx-auto mb-4" />
        <h1 className="t-heading mb-1 text-[20px] leading-7">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function LoginPage() {
  const [access, setAccess] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .get<{ access: boolean }>("/auth/methods")
      .then((m) => setAccess(m.access))
      .catch(() => setAccess(false));
  }, []);
  return (
    <Shell title={t("Sign in to Pulse")}>
      <p className="mx-auto mb-6 text-sm text-ink-2">
        {t("Private, cookieless analytics. Sign in with a one-time code sent to your email.")}
      </p>
      {access === false ? (
        <p role="alert" className="text-sm text-bad">
          {t("Sign-in isn't configured on this server.")}
        </p>
      ) : (
        <a
          className="btn btn-primary w-full justify-center"
          href={`/auth/access?next=${encodeURIComponent(safeNext())}`}
        >
          {t("Sign in with an email code")}
        </a>
      )}
    </Shell>
  );
}
