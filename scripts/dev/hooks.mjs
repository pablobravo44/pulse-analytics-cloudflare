// Node module hooks for the local dev server: `cloudflare:*` modules resolve to the unit-test stand-ins.
const STUB = new URL("../../test/unit/cloudflare-workers-stub.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers" || specifier === "cloudflare:email") return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
