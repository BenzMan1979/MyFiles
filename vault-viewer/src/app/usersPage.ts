// "使用者與登入": how the packer signs in (admin password, or Google account + authenticator app),
// who may sign in (listed accounts, whole domains, anyone), and the people: owners and members.

import { clear, formatDateTime, h } from '../shared/dom';
import { api, listClouds, servers, tokens, type AuthView, type ServerProfile, type UserInfo } from './api';
import { recoveryDialog, startGoogleLogin } from './googleLogin';
import { loginDialog } from './serverPage';
import { confirmDialog, copyButton, columns, field, modal, section, stackable, toast } from './ui';

let selectedServer = '';

export const setUsersServer = (id: string) => {
  selectedServer = id;
};

export function renderUsers(root: HTMLElement, rerender: () => void) {
  root.append(
    h('div', { class: 'page-head' },
      h('h1', null, '👥 使用者與登入'),
      h('p', { class: 'muted' }, '決定打包器怎麼登入、誰可以使用。開啟 Google 登入後，每個人用自己的 Google 帳號＋手機上的驗證器 App 登入；擁有者管理所有東西，成員只看得到自己建立的封存檔。收件人不受影響，照樣不需要登入。'),
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

  const me = tokens.user(server.id);
  if (!me) {
    root.append(h('div', { class: 'card section' }, h('p', null, '請先登入這台伺服器。'), h('button', { class: 'btn primary', onclick: () => loginDialog(server).then((ok) => ok && rerender()) }, '登入')));
    return;
  }
  if (me.email) root.append(myAccount(server, me.email));
  if (me.role !== 'owner') {
    root.append(h('p', { class: 'note' }, '登入方式與使用者名單由擁有者管理。'));
    return;
  }
  const body = h('div', null, h('div', { class: 'empty' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, '讀取中…')));
  root.append(body);
  void load(server, body, rerender);
}

function myAccount(server: ServerProfile, email: string) {
  return section('我的帳號',
    h('p', null, h('strong', null, email)),
    h('p', { class: 'hint' }, '換手機時，先在新手機的驗證器 App 加入帳號：請擁有者在下面的名單幫你按「重設驗證器」，下次登入就會出現新的 QR Code。備用碼用完或遺失時，可以產生一組新的（舊的會失效）。'),
    h('button', {
      class: 'btn small',
      onclick: async () => {
        if (!(await confirmDialog('產生新的備用碼', '舊的備用碼會全部失效。確定嗎？', '產生'))) return;
        const r = await api<{ recoveryCodes: string[] }>(server, '/api/admin/me/recovery', { body: {}, auth: true });
        await recoveryDialog(r.recoveryCodes, email);
      },
    }, '產生新的備用碼'),
  );
}

async function load(server: ServerProfile, body: HTMLElement, rerender: () => void) {
  let v: AuthView;
  try {
    v = await api<AuthView>(server, '/api/admin/auth', { auth: true });
  } catch (e) {
    clear(body);
    body.append(h('p', { class: 'note warn' }, (e as Error).message.includes('找不到這個功能') ? '這台伺服器的版本還不支援 Google 登入，請更新伺服器（重新部署）。' : (e as Error).message));
    return;
  }
  clear(body);
  if (v.me.breakGlass) {
    body.append(h('p', { class: 'note warn' }, '你現在是用部署時的備用密碼登入。處理完之後，建議到 Cloudflare 把 ADMIN_PASSWORD 換成新的一組。'));
  }
  body.append(columns(
    [v.mode === 'google' ? googleMode(server, v, rerender) : passwordMode(server, v, rerender)],
    [v.mode === 'google' || v.users.length ? people(server, v, rerender) : null],
  ));
}

// ---------- sign-in mode ----------

function passwordMode(server: ServerProfile, v: AuthView, rerender: () => void) {
  const redirect = `${server.url}/api/storage/google/callback`;
  const clientBox = h('div');
  const status = v.google ? h('p', { class: 'hint ok' }, `✓ 已設定 OAuth 用戶端：${v.google.clientId}`) : h('p', { class: 'hint' }, '還沒有設定。');
  const fillClient = async () => {
    clear(clientBox);
    let drives: { id: string; name: string; account: string }[] = [];
    try {
      drives = (await listClouds(server)).profiles.filter((p) => p.type === 'gdrive' && p.status === 'ready');
    } catch {
      /* cloud storages not available */
    }
    const id = h('input', { class: 'input mono', placeholder: '….apps.googleusercontent.com', value: v.google?.clientId ?? '' });
    const secret = h('input', { class: 'input mono', type: 'password', placeholder: v.google?.hasSecret ? '（不變）' : 'GOCSPX-…' });
    const save = async (payload: object) => {
      try {
        await api(server, '/api/admin/auth/google', { body: payload, auth: true });
        toast('已儲存 OAuth 用戶端');
        rerender();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    };
    clientBox.append(
      drives.length
        ? h('div', { class: 'row-buttons' }, ...drives.map((d) => h('button', { class: 'btn small primary', onclick: () => save({ fromStorage: d.id }) }, `沿用 Google Drive「${d.name}」的用戶端`)))
        : '',
      h('details', { class: 'more', open: !drives.length },
        h('summary', null, drives.length ? '或手動輸入' : '輸入 OAuth 用戶端'),
        field('用戶端 ID（Client ID）', id), field('用戶端密鑰（Client Secret）', secret),
        h('button', { class: 'btn small', onclick: () => save({ clientId: id.value, clientSecret: secret.value }) }, '儲存'),
      ),
    );
  };
  void fillClient();
  return section('登入方式：管理員密碼',
    h('p', null, '目前用一組管理員密碼登入，知道密碼的人都有全部權限。要讓多人各自登入、分開管理，請改用 Google 登入＋驗證器：'),
    h('ol', { class: 'steps' },
      h('li', null, h('strong', null, 'OAuth 用戶端：'), '已經連結 Google Drive 的話，直接沿用同一組；否則照「☁️ 雲端空間 →＋ Google Drive」的說明在 Google Cloud 建立一組。重新導向 URI 和 Google Drive 用的是同一個，不用另外加：',
        h('div', { class: 'copy-line', style: 'margin:6px 0' }, h('span', { class: 'mono' }, redirect), copyButton(() => redirect)), status, clientBox),
      h('li', null, h('strong', null, '準備手機：'), '安裝 Google Authenticator（或 Microsoft Authenticator、1Password 等任何支援驗證碼的 App）。'),
      h('li', null, h('strong', null, '啟用：'), '按下面的按鈕，用你自己的 Google 帳號登入、掃 QR Code 綁定驗證器。完成後你就是擁有者，管理員密碼登入隨即停用。'),
    ),
    h('button', {
      class: 'btn primary',
      disabled: !v.google,
      onclick: async () => {
        if (!(await confirmDialog('改用 Google 登入＋驗證器', '接下來會到 Google 登入，再掃 QR Code 綁定驗證器。完成後，打包器就不能再用管理員密碼登入（部署時設定在 Cloudflare 的 ADMIN_PASSWORD 仍可緊急登入）。', '開始'))) return;
        try {
          await startGoogleLogin(server, 'enable');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      },
    }, '🔐 用 Google 登入並啟用'),
  );
}

function googleMode(server: ServerProfile, v: AuthView, rerender: () => void) {
  const radio = (value: AuthView['access'], label: string, desc: string) =>
    h('label', { class: `choice ${v.access === value ? 'selected' : ''}` },
      h('input', { type: 'radio', name: 'access', value, checked: v.access === value }),
      h('div', null, h('div', { class: 'choice-title' }, label), h('p', { class: 'muted small' }, desc)));
  const domains = h('input', { class: 'input mono', value: v.domains.join(', '), placeholder: '例如 example.com, example.com.tw' });
  const origins = h('textarea', { class: 'input mono', rows: 3, placeholder: 'https://你的名稱.github.io' }, v.returnOrigins.join('\n'));
  const choices = h('div', { class: 'choices' },
    radio('list', '只限名單', '只有下面名單裡的 Google 帳號可以登入（建議）。'),
    radio('domain', '指定網域', '這些網域的帳號都可以登入，第一次登入時自動加入名單，身分是成員。'),
    radio('any', '所有 Google 帳號', '任何人都能登入成為成員，可以用你的伺服器和開放給成員的雲端空間。不建議。'),
  );
  choices.addEventListener('change', () => choices.querySelectorAll('.choice').forEach((c) => c.classList.toggle('selected', (c.querySelector('input') as HTMLInputElement).checked)));
  const save = async () => {
    const access = (choices.querySelector('input:checked') as HTMLInputElement).value;
    if (access === 'any' && v.access !== 'any' && !(await confirmDialog('開放給所有 Google 帳號', '任何有 Google 帳號的人都能登入你的伺服器建立封存檔。確定嗎？', '確定開放', true))) return;
    try {
      await api(server, '/api/admin/auth', {
        method: 'PATCH',
        auth: true,
        body: { access, domains: domains.value.split(/[\s,，、]+/).filter(Boolean), returnOrigins: origins.value.split(/\s+/).filter(Boolean) },
      });
      toast('已儲存');
      rerender();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return section('登入方式：Google 帳號＋驗證器',
    h('p', { class: 'hint ok' }, `✓ 已啟用。OAuth 用戶端：${v.google?.clientId ?? '—'}`),
    h('h3', null, '誰可以登入'),
    choices,
    field('網域（「指定網域」用）', domains, '用逗號分開。不用加 @。'),
    field('允許從這些網址的打包器登入', origins, `伺服器本身（${server.url}）一定可以。打包器放在別的網址（例如 GitHub Pages）時要列在這裡，一行一個。`),
    h('div', { class: 'row-buttons' },
      h('button', { class: 'btn primary', onclick: save }, '儲存'),
      h('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!(await confirmDialog('改回管理員密碼登入', '所有人會被登出，之後只能用管理員密碼登入（名單和驗證器會保留，之後可以再改回來）。確定嗎？', '改回密碼', true))) return;
          await api(server, '/api/admin/auth/password', { body: {}, auth: true });
          tokens.clear(server.id);
          servers.update({ ...server, auth: 'password' });
          toast('已改回管理員密碼登入，請重新登入');
          rerender();
        },
      }, '改回管理員密碼登入'),
    ),
  );
}

// ---------- people ----------

function people(server: ServerProfile, v: AuthView, rerender: () => void) {
  const patch = async (u: UserInfo, body: object, msg: string) => {
    try {
      await api(server, `/api/admin/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body, auth: true });
      toast(msg);
      rerender();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const rows = v.users.map((u) =>
    h('tr', null,
      h('td', null, h('strong', null, u.email), u.email === v.me.email ? h('span', { class: 'chip ok', style: 'margin-left:6px' }, '我') : null),
      h('td', null, u.role === 'owner' ? '擁有者' : '成員'),
      h('td', null, u.disabled ? h('span', { class: 'chip danger' }, '已停用') : u.locked ? h('span', { class: 'chip warn' }, '錯太多次，暫時鎖定') : h('span', { class: 'chip ok' }, '可登入')),
      h('td', null, u.totp ? `已綁定（備用碼剩 ${u.recoveryLeft}）` : h('span', { class: 'muted' }, '下次登入時綁定')),
      h('td', null, u.lastLoginAt ? formatDateTime(u.lastLoginAt) : h('span', { class: 'muted' }, '還沒登入過')),
      h('td', { class: 'actions' }, h('div', null,
        h('button', { class: 'btn small', onclick: () => patch(u, { role: u.role === 'owner' ? 'member' : 'owner' }, '已更新角色') }, u.role === 'owner' ? '改為成員' : '設為擁有者'),
        u.email !== v.me.email ? h('button', { class: 'btn small', onclick: () => patch(u, { disabled: !u.disabled }, u.disabled ? '已啟用' : '已停用') }, u.disabled ? '啟用' : '停用') : null,
        u.locked ? h('button', { class: 'btn small', onclick: () => patch(u, { unlock: true }, '已解除鎖定') }, '解除鎖定') : null,
        u.totp ? h('button', {
          class: 'btn small',
          onclick: async () => {
            if (await confirmDialog('重設驗證器', `${u.email} 下次登入時要重新掃 QR Code（換手機或手機遺失時使用）。他目前的登入會被登出。`, '重設')) await patch(u, { resetTotp: true }, '已重設驗證器');
          },
        }, '重設驗證器') : null,
        u.email !== v.me.email ? h('button', {
          class: 'btn small danger',
          onclick: async () => {
            if (!(await confirmDialog('移除使用者', `從名單移除 ${u.email}？他建立的封存檔會保留，你在「管理封存檔」仍看得到。`, '移除', true))) return;
            try {
              await api(server, `/api/admin/users/${encodeURIComponent(u.email)}`, { method: 'DELETE', auth: true });
              toast('已移除');
              rerender();
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          },
        }, '移除') : null,
      )),
    ),
  );
  const add = async () => {
    const email = h('input', { class: 'input', type: 'email', placeholder: 'someone@gmail.com' });
    const role = h('select', { class: 'input' }, h('option', { value: 'member' }, '成員：只看得到自己建立的封存檔'), h('option', { value: 'owner' }, '擁有者：管理所有東西'));
    const err = h('p', { class: 'error' });
    const r = await modal('新增使用者', [field('Google 帳號（電子郵件）', email), field('身分', role), h('p', { class: 'hint' }, '對方第一次登入時會掃 QR Code 綁定自己的驗證器。請把打包器的網址告訴他。'), err], [
      { label: '取消', value: '' },
      { label: '新增', value: 'ok', kind: 'primary' },
    ], async () => {
      try {
        await api(server, '/api/admin/users', { body: { email: email.value, role: role.value }, auth: true });
        return true;
      } catch (e) {
        err.textContent = (e as Error).message;
        return false;
      }
    });
    if (r === 'ok') {
      toast('已新增');
      rerender();
    }
  };
  return section(`使用者（${v.users.length}）`,
    v.mode !== 'google' ? h('p', { class: 'note' }, '目前用管理員密碼登入，這份名單暫時沒有作用。') : null,
    h('div', { class: 'table-wrap' },
      stackable(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ...['帳號', '身分', '狀態', '驗證器', '最後登入', ''].map((t) => h('th', null, t)))),
        h('tbody', null, ...rows),
      )),
    ),
    h('button', { class: 'btn', onclick: add }, '＋ 新增使用者'),
  );
}
