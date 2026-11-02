import './style.css';
import { APP_NAME } from '../shared/config';
import { clear, h } from '../shared/dom';
import { hasUnsavedResult, renderCreate } from './createPage';
import { randomId } from '../core/keytext';
import { settings } from '../shared/settings';
import { authMode, login, serverInfo, servers, tokens } from './api';
import { finishGoogleLogin, googleLoginBody, isGoogleReturn } from './googleLogin';
import { renderHelp } from './helpPage';
import { renderHome } from './homePage';
import { renderCloud } from './cloudPage';
import { renderManage } from './managePage';
import { renderServers } from './serverPage';
import { renderUsers } from './usersPage';
import { toast } from './ui';

const ROUTES: { id: string; icon: string; label: string; render: (root: HTMLElement, rerender: () => void) => void }[] = [
  { id: 'home', icon: '🏠', label: '首頁', render: renderHome },
  { id: 'servers', icon: '🌐', label: '伺服器設定', render: renderServers },
  { id: 'cloud', icon: '☁️', label: '雲端空間', render: renderCloud },
  { id: 'create', icon: '📦', label: '建立封存檔', render: renderCreate },
  { id: 'manage', icon: '📋', label: '管理封存檔', render: renderManage },
  { id: 'users', icon: '👥', label: '使用者與登入', render: renderUsers },
  { id: 'help', icon: '❓', label: '使用說明', render: renderHelp },
];

const app = document.getElementById('app')!;
const nav = h('nav', { class: 'app-nav' });
const main = h('main', { class: 'app-main' });
const shell = h('div', { class: 'app-shell' },
  h('aside', { class: 'app-side' }, h('div', { class: 'app-brand' }, '🔐 ', APP_NAME, h('span', { class: 'muted small' }, ' 打包器')), nav),
  main,
);
app.append(shell);

const SKIP_GATE = 'vault-packer:skip-gate';
const gateSkipped = () => {
  try {
    return sessionStorage.getItem(SKIP_GATE) === '1';
  } catch {
    return false;
  }
};

/**
 * When the default server signs in with Google, the packer opens on its login screen; signing in
 * there is all it takes (the server is logged in too). The pages hold no secrets, so this is about
 * getting people to sign in, not protection: that is the server's job.
 */
function gate(): boolean {
  const d = servers.default();
  if (!d || d.auth !== 'google' || tokens.get(d.id) || gateSkipped() || location.hash === '#servers') return false;
  clear(nav);
  clear(main);
  shell.classList.add('gated');
  const g = googleLoginBody(d, async (password, remember) => {
    await login(d, password, false, remember);
    render();
  });
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary wide' }, 'G 用 Google 登入');
  go.addEventListener('click', () => g.go().catch((e: Error) => (err.textContent = e.message)));
  const skip = (hash: string) => () => {
    try {
      sessionStorage.setItem(SKIP_GATE, '1');
    } catch {
      /* storage unavailable */
    }
    location.hash = hash;
    render();
  };
  main.append(
    h('div', { class: 'center-screen' },
      h('div', { class: 'card gate' },
        h('div', { class: 'brand' }, '🔐 ', APP_NAME),
        h('h1', null, '登入'),
        ...g.body.slice(0, 1),
        go, err,
        ...g.body.slice(1),
        h('p', { class: 'foot muted small' },
          h('button', { class: 'link', onclick: skip('#servers') }, '改用其他伺服器'), '　·　',
          h('button', { class: 'link', onclick: skip('#create') }, '不登入，只做離線封存檔')),
      ),
    ),
  );
  document.title = `登入 · ${APP_NAME} 打包器`;
  return true;
}

function render() {
  if (gate()) return;
  shell.classList.remove('gated');
  const id = location.hash.replace('#', '') || 'home';
  const route = ROUTES.find((r) => r.id === id) ?? ROUTES[0];
  clear(nav);
  for (const r of ROUTES) nav.append(h('a', { href: `#${r.id}`, class: r === route ? 'active' : '' }, h('span', null, r.icon), ' ', r.label));
  clear(main);
  const page = h('div', { class: 'page' });
  main.append(page);
  route.render(page, render);
  document.title = `${route.label} · ${APP_NAME} 打包器`;
}

window.addEventListener('hashchange', () => {
  if (!isGoogleReturn()) render();
});
// Button handlers are async; surface any failure (e.g. lost connection) instead of failing silently.
window.addEventListener('unhandledrejection', (e) => toast((e.reason as Error)?.message ?? '發生錯誤', 'error'));
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedResult()) e.preventDefault();
});
if (isGoogleReturn()) {
  // back from Google: ask for the authenticator code first, then show the page the sign-in started from
  void finishGoogleLogin().finally(render);
} else {
  render();
}

// Learn how the default server signs in (the login screen shows straight away next time).
{
  const d = servers.default();
  if (d && location.protocol.startsWith('http')) {
    const before = d.auth;
    authMode(d)
      .then((mode) => {
        if (mode !== before && !isGoogleReturn()) render();
      })
      .catch(() => {});
  }
}

// Opened from a vault server itself (say, on a new computer)? Then it is already "my server": add it,
// so that only the admin login is left to do. Nothing secret is stored, just its name and address.
if (settings.autoAddServer && location.protocol.startsWith('http') && servers.autoAddAllowed() && !servers.list().some((s) => s.url === location.origin)) {
  serverInfo(location.origin)
    .then((info) => {
      // A server that has no admin password yet goes through the setup card on the servers page instead.
      if (!info.adminConfigured) return;
      servers.upsert({ id: randomId(6), name: '我的伺服器', url: location.origin, auth: info.auth?.mode });
      render();
    })
    .catch(() => {});
}
