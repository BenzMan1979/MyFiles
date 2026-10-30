import { randomId } from '../core/keytext';
import { APP_NAME, DEPLOY_BUTTON_URL } from '../shared/config';
import { settings } from '../shared/settings';
import { clear, h } from '../shared/dom';
import { api, ApiError, login, normaliseUrl, serverInfo, servers, tokens, type ServerProfile } from './api';
import { confirmDialog, modal, section, toast } from './ui';

export function renderServers(root: HTMLElement, rerender: () => void) {
  const list = servers.list();
  root.append(
    h('div', { class: 'page-head' },
      h('h1', null, '🌐 伺服器設定'),
      h('p', { class: 'muted' }, '「線上模式」的封存檔需要一台驗證伺服器，負責檢查次數、期限，並讓你可以隨時收回。伺服器免費架在你自己的 Cloudflare 帳號上，只要照著下面的步驟做一次。'),
    ),
  );

  // When this page is served by the vault server itself, there is nothing to set up: just log in.
  const here = h('div');
  const detect = !servers.list().some((s) => s.url === location.origin) && location.protocol.startsWith('http');
  const wizardBox = h('div');
  const showWizard = () => {
    clear(wizardBox);
    wizardBox.append(wizard(rerender));
  };

  if (list.length) {
    const box = section('我的伺服器');
    for (const s of list) box.append(serverCard(s, rerender));
    box.append(h('button', { class: 'btn', onclick: () => openWizard(root, rerender) }, '＋ 新增另一台伺服器'));
    root.append(here, box);
  } else {
    root.append(here, wizardBox);
    showWizard();
  }

  if (detect) {
    serverInfo(location.origin)
      .then((info) => {
        const profile: ServerProfile = { id: randomId(6), name: '我的伺服器', url: location.origin };
        clear(here);
        here.append(
          h('section', { class: 'card section here' },
            h('h2', null, '✅ 這個網站本身就是你的伺服器'),
            h('p', { class: 'muted' }, `你現在開啟的就是${APP_NAME}伺服器（${location.host}），不需要另外部署，登入後就能使用線上模式。`),
            adminStep(profile, info.adminConfigured, rerender),
          ),
        );
        if (!list.length) {
          clear(wizardBox);
          wizardBox.append(h('details', { class: 'more' }, h('summary', null, '要改用另一台伺服器？'), wizard(rerender)));
        }
      })
      .catch(() => {});
  }
}

function openWizard(root: HTMLElement, rerender: () => void) {
  clear(root);
  root.append(h('button', { class: 'btn ghost', onclick: rerender }, '← 返回伺服器清單'), wizard(rerender));
}

function serverCard(s: ServerProfile, rerender: () => void) {
  const loggedIn = !!tokens.get(s.id);
  const isDefault = servers.defaultId() === s.id;
  const status = h('span', { class: 'chip' }, '檢查中…');
  // Changing or deleting a server's entry is for its admin: the buttons only appear once logged in.
  // The one exception is a server that cannot be reached at all, so a dead entry can still be removed.
  const guarded = h('span', { class: 'server-actions' });
  guarded.style.display = loggedIn ? '' : 'none';
  guarded.append(
    h('button', { class: 'btn small', onclick: () => editDialog(s).then((ok) => ok && rerender()) }, '編輯'),
    h('button', { class: 'btn small', onclick: () => passwordDialog(s) }, '更換管理員密碼'),
    h('button', {
      class: 'btn small danger',
      onclick: async () => {
        if (await confirmDialog('移除伺服器設定', `只會從這個瀏覽器移除「${s.name}」的設定，伺服器本身和上面的封存檔都不受影響。`, '移除', true)) {
          servers.remove(s.id);
          rerender();
        }
      },
    }, '移除'),
  );
  serverInfo(s.url)
    .then(() => {
      status.className = 'chip ok';
      status.textContent = '● 連線正常';
    })
    .catch((e: Error) => {
      status.className = 'chip danger';
      status.textContent = '● 無法連線';
      status.title = e.message;
      guarded.style.display = '';
    });

  return h('div', { class: 'server-card' },
    h('div', { class: 'server-main' },
      h('div', null, h('strong', null, s.name), isDefault ? h('span', { class: 'chip ok', style: 'margin-left:8px' }, '預設') : null),
      h('div', { class: 'muted small mono' }, s.url),
      h('div', { class: 'chips', style: 'margin-top:6px' }, status, h('span', { class: `chip ${loggedIn ? 'ok' : ''}` }, loggedIn ? '管理員已登入' : '管理員未登入')),
    ),
    h('div', { class: 'server-actions' },
      loggedIn
        ? h('button', { class: 'btn small', onclick: async () => { await api(s, '/api/admin/logout', { body: {}, auth: true }).catch(() => {}); tokens.clear(s.id); rerender(); } }, '登出')
        : h('button', { class: 'btn small primary', onclick: () => loginDialog(s).then((ok) => ok && rerender()) }, '登入'),
      !isDefault ? h('button', { class: 'btn small', onclick: () => { servers.setDefault(s.id); rerender(); } }, '設為預設') : null,
      guarded,
    ),
  );
}

