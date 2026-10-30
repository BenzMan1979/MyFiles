import './style.css';
import { APP_NAME } from '../shared/config';
import { clear, h } from '../shared/dom';
import { hasUnsavedResult, renderCreate } from './createPage';
import { randomId } from '../core/keytext';
import { settings } from '../shared/settings';
import { serverInfo, servers } from './api';
import { renderHelp } from './helpPage';
import { renderHome } from './homePage';
import { renderManage } from './managePage';
import { renderServers } from './serverPage';
import { toast } from './ui';

const ROUTES: { id: string; icon: string; label: string; render: (root: HTMLElement, rerender: () => void) => void }[] = [
  { id: 'home', icon: '🏠', label: '首頁', render: renderHome },
  { id: 'servers', icon: '🌐', label: '伺服器設定', render: renderServers },
  { id: 'create', icon: '📦', label: '建立封存檔', render: renderCreate },
  { id: 'manage', icon: '📋', label: '管理封存檔', render: renderManage },
  { id: 'help', icon: '❓', label: '使用說明', render: renderHelp },
];

const app = document.getElementById('app')!;
const nav = h('nav', { class: 'app-nav' });
const main = h('main', { class: 'app-main' });
app.append(
  h('div', { class: 'app-shell' },
    h('aside', { class: 'app-side' }, h('div', { class: 'app-brand' }, '🔐 ', APP_NAME, h('span', { class: 'muted small' }, ' 打包器')), nav),
    main,
  ),
);

function render() {
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

window.addEventListener('hashchange', render);
// Button handlers are async; surface any failure (e.g. lost connection) instead of failing silently.
window.addEventListener('unhandledrejection', (e) => toast((e.reason as Error)?.message ?? '發生錯誤', 'error'));
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedResult()) e.preventDefault();
});
render();

// Opened from a vault server itself (say, on a new computer)? Then it is already "my server": add it,
// so that only the admin login is left to do. Nothing secret is stored, just its name and address.
if (settings.autoAddServer && location.protocol.startsWith('http') && servers.autoAddAllowed() && !servers.list().some((s) => s.url === location.origin)) {
  serverInfo(location.origin)
    .then((info) => {
      // A server that has no admin password yet goes through the setup card on the servers page instead.
      if (!info.adminConfigured) return;
      servers.upsert({ id: randomId(6), name: '我的伺服器', url: location.origin });
      render();
    })
    .catch(() => {});
}
