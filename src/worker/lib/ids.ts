import { monotonicFactory } from "ulid";

const next = monotonicFactory();

export function ulid(ts?: number): string {
  return next(ts);
}
