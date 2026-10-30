import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { randomBytes, toB64 } from '../../src/core/bytes';
import { keyToText } from '../../src/core/keytext';
import { buildVault, renderVaultHtml, DEFAULT_POLICY, DEFAULT_PROTECTION, type BuildOptions } from '../../src/core/format';
import { officeFiles, sampleFiles, startHub } from './fixtures';

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

async function makeVault(name: string, over: Partial<BuildOptions>, files = sampleFiles()) {
  const keyfile = randomBytes(32);
  const o: BuildOptions = {
    title: '測試封存', recipient: '王小明', batchId: 'b1', mode: 'offline', server: null,
    policy: DEFAULT_POLICY, protection: DEFAULT_PROTECTION, password: 'abcd-efgh-jkmn', keyfile, serverShare: null, kdf: FAST_KDF, ...over,
  };
  const v = await buildVault(files, o);
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

describe('Word and Excel previews', () => {
  it('shows a Word document, neutralises hostile links, and keeps allowed behaviour', async () => {
    const { path, key } = await makeVault('office', {}, officeFiles());
    const page = await openPage(path);
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');

    await page.click('.file:has-text("合約.docx")');
    await page.waitForSelector('.docx-view section.docx', { timeout: 20_000 });
    const text = await page.locator('.docx-view').innerText();
    expect(text).toContain('合約標題');
    expect(text).toContain('docx-secret');
    expect(text).toContain('甲方');
    expect(await page.locator('.docx-view table').count()).toBeGreaterThan(0);
    expect(await page.locator('.docx-view a[href^="https://example.com"][rel~="noopener"]').count()).toBe(1);
    expect(await page.locator('.docx-view a[href^="javascript"]').count()).toBe(0);
    expect(await page.locator('.docx-view a:has-text("壞連結")[href]').count()).toBe(0);
    await page.screenshot({ path: join(OUT, 'preview-docx.png') });

    await page.click('.file:has-text("報表.xlsx")');
    await page.waitForSelector('table.sheet');
    const tabs = await page.locator('.sheet-tabs button').allTextContents();
    expect(tabs).toEqual(['摘要', '明細']); // the hidden sheet is not offered
    const cells = await page.locator('table.sheet td').allTextContents();
    expect(cells).toContain('合計 xlsx-secret'); // rich text runs joined
    expect(cells).toContain('1,234.50'); // #,##0.00
    expect(cells).toContain('2026-10-30'); // built-in date
    expect(cells).toContain('12.5%'); // custom percent
    expect(cells).toContain('2026年10月30日'); // custom Chinese date
    expect(cells).toContain('TRUE');
    expect(cells).toContain('內嵌文字');
    expect(cells).toContain('#DIV/0!');
    expect(await page.locator('table.sheet td[colspan="3"]').textContent()).toBe('跨欄的標題');
    expect(await page.locator('table.sheet td.num').count()).toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: join(OUT, 'preview-xlsx.png') });
    await page.click('.sheet-tabs button:has-text("明細")');
    await page.waitForSelector('table.sheet td:has-text("明細頁內容")');
    expect(await page.locator('table.sheet').innerText()).not.toContain('不該看到');
    // column letters and row numbers like a spreadsheet
    expect(await page.locator('table.sheet thead th').allTextContents()).toEqual(['', 'A', 'B']);

    await page.click('.file:has-text("舊檔.xls")');
    await page.waitForSelector('text=舊版 Office 格式');
    expect((page as Page & { errors: string[] }).errors).toEqual([]);
    await page.close();
  });
});

describe('PDF text', () => {
  it('can be selected only when copying is allowed', async () => {
    const open = async (name: string, allowCopy: boolean) => {
      const { path, key } = await makeVault(name, { protection: { ...DEFAULT_PROTECTION, allowCopy } });
      const page = await openPage(path);
      await unlock(page, 'abcd-efgh-jkmn', key);
      await page.waitForSelector('.tree');
      await page.click('.file:has-text("報價單.pdf")');
      await page.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
      return page;
    };
    const locked = await open('pdf-nocopy', false);
    expect(await locked.locator('.textLayer').count()).toBe(0); // no hidden text to copy
    await locked.close();

    const free = await open('pdf-copy', true);
    await free.waitForSelector('.textLayer span');
    expect(await free.locator('.textLayer').innerText()).toContain('Hello PDF');
    // the text really is selectable and lines up with the page
    const sel = await free.evaluate(() => {
      const span = document.querySelector('.textLayer span') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(span);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      const r = span.getBoundingClientRect();
      const page = span.closest('.pdf-page')!.getBoundingClientRect();
      return { text: s.toString(), inside: r.left >= page.left - 1 && r.right <= page.right + 1 && r.top >= page.top - 1 && r.bottom <= page.bottom + 1, userSelect: getComputedStyle(span).userSelect };
    });
    expect(sel.text).toContain('Hello PDF');
    expect(sel.inside).toBe(true);
    expect(sel.userSelect).not.toBe('none');
    await free.screenshot({ path: join(OUT, 'pdf-textlayer.png') });
    await free.close();
  });
});

