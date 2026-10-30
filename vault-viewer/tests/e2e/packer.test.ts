import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { sampleFiles, startHub } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = join(process.env.E2E_OUT ?? join(process.cwd(), 'test-results'), 'packer');
const PACKER = `file://${join(process.cwd(), 'dist/index.html')}`;

let browser: Browser;
let ctx: BrowserContext;
let hub: Awaited<ReturnType<typeof startHub>>;
const errors: string[] = [];

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  hub = await startHub('admin-pass-123');
});
afterAll(async () => {
  await browser?.close();
  hub?.server.close();
});

async function page(url: string): Promise<Page> {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', JSON.stringify({ msg: String(e), stack: (e as Error).stack?.slice(0, 400), url: p.url().slice(0, 100) })); });
  p.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  p.on('dialog', (d) => d.accept());
  await p.goto(url);
  return p;
}

let packer: Page;
async function gotoPacker(hash: string) {
  if (!packer) packer = await page(`${PACKER}#${hash}`);
  else await packer.evaluate((h) => (location.hash = h), hash);
  return packer;
}

const shot = (p: Page, name: string) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

describe('packer', () => {
  let vaultPath = '';
  let password = '';
  let keyText = '';

  it('sets up a server through the wizard', async () => {
    const p = await gotoPacker('home');
    await shot(p, '01-home');
    await p.click('.app-nav a:has-text("伺服器設定")');
    await shot(p, '02-server-wizard');
    await p.fill('input[placeholder^="https://vault-viewer."]', hub.url);
    await p.click('button:has-text("測試連線")');
    await p.waitForSelector('text=連線成功');
    await p.fill('.admin-step input[type=password]', 'wrong-password');
    await p.click('button:has-text("登入並儲存")');
    await p.waitForSelector('.admin-step .error:has-text("不正確")');
    await p.fill('.admin-step input[type=password]', 'admin-pass-123');
    await p.click('button:has-text("登入並儲存")');
    await p.waitForSelector('.server-card');
    await expect(p.locator('.server-card').textContent()).resolves.toContain('管理員已登入');
    await p.waitForSelector('.chip.ok:has-text("連線正常")');
    await shot(p, '03-server-list');
  });

  it('creates vaults for two recipients', async () => {
    const p = await gotoPacker('create');
    // In-memory files keep the test independent of the machine's file-name encoding.
    const files = await Promise.all(sampleFiles().map(async (f) => ({ name: f.path.split('/').pop()!, mimeType: f.mime, buffer: Buffer.from(await f.read()) })));
    await p.setInputFiles('input[type=file][multiple]:not([webkitdirectory])', files);
    await p.waitForSelector('.file-row');
    await shot(p, '04-create-files');
    await p.click('button:has-text("下一步")');
    await p.fill('input[maxlength="100"]', '年度合約');
    await shot(p, '05-create-basics');
    await p.click('button:has-text("下一步")');
    await p.click('.seg button:has-text("限制次數")');
    await p.fill('input[type=number][min="1"]', '2');
    await shot(p, '06-create-policy');
    await p.click('button:has-text("下一步")');
    await p.click('button:has-text("追蹤：名字＋IP＋編號")');
    expect(await p.evaluate(() => Array.from(document.querySelectorAll('input')).some((i) => i.value.includes('{IP}')))).toBe(true);
    await shot(p, '07-create-protection');
    await p.click('button:has-text("下一步")');
    // template download, then import a Big5-free UTF-8 CSV (with BOM, quoted field and a short password)
    const [tpl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("下載範本")')]);
    expect(tpl.suggestedFilename()).toBe('收件人名單範本.csv');
    const csv = '\uFEFF名稱,密碼,備註\r\n王小明,,"財務部, NB-0123"\r\n陳小華,my-pass-2026,業務部\r\n王小明,dup-dup-dup,\r\n林小美,123,\r\n';
    await p.setInputFiles('input[type=file][accept*=csv]', { name: '名單.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await p.waitForSelector('dialog:has-text("讀到")');
    await expect(p.locator('dialog').textContent()).resolves.toContain('3 位');
    await expect(p.locator('dialog').textContent()).resolves.toContain('重複');
    await expect(p.locator('dialog').textContent()).resolves.toContain('自動產生');
    await shot(p, '08a-csv-import');
    await p.click('dialog button:has-text("匯入")');
    await p.waitForSelector('text=共 3 位');
    await expect(p.locator('.recipient-row input[placeholder^="備註"] >> nth=0').inputValue()).resolves.toBe('財務部, NB-0123');
    await expect(p.locator('.recipient-row .pw-cell input >> nth=1').inputValue()).resolves.toBe('my-pass-2026');
    expect(await p.locator('.recipient-row button:has-text("複製")').count()).toBe(3);
    await p.click('.recipient-row >> nth=2 >> button[title="移除"]'); // drop 林小美
    await shot(p, '08-create-recipients');
    await p.click('button:has-text("確認並產生")');
    await shot(p, '09-create-confirm');
    await p.click('button:has-text("開始加密")');
    await p.waitForSelector('text=封存檔已產生', { timeout: 60_000 });
    await shot(p, '10-create-result');

    const card = p.locator('.result-card').first();
    password = (await card.locator('.copy-line .mono').nth(0).textContent())!.trim();
    keyText = (await card.locator('.copy-line .mono').nth(1).textContent())!.trim();
    expect(keyText).toMatch(/^VK1-/);
    const [dl] = await Promise.all([p.waitForEvent('download'), card.locator('button:has-text("封存檔")').click()]);
    vaultPath = join(OUT, dl.suggestedFilename());
    await dl.saveAs(vaultPath);
    expect(dl.suggestedFilename()).toBe('年度合約_王小明.vault.html');
    const [zip] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("全部下載成 ZIP")')]);
    expect(zip.suggestedFilename()).toBe('年度合約.zip');
  });

  it('the generated vault opens online', async () => {
    const p = await page(`file://${vaultPath}`);
    await p.fill('input[type=password]', password);
    await p.fill('textarea', keyText);
    await p.click('button[type=submit]');
    await p.waitForSelector('.tree');
    await expect(p.locator('.topbar').textContent()).resolves.toContain('剩餘 1 次');
    await p.click('.file:has-text("報價單.pdf")');
    await p.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
    await shot(p, '11-viewer');
    await p.close();
  });

  it('manages and revokes from the manage page', async () => {
    const p = await gotoPacker('manage');
    await p.waitForSelector('table.table');
    await expect(p.locator('tr:has-text("王小明")').textContent()).resolves.toContain('1 / 2');
    // statistics: the one open above shows in the headline number, the chart and the table view
    await p.waitForSelector('.stats .tile');
    await expect(p.locator('.tile:has-text("近 30 天開啟") .tile-value').textContent()).resolves.toBe('1');
    await expect(p.locator('.tile:has-text("近 30 天異常") .tile-value').textContent()).resolves.toBe('0');
    await expect(p.locator('.chart-host path').count()).resolves.toBe(1); // one coloured column: today's open
    await p.hover('.chart-host svg rect:last-of-type', { position: { x: 5, y: 5 }, force: true });
    await expect(p.locator('.tooltip').textContent()).resolves.toContain('成功開啟');
    await p.click('.seg-btn:has-text("7 天")');
    await p.waitForFunction(() => document.querySelector('.tile-label')?.parentElement && [...document.querySelectorAll('.tile-label')].some((e) => e.textContent === '近 7 天開啟'));
    await p.click('.stats button:has-text("以表格檢視")');
    await expect(p.locator('.stats table').first().locator('tbody tr').count()).resolves.toBe(7);
    await p.click('.stats button:has-text("以圖表檢視")');
    await p.screenshot({ path: join(OUT, '12a-stats.png'), fullPage: true });
    await p.click('tr:has-text("王小明") button:has-text("紀錄")');
    await p.waitForSelector('dialog td:has-text("開啟")');
    await shot(p, '12-manage-logs');
    await p.click('dialog button:has-text("關閉")');
    await p.click('tr:has-text("王小明") button:has-text("收回")');
    await p.click('dialog button:has-text("收回")');
    await p.waitForSelector('tr:has-text("王小明") .chip:has-text("已收回")');
    await p.click('tr:has-text("陳小華") button:has-text("調整")');
    await p.fill('dialog input[type=number] >> nth=0', '9');
    await p.click('dialog button:has-text("儲存")');
    await p.waitForSelector('tr:has-text("陳小華"):has-text("0 / 9")');
    await shot(p, '13-manage');

    const v = await page(`file://${vaultPath}`);
    await v.fill('input[type=password]', password);
    await v.fill('textarea', keyText);
    await v.click('button[type=submit]');
    await v.waitForSelector('.error:has-text("收回")');
    await v.close();
    // the refused attempt is now counted as a problem, with who and why
    await p.evaluate(() => (location.hash = 'home'));
    await p.evaluate(() => (location.hash = 'manage'));
    await p.waitForSelector('.tile:has-text("近 7 天異常")');
    await p.waitForFunction(() => document.querySelector('.stats .chip')?.textContent?.includes('已收回仍有人嘗試'));
    await expect(p.locator('.stats table tbody tr:has-text("王小明")').first().textContent()).resolves.toContain('已收回');
    await shot(p, '14-stats-issue');
    expect(errors).toEqual([]);
  });
});
