import { HOSTED_OPEN_URL } from '../shared/config';
import { h } from '../shared/dom';
import { section } from './ui';

const qa = (q: string, ...a: (Node | string)[]) => h('details', { class: 'faq' }, h('summary', null, q), h('div', null, ...a));

export function renderHelp(root: HTMLElement) {
  root.append(
    h('div', { class: 'page-head' }, h('h1', null, '❓ 使用說明')),
    section('收件人怎麼開啟',
      h('ol', { class: 'steps' },
        h('li', null, '電腦：雙擊 .vault.html，用 Chrome、Edge、Firefox 或 Safari 打開。'),
        h('li', null, '輸入密碼，貼上金鑰文字或選擇 .key 金鑰檔，按「解鎖」。'),
        h('li', null, '手機：請到 ', h('a', { href: HOSTED_OPEN_URL, target: '_blank', rel: 'noopener' }, HOSTED_OPEN_URL), ' 選擇封存檔（金鑰可以用相機掃描金鑰卡上的 QR Code 取得文字再貼上）。'),
      ),
    ),
    section('PowerPoint 簡報怎麼處理',
      h('p', null, '瀏覽器無法準確呈現 PowerPoint，請先轉成 PDF 再加入：'),
      h('ol', { class: 'steps' },
        h('li', null, '用 PowerPoint 打開簡報。'),
        h('li', null, '「檔案」→「匯出」→「建立 PDF/XPS 文件」（Mac：「檔案」→「匯出」→ 格式選 PDF）。'),
        h('li', null, '把產生的 PDF 加進封存檔。版面、字型都會和 PowerPoint 一樣。'),
      ),
    ),
    section('常見問題',
      qa('忘記密碼或弄丟金鑰怎麼辦？', h('p', null, '沒有辦法救回，這是加密的本質（連你的伺服器也解不開）。請重新建立一份封存檔，並在管理頁收回舊的那份。')),
      qa('次數和期限真的擋得住嗎？', h('p', null, h('strong', null, '線上模式'), '：由你的伺服器判斷，複製檔案、改電腦時間、換瀏覽器都繞不過，收回後立即失效。'), h('p', null, h('strong', null, '離線模式'), '：只記在對方的瀏覽器裡，清除瀏覽資料或換瀏覽器就能重來，只能防君子。')),
      qa('能防止截圖嗎？', h('p', null, '不行。任何顯示在螢幕上的內容都可能被截圖或翻拍。浮水印會在畫面上印出收件人名稱和時間，外流時可以追查來源，這是最有效的嚇阻方式。')),
      qa('對方開了之後，我收回還來得及嗎？', h('p', null, '收回後，對方下次開啟或自動上鎖後就打不開。但已經顯示在畫面上的內容，懂技術的人可能在當下存下來，所以重要文件請搭配浮水印並禁止下載。')),
      qa('為什麼不建議用 Email 附件寄封存檔？', h('p', null, '「內含加密資料的 HTML 檔」和某些惡意程式的手法很像，公司信箱可能會擋下或隔離。用雲端硬碟連結或隨身碟最穩。')),
      qa('檔案太大怎麼辦？', h('p', null, '單份封存檔建議 300MB 以內。影片可以先用 HandBrake 等工具壓縮成 MP4，或把文件分成幾份封存。')),
      qa('伺服器要錢嗎？', h('p', null, 'Cloudflare 免費方案每天可以處理 10 萬次請求，一般使用完全免費。')),
      qa('我的檔案會被上傳嗎？', h('p', null, '不會。加密在你的電腦上完成；線上模式只會把「伺服器那一份金鑰」和使用條件送到你自己的伺服器。')),
    ),
  );
}
