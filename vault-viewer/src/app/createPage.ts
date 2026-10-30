import template from '../generated/viewer-template.html?raw';
import { randomBytes, toB64 } from '../core/bytes';
import { buildVault, DEFAULT_POLICY, DEFAULT_PROTECTION, renderVaultHtml, type InputFile, type Policy, type Protection } from '../core/format';
import { generatePassword, keyFileContent, keyToText, randomId } from '../core/keytext';
import { extOf, formatSize, guessMime, kindOf } from '../core/mime';
import { formatDateTime, h, saveBlob } from '../shared/dom';
import { DENSITY_LABELS, describeDevice, watermarkBackground, watermarkStyle, watermarkText, WATERMARK_SIZE_RANGE } from '../viewer/protect';
import { api, phoneViewerUrl, servers, tokens } from './api';
import { decodeCsv, parseRecipients, templateCsv } from './csv';
import { settings } from '../shared/settings';
import { canPickFolder, downloadKeyCard, downloadSheet, downloadZip, safeName, saveToFolder, type BatchOutput } from './output';
import { loginDialog } from './serverPage';
import { confirmDialog, copyButton, field, fromLocalInput, modal, qrElement, section, toast, toggle, toLocalInput } from './ui';

const SIZE_LIMIT = settings.limits.maxTotalMB * 1024 * 1024;
const MAX_RECIPIENTS = settings.limits.maxRecipients;
const MIN_PASSWORD = settings.limits.minPasswordLength;
const IMPORT_LIMITS = { maxRecipients: MAX_RECIPIENTS, minPassword: MIN_PASSWORD };

interface Draft {
  files: { file: File; path: string }[];
  title: string;
  mode: 'online' | 'offline';
  serverId: string;
  notBefore: string; // datetime-local value
  expiryPreset: 'none' | '7' | '30' | '90' | 'custom';
  expiryCustom: string;
  limitOpens: boolean;
  maxOpens: number;
  policy: Policy;
  protection: Protection;
  recipients: { name: string; password: string; note: string }[];
  samePassword: boolean;
  sharedPassword: string;
}

function newDraft(): Draft {
  const d = settings.defaults;
  const days = d.expiryDays;
  const preset: Draft['expiryPreset'] = days === null ? 'none' : days === 7 || days === 30 || days === 90 ? (String(days) as '7' | '30' | '90') : 'custom';
  return {
    files: [],
    title: '',
    mode: 'online',
    serverId: servers.defaultId(),
    notBefore: '',
    expiryPreset: preset,
    expiryCustom: preset === 'custom' ? toLocalInput(new Date(Date.now() + days! * 86400_000).toISOString()) : '',
    limitOpens: false,
    maxOpens: 5,
    policy: { ...DEFAULT_POLICY, maxFailures: d.maxFailures, sessionMinutes: d.sessionMinutes },
    protection: {
      ...structuredClone(DEFAULT_PROTECTION),
      watermark: { ...d.watermark },
      allowCopy: d.allowCopy,
      allowPrint: d.allowPrint,
      allowDownload: d.allowDownload,
      idleLockMinutes: d.idleLockMinutes,
      blurLockSeconds: d.blurLockSeconds,
    },
    recipients: [{ name: '', password: generatePassword(), note: '' }],
    samePassword: false,
    sharedPassword: generatePassword(),
  };
}

let draft = newDraft();
let stepIndex = 0;
let lastOutput: BatchOutput | null = null;

const STEPS = ['選擇檔案', '基本設定', '使用條件', '防護設定', '收件人', '產生'];

export function renderCreate(root: HTMLElement, rerender: () => void) {
  if (lastOutput) return renderResult(root, lastOutput, rerender);
  root.append(
    h('div', { class: 'page-head' }, h('h1', null, '📦 建立封存檔'), h('p', { class: 'muted' }, '跟著下面的步驟，把文件加密成封存檔。每一步都可以回頭修改。')),
    h('ol', { class: 'stepper' },
      ...STEPS.map((s, i) =>
        h('li', { class: i === stepIndex ? 'current' : i < stepIndex ? 'done' : '' },
          h('button', { type: 'button', disabled: i > stepIndex, onclick: () => go(i) }, h('span', { class: 'n' }, i < stepIndex ? '✓' : String(i + 1)), s)),
      ),
    ),
  );
  const body = h('div', { class: 'step-content' });
  root.append(body);
  const err = h('p', { class: 'error', role: 'alert' });
  const pages = [stepFiles, stepBasics, stepPolicy, stepProtection, stepRecipients, stepGenerate];
  pages[stepIndex](body, rerender);
  const next = h('button', { class: 'btn primary' }, stepIndex === STEPS.length - 2 ? '下一步：確認並產生 →' : '下一步 →');
  next.addEventListener('click', () => {
    const problem = validate(stepIndex);
    if (problem) {
      err.textContent = problem;
      return;
    }
    go(stepIndex + 1);
  });
  root.append(
    err,
    h('div', { class: 'nav-buttons' },
      stepIndex > 0 ? h('button', { class: 'btn', onclick: () => go(stepIndex - 1) }, '← 上一步') : h('span'),
      stepIndex < STEPS.length - 1 ? next : h('span'),
    ),
  );

  function go(i: number) {
    stepIndex = i;
    rerender();
    window.scrollTo(0, 0);
  }
}

