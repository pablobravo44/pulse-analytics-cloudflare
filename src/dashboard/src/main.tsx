import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, applyTheme } from "./components/Shell.tsx";
import { ToastProvider } from "./components/ui.tsx";
import { t } from "./lib/i18n.ts";
import { validateSiteSearch } from "./lib/state.ts";
import { LoginPage } from "./pages/auth.tsx";
import { AddSitePage } from "./pages/sites.tsx";
import { SitesPage } from "./pages/home.tsx";
import "./styles.css";

// The home page ships in the main chunk; every other page (the site overview too) loads on first visit.
const OverviewPage = lazyRouteComponent(() => import("./pages/overview.tsx"), "OverviewPage");
const more = () => import("./pages/more.tsx");
const SettingsPage = lazyRouteComponent(() => import("./pages/settings.tsx"), "SettingsPage");
const SiteSettingsPage = lazyRouteComponent(() => import("./pages/siteSettings.tsx"), "SiteSettingsPage");
const StatusPage = lazyRouteComponent(() => import("./pages/status.tsx"), "StatusPage");
const SessionsPage = lazyRouteComponent(() => import("./pages/sessions.tsx"), "SessionsPage");
const SharePage = lazyRouteComponent(() => import("./pages/share.tsx"), "SharePage");
const RealtimePage = lazyRouteComponent(() => import("./pages/live.tsx"), "SiteRealtimePage");
const LivePage = lazyRouteComponent(() => import("./pages/live.tsx"), "LivePage");
const GoalsPage = lazyRouteComponent(more, "GoalsPage");
const FunnelsPage = lazyRouteComponent(more, "FunnelsPage");
const PathsPage = lazyRouteComponent(more, "PathsPage");
const RetentionPage = lazyRouteComponent(more, "RetentionPage");
const VitalsPage = lazyRouteComponent(more, "VitalsPage");
const ErrorsPage = lazyRouteComponent(more, "ErrorsPage");
const AnnotationsPage = lazyRouteComponent(more, "AnnotationsPage");

applyTheme();

function Layout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-fog px-4">
      <div className="panel w-full max-w-sm px-7 py-8 text-center">
        <p className="t-num text-[38px] font-bold leading-none text-ink-3">404</p>
        <h1 className="t-heading mt-3 text-[20px] leading-7">{t("Page not found")}</h1>
        <p className="mt-1 mb-6 text-sm text-ink-2">{t("There is nothing at this address.")}</p>
        <Link to="/" className="btn btn-primary w-full justify-center">
          {t("Back to Pulse")}
        </Link>
      </div>
    </main>
  );
}

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });
const login = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const share = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$token",
  component: SharePage,
  validateSearch: validateSiteSearch,
});
const app = createRoute({ getParentRoute: () => rootRoute, id: "app", component: Layout });
const index = createRoute({ getParentRoute: () => app, path: "/", component: SitesPage });
const addSite = createRoute({ getParentRoute: () => app, path: "/add-site", component: AddSitePage });
const settingsIndex = createRoute({
  getParentRoute: () => app,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "keys" } });
  },
});
const settings = createRoute({
  getParentRoute: () => app,
  path: "/settings/$section",
  component: SettingsPage,
  validateSearch: (s: Record<string, unknown>) => (s.new === "1" || s.new === 1 ? { new: "1" } : {}),
});
const status = createRoute({
  getParentRoute: () => app,
  path: "/status",
  component: StatusPage,
  validateSearch: (s: Record<string, unknown>) => ({
    ...(s.new === "1" || s.new === 1 ? { new: "1" } : {}),
    ...(typeof s.site === "string" ? { site: s.site } : {}),
  }),
});
const live = createRoute({ getParentRoute: () => app, path: "/live", component: LivePage });
const siteRoute = (path: string, component: Parameters<typeof createRoute>[0]["component"]) =>
  createRoute({
    getParentRoute: () => app,
    path: `/sites/$site${path}`,
    component,
    validateSearch: validateSiteSearch,
  });

const routeTree = rootRoute.addChildren([
  login,
  share,
  app.addChildren([
    index,
    addSite,
    settingsIndex,
    settings,
    status,
    live,
    siteRoute("", OverviewPage),
    siteRoute("/realtime", RealtimePage),
    siteRoute("/goals", GoalsPage),
    siteRoute("/funnels", FunnelsPage),
    siteRoute("/paths", PathsPage),
    siteRoute("/sessions", SessionsPage),
    siteRoute("/retention", RetentionPage),
    siteRoute("/vitals", VitalsPage),
    siteRoute("/errors", ErrorsPage),
    siteRoute("/annotations", AnnotationsPage),
    siteRoute("/settings", SiteSettingsPage),
  ]),
]);

// Page changes cross-fade (200 ms) and a site's name travels from its card or the sidebar to its header (View Transitions).
const router = createRouter({ routeTree, defaultPreload: "intent", defaultViewTransition: true });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
