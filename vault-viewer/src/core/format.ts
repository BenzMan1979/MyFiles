// The sealed vault: a viewer HTML page with an encrypted payload embedded as <script> blocks.
//
//   <script type="application/json" id="vault-header">{...plaintext header...}</script>
//   <script type="application/octet-stream" class="vault-chunk">base64...</script>  (repeated)
//
// The header holds only non-secret data plus the encrypted manifest. The manifest (file names,
// recipient, policy, protection settings) and every file are AES-256-GCM encrypted.

import { fromB64, fromUtf8, randomBytes, toB64, utf8 } from './bytes';
import { aesDecrypt, aesEncrypt, deriveAuthKey, deriveContentKey, derivePasswordKey, DEFAULT_KDF, type KdfParams } from './crypto';
import { randomId } from './keytext';

export const FORMAT = 'vault-viewer';
export const FORMAT_VERSION = 1;
export const PAYLOAD_MARKER = '<!--VAULT-PAYLOAD-->';
export const TITLE_MARKER = '__VAULT_TITLE__';
/** Raw bytes per embedded chunk (multiple of 3 so chunks base64-encode without padding). */
export const CHUNK_BYTES = 3 * 1024 * 1024;

export type VaultMode = 'online' | 'offline';

export interface Policy {
  /** ISO date-time; null = no limit */
  notBefore: string | null;
  expiresAt: string | null;
  /** null = unlimited */
  maxOpens: number | null;
  /** wrong password/key attempts before lock; 0 = never lock */
  maxFailures: number;
  /** re-unlocking within this window after an idle lock does not use up another open */
  sessionMinutes: number;
}

export interface Protection {
  watermark: {
    enabled: boolean;
    text: string;
    opacity: number;
    /** font size in px; older vaults have none (18) */
    size?: number;
    /** 1 (sparse) … 5 (dense); older vaults have none (3) */
    density?: number;
  };
  allowCopy: boolean;
  allowPrint: boolean;
  allowDownload: boolean;
  /** lock after N minutes without input; 0 = off */
  idleLockMinutes: number;
  /** lock when the window stays hidden/unfocused for N seconds; 0 = off */
  blurLockSeconds: number;
}

export const DEFAULT_POLICY: Policy = { notBefore: null, expiresAt: null, maxOpens: null, maxFailures: 5, sessionMinutes: 30 };

export const DEFAULT_PROTECTION: Protection = {
  watermark: { enabled: true, text: '{收件人}  {時間}', opacity: 0.16, size: 18, density: 3 },
  allowCopy: false,
  allowPrint: false,
  allowDownload: false,
  idleLockMinutes: 10,
  blurLockSeconds: 0,
};

export interface FileEntry {
  id: string;
  path: string;
  size: number;
  mime: string;
  offset: number;
  length: number;
  iv: string;
}

export interface Manifest {
  title: string;
  recipient: string;
  /** free text from the sender (department, laptop name…), usable in the watermark as {備註} */
  note?: string;
  batchId: string;
  createdAt: string;
  policy: Policy;
  protection: Protection;
  files: FileEntry[];
}

export interface VaultHeader {
  format: typeof FORMAT;
  v: number;
  id: string;
  title: string;
  mode: VaultMode;
  server: string | null;
  salt: string;
  kdf: KdfParams;
  /** offline only: local wrong-attempt limit (online vaults are enforced by the server) */
  maxFailures: number;
  blobSize: number;
  manifest: { iv: string; ct: string };
}

