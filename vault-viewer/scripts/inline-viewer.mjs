// Inlines the built viewer JS/CSS into one HTML template.
//   src/generated/viewer-template.html  -> imported by the packer (contains the payload marker)
//   dist-viewer/open.html               -> hosted page for phones (no payload; asks for a file)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const js = readFileSync('dist-viewer/viewer.js', 'utf8');
const css = readFileSync('dist-viewer/viewer.css', 'utf8');

// A raw "</script" or "<!--" inside the inline script would end or derail the <script> element.
const safeJs = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
if (/<\/script/i.test(safeJs) || safeJs.includes('<!--')) throw new Error('unsafe sequence left in viewer.js');
const safeCss = css.replace(/<\/style/gi, '<\\/style');

const page = (title, payload) => `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${safeCss}</style>
</head>
<body>
<div id="app"><noscript>請允許 JavaScript 才能開啟這個檔案。</noscript></div>
${payload}
<script type="module">${safeJs}</script>
</body>
</html>
`;

mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/viewer-template.html', page('__VAULT_TITLE__', '<!--VAULT-PAYLOAD-->'));
writeFileSync('dist-viewer/open.html', page('隨身密閱 檢視器', ''));
console.log(`viewer template: ${(js.length / 1024).toFixed(0)} KB js, ${(css.length / 1024).toFixed(0)} KB css`);
