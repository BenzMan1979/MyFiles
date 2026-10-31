// All server logic, independent of Cloudflare so it can be unit-tested and self-hosted.
// The Durable Object (index.ts) just passes its storage in; there is exactly one Hub, so every
// counter update is serialised and strongly consistent.

import { Clouds, GOOGLE_CALLBACK } from './cloud';
import { BadRequest, body, CORS, fail, isStr, json, randomToken, type Store } from './common';
import { buildStats, type StatLog, type StatVault } from './stats';
import { StorageError } from './storage';

export type { Store } from './common';

export const SERVER_VERSION = 1;

/**
 * Everything here is set from outside (Worker secrets and variables), never in code. Numbers may
 * arrive as strings, because that is how the Cloudflare dashboard and `wrangler --var` pass them.
 */
export interface Env {
  /** secret: admin password; if unset, the first visitor can set one */
  ADMIN_PASSWORD?: string;
  /** hours an admin login stays valid (default 12) */
  ADMIN_SESSION_HOURS?: string | number;
  /** wrong admin passwords before the login is locked (default 5) */
  ADMIN_MAX_FAILURES?: string | number;
  /** minutes the admin login stays locked (default 15) */
  ADMIN_LOCK_MINUTES?: string | number;
  /** comma-separated websites allowed to call the admin API from a browser; empty = any (default) */
  ADMIN_ORIGINS?: string;
  /** days the open log is kept; 0 = forever (default 365) */
  LOG_RETENTION_DAYS?: string | number;
}

function envInt(v: string | number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export interface VaultPolicy {
  notBefore: string | null;
  expiresAt: string | null;
  maxOpens: number | null;
  maxFailures: number;
  sessionMinutes: number;
}

/** Where a "cloud link" vault's encrypted blob lives, split into fixed-size parts. */
interface CloudInfo {
  storage: string;
  size: number;
  partBytes: number;
  parts: number;
  /** the vault's folder (or prefix) in the storage; made when the first part arrives */
  container: string | null;
  refs: (string | null)[];
  /** all parts uploaded; until then the vault cannot be opened */
  complete: boolean;
}

interface VaultRecord {
  id: string;
  batchId: string;
  title: string;
  recipient: string;
  authKey: string;
  share: string;
  policy: VaultPolicy;
  opens: number;
  failures: number;
  locked: boolean;
  revoked: boolean;
  createdAt: string;
  lastOpenAt: string | null;
  cloud?: CloudInfo;
}

export interface LogEntry {
  t: string;
  ev: 'open' | 'resume' | 'bad_proof' | 'locked' | 'denied';
  detail?: string;
  /** short code shown in the viewer's watermark, so a leaked screenshot maps back to this entry */
  tag?: string;
  ip?: string;
  country?: string;
  ua?: string;
}

const NONCE_MS = 2 * 60 * 1000;
/** How long one unlock may keep reading a cloud vault's parts (re-unlocking issues a new pass). */
const BLOB_PASS_MS = 12 * 3600_000;
/** Size of each stored part of a cloud vault. Under the 100 MB request limit of Workers, few enough files for 2 GB. */
export const PART_BYTES = 32 * 1024 * 1024;
/** Largest cloud vault the server accepts (the packer has its own, lower, limit). */
const MAX_CLOUD_BYTES = 50 * 1024 ** 3;
/** The plaintext vault header kept for cloud vaults (salt, KDF settings, encrypted file list). */
const MAX_HEADER_CHARS = 1_500_000;
// Workers' free plan allows ~10 ms CPU per request, so the admin hash stays light; brute force
// is stopped by the login lockout instead.
const PBKDF2_ITERATIONS = 5000;

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function sha256(s: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function pbkdf2(password: string, salt: Bytes, iterations: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, 256));
}

async function hmac(key: Bytes, msg: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
}

/** Must match openProofMessage() in the client core. */
const openProofMessage = (vaultId: string, nonce: string) => enc.encode(`vault-viewer/v1/open:${vaultId}:${nonce}`) as Bytes;


