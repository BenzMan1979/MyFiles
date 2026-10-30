import { describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv, parseRecipients, templateCsv } from '../src/app/csv';
import { describeDevice, watermarkBackground, watermarkStyle, watermarkText, type WatermarkContext } from '../src/viewer/protect';
import { DEFAULT_PROTECTION } from '../src/core/format';

describe('csv', () => {
  it('parses quotes, CRLF and a trailing line without newline', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\nlast,row')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['last', 'row']]);
  });
  it('detects semicolons and tabs, and skips blank lines', () => {
    expect(parseCsv('a;b\n\n1;2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('reads the template it hands out', () => {
    const r = parseRecipients(decodeCsv(new TextEncoder().encode(templateCsv())));
    expect(r.recipients.map((x) => x.name)).toEqual(['王小明', '陳小華', '林小美']);
    expect(r.recipients[0]).toMatchObject({ password: '', note: '財務部 NB-0123' });
    expect(r.recipients[1].password).toBe('my-pass-2026');
    expect(r.warnings).toEqual([]);
  });
  it('falls back to Big5, which is what Excel writes for plain CSV', () => {
    // 名稱,密碼 / 王小明 in Big5
    const big5 = Uint8Array.from([0xa6, 0x57, 0xba, 0xd9, 0x2c, 0xb1, 0x4b, 0xbd, 0x58, 0x0d, 0x0a, 0xa4, 0xfd, 0xa4, 0x70, 0xa9, 0xfa, 0x2c, 0x0d, 0x0a]);
    expect(decodeCsv(big5).startsWith('名稱,密碼')).toBe(true);
    expect(parseRecipients(decodeCsv(big5)).recipients[0].name).toBe('王小明');
  });
  it('maps columns by header in any order, and works without a header', () => {
    expect(parseRecipients('備註,姓名\n NB-1 ,A').recipients[0]).toMatchObject({ name: 'A', note: 'NB-1', password: '' });
    expect(parseRecipients('A,pw-123456,x\nB').recipients.map((r) => [r.name, r.password, r.note])).toEqual([['A', 'pw-123456', 'x'], ['B', '', '']]);
  });
  it('reports duplicates, blanks and short passwords instead of silently changing them', () => {
    const r = parseRecipients('名稱,密碼\nA,123\nA,abcdefgh\n,xxxxxxx\nB,abcdefgh');
    expect(r.recipients.map((x) => [x.name, x.password])).toEqual([['A', ''], ['B', 'abcdefgh']]);
    expect(r.skipped).toBe(2);
    expect(r.warnings.join('\n')).toMatch(/第 2 列.*密碼少於.*自動產生/);
    expect(r.warnings.join('\n')).toMatch(/第 3 列.*重複/);
    expect(r.warnings.join('\n')).toMatch(/第 4 列沒有名稱/);
  });
  it('caps one import at 500 recipients', () => {
    const csv = ['名稱', ...Array.from({ length: 520 }, (_, i) => `u${i}`)].join('\n');
    const r = parseRecipients(csv);
    expect(r.recipients).toHaveLength(500);
    expect(r.warnings.at(-1)).toMatch(/最多 500/);
  });
});

describe('watermark text', () => {
  const ctx: WatermarkContext = { recipient: '王小明', note: 'NB-1', openedAt: new Date(2026, 9, 30, 8, 5), ip: '203.0.113.8', country: 'TW', tag: 'A7K2Q9', device: 'Chrome 130 / Windows' };
  const wm = (text: string, c = ctx) => watermarkText({ ...DEFAULT_PROTECTION, watermark: { ...DEFAULT_PROTECTION.watermark, text } }, c);
  it('fills every placeholder', () => {
    expect(wm('{收件人} {IP} {地區} {裝置} {編號} {備註} {日期} {時間}')).toBe('王小明 203.0.113.8 TW Chrome 130 / Windows A7K2Q9 NB-1 2026/10/30 2026/10/30 08:05');
  });
  it('shows a dash when the address is unknown (offline) and keeps unknown braces', () => {
    expect(wm('{IP}|{地區}|{未知}', { ...ctx, ip: null, country: null })).toBe('—|—|{未知}');
  });
  it('describes the browser and OS only', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Edge 130 / Windows');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari 17 / iOS');
  });
});

describe('watermark tile', () => {
  const tile = (text: string, size: number, density: number) => {
    const svg = decodeURIComponent(watermarkBackground(text, 0.2, size, density).slice(5, -2).replace('data:image/svg+xml;charset=utf-8,', ''));
    const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/)!.map(Number);
    return { w, h, marks: (svg.match(/<text /g) ?? []).length, svg };
  };
  it('grows with the text, so a long text is not cut off', () => {
    expect(tile('王小明  203.0.113.8  A7K2Q9  2026/10/30 08:05', 18, 3).w).toBeGreaterThan(tile('王小明', 18, 3).w);
  });
  it('is bigger for larger fonts and smaller for denser settings', () => {
    const t = '王小明 2026/10/30';
    expect(tile(t, 30, 3).w).toBeGreaterThan(tile(t, 14, 3).w);
    const widths = [1, 2, 3, 4, 5].map((d) => tile(t, 18, d).w * tile(t, 18, d).h);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(new Set(widths).size).toBe(5);
  });
  it('lays marks out like bricks: one in the middle of the top row, the next row wrapping around the sides', () => {
    const t = tile('abc', 18, 3);
    expect(t.marks).toBe(3);
    const xs = [...t.svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(xs[0][0]).toBe(t.w / 2); // middle of the first row
    expect(xs[1][0]).toBe(0); // second row: half a mark at each side edge
    expect(xs[2][0]).toBe(t.w);
    expect(xs[1][1]).toBe(xs[2][1]);
    expect(xs[1][1]).toBe(t.h * 0.75); // centred in the lower half
  });
  it('clamps and defaults the style, including vaults made before these settings existed', () => {
    expect(watermarkStyle({})).toEqual({ size: 18, density: 3 });
    expect(watermarkStyle({ size: 500, density: 0 })).toEqual({ size: 48, density: 1 });
    expect(watermarkStyle({ size: 2, density: 9 })).toEqual({ size: 10, density: 5 });
  });
});
