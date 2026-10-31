import { beforeEach, describe, expect, it } from 'vitest';
import { Hub, MemoryStore } from '../server/src/hub';
import { signV4 } from '../server/src/storage';
import { fromUtf8, randomBytes, toB64, utf8 } from '../src/core/bytes';
import { deriveContentKey, hmac, openProofMessage } from '../src/core/crypto';
import { buildVault, DEFAULT_POLICY, DEFAULT_PROTECTION, openManifest, prepareUnlock, readFile, sliceBlob, type BuiltVault } from '../src/core/format';
import { fakeGoogle, fakeS3, fakeWebdav, routeFetch } from './fakeClouds';

const FAST_KDF = { alg: 'argon2id' as const, m: 1024, t: 1, p: 1 };
const PART = 64; // tiny parts, so every vault below spans several of them
let now = Date.parse('2026-11-01T00:00:00Z');
let hub: Hub;
let token: string;

async function call(method: string, path: string, body?: unknown, auth?: string, extra: Record<string, string> = {}) {
  const res = await hub.handle(new Request(`https://x.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...extra },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function setup(fetcher: typeof fetch) {
  hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: 'admin-pass' }, () => now, fetcher, { partBytes: PART });
  token = (await call('POST', '/api/admin/login', { password: 'admin-pass' })).body.token;
}

const password = 'pw-123456';
const keyfile = randomBytes(32);
const share = randomBytes(32);
const content = { a: '第一份文件的內容，'.repeat(8), b: 'second file '.repeat(12) };

function build(id: string): Promise<BuiltVault> {
  return buildVault(
    [
      { path: 'docs/a.txt', mime: 'text/plain', size: utf8(content.a).length, read: async () => utf8(content.a) },
      { path: 'b.txt', mime: 'text/plain', size: utf8(content.b).length, read: async () => utf8(content.b) },
    ],
    { title: 'T', recipient: '小明', batchId: 'b1', mode: 'online', server: 'https://x.test', policy: DEFAULT_POLICY, protection: DEFAULT_PROTECTION, password, keyfile, serverShare: share, kdf: FAST_KDF, vaultId: id },
  );
}

/** Registers a cloud vault and uploads it the way the packer does. */
async function publish(id: string, storage: string) {
  const v = await build(id);
  const size = v.header.blobSize;
  const reg = await call('POST', '/api/admin/vaults', {
    vaults: [{ id, batchId: 'b1', title: 'T', recipient: '小明', authKey: toB64(v.authKey), share: toB64(share), policy: { maxOpens: 3 }, cloud: { storage, size }, header: v.header }],
  }, token);
  expect(reg.status).toBe(200);
  const { parts, partBytes } = reg.body.cloud[id];
  expect(parts).toBe(Math.ceil(size / partBytes));
  // not readable before the upload finished
  expect((await call('GET', `/api/vault/${id}`)).body.code).toBe('uploading');
  for (let p = 0; p < parts; p++) {
    const r = await call('PUT', `/api/admin/blob/${id}/${p}`, sliceBlob(v.blobParts, p * partBytes, Math.min(size, (p + 1) * partBytes)), token, { 'content-type': 'application/octet-stream' });
    expect(r.status, r.text).toBe(200);
  }
  expect((await call('POST', `/api/admin/vaults/${id}/complete`, {}, token)).status).toBe(200);
  return v;
}

async function open(id: string) {
  const c = await call('POST', '/api/open/challenge', { vaultId: id });
  const proof = toB64(await hmac(await authKeyFor(id), openProofMessage(id, c.body.nonce)));
  return call('POST', '/api/open', { vaultId: id, nonce: c.body.nonce, proof });
}

const headers = new Map<string, any>();
async function authKeyFor(id: string) {
  const h = headers.get(id) ?? (await call('GET', `/api/vault/${id}`)).body.header;
  headers.set(id, h);
  return (await prepareUnlock(h, password, keyfile)).authKey;
}

/** What the viewer does after unlocking: fetch the ranges a file needs and decrypt them. */
async function readAll(id: string, pass: string) {
  const r = await call('GET', `/api/vault/${id}`);
  const { header, blob } = r.body;
  const source = {
    async read(offset: number, length: number) {
      const out = new Uint8Array(length);
      for (let pos = offset; pos < offset + length; ) {
        const part = Math.floor(pos / blob.partBytes);
        const end = Math.min(offset + length, (part + 1) * blob.partBytes);
        const res = await hub.handle(new Request(`https://x.test/api/blob/${id}/${part}`, { headers: { authorization: `Bearer ${pass}`, range: `bytes=${pos - part * blob.partBytes}-${end - part * blob.partBytes - 1}` } }));
        if (res.status !== 206) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        out.set(new Uint8Array(await res.arrayBuffer()), pos - offset);
        pos = end;
      }
      return out;
    },
    clear() {},
  };
  const { pwKey, salt } = await prepareUnlock(header, password, keyfile);
  const key = await deriveContentKey(pwKey, keyfile, share, salt);
  const manifest = await openManifest(header, key);
  return Promise.all(manifest.files.map(async (f) => [f.path, fromUtf8(await readFile(header, source, f, key))]));
}

