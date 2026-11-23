// HTML for alert and report emails, in the dashboard's palette (inline styles only; mail clients drop <style>).
// Every email also has a plain-text twin, built by the caller from the same data.

const C = { paper: "#f1f4f2", sheet: "#ffffff", ink: "#18213a", ink2: "#4b5568", ink3: "#646d80", rule: "#d5ddd8", mark: "#f6e58d", up: "#1c7a48", down: "#b4332b" };
const FONT = "Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface MailBlock {
  heading?: string;
  /** Label, value, an optional change like "+12%" (coloured by sign) and whether lower is better (bounce rate). */
  rows?: [string, string, string?, boolean?][];
  lines?: string[];
}

function change(c: string | undefined, lowerIsBetter = false): string {
  if (!c) return "";
  const falling = c.startsWith("-") || c.startsWith("−");
  const color = falling !== lowerIsBetter ? C.down : C.up;
  return `<span style="color:${color};font-size:13px;margin-left:6px">${esc(c)}</span>`;
}

function block(b: MailBlock): string {
  const head = b.heading ? `<h2 style="margin:24px 0 8px;font:600 16px/1.3 ${FONT};color:${C.ink}">${esc(b.heading)}</h2>` : "";
  const rows = b.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${b.rows
        .map(
          ([label, value, ch, lower]) =>
            `<tr><td style="padding:6px 0;border-bottom:1px solid ${C.rule};font:14px/1.4 ${FONT};color:${C.ink2}">${esc(label)}</td><td align="right" style="padding:6px 0;border-bottom:1px solid ${C.rule};font:500 15px/1.4 ${FONT};color:${C.ink};white-space:nowrap">${esc(value)}${change(ch, lower)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const lines = b.lines?.length ? b.lines.map((l) => `<p style="margin:6px 0;font:14px/1.5 ${FONT};color:${C.ink2}">${esc(l)}</p>`).join("") : "";
  return head + rows + lines;
}

/** A full email: paper background, one white sheet, a highlighter rule under the title. */
export function emailHtml(o: { title: string; intro?: string; blocks: MailBlock[]; link?: { url: string; label: string }; footer?: string }): string {
  const link = o.link
    ? `<p style="margin:24px 0 0"><a href="${esc(o.link.url)}" style="display:inline-block;background:${C.ink};color:#ffffff;text-decoration:none;font:600 14px/1 ${FONT};padding:11px 16px;border-radius:6px">${esc(o.link.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:${C.paper}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.sheet};border:1px solid ${C.rule};border-radius:8px"><tr><td style="padding:24px 24px 28px">
<h1 style="margin:0 0 4px;font:700 22px/1.25 ${FONT};color:${C.ink};border-bottom:3px solid ${C.mark};padding-bottom:8px">${esc(o.title)}</h1>
${o.intro ? `<p style="margin:12px 0 0;font:15px/1.5 ${FONT};color:${C.ink2}">${esc(o.intro)}</p>` : ""}
${o.blocks.map(block).join("\n")}
${link}
</td></tr></table>${o.footer ? `<p style="margin:12px 0 0;font:12px/1.4 ${FONT};color:${C.ink3}">${esc(o.footer)}</p>` : ""}</td></tr></table></body></html>`;
}
