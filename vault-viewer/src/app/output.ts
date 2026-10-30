// Packaging the results: delivery sheet, key cards, and saving to a folder or a ZIP.

import { Zip, ZipPassThrough } from 'fflate';
import { formatDateTime, saveBlob } from '../shared/dom';
import { APP_NAME } from '../shared/config';
import { qrSvg } from './ui';

export interface RecipientOutput {
  recipient: string;
  password: string;
  keyText: string;
  keyFileText: string;
  vault: Blob;
  vaultName: string;
}

export interface BatchOutput {
  title: string;
  mode: 'online' | 'offline';
  serverName: string | null;
  createdAt: string;
  expiresAt: string | null;
  maxOpens: number | null;
  /** the viewer page for phones, if a server hosts one */
  phoneUrl: string | null;
  items: RecipientOutput[];
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || '未命名';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGE_CSS = `body{font:15px/1.6 system-ui,"Microsoft JhengHei","PingFang TC",sans-serif;color:#1c2330;max-width:820px;margin:32px auto;padding:0 20px}
h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:15px;word-break:break-all;background:#f3f4f6;padding:8px 10px;border-radius:6px}
.qr{width:160px;height:160px}.row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}.muted{color:#667085}
.warn{background:#fff4e0;border-radius:8px;padding:10px 14px}.card{border:1px solid #ddd;border-radius:10px;padding:16px 20px;margin:16px 0;page-break-inside:avoid}
ol li{margin:4px 0}@media print{.noprint{display:none}}`;

export function keyCardHtml(b: BatchOutput, it: RecipientOutput): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>金鑰卡 - ${esc(it.recipient)}</title><style>${PAGE_CSS}</style></head><body>
<h1>🔑 ${APP_NAME} 金鑰卡</h1>
<p>封存：<strong>${esc(b.title)}</strong>　收件人：<strong>${esc(it.recipient)}</strong></p>
<div class="card"><div class="row"><div class="qr">${qrSvg(it.keyText)}</div><div style="flex:1;min-width:240px">
<p><strong>金鑰文字</strong></p><p class="mono">${esc(it.keyText)}</p>
<p class="muted">手機可以用相機掃描左邊的 QR Code 取得金鑰文字。</p></div></div></div>
<h2>怎麼開啟</h2><ol>
<li>在電腦上雙擊 <strong>${esc(it.vaultName)}</strong>，會用瀏覽器（建議 Chrome 或 Edge）打開。</li>
<li>輸入發送者另外給你的<strong>密碼</strong>。</li>
<li>貼上上面的<strong>金鑰文字</strong>，或選擇 .key 金鑰檔。</li>
${b.mode === 'online' ? '<li>開啟時需要連上網路（由伺服器驗證）。</li>' : ''}
${b.phoneUrl ? `<li>手機打不開時，請改用 <a href="${esc(b.phoneUrl)}">${esc(b.phoneUrl)}</a> 選擇封存檔。</li>` : ''}</ol>
<p class="warn">請妥善保管這張金鑰卡，不要和封存檔、密碼放在同一個地方。</p>
</body></html>`;
}

export function deliverySheetHtml(b: BatchOutput): string {
  const items = b.items
    .map(
      (it) => `<div class="card"><h2 style="margin-top:0;border:0">${esc(it.recipient)}</h2>
<p>封存檔：<span class="mono">${esc(it.vaultName)}</span></p>
<p>密碼：<span class="mono">${esc(it.password)}</span></p>
<div class="row"><div class="qr">${qrSvg(it.keyText)}</div><div style="flex:1;min-width:240px"><p>金鑰：</p><p class="mono">${esc(it.keyText)}</p></div></div></div>`,
    )
    .join('\n');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付清單 - ${esc(b.title)}</title><style>${PAGE_CSS}</style></head><body>
<h1>📋 交付清單：${esc(b.title)}</h1>
<p class="warn"><strong>這份清單同時有密碼和金鑰，只給你自己看。</strong>請不要轉寄，用完建議刪除或妥善保存。</p>
<p>建立時間：${formatDateTime(b.createdAt)}　模式：${b.mode === 'online' ? `線上驗證（${esc(b.serverName ?? '')}）` : '離線'}　到期：${b.expiresAt ? formatDateTime(b.expiresAt) : '不限'}　次數：${b.maxOpens ?? '不限'}</p>
<h2>建議的交付方式（三樣東西分開傳）</h2><ol>
<li><strong>封存檔</strong>（.vault.html）：用雲端硬碟連結或隨身碟。不建議用 Email 附件，公司信箱可能會擋。</li>
<li><strong>金鑰</strong>：把金鑰卡或 .key 檔用另一個管道給，例如通訊軟體。</li>
<li><strong>密碼</strong>：再用第三個管道告訴對方，例如電話或簡訊。</li></ol>
${items}
</body></html>`;
}

const SHEET_NAME = '交付清單（只給自己看）.html';

function filesOf(b: BatchOutput): { path: string; data: Blob }[] {
  const out: { path: string; data: Blob }[] = [{ path: SHEET_NAME, data: new Blob([deliverySheetHtml(b)], { type: 'text/html' }) }];
  for (const it of b.items) {
    const dir = safeName(it.recipient);
    out.push({ path: `${dir}/${it.vaultName}`, data: it.vault });
    out.push({ path: `${dir}/${safeName(it.recipient)}.key`, data: new Blob([it.keyFileText], { type: 'text/plain' }) });
    out.push({ path: `${dir}/金鑰卡.html`, data: new Blob([keyCardHtml(b, it)], { type: 'text/html' }) });
  }
  return out;
}

export const canPickFolder = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

type DirHandle = {
  getDirectoryHandle(name: string, o: { create: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o: { create: boolean }): Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }>;
};

/** Writes everything into a new sub-folder of a folder the user picks. Returns the folder name. */
export async function saveToFolder(b: BatchOutput): Promise<string | null> {
  let root: DirHandle;
  try {
    root = await (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null; // cancelled
  }
  const stamp = b.createdAt.slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const folderName = `${safeName(b.title)}_${stamp}`;
  const base = await root.getDirectoryHandle(folderName, { create: true });
  for (const f of filesOf(b)) {
    const parts = f.path.split('/');
    let dir = base;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(f.data);
    await w.close();
  }
  return folderName;
}

export async function downloadZip(b: BatchOutput) {
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    parts.push(chunk);
  });
  for (const f of filesOf(b)) {
    const entry = new ZipPassThrough(f.path);
    zip.add(entry);
    entry.push(new Uint8Array(await f.data.arrayBuffer()), true);
  }
  zip.end();
  saveBlob(new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'application/zip' }), `${safeName(b.title)}.zip`);
}

export function downloadSheet(b: BatchOutput) {
  saveBlob(new Blob([deliverySheetHtml(b)], { type: 'text/html' }), SHEET_NAME);
}

export function downloadKeyCard(b: BatchOutput, it: RecipientOutput) {
  saveBlob(new Blob([keyCardHtml(b, it)], { type: 'text/html' }), `金鑰卡_${safeName(it.recipient)}.html`);
}
