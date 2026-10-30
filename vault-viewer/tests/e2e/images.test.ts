import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { cjkPdf, minimalPdf } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = join(process.env.E2E_OUT ?? join(process.cwd(), 'test-results'), 'images');
let browser: Browser;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe('PDF converted to page images', () => {
  it('packs a PDF as pictures and shows it as one scrollable document with nothing to copy', async () => {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { throw e; });
    await p.goto(`file://${join(process.cwd(), 'dist/index.html')}#create`);
    await p.setInputFiles('input[type=file][multiple]:not([webkitdirectory])', [
      { name: '簡報.pdf', mimeType: 'application/pdf', buffer: Buffer.from(minimalPdf(3)) },
      { name: '舊式.pdf', mimeType: 'application/pdf', buffer: Buffer.from(cjkPdf()) }, // fonts not embedded
      { name: '備註.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text file') },
    ]);
    await p.waitForSelector('.pdf-images');
    await p.click('.pdf-images .toggle');
    await p.waitForSelector('.pdf-images select');
    await p.selectOption('.pdf-images select', '1200');
    await p.screenshot({ path: join(OUT, 'option.png') });
    await p.click('button:has-text("下一步")');
    await p.click('.choice:has-text("離線")');
    for (let i = 0; i < 3; i++) await p.click('button:has-text("下一步")'); // policy, protection, recipients
    await p.fill('.recipient-row input >> nth=0', '王小明');
    await p.click('button:has-text("確認並產生")');
    await p.click('button:has-text("開始加密")');
    await p.waitForSelector('text=封存檔已產生', { timeout: 60_000 });

    const card = p.locator('.result-card').first();
    const password = (await card.locator('.copy-line .mono').nth(0).textContent())!.trim();
    const keyText = (await card.locator('.copy-line .mono').nth(1).textContent())!.trim();
    const [dl] = await Promise.all([p.waitForEvent('download'), card.locator('button:has-text("封存檔")').click()]);
    const vault = join(OUT, 'images.vault.html');
    await dl.saveAs(vault);
    await p.close();

    const v = await ctx.newPage();
    v.on('pageerror', (e) => { throw e; });
    await v.goto(`file://${vault}`);
    await v.fill('input[type=password]', password);
    await v.fill('textarea', keyText);
    await v.click('button[type=submit]');
    await v.waitForSelector('.tree');
    // one document, no per-page files
    expect(await v.locator('.tree .file').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('簡報.pdf'), expect.stringContaining('備註.txt')]));
    expect(await v.locator('.tree .file').count()).toBe(3);
    expect(await v.locator('.side-foot').textContent()).toContain('3 個檔案');

    await v.click('.file:has-text("簡報.pdf")');
    await v.waitForSelector('.page-images .page-image img', { timeout: 20_000 });
    await expect(v.locator('.page-image').count()).resolves.toBe(3);
    await v.waitForFunction(() => document.querySelectorAll('.page-image img').length === 3, null, { timeout: 20_000 });
    const sizes = await v.locator('.page-image img').evaluateAll((imgs) => imgs.map((i) => [(i as HTMLImageElement).naturalWidth, (i as HTMLImageElement).naturalHeight]));
    expect(sizes).toEqual([[1200, 800], [1200, 800], [1200, 800]]); // 300x200 pt page at 1200 px across
    expect(await v.locator('.textLayer').count()).toBe(0);
    expect(await v.locator('.pdf-page canvas').count()).toBe(0); // not drawn from the PDF any more
    expect(await v.locator('.filebar button:has-text("下載")').count()).toBe(0);
    await v.screenshot({ path: join(OUT, 'viewer.png') });

    // the page images are real renderings of the PDF: the text "Page 1" is in the first one
    const darkPixels = await v.locator('.page-image img').first().evaluate((img) => {
      const i = img as HTMLImageElement;
      const c = document.createElement('canvas');
      c.width = i.naturalWidth; c.height = i.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(i, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] < 80) n++;
      return n;
    });
    expect(darkPixels).toBeGreaterThan(300);
    // an older Chinese PDF (font not embedded) becomes pictures with its characters drawn too
    await v.click('.file:has-text("舊式.pdf")');
    await v.waitForSelector('.page-image img');
    const cjkInk = await v.locator('.page-image img').first().evaluate((img) => {
      const i = img as HTMLImageElement;
      const c = document.createElement('canvas');
      c.width = i.naturalWidth; c.height = i.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(i, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] < 80) n++;
      return n;
    });
    expect(cjkInk).toBeGreaterThan(1500);
    await v.click('.file:has-text("備註.txt")');
    await v.waitForSelector('pre.code:has-text("plain text file")');
    await ctx.close();
  });
});
