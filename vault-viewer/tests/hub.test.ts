import { describe, expect, it, beforeEach } from 'vitest';
import { Hub, MemoryStore } from '../server/src/hub';
import { hmac, openProofMessage } from '../src/core/crypto';
import { randomBytes, toB64 } from '../src/core/bytes';

let now = Date.parse('2026-11-01T00:00:00Z');
let hub: Hub;
const authKey = randomBytes(32);
const share = randomBytes(32);

async function call(method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const res = await hub.handle(new Request(`https://x.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json()) as any };
}

async function admin() {
  return (await call('POST', '/api/admin/login', { password: 'admin-pass' })).body.token as string;
}

async function register(policy: object, id = 'v1') {
  const t = await admin();
  return call('POST', '/api/admin/vaults', { vaults: [{ id, batchId: 'b', title: 'T', recipient: '小明', authKey: toB64(authKey), share: toB64(share), policy }] }, t);
}

async function open(key = authKey, session?: string, id = 'v1', extra: { tag?: string; headers?: Record<string, string> } = {}) {
  const c = await call('POST', '/api/open/challenge', { vaultId: id });
  const proof = toB64(await hmac(key, openProofMessage(id, c.body.nonce)));
  return call('POST', '/api/open', { vaultId: id, nonce: c.body.nonce, proof, session, tag: extra.tag }, undefined, extra.headers);
}

beforeEach(() => {
  now = Date.parse('2026-11-01T00:00:00Z');
  hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: 'admin-pass' }, () => now);
});

describe('hub', () => {
  it('reports info and rejects bad admin passwords', async () => {
    expect((await call('GET', '/api/info')).body).toMatchObject({ app: 'vault-viewer-server', adminConfigured: true });
    expect((await call('POST', '/api/admin/login', { password: 'nope' })).status).toBe(401);
    expect((await call('GET', '/api/admin/vaults', undefined, 'bogus')).status).toBe(401);
  });

  it('locks admin login after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/admin/login', { password: 'nope' });
    expect((await call('POST', '/api/admin/login', { password: 'admin-pass' })).status).toBe(429);
    now += 16 * 60 * 1000;
    expect((await call('POST', '/api/admin/login', { password: 'admin-pass' })).status).toBe(200);
  });

  it('first-time setup when no env password', async () => {
    hub = new Hub(new MemoryStore(), {}, () => now);
    expect((await call('GET', '/api/info')).body.adminConfigured).toBe(false);
    expect((await call('POST', '/api/admin/setup', { password: 'short' })).status).toBe(400);
    const s = await call('POST', '/api/admin/setup', { password: 'long-enough-pw' });
    expect(s.body.token).toBeTruthy();
    expect((await call('POST', '/api/admin/setup', { password: 'another-pw-1' })).status).toBe(409);
    expect((await call('POST', '/api/admin/login', { password: 'long-enough-pw' })).status).toBe(200);
  });

  it('changes the admin password', async () => {
    const t = await admin();
    expect((await call('POST', '/api/admin/password', { current: 'admin-pass', next: 'new-pass-123' }, t)).status).toBe(200);
    expect((await call('POST', '/api/admin/login', { password: 'admin-pass' })).status).toBe(401);
    expect((await call('POST', '/api/admin/login', { password: 'new-pass-123' })).status).toBe(200);
    expect((await call('GET', '/api/admin/vaults', undefined, t)).status).toBe(401); // old sessions revoked
  });

  it('opens with a valid proof and counts opens', async () => {
    await register({ maxOpens: 2, maxFailures: 3, sessionMinutes: 0 });
    const a = await open();
    expect(a.status).toBe(200);
    expect(a.body.share).toBe(toB64(share));
    expect(a.body.status).toMatchObject({ opens: 1, maxOpens: 2 });
    expect((await open()).status).toBe(200);
    const c = await open();
    expect(c.body.code).toBe('exhausted');
  });

  it('does not count a re-unlock inside the session window', async () => {
    await register({ maxOpens: 1, sessionMinutes: 30 });
    const a = await open();
    const b = await open(authKey, a.body.session);
    expect(b.status).toBe(200);
    expect(b.body.status.opens).toBe(1);
    now += 31 * 60 * 1000;
    expect((await open(authKey, a.body.session)).body.code).toBe('exhausted');
  });

  it('locks after too many wrong proofs and can be unlocked', async () => {
    await register({ maxFailures: 2 });
    const bad = randomBytes(32);
    expect((await open(bad)).body).toMatchObject({ code: 'bad_proof', remainingAttempts: 1 });
    expect((await open(bad)).body.code).toBe('locked');
    expect((await open()).body.code).toBe('locked');
    const t = await admin();
    await call('PATCH', '/api/admin/vaults/v1', { unlock: true }, t);
    expect((await open()).status).toBe(200);
  });

  it('enforces dates with server time', async () => {
    await register({ notBefore: '2026-11-02T00:00:00Z', expiresAt: '2026-11-03T00:00:00Z' });
    expect((await open()).body.code).toBe('not_yet');
    now = Date.parse('2026-11-02T12:00:00Z');
    expect((await open()).status).toBe(200);
    now = Date.parse('2026-11-03T00:00:01Z');
    expect((await open()).body.code).toBe('expired');
    const t = await admin();
    await call('PATCH', '/api/admin/vaults/v1', { policy: { expiresAt: '2026-12-01T00:00:00Z' } }, t);
    expect((await open()).status).toBe(200);
  });

  it('revokes, logs, lists and deletes', async () => {
    await register({ sessionMinutes: 30 });
    const a = await open();
    const t = await admin();
    await call('PATCH', '/api/admin/vaults/v1', { revoked: true }, t);
    expect((await open(authKey, a.body.session)).body.code).toBe('revoked');
    const list = await call('GET', '/api/admin/vaults', undefined, t);
    expect(list.body.vaults[0]).toMatchObject({ id: 'v1', recipient: '小明', opens: 1, revoked: true });
    expect(list.body.vaults[0].share).toBeUndefined();
    expect(list.body.vaults[0].authKey).toBeUndefined();
    const logs = await call('GET', '/api/admin/vaults/v1/logs', undefined, t);
    expect(logs.body.logs.map((l: any) => l.ev)).toEqual(['denied', 'open']);
    expect((await call('DELETE', '/api/admin/vaults/v1', undefined, t)).status).toBe(200);
    expect((await call('POST', '/api/open/challenge', { vaultId: 'v1' })).status).toBe(404);
  });

  it('rejects replayed nonces and duplicate registration', async () => {
    await register({});
    const c = await call('POST', '/api/open/challenge', { vaultId: 'v1' });
    const proof = toB64(await hmac(authKey, openProofMessage('v1', c.body.nonce)));
    expect((await call('POST', '/api/open', { vaultId: 'v1', nonce: c.body.nonce, proof })).status).toBe(200);
    expect((await call('POST', '/api/open', { vaultId: 'v1', nonce: c.body.nonce, proof })).body.code).toBe('bad_nonce');
    expect((await register({})).status).toBe(409);
  });

  it('tells the viewer which address it connected from, and logs the watermark code', async () => {
    await register({ sessionMinutes: 30 });
    const a = await open(authKey, undefined, 'v1', { tag: 'A7K2Q9', headers: { 'x-vv-ip': '203.0.113.8', 'x-vv-country': 'TW' } });
    expect(a.body.client).toEqual({ ip: '203.0.113.8', country: 'TW' });
    const none = await open(authKey, a.body.session);
    expect(none.body.client).toEqual({ ip: null, country: null });
    await open(authKey, a.body.session, 'v1', { tag: 'bad tag!' }); // ignored: not alphanumeric
    const t = await admin();
    const logs = (await call('GET', '/api/admin/vaults/v1/logs', undefined, t)).body.logs;
    expect(logs.map((l: any) => l.tag)).toEqual([undefined, undefined, 'A7K2Q9']);
    expect(logs[2]).toMatchObject({ ev: 'open', ip: '203.0.113.8', country: 'TW' });
  });

  it('takes admin session, lockout and origin limits from Worker variables', async () => {
    hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: 'admin-pass', ADMIN_MAX_FAILURES: '2', ADMIN_LOCK_MINUTES: 1, ADMIN_SESSION_HOURS: '1', ADMIN_ORIGINS: 'https://vault.example.com/, https://other.example.com' }, () => now);
    // two wrong passwords lock the login, and the lock lasts one minute
    await call('POST', '/api/admin/login', { password: 'nope' });
    await call('POST', '/api/admin/login', { password: 'nope' });
    expect((await call('POST', '/api/admin/login', { password: 'admin-pass' })).status).toBe(429);
    now += 61_000;
    const t = (await call('POST', '/api/admin/login', { password: 'admin-pass' })).body.token;
    expect((await call('GET', '/api/admin/vaults', undefined, t)).status).toBe(200);
    // the login stays valid for one hour
    now += 59 * 60_000;
    expect((await call('GET', '/api/admin/vaults', undefined, t)).status).toBe(200);
    now += 2 * 60_000;
    expect((await call('GET', '/api/admin/vaults', undefined, t)).status).toBe(401);
  });

  it('limits browser access to the admin API to the listed websites only', async () => {
    hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: 'admin-pass', ADMIN_ORIGINS: 'https://vault.example.com' }, () => now);
    const withOrigin = (path: string, origin: string) =>
      hub.handle(new Request(`https://x.test${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) }));
    expect((await withOrigin('/api/admin/login', 'https://vault.example.com')).headers.get('access-control-allow-origin')).toBe('https://vault.example.com');
    expect((await withOrigin('/api/admin/login', 'https://evil.example.com')).headers.get('access-control-allow-origin')).toBeNull();
    // opening a vault (and the info check) stay open to every origin, including a vault file on disk
    expect((await withOrigin('/api/open/challenge', 'null')).headers.get('access-control-allow-origin')).toBe('*');
    const pre = await hub.handle(new Request('https://x.test/api/admin/vaults', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }));
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ignores nonsense values and keeps the defaults', async () => {
    hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: 'admin-pass', ADMIN_MAX_FAILURES: 'lots', ADMIN_LOCK_MINUTES: '', ADMIN_SESSION_HOURS: undefined }, () => now);
    for (let i = 0; i < 4; i++) await call('POST', '/api/admin/login', { password: 'nope' });
    expect((await call('POST', '/api/admin/login', { password: 'admin-pass' })).status).toBe(200); // still 5 tries
  });
});

