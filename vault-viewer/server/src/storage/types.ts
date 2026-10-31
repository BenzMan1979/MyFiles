// Cloud storage for "cloud link" vaults: the encrypted blob is kept in the admin's own cloud space
// and the server hands it out, part by part, only to someone who passed the open check. The cloud
// only ever sees ciphertext, and recipients never need an account there.
//
// Every kind of storage implements the same small Adapter, so adding another one later (OneDrive,
// Dropbox, …) means writing one more file and registering it in index.ts.

export type StorageType = 'webdav' | 's3' | 'gdrive';

export interface StorageProfile {
  id: string;
  type: StorageType;
  name: string;
  createdAt: string;
  /** settings, secrets included (never sent back to a browser; see publicProfile) */
  config: Record<string, string>;
  /** things the adapter learns and keeps: access tokens, the account it is connected to */
  state: { accessToken?: string; accessExpires?: number; account?: string; connectedAt?: string };
  /** pending = waiting for the Google sign-in to finish */
  status: 'ready' | 'pending';
}

export interface AdapterDeps {
  fetch: typeof fetch;
  now: () => number;
  /** persists changes to profile.state (e.g. a refreshed access token) */
  saveState: (state: StorageProfile['state']) => Promise<void>;
}

export interface Adapter {
  /** Checks that the settings work and the storage can be written. Returns a short description (account, quota…). */
  test(): Promise<string>;
  /** Makes room for one vault; returns a reference to it (a folder id or path), stored with the vault. */
  prepare(vaultId: string): Promise<string>;
  /** Stores one part; returns the reference used to read it back. */
  put(container: string, vaultId: string, part: number, data: ArrayBuffer): Promise<string>;
  /** Reads one part (or a byte range of it). Returns the storage's own response (200 or 206). */
  get(ref: string, range: string | null): Promise<Response>;
  /**
   * Deletes a vault's parts. Returns the refs that are still left: a call may stop early to stay within
   * the platform's per-request limit on outgoing requests, and is then simply called again.
   */
  remove(container: string | null, refs: string[]): Promise<string[]>;
}

/** A problem with the cloud storage, worded for the person using the packer. */
export class StorageError extends Error {
  constructor(message: string, readonly code = 'storage', readonly status = 502) {
    super(message);
  }
}

/** Outgoing requests one call may make (Cloudflare's free plan allows 50 per request; keep some spare). */
export const SUBREQUEST_BUDGET = 40;

/** Turns an HTTP error from a storage service into a readable message. */
export async function httpError(what: string, res: Response, hints: Record<number, string> = {}): Promise<StorageError> {
  let detail = '';
  try {
    const t = (await res.text()).slice(0, 2000);
    detail =
      t.match(/<(?:s:)?message>([^<]{1,300})<\/(?:s:)?message>/i)?.[1] ??
      t.match(/"message"\s*:\s*"([^"]{1,300})"/)?.[1] ??
      t.match(/"error_description"\s*:\s*"([^"]{1,300})"/)?.[1] ??
      '';
  } catch {
    /* no body */
  }
  const hint = hints[res.status];
  return new StorageError(`${what}失敗（HTTP ${res.status}）${hint ? `：${hint}` : ''}${detail && !hint ? `：${detail}` : ''}`);
}

export const partName = (part: number) => `${String(part).padStart(5, '0')}.bin`;

/** "a/b c" -> "a/b%20c": each path segment encoded, slashes kept. */
export const encodePath = (p: string) =>
  p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
