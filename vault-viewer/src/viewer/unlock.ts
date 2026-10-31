// Turns password + key into an opened vault, enforcing the policy either through the server
// (online) or with local bookkeeping (offline, best effort).

import { fromB64, toB64 } from '../core/bytes';
import { hmac, openProofMessage } from '../core/crypto';
import { deriveContentKey, openManifest, prepareUnlock, type Manifest, type VaultHeader } from '../core/format';

export interface OpenedVault {
  manifest: Manifest;
  contentKey: CryptoKey;
  status: { opens: number; maxOpens: number | null; expiresAt: string | null };
  /** Short code for the watermark; online vaults log it so a screenshot can be traced. */
  tag: string;
  /** The address the server saw (online vaults only). */
  client: { ip: string | null; country: string | null } | null;
  /** cloud link vaults: the pass for reading the encrypted parts from the server */
  blobPass: string | null;
}

const TAG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newTag(): string {
  const r = new Uint8Array(6);
  crypto.getRandomValues(r);
  return Array.from(r, (n) => TAG_ALPHABET[n % TAG_ALPHABET.length]).join('');
}

export class UnlockError extends Error {
  constructor(message: string, readonly code = 'error', readonly final = false) {
    super(message);
  }
}

// ---------- offline bookkeeping (localStorage; easy to reset, so only deters casual users) ----------

interface LocalState {
  opens: number;
  failures: number;
  lastSeen: number;
}

const stateKey = (id: string) => `vault-viewer:${id}`;

function loadState(id: string): LocalState {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(id)) ?? 'null');
    if (s && typeof s.opens === 'number') return s;
  } catch {
    /* storage unavailable */
  }
  return { opens: 0, failures: 0, lastSeen: 0 };
}

function saveState(id: string, s: LocalState) {
  try {
    localStorage.setItem(stateKey(id), JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Opens counted in this page so re-unlocking after an idle lock does not use another one. */
const countedThisPage = new Set<string>();
let onlineSession: { vaultId: string; token: string } | null = null;

const CLOCK_TOLERANCE_MS = 10 * 60 * 1000;

export function offlineLockedOut(header: VaultHeader): boolean {
  if (header.mode !== 'offline' || header.maxFailures <= 0) return false;
  return loadState(header.id).failures >= header.maxFailures;
}

async function unlockOffline(header: VaultHeader, password: string, keyfile: Uint8Array): Promise<OpenedVault> {
  const st = loadState(header.id);
  const now = Date.now();
  if (header.maxFailures > 0 && st.failures >= header.maxFailures) {
    throw new UnlockError('密碼錯誤次數過多，這份封存檔在此裝置上已鎖定', 'locked', true);
  }
  if (st.lastSeen && now < st.lastSeen - CLOCK_TOLERANCE_MS) {
    throw new UnlockError('偵測到系統時間被調回過去，請將電腦時間調整正確後再試', 'clock', true);
  }
  const { pwKey, salt } = await prepareUnlock(header, password, keyfile);
  const contentKey = await deriveContentKey(pwKey, keyfile, null, salt);
  let manifest: Manifest;
  try {
    manifest = await openManifest(header, contentKey);
  } catch {
    st.failures += 1;
    saveState(header.id, st);
    const left = header.maxFailures > 0 ? header.maxFailures - st.failures : null;
    if (left !== null && left <= 0) throw new UnlockError('密碼錯誤次數過多，這份封存檔在此裝置上已鎖定', 'locked', true);
    throw new UnlockError(left !== null ? `密碼或金鑰不正確（還可以再試 ${left} 次）` : '密碼或金鑰不正確', 'bad_proof');
  }
  st.failures = 0;
  st.lastSeen = Math.max(st.lastSeen, now);
  const p = manifest.policy;
  if (p.notBefore && now < Date.parse(p.notBefore)) {
    saveState(header.id, st);
    throw new UnlockError(`這份封存檔要到 ${new Date(p.notBefore).toLocaleString()} 之後才能開啟`, 'not_yet', true);
  }
  if (p.expiresAt && now >= Date.parse(p.expiresAt)) {
    saveState(header.id, st);
    throw new UnlockError('這份封存檔已過期', 'expired', true);
  }
  if (!countedThisPage.has(header.id)) {
    if (p.maxOpens != null && st.opens >= p.maxOpens) {
      saveState(header.id, st);
      throw new UnlockError('可開啟次數已用完', 'exhausted', true);
    }
    st.opens += 1;
    countedThisPage.add(header.id);
  }
  saveState(header.id, st);
  return { manifest, contentKey, status: { opens: st.opens, maxOpens: p.maxOpens, expiresAt: p.expiresAt }, tag: newTag(), client: null, blobPass: null };
}

// ---------- online ----------

async function post(server: string, path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(new URL(path, server).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new UnlockError('無法連線到驗證伺服器，請確認網路連線後再試', 'network');
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    throw new UnlockError(`驗證伺服器回應異常（HTTP ${res.status}）`, 'server');
  }
  return { ok: res.ok, data };
}

const FINAL_CODES = new Set(['revoked', 'locked', 'expired', 'exhausted', 'unknown', 'not_yet', 'uploading']);

async function unlockOnline(header: VaultHeader, password: string, keyfile: Uint8Array): Promise<OpenedVault> {
  const server = header.server!;
  const { pwKey, authKey, salt } = await prepareUnlock(header, password, keyfile);
  const ch = await post(server, '/api/open/challenge', { vaultId: header.id });
  if (!ch.ok) throw new UnlockError(String(ch.data.message ?? '無法開始驗證'), String(ch.data.code), FINAL_CODES.has(String(ch.data.code)));
  const nonce = String(ch.data.nonce);
  const proof = toB64(await hmac(authKey, openProofMessage(header.id, nonce)));
  const session = onlineSession?.vaultId === header.id ? onlineSession.token : undefined;
  const tag = newTag();
  const r = await post(server, '/api/open', { vaultId: header.id, nonce, proof, session, tag });
  if (!r.ok) {
    const code = String(r.data.code);
    let msg = String(r.data.message ?? '無法開啟');
    if (code === 'bad_proof' && typeof r.data.remainingAttempts === 'number') msg += `（還可以再試 ${r.data.remainingAttempts} 次）`;
    throw new UnlockError(msg, code, FINAL_CODES.has(code));
  }
  if (typeof r.data.session === 'string') onlineSession = { vaultId: header.id, token: r.data.session };
  const contentKey = await deriveContentKey(pwKey, keyfile, fromB64(String(r.data.share)), salt);
  let manifest: Manifest;
  try {
    manifest = await openManifest(header, contentKey);
  } catch {
    throw new UnlockError('伺服器驗證通過，但無法解開內容（封存檔可能損毀）', 'corrupt', true);
  }
  const s = r.data.status as { opens: number; maxOpens: number | null; expiresAt: string | null };
  const client = r.data.client as { ip: string | null; country: string | null } | undefined;
  const blob = r.data.blob as { token?: string } | undefined;
  return { manifest, contentKey, status: { opens: s.opens, maxOpens: s.maxOpens, expiresAt: s.expiresAt }, tag, client: client ?? null, blobPass: blob?.token ?? null };
}

export function unlockVault(header: VaultHeader, password: string, keyfile: Uint8Array): Promise<OpenedVault> {
  return header.mode === 'online' ? unlockOnline(header, password, keyfile) : unlockOffline(header, password, keyfile);
}
