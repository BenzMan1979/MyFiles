import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { base32Decode, totpAt } from '../../server/src/totp';
import { fakeGoogle, routeFetch } from '../fakeClouds';
import { startSite } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = join(process.env.E2E_OUT ?? join(process.cwd(), 'test-results'), 'login');
let browser: Browser;
let site: Awaited<ReturnType<typeof startSite>>;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  site = await startSite('deploy-pass-123', { fetcher: routeFetch(fakeGoogle()) as typeof fetch });
});
afterAll(async () => {
  await browser?.close();
  site?.server.close();
});

/** A browser (own storage) where "Google" signs in as `email`: its sign-in page sends straight back with a code. */
async function asGoogleUser(email: string, url = `${site.url}/`): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('https://accounts.google.com/**', (route) => {
    const u = new URL(route.request().url());
    const back = `${u.searchParams.get('redirect_uri')}?state=${u.searchParams.get('state')}&code=${encodeURIComponent(`login:${email}`)}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { throw e; });
  await p.goto(url);
  return p;
}
const shot = (p: Page, name: string) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const codeFor = async (secret: string) => totpAt(base32Decode(secret.replace(/\s/g, '')), Math.floor(Date.now() / 30000));

/** The authenticator step: scan (read the key off the screen) and type the code. */
async function enroll(p: Page): Promise<string> {
  await p.waitForSelector('dialog .enroll-qr');
  const secret = (await p.locator('dialog .enroll-qr .key').textContent())!;
  await p.fill('dialog .code-input', await codeFor(secret));
  await p.click('dialog button:has-text("登入")');
  await p.waitForSelector('dialog:has-text("請保存備用碼")');
  await expect(p.locator('dialog .recovery-codes span').count()).resolves.toBe(10);
  await p.click('dialog button:has-text("我已經存好了")');
  return secret;
}

describe('sign in with Google + authenticator', () => {
  it('the owner switches it on from the users page', async () => {
    const p = await asGoogleUser('boss@gmail.com', `${site.url}/#servers`);
    await p.waitForSelector('.server-card');
    await p.click('.server-card button:has-text("登入")');
    await p.fill('dialog input[type=password]', 'deploy-pass-123');
    await p.click('dialog button:has-text("登入")');
    await p.click('.server-card a:has-text("使用者與登入")');
    await p.waitForSelector('text=登入方式：管理員密碼');
    // no Google Drive connected here, so the form to type the OAuth client in is already open
    await p.fill('.field:has(label:text-is("用戶端 ID（Client ID）")) input', 'cid.apps.googleusercontent.com');
    await p.fill('.field:has(label:text-is("用戶端密鑰（Client Secret）")) input', 'secret');
    await p.click('button:has-text("儲存")');
    await p.waitForSelector('text=已設定 OAuth 用戶端');
    await shot(p, '01-enable');
    await p.click('button:has-text("用 Google 登入並啟用")');
    await p.click('dialog button:has-text("開始")');
    await enroll(p);
    await p.waitForSelector('text=登入方式：Google 帳號＋驗證器');
    expect(p.url()).toBe(`${site.url}/#users`); // back where it started
    await expect(p.locator('tr:has-text("boss@gmail.com")').textContent()).resolves.toContain('擁有者');

    await p.click('button:has-text("新增使用者")');
    await p.fill('dialog input[type=email]', 'amy@gmail.com');
    await p.click('dialog button:has-text("新增")');
    await p.waitForSelector('tr:has-text("amy@gmail.com")');
    await shot(p, '02-users');
    await p.click('.app-nav a:has-text("伺服器設定")');
    await expect(p.locator('.server-card').textContent()).resolves.toContain('已登入：boss@gmail.com（擁有者）');
    await expect(p.locator('.server-card button:has-text("更換管理員密碼")').count()).resolves.toBe(0);
    await p.context().close();
  });

  it('a member opens the packer on its login screen and gets straight in', async () => {
    const p = await asGoogleUser('amy@gmail.com');
    await p.waitForSelector('.card.gate');
    await expect(p.locator('.app-side').isVisible()).resolves.toBe(false);
    // no way around it: no links past it, and going to another page still shows it
    await expect(p.locator('.card.gate').textContent()).resolves.not.toMatch(/改用其他伺服器|不登入/);
    for (const page of ['#servers', '#create', '#manage']) {
      await p.evaluate((h) => (location.hash = h), page);
      await p.waitForSelector('.card.gate');
    }
    await shot(p, '03-gate');
    await p.click('.card.gate button:has-text("用 Google 登入")');
    await enroll(p);
    await p.waitForSelector('.app-nav');
    await p.click('.app-nav a:has-text("使用者與登入")');
    await p.waitForSelector('text=登入方式與使用者名單由擁有者管理');
    await p.click('.app-nav a:has-text("雲端空間")');
    await p.waitForSelector('text=雲端空間由擁有者連結和管理');
    await p.context().close();
  });

  it('someone not on the list is refused like a wrong code', async () => {
    const p = await asGoogleUser('stranger@gmail.com');
    await p.click('.card.gate button:has-text("用 Google 登入")');
    await p.waitForSelector('dialog:has-text("輸入驗證碼")'); // asked for a code, like anyone else
    await p.fill('dialog .code-input', '123456');
    await p.click('dialog button:has-text("登入")');
    await p.waitForSelector('dialog .error:has-text("沒有使用權限")');
    await shot(p, '04-refused');
    await p.context().close();
  });

  it('the spare password still gets the owner in', async () => {
    const p = await asGoogleUser('nobody@gmail.com');
    await p.click('.card.gate summary:has-text("手機和備用碼都不見了")');
    await p.fill('.card.gate input[type=password]', 'deploy-pass-123');
    await p.click('.card.gate button:has-text("用備用密碼登入")');
    await p.waitForSelector('.app-nav');
    await p.goto(`${site.url}/#users`);
    await p.waitForSelector('text=你現在是用部署時的備用密碼登入');
    await p.context().close();
  });
});