export interface InputFile {
  path: string;
  mime: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

export interface BuildOptions {
  title: string;
  recipient: string;
  note?: string;
  batchId: string;
  mode: VaultMode;
  server: string | null;
  policy: Policy;
  protection: Protection;
  password: string;
  keyfile: Uint8Array;
  /** required for online vaults */
  serverShare: Uint8Array | null;
  kdf?: KdfParams;
  vaultId?: string;
}

export interface BuiltVault {
  header: VaultHeader;
  blobParts: Uint8Array[];
  authKey: Uint8Array;
}

function headerAad(h: Omit<VaultHeader, 'manifest'>): Uint8Array {
  return utf8(JSON.stringify([h.format, h.v, h.id, h.title, h.mode, h.server, h.salt, h.kdf, h.maxFailures, h.blobSize]));
}

const fileAad = (vaultId: string, fileId: string) => utf8(`${vaultId}:file:${fileId}`);

export async function buildVault(
  files: InputFile[],
  o: BuildOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<BuiltVault> {
  if (o.mode === 'online' && (!o.server || !o.serverShare)) throw new Error('online vault needs a server and a server share');
  const id = o.vaultId ?? randomId();
  const salt = randomBytes(16);
  const kdf = o.kdf ?? DEFAULT_KDF;
  const pwKey = await derivePasswordKey(o.password, salt, kdf);
  const authKey = await deriveAuthKey(pwKey, o.keyfile, salt);
  const contentKey = await deriveContentKey(pwKey, o.keyfile, o.mode === 'online' ? o.serverShare : null, salt);

  const entries: FileEntry[] = [];
  const blobParts: Uint8Array[] = [];
  let offset = 0;
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  for (const f of files) {
    const fid = randomId(8);
    const iv = randomBytes(12);
    const ct = await aesEncrypt(contentKey, iv, await f.read(), fileAad(id, fid));
    entries.push({ id: fid, path: f.path, size: f.size, mime: f.mime, offset, length: ct.length, iv: toB64(iv) });
    blobParts.push(ct);
    offset += ct.length;
    done += f.size;
    onProgress?.(done, total);
  }

  const manifest: Manifest = {
    title: o.title,
    recipient: o.recipient,
    note: o.note || undefined,
    batchId: o.batchId,
    createdAt: new Date().toISOString(),
    policy: o.policy,
    protection: o.protection,
    files: entries,
  };
  const base: Omit<VaultHeader, 'manifest'> = {
    format: FORMAT,
    v: FORMAT_VERSION,
    id,
    title: o.title,
    mode: o.mode,
    server: o.mode === 'online' ? o.server : null,
    salt: toB64(salt),
    kdf,
    maxFailures: o.policy.maxFailures,
    blobSize: offset,
  };
  const miv = randomBytes(12);
  const mct = await aesEncrypt(contentKey, miv, utf8(JSON.stringify(manifest)), headerAad(base));
  return { header: { ...base, manifest: { iv: toB64(miv), ct: toB64(mct) } }, blobParts, authKey };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Yields the blob in CHUNK_BYTES slices without materialising one giant array. */
function* sliceParts(parts: Uint8Array[]): Generator<Uint8Array> {
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  for (const p of parts) {
    let pos = 0;
    while (pos < p.length) {
      const take = Math.min(CHUNK_BYTES - pendingLen, p.length - pos);
      pending.push(p.subarray(pos, pos + take));
      pendingLen += take;
      pos += take;
      if (pendingLen === CHUNK_BYTES) {
        yield pending.length === 1 ? pending[0] : joinParts(pending, pendingLen);
        pending = [];
        pendingLen = 0;
      }
    }
  }
  if (pendingLen > 0) yield pending.length === 1 ? pending[0] : joinParts(pending, pendingLen);
}

function joinParts(parts: Uint8Array[], len: number): Uint8Array {
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Returns the vault HTML as string pieces (feed them to `new Blob(pieces)` in the browser). */
export function renderVaultHtml(template: string, header: VaultHeader, blobParts: Uint8Array[]): string[] {
  const at = template.indexOf(PAYLOAD_MARKER);
  if (at < 0) throw new Error('viewer template has no payload marker');
  const head = template.slice(0, at).replace(TITLE_MARKER, escapeHtml(header.title));
  const tail = template.slice(at + PAYLOAD_MARKER.length);
  const json = JSON.stringify(header).replace(/</g, '\\u003c');
  const pieces = [head, `<script type="application/json" id="vault-header">${json}</script>\n`];
  for (const chunk of sliceParts(blobParts)) {
    pieces.push(`<script type="application/octet-stream" class="vault-chunk">${toB64(chunk)}</script>\n`);
  }
  pieces.push(tail);
  return pieces;
}

export interface Payload {
  header: VaultHeader;
  chunks: string[];
}

function checkHeader(h: VaultHeader): VaultHeader {
  if (h?.format !== FORMAT) throw new Error('這不是隨身密閱的封存檔');
  if (h.v > FORMAT_VERSION) throw new Error('封存檔版本較新，請使用新版檢視器');
  return h;
}

export function readPayloadFromDocument(doc: Document): Payload | null {
  const h = doc.getElementById('vault-header');
  if (!h) return null;
  const nodes = Array.from(doc.querySelectorAll('script.vault-chunk'));
  const chunks = nodes.map((s) => s.textContent ?? '');
  // The page would otherwise keep a second copy of the whole payload for as long as it is open.
  nodes.forEach((s) => s.remove());
  return { header: checkHeader(JSON.parse(h.textContent ?? '')), chunks };
}

/** For the hosted viewer page: parse a vault file the user picked, without building a DOM. */
export function readPayloadFromHtml(html: string): Payload {
  const hm = html.match(/<script type="application\/json" id="vault-header">([\s\S]*?)<\/script>/);
  if (!hm) throw new Error('這不是隨身密閱的封存檔');
  const chunks: string[] = [];
  const re = /<script type="application\/octet-stream" class="vault-chunk">([^<]*)<\/script>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) chunks.push(m[1]);
  return { header: checkHeader(JSON.parse(hm[1])), chunks };
}

/**
 * Random access into the embedded blob. Only the chunks covering a file are decoded, so opening
 * one document in a 300 MB vault does not decode all 300 MB.
 */
export class ChunkReader {
  private cache = new Map<number, Uint8Array>();

  constructor(private p: Payload) {
    const expected = Math.ceil(p.header.blobSize / CHUNK_BYTES);
    if (p.chunks.length !== expected) throw new Error('封存檔內容不完整（檔案可能損毀或被截斷）');
  }

  private chunk(i: number): Uint8Array {
    let c = this.cache.get(i);
    if (!c) {
      c = fromB64(this.p.chunks[i]);
      if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(i, c);
    }
    return c;
  }

  read(offset: number, length: number): Uint8Array {
    if (offset + length > this.p.header.blobSize) throw new Error('封存檔內容不完整（檔案可能損毀或被截斷）');
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = offset + done;
      const i = Math.floor(pos / CHUNK_BYTES);
      const c = this.chunk(i);
      const from = pos - i * CHUNK_BYTES;
      const take = Math.min(c.length - from, length - done);
      out.set(c.subarray(from, from + take), done);
      done += take;
    }
    return out;
  }

  clear() {
    this.cache.clear();
  }
}

export async function prepareUnlock(header: VaultHeader, password: string, keyfile: Uint8Array) {
  const salt = fromB64(header.salt);
  const pwKey = await derivePasswordKey(password, salt, header.kdf);
  const authKey = await deriveAuthKey(pwKey, keyfile, salt);
  return { pwKey, authKey, salt };
}

/** Throws if the password, key file or server share is wrong. */
export async function openManifest(header: VaultHeader, contentKey: CryptoKey): Promise<Manifest> {
  const { manifest, ...base } = header;
  const pt = await aesDecrypt(contentKey, fromB64(manifest.iv), fromB64(manifest.ct), headerAad(base));
  return JSON.parse(fromUtf8(pt)) as Manifest;
}

export function readFile(header: VaultHeader, blob: ChunkReader, entry: FileEntry, contentKey: CryptoKey): Promise<Uint8Array> {
  return aesDecrypt(contentKey, fromB64(entry.iv), blob.read(entry.offset, entry.length), fileAad(header.id, entry.id));
}

export { deriveContentKey };