export async function loginDialog(s: ServerProfile): Promise<boolean> {
  const pw = h('input', { type: 'password', class: 'input', placeholder: '管理員密碼', autocomplete: 'current-password' });
  const err = h('p', { class: 'error' });
  const v = await modal('管理員登入', [h('p', { class: 'muted' }, `登入「${s.name}」`), pw, err], [
    { label: '取消', value: '' },
    { label: '登入', value: 'ok', kind: 'primary' },
  ], async () => {
    try {
      await login(s, pw.value);
      return true;
    } catch (e) {
      err.textContent = (e as Error).message;
      return false;
    }
  });
  if (v === 'ok') toast('已登入');
  return v === 'ok';
}

async function editDialog(s: ServerProfile): Promise<boolean> {
  const name = h('input', { class: 'input', value: s.name });
  const url = h('input', { class: 'input mono', value: s.url });
  const err = h('p', { class: 'error' });
  const v = await modal('編輯伺服器', [h('label', { class: 'label' }, '名稱'), name, h('label', { class: 'label', style: 'margin-top:12px' }, '網址'), url, err], [
    { label: '取消', value: '' },
    { label: '儲存', value: 'ok', kind: 'primary' },
  ], async () => {
    const u = normaliseUrl(url.value);
    if (!u) {
      err.textContent = '網址格式不正確';
      return false;
    }
    try {
      await serverInfo(u);
    } catch (e) {
      err.textContent = (e as Error).message;
      return false;
    }
    if (u !== s.url) tokens.clear(s.id);
    servers.upsert({ ...s, name: name.value.trim() || s.name, url: u });
    return true;
  });
  if (v === 'ok') toast('已儲存');
  return v === 'ok';
}

async function passwordDialog(s: ServerProfile) {
  if (!tokens.get(s.id) && !(await loginDialog(s))) return;
  const cur = h('input', { type: 'password', class: 'input', placeholder: '目前的管理員密碼' });
  const next = h('input', { type: 'password', class: 'input', placeholder: '新密碼（至少 8 個字元）' });
  const again = h('input', { type: 'password', class: 'input', placeholder: '再輸入一次新密碼' });
  const err = h('p', { class: 'error' });
  const v = await modal('更換管理員密碼', [cur, h('div', { style: 'height:8px' }), next, h('div', { style: 'height:8px' }), again, err], [
    { label: '取消', value: '' },
    { label: '更換', value: 'ok', kind: 'primary' },
  ], async () => {
    if (next.value.length < 8) return (err.textContent = '新密碼至少 8 個字元'), false;
    if (next.value !== again.value) return (err.textContent = '兩次輸入的新密碼不一樣'), false;
    try {
      const r = await api<{ token: string; expiresAt: string }>(s, '/api/admin/password', { body: { current: cur.value, next: next.value }, auth: true });
      tokens.set(s.id, r.token, r.expiresAt);
      return true;
    } catch (e) {
      err.textContent = (e as Error).message;
      return false;
    }
  });
  if (v === 'ok') toast('管理員密碼已更換，其他地方的登入都已登出');
}

