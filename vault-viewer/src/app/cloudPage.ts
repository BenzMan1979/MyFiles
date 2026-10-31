// "雲端空間": connect the server to the admin's own cloud storage, so vaults can be handed out as
// links (the encrypted blob lives in that storage; the server streams it to recipients who unlock).

import { clear, h } from '../shared/dom';
import { api, ApiError, listClouds, servers, tokens, type CloudProfile, type ServerProfile } from './api';
import { loginDialog } from './serverPage';
import { confirmDialog, copyButton, modal, section, toast } from './ui';

let selectedServer = '';

/** Opens the cloud page on this server (from its card on the servers page). */
export const setCloudServer = (id: string) => {
  selectedServer = id;
};

const TYPE_ICON: Record<string, string> = { gdrive: '🟢', webdav: '🗄️', s3: '🪣' };

export function renderCloud(root: HTMLElement, rerender: () => void) {
  root.append(
    h('div', { class: 'page-head' },
      h('h1', null, '☁️ 雲端空間'),
      h('p', { class: 'muted' }, '把伺服器連到你自己的雲端空間後，建立封存檔時可以選「雲端連結」：加密後的內容放在你的雲端，收件人打開網址、輸入密碼和金鑰就能直接看，不用下載檔案，也不需要雲端帳號。'),
      h('p', { class: 'muted' }, '只要設定一次：連線資料存在伺服器上，之後每次建立封存檔只要在「交付方式」選「雲端連結」，換電腦也不用重新連。'),
    ),
  );
  const list = servers.list();
  if (!list.length) {
    root.append(h('p', { class: 'note' }, '還沒有設定伺服器。請先到 ', h('a', { href: '#servers' }, '伺服器設定'), '。'));
    return;
  }
  if (!servers.get(selectedServer)) selectedServer = servers.default()!.id;
  const server = servers.get(selectedServer)!;
  const sel = h('select', { class: 'input narrow' }, ...list.map((s) => h('option', { value: s.id, selected: s.id === server.id }, s.name)));
  sel.addEventListener('change', () => {
    selectedServer = sel.value;
    rerender();
  });
  root.append(h('div', { class: 'toolbar' }, h('span', null, '伺服器：'), sel, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: rerender }, '↻ 重新整理')));

  if (!tokens.get(server.id)) {
    root.append(h('div', { class: 'card section' }, h('p', null, '雲端空間的設定只有這台伺服器的管理員能看到和修改，請先登入。'), h('button', { class: 'btn primary', onclick: () => loginDialog(server).then((ok) => ok && rerender()) }, '登入')));
    return;
  }
  const body = h('div', null, h('div', { class: 'empty' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, '讀取中…')));
  root.append(body, howItWorks());
  void load(server, body, rerender);
}

async function load(server: ServerProfile, body: HTMLElement, rerender: () => void) {
  let data: { profiles: CloudProfile[]; googleRedirectUri: string };
  try {
    data = await listClouds(server);
  } catch (e) {
    clear(body);
    if (e instanceof ApiError && e.code === 'not_found') {
      body.append(h('p', { class: 'note warn' }, '這台伺服器的版本還不支援雲端空間。請更新伺服器的程式（重新部署）後再試。'));
      return;
    }
    body.append(h('p', { class: 'error' }, (e as Error).message));
    if (!tokens.get(server.id)) body.append(h('button', { class: 'btn primary', onclick: () => loginDialog(server).then((ok) => ok && rerender()) }, '重新登入'));
    return;
  }
  clear(body);
  const box = section('已連結的雲端空間');
  if (!data.profiles.length) box.append(h('p', { class: 'muted' }, '還沒有連結任何雲端空間。從下面選一種開始：'));
  for (const p of data.profiles) box.append(profileCard(server, p, data.googleRedirectUri, rerender));
  box.append(
    h('div', { class: 'row-buttons', style: 'margin-top:12px' },
      h('button', { class: 'btn', onclick: () => googleDialog(server, data.googleRedirectUri).then((ok) => ok && rerender()) }, '＋ Google Drive'),
      h('button', { class: 'btn', onclick: () => webdavDialog(server).then((ok) => ok && rerender()) }, '＋ Nextcloud／WebDAV'),
      h('button', { class: 'btn', onclick: () => s3Dialog(server).then((ok) => ok && rerender()) }, '＋ Cloudflare R2／S3'),
    ),
  );
  body.append(box);
}