function validate(i: number): string | null {
  if (i === 0 && !draft.files.length) return '請至少加入一個檔案';
  if (i === 1) {
    if (!draft.title.trim()) return '請輸入封存名稱';
    if (draft.mode === 'online' && !servers.get(draft.serverId)) return '線上模式需要先選擇伺服器（或到「伺服器設定」新增一台）';
  }
  if (i === 2) {
    if (draft.expiryPreset === 'custom' && !draft.expiryCustom) return '請選擇到期時間';
    const exp = expiresAt();
    if (exp && Date.parse(exp) <= Date.now()) return '到期時間必須在未來';
    if (draft.notBefore && exp && Date.parse(fromLocalInput(draft.notBefore)!) >= Date.parse(exp)) return '開始時間必須早於到期時間';
    if (draft.limitOpens && (!Number.isInteger(draft.maxOpens) || draft.maxOpens < 1)) return '可開啟次數至少 1 次';
  }
  if (i === 4) {
    const names = draft.recipients.map((r) => r.name.trim());
    if (names.some((n) => !n)) return '每位收件人都要填名稱';
    if (new Set(names).size !== names.length) return '收件人名稱不能重複';
    if (draft.recipients.length > MAX_RECIPIENTS) return `一次最多 ${MAX_RECIPIENTS} 位收件人，請分批建立`;
    const pws = draft.samePassword ? [draft.sharedPassword] : draft.recipients.map((r) => r.password);
    if (pws.some((p) => p.length < MIN_PASSWORD)) return `密碼至少 ${MIN_PASSWORD} 個字元（建議使用自動產生的密碼）`;
  }
  return null;
}

function expiresAt(): string | null {
  if (draft.expiryPreset === 'none') return null;
  if (draft.expiryPreset === 'custom') return fromLocalInput(draft.expiryCustom);
  return new Date(Date.now() + Number(draft.expiryPreset) * 86400_000).toISOString();
}

// ---------- step 1: files ----------

function fileWarning(path: string): string | null {
  const ext = extOf(path);
  if (ext === 'pptx' || ext === 'ppt') return '簡報無法直接預覽：請先用 PowerPoint「檔案 → 匯出 → 建立 PDF」，再加入 PDF。';
  if (ext === 'doc' || ext === 'xls') return '舊版 Office 格式無法預覽，建議另存為 PDF。';
  if (ext === 'docx' || ext === 'xlsx') return 'Word／Excel 預覽將在下一版加入；版面重要的話建議另存為 PDF。';
  if (['mov', 'avi', 'wmv', 'mkv', 'flv'].includes(ext)) return '這個影片格式瀏覽器可能無法播放，建議轉成 MP4（H.264）。';
  if (kindOf(path, guessMime(path)) === 'other') return '這個類型無法預覽，只能在允許下載時下載原檔。';
  return null;
}

async function collectEntries(items: DataTransferItemList): Promise<{ file: File; path: string }[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?(cb: (f: File) => void, err: (e: unknown) => void): void; createReader?(): { readEntries(cb: (e: Entry[]) => void, err: (e: unknown) => void): void } };
  const out: { file: File; path: string }[] = [];
  const walk = async (e: Entry): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((ok, bad) => e.file!(ok, bad));
      out.push({ file: f, path: e.fullPath.replace(/^\//, '') });
    } else if (e.isDirectory) {
      const reader = e.createReader!();
      for (;;) {
        const batch = await new Promise<Entry[]>((ok, bad) => reader.readEntries(ok, bad));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  const entries = Array.from(items)
    .map((i) => i.webkitGetAsEntry?.() as unknown as Entry | null)
    .filter((e): e is Entry => !!e);
  for (const e of entries) await walk(e);
  return out;
}

function addFiles(list: { file: File; path: string }[]) {
  const map = new Map(draft.files.map((f) => [f.path, f]));
  for (const f of list) {
    if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(f.path)) continue;
    map.set(f.path.replace(/\\/g, '/'), f);
  }
  draft.files = [...map.values()];
  if (!draft.title && draft.files.length) {
    const top = draft.files[0].path.split('/');
    draft.title = top.length > 1 ? top[0] : draft.files[0].file.name.replace(/\.[^.]+$/, '');
  }
}

function stepFiles(body: HTMLElement, rerender: () => void) {
  const pickFiles = h('input', { type: 'file', multiple: true, hidden: true });
  const pickDir = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  pickFiles.addEventListener('change', () => {
    addFiles(Array.from(pickFiles.files ?? [], (f) => ({ file: f, path: f.name })));
    rerender();
  });
  pickDir.addEventListener('change', () => {
    addFiles(Array.from(pickDir.files ?? [], (f) => ({ file: f, path: (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name })));
    rerender();
  });
  const zone = h('div', { class: 'dropzone' },
    h('div', { class: 'big-icon' }, '📥'),
    h('p', null, h('strong', null, '把檔案或資料夾拖到這裡')),
    h('p', { class: 'muted' }, '資料夾結構會保留，收件人看到的就是同樣的資料夾'),
    h('div', { class: 'row-buttons' },
      h('button', { type: 'button', class: 'btn', onclick: () => pickFiles.click() }, '加入檔案…'),
      h('button', { type: 'button', class: 'btn', onclick: () => pickDir.click() }, '加入資料夾…'),
    ),
  );
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer?.items?.length) addFiles(await collectEntries(e.dataTransfer.items));
    rerender();
  });
  body.append(zone, pickFiles, pickDir);

  if (!draft.files.length) return;
  const total = draft.files.reduce((n, f) => n + f.file.size, 0);
  const pct = Math.min(100, (total / SIZE_LIMIT) * 100);
  const sorted = [...draft.files].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant', { numeric: true }));
  body.append(
    section(`已加入 ${draft.files.length} 個檔案`,
      h('div', { class: 'size-meter' },
        h('div', { class: 'size-bar' }, h('div', { class: `size-fill ${total > SIZE_LIMIT ? 'over' : ''}`, style: `width:${pct}%` })),
        h('span', { class: 'muted small' }, `${formatSize(total)} ／ 建議上限 ${formatSize(SIZE_LIMIT)}`),
      ),
      total > settings.limits.phoneMB * 1024 * 1024 && total <= SIZE_LIMIT
        ? h('p', { class: 'note' }, `超過 ${settings.limits.phoneMB}MB 的封存檔，電腦開得起來，但手機（特別是 iPhone）可能因為記憶體不足而打不開。收件人用手機的話，建議分成較小的幾份。`)
        : null,
      total > SIZE_LIMIT ? h('p', { class: 'note warn' }, `總大小超過 ${settings.limits.maxTotalMB}MB，收件人開啟時可能很慢或開不起來。建議先壓縮影片，或分成幾份封存。`) : null,
      h('div', { class: 'file-table' },
        ...sorted.map((f) => {
          const warn = fileWarning(f.path);
          return h('div', { class: 'file-row' },
            h('span', { class: 'mono path', title: f.path }, f.path),
            h('span', { class: 'muted small' }, formatSize(f.file.size)),
            h('button', { class: 'btn ghost small', title: '移除', onclick: () => { draft.files = draft.files.filter((x) => x !== f); rerender(); } }, '✕'),
            warn ? h('p', { class: 'file-warn' }, '⚠️ ', warn) : null,
          );
        }),
      ),
      h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('清除全部檔案', '確定要清除已加入的所有檔案嗎？', '清除', true)) { draft.files = []; rerender(); } } }, '清除全部'),
    ),
  );
}