/** Private repos cannot use the one-click button; Cloudflare can still build them once it is allowed to read the repo. */
function gitConnectHelp() {
  const code = (t: string) => h('code', null, t);
  return h('details', { class: 'more' },
    h('summary', null, '程式碼放在私有 repo？改用「連結 Git」部署'),
    h('p', { class: 'muted small' }, '一鍵部署需要程式碼是公開的。私有 repo 可以讓 Cloudflare 直接讀取後自己建置，不用公開任何東西（畫面名稱可能依 Cloudflare 的版本略有不同）：'),
    h('ol', { class: 'steps' },
      h('li', null, '到 ', h('a', { href: settings.links.cloudflareDashboard, target: '_blank', rel: 'noopener' }, 'Cloudflare 主控台'), '，左側選「Workers 和 Pages」→「建立」→「匯入 Git 儲存庫（Import a repository）」。'),
      h('li', null, '連結 GitHub，授權 Cloudflare 讀取這個 repo（私有的也可以，只要你的帳號有存取權）。'),
      h('li', null, '專案名稱填 ', code(settings.workerName), '，「根目錄（Root directory）」填 ', code(settings.projectDir), '。'),
      h('li', null, '建置指令填 ', code('npm run build'), '，部署指令填 ', code('npx wrangler deploy'), '。'),
      h('li', null, '在「變數（Variables）」加上 ', code('ADMIN_PASSWORD'), '（你的管理員密碼，至少 8 個字元，類型選「密碼／機密」）。'),
      h('li', null, '按部署，完成後複製畫面上的 ', code('https://….workers.dev'), ' 網址，回到下面第 3 步貼上。'),
    ),
    h('p', { class: 'hint' }, '如果 Worker 的名稱和專案名稱不同（例如一鍵部署時改了名字），部署指令請改成 ', code('npm run deploy:ci'), '，並在建置變數的 ', code('VAULT_SETTINGS'), ' 加上 ', code('{"worker":{"name":"你的 Worker 名稱"}}'), '，否則會建出另一個空的 Worker。'),
    h('p', { class: 'hint' }, '想改名稱、限制或預設值：在同一個頁面的建置變數新增 ', code('VAULT_SETTINGS'), '（JSON，格式見專案說明的「參數」），重新部署就會生效。'),
  );
}

