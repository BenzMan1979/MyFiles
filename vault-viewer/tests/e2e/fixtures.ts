import { createServer, type Server } from 'node:http';
import { Hub, MemoryStore } from '../../server/src/hub';
import { zipSync } from 'fflate';
import { utf8 } from '../../src/core/bytes';
import type { InputFile } from '../../src/core/format';

/** A tiny but valid PDF whose pages say "Hello PDF" (page 1) or "Page N". */
export function minimalPdf(pages = 1): Uint8Array {
  const objs: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']; // 1 catalog, 2 page tree, 3 font
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const pageNo = 4 + i * 2;
    kids.push(`${pageNo} 0 R`);
    const text = pages === 1 ? 'Hello PDF' : `Page ${i + 1}`;
    const stream = `BT /F1 24 Tf 60 100 Td (${text}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${pageNo + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return utf8(out);
}

/**
 * Chinese text the old way: a font that is NOT embedded, referring to a predefined character map
 * (UniCNS-UCS2-H for Traditional Chinese, UniGB-UCS2-H for Simplified). The reader has to supply the map.
 */
export function cjkPdf(): Uint8Array {
  const hex = (t: string) => Array.from(t, (ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
  const stream = `BT /F1 28 Tf 30 130 Td <${hex('中文測試報價單')}> Tj ET\nBT /F2 28 Tf 30 70 Td <${hex('简体中文文档')}> Tj ET`;
  const font = (n: number, base: string, enc: string, order: string) =>
    `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /${enc} /DescendantFonts [${n} 0 R] >>`;
  const cid = (base: string, order: string) =>
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (${order}) /Supplement 0 >> /DW 1000 >>`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    font(7, 'MSung-Light', 'UniCNS-UCS2-H', 'CNS1'),
    font(8, 'STSong-Light', 'UniGB-UCS2-H', 'GB1'),
    cid('MSung-Light', 'CNS1'),
    cid('STSong-Light', 'GB1'),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return utf8(out);
}

// 2x2 red PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const file = (path: string, data: Uint8Array, mime: string): InputFile => ({ path, mime, size: data.length, read: async () => data });

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, utf8(v)])));

/** A one-page Word file: bold title, text, a good and a hostile link, and a 2-cell table. */
export function minimalDocx(): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL + '"';
  return zip({
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rId11" Type="${REL}/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`,
    'word/document.xml': XML + `<w:document ${W}><w:body>` +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>合約標題</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第一段內容 docx-secret</w:t></w:r></w:p>' +
      '<w:p><w:hyperlink r:id="rId10"><w:r><w:t>壞連結</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> </w:t></w:r><w:hyperlink r:id="rId11"><w:r><w:t>好連結</w:t></w:r></w:hyperlink></w:p>' +
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙方</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>',
  });
}

/** Two visible sheets and one hidden: numbers with several formats, dates, a merged cell. */
export function minimalXlsx(): Uint8Array {
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zip({
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': XML + `<workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="摘要" sheetId="1" r:id="rId1"/><sheet name="明細" sheetId="2" r:id="rId2"/><sheet name="隱藏" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
    'xl/styles.xml': XML + `<styleSheet ${NS}><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>`,
    'xl/sharedStrings.xml': XML + `<sst ${NS}><si><t>品項</t></si><si><t>金額</t></si><si><t>日期</t></si><si><r><t>合計</t></r><r><t> xlsx-secret</t></r></si><si><t>占比</t></si><si><t>跨欄的標題</t></si></sst>`,
    'xl/worksheets/sheet1.xml': XML + `<worksheet ${NS}><cols><col min="1" max="1" width="18"/></cols><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="4"><v>1234.5</v></c><c r="C2" s="1"><v>46325</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>0.125</v></c><c r="C3" s="3"><v>46325</v></c></row>' +
      '<row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" t="inlineStr"><is><t>內嵌文字</t></is></c><c r="C4" t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="5"><c r="A5" t="s"><v>5</v></c></row>' +
      '</sheetData><mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells></worksheet>',
    'xl/worksheets/sheet2.xml': XML + `<worksheet ${NS}><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>明細頁內容</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>第二頁</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet3.xml': XML + `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>不該看到</t></is></c></row></sheetData></worksheet>`,
  });
}

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const officeFiles = (): InputFile[] => [
  file('文件/合約.docx', minimalDocx(), MIME_DOCX),
  file('文件/報表.xlsx', minimalXlsx(), MIME_XLSX),
  file('文件/舊檔.xls', utf8('not really a legacy file'), 'application/vnd.ms-excel'),
];

export function sampleFiles(): InputFile[] {
  return [
    file('合約/報價單.pdf', minimalPdf(), 'application/pdf'),
    file('合約/說明.md', utf8('# 標題\n\n這是 **Markdown** 內容。\n\n<script>window.hacked=1</script>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'), 'text/markdown'),
    file('圖片/red.png', PNG, 'image/png'),
    file('備註.txt', utf8('第一行\n第二行 secret-text'), 'text/plain'),
  ];
}

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

async function serveApi(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const noBody = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  // the real Worker adds these from Cloudflare's connection data
  const headers = { ...(req.headers as Record<string, string>), 'x-vv-ip': req.socket.remoteAddress ?? '', 'x-vv-country': 'TW' };
  const r = await hub.handle(new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers, body: noBody ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** The server API only, like a Worker without static pages. */
export async function startHub(adminPassword = 'admin-pass-123', env: Record<string, string> = {}): Promise<{ url: string; server: Server }> {
  const hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: adminPassword, ...env });
  const server = createServer((req, res) => void serveApi(hub, req, res));
  return { url: await listen(server), server };
}

/** Pages and API on one address, like the deployed Worker: /api/* is the server, the rest is dist/. */
export async function startSite(
  adminPassword: string | undefined = 'admin-pass-123',
  /** the cloud services the server talks to (fakes in tests), and the part size of cloud vaults */
  cloud: { fetcher?: typeof fetch; partBytes?: number } = {},
): Promise<{ url: string; server: Server }> {
  const hub = new Hub(new MemoryStore(), adminPassword ? { ADMIN_PASSWORD: adminPassword } : {}, Date.now, cloud.fetcher, { partBytes: cloud.partBytes });
  const pages: Record<string, string> = { '/': 'dist/index.html', '/index.html': 'dist/index.html', '/open.html': 'dist/open.html' };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/api/')) return void serveApi(hub, req, res);
    // a cloud link is the viewer page, like the Worker does
    const file = /^\/v\/[a-z0-9]+\/?$/.test(path) ? 'dist/open.html' : pages[path];
    if (!file) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file));
  });
  return { url: await listen(server), server };
}