function cleanPolicy(p: Partial<VaultPolicy> | undefined): VaultPolicy {
  const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const int = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  return {
    notBefore: date(p?.notBefore),
    expiresAt: date(p?.expiresAt),
    maxOpens: p?.maxOpens == null ? null : int(p.maxOpens, 1, 1, 1_000_000),
    maxFailures: int(p?.maxFailures, 5, 0, 1000),
    sessionMinutes: int(p?.sessionMinutes, 30, 0, 24 * 60),
  };
}

function publicVault(v: VaultRecord) {
  const { authKey: _a, share: _s, cloud, ...rest } = v;
  return { ...rest, cloud: cloud ? { storage: cloud.storage, size: cloud.size, complete: cloud.complete } : undefined };
}

export class Hub {
  private clouds: Clouds;
  /** first-part uploads in flight, so two parts arriving together do not each create a folder */
  private preparing = new Map<string, Promise<string>>();

  private partBytes: number;

  constructor(
    private store: Store,
    private env: Env,
    private now: () => number = Date.now,
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    /** tests use small parts to exercise multi-part vaults */
    opts: { partBytes?: number } = {},
  ) {
    this.clouds = new Clouds(store, fetcher, now);
    this.partBytes = opts.partBytes ?? PART_BYTES;
  }

  private get sessionMs() {
    return envInt(this.env.ADMIN_SESSION_HOURS, 12, 1, 24 * 30) * 3600_000;
  }
  private get maxAdminFailures() {
    return envInt(this.env.ADMIN_MAX_FAILURES, 5, 1, 1000);
  }
  private get adminLockMs() {
    return envInt(this.env.ADMIN_LOCK_MINUTES, 15, 1, 24 * 60) * 60_000;
  }
  private get logRetentionMs() {
    return envInt(this.env.LOG_RETENTION_DAYS, 365, 0, 36500) * 86_400_000;
  }
  private get adminOrigins(): string[] {
    return (this.env.ADMIN_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  }

  async handle(req: Request): Promise<Response> {
    const res = await this.respond(req);
    // Opening a vault must work from any page (a vault file on disk has the origin "null"), but the
    // admin API can be limited to the sites that are meant to use it.
    const origins = this.adminOrigins;
    if (!origins.length || !new URL(req.url).pathname.startsWith('/api/admin/')) return res;
    const headers = new Headers(res.headers);
    const origin = req.headers.get('origin');
    headers.delete('access-control-allow-origin');
    headers.append('vary', 'origin');
    if (origin && origins.includes(origin)) headers.set('access-control-allow-origin', origin);
    return new Response(res.body, { status: res.status, headers });
  }

  private async respond(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await this.route(req);
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, 'bad_request', e.message);
      if (e instanceof StorageError) return fail(e.status, e.code, e.message);
      throw e;
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    {
      if (path === '/api/info' && req.method === 'GET') return this.info();
      if (path === '/api/open/challenge' && req.method === 'POST') return this.challenge(await body(req));
      if (path === '/api/open' && req.method === 'POST') return this.open(req, await body(req));
      const cv = path.match(/^\/api\/vault\/([a-z0-9]{1,64})$/);
      if (cv && req.method === 'GET') return this.cloudHeader(cv[1]);
      const cb = path.match(/^\/api\/blob\/([a-z0-9]{1,64})\/(\d{1,6})$/);
      if (cb && req.method === 'GET') return this.readPart(req, cb[1], Number(cb[2]));
      if (path === GOOGLE_CALLBACK && req.method === 'GET') return this.clouds.googleCallback(url);
      if (path === '/api/admin/setup' && req.method === 'POST') return this.setup(await body(req));
      if (path === '/api/admin/login' && req.method === 'POST') return this.login(await body(req));
      if (path.startsWith('/api/admin/')) {
        const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (!(await this.checkAdmin(token))) return fail(401, 'unauthorized', '登入已過期，請重新登入管理員');
        if (path === '/api/admin/logout' && req.method === 'POST') {
          await this.store.delete(`admin:sess:${token}`);
          return json({ ok: true });
        }
        if (path === '/api/admin/password' && req.method === 'POST') return this.changePassword(await body(req));
        if (path === '/api/admin/vaults' && req.method === 'POST') return this.register(await body(req));
        if (path === '/api/admin/vaults' && req.method === 'GET') return this.listVaults();
        if (path === '/api/admin/stats' && req.method === 'GET') return this.stats(url.searchParams);
        if (path === '/api/admin/storage' && req.method === 'GET') return this.clouds.adminList(await this.storageUsage(), url.origin);
        if (path === '/api/admin/storage' && req.method === 'POST') return this.clouds.adminSave(await body(req));
        if (path === '/api/admin/storage/google/start' && req.method === 'POST') return this.clouds.googleStart(await body(req), url.origin);
        const st = path.match(/^\/api\/admin\/storage\/([a-z0-9]{1,40})(?:\/(test|default))?$/);
        if (st && st[2] === 'test' && req.method === 'POST') return this.clouds.adminTest(st[1]);
        if (st && st[2] === 'default' && req.method === 'POST') return this.clouds.adminSetDefault(st[1]);
        if (st && !st[2] && req.method === 'DELETE') return this.clouds.adminRemove(st[1], (await this.storageUsage()).get(st[1]) ?? 0);
        const up = path.match(/^\/api\/admin\/blob\/([a-z0-9]{1,64})\/(\d{1,6})$/);
        if (up && req.method === 'PUT') return this.uploadPart(req, up[1], Number(up[2]));
        const m = path.match(/^\/api\/admin\/vaults\/([a-z0-9]{1,64})(\/logs|\/complete)?$/);
        if (m && m[2] === '/complete' && req.method === 'POST') return this.completeUpload(m[1]);
        if (m && m[2] === '/logs' && req.method === 'GET') return this.logs(m[1]);
        if (m && !m[2] && req.method === 'PATCH') return this.update(m[1], await body(req));
        if (m && !m[2] && req.method === 'DELETE') return this.remove(m[1]);
      }
      return fail(404, 'not_found', '找不到這個功能');
    }
  }

