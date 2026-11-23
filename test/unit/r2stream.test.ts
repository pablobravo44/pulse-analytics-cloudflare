import { describe, expect, it } from "vitest";
import { backup, tableNdjson } from "../../src/worker/cron/jobs.ts";
import { putStream } from "../../src/worker/ops/r2stream.ts";
import { makeEnv, MemR2 } from "./harness.ts";

const streamOf = (chunks: (string | Error)[]) =>
  new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const c = chunks.shift();
      if (c === undefined) ctrl.close();
      else if (c instanceof Error) ctrl.error(c);
      else ctrl.enqueue(new TextEncoder().encode(c));
    },
  });

/** MemR2 that records multipart part sizes and aborts. */
class SpyR2 extends MemR2 {
  parts: number[] = [];
  aborted = 0;
  singlePuts = 0;
  override async put(key: string, value: unknown) {
    this.singlePuts++;
    return super.put(key, value);
  }
  override async createMultipartUpload(key: string) {
    const up = await super.createMultipartUpload(key);
    return {
      ...up,
      uploadPart: async (n: number, v: unknown) => (this.parts.push((v as Uint8Array).byteLength), up.uploadPart(n, v)),
      abort: async () => (this.aborted++, up.abort()),
    };
  }
}

const text = async (r2: MemR2, key: string) => new TextDecoder().decode(r2.objects.get(key)!.body);

describe("putStream", () => {
  it("cuts equal-size parts with a shorter last one, and round-trips the bytes", async () => {
    const r2 = new SpyR2(true);
    const n = await putStream(r2 as unknown as R2Bucket, "k", streamOf(["abcdefg", "hijklmnopqrstu", "vwxy"]), {}, 10);
    expect(n).toBe(25);
    expect(r2.parts).toEqual([10, 10, 5]);
    expect(r2.singlePuts).toBe(0);
    expect(await text(r2, "k")).toBe("abcdefghijklmnopqrstuvwxy");
  });

  it("uses one put for a body smaller than a part", async () => {
    const r2 = new SpyR2(true);
    await putStream(r2 as unknown as R2Bucket, "small", streamOf(["tiny"]), {}, 10);
    expect(r2.singlePuts).toBe(1);
    expect(r2.parts).toEqual([]);
    expect(await text(r2, "small")).toBe("tiny");
  });

  it("aborts the upload and writes nothing when the source fails", async () => {
    const r2 = new SpyR2(true);
    await expect(putStream(r2 as unknown as R2Bucket, "bad", streamOf(["0123456789ab", new Error("export broke")]), {}, 10)).rejects.toThrow("export broke");
    expect(r2.aborted).toBe(1);
    expect(r2.objects.has("bad")).toBe(false);
  });
});

describe("NDJSON backup stream", () => {
  it("pages through a table by rowid and the gzip in R2 holds every row", async () => {
    const h = makeEnv();
    const ins = h.db.sqlite.prepare("INSERT INTO audit_log (id, ts, actor, action) VALUES (?, ?, 'test', 'x')");
    for (let i = 0; i < 5003; i++) ins.run(`a${i}`, i);
    const { stream, rows } = tableNdjson(h.db, "audit_log");
    const lines = (await new Response(stream).text()).trim().split("\n");
    expect(rows()).toBe(5003);
    expect(lines).toHaveLength(5003);
    expect(JSON.parse(lines[5002]!)).toMatchObject({ id: "a5002", ts: 5002 });

    const r2 = new MemR2(true);
    Object.assign(h.env, { BACKUPS: r2 });
    const r = await backup(h.env, Date.UTC(2026, 9, 18, 4));
    expect(r.tables.audit_log).toBe(5003);
    const gz = r2.objects.get(`${r.key}audit_log.ndjson.gz`)!.body;
    const back = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(back.trim().split("\n")).toHaveLength(5003);
  });
});
