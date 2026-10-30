import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { randomBytes, toB64 } from '../../src/core/bytes';
import { keyToText } from '../../src/core/keytext';
import { buildVault, renderVaultHtml, DEFAULT_POLICY, DEFAULT_PROTECTION, type BuildOptions } from '../../src/core/format';
import { sampleFiles, startHub } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = process.env.E2E_OUT ?? join(process.cwd(), 'test-results');
const TEMPLATE = readFileSync('src/generated/viewer-template.html', 'utf8');
const FAST_KDF = { alg: 'argon2id' as const, m: 8192, t: 1, p: 1 };

let browser: Browser;
let hub: Awaited<ReturnType<typeof startHub>>;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  hub = await startHub();
});
afterAll(async () => {
  await browser?.close();
  hub?.server.close();
});

async function makeVault(name: string, over: Partial<BuildOptions>) {
  const keyfile = randomBytes(32);
  const o: BuildOptions = {
    title: '測試封存', recipient: '王小明', batchId: 'b1', mode: 'offline', server: null,
    policy: DEFAULT_POLICY, protection: DEFAULT_PROTECTION, password: 'abcd-efgh-jkmn', keyfile, serverShare: null, kdf: FAST_KDF, ...over,
  };
  const v = await buildVault(sampleFiles(), o);
  const path = join(OUT, `${name}.vault.html`);
  writeFileSync(path, renderVaultHtml(TEMPLATE, v.header, v.blobParts).join(''));
  return { path, key: keyToText(keyfile), v, o };
}

async function openPage(path: string, context?: import('playwright').BrowserContext): Promise<Page> {
  const page = await (context ?? browser).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.text()); });
  (page as Page & { errors: string[] }).errors = errors;
  await page.goto(`file://${path}`);
  return page;
}

async function unlock(page: Page, password: string, key: string) {
  await page.fill('input[type=password]', password);
  if (await page.locator('textarea').count()) await page.fill('textarea', key);
  await page.click('button[type=submit]');
}

describe('viewer (offline)', () => {
  it('unlocks, browses and previews files', async () => {
    const { path, key } = await makeVault('offline', { policy: { ...DEFAULT_POLICY, maxOpens: 5 } });
    const page = await openPage(path);
    await expect(page.title()).resolves.toBe('測試封存');
    await page.fill('textarea', key.toLowerCase());
    await expect(page.locator('.hint.ok').textContent()).resolves.toContain('金鑰格式正確');

    await unlock(page, 'wrong-pass', key);
    await page.waitForSelector('.error:has-text("密碼或金鑰不正確")');

    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    await expect(page.locator('.topbar').textContent()).resolves.toContain('剩餘 4 次');

    await page.click('.file:has-text("備註.txt")');
    await page.waitForSelector('pre.code:has-text("secret-text")');

    await page.click('.file:has-text("說明.md")');
    await page.waitForSelector('article.doc table');
    expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked)).toBeUndefined();

    await page.click('.file:has-text("red.png")');
    await page.waitForSelector('.media img');

    await page.click('.file:has-text("報價單.pdf")');
    await page.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
    await expect(page.locator('.watermark').evaluate((el) => getComputedStyle(el).backgroundImage)).resolves.toContain('svg');
    await page.screenshot({ path: join(OUT, 'offline-pdf.png') });

    await page.fill('input[type=search]', 'png');
    await expect(page.locator('.tree .file').count()).resolves.toBe(1);

    await page.click('button:has-text("上鎖")');
    await page.waitForSelector('text=金鑰已載入');
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    await expect(page.locator('.topbar').textContent()).resolves.toContain('剩餘 4 次'); // same page: not counted again
    expect((page as Page & { errors: string[] }).errors).toEqual([]);
    await page.close();
  });

  it('enforces the open limit and lockout locally', async () => {
    const { path, key } = await makeVault('limit', { policy: { ...DEFAULT_POLICY, maxOpens: 1, maxFailures: 2 } });
    const ctx = await browser.newContext();
    const p1 = await openPage(path, ctx);
    await unlock(p1, 'abcd-efgh-jkmn', key);
    await p1.waitForSelector('.tree');
    await p1.close();
    const p2 = await openPage(path, ctx);
    await unlock(p2, 'abcd-efgh-jkmn', key);
    await p2.waitForSelector('.error:has-text("次數已用完")');
    await p2.close();
    // wrong attempts lock the vault on this device
    const { path: path2, key: key2 } = await makeVault('lockout', { policy: { ...DEFAULT_POLICY, maxFailures: 2 } });
    const p3 = await openPage(path2, ctx);
    await unlock(p3, 'bad-1', key2);
    await p3.waitForSelector('.error:has-text("還可以再試 1 次")');
    await unlock(p3, 'bad-2', key2);
    await p3.waitForSelector('.error:has-text("已鎖定")');
    await expect(p3.locator('button[type=submit]').isDisabled()).resolves.toBe(true);
    await ctx.close();
  });
});

