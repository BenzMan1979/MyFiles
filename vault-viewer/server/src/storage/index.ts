// The storage kinds the server knows, and how their settings are checked and shown.
// To add a kind: write an adapter (see types.ts), then add it to KINDS below.

import { gdriveAdapter } from './gdrive';
import { s3Adapter } from './s3';
import { StorageError, type Adapter, type AdapterDeps, type StorageProfile, type StorageType } from './types';
import { webdavAdapter } from './webdav';

export * from './types';
export { googleAuthUrl, googleExchange, gdriveAdapter } from './gdrive';
export { signV4 } from './s3';

interface Kind {
  label: string;
  /** fields that may be set from the packer (anything else is ignored) */
  fields: string[];
  required: string[];
  /** never sent back to the browser; left empty when editing = keep the old value */
  secrets: string[];
  make: (p: StorageProfile, d: AdapterDeps) => Adapter;
}

const KINDS: Record<StorageType, Kind> = {
  webdav: {
    label: 'WebDAV',
    fields: ['url', 'username', 'password', 'folder'],
    required: ['url', 'username', 'password'],
    secrets: ['password'],
    make: webdavAdapter,
  },
  s3: {
    label: 'S3 相容',
    fields: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'prefix'],
    required: ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'],
    secrets: ['secretAccessKey'],
    make: s3Adapter,
  },
  gdrive: {
    label: 'Google Drive',
    fields: ['clientId', 'clientSecret', 'folderName'],
    required: ['clientId', 'clientSecret'],
    secrets: ['clientSecret', 'refreshToken'],
    make: gdriveAdapter,
  },
};

export const isStorageType = (t: unknown): t is StorageType => typeof t === 'string' && t in KINDS;

export function makeAdapter(p: StorageProfile, d: AdapterDeps): Adapter {
  return KINDS[p.type].make(p, d);
}

/**
 * Merges what the packer sent with the stored settings: unknown fields are dropped, secrets left
 * empty keep their old value. Throws a StorageError (400) when something required is missing.
 */
export function mergeConfig(type: StorageType, incoming: unknown, old: Record<string, string> = {}): Record<string, string> {
  const k = KINDS[type];
  const src = incoming && typeof incoming === 'object' ? (incoming as Record<string, unknown>) : {};
  const out: Record<string, string> = { ...old };
  for (const f of k.fields) {
    const v = src[f];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length > 2000) throw new StorageError(`「${f}」太長了`, 'bad_config', 400);
    if (k.secrets.includes(f) && !t) continue;
    out[f] = t;
  }
  for (const f of k.required) if (!out[f]) throw new StorageError(`請填寫「${f}」`, 'bad_config', 400);
  for (const f of ['url', 'endpoint']) {
    if (out[f] && !/^https?:\/\/[^\s/]+/i.test(out[f])) throw new StorageError('網址格式不正確（要以 https:// 開頭）', 'bad_config', 400);
  }
  return out;
}

/** What the packer may see: no secrets, just whether they are set. */
export function publicProfile(p: StorageProfile, isDefault: boolean, vaults: number) {
  const k = KINDS[p.type];
  const config: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [f, v] of Object.entries(p.config)) {
    if (k.secrets.includes(f)) secretsSet[f] = !!v;
    else if (k.fields.includes(f)) config[f] = v;
  }
  return { id: p.id, type: p.type, typeLabel: k.label, name: p.name, createdAt: p.createdAt, status: p.status, account: p.state.account ?? '', connectedAt: p.state.connectedAt ?? '', config, secretsSet, isDefault, vaults };
}
