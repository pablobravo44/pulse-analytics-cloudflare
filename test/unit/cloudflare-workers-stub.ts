// Node stand-in for the `cloudflare:workers` module (unit tests only).
export class WorkerEntrypoint<E = unknown> {
  ctx: unknown;
  env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class DurableObject<E = unknown> {
  ctx: unknown;
  env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class RpcTarget {}
export const env = {};
export class EmailMessage {
  from: string;
  to: string;
  raw: string;
  constructor(from: string, to: string, raw: string) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
