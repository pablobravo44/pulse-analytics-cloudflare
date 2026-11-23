// Stream a body into R2 without holding it in memory: a multipart upload with fixed-size parts (R2 wants every
// part but the last to be the same size, at least 5 MiB). Bodies smaller than one part are a single put.
// The key must be new: the backup buckets are retention-locked (src/worker/lib/backupkeys.ts).

export const PART_BYTES = 8 * 1024 * 1024;

type PutOptions = { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> };

/** Upload `stream` to `key`; resolves to the number of bytes written. On failure the multipart upload is aborted. */
export async function putStream(bucket: R2Bucket, key: string, stream: ReadableStream<Uint8Array>, opts: PutOptions = {}, partBytes = PART_BYTES): Promise<number> {
  const reader = stream.getReader();
  let chunks: Uint8Array[] = [];
  let held = 0;
  let total = 0;
  let upload: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];

  // Take exactly `n` bytes off the front of what's held.
  const take = (n: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = chunks[0]!;
      const want = n - at;
      if (c.byteLength <= want) {
        out.set(c, at);
        at += c.byteLength;
        chunks.shift();
      } else {
        out.set(c.subarray(0, want), at);
        chunks[0] = c.subarray(want);
        at = n;
      }
    }
    held -= n;
    return out;
  };
  const sendPart = async (bytes: Uint8Array<ArrayBuffer>) => {
    upload ??= await bucket.createMultipartUpload(key, opts);
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(value);
      held += value.byteLength;
      total += value.byteLength;
      while (held >= partBytes) await sendPart(take(partBytes));
    }
    if (!upload) {
      await bucket.put(key, take(held), opts);
      return total;
    }
    if (held) await sendPart(take(held));
    await (upload as R2MultipartUpload).complete(parts);
    chunks = [];
    return total;
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (upload) await (upload as R2MultipartUpload).abort().catch(() => {});
    throw err;
  }
}
