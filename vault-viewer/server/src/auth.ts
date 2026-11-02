// Who may use the packer and the admin API.
//
// Two modes:
//   password  the original: one admin password (the deploy-time ADMIN_PASSWORD or one set in the packer)
//   google    sign in with Google, then a code from an authenticator app (TOTP). Who may sign in is
//             up to the owner: listed accounts only, whole domains, or any Google account. People are
//             "owner" (everything) or "member" (only their own vaults). The deploy-time ADMIN_PASSWORD
//             secret stays a spare key that logs in as owner, for when every phone is lost.
//
// The Google sign-in uses the same OAuth client and callback address as Google Drive, so nothing new
// has to be registered in Google Cloud. The flow:
//   packer  POST /api/auth/google/start {returnTo, challenge}      -> Google's sign-in address
//   Google  -> GET callback?state&code   server learns the e-mail -> back to returnTo#vvlogin=<ticket>
//   packer  POST /api/auth/ticket {ticket, verifier}                -> "totp" or "enroll" (QR secret)
//   packer  POST /api/auth/totp {ticket, verifier, code, remember}  -> admin token
// The ticket only works with the verifier the packer kept (like PKCE), and a refused account is told
// exactly what a wrong code is told, so trying does not reveal which accounts are allowed.

import { BadRequest, fail, htmlPage, isStr, json, randomToken, type Store } from './common';
import { normaliseRecovery, newRecoveryCodes, newTotpSecret, otpauthUrl, sha256Hex, verifyTotp } from './totp';

export type Role = 'owner' | 'member';
export type Access = 'list' | 'domain' | 'any';

export interface Principal {
  /** null = signed in with a password (the owner) */
  email: string | null;
  role: Role;
  /** signed in with the deploy-time password while Google sign-in is on */
  breakGlass?: boolean;
}

export interface AuthConfig {
  mode: 'password' | 'google';
  access: Access;
  /** for access "domain": e-mail domains whose accounts may sign in, e.g. "example.com" */
  domains: string[];
  /** sites the sign-in may return to (where the packer is opened), besides this server itself */
  returnOrigins: string[];
  google: { clientId: string; clientSecret: string } | null;
}

interface UserRecord {
  email: string;
  role: Role;
  disabled: boolean;
  /** base32 TOTP secret; null until the person scans the QR code at their first sign-in */
  totp: string | null;
  /** last accepted TOTP step: the same code cannot be used twice */
  lastStep: number;
  /** SHA-256 of the unused recovery codes */
  recovery: string[];
  failures: number;
  lockUntil: number;
  lockLevel: number;
  createdAt: string;
  lastLoginAt: string | null;
  /** who added this person: an e-mail, "auto" (allowed by domain / anyone), or null (owner by password) */
  addedBy: string | null;
}

interface Session {
  expires: number;
  email: string | null;
  breakGlass?: boolean;
}

interface LoginState {
  returnTo: string;
  challenge: string;
  purpose: 'login' | 'enable';
  redirectUri: string;
  expires: number;
}

interface Ticket {
  email: string;
  allowed: boolean;
  purpose: 'login' | 'enable';
  challenge: string;
  expires: number;
  attempts: number;
  enrollSecret?: string;
}

const CFG = 'auth:cfg';
const USER = 'user:';
const STATE = 'glogin:';
const TICKET = 'ticket:';
const SESS = 'admin:sess:';
const STATE_MS = 15 * 60_000;
const TICKET_MS = 10 * 60_000;
const TICKET_ATTEMPTS = 5;
const USER_FAILURES = 5;
const LOCK_BASE_MS = 15 * 60_000;
const LOCK_MAX_MS = 24 * 3600_000;
export const REMEMBER_DAYS = 30;
const ISSUER = '隨身密閱';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FAILED = '登入失敗：驗證碼不正確，或這個帳號沒有使用權限';

const DEFAULT_CFG: AuthConfig = { mode: 'password', access: 'list', domains: [], returnOrigins: [], google: null };

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v))));
const normEmail = (e: string) => e.trim().toLowerCase();
const isEmail = (e: unknown): e is string => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const isDomain = (d: string) => /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);

