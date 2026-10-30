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

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

async function serveApi(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const noBody = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  // the real Worker adds these from Cloudflare's connection data
  const headers = { ...(req.headers as Record<string, string>), 'x-vv-ip': req.socket.remoteAddress ?? '', 'x-vv-country': 'TW' };
  const r = await hub.handle(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: noBody ? undefined : body }));
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
export async function startSite(adminPassword: string | undefined = 'admin-pass-123'): Promise<{ url: string; server: Server }> {
  const hub = new Hub(new MemoryStore(), adminPassword ? { ADMIN_PASSWORD: adminPassword } : {});
  const pages: Record<string, string> = { '/': 'dist/index.html', '/index.html': 'dist/index.html', '/open.html': 'dist/open.html' };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/api/')) return void serveApi(hub, req, res);
    const file = pages[path];
    if (!file) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file));
  });
  return { url: await listen(server), server };
}
