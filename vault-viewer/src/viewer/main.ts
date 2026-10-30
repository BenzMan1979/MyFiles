import './style.css';
import { textToKey } from '../core/keytext';
import { ChunkReader, readFile, readPayloadFromDocument, readPayloadFromHtml, type FileEntry, type Payload } from '../core/format';
import { formatSize } from '../core/mime';
import { APP_NAME, HOSTED_OPEN_URL } from '../shared/config';
import { clear, formatDateTime, h, saveBlob } from '../shared/dom';
import { installAutoLock, installGuards, watermarkBackground, watermarkText } from './protect';
import { iconFor, renderPreview } from './preview';
import { offlineLockedOut, unlockVault, UnlockError, type OpenedVault } from './unlock';

const app = document.getElementById('app')!;
const embedded = !!document.getElementById('vault-header');

/** Key stays in memory for the page so an idle re-lock only asks for the password. */
let cachedKey: Uint8Array | null = null;

function boot() {
  if (!embedded) return showPicker();
  try {
    showUnlock(readPayloadFromDocument(document)!);
  } catch (e) {
    showFatal((e as Error).message);
  }
}

function showFatal(message: string) {
  clear(app);
  app.append(h('div', { class: 'center-screen' }, h('div', { class: 'card' }, h('h1', null, APP_NAME), h('p', { class: 'error' }, message))));
}

// ---------- hosted page: pick a vault file ----------

function showPicker(error?: string) {
  clear(app);
  const input = h('input', { type: 'file', accept: '.html,.htm', hidden: true });
  const status = h('p', { class: error ? 'error' : 'muted' }, error ?? '');
  const load = async (file: File) => {
    status.className = 'muted';
    status.textContent = `正在讀取 ${file.name}（${formatSize(file.size)}）…`;
    try {
      showUnlock(readPayloadFromHtml(await file.text()));
    } catch (e) {
      showPicker((e as Error).message);
    }
  };
  input.addEventListener('change', () => input.files?.[0] && load(input.files[0]));
  const zone = h(
    'div',
    { class: 'dropzone', tabindex: 0, onclick: () => input.click(), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && input.click() },
    h('div', { class: 'big-icon' }, '🔐'),
    h('p', null, h('strong', null, '選擇封存檔'), '（.vault.html）'),
    h('p', { class: 'muted' }, '或把檔案拖到這裡'),
  );
  dropTarget(zone, (f) => load(f));
  app.append(
    h('div', { class: 'center-screen' },
      h('div', { class: 'card' },
        h('h1', null, APP_NAME, ' 檢視器'),
        h('p', { class: 'muted' }, '在手機或任何瀏覽器開啟封存檔。檔案只會在這台裝置上解密，不會上傳到任何地方。'),
        zone, input, status,
      ),
    ),
  );
}

function dropTarget(el: HTMLElement, onFile: (f: File) => void) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

// ---------- unlock ----------