  private async info() {
    return json({
      ok: true,
      app: 'vault-viewer-server',
      version: SERVER_VERSION,
      adminConfigured: await this.adminConfigured(),
      serverTime: new Date(this.now()).toISOString(),
      // this server can keep vaults in a cloud storage and hand them out as links
      cloud: { partBytes: this.partBytes },
    });
  }

  // ---------- opening a vault ----------

  private async challenge(b: Record<string, unknown>) {
    if (!isStr(b.vaultId, 64)) throw new BadRequest('vaultId');
    const v = await this.store.get<VaultRecord>(`vault:${b.vaultId}`);
    if (!v) return fail(404, 'unknown', '伺服器上找不到這份封存檔（可能已被刪除）');
    const now = this.now();
    for (const [k, exp] of await this.store.list<number>({ prefix: `nonce:${v.id}:` })) {
      if (exp < now) await this.store.delete(k);
    }
    const nonce = randomToken(18);
    await this.store.put(`nonce:${v.id}:${nonce}`, now + NONCE_MS);
    return json({ ok: true, nonce });
  }

  private async open(req: Request, b: Record<string, unknown>) {
    if (!isStr(b.vaultId, 64) || !isStr(b.nonce, 64) || !isStr(b.proof, 100)) throw new BadRequest('vaultId/nonce/proof');
    const key = `vault:${b.vaultId}`;
    const v = await this.store.get<VaultRecord>(key);
    if (!v) return fail(404, 'unknown', '伺服器上找不到這份封存檔（可能已被刪除）');
    const now = this.now();
    const tag = isStr(b.tag, 16) && /^[A-Za-z0-9]+$/.test(b.tag) ? b.tag : undefined;
    const ip = req.headers.get('x-vv-ip') || undefined;
    const country = req.headers.get('x-vv-country') || undefined;
    const meta = { ip, country, ua: req.headers.get('user-agent')?.slice(0, 200), tag };
    const deny = async (status: number, code: string, message: string, extra: object = {}) => {
      await this.log(v.id, { ev: 'denied', detail: code, ...meta });
      return fail(status, code, message, extra);
    };

    if (v.revoked) return deny(403, 'revoked', '這份封存檔已被發送者收回');
    if (v.locked) return deny(423, 'locked', '密碼錯誤次數過多，已鎖定。請聯絡發送者解除');
    if (v.cloud && !v.cloud.complete) return fail(409, 'uploading', '這份封存檔還沒有上傳完成，請稍後再試或聯絡發送者');

    const nonceKey = `nonce:${v.id}:${b.nonce}`;
    const nonceExp = await this.store.get<number>(nonceKey);
    await this.store.delete(nonceKey);
    if (!nonceExp || nonceExp < now) return fail(400, 'bad_nonce', '驗證逾時，請再試一次');

    const expected = await hmac(unb64(v.authKey), openProofMessage(v.id, b.nonce));
    if (!sameBytes(expected, unb64(b.proof))) {
      v.failures += 1;
      const max = v.policy.maxFailures;
      if (max > 0 && v.failures >= max) v.locked = true;
      await this.store.put(key, v);
      await this.log(v.id, { ev: v.locked ? 'locked' : 'bad_proof', ...meta });
      if (v.locked) return fail(423, 'locked', '密碼錯誤次數過多，已鎖定。請聯絡發送者解除');
      return fail(401, 'bad_proof', '密碼或金鑰不正確', { remainingAttempts: max > 0 ? max - v.failures : null });
    }
    v.failures = 0;

    if (v.policy.notBefore && now < Date.parse(v.policy.notBefore)) {
      await this.store.put(key, v);
      return deny(403, 'not_yet', `這份封存檔要到 ${v.policy.notBefore} 之後才能開啟`, { notBefore: v.policy.notBefore });
    }
    if (v.policy.expiresAt && now >= Date.parse(v.policy.expiresAt)) {
      await this.store.put(key, v);
      return deny(403, 'expired', '這份封存檔已過期', { expiresAt: v.policy.expiresAt });
    }

    // A still-valid session (re-unlock after an idle lock) does not use up another open.
    let resumed = false;
    if (isStr(b.session, 64)) {
      const s = await this.store.get<{ vaultId: string; expires: number }>(`sess:${b.session}`);
      resumed = !!s && s.vaultId === v.id && s.expires > now;
      if (!resumed) await this.store.delete(`sess:${b.session}`);
    }
    if (!resumed) {
      if (v.policy.maxOpens != null && v.opens >= v.policy.maxOpens) {
        await this.store.put(key, v);
        return deny(403, 'exhausted', '可開啟次數已用完');
      }
      v.opens += 1;
    }
    v.lastOpenAt = new Date(now).toISOString();
    await this.store.put(key, v);

    const session = resumed ? (b.session as string) : randomToken();
    const sessionExpires = now + v.policy.sessionMinutes * 60 * 1000;
    if (v.policy.sessionMinutes > 0) await this.store.put(`sess:${session}`, { vaultId: v.id, expires: sessionExpires });
    await this.log(v.id, { ev: resumed ? 'resume' : 'open', ...meta });
    let blob: { token: string; expiresAt: string } | undefined;
    if (v.cloud) {
      // A pass for reading this vault's parts from the cloud storage, only after a successful open.
      for (const [k, exp] of await this.store.list<number>({ prefix: `blobpass:${v.id}:` })) if (exp < now) await this.store.delete(k);
      const token = randomToken();
      await this.store.put(`blobpass:${v.id}:${token}`, now + BLOB_PASS_MS);
      blob = { token, expiresAt: new Date(now + BLOB_PASS_MS).toISOString() };
    }
    return json({
      ok: true,
      share: v.share,
      blob,
      session: v.policy.sessionMinutes > 0 ? session : null,
      // The address the server saw, so the viewer can put it in the watermark.
      client: { ip: ip ?? null, country: country ?? null },
      status: {
        opens: v.opens,
        maxOpens: v.policy.maxOpens,
        expiresAt: v.policy.expiresAt,
        serverTime: new Date(now).toISOString(),
      },
    });
  }

