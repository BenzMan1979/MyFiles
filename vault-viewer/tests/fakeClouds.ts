// In-memory stand-ins for the cloud services, plugged into the Hub as its `fetch`. They implement
// just enough of WebDAV, S3 and the Google Drive API (with their error behaviour) to run the real
// adapters end to end.

type Init = RequestInit | undefined;

const urlOf = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input);

async function bytesOf(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Answers a GET, honouring a "bytes=a-b" Range like real storage services. */
function serve(data: Uint8Array, range: string | null): Response {
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return new Response(data as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'content-length': String(data.length) } });
  const from = Number(m[1]);
  const to = Math.min(data.length - 1, m[2] ? Number(m[2]) : data.length - 1);
  if (from > to) return new Response(null, { status: 416 });
  const part = data.slice(from, to + 1);
  return new Response(part, { status: 206, headers: { 'content-length': String(part.length), 'content-range': `bytes ${from}-${to}/${data.length}` } });
}

const status = (s: number, body = '') => new Response(body || null, { status: s });

export function fakeWebdav(o: { base?: string; user?: string; pass?: string } = {}) {
  const base = (o.base ?? 'https://dav.test/remote.php/dav/files/ben').replace(/\/+$/, '');
  const auth = `Basic ${btoa(`${o.user ?? 'ben'}:${o.pass ?? 'app-pass'}`)}`;
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>([base]);
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: Init): Promise<Response> => {
    const url = urlOf(input).replace(/\/+$/, '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url}`);
    if (!url.startsWith(base)) throw new TypeError('fetch failed');
    if (headers.get('authorization') !== auth) return status(401);
    const parent = url.slice(0, url.lastIndexOf('/'));
    switch (method) {
      case 'MKCOL':
        if (dirs.has(url)) return status(405);
        if (!dirs.has(parent)) return status(409);
        dirs.add(url);
        return status(201);
      case 'PUT':
        if (!dirs.has(parent)) return status(409);
        files.set(url, await bytesOf(init?.body));
        return status(201);
      case 'GET': {
        const f = files.get(url);
        return f ? serve(f, headers.get('range')) : status(404);
      }
      case 'DELETE': {
        let found = files.delete(url) || dirs.delete(url);
        for (const k of [...files.keys()]) if (k.startsWith(`${url}/`)) found = files.delete(k);
        for (const k of [...dirs]) if (k.startsWith(`${url}/`)) found = dirs.delete(k);
        return status(found ? 204 : 404);
      }
    }
    return status(405);
  };
  return { fetch, files, dirs, calls, base };
}

export function fakeS3(o: { endpoint?: string; bucket?: string; keyId?: string } = {}) {
  const endpoint = o.endpoint ?? 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
  const bucket = o.bucket ?? 'vault-files';
  const keyId = o.keyId ?? 'KEYID';
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: Init): Promise<Response> => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url.pathname}`);
    if (`${url.protocol}//${url.host}` !== endpoint) throw new TypeError('fetch failed');
    const authz = headers.get('authorization') ?? '';
    if (!authz.startsWith(`AWS4-HMAC-SHA256 Credential=${keyId}/`) || !headers.get('x-amz-date')) {
      return status(403, '<Error><Code>InvalidAccessKeyId</Code><Message>bad key</Message></Error>');
    }
    const [, b, ...rest] = url.pathname.split('/');
    if (b !== bucket) return status(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const key = rest.map(decodeURIComponent).join('/');
    if (method === 'PUT') {
      objects.set(key, await bytesOf(init?.body));
      return status(200);
    }
    if (method === 'GET') {
      const f = objects.get(key);
      return f ? serve(f, headers.get('range')) : status(404);
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return status(204);
    }
    return status(405);
  };
  return { fetch, objects, calls, endpoint, bucket };
}

export function fakeGoogle() {
  const files = new Map<string, { name: string; parents: string[]; folder: boolean; data?: Uint8Array; trashed?: boolean }>();
  const uploads = new Map<string, { name: string; parents: string[] }>();
  let seq = 0;
  let accessToken = '';
  const g = {
    refreshToken: 'refresh-1',
    /** set to make Google refuse the refresh token, like after 7 days in "testing" mode */
    revoked: false,
    /** the Drive API is not enabled in the Cloud project */
    apiDisabled: false,
    /** scopes handed out with tokens (the user may untick Drive on the consent screen) */
    grantedScope: 'https://www.googleapis.com/auth/drive.file',
    tokenCalls: 0,
    files,
    expireAccessToken: () => (accessToken = 'expired'),
  };
  const json = (data: unknown, s = 200) => new Response(JSON.stringify(data), { status: s, headers: { 'content-type': 'application/json' } });
  const fetch = async (input: RequestInfo | URL, init?: Init): Promise<Response> => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      g.tokenCalls++;
      const f = new URLSearchParams(String(init?.body));
      if (f.get('client_id') !== 'cid.apps.googleusercontent.com' || f.get('client_secret') !== 'secret') return json({ error: 'invalid_client' }, 401);
      accessToken = `access-${++seq}`;
      if (f.get('grant_type') === 'authorization_code') {
        if (f.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: accessToken, refresh_token: g.refreshToken, expires_in: 3600, scope: g.grantedScope });
      }
      if (g.revoked || f.get('refresh_token') !== g.refreshToken) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      return json({ access_token: accessToken, expires_in: 3600 });
    }
    if (url.host !== 'www.googleapis.com') throw new TypeError('fetch failed');
    if (url.pathname.startsWith('/upload/drive/v3/files') && method === 'PUT') {
      const up = uploads.get(url.searchParams.get('upload_id') ?? '');
      if (!up) return status(404);
      const id = `f${++seq}`;
      files.set(id, { ...up, folder: false, data: await bytesOf(init?.body) });
      return json({ id });
    }
    if (headers.get('authorization') !== `Bearer ${accessToken}`) return json({ error: { message: 'Invalid Credentials' } }, 401);
    if (g.apiDisabled) {
      return json({ error: { code: 403, message: 'Google Drive API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }, 403);
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(String(init?.body));
      const uid = `u${++seq}`;
      uploads.set(uid, { name: meta.name, parents: meta.parents ?? [] });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uid}` } });
    }
    if (url.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'me@gmail.com' }, storageQuota: { limit: String(5 * 1024 ** 4), usage: String(1024 ** 3) } });
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(String(init?.body));
      const id = `d${++seq}`;
      files.set(id, { name: meta.name, parents: meta.parents ?? [], folder: meta.mimeType === 'application/vnd.google-apps.folder' });
      return json({ id });
    }
    const m = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const f = files.get(id);
      if (!f) return json({ error: { message: 'File not found' } }, 404);
      if (method === 'DELETE') {
        const drop = (x: string) => {
          files.delete(x);
          for (const [k, v] of [...files]) if (v.parents.includes(x)) drop(k);
        };
        drop(id);
        return status(204);
      }
      if (url.searchParams.get('alt') === 'media') return f.data ? serve(f.data, headers.get('range')) : status(403);
      return json({ id, trashed: !!f.trashed });
    }
    return status(404);
  };
  return Object.assign(g, { fetch });
}

/** Sends each request to the fake that owns its host. */
export function routeFetch(...fakes: { fetch: typeof fetch }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: Init) => {
    let last: unknown;
    for (const f of fakes) {
      try {
        return await f.fetch(input, init);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }) as typeof fetch;
}