function profileCard(server: ServerProfile, p: CloudProfile, redirectUri: string, rerender: () => void) {
  const status = p.status === 'ready' ? h('span', { class: 'chip ok' }, '● 已連結') : h('span', { class: 'chip warn' }, '等待 Google 授權');
  const test = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    btn.textContent = '測試中…';
    try {
      const r = await api<{ message: string }>(server, `/api/admin/storage/${p.id}/test`, { body: {}, auth: true });
      toast(`✓ 連線正常：${r.message}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '測試連線';
    }
  };
  const testBtn: HTMLButtonElement = h('button', { class: 'btn small', onclick: () => test(testBtn) }, '測試連線');
  const edit = () =>
    (p.type === 'gdrive' ? googleDialog(server, redirectUri, p) : p.type === 'webdav' ? webdavDialog(server, p) : s3Dialog(server, p)).then((ok) => ok && rerender());
  return h('div', { class: 'server-card' },
    h('div', { class: 'server-main' },
      h('div', null, TYPE_ICON[p.type] ?? '☁️', ' ', h('strong', null, p.name), h('span', { class: 'chip', style: 'margin-left:8px' }, p.typeLabel), p.isDefault ? h('span', { class: 'chip ok', style: 'margin-left:6px' }, '預設') : null),
      p.account ? h('div', { class: 'muted small' }, p.account) : null,
      h('div', { class: 'chips', style: 'margin-top:6px' }, status, h('span', { class: 'chip' }, `${p.vaults} 份封存檔`)),
    ),
    h('div', { class: 'server-actions' },
      p.status === 'ready' ? testBtn : null,
      p.status === 'ready' && !p.isDefault
        ? h('button', { class: 'btn small', onclick: async () => { await api(server, `/api/admin/storage/${p.id}/default`, { body: {}, auth: true }); toast('已設為預設'); rerender(); } }, '設為預設')
        : null,
      h('button', { class: 'btn small', onclick: edit }, p.type === 'gdrive' ? (p.status === 'ready' ? '設定／重新連結' : '繼續連結') : '編輯'),
      h('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!(await confirmDialog('移除雲端空間', `從伺服器移除「${p.name}」的連線設定。雲端上的檔案不會被刪除。${p.vaults ? `（還有 ${p.vaults} 份封存檔放在這裡，要先刪除它們）` : ''}`, '移除', true))) return;
          try {
            await api(server, `/api/admin/storage/${p.id}`, { method: 'DELETE', auth: true });
            toast('已移除');
            rerender();
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        },
      }, '移除'),
    ),
  );
}

function howItWorks() {
  return h('details', { class: 'more card section' },
    h('summary', null, '雲端連結是怎麼運作的？安全嗎？'),
    h('ul', null,
      h('li', null, '加密一樣在你的電腦上完成；上傳到雲端的只有加密後的內容，雲端業者看不到檔名，也看不到內容。'),
      h('li', null, '收件人打開連結時，要先通過伺服器的檢查（密碼＋金鑰、期限、次數、是否收回），伺服器才會從雲端把加密內容轉給他，在他的裝置上解密。'),
      h('li', null, '收回之後，正在看的人也讀不到還沒看過的檔案；在「管理封存檔」刪除封存檔時，雲端上的檔案也會一起刪除。'),
      h('li', null, '雲端的帳號密碼只存在你的伺服器裡（你的 Cloudflare 帳號），不會傳回這個網頁，也不會給收件人。'),
      h('li', null, '流量：收件人看的內容會經過你的伺服器。Cloudflare 免費方案每天可以處理 10 萬次請求，每 32MB 算一次，一般使用很夠。'),
    ),
  );
}

// ---------- dialogs ----------

const input = (value = '', attrs: Record<string, unknown> = {}) => h('input', { class: 'input', value, ...attrs });
const row = (label: string, ctl: Node, hint?: Node | string) => h('div', { class: 'field' }, h('label', { class: 'label' }, label), ctl, hint ? h('p', { class: 'hint' }, hint) : null);
const ext = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text, ' ↗');

/** Saves a WebDAV / S3 profile; the server tests the connection first and refuses settings that do not work. */
async function saveProfile(server: ServerProfile, err: HTMLElement, payload: object): Promise<boolean> {
  err.textContent = '連線測試中…';
  err.className = 'muted';
  try {
    const r = await api<{ message: string }>(server, '/api/admin/storage', { body: payload, auth: true });
    toast(`✓ 已連結：${r.message}`);
    return true;
  } catch (e) {
    err.className = 'error';
    err.textContent = (e as Error).message;
    return false;
  }
}

type WebdavPreset = 'nextcloud' | 'koofr' | 'other';

function presetOf(url: string): { preset: WebdavPreset; base: string; user: string } {
  const nc = url.match(/^(https?:\/\/.+?)\/remote\.php\/dav\/files\/([^/]+)\/?$/);
  if (nc) return { preset: 'nextcloud', base: nc[1], user: decodeURIComponent(nc[2]) };
  if (/^https:\/\/app\.koofr\.net\/dav\//.test(url)) return { preset: 'koofr', base: '', user: '' };
  return { preset: url ? 'other' : 'nextcloud', base: '', user: '' };
}

async function webdavDialog(server: ServerProfile, p?: CloudProfile): Promise<boolean> {
  const c = p?.config ?? {};
  const guess = presetOf(c.url ?? '');
  const preset = h('select', { class: 'input' },
    h('option', { value: 'nextcloud', selected: guess.preset === 'nextcloud' }, 'Nextcloud（自己架設或代管）'),
    h('option', { value: 'koofr', selected: guess.preset === 'koofr' }, 'Koofr（免費 10GB）'),
    h('option', { value: 'other', selected: guess.preset === 'other' }, '其他 WebDAV（Synology、ownCloud、InfiniCLOUD…）'),
  );
  const name = input(p?.name ?? '', { placeholder: '例如：公司 Nextcloud' });
  const ncBase = input(guess.base, { placeholder: 'https://cloud.example.com', class: 'input mono' });
  const url = input(c.url ?? '', { placeholder: 'https://…/', class: 'input mono' });
  const user = input(c.username ?? guess.user, { autocomplete: 'off' });
  const pass = input('', { type: 'password', autocomplete: 'new-password', placeholder: p?.secretsSet.password ? '（不變）' : '' });
  const folder = input(c.folder ?? '隨身密閱');
  const err = h('p', { class: 'error' });
  const computed = h('p', { class: 'hint mono' });
  const ncRow = row('Nextcloud 網址', ncBase, '瀏覽器打開 Nextcloud 時網址列的開頭，例如 https://cloud.example.com');
  const urlRow = row('WebDAV 網址', url, '服務說明裡的 WebDAV 位址（要能寫入的資料夾）');
  const help = h('div', { class: 'note' });
  const davUrl = () => {
    if (preset.value === 'nextcloud') return ncBase.value.trim() && user.value.trim() ? `${ncBase.value.trim().replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(user.value.trim())}/` : '';
    if (preset.value === 'koofr') return 'https://app.koofr.net/dav/Koofr/';
    return url.value.trim();
  };
  const paint = () => {
    ncRow.hidden = preset.value !== 'nextcloud';
    urlRow.hidden = preset.value !== 'other';
    computed.textContent = preset.value !== 'other' && davUrl() ? `WebDAV 位址：${davUrl()}` : '';
    clear(help);
    if (preset.value === 'nextcloud') {
      help.append(
        h('strong', null, '建議用「應用程式密碼」'), '：在 Nextcloud 右上角頭像 →「個人設定」→「安全性」→「建立新的應用程式密碼」，把產生的密碼貼到下面。不要用你的登入密碼。',
        h('br'), h('strong', null, '自己架的 Nextcloud'), '：必須能從網際網路用 https 連到（伺服器在 Cloudflare 上，連不到家裡的區域網路）。放在家裡的話，建議用 ', ext('https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/', 'Cloudflare Tunnel'), '，不用開 port，也不用固定 IP。',
      );
    } else if (preset.value === 'koofr') {
      help.append('帳號填 Koofr 的 Email；密碼請到 Koofr 網頁「偏好設定 → 密碼 → 產生新的應用程式密碼」建立一組貼到下面。');
    } else {
      help.append('Synology：在 DSM 安裝「WebDAV Server」套件並開啟 HTTPS；ownCloud 的網址通常是 https://…/remote.php/webdav/。');
    }
  };
  preset.addEventListener('change', paint);
  ncBase.addEventListener('input', paint);
  user.addEventListener('input', paint);
  paint();
  const r = await modal(p ? `編輯：${p.name}` : '連結 Nextcloud／WebDAV', [
    row('服務', preset), row('名稱', name), ncRow, urlRow, row('帳號', user), row('密碼（應用程式密碼）', pass), computed,
    row('存放的資料夾', folder, '會在雲端建立這個資料夾，每份封存檔一個子資料夾。'), help, err,
  ], [{ label: '取消', value: '' }, { label: '測試並儲存', value: 'ok', kind: 'primary' }], async () => {
    if (!name.value.trim()) return (err.textContent = '請幫這個雲端空間取個名字'), false;
    if (!davUrl()) return (err.textContent = preset.value === 'nextcloud' ? '請填 Nextcloud 網址和帳號' : '請填 WebDAV 網址'), false;
    return saveProfile(server, err, { id: p?.id, type: 'webdav', name: name.value, config: { url: davUrl(), username: user.value, password: pass.value, folder: folder.value } });
  });
  return r === 'ok';
}

async function s3Dialog(server: ServerProfile, p?: CloudProfile): Promise<boolean> {
  const c = p?.config ?? {};
  const r2 = (c.endpoint ?? '').match(/^https:\/\/([0-9a-f]{32})\.(?:eu\.|fedramp\.)?r2\.cloudflarestorage\.com\/?$/);
  const b2 = (c.endpoint ?? '').match(/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/);
  const preset = h('select', { class: 'input' },
    h('option', { value: 'r2', selected: !p || !!r2 }, 'Cloudflare R2（免費 10GB，流量不收費）'),
    h('option', { value: 'b2', selected: !!b2 }, 'Backblaze B2（免費 10GB）'),
    h('option', { value: 'other', selected: !!p && !r2 && !b2 }, '其他 S3 相容（Wasabi、MinIO、Amazon S3…）'),
  );
  const name = input(p?.name ?? '', { placeholder: '例如：R2 儲存桶' });
  const account = input(r2?.[1] ?? '', { placeholder: '32 碼的帳戶 ID', class: 'input mono' });
  const region = input(c.region ?? (b2?.[1] ?? ''), { placeholder: '例如 us-west-004', class: 'input mono' });
  const endpoint = input(c.endpoint ?? '', { placeholder: 'https://…', class: 'input mono' });
  const bucket = input(c.bucket ?? '', { class: 'input mono' });
  const keyId = input(c.accessKeyId ?? '', { class: 'input mono', autocomplete: 'off' });
  const secret = input('', { type: 'password', autocomplete: 'new-password', placeholder: p?.secretsSet.secretAccessKey ? '（不變）' : '' });
  const prefix = input(c.prefix ?? 'vault-viewer', { class: 'input mono' });
  const err = h('p', { class: 'error' });
  const accountRow = row('Cloudflare 帳戶 ID', account, 'R2 頁面右側「帳戶詳細資料」的 Account ID');
  const regionRow = row('區域（Region）', region);
  const endpointRow = row('端點網址（Endpoint）', endpoint);
  const help = h('div', { class: 'note' });
  const resolved = () => {
    if (preset.value === 'r2') return { endpoint: account.value.trim() ? `https://${account.value.trim()}.r2.cloudflarestorage.com` : '', region: 'auto' };
    if (preset.value === 'b2') return { endpoint: region.value.trim() ? `https://s3.${region.value.trim()}.backblazeb2.com` : '', region: region.value.trim() };
    return { endpoint: endpoint.value.trim(), region: region.value.trim() || 'us-east-1' };
  };
  const paint = () => {
    accountRow.hidden = preset.value !== 'r2';
    regionRow.hidden = preset.value === 'r2';
    endpointRow.hidden = preset.value !== 'other';
    clear(help);
    if (preset.value === 'r2') {
      help.append(
        '在 ', ext('https://dash.cloudflare.com/?to=/:account/r2/overview', 'Cloudflare 主控台 → R2'), '：',
        h('ol', { class: 'steps' },
          h('li', null, '第一次使用要先啟用 R2（Cloudflare 可能要求綁定付款方式；10GB 內免費，下載流量不收費）。'),
          h('li', null, '「建立儲存桶」，名稱例如 vault-files，填到下面的「儲存桶名稱」。'),
          h('li', null, '回到 R2 首頁 →「管理 API 權杖」→「建立帳戶 API 權杖」：權限選「物件讀取和寫入」，套用到剛建立的那個儲存桶。'),
          h('li', null, '把畫面上的「存取金鑰識別碼（Access Key ID）」和「秘密存取金鑰（Secret Access Key）」貼到下面（秘密金鑰只會顯示一次）。'),
        ),
      );
    } else if (preset.value === 'b2') {
      help.append('在 Backblaze 建立儲存桶（Private），再到「Application Keys」建立一組只能存取這個儲存桶、可讀寫的金鑰。區域在儲存桶的 Endpoint 裡，例如 s3.us-west-004.backblazeb2.com 的區域就是 us-west-004。');
    } else {
      help.append('需要一組能讀寫這個儲存桶的存取金鑰。端點必須是 https。');
    }
  };
  preset.addEventListener('change', paint);
  paint();
  const res = await modal(p ? `編輯：${p.name}` : '連結 Cloudflare R2／S3', [
    row('服務', preset), row('名稱', name), accountRow, regionRow, endpointRow, row('儲存桶名稱（Bucket）', bucket),
    row('Access Key ID', keyId), row('Secret Access Key', secret), row('存放的資料夾（前綴）', prefix), help, err,
  ], [{ label: '取消', value: '' }, { label: '測試並儲存', value: 'ok', kind: 'primary' }], async () => {
    const r = resolved();
    if (!name.value.trim()) return (err.textContent = '請幫這個雲端空間取個名字'), false;
    if (!r.endpoint) return (err.textContent = preset.value === 'r2' ? '請填 Cloudflare 帳戶 ID' : preset.value === 'b2' ? '請填區域' : '請填端點網址'), false;
    return saveProfile(server, err, { id: p?.id, type: 's3', name: name.value, config: { endpoint: r.endpoint, region: r.region, bucket: bucket.value, accessKeyId: keyId.value, secretAccessKey: secret.value, prefix: prefix.value } });
  });
  return res === 'ok';
}

async function googleDialog(server: ServerProfile, redirectUri: string, p?: CloudProfile): Promise<boolean> {
  const name = input(p?.name ?? 'Google Drive');
  const folder = input(p?.config.folderName ?? '隨身密閱');
  const clientId = input(p?.config.clientId ?? '', { class: 'input mono', placeholder: '….apps.googleusercontent.com', autocomplete: 'off' });
  const secret = input('', { type: 'password', class: 'input mono', autocomplete: 'new-password', placeholder: p?.secretsSet.clientSecret ? '（不變）' : 'GOCSPX-…' });
  const err = h('p', { class: 'error' });
  const status = h('p', { class: 'hint' });
  const steps = h('details', { class: 'more', open: !p },
    h('summary', null, '第一次設定：在 Google Cloud 建立自己的 OAuth 用戶端（約 5 分鐘，只要做一次）'),
    h('ol', { class: 'steps' },
      h('li', null, '打開 ', ext('https://console.cloud.google.com/projectcreate', 'Google Cloud 建立專案'), '，用你要存放檔案的 Google 帳號登入，專案名稱隨意（例如 vault-viewer），建立。'),
      h('li', null, '打開 ', ext('https://console.cloud.google.com/apis/library/drive.googleapis.com', 'Google Drive API'), '，確認上方選的是剛建立的專案，按「啟用」。'),
      h('li', null, '打開 ', ext('https://console.cloud.google.com/auth/overview', 'Google Auth Platform'), ' →「開始」：應用程式名稱填 ', h('code', null, '隨身密閱'), '、填你的 Email，目標對象選「外部」，完成。'),
      h('li', null, h('strong', null, '很重要：'), '到「目標對象（Audience）」按「發布應用程式」，把狀態改成「正式版（In production）」。如果留在「測試」，Google 給的授權', h('strong', null, '每 7 天就會失效'), '。',
        h('br'), '「發布應用程式」是灰色按不下去的話：先到「品牌（Branding）」把應用程式名稱、使用者支援電子郵件、開發人員聯絡資訊填好並按「儲存」，再回來按。只用 drive.file 權限不需要送 Google 審查。'),
      h('li', null, '到 ', ext('https://console.cloud.google.com/auth/clients', '用戶端（Clients）'), ' →「建立用戶端」：類型選「網頁應用程式」，在「已授權的重新導向 URI」新增下面這一行：',
        h('div', { class: 'copy-line', style: 'margin:6px 0' }, h('span', { class: 'mono' }, redirectUri), copyButton(() => redirectUri))),
      h('li', null, '建立後，把畫面上的「用戶端 ID」和「用戶端密鑰」貼到下面，按「前往 Google 授權」。'),
    ),
    h('p', { class: 'hint' }, '只會要求「drive.file」權限：伺服器只能看到它自己建立的檔案，看不到你 Google Drive 裡的其他東西。授權時如果出現「Google 尚未驗證這個應用程式」，按「進階」→「前往（不安全）」即可，這是你自己的應用程式。'),
  );
  const r = await modal(p ? `Google Drive：${p.name}` : '連結 Google Drive', [
    steps, row('名稱', name), row('用戶端 ID（Client ID）', clientId), row('用戶端密鑰（Client Secret）', secret),
    row('存放的資料夾', folder, '會在你的 Google Drive 建立這個資料夾，每份封存檔一個子資料夾。'), status, err,
  ], [{ label: '取消', value: '' }, { label: '前往 Google 授權', value: 'ok', kind: 'primary' }], async () => {
    err.textContent = '';
    // Open the tab now, while this still counts as the click (pop-up blockers), and point it at Google afterwards.
    const tab = window.open('about:blank', '_blank');
    let start: { id: string; authUrl: string; startedAt: string };
    try {
      start = await api(server, '/api/admin/storage/google/start', { body: { id: p?.id, name: name.value, clientId: clientId.value, clientSecret: secret.value, folderName: folder.value }, auth: true });
    } catch (e) {
      tab?.close();
      err.textContent = (e as Error).message;
      return false;
    }
    clear(status);
    if (tab) {
      tab.opener = null;
      tab.location.href = start.authUrl;
      status.append('已在新分頁打開 Google 的授權畫面，請在那裡登入並按「繼續／允許」。完成後這裡會自動更新…');
    } else {
      status.append('瀏覽器擋下了新分頁，請按這個連結完成授權：', h('a', { href: start.authUrl, target: '_blank', rel: 'noopener' }, '前往 Google 授權 ↗'));
    }
    // Wait for the sign-in to finish (the server marks the profile ready), up to 10 minutes.
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until && status.isConnected) {
      await new Promise((ok) => setTimeout(ok, 2500));
      try {
        const { profiles } = await listClouds(server);
        const now = profiles.find((x) => x.id === start.id);
        if (now?.status === 'ready' && now.connectedAt >= start.startedAt) {
          toast(`✓ 已連結 Google Drive：${now.account}`);
          return true;
        }
      } catch {
        /* keep waiting */
      }
    }
    if (status.isConnected) err.textContent = '等太久了，請再按一次「前往 Google 授權」。';
    return false;
  });
  return r === 'ok';
}
