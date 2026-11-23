export const SCOPES = ["stats:read", "events:export", "annotations:write", "sites:write", "ops:write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** What each scope allows, in the words the dashboard, docs and agents use. */
export const SCOPE_INFO: Record<Scope, string> = {
  "stats:read": "Read analytics, goals, funnels, annotations, status checks and site settings",
  "events:export": "Export raw event rows",
  "annotations:write": "Add and delete annotations (change markers on charts)",
  "sites:write": "Add, edit and archive sites; create and edit goals and funnels",
  "ops:write": "Add, edit, pause and test status checks; scheduled reports; the database size warning",
  "admin": "Everything, plus API keys, people, imports, data deletion, ops jobs and which databases are backed up",
};

export interface Principal {
  kind: "key" | "user" | "oauth" | "share";
  /** api key id, user id, or oauth grant user id */
  id: string;
  /** For audit: "key:<prefix>", "user:<email>", "oauth:<client>", "share:<id>" */
  label: string;
  scopes: Scope[];
  /** null = all sites */
  siteIds: string[] | null;
  role?: "owner" | "admin" | "viewer";
  /** Share links bound to a saved view: the view's filters, applied to every query. */
  filters?: [string, string, (string | number)[]][];
}

export function hasScope(p: Principal, s: Scope): boolean {
  return p.scopes.includes("admin") || p.scopes.includes(s);
}

export function canAccessSite(p: Principal, siteId: string): boolean {
  return p.siteIds === null || p.siteIds.includes(siteId);
}

export function roleScopes(role: "owner" | "admin" | "viewer"): Scope[] {
  if (role === "viewer") return ["stats:read"];
  return [...SCOPES];
}

/** The sites a user may see: viewers with a list are limited to it; everyone else sees all (null). */
export function userSiteIds(role: "owner" | "admin" | "viewer", siteIdsJson: string | null): string[] | null {
  return role === "viewer" && siteIdsJson ? (JSON.parse(siteIdsJson) as string[]) : null;
}

/**
 * An OAuth grant's principal narrowed to what its user may do today. Grants freeze scopes and sites at consent;
 * if the user was since made a viewer or lost access to a site, the connector loses it too, on the next request.
 */
export function narrowToUser(granted: Principal, user: { role: "owner" | "admin" | "viewer"; site_ids_json: string | null }): Principal {
  const allowed = roleScopes(user.role);
  const scopes = granted.scopes.filter((s) => allowed.includes(s) || allowed.includes("admin"));
  const mine = userSiteIds(user.role, user.site_ids_json);
  const siteIds = granted.siteIds === null ? mine : mine === null ? granted.siteIds : granted.siteIds.filter((s) => mine.includes(s));
  return { ...granted, scopes, siteIds };
}
