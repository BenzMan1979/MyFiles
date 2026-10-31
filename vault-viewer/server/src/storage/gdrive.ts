// Google Drive, through the admin's own Google Cloud OAuth client (each deployment has its own, so
// there is no shared app to trust or get verified).
//   config.clientId / config.clientSecret   the OAuth client ("Web application")
//   config.refreshToken                     from the one-time sign-in (see googleAuthUrl / googleExchange)
//   config.folderId                         the "隨身密閱" folder this app created
//   config.folderName
// Scope is drive.file: the server can only see files it created itself, nothing else in the Drive.
// Layout: <folder>/<vaultId>/<00000.bin, …>; the container is the vault folder's id, refs are file ids.

import { partName, StorageError, type Adapter, type AdapterDeps, type StorageProfile } from './types';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

const REAUTH =
  'Google 授權已失效，請到「雲端空間」按「重新連結」。如果 Google Cloud 的 OAuth 同意畫面還在「測試」狀態，授權每 7 天就會失效，請改成「正式版（In production）」。';

export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always hand out a refresh token, also when connecting again
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(d: AdapterDeps, form: Record<string, string>) {
  let res: Response;
  try {
    res = await d.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  } catch (e) {
    throw new StorageError(`連不到 Google（${(e as Error).message}）`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, string | number>;
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new StorageError(REAUTH, 'reauth');
    if (data.error === 'invalid_client') throw new StorageError('Google 不認得這組 Client ID／Client Secret，請確認有完整貼上', 'bad_config', 400);
    if (data.error === 'redirect_uri_mismatch') throw new StorageError('重新導向 URI 和 Google Cloud 裡設定的不一樣', 'bad_config', 400);
    throw new StorageError(`Google 授權失敗：${data.error_description ?? data.error ?? `HTTP ${res.status}`}`);
  }
  return data;
}

/**
 * Turns an error from the Drive API into what to do about it. Google says why in the body
 * (error.errors[].reason / error.details[].reason), e.g. the API is not enabled in the project.
 */
export async function googleError(what: string, res: Response): Promise<StorageError> {
  let message = '';
  const reasons: string[] = [];
  try {
    const e = ((await res.json()) as { error?: { message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[]; status?: string } }).error;
    message = e?.message ?? '';
    for (const x of [...(e?.errors ?? []), ...(e?.details ?? [])]) if (x.reason) reasons.push(x.reason);
    if (e?.status) reasons.push(e.status);
  } catch {
    /* not JSON */
  }
  const has = (...r: string[]) => r.some((x) => reasons.includes(x));
  const head = `${what}失敗（HTTP ${res.status}）：`;
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
    return new StorageError(`${head}這個 Google Cloud 專案還沒有啟用「Google Drive API」。請到 Google Cloud 的「API 和服務 → 程式庫」搜尋 Google Drive API 按「啟用」，等 1～2 分鐘後，回到打包器的「雲端空間」按「繼續連結」。`, 'drive_api_disabled');
  }
  if (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientScopes')) {
    return new StorageError(`${head}授權時沒有給「Google 雲端硬碟」的權限。請回到打包器的「雲端空間」按「繼續連結」，在 Google 的授權畫面勾選雲端硬碟那一項再按「繼續」。`, 'reauth');
  }
  if (has('storageQuotaExceeded')) return new StorageError(`${head}Google 雲端硬碟的空間已滿`);
  if (has('rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED')) return new StorageError(`${head}對 Google 的請求太頻繁，請稍後再試`);
  if (has('downloadQuotaExceeded')) return new StorageError(`${head}這個檔案今天的下載次數已超過 Google 的上限，請明天再試`);
  if (res.status === 404) return new StorageError(`${head}找不到檔案或資料夾（可能被手動刪除了）`);
  return new StorageError(`${head}${message || 'Google 拒絕這個請求'}`);
}

/** Trades the code from Google's sign-in page for a refresh token. */
export async function googleExchange(d: AdapterDeps, o: { clientId: string; clientSecret: string; code: string; redirectUri: string }) {
  const data = await tokenRequest(d, { client_id: o.clientId, client_secret: o.clientSecret, code: o.code, redirect_uri: o.redirectUri, grant_type: 'authorization_code' });
  if (typeof data.refresh_token !== 'string') throw new StorageError('Google 沒有給長期授權，請再試一次「連結 Google Drive」');
  // Google lets the user untick permissions on the consent screen; without Drive there is nothing to do.
  if (typeof data.scope === 'string' && !data.scope.split(' ').includes(GOOGLE_SCOPE)) {
    throw new StorageError('授權時沒有勾選「Google 雲端硬碟」的權限。請回到打包器的「雲端空間」按「繼續連結」，在 Google 的授權畫面勾選雲端硬碟那一項再按「繼續」。', 'reauth');
  }
  return { refreshToken: data.refresh_token, accessToken: String(data.access_token), accessExpires: d.now() + Number(data.expires_in ?? 3600) * 1000 };
}

