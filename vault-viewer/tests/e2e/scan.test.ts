import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import type { Browser } from 'playwright';
import { randomBytes } from '../../src/core/bytes';
import { keyToText } from '../../src/core/keytext';
import { buildVault, renderVaultHtml, DEFAULT_POLICY, DEFAULT_PROTECTION } from '../../src/core/format';
import { readFileSync } from 'node:fs';
import { sampleFiles } from './fixtures';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const OUT = join(process.env.E2E_OUT ?? join(process.cwd(), 'test-results'), 'scan');
const W = 640;
const H = 480;

/** A few frames of a webcam looking at a QR code, in the raw format Chromium's fake camera plays. */
function qrVideo(text: string, path: string) {
  const qr = qrcode(0, 'M');
  qr.addData(text.toUpperCase(), 'Alphanumeric');
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.floor((H * 0.8) / (n + 8));
  const size = (n + 8) * cell;
  const x0 = Math.floor((W - size) / 2);
  const y0 = Math.floor((H - size) / 2);
  const y = new Uint8Array(W * H).fill(200); // grey table
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) y[(y0 + py) * W + x0 + px] = 235; // white card with a quiet zone
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) y[(y0 + (r + 4) * cell + py) * W + x0 + (c + 4) * cell + px] = 16;
  }
  const chroma = new Uint8Array((W / 2) * (H / 2)).fill(128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(frame)]));
}

let keyfile: Uint8Array;
let vaultPath: string;
const browsers: Browser[] = [];

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  keyfile = randomBytes(32);
  qrVideo(keyToText(keyfile), join(OUT, 'key.y4m'));
  qrVideo('HELLO WORLD', join(OUT, 'other.y4m'));
  const v = await buildVault(sampleFiles(), {
    title: '掃描測試', recipient: '手機使用者', batchId: 'b', mode: 'offline', server: null, policy: DEFAULT_POLICY, protection: DEFAULT_PROTECTION,
    password: 'abcd-efgh-jkmn', keyfile, serverShare: null, kdf: { alg: 'argon2id', m: 8192, t: 1, p: 1 },
  });
  vaultPath = join(OUT, 'scan.vault.html');
  writeFileSync(vaultPath, renderVaultHtml(readFileSync('src/generated/viewer-template.html', 'utf8'), v.header, v.blobParts).join(''));
});
afterAll(async () => {
  for (const b of browsers) await b.close();
});

async function openWithCamera(video: string) {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${join(OUT, video)}`] });
  browsers.push(browser);
  const ctx = await browser.newContext({ permissions: ['camera'], viewport: { width: 390, height: 780 } }); // phone-sized
  const page = await ctx.newPage();
  await page.goto(`file://${vaultPath}`);
  return page;
}

describe('scanning the key QR code', () => {
  it('fills in the key from the camera, then the vault opens', async () => {
    const page = await openWithCamera('key.y4m');
    await page.click('button:has-text("掃描 QR")');
    await page.waitForSelector('.scan-overlay video');
    await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value.startsWith('VK1'), null, { timeout: 20_000 });
    expect(await page.locator('.scan-overlay').count()).toBe(0); // scanner closes by itself
    await expect(page.locator('.hint.ok').textContent()).resolves.toContain('金鑰格式正確');
    expect((await page.locator('textarea').inputValue()).replace(/\s/g, '')).toBe(keyToText(keyfile).replace(/\s/g, ''));
    await page.screenshot({ path: join(OUT, 'after-scan.png') });
    await page.fill('input[type=password]', 'abcd-efgh-jkmn');
    await page.click('button[type=submit]');
    await page.waitForSelector('.tree');
  });

  it('says so when the QR code is not a key, and can be closed', async () => {
    const page = await openWithCamera('other.y4m');
    await page.click('button:has-text("掃描 QR")');
    await page.waitForSelector('.scan-hint:has-text("不是金鑰")', { timeout: 20_000 });
    expect(await page.locator('textarea').inputValue()).toBe('');
    await page.screenshot({ path: join(OUT, 'not-a-key.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.scan-overlay'));
  });
});
