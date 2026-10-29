import { APP_NAME, HOSTED_OPEN_URL } from '../shared/config';
import { h } from '../shared/dom';
import { servers, tokens } from './api';
import { section } from './ui';

export function renderHome(root: HTMLElement) {
  const s = servers.default();
  const serverState = s
    ? h('span', { class: `chip ${tokens.get(s.id) ? 'ok' : ''}` }, tokens.get(s.id) ? `✓ ${s.name}（已登入）` : `${s.name}（未登入）`)
    : h('span', { class: 'chip warn' }, '尚未設定');
  const card = (n: string, icon: string, title: string, desc: string, href: string, action: string, extra?: Node) =>
    h('a', { class: 'card home-card', href },
      h('div', { class: 'home-num' }, n),
      h('div', { class: 'big-icon' }, icon),
      h('h2', null, title),
      h('p', { class: 'muted' }, desc),
      extra ?? null,
      h('span', { class: 'btn primary small' }, action, ' →'),
    );
  root.append(
    h('div', { class: 'page-head' },
      h('h1', null, `歡迎使用 ${APP_NAME}`),
      h('p', { class: 'muted' }, '把文件加密成一個檔案，對方雙擊就能用瀏覽器開啟。需要密碼＋金鑰才能看，還可以限制期限、次數，隨時收回。'),
    ),
    h('div', { class: 'home-grid' },
      card('1', '🌐', '設定伺服器', '只要做一次。使用線上模式（可收回、可限制次數）需要它。只做離線封存可以跳過。', '#servers', s ? '查看' : '開始設定', serverState),
      card('2', '📦', '建立封存檔', '選檔案、設定條件與收件人，產生每個人專屬的封存檔和金鑰。', '#create', '建立'),
      card('3', '📋', '管理封存檔', '查看誰開過、剩幾次，延長期限、解除鎖定或立即收回。', '#manage', '管理'),
    ),
    section('運作方式',
      h('ol', { class: 'steps' },
        h('li', null, '你在這個頁面選好檔案，加密都在你自己的電腦上完成，檔案', h('strong', null, '不會上傳'), '。'),
        h('li', null, '每位收件人拿到三樣東西：', h('strong', null, '封存檔'), '（.vault.html）、', h('strong', null, '金鑰'), '、', h('strong', null, '密碼'), '。建議分三個管道傳送。'),
        h('li', null, '對方雙擊封存檔，用瀏覽器打開，輸入密碼和金鑰就能看到左邊檔案列表、右邊內容。'),
        h('li', null, '線上模式每次開啟都會問你的伺服器：沒過期、還有次數、沒被收回才放行。'),
      ),
      h('p', { class: 'hint' }, '手機（特別是 iPhone）無法直接開啟 HTML 檔，請收件人改用 ', h('a', { href: HOSTED_OPEN_URL, target: '_blank', rel: 'noopener' }, '線上檢視頁'), ' 選擇封存檔，解密一樣只在手機上進行。'),
    ),
    location.protocol.startsWith('http')
      ? section('離線使用打包器',
          h('p', { class: 'muted' }, '這個頁面也可以存到電腦上，之後不用連到這個網址也能打包（線上模式仍需要連到你的伺服器）。'),
          h('a', { class: 'btn', href: './index.html', download: '隨身密閱打包器.html' }, '⬇ 下載打包器'),
        )
      : '',
  );
}