  private async log(vaultId: string, e: Omit<LogEntry, 't'>) {
    const t = new Date(this.now()).toISOString();
    const seq = ((await this.store.get<number>('logseq')) ?? 0) + 1;
    await this.store.put('logseq', seq);
    await this.store.put(`log:${vaultId}:${String(seq).padStart(12, '0')}`, { t, ...e });
    if (seq % 50 === 0) await this.pruneLogs();
  }

  /** Drops log entries older than LOG_RETENTION_DAYS; runs now and then, not on every write. */
  private async pruneLogs() {
    const keep = this.logRetentionMs;
    if (!keep) return;
    const cutoff = new Date(this.now() - keep).toISOString();
    for (const [k, l] of await this.store.list<LogEntry>({ prefix: 'log:' })) {
      if (l.t < cutoff) await this.store.delete(k);
    }
  }

  // ---------- admin ----------

  private async adminConfigured() {
    return !!(this.env.ADMIN_PASSWORD || (await this.store.get('admin:pw')));
  }

  private async setup(b: Record<string, unknown>) {
    if (await this.adminConfigured()) return fail(409, 'already_configured', '管理員密碼已經設定過了');
    if (!isStr(b.password, 200) || b.password.length < 8) throw new BadRequest('管理員密碼至少 8 個字元');
    await this.savePassword(b.password);
    return this.issueAdminToken();
  }