describe('watermark visibility', () => {
  // Content such as a PDF page is white even in dark mode, so the mark must show on light and dark.
  for (const scheme of ['dark', 'light'] as const) {
    it(`is readable over white and dark backgrounds (${scheme} mode)`, async () => {
      const { path, key } = await makeVault(`wm-${scheme}`, {});
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await openPage(path, ctx);
      await unlock(page, 'abcd-efgh-jkmn', key);
      await page.waitForSelector('.tree');
      await page.click('.file:has-text("備註.txt")');
      const bg = await page.locator('.watermark').evaluate((el) => getComputedStyle(el).backgroundImage);
      const result = await page.evaluate(async (css) => {
        const url = css.slice(5, -2); // url("...")
        const img = new Image();
        await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
        const measure = (fill: string) => {
          const c = document.createElement('canvas');
          c.width = 360; c.height = 220;
          const g = c.getContext('2d')!;
          g.fillStyle = fill; g.fillRect(0, 0, 360, 220);
          const before = g.getImageData(0, 0, 360, 220).data;
          g.drawImage(img, 0, 0);
          const after = g.getImageData(0, 0, 360, 220).data;
          let strong = 0;
          for (let i = 0; i < after.length; i += 4) {
            if (Math.abs(after[i] - before[i]) >= 14) strong++;
          }
          return strong;
        };
        return { onWhite: measure('#ffffff'), onDark: measure('#12151b'), onMid: measure('#808080') };
      }, bg);
      // a few hundred pixels of the mark must clearly differ from the background
      expect(result.onWhite).toBeGreaterThan(150);
      expect(result.onDark).toBeGreaterThan(150);
      expect(result.onMid).toBeGreaterThan(150);
      if (scheme === 'dark') {
        await page.click('.file:has-text("報價單.pdf")');
        await page.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
        await page.screenshot({ path: join(OUT, 'watermark-dark-pdf.png') });
      }
      await ctx.close();
    });
  }
});

describe('watermark size and density', () => {
  const LONG = '王小明  203.0.113.8  A7K2Q9  2026/10/30 08:05  Chrome 130 / Windows';
  type Metrics = { w: number; h: number; coverage: number; edge: number; markHeight: number };

  async function measure(name: string, text: string, size: number | undefined, density: number | undefined): Promise<Metrics> {
    const { path, key } = await makeVault(name, { protection: { ...DEFAULT_PROTECTION, watermark: { enabled: true, text, opacity: 0.3, size, density } } });
    const page = await openPage(path);
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    const bg = await page.locator('.watermark').evaluate((el) => getComputedStyle(el).backgroundImage);
    const m = await page.evaluate(async (css) => {
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = css.slice(5, -2); });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const at = (x: number, y: number) => d[(y * c.width + x) * 4 + 3];
      let ink = 0, edge = 0, top = c.height, bottom = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (at(x, y) > 20) {
            ink++;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
          // marks wrap around the left/right edges by design; top and bottom must stay clear
          if ((y === 0 || y === c.height - 1) && at(x, y) > 8) edge++;
        }
      }
      return { w: c.width, h: c.height, coverage: ink / (c.width * c.height), edge, markHeight: bottom - top };
    }, bg);
    await page.close();
    return m;
  }

  it('never cuts a mark off at the top or bottom of the tile, and responds to size and density', async () => {
    const base = await measure('wm-base', LONG, undefined, undefined); // a vault from before these settings
    const sparse = await measure('wm-sparse', LONG, 18, 1);
    const dense = await measure('wm-dense', LONG, 18, 5);
    const small = await measure('wm-small', LONG, 12, 3);
    const big = await measure('wm-big', LONG, 40, 3);
    for (const m of [base, sparse, dense, small, big]) expect(m.edge).toBe(0);
    expect(dense.coverage).toBeGreaterThan(sparse.coverage * 1.6);
    expect(big.markHeight).toBeGreaterThan(small.markHeight);
    expect(big.w).toBeGreaterThan(small.w);
    expect(base.w).toBeGreaterThan(0);
  });
});

describe('watermark tamper guard', () => {
  it('locks the vault again when the watermark is removed', async () => {
    const { path, key } = await makeVault('wm-tamper', {});
    const page = await openPage(path);
    await unlock(page, 'abcd-efgh-jkmn', key);
    await page.waitForSelector('.tree');
    await page.evaluate(() => document.querySelector('.watermark')!.remove());
    await page.waitForSelector('text=浮水印被移除', { timeout: 5000 });
    await page.waitForSelector('input[type=password]');
    await page.close();
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