/** The step-by-step setup guide. */
function wizard(done: () => void) {
  const name = h('input', { class: 'input', placeholder: '例如：我的伺服器', value: '我的伺服器' });
  const url = h('input', { class: 'input mono', placeholder: `https://${settings.workerName}.你的名稱.workers.dev` });
  const result = h('div');
  const testBtn = h('button', { class: 'btn primary' }, '測試連線');

  testBtn.addEventListener('click', async () => {
    clear(result);
    const u = normaliseUrl(url.value);
    if (!u) {
      result.append(h('p', { class: 'error' }, '請貼上伺服器網址（部署完成後 Cloudflare 顯示的 https://… 網址）'));
      return;
    }
    testBtn.disabled = true;
    testBtn.textContent = '連線中…';
    try {
      const info = await serverInfo(u);
      const profile: ServerProfile = { id: randomId(6), name: name.value.trim() || '我的伺服器', url: u };
      result.append(h('p', { class: 'hint ok' }, `✓ 連線成功！這是一台${APP_NAME}伺服器。`));
      result.append(adminStep(profile, info.adminConfigured, done));
    } catch (e) {
      result.append(h('p', { class: 'error' }, (e as Error).message));
      if (e instanceof ApiError && e.code === 'network') {
        result.append(h('p', { class: 'hint' }, '剛部署完通常要等 1～2 分鐘才會生效，可以稍後再按一次「測試連線」。'));
      }
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '測試連線';
    }
  });

  return h('div', { class: 'wizard' },
    step(1, '註冊 Cloudflare 免費帳號', [
      h('p', null, '打開 Cloudflare 註冊頁，用 Email 註冊並完成信箱驗證。選', h('strong', null, '免費方案（Free）'), '就夠用，不需要信用卡。'),
      h('a', { class: 'btn', href: settings.links.cloudflareSignup, target: '_blank', rel: 'noopener' }, '開啟 Cloudflare 註冊頁 ↗'),
      h('p', { class: 'hint' }, '已經有帳號？直接到第 2 步。'),
    ]),
    DEPLOY_BUTTON_URL
      ? step(2, '一鍵部署伺服器', [
          h('p', null, '按下面的按鈕，會在新分頁打開 Cloudflare 的部署頁：'),
          h('ol', { class: 'steps' },
            h('li', null, '登入 Cloudflare。'),
            h('li', null, '畫面要求連結 ', h('strong', null, 'GitHub'), ' 時，照指示登入或免費註冊 GitHub（Cloudflare 會在你的 GitHub 建一份程式副本，之後可以自動更新）。'),
            h('li', null, '看到 ', h('code', null, 'ADMIN_PASSWORD'), ' 欄位時，輸入你自己想要的', h('strong', null, '管理員密碼'), '（至少 8 個字元，請記下來）。'),
            h('li', null, '其他欄位保持預設，按 ', h('strong', null, 'Create and deploy'), '（建立並部署）。'),
            h('li', null, '等 1～2 分鐘部署完成，複製畫面上 ', h('code', null, 'https://….workers.dev'), ' 的網址。這個網址同時也是你自己的打包器網頁。'),
          ),
          h('a', { class: 'btn primary', href: DEPLOY_BUTTON_URL, target: '_blank', rel: 'noopener' }, '☁️ 部署到 Cloudflare ↗'),
          gitConnectHelp(),
          h('details', { class: 'more' },
            h('summary', null, '找不到網址？'),
            h('p', null, '到 Cloudflare 主控台左側選「Workers 和 Pages（Workers & Pages）」→ 點 ', h('code', null, settings.workerName), ' → 右上角「造訪（Visit）」旁邊的網址就是。'),
            h('p', null, h('a', { href: settings.links.cloudflareDashboard, target: '_blank', rel: 'noopener' }, '開啟 Cloudflare 主控台 ↗')),
          ),
        ])
      : step(2, '取得伺服器網址', [
          h('p', null, '這份打包器沒有設定一鍵部署的來源。請向提供這份打包器的人索取伺服器網址，直接到下一步貼上；或依專案說明自行部署一台。'),
          gitConnectHelp(),
        ]),
    step(3, '連線並登入', [
      h('div', { class: 'field' }, h('label', { class: 'label' }, '幫這台伺服器取個名字'), name),
      h('div', { class: 'field' }, h('label', { class: 'label' }, '伺服器網址'), url, h('p', { class: 'hint' }, '貼上第 2 步複製的網址')),
      testBtn,
      result,
    ]),
  );
}

function adminStep(profile: ServerProfile, configured: boolean, done: () => void) {
  const pw = h('input', { type: 'password', class: 'input', placeholder: configured ? '輸入部署時設定的管理員密碼' : '設定管理員密碼（至少 8 個字元）' });
  const pw2 = configured ? null : h('input', { type: 'password', class: 'input', placeholder: '再輸入一次' });
  const err = h('p', { class: 'error' });
  const btn = h('button', { class: 'btn primary' }, configured ? '登入並儲存' : '設定密碼並儲存');
  btn.addEventListener('click', async () => {
    err.textContent = '';
    if (!configured) {
      if (pw.value.length < 8) return void (err.textContent = '管理員密碼至少 8 個字元');
      if (pw.value !== pw2!.value) return void (err.textContent = '兩次輸入的密碼不一樣');
    }
    btn.disabled = true;
    try {
      await login(profile, pw.value, !configured);
      servers.upsert(profile);
      toast('伺服器設定完成！');
      done();
    } catch (e) {
      err.textContent = (e as Error).message;
      btn.disabled = false;
    }
  });
  return h('div', { class: 'admin-step' },
    configured ? h('p', null, '最後，輸入管理員密碼登入：') : h('p', { class: 'note warn' }, '這台伺服器還沒有設定管理員密碼（部署時沒有填 ADMIN_PASSWORD）。請現在設定一組：'),
    pw, pw2 ? h('div', { style: 'height:8px' }) : null, pw2, err, btn,
  );
}

function step(n: number, title: string, body: (Node | string)[]) {
  return h('section', { class: 'card step' }, h('div', { class: 'step-num' }, String(n)), h('div', { class: 'step-body' }, h('h2', null, title), ...body));
}
