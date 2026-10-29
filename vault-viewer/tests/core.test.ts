import { describe, expect, it } from 'vitest';
import { randomBytes, utf8, fromUtf8 } from '../src/core/bytes';
import { keyToText, textToKey, generatePassword } from '../src/core/keytext';
import {
  buildVault, renderVaultHtml, readPayloadFromHtml, decodeBlob, prepareUnlock, openManifest, readFile,
  deriveContentKey, DEFAULT_POLICY, DEFAULT_PROTECTION, PAYLOAD_MARKER, type InputFile, type BuildOptions,
} from '../src/core/format';
import { fromB64 } from '../src/core/bytes';

const FAST_KDF = { alg: 'argon2id' as const, m: 1024, t: 1, p: 1 };
const TEMPLATE = `<html><head><title>__VAULT_TITLE__</title></head><body>${PAYLOAD_MARKER}</body></html>`;

const mem = (path: string, data: Uint8Array, mime = 'text/plain'): InputFile => ({ path, mime, size: data.length, read: async () => data });

function opts(over: Partial<BuildOptions> = {}): BuildOptions {
  return {
    title: '測試 <封存>', recipient: '小明', batchId: 'b1', mode: 'offline', server: null,
    policy: DEFAULT_POLICY, protection: DEFAULT_PROTECTION, password: 'pw-1234', keyfile: randomBytes(32),
    serverShare: null, kdf: FAST_KDF, ...over,
  };
}

async function unlock(html: string, password: string, keyfile: Uint8Array, share: Uint8Array | null) {
  const p = readPayloadFromHtml(html);
  const { pwKey, authKey, salt } = await prepareUnlock(p.header, password, keyfile);
  const key = await deriveContentKey(pwKey, keyfile, share, salt);
  return { p, authKey, key, manifest: await openManifest(p.header, key) };
}

describe('key text', () => {
  it('round-trips and tolerates formatting', () => {
    const k = randomBytes(32);
    const t = keyToText(k);
    expect(t.startsWith('VK1-')).toBe(true);
    const messy = ` ${t.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    const r = textToKey(messy);
    expect(r.ok && Array.from(r.key)).toEqual(Array.from(k));
    expect(textToKey(`金鑰檔\r\n${t}\r\n`).ok).toBe(true);
  });
  it('detects typos', () => {
    const t = keyToText(randomBytes(32));
    const i = 10;
    const typo = t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1);
    expect(textToKey(typo)).toEqual({ ok: false, reason: 'checksum' });
    expect(textToKey('hello')).toEqual({ ok: false, reason: 'format' });
  });
  it('generates readable passwords', () => {
    expect(generatePassword()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  });
});

describe('vault format', () => {
  it('builds, renders and opens an offline vault', async () => {
    const big = randomBytes(7 * 1024 * 1024 + 123); // spans several 3 MB chunks
    const o = opts();
    const v = await buildVault([mem('a/說明.txt', utf8('你好')), mem('b/big.bin', big, 'application/octet-stream')], o);
    const html = renderVaultHtml(TEMPLATE, v.header, v.blobParts).join('');
    expect(html).toContain('<title>測試 &#60;封存&#62;</title>');
    expect(html).not.toContain('說明.txt'); // file names are encrypted
    const { p, key, manifest } = await unlock(html, 'pw-1234', o.keyfile, null);
    expect(manifest.recipient).toBe('小明');
    expect(manifest.files.map((f) => f.path)).toEqual(['a/說明.txt', 'b/big.bin']);
    const blob = decodeBlob(p);
    expect(fromUtf8(await readFile(p.header, blob, manifest.files[0], key))).toBe('你好');
    const back = await readFile(p.header, blob, manifest.files[1], key);
    expect(back.length).toBe(big.length);
    expect(back[big.length - 1]).toBe(big[big.length - 1]);
  });

  it('rejects a wrong password or key file', async () => {
    const o = opts();
    const v = await buildVault([mem('x.txt', utf8('x'))], o);
    const html = renderVaultHtml(TEMPLATE, v.header, v.blobParts).join('');
    await expect(unlock(html, 'wrong', o.keyfile, null)).rejects.toThrow();
    await expect(unlock(html, 'pw-1234', randomBytes(32), null)).rejects.toThrow();
  });

  it('online vaults need the server share, and authKey matches', async () => {
    const share = randomBytes(32);
    const o = opts({ mode: 'online', server: 'https://example.workers.dev', serverShare: share });
    const v = await buildVault([mem('x.txt', utf8('x'))], o);
    const html = renderVaultHtml(TEMPLATE, v.header, v.blobParts).join('');
    await expect(unlock(html, 'pw-1234', o.keyfile, null)).rejects.toThrow();
    const ok = await unlock(html, 'pw-1234', o.keyfile, share);
    expect(Array.from(ok.authKey)).toEqual(Array.from(v.authKey));
  });

  it('detects a tampered header', async () => {
    const o = opts();
    const v = await buildVault([mem('x.txt', utf8('x'))], o);
    const html = renderVaultHtml(TEMPLATE, { ...v.header, title: '改過的' }, v.blobParts).join('');
    await expect(unlock(html, 'pw-1234', o.keyfile, null)).rejects.toThrow();
    const offlineFromOnline = renderVaultHtml(TEMPLATE, { ...v.header, maxFailures: 999 }, v.blobParts).join('');
    await expect(unlock(offlineFromOnline, 'pw-1234', o.keyfile, null)).rejects.toThrow();
  });

  it('escapes </script> in the header', async () => {
    const o = opts({ title: '</script><script>alert(1)</script>' });
    const v = await buildVault([mem('x.txt', utf8('x'))], o);
    const html = renderVaultHtml(TEMPLATE, v.header, v.blobParts).join('');
    expect(readPayloadFromHtml(html).header.title).toBe(o.title);
    expect(fromB64(v.header.salt).length).toBe(16);
  });
});