function originOf(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The claims of an ID token received straight from Google's token endpoint over TLS (no signature check needed then). */
function idTokenClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

export function publicUser(u: UserRecord, now: number) {
  return {
    email: u.email,
    role: u.role,
    disabled: u.disabled,
    totp: !!u.totp,
    recoveryLeft: u.recovery.length,
    locked: u.lockUntil > now,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    addedBy: u.addedBy,
  };
}

export class Auth {
  constructor(
    private store: Store,
    private now: () => number,
    private fetcher: typeof fetch,
    /** how long a normal (not remembered) admin login lasts */
    private sessionMs: () => number,
  ) {}

  async config(): Promise<AuthConfig> {
    return { ...DEFAULT_CFG, ...((await this.store.get<AuthConfig>(CFG)) ?? {}) };
  }

  private async saveConfig(c: AuthConfig) {
    await this.store.put(CFG, c);
  }

  getUser(email: string) {
    return this.store.get<UserRecord>(USER + normEmail(email));
  }

  private async saveUser(u: UserRecord) {
    await this.store.put(USER + u.email, u);
  }

  async users(): Promise<UserRecord[]> {
    return [...(await this.store.list<UserRecord>({ prefix: USER })).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------- sessions ----------

  async issueSession(p: { email: string | null; breakGlass?: boolean }, remember: boolean, role: Role) {
    const token = randomToken();
    const expires = this.now() + (remember ? REMEMBER_DAYS * 86_400_000 : this.sessionMs());
    await this.store.put<Session>(SESS + token, { expires, email: p.email, ...(p.breakGlass ? { breakGlass: true } : {}) });
    return { token, expiresAt: new Date(expires).toISOString(), user: { email: p.email, role, breakGlass: !!p.breakGlass } };
  }

  /** Who a token belongs to, or null. Checked on every admin request, so disabling someone takes effect at once. */
  async principal(token: string): Promise<Principal | null> {
    if (!token || token.length > 100) return null;
    const s = await this.store.get<number | Session>(SESS + token);
    if (s === undefined) return null;
    const exp = typeof s === 'number' ? s : s.expires;
    if (exp < this.now()) {
      await this.store.delete(SESS + token);
      return null;
    }
    const mode = (await this.config()).mode;
    const sess: Session = typeof s === 'number' ? { expires: s, email: null } : s;
    if (!sess.email) {
      // A password login. Once Google sign-in is on, only the spare key (deploy-time password) counts.
      if (mode === 'google' && !sess.breakGlass) return this.drop(token);
      return { email: null, role: 'owner', breakGlass: !!sess.breakGlass };
    }
    if (mode !== 'google') return this.drop(token);
    const u = await this.getUser(sess.email);
    if (!u || u.disabled) return this.drop(token);
    return { email: u.email, role: u.role };
  }

  private async drop(token: string) {
    await this.store.delete(SESS + token);
    return null;
  }

  /** Ends sessions: everyone's, or one person's (when disabled or removed), optionally keeping one token. */
  async endSessions(filter: (s: Session) => boolean, keep?: string) {
    for (const [k, s] of await this.store.list<number | Session>({ prefix: SESS })) {
      if (k === SESS + keep) continue;
      if (filter(typeof s === 'number' ? { expires: s, email: null } : s)) await this.store.delete(k);
    }
  }

  // ---------- Google sign-in ----------

  /** Step 1: hand back Google's sign-in address. `purpose: enable` (owner only) is how Google sign-in gets switched on. */
  async googleStart(b: Record<string, unknown>, origin: string, who: Principal | null) {
    const cfg = await this.config();
    const purpose = b.purpose === 'enable' ? 'enable' : 'login';
    if (purpose === 'enable' && who?.role !== 'owner') return fail(401, 'unauthorized', '只有擁有者可以啟用 Google 登入');
    if (purpose === 'login' && cfg.mode !== 'google') return fail(409, 'password_mode', '這台伺服器用管理員密碼登入');
    if (!cfg.google) return fail(409, 'no_client', '還沒有設定 Google 登入用的 OAuth 用戶端');
    if (!isStr(b.returnTo, 2000) || !isStr(b.challenge, 100)) throw new BadRequest('returnTo/challenge');
    const back = originOf(b.returnTo);
    if (!back) throw new BadRequest('returnTo');
    if (purpose === 'enable' && back !== origin && !cfg.returnOrigins.includes(back)) {
      // the owner is switching it on from this packer: it may receive sign-ins from now on
      cfg.returnOrigins = [...cfg.returnOrigins, back].slice(-20);
      await this.saveConfig(cfg);
    }
    if (back !== origin && !cfg.returnOrigins.includes(back)) {
      return fail(403, 'bad_origin', `這個打包器網址（${back}）不在允許的登入網址裡，請擁有者到「使用者」頁加入，或改從伺服器網址開啟打包器`);
    }
    const state = randomToken(24);
    const redirectUri = `${origin}/api/storage/google/callback`;
    await this.store.put<LoginState>(STATE + state, { returnTo: b.returnTo, challenge: b.challenge, purpose, redirectUri, expires: this.now() + STATE_MS });
    const q = new URLSearchParams({ client_id: cfg.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', prompt: 'select_account', state });
    return json({ ok: true, authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
  }

  async isLoginState(state: string | null): Promise<boolean> {
    return !!state && state.length < 100 && !!(await this.store.get(STATE + state));
  }

  /** Step 2: Google sends the browser back with a code; trade it for the e-mail, then return to the packer with a ticket. */
  async googleCallback(url: URL): Promise<Response> {
    const state = url.searchParams.get('state') ?? '';
    const st = await this.store.get<LoginState>(STATE + state);
    await this.store.delete(STATE + state);
    if (!st || st.expires < this.now()) return htmlPage('登入連結已過期', '請回到打包器重新按一次「用 Google 登入」。', false);
    const back = (hash: string) => new Response(null, { status: 302, headers: { location: `${st.returnTo.split('#')[0]}#${hash}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    const err = url.searchParams.get('error');
    if (err) return back(`vvlogin-error=${encodeURIComponent(err === 'access_denied' ? '你在 Google 的畫面按了取消' : `Google 回報：${err}`)}`);
    const cfg = await this.config();
    const code = url.searchParams.get('code');
    if (!code || !cfg.google) return back('vvlogin-error=' + encodeURIComponent('缺少授權資料，請再試一次'));
    let email: string;
    try {
      email = await this.exchange(cfg.google, code, st.redirectUri);
    } catch (e) {
      return back('vvlogin-error=' + encodeURIComponent((e as Error).message));
    }
    const u = await this.getUser(email);
    let allowed = st.purpose === 'enable' || (!!u && !u.disabled);
    if (!u && st.purpose === 'login') {
      if (cfg.access === 'any') allowed = true;
      if (cfg.access === 'domain' && cfg.domains.includes(email.split('@')[1])) allowed = true;
    }
    const ticket = randomToken(24);
    await this.store.put<Ticket>(TICKET + ticket, { email, allowed, purpose: st.purpose, challenge: st.challenge, expires: this.now() + TICKET_MS, attempts: 0 });
    return back(`vvlogin=${ticket}`);
  }

  private async exchange(client: { clientId: string; clientSecret: string }, code: string, redirectUri: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetcher(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
      });
    } catch {
      throw new Error('連不到 Google，請再試一次');
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (!res.ok || !data.id_token) {
      if (data.error === 'invalid_client') throw new Error('Google 不認得登入用的 OAuth 用戶端，請擁有者到「使用者」頁確認設定');
      throw new Error(`Google 登入失敗：${data.error_description ?? data.error ?? `HTTP ${res.status}`}`);
    }
    const c = idTokenClaims(data.id_token);
    const iss = String(c.iss ?? '');
    if (c.aud !== client.clientId || (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com')) throw new Error('Google 回傳的登入資料不正確');
    if (typeof c.exp === 'number' && c.exp * 1000 < this.now() - 60_000) throw new Error('Google 回傳的登入資料已過期，請再試一次');
    if (c.email_verified !== true || !isEmail(c.email)) throw new Error('這個 Google 帳號沒有已驗證的電子郵件');
    return normEmail(c.email);
  }

  private async openTicket(b: Record<string, unknown>): Promise<[string, Ticket] | Response> {
    if (!isStr(b.ticket, 100) || !isStr(b.verifier, 200)) throw new BadRequest('ticket/verifier');
    const t = await this.store.get<Ticket>(TICKET + b.ticket);
    if (!t || t.expires < this.now() || (await s256(b.verifier)) !== t.challenge) {
      return fail(401, 'ticket', '登入已逾時，請重新按「用 Google 登入」');
    }
    return [b.ticket, t];
  }

  /** Step 3: what the packer should ask for next. People signing in for the first time get a QR code to scan. */
  async ticket(b: Record<string, unknown>) {
    const r = await this.openTicket(b);
    if (r instanceof Response) return r;
    const [id, t] = r;
    const u = await this.getUser(t.email);
    if (t.allowed && !u?.totp) {
      t.enrollSecret ??= newTotpSecret();
      await this.store.put(TICKET + id, t);
      return json({ ok: true, next: 'enroll', email: t.email, secret: t.enrollSecret, otpauth: otpauthUrl(ISSUER, t.email, t.enrollSecret) });
    }
    return json({ ok: true, next: 'totp', email: t.email });
  }

  /** Step 4: the code from the authenticator app (or a recovery code). */
  async totp(b: Record<string, unknown>) {
    const r = await this.openTicket(b);
    if (r instanceof Response) return r;
    const [id, t] = r;
    if (!isStr(b.code, 40)) throw new BadRequest('請輸入驗證碼');
    t.attempts += 1;
    if (t.attempts >= TICKET_ATTEMPTS) await this.store.delete(TICKET + id);
    else await this.store.put(TICKET + id, t);
    if (!t.allowed) return fail(401, 'login_failed', FAILED);

    const now = this.now();
    const existing = await this.getUser(t.email);
    const cfg = await this.config();
    const u: UserRecord = existing ?? {
      email: t.email,
      role: t.purpose === 'enable' ? 'owner' : 'member',
      disabled: false,
      totp: null,
      lastStep: -1,
      recovery: [],
      failures: 0,
      lockUntil: 0,
      lockLevel: 0,
      createdAt: new Date(now).toISOString(),
      lastLoginAt: null,
      addedBy: t.purpose === 'enable' ? null : 'auto',
    };
    if (u.lockUntil > now) return fail(429, 'locked', `驗證碼錯太多次，請 ${Math.ceil((u.lockUntil - now) / 60000)} 分鐘後再試`);

    let recoveryCodes: string[] | undefined;
    let ok = false;
    if (!u.totp) {
      // first sign-in: the code proves the QR code was scanned correctly
      const step = t.enrollSecret ? await verifyTotp(t.enrollSecret, b.code, now) : null;
      if (step !== null) {
        u.totp = t.enrollSecret!;
        u.lastStep = step;
        recoveryCodes = newRecoveryCodes();
        u.recovery = await Promise.all(recoveryCodes.map((c) => sha256Hex(normaliseRecovery(c))));
        ok = true;
      }
    } else {
      const step = await verifyTotp(u.totp, b.code, now, u.lastStep);
      if (step !== null) {
        u.lastStep = step;
        ok = true;
      } else {
        const h = await sha256Hex(normaliseRecovery(b.code));
        if (normaliseRecovery(b.code).length === 8 && u.recovery.includes(h)) {
          u.recovery = u.recovery.filter((x) => x !== h);
          ok = true;
        }
      }
    }
    if (!ok) {
      u.failures += 1;
      if (u.failures >= USER_FAILURES) {
        u.failures = 0;
        u.lockLevel += 1;
        u.lockUntil = now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (u.lockLevel - 1));
      }
      if (existing) await this.saveUser(u); // nobody is created by wrong codes
      return fail(401, 'login_failed', FAILED);
    }

    await this.store.delete(TICKET + id);
    u.failures = 0;
    u.lockLevel = 0;
    u.lockUntil = 0;
    u.lastLoginAt = new Date(now).toISOString();
    if (t.purpose === 'enable') {
      u.role = 'owner';
      u.disabled = false;
    }
    await this.saveUser(u);
    const session = await this.issueSession({ email: u.email }, b.remember === true, u.role);
    if (t.purpose === 'enable') {
      cfg.mode = 'google';
      await this.saveConfig(cfg);
      // password logins stop counting now (the deploy-time password stays a spare key)
      await this.endSessions((s) => !s.email, session.token);
    }
    return json({ ok: true, ...session, recoveryCodes, enabled: t.purpose === 'enable' || undefined });
  }

  // ---------- owner settings ----------

  async adminView(me: Principal) {
    const cfg = await this.config();
    const now = this.now();
    return json({
      ok: true,
      mode: cfg.mode,
      access: cfg.access,
      domains: cfg.domains,
      returnOrigins: cfg.returnOrigins,
      google: cfg.google ? { clientId: cfg.google.clientId, hasSecret: !!cfg.google.clientSecret } : null,
      users: (await this.users()).map((u) => publicUser(u, now)),
      me,
    });
  }

  /** The OAuth client for signing in: typed in, or copied from a connected Google Drive. */
  async setGoogleClient(b: Record<string, unknown>, fromDrive: { clientId: string; clientSecret: string } | null) {
    const cfg = await this.config();
    const clientId = fromDrive?.clientId ?? (typeof b.clientId === 'string' ? b.clientId.trim() : '');
    const clientSecret = fromDrive?.clientSecret ?? (typeof b.clientSecret === 'string' && b.clientSecret.trim() ? b.clientSecret.trim() : cfg.google?.clientSecret ?? '');
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new BadRequest('Client ID 應該以 .apps.googleusercontent.com 結尾');
    if (!clientSecret) throw new BadRequest('請填用戶端密鑰');
    cfg.google = { clientId, clientSecret };
    await this.saveConfig(cfg);
    return json({ ok: true });
  }

  async patchConfig(b: Record<string, unknown>) {
    const cfg = await this.config();
    if (b.access !== undefined) {
      if (b.access !== 'list' && b.access !== 'domain' && b.access !== 'any') throw new BadRequest('access');
      cfg.access = b.access;
    }
    if (b.domains !== undefined) {
      if (!Array.isArray(b.domains) || b.domains.length > 50) throw new BadRequest('domains');
      const ds = b.domains.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
      const bad = ds.find((d) => !isDomain(d));
      if (bad) throw new BadRequest(`網域格式不正確：${bad}`);
      cfg.domains = [...new Set(ds)];
    }
    if (b.returnOrigins !== undefined) {
      if (!Array.isArray(b.returnOrigins) || b.returnOrigins.length > 20) throw new BadRequest('returnOrigins');
      const os = b.returnOrigins.map((o) => originOf(String(o).trim()));
      if (os.some((o) => !o)) throw new BadRequest('網址格式不正確（要以 https:// 開頭）');
      cfg.returnOrigins = [...new Set(os as string[])];
    }
    if (cfg.access === 'domain' && !cfg.domains.length) throw new BadRequest('「指定網域」至少要填一個網域');
    await this.saveConfig(cfg);
    return json({ ok: true });
  }

  /** Back to the admin password. People and their authenticators are kept for when it is switched on again. */
  async usePassword() {
    const cfg = await this.config();
    cfg.mode = 'password';
    await this.saveConfig(cfg);
    await this.endSessions((s) => !!s.email);
    return json({ ok: true });
  }

  private async activeOwners() {
    return (await this.users()).filter((u) => u.role === 'owner' && !u.disabled);
  }

  async addUser(b: Record<string, unknown>, me: Principal) {
    if (!isEmail(b.email)) throw new BadRequest('請輸入正確的 Google 帳號（電子郵件）');
    const email = normEmail(b.email);
    if (await this.getUser(email)) return fail(409, 'exists', `${email} 已經在名單裡`);
    const u: UserRecord = {
      email,
      role: b.role === 'owner' ? 'owner' : 'member',
      disabled: false,
      totp: null,
      lastStep: -1,
      recovery: [],
      failures: 0,
      lockUntil: 0,
      lockLevel: 0,
      createdAt: new Date(this.now()).toISOString(),
      lastLoginAt: null,
      addedBy: me.email,
    };
    await this.saveUser(u);
    return json({ ok: true, user: publicUser(u, this.now()) });
  }

  async patchUser(email: string, b: Record<string, unknown>, me: Principal) {
    const u = await this.getUser(email);
    if (!u) return fail(404, 'unknown', '找不到這個使用者');
    const losingOwner = u.role === 'owner' && !u.disabled && (b.role === 'member' || b.disabled === true);
    if (losingOwner && (await this.activeOwners()).length <= 1) return fail(409, 'last_owner', '至少要保留一位可以登入的擁有者');
    if (me.email === u.email && b.disabled === true) return fail(409, 'self', '不能停用自己');
    if (b.role === 'owner' || b.role === 'member') u.role = b.role;
    if (typeof b.disabled === 'boolean') u.disabled = b.disabled;
    if (b.resetTotp === true) {
      // they scan a new QR code at their next sign-in
      u.totp = null;
      u.lastStep = -1;
      u.recovery = [];
    }
    if (b.unlock === true) {
      u.lockUntil = 0;
      u.failures = 0;
      u.lockLevel = 0;
    }
    await this.saveUser(u);
    if (u.disabled || b.resetTotp === true) await this.endSessions((s) => s.email === u.email);
    return json({ ok: true, user: publicUser(u, this.now()) });
  }

  async removeUser(email: string, me: Principal) {
    const u = await this.getUser(email);
    if (!u) return fail(404, 'unknown', '找不到這個使用者');
    if (me.email === u.email) return fail(409, 'self', '不能移除自己');
    if (u.role === 'owner' && !u.disabled && (await this.activeOwners()).length <= 1) return fail(409, 'last_owner', '至少要保留一位可以登入的擁有者');
    await this.store.delete(USER + u.email);
    await this.endSessions((s) => s.email === u.email);
    return json({ ok: true });
  }

  /** New recovery codes for the person signed in (the old ones stop working). */
  async newRecovery(me: Principal) {
    if (!me.email) return fail(409, 'password', '用密碼登入時沒有備用碼');
    const u = await this.getUser(me.email);
    if (!u?.totp) return fail(409, 'no_totp', '還沒有綁定驗證器');
    const codes = newRecoveryCodes();
    u.recovery = await Promise.all(codes.map((c) => sha256Hex(normaliseRecovery(c))));
    await this.saveUser(u);
    return json({ ok: true, recoveryCodes: codes });
  }
}
