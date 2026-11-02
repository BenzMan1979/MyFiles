import { beforeEach, describe, expect, it } from 'vitest';
import { Hub, MemoryStore } from '../server/src/hub';
import { base32Decode, totpAt, verifyTotp } from '../server/src/totp';
import { toB64, randomBytes } from '../src/core/bytes';
import { fakeGoogle, fakeWebdav, routeFetch } from './fakeClouds';

let now = Date.parse('2026-11-02T00:00:00Z');
let hub: Hub;
let dav: ReturnType<typeof fakeWebdav>;
const PACKER = 'https://pages.test/MyFiles/';

async function call(method: string, path: string, body?: unknown, auth?: string) {
  const res = await hub.handle(new Request(`https://srv.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challengeOf = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
const codeNow = async (secret: string, at = now) => totpAt(base32Decode(secret), Math.floor(at / 30000));

/** Runs the Google sign-in up to the ticket, like the packer does. */
async function signIn(email: string, o: { purpose?: 'enable'; bearer?: string; returnTo?: string; verifier?: string } = {}) {
  const verifier = o.verifier ?? `verifier-${Math.random()}-${Math.random()}`;
  const start = await call('POST', '/api/auth/google/start', { returnTo: o.returnTo ?? PACKER, challenge: await challengeOf(verifier), purpose: o.purpose }, o.bearer);
  if (start.status !== 200) return { start };
  const state = new URL(start.body.authUrl).searchParams.get('state');
  const back = await call('GET', `/api/storage/google/callback?state=${state}&code=login:${email}`);
  const location = back.headers.get('location') ?? '';
  const ticket = location.match(/#vvlogin=(.+)$/)?.[1] ?? '';
  const t = await call('POST', '/api/auth/ticket', { ticket, verifier });
  return { start, location, ticket, verifier, next: t.body };
}

async function totp(ticket: string, verifier: string, code: string, remember = false) {
  return call('POST', '/api/auth/totp', { ticket, verifier, code, remember });
}

/** Signs in and, at the first time, scans the QR code. Returns the token and the person's secret. */
async function login(email: string, secret?: string, o: Parameters<typeof signIn>[1] = {}) {
  const s = await signIn(email, o);
  const sec = s.next.next === 'enroll' ? s.next.secret : secret!;
  const r = await totp(s.ticket!, s.verifier!, await codeNow(sec));
  now += 31_000; // a code is good once: later sign-ins in these tests use the next one
  return { token: r.body.token as string, secret: sec, res: r, enrolled: s.next.next === 'enroll' };
}

async function ownerPassword() {
  return (await call('POST', '/api/admin/login', { password: 'deploy-pass' })).body.token as string;
}

async function enableGoogle(ownerEmail = 'boss@gmail.com') {
  const t0 = await ownerPassword();
  expect((await call('POST', '/api/admin/auth/google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' }, t0)).status).toBe(200);
  const r = await login(ownerEmail, undefined, { purpose: 'enable', bearer: t0 });
  return { t0, ...r };
}

beforeEach(() => {
  now = Date.parse('2026-11-02T00:00:00Z');
  dav = fakeWebdav();
  hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: 'deploy-pass' }, () => now, routeFetch(fakeGoogle(), dav) as typeof fetch);
});

describe('TOTP (RFC 6238)', () => {
  it('matches the SHA-1 test vectors', async () => {
    const secret = new TextEncoder().encode('12345678901234567890');
    const at = async (t: number) => totpAt(secret, Math.floor(t / 30), 8);
    expect(await at(59)).toBe('94287082');
    expect(await at(1111111109)).toBe('07081804');
    expect(await at(1234567890)).toBe('89005924');
    expect(await at(2000000000)).toBe('69279037');
  });

  it('allows one step of clock drift and refuses a code twice', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const t = Date.parse('2026-11-02T00:00:10Z');
    const step = Math.floor(t / 30000);
    const code = await totpAt(base32Decode(secret), step - 1);
    expect(await verifyTotp(secret, code, t)).toBe(step - 1);
    expect(await verifyTotp(secret, code, t, step - 1)).toBeNull();
    expect(await verifyTotp(secret, await totpAt(base32Decode(secret), step - 2), t)).toBeNull();
  });
});

describe('Google sign-in + authenticator', () => {
  it('is switched on by the owner signing in once, then replaces the password', async () => {
    expect((await call('GET', '/api/info')).body.auth.mode).toBe('password');
    const { t0, token, res, enrolled } = await enableGoogle();
    expect(enrolled).toBe(true);
    expect(res.body).toMatchObject({ enabled: true, user: { email: 'boss@gmail.com', role: 'owner' } });
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect((await call('GET', '/api/info')).body.auth.mode).toBe('google');
    // the old password session is over; the new one works
    expect((await call('GET', '/api/admin/vaults', undefined, t0)).status).toBe(401);
    expect((await call('GET', '/api/admin/me', undefined, token)).body.me).toMatchObject({ email: 'boss@gmail.com', role: 'owner' });
    // the packer it was switched on from may receive sign-ins from now on
    expect((await call('GET', '/api/admin/auth', undefined, token)).body.returnOrigins).toEqual(['https://pages.test']);
    // the deploy-time password is the spare key, marked as such
    const spare = await call('POST', '/api/admin/login', { password: 'deploy-pass' });
    expect(spare.body.user).toMatchObject({ role: 'owner', breakGlass: true });
    expect((await call('GET', '/api/admin/vaults', undefined, spare.body.token)).status).toBe(200);
    expect((await call('POST', '/api/admin/login', { password: 'wrong' })).status).toBe(401);
    // no password to change while Google sign-in is on
    expect((await call('POST', '/api/admin/password', { current: 'deploy-pass', next: 'another-pass' }, token)).status).toBe(409);
  });

  it('refuses an account that is not listed exactly like a wrong code', async () => {
    const { token: owner } = await enableGoogle();
    await call('POST', '/api/admin/users', { email: 'Alice@Example.com' }, owner);
    const alice = await login('alice@example.com');
    const a = await signIn('alice@example.com');
    const wrongForAlice = await totp(a.ticket!, a.verifier!, '000000');
    const stranger = await signIn('stranger@gmail.com');
    expect(stranger.next.next).toBe('totp'); // not "you are not allowed"
    const refused = await totp(stranger.ticket!, stranger.verifier!, '123456');
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual(wrongForAlice.body);
    expect(alice.res.body.user).toMatchObject({ email: 'alice@example.com', role: 'member' });
  });

  it('needs the verifier the packer kept, and a code works only once', async () => {
    const { token: owner, secret } = await enableGoogle();
    const s = await signIn('boss@gmail.com');
    expect((await call('POST', '/api/auth/ticket', { ticket: s.ticket, verifier: 'stolen' })).status).toBe(401);
    const code = await codeNow(secret);
    expect((await totp(s.ticket!, s.verifier!, code)).status).toBe(200);
    const again = await signIn('boss@gmail.com');
    expect((await totp(again.ticket!, again.verifier!, code)).status).toBe(401);
    expect(owner).toBeTruthy();
  });

  it('accepts each recovery code once, and locks after repeated wrong codes', async () => {
    const { res } = await enableGoogle();
    const [first] = res.body.recoveryCodes;
    let s = await signIn('boss@gmail.com');
    expect((await totp(s.ticket!, s.verifier!, first.toLowerCase())).status).toBe(200);
    s = await signIn('boss@gmail.com');
    expect((await totp(s.ticket!, s.verifier!, first)).status).toBe(401); // used up: counts as a wrong code
    for (let i = 0; i < 3; i++) {
      s = await signIn('boss@gmail.com');
      await totp(s.ticket!, s.verifier!, '000000');
    }
    s = await signIn('boss@gmail.com');
    expect((await totp(s.ticket!, s.verifier!, '000000')).status).toBe(401);
    s = await signIn('boss@gmail.com');
    expect((await totp(s.ticket!, s.verifier!, '000000')).status).toBe(429);
  });

  it('only returns to the packer sites the owner allowed', async () => {
    await enableGoogle();
    expect((await signIn('boss@gmail.com', { returnTo: 'https://evil.test/' })).start.body.code).toBe('bad_origin');
    expect((await signIn('boss@gmail.com', { returnTo: 'https://srv.test/#servers' })).start.status).toBe(200); // the server itself
  });

  it('lets whole domains in when chosen, as members', async () => {
    const { token: owner } = await enableGoogle();
    expect((await call('PATCH', '/api/admin/auth', { access: 'domain', domains: [] }, owner)).status).toBe(400);
    await call('PATCH', '/api/admin/auth', { access: 'domain', domains: ['@Corp.test'] }, owner);
    const bob = await login('bob@corp.test');
    expect(bob.res.body.user).toMatchObject({ email: 'bob@corp.test', role: 'member' });
    expect((await signIn('eve@other.test')).next.next).toBe('totp');
    const users = (await call('GET', '/api/admin/auth', undefined, owner)).body.users;
    expect(users.map((u: any) => u.email)).toEqual(['boss@gmail.com', 'bob@corp.test']);
    expect(users[1]).toMatchObject({ addedBy: 'auto', totp: true });
  });

  it('keeps at least one owner, and ends sessions of people who are disabled or reset', async () => {
    const { token: owner } = await enableGoogle();
    expect((await call('PATCH', '/api/admin/users/boss%40gmail.com', { role: 'member' }, owner)).body.code).toBe('last_owner');
    await call('POST', '/api/admin/users', { email: 'amy@gmail.com' }, owner);
    const amy = await login('amy@gmail.com');
    expect((await call('GET', '/api/admin/vaults', undefined, amy.token)).status).toBe(200);
    await call('PATCH', '/api/admin/users/amy%40gmail.com', { disabled: true }, owner);
    expect((await call('GET', '/api/admin/vaults', undefined, amy.token)).status).toBe(401);
    await call('PATCH', '/api/admin/users/amy%40gmail.com', { disabled: false, resetTotp: true }, owner);
    expect((await signIn('amy@gmail.com')).next.next).toBe('enroll'); // scans a new QR code
    expect((await call('DELETE', '/api/admin/users/boss%40gmail.com', undefined, owner)).body.code).toBe('self');
  });

  it('remembers a device for 30 days when asked', async () => {
    const { secret } = await enableGoogle();
    const s = await signIn('boss@gmail.com');
    const r = await totp(s.ticket!, s.verifier!, await codeNow(secret), true);
    now += 20 * 86_400_000;
    expect((await call('GET', '/api/admin/me', undefined, r.body.token)).status).toBe(200);
    now += 11 * 86_400_000;
    expect((await call('GET', '/api/admin/me', undefined, r.body.token)).status).toBe(401);
  });

  it('can go back to the password', async () => {
    const { token } = await enableGoogle();
    await call('POST', '/api/admin/auth/password', {}, token);
    expect((await call('GET', '/api/info')).body.auth.mode).toBe('password');
    expect((await call('GET', '/api/admin/me', undefined, token)).status).toBe(401);
    expect((await call('POST', '/api/admin/login', { password: 'deploy-pass' })).body.user.breakGlass).toBe(false);
  });
});

describe('owners and members', () => {
  const vault = (id: string) => ({ id, batchId: 'b', title: 'T', recipient: 'R', authKey: toB64(randomBytes(32)), share: toB64(randomBytes(32)) });

  it('members see and manage only their own vaults, and none of the settings', async () => {
    const { token: owner } = await enableGoogle();
    await call('POST', '/api/admin/users', { email: 'amy@gmail.com' }, owner);
    const amy = (await login('amy@gmail.com')).token;
    expect((await call('POST', '/api/admin/vaults', { vaults: [vault('own1')] }, owner)).status).toBe(200);
    expect((await call('POST', '/api/admin/vaults', { vaults: [vault('amy1')] }, amy)).status).toBe(200);

    expect((await call('GET', '/api/admin/vaults', undefined, amy)).body.vaults.map((v: any) => v.id)).toEqual(['amy1']);
    const all = (await call('GET', '/api/admin/vaults', undefined, owner)).body.vaults;
    expect(Object.fromEntries(all.map((v: any) => [v.id, v.createdBy]))).toEqual({ own1: 'boss@gmail.com', amy1: 'amy@gmail.com' });
    // someone else's vault looks like it does not exist
    expect((await call('PATCH', '/api/admin/vaults/own1', { revoked: true }, amy)).status).toBe(404);
    expect((await call('DELETE', '/api/admin/vaults/own1', undefined, amy)).status).toBe(404);
    expect((await call('GET', '/api/admin/vaults/own1/logs', undefined, amy)).status).toBe(404);
    expect((await call('PATCH', '/api/admin/vaults/amy1', { revoked: true }, amy)).status).toBe(200);
    expect((await call('PATCH', '/api/admin/vaults/amy1', { revoked: false }, owner)).status).toBe(200); // owners can
    expect((await call('GET', '/api/admin/stats', undefined, amy)).body.stats.totals.vaults).toBe(1);
    // settings are for the owner
    for (const [m, p] of [['GET', '/api/admin/auth'], ['POST', '/api/admin/users'], ['POST', '/api/admin/storage'], ['POST', '/api/admin/auth/password']] as const) {
      expect((await call(m, p, m === 'GET' ? undefined : {}, amy)).status).toBe(403);
    }
  });

  it('members only see and use the cloud storages opened to them', async () => {
    const { token: owner } = await enableGoogle();
    const add = await call('POST', '/api/admin/storage', { type: 'webdav', name: 'NC', config: { url: `${dav.base}/`, username: 'ben', password: 'app-pass' } }, owner);
    expect(add.status).toBe(200);
    await call('POST', '/api/admin/users', { email: 'amy@gmail.com' }, owner);
    const amy = (await login('amy@gmail.com')).token;
    expect((await call('GET', '/api/admin/storage', undefined, amy)).body.profiles).toEqual([]);
    const cloudVault = { ...vault('c1'), cloud: { storage: add.body.id, size: 10 }, header: { id: 'c1', blobSize: 10, mode: 'online' } };
    expect((await call('POST', '/api/admin/vaults', { vaults: [cloudVault] }, amy)).status).toBe(403);
    await call('POST', `/api/admin/storage/${add.body.id}/members`, { enabled: true }, owner);
    const seen = (await call('GET', '/api/admin/storage', undefined, amy)).body.profiles;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'NC', account: '', config: {}, isDefault: true });
    expect((await call('POST', '/api/admin/vaults', { vaults: [cloudVault] }, amy)).status).toBe(200);
  });
});