  private async savePassword(password: string) {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    await this.store.put('admin:pw', { salt: b64(salt), hash: b64(hash), iterations: PBKDF2_ITERATIONS });
  }

  private async verifyPassword(password: string): Promise<boolean> {
    const stored = await this.store.get<{ salt: string; hash: string; iterations: number }>('admin:pw');
    if (stored && sameBytes(await pbkdf2(password, unb64(stored.salt), stored.iterations), unb64(stored.hash))) return true;
    // The password set when deploying (a Worker secret) always keeps working, even after the password
    // was changed from the packer: it is the spare key if that new password is lost or misused.
    if (this.env.ADMIN_PASSWORD) return sameBytes(await sha256(password), await sha256(this.env.ADMIN_PASSWORD));
    return false;
  }

  private async login(b: Record<string, unknown>) {
    if (!isStr(b.password, 200)) throw new BadRequest('password');
    if (!(await this.adminConfigured())) return fail(409, 'not_configured', '伺服器還沒有設定管理員密碼');
    const now = this.now();
    const lock = (await this.store.get<{ failures: number; until: number }>('admin:lock')) ?? { failures: 0, until: 0 };
    if (lock.until > now) {
      return fail(429, 'admin_locked', `登入失敗太多次，請 ${Math.ceil((lock.until - now) / 60000)} 分鐘後再試`);
    }
    if (!(await this.verifyPassword(b.password))) {
      lock.failures += 1;
      if (lock.failures >= this.maxAdminFailures) {
        lock.failures = 0;
        lock.until = now + this.adminLockMs;
      }
      await this.store.put('admin:lock', lock);
      return fail(401, 'bad_password', '管理員密碼不正確');
    }
    await this.store.delete('admin:lock');
    return this.issueAdminToken();
  }

  private async issueAdminToken() {
    const token = randomToken();
    const expires = this.now() + this.sessionMs;
    await this.store.put(`admin:sess:${token}`, expires);
    return json({ ok: true, token, expiresAt: new Date(expires).toISOString() });
  }

  private async checkAdmin(token: string) {
    if (!token || token.length > 100) return false;
    const exp = await this.store.get<number>(`admin:sess:${token}`);
    if (!exp) return false;
    if (exp < this.now()) {
      await this.store.delete(`admin:sess:${token}`);
      return false;
    }
    return true;
  }

  private async changePassword(b: Record<string, unknown>) {
    if (!isStr(b.current, 200) || !isStr(b.next, 200)) throw new BadRequest('current/next');
    if (b.next.length < 8) throw new BadRequest('新密碼至少 8 個字元');
    if (!(await this.verifyPassword(b.current))) return fail(401, 'bad_password', '目前的管理員密碼不正確');
    await this.savePassword(b.next);
    for (const k of (await this.store.list({ prefix: 'admin:sess:' })).keys()) await this.store.delete(k);
    return this.issueAdminToken();
  }