// ---------- step 2: basics ----------

function stepBasics(body: HTMLElement, rerender: () => void) {
  const title = h('input', { class: 'input', value: draft.title, maxlength: 100, placeholder: '例如：2026 年度合約' });
  title.addEventListener('input', () => (draft.title = title.value));
  const list = servers.list();
  const modeCard = (mode: 'online' | 'offline', icon: string, name: string, desc: string, badge?: string) =>
    h('label', { class: `choice ${draft.mode === mode ? 'selected' : ''}` },
      h('input', { type: 'radio', name: 'mode', checked: draft.mode === mode, onchange: () => { draft.mode = mode; rerender(); } }),
      h('div', null, h('div', { class: 'choice-title' }, icon, ' ', name, badge ? h('span', { class: 'chip ok', style: 'margin-left:6px' }, badge) : null), h('p', { class: 'muted small' }, desc)),
    );

  let serverBlock: Node | null = null;
  if (draft.mode === 'online') {
    if (!list.length) {
      serverBlock = h('p', { class: 'note warn' }, '還沒有設定伺服器。請先到 ', h('a', { href: '#servers' }, '伺服器設定'), ' 照步驟建立一台（大約 5 分鐘）。');
    } else {
      if (!servers.get(draft.serverId)) draft.serverId = servers.default()!.id;
      const sel = h('select', { class: 'input' }, ...list.map((s) => h('option', { value: s.id, selected: s.id === draft.serverId }, `${s.name}（${s.url.replace(/^https?:\/\//, '')}）`)));
      sel.addEventListener('change', () => (draft.serverId = sel.value));
      serverBlock = field('使用哪台伺服器', sel);
    }
  }

  body.append(
    section('封存名稱',
      field('名稱', title, '會顯示在解鎖畫面和瀏覽器分頁上（這個名稱本身不加密，請不要放機密字眼）。'),
    ),
    section('驗證模式',
      h('div', { class: 'choices' },
        modeCard('online', '🌐', '線上驗證', '開啟時要連網，由伺服器檢查次數與期限。可以隨時收回、查看開啟紀錄。適合給別人看。', '建議'),
        modeCard('offline', '📴', '離線', '不用網路就能開。次數與期限只記在對方電腦上，懂技術的人可以繞過。適合自己隨身備份。'),
      ),
      serverBlock,
    ),
  );
}

// ---------- step 3: policy ----------

