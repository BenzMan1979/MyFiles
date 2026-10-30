import { openPageOf } from '../shared/config';

// Server profiles (stored in this browser) and a small client for the vault server API.

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

const LS_SERVERS = 'vault-packer:servers';
const LS_DEFAULT = 'vault-packer:default-server';
const SS_TOKEN = 'vault-packer:token:';

function lsGet<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function lsSet(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export const servers = {
  list: (): ServerProfile[] => lsGet<ServerProfile[]>(LS_SERVERS, []),
  save(list: ServerProfile[]) {
    lsSet(LS_SERVERS, list);
  },
  upsert(p: ServerProfile) {
    const list = servers.list().filter((s) => s.id !== p.id);
    list.push(p);
    servers.save(list);
    if (!servers.defaultId()) servers.setDefault(p.id);
  },
  remove(id: string) {
    servers.save(servers.list().filter((s) => s.id !== id));
    tokens.clear(id);
    if (servers.defaultId() === id) servers.setDefault(servers.list()[0]?.id ?? '');
  },
  defaultId: (): string => lsGet<string>(LS_DEFAULT, ''),
  setDefault(id: string) {
    lsSet(LS_DEFAULT, id);
  },
  get: (id: string) => servers.list().find((s) => s.id === id),
  default: () => servers.get(servers.defaultId()) ?? servers.list()[0],
};

export const tokens = {
  get(id: string): string | null {
    try {
      const raw = sessionStorage.getItem(SS_TOKEN + id);
      if (!raw) return null;
      const t = JSON.parse(raw) as { token: string; expiresAt: string };
      return Date.parse(t.expiresAt) > Date.now() ? t.token : null;
    } catch {
      return null;
    }
  },
  set(id: string, token: string, expiresAt: string) {
    try {
      sessionStorage.setItem(SS_TOKEN + id, JSON.stringify({ token, expiresAt }));
    } catch {
      /* storage unavailable */
    }
  },
  clear(id: string) {
    try {
      sessionStorage.removeItem(SS_TOKEN + id);
    } catch {
      /* storage unavailable */
    }
  },
};

/** Where to send a recipient whose device cannot open the HTML file: this site, else the default server. */
export function phoneViewerUrl(serverUrl?: string | null): string | null {
  if (serverUrl) return openPageOf(serverUrl);
  if (location.protocol.startsWith('http')) return new URL('open.html', location.href).toString();
  const d = servers.default();
  return d ? openPageOf(d.url) : null;
}

/** Normalises what people paste: adds https://, strips paths and trailing slashes. */
export function normaliseUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export async function api<T = Record<string, unknown>>(
  server: ServerProfile | string,
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const base = typeof server === 'string' ? server : server.url;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth && typeof server !== 'string') {
    const t = tokens.get(server.id);
    if (!t) throw new ApiError('需要先登入這台伺服器的管理員', 'unauthorized', 401);
    headers.authorization = `Bearer ${t}`;
  }
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError('無法連線到伺服器。請確認網址正確、網路正常，以及伺服器已部署完成。', 'network', 0);
  }
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`這個網址不是隨身密閱伺服器（HTTP ${res.status}）`, 'not_server', res.status);
  }
  if (!res.ok || data.ok === false) {
    if (res.status === 401 && typeof server !== 'string' && data.code === 'unauthorized') tokens.clear(server.id);
    throw new ApiError(String(data.message ?? `伺服器錯誤（HTTP ${res.status}）`), String(data.code ?? 'error'), res.status);
  }
  return data as T;
}

export interface ServerInfo {
  app: string;
  version: number;
  adminConfigured: boolean;
  serverTime: string;
}

export async function serverInfo(url: string): Promise<ServerInfo> {
  const info = await api<ServerInfo>(url, '/api/info');
  if (info.app !== 'vault-viewer-server') throw new ApiError('這個網址不是隨身密閱伺服器', 'not_server', 200);
  return info;
}

export async function login(p: ServerProfile, password: string, setup = false) {
  const r = await api<{ token: string; expiresAt: string }>(p.url, setup ? '/api/admin/setup' : '/api/admin/login', { body: { password } });
  tokens.set(p.id, r.token, r.expiresAt);
}

export interface RemoteVault {
  id: string;
  batchId: string;
  title: string;
  recipient: string;
  policy: { notBefore: string | null; expiresAt: string | null; maxOpens: number | null; maxFailures: number; sessionMinutes: number };
  opens: number;
  failures: number;
  locked: boolean;
  revoked: boolean;
  createdAt: string;
  lastOpenAt: string | null;
}

export interface RemoteLog {
  t: string;
  ev: string;
  detail?: string;
  tag?: string;
  ip?: string;
  country?: string;
  ua?: string;
}
