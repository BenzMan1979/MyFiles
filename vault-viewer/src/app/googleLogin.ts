// Signing in with Google + an authenticator app.
//
// The packer sends this tab to Google; Google returns it to the server, which sends it back here with
// a one-time ticket in the address (#vvlogin=…). The ticket only works together with a secret this
// tab kept (sessionStorage), and is traded, with the 6-digit code, for an admin login.

import { clear, h, saveBlob } from '../shared/dom';
import { api, ApiError, servers, tokens, type ServerProfile, type SignedIn } from './api';
import qrcode from 'qrcode-generator';
import { copyButton, modal, toast } from './ui';

const PENDING = 'vault-packer:google-login';

interface Pending {
  serverId: string;
  verifier: string;
  /** the page to come back to */
  hash: string;
  purpose: 'login' | 'enable';
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Sends this tab to Google's sign-in page. `enable` = the owner switching Google sign-in on. */
export async function startGoogleLogin(server: ServerProfile, purpose: 'login' | 'enable' = 'login'): Promise<void> {
  if (!location.protocol.startsWith('http')) {
    throw new Error('從檔案開啟的打包器不能用 Google 登入：請改用網址開啟（你的伺服器網址或 GitHub Pages）');
  }
  const v = new Uint8Array(32);
  crypto.getRandomValues(v);
  const verifier = b64url(v);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const returnTo = `${location.origin}${location.pathname}`;
  const r = await api<{ authUrl: string }>(server, '/api/auth/google/start', { body: { returnTo, challenge, purpose }, auth: purpose === 'enable' });
  try {
    sessionStorage.setItem(PENDING, JSON.stringify({ serverId: server.id, verifier, hash: location.hash || '#home', purpose } satisfies Pending));
  } catch {
    throw new Error('這個瀏覽器不允許網站儲存資料（無痕模式？），無法完成 Google 登入');
  }
  location.href = r.authUrl;
}

/** True when this page load is the return from Google (handle it before rendering the app). */
export const isGoogleReturn = () => /^#vvlogin(-error)?=/.test(location.hash);

/** Finishes a sign-in after Google sent the tab back. Resolves when done (signed in or given up). */
export async function finishGoogleLogin(): Promise<void> {
  const m = location.hash.match(/^#vvlogin(-error)?=(.*)$/);
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null');
    sessionStorage.removeItem(PENDING);
  } catch {
    /* storage unavailable */
  }
  history.replaceState(null, '', `${location.pathname}${pending?.hash ?? '#home'}`);
  if (!m) return;
  if (m[1]) return void toast(`沒有完成登入：${decodeURIComponent(m[2])}`, 'error');
  const server = pending && servers.get(pending.serverId);
  if (!pending || !server) return void toast('登入資料遺失了（可能換了分頁），請再按一次「用 Google 登入」', 'error');

  const ticket = m[2];
  let step: { next: 'totp' | 'enroll'; email: string; secret?: string; otpauth?: string };
  try {
    step = await api(server, '/api/auth/ticket', { body: { ticket, verifier: pending.verifier } });
  } catch (e) {
    return void toast((e as Error).message, 'error');
  }
  await codeDialog(server, ticket, pending, step);
}

async function codeDialog(server: ServerProfile, ticket: string, pending: Pending, step: { next: string; email: string; secret?: string; otpauth?: string }) {
  const code = h('input', { class: 'input mono code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 9, placeholder: '6 位數驗證碼' });
  const remember = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'error', role: 'alert' });
  const enroll = step.next === 'enroll';
  const body: (Node | string)[] = [h('p', null, '帳號：', h('strong', null, step.email))];
  if (enroll) {
    body.push(
      h('p', null, pending.purpose === 'enable' ? '最後一步：把這台伺服器加到你手機的驗證器 App。' : '第一次登入：請把這個帳號加到你手機的驗證器 App。'),
      h('ol', { class: 'steps' },
        h('li', null, '打開 Google Authenticator（或 Microsoft Authenticator、1Password 等），按「＋」→「掃描 QR 圖碼」。'),
        h('li', null, '掃描下面的 QR Code。不能掃描的話，選「輸入設定金鑰」並貼上金鑰。'),
        h('li', null, '輸入 App 上顯示的 6 位數驗證碼。'),
      ),
      h('div', { class: 'enroll-qr' }, qrBox(step.otpauth!), h('div', null, h('div', { class: 'label' }, '設定金鑰'), h('div', { class: 'copy-line' }, h('span', { class: 'mono key' }, step.secret!.replace(/(.{4})/g, '$1 ').trim()), copyButton(() => step.secret!)))),
    );
  } else {
    body.push(h('p', { class: 'muted' }, '輸入驗證器 App 上的 6 位數驗證碼。手機不在身邊的話，可以輸入一組備用碼。'));
  }
  body.push(h('div', { class: 'field' }, code), h('label', { class: 'check' }, remember, ' 記住這台裝置 30 天（公用電腦請不要勾）'), err);

  let result: { token: string; expiresAt: string; user: SignedIn; recoveryCodes?: string[]; enabled?: boolean } | null = null;
  const v = await modal(enroll ? '綁定驗證器' : '輸入驗證碼', body, [
    { label: '取消', value: '' },
    { label: '登入', value: 'ok', kind: 'primary' },
  ], async () => {
    err.textContent = '';
    try {
      result = await api(server, '/api/auth/totp', { body: { ticket, verifier: pending.verifier, code: code.value.trim(), remember: remember.checked } });
      return true;
    } catch (e) {
      err.textContent = (e as Error).message;
      if (e instanceof ApiError && (e.code === 'ticket' || e.status === 429)) err.textContent += '（請重新按「用 Google 登入」）';
      code.select();
      return false;
    }
  });
  if (v !== 'ok' || !result) return;
  const r = result as { token: string; expiresAt: string; user: SignedIn; recoveryCodes?: string[]; enabled?: boolean };
  tokens.set(server.id, r.token, r.expiresAt, r.user, remember.checked);
  if (r.enabled) servers.update({ ...server, auth: 'google' });
  if (r.recoveryCodes) await recoveryDialog(r.recoveryCodes, r.user.email ?? '');
  toast(r.enabled ? '已改用 Google 登入＋驗證器' : `已登入：${r.user.email}`);
}

function qrBox(text: string) {
  // otpauth addresses need the byte mode (the key-card QR helper only does upper-case alphanumerics)
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const box = h('div', { class: 'qr', style: 'width:180px;height:180px' });
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return box;
}

/** Shows new recovery codes once, with ways to keep them. */
export async function recoveryDialog(codes: string[], email: string) {
  const text = `隨身密閱 備用碼（${email}）\n每組只能用一次，手機遺失時代替驗證碼登入。\n\n${codes.join('\n')}\n`;
  const list = h('div', { class: 'recovery-codes mono' }, ...codes.map((c) => h('span', null, c)));
  await modal('請保存備用碼', [
    h('p', { class: 'note warn' }, '手機遺失或換手機時，可以用這些備用碼代替驗證碼登入，每組只能用一次。這是唯一一次顯示，請現在存好（列印、存到密碼管理器，或放在安全的地方）。'),
    list,
    h('div', { class: 'row-buttons' },
      copyButton(() => text, '複製全部'),
      h('button', { type: 'button', class: 'btn small', onclick: () => saveBlob(new Blob([text], { type: 'text/plain' }), '隨身密閱備用碼.txt') }, '⬇ 下載文字檔'),
    ),
  ], [{ label: '我已經存好了', value: 'ok', kind: 'primary' }]);
}

/** The login dialog for a server that uses Google sign-in (with the spare-key password tucked away). */
export function googleLoginBody(server: ServerProfile, spare: (password: string, remember: boolean) => Promise<void>): { body: Node[]; go: () => Promise<void> } {
  const err = h('p', { class: 'error' });
  const pw = h('input', { type: 'password', class: 'input', placeholder: '部署時設定的 ADMIN_PASSWORD' });
  const remember = h('input', { type: 'checkbox' });
  const spareBtn = h('button', { type: 'button', class: 'btn small' }, '用備用密碼登入');
  spareBtn.addEventListener('click', async () => {
    err.textContent = '';
    try {
      await spare(pw.value, remember.checked);
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  });
  const body = [
    h('p', { class: 'muted' }, `「${server.name}」用 Google 帳號＋驗證器 App 登入。`),
    err,
    h('details', { class: 'more' },
      h('summary', null, '手機和備用碼都不見了？'),
      h('p', { class: 'hint' }, '擁有者可以用部署時設定在 Cloudflare 的 ADMIN_PASSWORD 緊急登入，再到「使用者」頁重設驗證器。'),
      pw, h('label', { class: 'check' }, remember, ' 記住這台裝置 30 天'), spareBtn,
    ),
  ];
  return {
    body,
    go: async () => {
      clear(err);
      try {
        await startGoogleLogin(server);
      } catch (e) {
        err.textContent = (e as Error).message;
        throw e;
      }
    },
  };
}