function stepPolicy(body: HTMLElement, rerender: () => void) {
  const p = draft.policy;
  const presets: [Draft['expiryPreset'], string][] = [['none', '不限期'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['custom', '自訂']];
  const expiryButtons = h('div', { class: 'seg' },
    ...presets.map(([v, label]) => h('button', { type: 'button', class: draft.expiryPreset === v ? 'on' : '', onclick: () => { draft.expiryPreset = v; rerender(); } }, label)),
  );
  const custom = h('input', { type: 'datetime-local', class: 'input', value: draft.expiryCustom });
  custom.addEventListener('change', () => (draft.expiryCustom = custom.value));
  const exp = expiresAt();

  const notBefore = h('input', { type: 'datetime-local', class: 'input', value: draft.notBefore });
  notBefore.addEventListener('change', () => (draft.notBefore = notBefore.value));

  const opens = h('input', { type: 'number', class: 'input narrow', min: 1, value: draft.maxOpens });
  opens.addEventListener('input', () => (draft.maxOpens = Number(opens.value)));
  const fails = h('input', { type: 'number', class: 'input narrow', min: 0, max: 100, value: p.maxFailures });
  fails.addEventListener('input', () => (p.maxFailures = Math.max(0, Number(fails.value) || 0)));
  const sess = h('input', { type: 'number', class: 'input narrow', min: 0, max: 1440, value: p.sessionMinutes });
  sess.addEventListener('input', () => (p.sessionMinutes = Math.max(0, Number(sess.value) || 0)));

  body.append(
    draft.mode === 'offline' ? h('p', { class: 'note warn' }, '離線模式：以下限制只記錄在對方的瀏覽器裡，只能防君子。需要確實限制請改用線上驗證。') : '',
    section('有效期間',
      field('到期', h('div', null, expiryButtons, draft.expiryPreset === 'custom' ? custom : null),
        exp ? `將在 ${formatDateTime(exp)} 到期（從按下「產生」那一刻起算）` : '永遠可以開啟（仍可隨時從管理頁收回）'),
      field('開始時間（選填）', notBefore, '在這之前打不開。留空表示立刻可以開啟。'),
    ),
    section('開啟次數',
      h('div', { class: 'seg' },
        h('button', { type: 'button', class: draft.limitOpens ? '' : 'on', onclick: () => { draft.limitOpens = false; rerender(); } }, '不限次數'),
        h('button', { type: 'button', class: draft.limitOpens ? 'on' : '', onclick: () => { draft.limitOpens = true; rerender(); } }, '限制次數'),
      ),
      draft.limitOpens ? field('每位收件人最多可以開啟', h('div', { class: 'inline' }, opens, h('span', null, '次'))) : null,
      field('上鎖後免重算時間', h('div', { class: 'inline' }, sess, h('span', null, '分鐘')), '自動上鎖後，在這段時間內重新輸入密碼解鎖不會多算一次。0 表示每次解鎖都算。'),
    ),
    section('密碼錯誤保護',
      field('密碼錯誤幾次就鎖定', h('div', { class: 'inline' }, fails, h('span', null, '次')), '0 表示不鎖定。線上模式被鎖定後，可以在「管理封存檔」解除。'),
    ),
  );
}

// ---------- step 4: protection ----------

function stepProtection(body: HTMLElement, rerender: () => void) {
  const pr = draft.protection;
  const wmText = h('input', { class: 'input', value: pr.watermark.text });
  const sample = () => ({
    recipient: draft.recipients[0]?.name || '王小明',
    note: draft.recipients[0]?.note || '財務部 NB-0123',
    openedAt: new Date(),
    ip: draft.mode === 'online' ? '203.0.113.8' : null,
    country: draft.mode === 'online' ? 'TW' : null,
    tag: 'A7K2Q9',
    device: describeDevice(),
  });
  const preview = h('div', { class: 'wm-preview' }, h('div', { class: 'wm-doc' }, h('p', null, '文件內容預覽'), h('p', { class: 'muted' }, '浮水印會斜斜地重複蓋在內容上方。')));
  const paint = () => {
    preview.style.backgroundImage = pr.watermark.enabled ? watermarkBackground(watermarkText(pr, sample()), pr.watermark.opacity, pr.watermark.size, pr.watermark.density) : 'none';
  };
  wmText.addEventListener('input', () => {
    pr.watermark.text = wmText.value;
    paint();
  });
  const opacity = h('input', { type: 'range', min: 4, max: 40, value: Math.round(pr.watermark.opacity * 100) });
  opacity.addEventListener('input', () => {
    pr.watermark.opacity = Number(opacity.value) / 100;
    paint();
  });
  const wm = watermarkStyle(pr.watermark);
  const sizeLabel = h('span', { class: 'range-value' }, `${wm.size} px`);
  const sizeInput = h('input', { type: 'range', 'data-wm': 'size', min: WATERMARK_SIZE_RANGE.min, max: 40, value: wm.size });
  sizeInput.addEventListener('input', () => {
    pr.watermark.size = Number(sizeInput.value);
    sizeLabel.textContent = `${pr.watermark.size} px`;
    paint();
  });
  const densityLabel = h('span', { class: 'range-value' }, DENSITY_LABELS[wm.density - 1]);
  const densityInput = h('input', { type: 'range', 'data-wm': 'density', min: 1, max: 5, step: 1, value: wm.density });
  densityInput.addEventListener('input', () => {
    pr.watermark.density = Number(densityInput.value);
    densityLabel.textContent = DENSITY_LABELS[pr.watermark.density - 1];
    paint();
  });
  const token = (t: string) => h('button', { type: 'button', class: 'btn small', onclick: () => { wmText.value += t; pr.watermark.text = wmText.value; paint(); } }, `＋${t}`);
  const preset = (label: string, text: string) => h('button', { type: 'button', class: 'btn small', onclick: () => { pr.watermark.text = text; rerender(); } }, label);
  const online = draft.mode === 'online';
  paint();

  const idle = h('select', { class: 'input narrow' }, ...[0, 5, 10, 15, 30, 60].map((m) => h('option', { value: m, selected: pr.idleLockMinutes === m }, m ? `${m} 分鐘` : '不啟用')));
  idle.addEventListener('change', () => (pr.idleLockMinutes = Number(idle.value)));
  const blur = h('select', { class: 'input narrow' }, ...[0, 10, 30, 60, 300].map((s) => h('option', { value: s, selected: pr.blurLockSeconds === s }, s ? (s >= 60 ? `${s / 60} 分鐘` : `${s} 秒`) : '不啟用')));
  blur.addEventListener('change', () => (pr.blurLockSeconds = Number(blur.value)));

  body.append(
    section('浮水印',
      toggle('顯示浮水印', pr.watermark.enabled, (v) => { pr.watermark.enabled = v; rerender(); }, '在內容上蓋收件人名稱與時間，截圖或翻拍外流時可以追查來源。'),
      pr.watermark.enabled
        ? h('div', null,
            h('div', { class: 'field' },
              h('div', { class: 'label' }, '常用樣式'),
              h('div', { class: 'row-buttons', style: 'margin-top:0' },
                preset('簡單：名字＋時間', '{收件人}  {時間}'),
                preset(online ? '追蹤：名字＋IP＋編號' : '追蹤：名字＋裝置＋編號', online ? '{收件人}  {IP}  {編號}  {時間}' : '{收件人}  {裝置}  {編號}  {時間}'),
              ),
              h('p', { class: 'hint' }, '「編號」是每次開啟隨機產生的代碼。', online ? '線上模式會把它連同 IP 記在伺服器的開啟紀錄，外流的截圖可以靠編號查出是哪一次、從哪裡開的。' : '離線模式沒有伺服器可以對照，編號只能當標記。')),
            field('浮水印文字', wmText, h('span', null, '可以插入：', ...['{收件人}', '{時間}', '{日期}', '{IP}', '{地區}', '{裝置}', '{編號}', '{備註}'].flatMap((t) => [token(t), ' ']))),
            h('div', { class: 'hint-box' },
              h('p', null, h('strong', null, '{IP}、{地區}'), '：對方開啟時網路對外的位址，只有線上模式才取得到（離線會顯示「—」）。對方看得到自己的 IP，同時伺服器也會記錄。'),
              h('p', null, h('strong', null, '{裝置}'), '：只能顯示瀏覽器和作業系統（例如 Chrome 130 / Windows）。網頁沒有任何方法讀到電腦名稱或硬體資訊。'),
              h('p', null, h('strong', null, '{備註}'), '：想標示電腦名稱的話，可以在上一步的收件人「備註」填入發放給對方的電腦名稱或部門。')),
            field('濃淡', opacity),
            field('字型大小', h('div', { class: 'range-row' }, sizeInput, sizeLabel), '字越大越醒目，但也越遮住內容。'),
            field('密集程度', h('div', { class: 'range-row' }, densityInput, densityLabel), '越密越難被裁掉或遮住，截圖時也越難只留下乾淨的一塊；但會更干擾閱讀。'),
            preview)
        : null,
    ),
    section('允許的操作',
      toggle('允許複製文字', pr.allowCopy, (v) => (pr.allowCopy = v), '關閉時會停用選取、複製、右鍵選單。'),
      toggle('允許列印', pr.allowPrint, (v) => (pr.allowPrint = v), '關閉時列印出來會是空白頁。'),
      toggle('允許下載原檔', pr.allowDownload, (v) => (pr.allowDownload = v), '開啟後收件人可以把檔案存出來（存出來的檔案就不受保護了）。'),
      h('p', { class: 'hint' }, '這些限制可以擋住一般操作，但擋不住截圖、翻拍或懂技術的人，所以建議同時開啟浮水印。'),
    ),
    section('自動上鎖',
      field('閒置多久自動上鎖', idle, '沒有滑鼠或鍵盤操作超過這個時間，就要重新輸入密碼。'),
      field('離開視窗多久自動上鎖', blur, '切換到其他程式或分頁超過這個時間就上鎖。'),
    ),
  );
}

// ---------- step 5: recipients ----------

const blankRecipient = () => ({ name: '', password: generatePassword(), note: '' });

function stepRecipients(body: HTMLElement, rerender: () => void) {
  const rows = h('div', { class: `recipients ${draft.samePassword ? 'same' : ''}` });
  draft.recipients.forEach((r, i) => {
    const name = h('input', { class: 'input', value: r.name, placeholder: '收件人名稱（會顯示在浮水印上）', maxlength: 100 });
    name.addEventListener('input', () => (r.name = name.value));
    const note = h('input', { class: 'input', value: r.note, placeholder: '備註（選填）', maxlength: 100 });
    note.addEventListener('input', () => (r.note = note.value));
    const pw = h('input', { class: 'input mono', value: r.password });
    pw.addEventListener('input', () => (r.password = pw.value));
    rows.append(h('div', { class: 'recipient-row' },
      h('span', { class: 'muted' }, `${i + 1}.`),
      name,
      draft.samePassword ? null : h('div', { class: 'pw-cell' }, pw, copyButton(() => r.password), h('button', { type: 'button', class: 'btn small', title: '重新產生密碼', onclick: () => { r.password = generatePassword(); rerender(); } }, '🎲')),
      note,
      draft.recipients.length > 1 ? h('button', { type: 'button', class: 'btn ghost small', title: '移除', onclick: () => { draft.recipients.splice(i, 1); rerender(); } }, '✕') : h('span'),
    ));
  });

  const bulk = async () => {
    const ta = h('textarea', { class: 'input', rows: 8, placeholder: '一行一個名字，例如：\n王小明\n陳小華' });
    if ((await modal('貼上名單', [ta], [{ label: '取消', value: '' }, { label: '加入', value: 'ok', kind: 'primary' }])) !== 'ok') return;
    const names = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    draft.recipients = draft.recipients.filter((r) => r.name.trim());
    for (const n of names) if (!draft.recipients.some((r) => r.name === n)) draft.recipients.push({ ...blankRecipient(), name: n });
    if (!draft.recipients.length) draft.recipients.push(blankRecipient());
    rerender();
  };

  const csvInput = h('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true });
  csvInput.addEventListener('change', async () => {
    const f = csvInput.files?.[0];
    csvInput.value = '';
    if (!f) return;
    const res = parseRecipients(decodeCsv(new Uint8Array(await f.arrayBuffer())), IMPORT_LIMITS);
    const existing = draft.recipients.filter((r) => r.name.trim());
    const lines: (HTMLElement | null)[] = [
      h('p', null, `讀到 `, h('strong', null, `${res.recipients.length} 位`), ` 收件人`, res.skipped ? `，略過 ${res.skipped} 列` : '', '。'),
      res.recipients.length
        ? h('p', { class: 'muted small' }, `前幾位：${res.recipients.slice(0, 5).map((r) => r.name).join('、')}${res.recipients.length > 5 ? '…' : ''}`)
        : null,
      res.recipients.some((r) => !r.password) ? h('p', { class: 'hint' }, '密碼留空的會自動產生。') : null,
      res.warnings.length
        ? h('div', { class: 'note warn' }, h('strong', null, '請留意：'), h('ul', { class: 'plain' }, ...res.warnings.slice(0, 8).map((w) => h('li', null, w)), res.warnings.length > 8 ? h('li', null, `…還有 ${res.warnings.length - 8} 則`) : null))
        : null,
    ];
    if (!res.recipients.length) {
      await modal('匯入 CSV', lines.filter((x): x is HTMLElement => !!x));
      return;
    }
    const buttons = [{ label: '取消', value: '' }, ...(existing.length ? [{ label: `加入現有的 ${existing.length} 位之後`, value: 'add' }] : []), { label: existing.length ? '取代現有名單' : '匯入', value: 'replace', kind: 'primary' }];
    const choice = await modal('匯入 CSV', lines.filter((x): x is HTMLElement => !!x), buttons);
    if (!choice) return;
    const incoming = res.recipients.map((r) => ({ name: r.name, password: r.password || generatePassword(), note: r.note }));
    if (choice === 'replace') draft.recipients = incoming;
    else {
      const have = new Set(existing.map((r) => r.name));
      draft.recipients = [...existing, ...incoming.filter((r) => !have.has(r.name))];
    }
    toast(`已匯入 ${incoming.length} 位收件人`);
    rerender();
  });

  const shared = h('input', { class: 'input mono', value: draft.sharedPassword });
  shared.addEventListener('input', () => (draft.sharedPassword = shared.value));

  body.append(
    section('收件人',
      h('p', { class: 'muted' }, '每位收件人會拿到自己的封存檔和金鑰：次數分開計算、浮水印顯示各自的名字，也可以單獨收回。自己用的話，填自己的名字就好。'),
      h('div', { class: 'import-box' },
        h('div', null, h('strong', null, '人很多？用 CSV 一次匯入'), h('p', { class: 'hint', style: 'margin:2px 0 0' }, '欄位：名稱、密碼（留空自動產生）、備註（選填，可以放電腦名稱或部門，用在浮水印）。Excel 另存成 CSV 即可。')),
        h('div', { class: 'row-buttons', style: 'margin:0' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => csvInput.click() }, '📥 匯入 CSV…'),
          h('button', { type: 'button', class: 'btn', onclick: () => saveBlob(new Blob([templateCsv()], { type: 'text/csv;charset=utf-8' }), '收件人名單範本.csv') }, '下載範本'),
        ),
        csvInput,
      ),
      toggle('所有收件人使用同一組密碼', draft.samePassword, (v) => { draft.samePassword = v; rerender(); }, '金鑰仍然每人不同。'),
      draft.samePassword ? field('共用密碼', h('div', { class: 'pw-cell' }, shared, copyButton(() => draft.sharedPassword), h('button', { type: 'button', class: 'btn small', title: '重新產生密碼', onclick: () => { draft.sharedPassword = generatePassword(); rerender(); } }, '🎲'))) : null,
      h('div', { class: `recipient-head muted small ${draft.samePassword ? 'same' : ''}` }, h('span'), h('span', null, '名稱'), draft.samePassword ? null : h('span', null, '密碼（可自訂，建議用自動產生的）'), h('span', null, '備註'), h('span')),
      rows,
      h('p', { class: 'muted small' }, `共 ${draft.recipients.length} 位`),
      h('div', { class: 'row-buttons' },
        h('button', { type: 'button', class: 'btn', onclick: () => { draft.recipients.push(blankRecipient()); rerender(); } }, '＋ 新增收件人'),
        h('button', { type: 'button', class: 'btn', onclick: bulk }, '貼上名單…'),
        draft.recipients.length > 1 ? h('button', { type: 'button', class: 'btn danger', onclick: async () => { if (await confirmDialog('清空名單', '確定要清空全部收件人嗎？', '清空', true)) { draft.recipients = [blankRecipient()]; rerender(); } } }, '清空') : null,
      ),
    ),
  );
}

// ---------- step 6: confirm & generate ----------

function stepGenerate(body: HTMLElement, rerender: () => void) {
  const server = draft.mode === 'online' ? servers.get(draft.serverId) : undefined;
  const exp = expiresAt();
  const total = draft.files.reduce((n, f) => n + f.file.size, 0);
  const pr = draft.protection;
  const summary = h('dl', { class: 'summary' },
    h('dt', null, '封存名稱'), h('dd', null, draft.title),
    h('dt', null, '檔案'), h('dd', null, `${draft.files.length} 個，共 ${formatSize(total)}`),
    h('dt', null, '模式'), h('dd', null, draft.mode === 'online' ? `線上驗證（${server?.name}）` : '離線'),
    h('dt', null, '到期'), h('dd', null, exp ? formatDateTime(exp) : '不限期'),
    h('dt', null, '次數'), h('dd', null, draft.limitOpens ? `每人 ${draft.maxOpens} 次` : '不限'),
    h('dt', null, '防護'), h('dd', null, [pr.watermark.enabled ? '浮水印' : '', pr.allowCopy ? '' : '禁止複製', pr.allowPrint ? '' : '禁止列印', pr.allowDownload ? '可下載' : '禁止下載', pr.idleLockMinutes ? `閒置 ${pr.idleLockMinutes} 分鐘上鎖` : ''].filter(Boolean).join('、')),
    h('dt', null, '收件人'), h('dd', null, draft.recipients.map((r) => r.name).join('、')),
  );

  const outBytes = total * draft.recipients.length;
  const loggedIn = !server || !!tokens.get(server.id);
  const progressText = h('p', { class: 'muted' });
  const bar = h('div', { class: 'size-fill', style: 'width:0%' });
  const progress = h('div', { hidden: true }, h('div', { class: 'size-bar' }, bar), progressText);
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary wide', disabled: !loggedIn }, `🔒 開始加密並產生 ${draft.recipients.length} 份封存檔`);

  go.addEventListener('click', async () => {
    go.disabled = true;
    progress.hidden = false;
    err.textContent = '';
    try {
      lastOutput = await generate((done, all, label) => {
        bar.style.width = `${Math.round((done / all) * 100)}%`;
        progressText.textContent = label;
      });
      toast('封存檔已產生');
      rerender();
    } catch (e) {
      err.textContent = `產生失敗：${(e as Error).message}`;
      go.disabled = false;
    }
  });

  body.append(
    outBytes > 1024 ** 3
      ? h('p', { class: 'note warn' }, `每位收件人的封存檔都要各自加密一份，總共約 ${formatSize(outBytes)}，瀏覽器可能會因為記憶體不足而失敗。建議分成幾批建立（每批合計 1GB 以內）。`)
      : '',
    section('確認設定', summary),
    section('產生',
      !loggedIn && server
        ? h('p', { class: 'note warn' }, `需要先登入伺服器「${server.name}」的管理員，才能登記封存檔。 `, h('button', { class: 'btn small primary', onclick: () => loginDialog(server).then((ok) => ok && rerender()) }, '登入'))
        : null,
      h('p', { class: 'muted' }, '加密全部在這台電腦上進行，文件不會上傳。', draft.mode === 'online' ? '只有伺服器那份金鑰和使用條件會送到你的伺服器。' : ''),
      go, progress, err,
    ),
  );
}

async function generate(onProgress: (done: number, all: number, label: string) => void): Promise<BatchOutput> {
  const server = draft.mode === 'online' ? servers.get(draft.serverId)! : null;
  if (server) await api(server, '/api/admin/vaults', { auth: true }); // fail fast if logged out
  const exp = expiresAt();
  const policy: Policy = {
    ...draft.policy,
    notBefore: draft.notBefore ? fromLocalInput(draft.notBefore) : null,
    expiresAt: exp,
    maxOpens: draft.limitOpens ? draft.maxOpens : null,
  };
  const batchId = randomId(8);
  const inputs: InputFile[] = draft.files.map((f) => ({
    path: f.path,
    mime: guessMime(f.path, f.file.type),
    size: f.file.size,
    read: async () => new Uint8Array(await f.file.arrayBuffer()),
  }));
  const total = inputs.reduce((n, f) => n + f.size, 0) || 1;
  const n = draft.recipients.length;
  const items: BatchOutput['items'] = [];
  const registrations: Record<string, unknown>[] = [];
  const title = draft.title.trim();

  for (let i = 0; i < n; i++) {
    const r = draft.recipients[i];
    const name = r.name.trim();
    const password = draft.samePassword ? draft.sharedPassword : r.password;
    const keyfile = randomBytes(32);
    const share = server ? randomBytes(32) : null;
    onProgress(i, n, `正在為「${name}」加密（${i + 1}/${n}）…`);
    const built = await buildVault(inputs, {
      title, recipient: name, note: r.note.trim(), batchId, mode: draft.mode, server: server?.url ?? null, policy,
      protection: structuredClone(draft.protection), password, keyfile, serverShare: share,
    }, (done) => onProgress(i + done / total, n, `正在為「${name}」加密（${i + 1}/${n}）… ${Math.round((done / total) * 100)}%`));
    await new Promise((r) => setTimeout(r, 0));
    const vaultName = `${safeName(title)}_${safeName(name)}.vault.html`;
    items.push({
      recipient: name,
      password,
      keyText: keyToText(keyfile),
      keyFileText: keyFileContent(keyfile, title, name),
      vault: new Blob(renderVaultHtml(template, built.header, built.blobParts), { type: 'text/html' }),
      vaultName,
    });
    if (server) registrations.push({ id: built.header.id, batchId, title, recipient: name, authKey: toB64(built.authKey), share: toB64(share!), policy });
  }

  if (server) {
    onProgress(n, n, '正在登記到伺服器…');
    await api(server, '/api/admin/vaults', { body: { vaults: registrations }, auth: true });
  }
  onProgress(n, n, '完成');
  return { title, mode: draft.mode, serverName: server?.name ?? null, createdAt: new Date().toISOString(), expiresAt: exp, maxOpens: policy.maxOpens, phoneUrl: phoneViewerUrl(server?.url), items };
}

// ---------- result ----------

function renderResult(root: HTMLElement, b: BatchOutput, rerender: () => void) {
  const saveStatus = h('p', { class: 'hint ok' });
  const folderBtn = canPickFolder()
    ? h('button', {
        class: 'btn primary',
        onclick: async () => {
          const name = await saveToFolder(b);
          if (name) saveStatus.textContent = `✓ 已儲存到資料夾「${name}」`;
        },
      }, '💾 全部儲存到資料夾…')
    : null;
  const zipBtn = h('button', { class: `btn ${folderBtn ? '' : 'primary'}`, onclick: () => downloadZip(b).then(() => (saveStatus.textContent = '✓ 已下載 ZIP')) }, '🗜️ 全部下載成 ZIP');

  const rows = b.items.map((it) =>
    h('div', { class: 'card result-card' },
      h('div', { class: 'result-head' }, h('h3', null, it.recipient), h('span', { class: 'muted small mono' }, it.vaultName)),
      h('div', { class: 'result-grid' },
        h('div', null,
          h('div', { class: 'label' }, '密碼'),
          h('div', { class: 'copy-line' }, h('span', { class: 'mono' }, it.password), copyButton(() => it.password)),
          h('div', { class: 'label', style: 'margin-top:10px' }, '金鑰'),
          h('div', { class: 'copy-line' }, h('span', { class: 'mono key' }, it.keyText), copyButton(() => it.keyText)),
          h('div', { class: 'row-buttons', style: 'margin-top:10px' },
            h('button', { class: 'btn small', onclick: () => saveBlob(it.vault, it.vaultName) }, '⬇ 封存檔'),
            h('button', { class: 'btn small', onclick: () => saveBlob(new Blob([it.keyFileText], { type: 'text/plain' }), `${safeName(it.recipient)}.key`) }, '⬇ 金鑰檔'),
            h('button', { class: 'btn small', onclick: () => downloadKeyCard(b, it) }, '⬇ 金鑰卡'),
          ),
        ),
        qrElement(it.keyText, 140),
      ),
    ),
  );

  root.append(
    h('div', { class: 'page-head' }, h('h1', null, '✅ 封存檔已產生'), h('p', { class: 'muted' }, `「${b.title}」共 ${b.items.length} 份。`)),
    h('p', { class: 'note warn' }, '⚠️ 密碼和金鑰只會顯示在這一頁。離開前請先儲存（儲存的資料夾或 ZIP 裡會有一份「交付清單」，只給你自己看）。'),
    section('儲存',
      h('div', { class: 'row-buttons' }, folderBtn, zipBtn, h('button', { class: 'btn', onclick: () => downloadSheet(b) }, '📋 只下載交付清單')),
      saveStatus,
      h('p', { class: 'hint' }, '資料夾內容：交付清單、每位收件人一個資料夾（封存檔、.key 金鑰檔、可列印的金鑰卡）。'),
    ),
    section('怎麼交給收件人（三樣東西分開傳）',
      h('ol', { class: 'steps' },
        h('li', null, h('strong', null, '封存檔'), '：雲端硬碟連結或隨身碟。不建議用 Email 附件（公司信箱可能擋 HTML 附件）。'),
        h('li', null, h('strong', null, '金鑰'), '：金鑰卡、.key 檔或金鑰文字，用另一個管道（例如通訊軟體）。'),
        h('li', null, h('strong', null, '密碼'), '：再用第三個管道，例如電話或簡訊。'),
      ),
    ),
    ...rows,
    h('div', { class: 'nav-buttons' },
      h('span'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          if (await confirmDialog('建立新的封存檔', '離開後這一頁的密碼和金鑰就看不到了。確定已經儲存了嗎？', '已儲存，建立新的')) {
            lastOutput = null;
            draft = newDraft();
            stepIndex = 0;
            rerender();
          }
        },
      }, '建立新的封存檔'),
    ),
  );
}

export function hasUnsavedResult() {
  return !!lastOutput;
}