export function gdriveAdapter(p: StorageProfile, d: AdapterDeps): Adapter & { ensureFolder(): Promise<string>; describe(): Promise<string> } {
  const c = p.config;

  const token = async (force = false): Promise<string> => {
    if (!c.refreshToken) throw new StorageError('還沒有完成 Google 授權，請到「雲端空間」按「連結 Google Drive」', 'reauth');
    const s = p.state;
    if (!force && s.accessToken && (s.accessExpires ?? 0) > d.now() + 60_000) return s.accessToken;
    const data = await tokenRequest(d, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' });
    s.accessToken = String(data.access_token);
    s.accessExpires = d.now() + Number(data.expires_in ?? 3600) * 1000;
    await d.saveState({ accessToken: s.accessToken, accessExpires: s.accessExpires });
    return s.accessToken;
  };

  /** Calls Google with the access token; refreshes it once if Google says it expired. */
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${await token(attempt > 0)}`);
      let res: Response;
      try {
        res = await d.fetch(url, { ...init, headers });
      } catch (e) {
        throw new StorageError(`連不到 Google Drive（${(e as Error).message}）`);
      }
      if (res.status !== 401 || attempt > 0) return res;
    }
  };

  const json = async <T>(what: string, res: Response): Promise<T> => {
    if (!res.ok) throw await googleError(what, res);
    return (await res.json()) as T;
  };

  const createFolder = async (name: string, parent?: string) => {
    const res = await call(`${API}/files?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
    });
    return (await json<{ id: string }>('在 Google Drive 建立資料夾', res)).id;
  };

  const self = {
    /** Makes sure the app's root folder exists (re-creating it if it was deleted); returns its id. */
    async ensureFolder(): Promise<string> {
      if (c.folderId) {
        const res = await call(`${API}/files/${encodeURIComponent(c.folderId)}?fields=id,trashed`);
        if (res.ok && !((await res.json()) as { trashed?: boolean }).trashed) return c.folderId;
      }
      c.folderId = await createFolder(c.folderName || '隨身密閱');
      return c.folderId;
    },

    /** "who@gmail.com · 已用 1.2 GB / 5 TB" */
    async describe(): Promise<string> {
      const res = await call(`${API}/about?fields=user(emailAddress),storageQuota(limit,usage)`);
      const a = await json<{ user?: { emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }>('讀取 Google 帳號資訊', res);
      const gb = (v?: string) => (v ? `${(Number(v) / 1024 ** 3).toFixed(Number(v) >= 100 * 1024 ** 3 ? 0 : 1)} GB` : '不限');
      p.state.account = a.user?.emailAddress ?? '';
      return `${a.user?.emailAddress ?? 'Google 帳號'} · 已用 ${gb(a.storageQuota?.usage)} / ${gb(a.storageQuota?.limit)}`;
    },

    async test() {
      const text = await self.describe();
      await self.ensureFolder();
      return text;
    },

    async prepare(vaultId: string) {
      return createFolder(vaultId, await self.ensureFolder());
    },

    async put(container: string, _vaultId: string, part: number, data: ArrayBuffer) {
      // Resumable upload in one go: works for any size (the simple multipart upload is meant for ≤ 5 MB).
      const start = await call(`${UPLOAD}/files?uploadType=resumable&fields=id&supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(data.byteLength) },
        body: JSON.stringify({ name: partName(part), parents: [container], mimeType: 'application/octet-stream' }),
      });
      if (!start.ok) throw await googleError('開始上傳到 Google Drive', start);
      const session = start.headers.get('location');
      if (!session) throw new StorageError('Google Drive 沒有回傳上傳位址');
      let res: Response;
      try {
        res = await d.fetch(session, { method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } });
      } catch (e) {
        throw new StorageError(`上傳到 Google Drive 時斷線（${(e as Error).message}）`);
      }
      return (await json<{ id: string }>('上傳到 Google Drive', res)).id;
    },

    async get(ref: string, range: string | null) {
      return call(`${API}/files/${encodeURIComponent(ref)}?alt=media&supportsAllDrives=true`, range ? { headers: { range } } : {});
    },

    async remove(container: string | null, refs: string[]) {
      // Deleting the vault's folder deletes every part in it, in one request.
      const ids = container ? [container] : refs.slice(0, 30);
      for (const id of ids) {
        const res = await call(`${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw await googleError('刪除 Google Drive 上的檔案', res);
      }
      return container ? [] : refs.slice(ids.length);
    },
  };
  return self;
}