function showUnlock(payload: Payload, notice?: string) {
  const { header } = payload;
  document.title = header.title || APP_NAME;
  clear(app);

  const pw = h('input', { type: 'password', class: 'input', autocomplete: 'off', placeholder: '輸入密碼', 'aria-label': '密碼' });
  const showPw = h('button', { type: 'button', class: 'btn ghost small', onclick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; showPw.textContent = pw.type === 'password' ? '顯示' : '隱藏'; } }, '顯示');
  const keyText = h('textarea', { class: 'input key-input', rows: 3, spellcheck: 'false', placeholder: '貼上金鑰文字（VK1-…），或把 .key 金鑰檔拖到這裡', 'aria-label': '金鑰' });
  const keyStatus = h('p', { class: 'hint' });
  const keyFile = h('input', { type: 'file', accept: '.key,.txt', hidden: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary wide' }, '解鎖');

  const checkKey = () => {
    const v = keyText.value.trim();
    if (!v) {
      keyStatus.textContent = '';
      return;
    }
    const r = textToKey(v);
    keyStatus.className = r.ok ? 'hint ok' : 'hint bad';
    keyStatus.textContent = r.ok ? '✓ 金鑰格式正確' : r.reason === 'checksum' ? '✗ 金鑰有打錯的字，請再核對一次' : '✗ 看起來不是金鑰（應以 VK1- 開頭）';
  };
  keyText.addEventListener('input', checkKey);
  const loadKeyFile = async (f: File) => {
    keyText.value = (await f.text()).slice(0, 4000);
    checkKey();
  };
  keyFile.addEventListener('change', () => keyFile.files?.[0] && loadKeyFile(keyFile.files[0]));
  dropTarget(keyText, loadKeyFile);

  let keyBlock: HTMLElement;
  if (cachedKey) {
    keyBlock = h('div', { class: 'field' },
      h('div', { class: 'label' }, '金鑰'),
      h('p', { class: 'hint ok' }, '✓ 金鑰已載入 ', h('button', { type: 'button', class: 'link', onclick: () => { cachedKey = null; showUnlock(payload, notice); } }, '更換金鑰')),
    );
  } else {
    keyBlock = h('div', { class: 'field' },
      h('div', { class: 'label-row' }, h('label', { class: 'label' }, '金鑰'), h('button', { type: 'button', class: 'btn ghost small', onclick: () => keyFile.click() }, '選擇金鑰檔…')),
      keyText, keyStatus, keyFile,
    );
  }

  const locked = offlineLockedOut(header);
  const form = h('form', { class: 'card unlock', autocomplete: 'off' },
    h('div', { class: 'brand' }, '🔐 ', APP_NAME),
    h('h1', null, header.title || '加密文件'),
    h('div', { class: 'chips' },
      header.mode === 'online'
        ? h('span', { class: 'chip' }, '🌐 線上驗證', h('span', { class: 'muted' }, ` · ${hostOf(header.server)}`))
        : h('span', { class: 'chip' }, '📴 離線封存'),
    ),
    notice ? h('p', { class: 'notice' }, notice) : null,
    h('div', { class: 'field' }, h('div', { class: 'label-row' }, h('label', { class: 'label' }, '密碼'), showPw), pw),
    keyBlock,
    error,
    submit,
    h('p', { class: 'foot muted' }, '所有解密都在這台裝置上進行。', header.mode === 'online' ? '開啟時需要連上網路。' : ''),
    embedded ? h('p', { class: 'foot muted small' }, '在 iPhone／手機打不開？請改用 ', h('a', { href: HOSTED_OPEN_URL, target: '_blank', rel: 'noopener' }, '線上檢視頁'), ' 選擇這個檔案。') : null,
  );
  if (locked) {
    error.textContent = '密碼錯誤次數過多，這份封存檔在此裝置上已鎖定';
    submit.disabled = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    let key = cachedKey;
    if (!key) {
      const r = textToKey(keyText.value);
      if (!r.ok) {
        error.textContent = keyText.value.trim() ? '金鑰不正確，請檢查是否完整貼上' : '請貼上金鑰文字或選擇金鑰檔';
        return;
      }
      key = r.key;
    }
    if (!pw.value) {
      error.textContent = '請輸入密碼';
      pw.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = header.mode === 'online' ? '驗證中（連線伺服器）…' : '驗證中…';
    try {
      const opened = await unlockVault(header, pw.value, key);
      cachedKey = key;
      showMain(payload, opened);
    } catch (err) {
      const ue = err instanceof UnlockError ? err : new UnlockError(`發生錯誤：${(err as Error).message}`);
      error.textContent = ue.message;
      submit.textContent = '解鎖';
      submit.disabled = ue.final;
      if (!ue.final) {
        pw.select();
        pw.focus();
      }
    }
  });

  app.append(h('div', { class: 'center-screen' }, form));
  (cachedKey ? pw : pw).focus();
}

const hostOf = (url: string | null) => {
  try {
    return new URL(url ?? '').host;
  } catch {
    return url ?? '';
  }
};

// ---------- main explorer ----------

interface TreeNode {
  name: string;
  path: string;
  dirs: Map<string, TreeNode>;
  files: FileEntry[];
}

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { name: dir, path: node.path ? `${node.path}/${dir}` : dir, dirs: new Map(), files: [] };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const baseName = (p: string) => p.split('/').pop() ?? p;

function showMain(payload: Payload, opened: OpenedVault) {
  const { header } = payload;
  const { manifest, contentKey, status } = opened;
  const prot = manifest.protection;
  const openedAt = new Date();
  const reader = new ChunkReader(payload);
  const cleanups: (() => void)[] = [];
  let disposePreview: (() => void) | null = null;
  let current: FileEntry | null = null;
  let renderSeq = 0;
  let lockedOnce = false;

  const lock = (reason: string) => {
    if (lockedOnce) return;
    lockedOnce = true;
    disposePreview?.();
    cleanups.forEach((f) => f());
    reader.clear();
    showUnlock(payload, reason);
  };

  clear(app);
  cleanups.push(installGuards(prot));
  cleanups.push(installAutoLock(prot, lock));

  // header bar
  const remaining = status.maxOpens != null ? Math.max(0, status.maxOpens - status.opens) : null;
  const sidebarToggle = h('button', { class: 'btn ghost small only-narrow', onclick: () => shell.classList.toggle('show-side') }, '☰ 檔案');
  const topbar = h('header', { class: 'topbar' },
    sidebarToggle,
    h('div', { class: 'title' }, h('strong', null, manifest.title || header.title), manifest.recipient ? h('span', { class: 'muted' }, ` · 給 ${manifest.recipient}`) : null),
    h('div', { class: 'chips' },
      remaining != null ? h('span', { class: 'chip', title: `已開啟 ${status.opens} 次` }, `剩餘 ${remaining} 次`) : null,
      status.expiresAt ? h('span', { class: 'chip' }, `到期 ${formatDateTime(status.expiresAt)}`) : null,
      header.mode === 'offline' ? h('span', { class: 'chip' }, '離線') : null,
    ),
    h('button', { class: 'btn small', onclick: () => lock('已上鎖') }, '🔒 上鎖'),
  );

  // sidebar
  const search = h('input', { class: 'input', type: 'search', placeholder: '搜尋檔名…', 'aria-label': '搜尋檔名' });
  const treeEl = h('nav', { class: 'tree', 'aria-label': '檔案列表' });
  const tree = buildTree(manifest.files);
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  const side = h('aside', { class: 'sidebar protected' },
    search, treeEl,
    h('div', { class: 'side-foot muted' }, `${manifest.files.length} 個檔案 · ${formatSize(total)}`),
  );

  // content
  const fileBar = h('div', { class: 'filebar' });
  const box = h('div', { class: 'preview' });
  const scroll = h('div', { class: 'preview-scroll protected' }, box);
  const overlay = h('div', { class: 'watermark', 'aria-hidden': 'true' });
  const content = h('main', { class: 'content' }, fileBar, h('div', { class: 'stage' }, scroll, overlay));
  const shell = h('div', { class: 'shell' }, topbar, h('div', { class: 'body' }, side, content));
  app.append(shell);

  if (prot.watermark.enabled) {
    const text = watermarkText(prot, { recipient: manifest.recipient || '', note: manifest.note, openedAt, ip: opened.client?.ip, country: opened.client?.country, tag: opened.tag });
    overlay.style.backgroundImage = watermarkBackground(text, Math.max(0.04, Math.min(0.5, prot.watermark.opacity)));
    // Deterrent: if the mark is removed or hidden (for example from developer tools), lock again.
    const watch = setInterval(() => {
      const cs = getComputedStyle(overlay);
      if (!overlay.isConnected || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.5 || !cs.backgroundImage.includes('svg') || overlay.offsetWidth < 50) {
        lock('偵測到浮水印被移除或隱藏，已自動上鎖');
      }
    }, 1500);
    cleanups.push(() => clearInterval(watch));
  }

  const welcome = () => {
    clear(fileBar);
    clear(box);
    box.append(h('div', { class: 'empty' },
      h('div', { class: 'big-icon' }, '📂'),
      h('p', null, '從左側選擇一個檔案來檢視'),
      h('p', { class: 'muted' }, `共 ${manifest.files.length} 個檔案`),
    ));
  };

  const download = async (entry: FileEntry) => {
    if (!prot.allowDownload) return;
    const data = await readFile(header, reader, entry, contentKey);
    saveBlob(new Blob([data as Uint8Array<ArrayBuffer>], { type: entry.mime }), baseName(entry.path));
  };

  const select = async (entry: FileEntry) => {
    current = entry;
    shell.classList.remove('show-side');
    treeEl.querySelectorAll('.file.active').forEach((el) => el.classList.remove('active'));
    treeEl.querySelector(`[data-id="${entry.id}"]`)?.classList.add('active');
    const seq = ++renderSeq;
    disposePreview?.();
    disposePreview = null;
    clear(fileBar);
    fileBar.append(
      h('span', { class: 'file-icon' }, iconFor(entry)),
      h('span', { class: 'file-name', title: entry.path }, baseName(entry.path)),
      h('span', { class: 'muted small' }, formatSize(entry.size)),
      h('span', { class: 'spacer' }),
    );
    if (prot.allowDownload) fileBar.append(h('button', { class: 'btn small', onclick: () => download(entry) }, '⬇ 下載'));
    clear(box);
    box.append(h('div', { class: 'empty' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, '解密中…')));
    scroll.scrollTop = 0;
    try {
      const data = await readFile(header, reader, entry, contentKey);
      if (seq !== renderSeq) return;
      clear(box);
      const dispose = await renderPreview(box, entry, data, { allowDownload: prot.allowDownload, download: () => download(entry) });
      if (seq !== renderSeq) dispose();
      else disposePreview = dispose;
    } catch (e) {
      if (seq !== renderSeq) return;
      clear(box);
      box.append(h('div', { class: 'empty' }, h('p', { class: 'error' }, `無法開啟這個檔案：${(e as Error).message || '內容可能已損毀'}`)));
    }
  };

  const fileRow = (f: FileEntry, depth: number, label = baseName(f.path)) =>
    h('button', {
      class: `file ${current?.id === f.id ? 'active' : ''}`,
      'data-id': f.id,
      style: `padding-left:${12 + depth * 16}px`,
      title: f.path,
      onclick: () => select(f),
    }, h('span', { class: 'file-icon' }, iconFor(f)), h('span', { class: 'file-label' }, label));

  const expanded = new Set<string>();
  const autoExpand = manifest.files.length <= 60;
  const renderNode = (node: TreeNode, depth: number, out: HTMLElement[]) => {
    for (const d of [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name))) {
      const open = expanded.has(d.path) || (autoExpand && !expanded.has(`!${d.path}`));
      out.push(h('button', {
        class: 'folder',
        style: `padding-left:${12 + depth * 16}px`,
        'aria-expanded': String(open),
        onclick: () => {
          if (open) {
            expanded.delete(d.path);
            expanded.add(`!${d.path}`);
          } else {
            expanded.add(d.path);
            expanded.delete(`!${d.path}`);
          }
          renderTree();
        },
      }, h('span', { class: 'caret' }, open ? '▾' : '▸'), h('span', { class: 'file-icon' }, open ? '📂' : '📁'), h('span', { class: 'file-label' }, d.name)));
      if (open) renderNode(d, depth + 1, out);
    }
    for (const f of [...node.files].sort((a, b) => collator.compare(baseName(a.path), baseName(b.path)))) out.push(fileRow(f, depth));
  };

  const renderTree = () => {
    clear(treeEl);
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = manifest.files.filter((f) => f.path.toLowerCase().includes(q));
      if (!hits.length) treeEl.append(h('p', { class: 'muted pad' }, '找不到符合的檔案'));
      for (const f of hits) treeEl.append(fileRow(f, 0, f.path));
      return;
    }
    const rows: HTMLElement[] = [];
    renderNode(tree, 0, rows);
    treeEl.append(...rows);
  };
  search.addEventListener('input', renderTree);
  renderTree();

  if (manifest.files.length === 1) void select(manifest.files[0]);
  else welcome();
}

boot();
