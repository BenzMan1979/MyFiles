import './style.css';
import { APP_NAME } from '../shared/config';
import { clear, h } from '../shared/dom';
import { hasUnsavedResult, renderCreate } from './createPage';
import { randomId } from '../core/keytext';
import { settings } from '../shared/settings';
import { authMode, login, serverInfo, servers, tokens } from './api';
import { finishGoogleLogin, googleLoginBody, isGoogleReturn } from './googleLogin';
import { renderHome } from './homePage';
import { renderCloud } from './cloudPage';
import { renderManage } from './managePage';
import { renderServers } from './serverPage';
import { renderUsers } from './usersPage';
import { toast } from './ui';

// Every page keeps its own address (#create, #servers, ...), so links between pages and the return
// from Google sign-in work as before. The menu only shows the four groups; a group with several
// pages shows them as tabs at the top of the page (`short` is the tab's label).
const ROUTES: { id: string; label: string; short: string; render: (root: HTMLElement, rerender: () => void) => void }[] = [
  { id: 'home', label: '首頁', short: '首頁', render: renderHome },
  { id: 'create', label: '建立封存檔', short: '建立', render: renderCreate },
  { id: 'manage', label: '管理封存檔', short: '管理', render: renderManage },
  { id: 'servers', label: '伺服器設定', short: '伺服器', render: renderServers },
  { id: 'cloud', label: '雲端空間', short: '雲端空間', render: renderCloud },
  { id: 'users', label: '使用者與登入', short: '使用者與登入', render: renderUsers },
];
const GROUPS: { id: string; icon: string; label: string; routes: string[] }[] = [
  { id: 'home', icon: '🏠', label: '首頁', routes: ['home'] },
  { id: 'vaults', icon: '📦', label: '封存檔', routes: ['create', 'manage'] },
  { id: 'settings', icon: '⚙️', label: '設定', routes: ['servers', 'cloud', 'users'] },
];
/** the page each group opens on: the one visited last, else its first */
const lastIn: Record<string, string> = {};

const app = document.getElementById('app')!;
const nav = h('nav', { class: 'app-nav' });
const main = h('main', { class: 'app-main' });
const shell = h('div', { class: 'app-shell' },
  h('aside', { class: 'app-side' }, h('div', { class: 'app-brand' }, '🔐 ', APP_NAME, h('span', { class: 'muted small' }, ' 打包器')), nav),
  main,
);
app.append(shell);

/**
 * When the default server signs in with Google, the packer opens on its login screen and there is no
 * way past it without signing in: the owner chose who may use it. Signing in there is all it takes
 * (the server is logged in too). What actually protects the vaults, people and cloud storages is
 * the server, which refuses every admin request without a valid sign-in.
 */
function gate(): boolean {
  const d = servers.default();
  if (!d || d.auth !== 'google' || tokens.get(d.id)) return false;
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
  main.append(
    h('div', { class: 'center-screen' },
      h('div', { class: 'card gate' },
        h('div', { class: 'brand' }, '🔐 ', APP_NAME),
        h('h1', null, '登入'),
        ...g.body.slice(0, 1),
        go, err,
        ...g.body.slice(1),
      ),
    ),
  );
  document.title = `登入 · ${APP_NAME} 打包器`;
  return true;
}

function render() {
  if (gate()) return;
  shell.classList.remove('gated');
  const asked = location.hash.replace('#', '') || 'home';
  // the help is part of the home page now; the old #help address still works and scrolls to it
  const id = asked === 'help' ? 'home' : asked;
  const route = ROUTES.find((r) => r.id === id) ?? ROUTES[0];
  const group = GROUPS.find((g) => g.routes.includes(route.id))!;
  lastIn[group.id] = route.id;
  clear(nav);
  for (const g of GROUPS) {
    nav.append(h('a', { href: `#${lastIn[g.id] ?? g.routes[0]}`, class: g === group ? 'active' : '', 'aria-current': g === group ? 'page' : null },
      h('span', { class: 'nav-icon' }, g.icon), h('span', { class: 'nav-label' }, g.label)));
  }
  clear(main);
  const page = h('div', { class: 'page' });
  if (group.routes.length > 1) {
    page.append(h('nav', { class: 'subnav', 'aria-label': group.label },
      ...group.routes.map((id) => {
        const r = ROUTES.find((x) => x.id === id)!;
        return h('a', { href: `#${id}`, class: r === route ? 'active' : '', 'aria-current': r === route ? 'page' : null }, r.short);
      })));
  }
  main.append(page);
  route.render(page, render);
  if (asked === 'help') requestAnimationFrame(() => document.getElementById('help-section')?.scrollIntoView({ block: 'start' }));
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
