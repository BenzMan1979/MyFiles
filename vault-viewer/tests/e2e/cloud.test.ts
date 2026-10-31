import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { fakeWebdav } from '../fakeClouds';
import { sampleFiles, startSite } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = join(process.env.E2E_OUT ?? join(process.cwd(), 'test-results'), 'cloud');
let browser: Browser;
let site: Awaited<ReturnType<typeof startSite>>;
const dav = fakeWebdav({ base: 'https://nc.test/remote.php/dav/files/ben' });

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  // small parts, so the vault is split over several files in the cloud
  site = await startSite('cloud-admin-pass', { fetcher: dav.fetch as typeof fetch, partBytes: 4096 });
});
afterAll(async () => {
  await browser?.close();
  site?.server.close();
});

const newPage = async (url: string, width = 1280): Promise<Page> => {
  const p = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
  p.on('pageerror', (e) => { throw e; });
  await p.goto(url);
  return p;
};
const shot = (p: Page, name: string) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

let link = '';
let password = '';
let keyText = '';

describe('cloud links: packer → Nextcloud (WebDAV) → recipient opens the link', () => {
  let p: Page;

  it('connects a Nextcloud from the cloud page (settings are tested first)', async () => {
    p = await newPage(`${site.url}/#servers`);
    await p.waitForSelector('.server-card');
    await p.click('.server-card button:has-text("登入")');
    await p.fill('dialog input[type=password]', 'cloud-admin-pass');
    await p.click('dialog button:has-text("登入")');
    await p.waitForSelector('.server-card:has-text("管理員已登入")');
    // reached from the server's own card once logged in
    await p.click('.server-card a:has-text("雲端空間")');
    await p.waitForSelector('text=還沒有連結任何雲端空間');
    await p.click('button:has-text("Nextcloud／WebDAV")');
    const field = (label: string) => p.locator(`dialog .field:has(label:text-is("${label}")) input`);
    await field('名稱').fill('家裡的 Nextcloud');
    await field('Nextcloud 網址').fill('https://nc.test');
    await field('帳號').fill('ben');
    await field('密碼（應用程式密碼）').fill('wrong');
    await expect(p.locator('dialog .hint.mono').textContent()).resolves.toContain('https://nc.test/remote.php/dav/files/ben/');
    await p.click('dialog button:has-text("測試並儲存")');
    await p.waitForSelector('dialog .error:has-text("應用程式密碼")');
    await field('密碼（應用程式密碼）').fill('app-pass');
    await p.click('dialog button:has-text("測試並儲存")');
    await p.waitForSelector('.server-card:has-text("家裡的 Nextcloud"):has-text("已連結")');
    await shot(p, '01-cloud-page');
  });

  it('guides through Google Drive and R2 (redirect address to copy, presets fill in the endpoint)', async () => {
    await p.click('button:has-text("＋ Google Drive")');
    await p.waitForSelector(`dialog .mono:text-is("${site.url}/api/storage/google/callback")`);
    const guide = (await p.locator('dialog').textContent())!;
    // the addresses to type into Google Cloud are filled in from this server
    expect(guide).toContain(`${site.url}/privacy.html`);
    expect(guide).toContain('實際運作中');
    expect(guide).toContain('啟用 Google Drive API');
    await shot(p, '01b-google-dialog');
    await p.click('dialog button:has-text("取消")');
    await p.click('button:has-text("Cloudflare R2／S3")');
    await p.locator('dialog .field:has(label:text-is("Cloudflare 帳戶 ID")) input').fill('0123456789abcdef0123456789abcdef');
    await expect(p.locator('dialog .field:has(label:text-is("區域（Region）"))').isVisible()).resolves.toBe(false);
    await shot(p, '01c-r2-dialog');
    await p.click('dialog button:has-text("取消")');
  });

  it('creates a vault delivered as a cloud link', async () => {
    await p.click('.app-nav a:has-text("建立封存檔")');
    const files = await Promise.all(sampleFiles().map(async (f) => ({ name: f.path.split('/').pop()!, mimeType: f.mime, buffer: Buffer.from(await f.read()) })));
    // make it span several 4 KB parts
    files.push({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.from('雲端內容 cloud-secret\n'.repeat(1500)) });
    await p.setInputFiles('input[type=file][multiple]:not([webkitdirectory])', files);
    await p.waitForSelector('.file-row');
    await p.click('button:has-text("下一步")');
    await p.fill('input[maxlength="100"]', '雲端合約');
    await p.click('.choice:has-text("雲端連結")');
    await p.waitForSelector('.cloud-picker select');
    await expect(p.locator('.cloud-picker select').textContent()).resolves.toContain('家裡的 Nextcloud');
    await shot(p, '02-delivery');
    for (let i = 0; i < 3; i++) await p.click('button:has-text("下一步")');
    await p.fill('input[placeholder^="收件人名稱"]', '王小明');
    await p.click('button:has-text("確認並產生")');
    await expect(p.locator('.summary').textContent()).resolves.toContain('雲端連結（家裡的 Nextcloud）');
    await p.click('button:has-text("開始加密")');
    await p.waitForSelector('text=封存檔已產生', { timeout: 60_000 });
    link = (await p.locator('.result-card a.link-out').getAttribute('href'))!;
    expect(link).toMatch(new RegExp(`^${site.url}/v/[a-z0-9]+$`));
    const monos = await p.locator('.result-card .copy-line .mono').allTextContents();
    [, password, keyText] = monos;
    expect(keyText).toMatch(/^VK1-/);
    // no .vault.html to download: the vault lives in the cloud
    await expect(p.locator('.result-card button:has-text("封存檔")').count()).resolves.toBe(0);
    await shot(p, '03-result');

    // the cloud only holds ciphertext, split into parts
    const id = link.split('/').pop()!;
    const parts = [...dav.files.entries()].filter(([k]) => k.includes(`/${id}/`));
    expect(parts.length).toBeGreaterThan(3);
    for (const [, data] of parts) expect(Buffer.from(data).toString('utf8')).not.toContain('cloud-secret');
  });

  it('the recipient opens the link on a phone and reads the files', async () => {
    const v = await newPage(link, 390);
    await v.waitForSelector('text=雲端連結');
    await v.fill('input[type=password]', password);
    await v.fill('textarea', keyText);
    await v.click('button[type=submit]');
    await v.waitForSelector('.tree');
    await v.click('button:has-text("檔案")');
    await v.click('.file:has-text("big.txt")');
    await v.waitForSelector('.preview :text("cloud-secret")');
    await v.click('button:has-text("檔案")');
    await v.click('.file:has-text("報價單.pdf")');
    await v.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
    await shot(v, '04-phone-viewer');
    await v.close();
  });

  it('revoking stops the link; deleting removes the files from the cloud', async () => {
    await p.click('.app-nav a:has-text("管理封存檔")');
    await p.waitForSelector('tr:has-text("王小明")');
    await expect(p.locator('tr:has-text("王小明") .chip:has-text("☁️")').count()).resolves.toBe(1);
    await p.click('tr:has-text("王小明") button:has-text("收回")');
    await p.click('dialog button:has-text("收回")');
    await p.waitForSelector('tr:has-text("王小明") .chip:has-text("已收回")');

    const v = await newPage(link);
    await v.fill('input[type=password]', password);
    await v.fill('textarea', keyText);
    await v.click('button[type=submit]');
    await v.waitForSelector('.error:has-text("收回")');
    await v.close();

    const id = link.split('/').pop()!;
    await p.click('tr:has-text("王小明") button[title="從伺服器刪除"]');
    await p.click('dialog button:has-text("永久刪除")');
    await p.waitForSelector('text=這台伺服器上還沒有封存檔');
    expect([...dav.files.keys()].filter((k) => k.includes(`/${id}/`))).toEqual([]);

    const gone = await newPage(link);
    await gone.waitForSelector('.error:has-text("找不到")');
    await gone.close();
    await p.close();
  });
});
