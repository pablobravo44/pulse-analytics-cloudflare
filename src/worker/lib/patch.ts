/**
 * zod 4 applies `.default()` even inside `.partial()`, so a PATCH body parsed with a partial schema gains
 * fields the caller never sent. Keep only the keys present in the raw input.
 */
export function onlyGiven<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  const given = raw && typeof raw === "object" ? new Set(Object.keys(raw)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => given.has(k))) as Partial<T>;
}
