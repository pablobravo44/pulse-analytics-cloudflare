// Soft filter for traffic that comes from hosting and cloud networks (datacenter scrapers with browser user agents).
// Cloudflare gives the request's network as `cf.asn` / `cf.asOrganization`. The network is only looked up here:
// the ASN and its name are never stored, queued or logged, only the yes/no result is used (src/worker/ingest/handler.ts).

/** Well-known hosting/cloud autonomous systems. Deliberately short: a wrong entry would drop real visitors. */
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  16509, // Amazon AWS
  14618, // Amazon AWS (us-east-1)
  396982, // Google Cloud
  8075, // Microsoft (Azure)
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
  63949, // Linode / Akamai Connected Cloud
  45102, // Alibaba Cloud
  37963, // Alibaba (Hangzhou)
  132203, // Tencent Cloud
  45090, // Tencent (Shenzhen)
  136907, // Huawei Cloud
  31898, // Oracle Cloud
  51167, // Contabo
  20473, // Vultr (Choopa)
  12876, // Scaleway
]);

/** Fallback on the network's name, for hosts that aren't in the list. */
const HOSTING_ORG = /\b(hosting|cloud|data ?cent(?:er|re)s?|servers?)\b/i;

/** Is the request from a hosting/cloud network? Both inputs come from Cloudflare's `request.cf` and may be missing. */
export function isHostingNetwork(asn: unknown, asOrganization: unknown): boolean {
  if (typeof asn === "number" && HOSTING_ASNS.has(asn)) return true;
  return typeof asOrganization === "string" && HOSTING_ORG.test(asOrganization);
}
