// Cloud link vaults: the viewer page is opened as https://<server>/v/<vault id>. The plaintext header
// comes from the server; after a successful unlock the server hands out the encrypted blob, part
// by part, only to the holder of the pass it issued. Decryption still happens only on this device.

import type { BlobSource, Payload, VaultHeader } from '../core/format';

export type RemoteBlob = NonNullable<Payload['remote']>;

/** The vault id in a cloud link, or null on the plain viewer page. */
export function remoteVaultId(loc: Location = location): string | null {
  const m = loc.pathname.match(/\/v\/([a-z0-9]{1,64})\/?$/);
  return m ? m[1] : null;
}

/** Loads what is needed to show the unlock screen. Errors carry a message for the recipient. */
export async function loadRemoteVault(id: string, origin = location.origin): Promise<Payload> {
  let res: Response;
  try {
    res = await fetch(`${origin}/api/vault/${id}`, { cache: 'no-store' });
  } catch {
    throw new Error('無法連線到伺服器，請確認網路連線後重新整理');
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; header?: VaultHeader; blob?: RemoteBlob };
  if (!res.ok || !data.header || !data.blob) throw new Error(data.message ?? `伺服器回應異常（HTTP ${res.status}）`);
  return { header: data.header, chunks: [], remote: data.blob };
}

const PARALLEL = 3;

/** Reads byte ranges of the blob from the server, which fetches them from the cloud storage. */
export class RemoteReader implements BlobSource {
  private cache = new Map<string, Uint8Array>();
  private cachedBytes = 0;

  constructor(
    private server: string,
    private vaultId: string,
    private blob: RemoteBlob,
    private pass: string,
    /** called with (bytes done, bytes wanted) while a large read is in progress */
    public onProgress: ((done: number, total: number) => void) | null = null,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.blob.size) throw new Error('封存檔內容不完整（檔案可能損毀）');
    const key = `${offset}:${length}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = new Uint8Array(length);
    // one request per part the range touches, a few at a time
    const jobs: { part: number; from: number; to: number; at: number }[] = [];
    const pb = this.blob.partBytes;
    for (let pos = offset; pos < offset + length; ) {
      const part = Math.floor(pos / pb);
      const end = Math.min(offset + length, (part + 1) * pb);
      jobs.push({ part, from: pos - part * pb, to: end - part * pb - 1, at: pos - offset });
      pos = end;
    }
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        const bytes = await this.fetchPart(j.part, j.from, j.to);
        out.set(bytes, j.at);
        done += bytes.length;
        this.onProgress?.(done, length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
    this.remember(key, out);
    return out;
  }

  private async fetchPart(part: number, from: number, to: number): Promise<Uint8Array> {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(`${this.server}/api/blob/${this.vaultId}/${part}`, {
          headers: { authorization: `Bearer ${this.pass}`, range: `bytes=${from}-${to}` },
          cache: 'no-store',
        });
      } catch {
        res = null;
      }
      if (res && (res.ok || (res.status >= 400 && res.status < 500))) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    if (!res) throw new Error('無法連線到伺服器，請確認網路連線');
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(data.message ?? `讀取失敗（HTTP ${res.status}）`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A storage that ignores Range sends the whole part: cut out what was asked for.
    if (res.status === 200 && bytes.length > to - from + 1) return bytes.subarray(from, to + 1);
    if (bytes.length !== to - from + 1) throw new Error('從雲端讀到的內容不完整，請再試一次');
    return bytes;
  }

  /** Keeps the last few reads (re-opening a file or downloading it does not fetch it again). */
  private remember(key: string, data: Uint8Array) {
    const LIMIT = 96 * 1024 * 1024;
    if (data.length > LIMIT) return;
    this.cache.set(key, data);
    this.cachedBytes += data.length;
    while (this.cachedBytes > LIMIT || this.cache.size > 8) {
      const [k, v] = this.cache.entries().next().value!;
      this.cache.delete(k);
      this.cachedBytes -= v.length;
    }
  }

  clear() {
    this.cache.clear();
    this.cachedBytes = 0;
  }
}