describe('viewer (online)', () => {
  it('opens through the server, counts opens and honours revocation', async () => {
    const share = randomBytes(32);
    const { path, key, v } = await makeVault('online', {
      mode: 'online', server: hub.url, serverShare: share,
      policy: { ...DEFAULT_POLICY, maxOpens: 2, sessionMinutes: 30 },
      protection: { ...DEFAULT_PROTECTION, watermark: { ...DEFAULT_PROTECTION.watermark, text: '{收件人} {IP} {地區} {編號}' } },
    });
    const login = await (await fetch(`${hub.url}/api/admin/login`, { method: 'POST', body: JSON.stringify({ password: 'admin-pass-123' }) })).json();
    const auth = { authorization: `Bearer ${login.token}` };
    const reg = await fetch(`${hub.url}/api/admin/vaults`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ vaults: [{ id: v.header.id, batchId: 'b1', title: '測試封存', recipient: '王小明', authKey: toB64(v.authKey), share: toB64(share), policy: { maxOpens: 2, maxFailures: 5, sessionMinutes: 30 } }] }),
    });
    expect(reg.status).toBe(200);

    const page = await openPage(path);
    await expect(page.locator('.chip').first().textContent()).resolves.toContain('線上驗證');
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    await expect(page.locator('.topbar').textContent()).resolves.toContain('剩餘 1 次');
    // the watermark carries the address the server saw and a code that the server logged
    const mark = decodeURIComponent(await page.locator('.watermark').evaluate((el) => getComputedStyle(el).backgroundImage));
    const code = mark.match(/王小明 127\.0\.0\.1 TW ([A-Z2-9]{6})/)?.[1];
    expect(code).toBeTruthy();
    const logs = await (await fetch(`${hub.url}/api/admin/vaults/${v.header.id}/logs`, { headers: auth })).json();
    expect(logs.logs[0]).toMatchObject({ ev: 'open', tag: code, ip: '127.0.0.1', country: 'TW' });
    await page.click('.file:has-text("備註.txt")');
    await page.waitForSelector('pre.code');
    // re-lock + unlock inside the session does not use another open
    await page.click('button:has-text("上鎖")');
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    await expect(page.locator('.topbar').textContent()).resolves.toContain('剩餘 1 次');
    await page.close();

    await fetch(`${hub.url}/api/admin/vaults/${v.header.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ revoked: true }) });
    const p2 = await openPage(path);
    await unlock(p2, 'abcd-efgh-jkmn', key);
    await p2.waitForSelector('.error:has-text("收回")');
    await p2.screenshot({ path: join(OUT, 'online-revoked.png') });
    await p2.close();
  });

  it('works from the hosted open page too', async () => {
    const { path, key } = await makeVault('hosted', {});
    const page = await openPage(join(process.cwd(), 'dist-viewer/open.html'));
    await page.setInputFiles('input[type=file]', path);
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    await page.close();
  });
});
