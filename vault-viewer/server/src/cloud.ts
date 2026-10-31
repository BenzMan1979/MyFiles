// The admin's cloud storage profiles: adding, testing, removing, choosing the default, and the
// Google sign-in. Stored next to the vaults in the Durable Object; secrets never leave the server.

import { BadRequest, fail, htmlPage, isStr, json, randomToken, type Store } from './common';
import {
  googleAuthUrl,
  googleExchange,
  gdriveAdapter,
  isStorageType,
  makeAdapter,
  mergeConfig,
  publicProfile,
  StorageError,
  type Adapter,
  type AdapterDeps,
  type StorageProfile,
} from './storage';

const PROFILE = 'storage:';
const DEFAULT_KEY = 'cfg:storageDefault';
const GAUTH = 'gauth:';
const GAUTH_MS = 15 * 60 * 1000;
export const GOOGLE_CALLBACK = '/api/storage/google/callback';

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

const newId = () => randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

export class Clouds {
  constructor(
    private store: Store,
    private fetcher: typeof fetch,
    private now: () => number,
  ) {}

  get(id: string) {
    return this.store.get<StorageProfile>(PROFILE + id);
  }

  async list(): Promise<StorageProfile[]> {
    return [...(await this.store.list<StorageProfile>({ prefix: PROFILE })).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async save(p: StorageProfile) {
    await this.store.put(PROFILE + p.id, p);
  }

  private deps(p: StorageProfile): AdapterDeps {
    return {
      fetch: this.fetcher,
      now: this.now,
      saveState: async (state) => {
        // re-read, so a token refresh does not overwrite settings changed meanwhile
        const cur = await this.get(p.id);
        if (cur) await this.save({ ...cur, state: { ...cur.state, ...state } });
      },
    };
  }

  adapter(p: StorageProfile): Adapter {
    return makeAdapter(p, this.deps(p));
  }

  /** Runs `fn` with the profile's adapter and stores whatever the adapter changed in its settings (e.g. a re-created folder). */
  async withAdapter<T>(p: StorageProfile, fn: (a: Adapter) => Promise<T>): Promise<T> {
    const before = JSON.stringify([p.config, p.state.account]);
    const result = await fn(this.adapter(p));
    if (JSON.stringify([p.config, p.state.account]) !== before) {
      const cur = await this.get(p.id);
      if (cur) await this.save({ ...cur, config: p.config, state: { ...cur.state, account: p.state.account } });
    }
    return result;
  }

  async defaultId(): Promise<string> {
    const id = (await this.store.get<string>(DEFAULT_KEY)) ?? '';
    if (id && (await this.get(id))) return id;
    const first = (await this.list()).find((p) => p.status === 'ready');
    return first?.id ?? '';
  }

  // ---------- admin API ----------

  async adminList(usage: Map<string, number>, origin: string) {
    const def = await this.defaultId();
    return json({
      ok: true,
      profiles: (await this.list()).map((p) => publicProfile(p, p.id === def, usage.get(p.id) ?? 0)),
      googleRedirectUri: origin + GOOGLE_CALLBACK,
    });
  }

  /** Adds or edits a WebDAV / S3 profile (tested before it is saved), or renames a Google one. */
  async adminSave(b: Record<string, unknown>) {
    const old = isStr(b.id, 40) ? await this.get(b.id) : undefined;
    if (isStr(b.id, 40) && !old) return fail(404, 'unknown', '找不到這個雲端空間');
    const type = old?.type ?? b.type;
    if (!isStorageType(type)) throw new BadRequest('type');
    const name = isStr(b.name, 80) ? b.name.trim() : old?.name ?? '';
    if (!name) throw new BadRequest('請幫這個雲端空間取個名字');
    if (type === 'gdrive') {
      if (!old) throw new BadRequest('Google Drive 請用「連結 Google Drive」新增');
      const cfg = b.config as Record<string, unknown> | undefined;
      const folderName = typeof cfg?.folderName === 'string' ? cfg.folderName.trim().slice(0, 100) : old.config.folderName;
      await this.save({ ...old, name, config: { ...old.config, folderName: folderName || old.config.folderName } });
      return json({ ok: true, id: old.id });
    }
    const p: StorageProfile = {
      id: old?.id ?? newId(),
      type,
      name,
      createdAt: old?.createdAt ?? new Date(this.now()).toISOString(),
      config: mergeConfig(type, b.config, old?.config),
      state: {},
      status: 'ready',
    };
    const description = await this.adapter(p).test();
    p.state.account = `${type === 'webdav' ? p.config.username : p.config.bucket} @ ${hostOf(type === 'webdav' ? p.config.url : p.config.endpoint)}`;
    await this.save(p);
    if (!(await this.store.get(DEFAULT_KEY))) await this.store.put(DEFAULT_KEY, p.id);
    return json({ ok: true, id: p.id, message: description });
  }

  async adminTest(id: string) {
    const p = await this.get(id);
    if (!p) return fail(404, 'unknown', '找不到這個雲端空間');
    if (p.status !== 'ready') return fail(409, 'pending', '還沒有完成 Google 授權');
    const description = await this.withAdapter(p, (a) => a.test());
    return json({ ok: true, message: description });
  }

  async adminRemove(id: string, inUse: number) {
    const p = await this.get(id);
    if (!p) return fail(404, 'unknown', '找不到這個雲端空間');
    if (inUse > 0) return fail(409, 'in_use', `還有 ${inUse} 份封存檔放在「${p.name}」，請先到「管理封存檔」刪除它們，再移除這個雲端空間`);
    await this.store.delete(PROFILE + id);
    if ((await this.store.get(DEFAULT_KEY)) === id) await this.store.delete(DEFAULT_KEY);
    return json({ ok: true });
  }

  async adminSetDefault(id: string) {
    const p = await this.get(id);
    if (!p) return fail(404, 'unknown', '找不到這個雲端空間');
    await this.store.put(DEFAULT_KEY, id);
    return json({ ok: true });
  }

  /** Step 1 of connecting Google Drive: remember the client, hand back Google's sign-in address. */
  async googleStart(b: Record<string, unknown>, origin: string) {
    const old = isStr(b.id, 40) ? await this.get(b.id) : undefined;
    if (isStr(b.id, 40) && (!old || old.type !== 'gdrive')) return fail(404, 'unknown', '找不到這個 Google Drive 雲端空間');
    const config = mergeConfig('gdrive', { clientId: b.clientId, clientSecret: b.clientSecret, folderName: b.folderName }, old?.config);
    if (!/\.apps\.googleusercontent\.com$/.test(config.clientId)) throw new BadRequest('Client ID 應該以 .apps.googleusercontent.com 結尾，請確認有完整貼上');
    const name = isStr(b.name, 80) ? b.name.trim() : old?.name || 'Google Drive';
    const p: StorageProfile = old
      ? { ...old, name, config: { ...old.config, ...config } }
      : { id: newId(), type: 'gdrive', name, createdAt: new Date(this.now()).toISOString(), config: { folderName: '隨身密閱', ...config }, state: {}, status: 'pending' };
    await this.save(p);
    const state = randomToken(24);
    const redirectUri = origin + GOOGLE_CALLBACK;
    await this.store.put(GAUTH + state, { profileId: p.id, redirectUri, expires: this.now() + GAUTH_MS });
    return json({ ok: true, id: p.id, authUrl: googleAuthUrl(config.clientId, redirectUri, state), redirectUri, startedAt: new Date(this.now()).toISOString() });
  }

  /** Step 2: Google sends the admin's browser back here with a one-time code. */
  async googleCallback(url: URL): Promise<Response> {
    const state = url.searchParams.get('state') ?? '';
    const pending = state.length > 10 && state.length < 100 ? await this.store.get<{ profileId: string; redirectUri: string; expires: number }>(GAUTH + state) : undefined;
    if (pending) await this.store.delete(GAUTH + state);
    if (!pending || pending.expires < this.now()) return htmlPage('連結失敗', '這個授權連結已經過期或用過了。請回到打包器的「雲端空間」重新按一次「連結 Google Drive」。', false);
    const err = url.searchParams.get('error');
    if (err) return htmlPage('沒有完成授權', err === 'access_denied' ? '你在 Google 的畫面按了取消。需要時可以回到打包器再連結一次。' : `Google 回報：${err}`, false);
    const code = url.searchParams.get('code');
    const p = await this.get(pending.profileId);
    if (!code || !p) return htmlPage('連結失敗', '缺少授權資料，請回到打包器重新連結。', false);
    try {
      const t = await googleExchange(this.deps(p), { clientId: p.config.clientId, clientSecret: p.config.clientSecret, code, redirectUri: pending.redirectUri });
      p.config.refreshToken = t.refreshToken;
      p.state = { accessToken: t.accessToken, accessExpires: t.accessExpires, connectedAt: new Date(this.now()).toISOString() };
      const a = gdriveAdapter(p, this.deps(p));
      await a.ensureFolder();
      await a.describe(); // fills in the account's address
      p.status = 'ready';
      await this.save(p);
      if (!(await this.store.get(DEFAULT_KEY))) await this.store.put(DEFAULT_KEY, p.id);
      return htmlPage('✅ 已連結 Google Drive', `「${p.name}」已連結到 ${p.state.account}。可以關閉這個分頁，回到打包器繼續。`, true);
    } catch (e) {
      return htmlPage('連結失敗', e instanceof StorageError ? e.message : `發生錯誤：${(e as Error).message}`, false);
    }
  }
}