  private async register(b: Record<string, unknown>) {
    if (!Array.isArray(b.vaults) || b.vaults.length === 0 || b.vaults.length > 500) throw new BadRequest('vaults');
    const now = new Date(this.now()).toISOString();
    const records: VaultRecord[] = [];
    const headers = new Map<string, unknown>();
    for (const raw of b.vaults as Record<string, unknown>[]) {
      if (!isStr(raw.id, 64) || !/^[a-z0-9]+$/.test(raw.id)) throw new BadRequest('id');
      if (!isStr(raw.authKey, 100) || unb64(raw.authKey).length !== 32) throw new BadRequest('authKey');
      if (!isStr(raw.share, 100) || unb64(raw.share).length !== 32) throw new BadRequest('share');
      if (await this.store.get(`vault:${raw.id}`)) return fail(409, 'exists', `封存檔 ${raw.id} 已經登記過了`);
      let cloud: CloudInfo | undefined;
      if (raw.cloud !== undefined) {
        // A cloud link vault: the server keeps its plaintext header and the parts go to the storage.
        const c = (raw.cloud ?? {}) as Record<string, unknown>;
        if (!isStr(c.storage, 40)) throw new BadRequest('cloud.storage');
        const profile = await this.clouds.get(c.storage);
        if (!profile || profile.status !== 'ready') return fail(409, 'no_storage', '找不到這個雲端空間，或它還沒有完成連結，請到「雲端空間」確認');
        const size = c.size;
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_CLOUD_BYTES) throw new BadRequest('cloud.size');
        const h = raw.header as Record<string, unknown> | undefined;
        if (!h || typeof h !== 'object' || h.id !== raw.id || h.blobSize !== size || h.mode !== 'online') throw new BadRequest('header');
        if (JSON.stringify(h).length > MAX_HEADER_CHARS) throw new BadRequest('檔案太多，檔案清單超過伺服器能保存的大小，請分成幾份封存');
        const parts = Math.ceil(size / this.partBytes);
        cloud = { storage: c.storage, size, partBytes: this.partBytes, parts, container: null, refs: new Array(parts).fill(null), complete: false };
        headers.set(raw.id, h);
      }
      records.push({
        id: raw.id,
        batchId: isStr(raw.batchId, 64) ? raw.batchId : raw.id,
        title: isStr(raw.title, 200) ? raw.title : '',
        recipient: isStr(raw.recipient, 200) ? raw.recipient : '',
        authKey: raw.authKey,
        share: raw.share,
        policy: cleanPolicy(raw.policy as Partial<VaultPolicy>),
        opens: 0,
        failures: 0,
        locked: false,
        revoked: false,
        createdAt: now,
        lastOpenAt: null,
        ...(cloud ? { cloud } : {}),
      });
    }
    for (const r of records) {
      if (headers.has(r.id)) await this.store.put(`vhead:${r.id}`, headers.get(r.id));
      await this.store.put(`vault:${r.id}`, r);
    }
    const cloud = Object.fromEntries(records.filter((r) => r.cloud).map((r) => [r.id, { partBytes: r.cloud!.partBytes, parts: r.cloud!.parts }]));
    return json({ ok: true, count: records.length, cloud });
  }

  private async listVaults() {
    const all = await this.store.list<VaultRecord>({ prefix: 'vault:' });
    const vaults = [...all.values()].map(publicVault).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ ok: true, vaults, serverTime: new Date(this.now()).toISOString() });
  }

  private async stats(q: URLSearchParams) {
    const num = (k: string, d: number) => (q.get(k) !== null && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
    const vaults = [...(await this.store.list<VaultRecord>({ prefix: 'vault:' })).values()] as StatVault[];
    const logs: StatLog[] = [];
    for (const [k, l] of await this.store.list<LogEntry>({ prefix: 'log:' })) {
      logs.push({ ...l, vaultId: k.split(':')[1] });
    }
    const stats = buildStats(vaults, logs, { days: num('days', 30), tzOffset: num('tzOffset', 0), now: this.now() });
    return json({ ok: true, stats, serverTime: new Date(this.now()).toISOString() });
  }

  private async logs(id: string) {
    const all = await this.store.list<LogEntry>({ prefix: `log:${id}:`, reverse: true, limit: 500 });
    return json({ ok: true, logs: [...all.values()] });
  }

  private async update(id: string, b: Record<string, unknown>) {
    const key = `vault:${id}`;
    const v = await this.store.get<VaultRecord>(key);
    if (!v) return fail(404, 'unknown', '找不到這份封存檔');
    if (typeof b.revoked === 'boolean') v.revoked = b.revoked;
    if (b.unlock === true) {
      v.locked = false;
      v.failures = 0;
    }
    if (b.resetOpens === true) v.opens = 0;
    if (b.policy && typeof b.policy === 'object') v.policy = cleanPolicy({ ...v.policy, ...(b.policy as object) });
    await this.store.put(key, v);
    if (v.revoked) {
      for (const [k, s] of await this.store.list<{ vaultId: string }>({ prefix: 'sess:' })) {
        if (s.vaultId === id) await this.store.delete(k);
      }
      // whoever is reading it right now cannot fetch any more of it
      for (const k of (await this.store.list({ prefix: `blobpass:${id}:` })).keys()) await this.store.delete(k);
    }
    return json({ ok: true, vault: publicVault(v) });
  }

  private async remove(id: string) {
    const key = `vault:${id}`;
    const v = await this.store.get<VaultRecord>(key);
    if (!v) return fail(404, 'unknown', '找不到這份封存檔');
    if (v.cloud) {
      // Delete the parts in the cloud first. Object storage deletes one file per request, so a big
      // vault may take a few calls: the record stays (revoked) until nothing is left.
      const p = await this.clouds.get(v.cloud.storage);
      const refs = v.cloud.refs.filter((r): r is string => !!r);
      const left = p && (v.cloud.container || refs.length) ? await this.clouds.adapter(p).remove(v.cloud.container, refs) : [];
      if (left.length) {
        v.revoked = true;
        v.cloud = { ...v.cloud, container: null, refs: left, complete: false };
        await this.store.put(key, v);
        for (const k of (await this.store.list({ prefix: `blobpass:${id}:` })).keys()) await this.store.delete(k);
        return json({ ok: true, pending: left.length });
      }
    }
    await this.store.delete(key);
    await this.store.delete(`vhead:${id}`);
    for (const prefix of [`log:${id}:`, `blobpass:${id}:`]) {
      for (const k of (await this.store.list({ prefix })).keys()) await this.store.delete(k);
    }
    return json({ ok: true });
  }

  // ---------- cloud link vaults ----------

  /** Number of vaults kept in each storage profile. */
  private async storageUsage(): Promise<Map<string, number>> {
    const usage = new Map<string, number>();
    for (const v of (await this.store.list<VaultRecord>({ prefix: 'vault:' })).values()) {
      if (v.cloud) usage.set(v.cloud.storage, (usage.get(v.cloud.storage) ?? 0) + 1);
    }
    return usage;
  }

  /** What the viewer needs before unlocking: the plaintext header (salt, KDF, encrypted file list). */
  private async cloudHeader(id: string) {
    const v = await this.store.get<VaultRecord>(`vault:${id}`);
    if (!v?.cloud) return fail(404, 'unknown', '找不到這份封存檔（連結可能有誤，或已被刪除）');
    if (!v.cloud.complete) return fail(409, 'uploading', '這份封存檔還沒有上傳完成，請稍後再試或聯絡發送者');
    const header = await this.store.get(`vhead:${id}`);
    return json({ ok: true, header, blob: { size: v.cloud.size, partBytes: v.cloud.partBytes, parts: v.cloud.parts } });
  }

  /** Hands out one part (or a byte range of it) to a viewer holding a pass from a successful open. */
  private async readPart(req: Request, id: string, part: number) {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const exp = isStr(token, 100) ? await this.store.get<number>(`blobpass:${id}:${token}`) : undefined;
    if (!exp || exp < this.now()) return fail(401, 'no_pass', '閱讀權限已過期或已被收回，請按「上鎖」後重新解鎖');
    const v = await this.store.get<VaultRecord>(`vault:${id}`);
    if (!v?.cloud?.complete) return fail(404, 'unknown', '找不到這份封存檔');
    if (v.revoked) return fail(403, 'revoked', '這份封存檔已被發送者收回');
    if (v.locked) return fail(423, 'locked', '這份封存檔已鎖定');
    const ref = v.cloud.refs[part];
    if (part >= v.cloud.parts || !ref) return fail(404, 'no_part', '找不到這段內容');
    const p = await this.clouds.get(v.cloud.storage);
    if (!p) return fail(502, 'storage', '存放這份封存檔的雲端空間已被移除');
    const range = req.headers.get('range');
    const res = await this.clouds.adapter(p).get(ref, range && /^bytes=\d{1,12}-\d{0,12}$/.test(range) ? range : null);
    if (res.status !== 200 && res.status !== 206) {
      const why = res.status === 404 ? '雲端上找不到這份封存檔的內容（可能被手動刪除了）' : `雲端空間回應錯誤（HTTP ${res.status}）`;
      return fail(502, 'storage', why);
    }
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store', ...CORS });
    for (const h of ['content-length', 'content-range']) {
      const val = res.headers.get(h);
      if (val) headers.set(h, val);
    }
    return new Response(res.body, { status: res.status, headers });
  }

  /** The vault's folder in the storage, made once (parts arriving together share the same one). */
  private async containerFor(id: string, storage: string): Promise<string> {
    const cur = await this.store.get<VaultRecord>(`vault:${id}`);
    if (cur?.cloud?.container) return cur.cloud.container;
    let pending = this.preparing.get(id);
    if (!pending) {
      const p = await this.clouds.get(storage);
      if (!p) throw new StorageError('存放這份封存檔的雲端空間已被移除');
      pending = this.clouds.withAdapter(p, (a) => a.prepare(id)).then(async (container) => {
        const v = await this.store.get<VaultRecord>(`vault:${id}`);
        if (v?.cloud && !v.cloud.container) {
          v.cloud.container = container;
          await this.store.put(`vault:${id}`, v);
        }
        return container;
      });
      pending.catch(() => this.preparing.delete(id));
      this.preparing.set(id, pending);
    }
    return pending;
  }

  private async uploadPart(req: Request, id: string, part: number) {
    const key = `vault:${id}`;
    const v = await this.store.get<VaultRecord>(key);
    if (!v?.cloud) return fail(404, 'unknown', '找不到這份雲端封存檔');
    if (v.cloud.complete) return fail(409, 'complete', '這份封存檔已經上傳完成');
    const { parts, partBytes, size } = v.cloud;
    if (part >= parts) throw new BadRequest('part');
    const expected = part === parts - 1 ? size - partBytes * (parts - 1) : partBytes;
    const data = await req.arrayBuffer();
    if (data.byteLength !== expected) throw new BadRequest(`第 ${part + 1} 段的大小不對（${data.byteLength}，應為 ${expected}）`);
    const p = await this.clouds.get(v.cloud.storage);
    if (!p) throw new StorageError('存放這份封存檔的雲端空間已被移除');
    const container = await this.containerFor(id, v.cloud.storage);
    const ref = await this.clouds.withAdapter(p, (a) => a.put(container, id, part, data));
    const cur = await this.store.get<VaultRecord>(key); // re-read: other parts may have been saved meanwhile
    if (!cur?.cloud) return fail(404, 'unknown', '這份封存檔在上傳時被刪除了');
    cur.cloud.refs[part] = ref;
    cur.cloud.container ??= container;
    await this.store.put(key, cur);
    return json({ ok: true, part, uploaded: cur.cloud.refs.filter(Boolean).length, parts });
  }

  private async completeUpload(id: string) {
    const key = `vault:${id}`;
    const v = await this.store.get<VaultRecord>(key);
    if (!v?.cloud) return fail(404, 'unknown', '找不到這份雲端封存檔');
    const missing = v.cloud.refs.filter((r) => !r).length;
    if (missing) return fail(409, 'incomplete', `還有 ${missing} 段沒有上傳`);
    v.cloud.complete = true;
    await this.store.put(key, v);
    return json({ ok: true });
  }
}


/** In-memory Store for tests and quick local runs. */
export class MemoryStore implements Store {
  private m = new Map<string, unknown>();
  async get<T>(key: string) {
    const v = this.m.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T) {
    this.m.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.m.delete(key);
  }
  async list<T>(o: { prefix: string; limit?: number; reverse?: boolean }) {
    let keys = [...this.m.keys()].filter((k) => k.startsWith(o.prefix)).sort();
    if (o.reverse) keys.reverse();
    if (o.limit) keys = keys.slice(0, o.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.m.get(k)) as T]));
  }
}