beforeEach(() => {
  now = Date.parse('2026-11-01T00:00:00Z');
  headers.clear();
});

describe('AWS Signature V4', () => {
  it('matches the GET Object example from the AWS documentation', async () => {
    const h = await signV4({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9' },
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      amzDate: '20130524T000000Z',
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('cloud link vaults on WebDAV (Nextcloud)', () => {
  let dav: ReturnType<typeof fakeWebdav>;
  beforeEach(async () => {
    dav = fakeWebdav();
    await setup(dav.fetch as typeof fetch);
  });

  const addDav = (over: object = {}) =>
    call('POST', '/api/admin/storage', { type: 'webdav', name: '公司 Nextcloud', config: { url: `${dav.base}/`, username: 'ben', password: 'app-pass', folder: '隨身密閱', ...over } }, token);

  it('tests the settings before saving, and never sends the password back', async () => {
    const bad = await addDav({ password: 'wrong' });
    expect(bad.status).toBe(502);
    expect(bad.body.message).toContain('應用程式密碼');
    const ok = await addDav();
    expect(ok.status, ok.text).toBe(200);
    const list = await call('GET', '/api/admin/storage', undefined, token);
    expect(list.body.profiles).toHaveLength(1);
    const p = list.body.profiles[0];
    expect(p).toMatchObject({ type: 'webdav', name: '公司 Nextcloud', status: 'ready', isDefault: true, account: 'ben @ dav.test', secretsSet: { password: true } });
    expect(JSON.stringify(list.body)).not.toContain('app-pass');
    expect(list.body.googleRedirectUri).toBe('https://x.test/api/storage/google/callback');
    // editing without retyping the password keeps it
    expect((await call('POST', '/api/admin/storage', { id: p.id, name: '改名', config: { url: `${dav.base}/`, username: 'ben', password: '' } }, token)).status).toBe(200);
    // the storage endpoints are for the admin only
    expect((await call('GET', '/api/admin/storage')).status).toBe(401);
  });

  it('stores only ciphertext, hands it out after a successful open, and cleans up on delete', async () => {
    const sid = (await addDav()).body.id;
    await publish('cv1', sid);
    const stored = [...dav.files.entries()].filter(([k]) => k.includes('/cv1/'));
    expect(stored.length).toBeGreaterThan(1);
    for (const [, data] of stored) expect(fromUtf8(data)).not.toContain('第一份');

    // without a pass from /api/open nothing can be read
    expect((await call('GET', '/api/blob/cv1/0', undefined, 'made-up')).status).toBe(401);
    const opened = await open('cv1');
    expect(opened.status, opened.text).toBe(200);
    expect(opened.body.blob.token).toBeTruthy();
    expect(Object.fromEntries(await readAll('cv1', opened.body.blob.token))).toEqual({ 'docs/a.txt': content.a, 'b.txt': content.b });

    // the list shows it is a cloud vault, without storage internals
    const list = await call('GET', '/api/admin/vaults', undefined, token);
    expect(list.body.vaults[0].cloud).toEqual({ storage: sid, size: expect.any(Number), complete: true });
    expect(JSON.stringify(list.body)).not.toContain('refs');
    // a storage in use cannot be removed
    expect((await call('DELETE', `/api/admin/storage/${sid}`, undefined, token)).body.code).toBe('in_use');

    // revoking stops reading at once, also for whoever is reading right now
    await call('PATCH', '/api/admin/vaults/cv1', { revoked: true }, token);
    expect((await call('GET', '/api/blob/cv1/0', undefined, opened.body.blob.token)).status).toBe(401);
    expect((await open('cv1')).body.code).toBe('revoked');

    // deleting removes the files in the cloud too
    expect((await call('DELETE', '/api/admin/vaults/cv1', undefined, token)).body).toEqual({ ok: true });
    expect([...dav.files.keys()].filter((k) => k.includes('/cv1/'))).toEqual([]);
    expect((await call('GET', '/api/vault/cv1')).status).toBe(404);
    expect((await call('DELETE', `/api/admin/storage/${sid}`, undefined, token)).status).toBe(200);
  });

  it('expires the reading pass and checks part sizes and bounds', async () => {
    const sid = (await addDav()).body.id;
    const v = await build('cv2');
    const size = v.header.blobSize;
    await call('POST', '/api/admin/vaults', { vaults: [{ id: 'cv2', authKey: toB64(v.authKey), share: toB64(share), cloud: { storage: sid, size }, header: v.header }] }, token);
    expect((await call('PUT', '/api/admin/blob/cv2/0', new Uint8Array(5), token)).status).toBe(400); // wrong size
    expect((await call('PUT', '/api/admin/blob/cv2/0', new Uint8Array(PART))).status).toBe(401); // not admin
    expect((await call('POST', '/api/admin/vaults/cv2/complete', {}, token)).body.code).toBe('incomplete');
    // a header that does not belong to this vault is refused
    const other = await call('POST', '/api/admin/vaults', { vaults: [{ id: 'cv3', authKey: toB64(v.authKey), share: toB64(share), cloud: { storage: sid, size }, header: v.header }] }, token);
    expect(other.status).toBe(400);
    const parts = Math.ceil(size / PART);
    for (let p = 0; p < parts; p++) await call('PUT', `/api/admin/blob/cv2/${p}`, sliceBlob(v.blobParts, p * PART, Math.min(size, (p + 1) * PART)), token);
    await call('POST', '/api/admin/vaults/cv2/complete', {}, token);
    const pass = (await open('cv2')).body.blob.token;
    expect((await call('GET', `/api/blob/cv2/${parts}`, undefined, pass)).status).toBe(404);
    now += 13 * 3600_000;
    expect((await call('GET', '/api/blob/cv2/0', undefined, pass)).body.code).toBe('no_pass');
  });
});

describe('cloud link vaults on Cloudflare R2 (S3 API)', () => {
  it('signs every request, reads ranges, and deletes big vaults over several calls', async () => {
    const s3 = fakeS3();
    await setup(s3.fetch as typeof fetch);
    const bad = await call('POST', '/api/admin/storage', { type: 's3', name: 'R2', config: { endpoint: s3.endpoint, region: 'auto', bucket: s3.bucket, accessKeyId: 'WRONG', secretAccessKey: 'x' } }, token);
    expect(bad.status).toBe(502);
    const add = await call('POST', '/api/admin/storage', { type: 's3', name: 'R2', config: { endpoint: s3.endpoint, region: 'auto', bucket: s3.bucket, accessKeyId: 'KEYID', secretAccessKey: 'SECRET', prefix: 'vv' } }, token);
    expect(add.status, add.text).toBe(200);
    expect(s3.objects.size).toBe(0); // the test object was removed again

    // a vault of many parts: deleting it needs more requests than one call may make
    hub = new Hub((hub as any).store, { ADMIN_PASSWORD: 'admin-pass' }, () => now, s3.fetch as typeof fetch, { partBytes: 8 });
    token = (await call('POST', '/api/admin/login', { password: 'admin-pass' })).body.token;
    await publish('rv1', add.body.id);
    const count = s3.objects.size;
    expect(count).toBeGreaterThan(40);
    expect([...s3.objects.keys()].every((k) => k.startsWith('vv/rv1/'))).toBe(true);
    const pass = (await open('rv1')).body.blob.token;
    expect(Object.fromEntries(await readAll('rv1', pass))['b.txt']).toBe(content.b);

    const first = await call('DELETE', '/api/admin/vaults/rv1', undefined, token);
    expect(first.body.pending).toBe(count - 40);
    expect((await open('rv1')).body.code).toBe('revoked'); // half-deleted vaults cannot be opened
    const second = await call('DELETE', '/api/admin/vaults/rv1', undefined, token);
    expect(second.body).toEqual({ ok: true });
    expect(s3.objects.size).toBe(0);
  });
});

describe('cloud link vaults on Google Drive', () => {
  let google: ReturnType<typeof fakeGoogle>;
  beforeEach(async () => {
    google = fakeGoogle();
    await setup(routeFetch(google) as typeof fetch);
  });

  async function connect(code = 'good-code') {
    const start = await call('POST', '/api/admin/storage/google/start', { name: 'My Drive', clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' }, token);
    expect(start.status, start.text).toBe(200);
    const auth = new URL(start.body.authUrl);
    expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('redirect_uri')).toBe('https://x.test/api/storage/google/callback');
    const back = await call('GET', `/api/storage/google/callback?state=${auth.searchParams.get('state')}&code=${code}`);
    return { id: start.body.id as string, back, state: auth.searchParams.get('state') };
  }

  it('connects through the Google sign-in and keeps the vault in its own folder', async () => {
    const { id, back, state } = await connect();
    expect(back.status).toBe(200);
    expect(back.text).toContain('已連結 Google Drive');
    expect(back.headers.get('content-security-policy')).toContain("default-src 'none'");
    // the sign-in link works once only
    expect((await call('GET', `/api/storage/google/callback?state=${state}&code=good-code`)).text).toContain('過期');
    const p = (await call('GET', '/api/admin/storage', undefined, token)).body.profiles[0];
    expect(p).toMatchObject({ id, type: 'gdrive', status: 'ready', account: 'me@gmail.com', secretsSet: { clientSecret: true, refreshToken: true } });
    expect(p.connectedAt).toBeTruthy();
    const root = [...google.files.entries()].find(([, f]) => f.name === '隨身密閱')!;
    expect(root[1].folder).toBe(true);
    expect(p.config.folderId).toBe(root[0]); // shown, for the "open the folder in Drive" link

    await publish('gv1', id);
    const vaultFolder = [...google.files.entries()].find(([, f]) => f.name === 'gv1')!;
    expect(vaultFolder[1].parents).toEqual([root[0]]);
    const parts = [...google.files.values()].filter((f) => f.parents.includes(vaultFolder[0]));
    expect(parts.map((f) => f.name)).toContain('00000.bin');

    // an expired access token is refreshed by itself
    google.expireAccessToken();
    now += 2 * 3600_000;
    const pass = (await open('gv1')).body.blob.token;
    expect(Object.fromEntries(await readAll('gv1', pass))['docs/a.txt']).toBe(content.a);

    // test reports the account and quota
    expect((await call('POST', `/api/admin/storage/${id}/test`, {}, token)).body.message).toContain('me@gmail.com · 已用 1.0 GB / 5120 GB');

    // a refusal while reading says why (here: the Drive API was switched off in the project)
    google.apiDisabled = true;
    const refused = await hub.handle(new Request('https://x.test/api/blob/gv1/0', { headers: { authorization: `Bearer ${pass}`, range: 'bytes=0-9' } }));
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { message: string }).message).toContain('Google Drive API');
    google.apiDisabled = false;

    // deleting the vault deletes its folder (and every part in it) in one request
    await call('DELETE', '/api/admin/vaults/gv1', undefined, token);
    expect([...google.files.values()].some((f) => f.name === 'gv1' || f.name.endsWith('.bin'))).toBe(false);
  });

  it('explains a refused sign-in and a revoked authorisation', async () => {
    expect((await connect('bad-code')).back.text).toContain('連結失敗');
    const { id } = await connect();
    google.revoked = true;
    google.expireAccessToken();
    now += 2 * 3600_000;
    const r = await call('POST', `/api/admin/storage/${id}/test`, {}, token);
    expect(r.body.code).toBe('reauth');
    expect(r.body.message).toContain('7 天');
  });

  it('says what to do when the Drive API is off or Drive was not ticked, and lets the sign-in be finished again', async () => {
    google.apiDisabled = true;
    const first = await connect();
    expect(first.back.text).toContain('還沒有啟用「Google Drive API」');
    expect((await call('GET', '/api/admin/storage', undefined, token)).body.profiles[0].status).toBe('pending');
    google.apiDisabled = false;
    google.grantedScope = 'openid';
    expect((await connect()).back.text).toContain('沒有勾選「Google 雲端硬碟」');
    google.grantedScope = 'https://www.googleapis.com/auth/drive.file';
    expect((await connect()).back.text).toContain('已連結 Google Drive');
  });

    it('refuses a client id that is not a Google one', async () => {
    const r = await call('POST', '/api/admin/storage/google/start', { clientId: 'nope', clientSecret: 'x' }, token);
    expect(r.status).toBe(400);
  });
});
