import { createServer, type Server } from 'node:http';
import { Hub, MemoryStore } from '../../server/src/hub';
import { utf8 } from '../../src/core/bytes';
import type { InputFile } from '../../src/core/format';

/** A tiny but valid one-page PDF that says "Hello PDF". */
export function minimalPdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 24 Tf 60 100 Td (Hello PDF) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
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

export function sampleFiles(): InputFile[] {
  return [
    file('合約/報價單.pdf', minimalPdf(), 'application/pdf'),
    file('合約/說明.md', utf8('# 標題\n\n這是 **Markdown** 內容。\n\n<script>window.hacked=1</script>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'), 'text/markdown'),
    file('圖片/red.png', PNG, 'image/png'),
    file('備註.txt', utf8('第一行\n第二行 secret-text'), 'text/plain'),
  ];
}

export async function startHub(adminPassword = 'admin-pass-123'): Promise<{ url: string; server: Server }> {
  const hub = new Hub(new MemoryStore(), { ADMIN_PASSWORD: adminPassword });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await hub.handle(new Request(`http://localhost${req.url}`, { method: req.method, headers: { ...(req.headers as Record<string, string>), 'x-vv-ip': req.socket.remoteAddress ?? '', 'x-vv-country': 'TW' }, body: req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, server };
}
