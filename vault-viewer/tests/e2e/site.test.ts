import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { randomBytes, toB64 } from '../../src/core/bytes';
import { keyToText } from '../../src/core/keytext';
import { buildVault, renderVaultHtml, DEFAULT_POLICY, DEFAULT_PROTECTION } from '../../src/core/format';
import { sampleFiles, startSite } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = join(process.env.E2E_OUT ?? join(process.cwd(), 'test-results'), 'site');
let browser: Browser;
let site: Awaited<ReturnType<typeof startSite>>;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  site = await startSite('site-admin-pass');
});
afterAll(async () => {
  await browser?.close();
  site?.server.close();
});

const open = async (url: string): Promise<Page> => {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  p.on('pageerror', (e) => { throw e; });
  p.on('dialog', (d) => d.accept());
  await p.goto(url);
  return p;
};

describe('packer served by the server itself (one address for pages and API)', () => {
  it('adds its own server by itself, so only the admin login is left', async () => {
    const p = await open(`${site.url}/#servers`);
    await p.waitForSelector('.server-card');
    await expect(p.locator('.server-card').textContent()).resolves.toContain(site.url.replace('http://', ''));
    await expect(p.locator('.server-card').textContent()).resolves.toContain('管理員未登入');
    await p.click('.server-card button:has-text("登入")');
    await p.fill('dialog input[type=password]', 'wrong');
    await p.click('dialog button:has-text("登入")');
    await p.waitForSelector('dialog .error:has-text("不正確")');
    await p.fill('dialog input[type=password]', 'site-admin-pass');
    await p.click('dialog button:has-text("登入")');
    await p.waitForSelector('.server-card:has-text("管理員已登入")');
    await p.screenshot({ path: join(OUT, 'own-server.png') });
    // the phone link is this very site
    await p.click('.app-nav a:has-text("使用說明")');
    await p.waitForSelector(`a[href="${site.url}/open.html"]`);
    // removing it on purpose keeps it removed after a reload
    await p.click('.app-nav a:has-text("伺服器設定")');
    await p.click('.server-card button:has-text("移除")');
    await p.click('dialog button:has-text("移除")');
    await p.reload();
    await p.waitForSelector('.wizard, .section.here');
    await expect(p.locator('.server-card').count()).resolves.toBe(0);
    await p.close();
  });

  it('still offers the setup card when the server has no admin password yet', async () => {
    const fresh = await startSite('');
    const p = await open(`${fresh.url}/#servers`);
    await p.waitForSelector('text=這個網站本身就是你的伺服器');
    await expect(p.locator('.server-card').count()).resolves.toBe(0);
    await p.close();
    fresh.server.close();
  });

  it('opens a vault on the same site /open.html, as a phone would', async () => {
    const keyfile = randomBytes(32);
    const share = randomBytes(32);
    const built = await buildVault(sampleFiles(), {
      title: '同站測試', recipient: '手機使用者', batchId: 'b', mode: 'online', server: site.url, policy: { ...DEFAULT_POLICY, maxOpens: 3 },
      protection: DEFAULT_PROTECTION, password: 'abcd-efgh-jkmn', keyfile, serverShare: share, kdf: { alg: 'argon2id', m: 8192, t: 1, p: 1 },
    });
    const login = await (await fetch(`${site.url}/api/admin/login`, { method: 'POST', body: JSON.stringify({ password: 'site-admin-pass' }) })).json();
    const reg = await fetch(`${site.url}/api/admin/vaults`, {
      method: 'POST', headers: { authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ vaults: [{ id: built.header.id, batchId: 'b', title: '同站測試', recipient: '手機使用者', authKey: toB64(built.authKey), share: toB64(share), policy: { maxOpens: 3, maxFailures: 5, sessionMinutes: 30 } }] }),
    });
    expect(reg.status).toBe(200);
    const html = renderVaultHtml(readFileSync('src/generated/viewer-template.html', 'utf8'), built.header, built.blobParts).join('');
    const p = await open(`${site.url}/open.html`);
    await p.setInputFiles('input[type=file]', { name: '同站測試.vault.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    await p.fill('input[type=password]', 'abcd-efgh-jkmn');
    await p.fill('textarea', keyToText(keyfile));
    await p.click('button[type=submit]');
    await p.waitForSelector('.tree');
    await expect(p.locator('.topbar').textContent()).resolves.toContain('剩餘 2 次');
    await p.close();
  });

  it('serves the pages with the security headers file in place', () => {
    expect(readFileSync('dist/_headers', 'utf8')).toMatch(/X-Frame-Options: DENY/);
  });
});

describe('deployer settings baked into the built pages', () => {
  const dist = readFileSync('dist/index.html', 'utf8');
  const withSettings = (name: string, settings: object) => {
    // the build always writes one settings block; swap its content the way a deployer's build would
    const html = dist.replace(/(<script type="application\/json" id="vv-settings">)[^<]*(<\/script>)/, `$1${JSON.stringify(settings)}$2`);
    expect(html).not.toBe(dist);
    expect(dist).toContain('id="vv-settings"');
    const path = join(OUT, `${name}.html`);
    writeFileSync(path, html);
    return `file://${path}`;
  };

  it('uses the configured name, links, limits and defaults', async () => {
    const url = withSettings('custom', {
      appName: '我的密閱', workerName: 'mine', projectDir: 'apps/vault',
      links: { deployRepo: 'https://github.com/x/y/tree/main/vault-viewer', cloudflareSignup: 'https://example.com/signup' },
      limits: { maxTotalMB: 1, minPasswordLength: 10 },
      defaults: { expiryDays: null, maxFailures: 3, watermark: { text: '{收件人} 機密', size: 30, density: 5 } },
    });
    const p = await open(`${url}#servers`);
    await expect(p.locator('.app-brand').textContent()).resolves.toContain('我的密閱');
    await expect(p.title()).resolves.toContain('我的密閱');
    await expect(p.locator('a:has-text("部署到 Cloudflare")').getAttribute('href')).resolves.toBe('https://deploy.workers.cloudflare.com/?url=https://github.com/x/y/tree/main/vault-viewer');
    await expect(p.locator('a:has-text("開啟 Cloudflare 註冊頁")').getAttribute('href')).resolves.toBe('https://example.com/signup');
    await expect(p.locator('input[placeholder*="mine."]').count()).resolves.toBe(1);
    // the private-repo route names the configured worker and folder
    await p.click('summary:has-text("私有 repo")');
    await expect(p.locator('details.more:has(summary:has-text("私有 repo")) code').allTextContents()).resolves.toEqual(expect.arrayContaining(['mine', 'apps/vault', 'npm run build', 'npx wrangler deploy', 'ADMIN_PASSWORD']));

    await p.click('.app-nav a:has-text("建立封存檔")');
    await p.setInputFiles('input[type=file][multiple]:not([webkitdirectory])', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024) });
    await p.waitForSelector('.file-row');
    await expect(p.locator('.note.warn').textContent()).resolves.toContain('超過 1MB');
    await p.click('button:has-text("下一步")');
    await p.click('.choice:has-text("離線")');
    await p.click('button:has-text("下一步")');
    await expect(p.locator('.seg button.on').first().textContent()).resolves.toBe('不限期'); // expiryDays: null
    await expect(p.locator('input[type=number] >> nth=-1').inputValue()).resolves.toBe('3'); // max wrong attempts
    await p.click('button:has-text("下一步")');
    expect(await p.evaluate(() => Array.from(document.querySelectorAll('input')).some((i) => i.value === '{收件人} 機密'))).toBe(true);
    await expect(p.locator('input[data-wm=size]').inputValue()).resolves.toBe('30');
    await expect(p.locator('input[data-wm=density]').inputValue()).resolves.toBe('5');
    await p.close();
  });

  it('shows no deploy button when no repo is configured, and still works', async () => {
    const p = await open(`${withSettings('plain', {})}#servers`);
    await expect(p.locator('a:has-text("部署到 Cloudflare")').count()).resolves.toBe(0);
    await expect(p.locator('.step:has-text("取得伺服器網址")').count()).resolves.toBe(1);
    await expect(p.locator('.step:has-text("取得伺服器網址") summary:has-text("私有 repo")').count()).resolves.toBe(1);
    await expect(p.locator('.app-brand').textContent()).resolves.toContain('隨身密閱');
    await p.close();
  });

  it('ignores a broken settings block instead of failing', async () => {
    const html = dist.replace(/(<script type="application\/json" id="vv-settings">)[^<]*(<\/script>)/, '$1{oops$2');
    const path = join(OUT, 'broken.html');
    writeFileSync(path, html);
    const p = await open(`file://${path}#home`);
    await expect(p.locator('.app-brand').textContent()).resolves.toContain('隨身密閱');
    await p.close();
  });
});
