// Shared helper: inline a JS bundle and CSS into a standalone HTML page.
export function inlinePage({ title, js, css, body = '', lang = 'zh-Hant', settings = '' }) {
  // A raw "</script" or "<!--" inside the inline script would end or derail the <script> element.
  const safeJs = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  if (/<\/script/i.test(safeJs) || safeJs.includes('<!--')) throw new Error('unsafe sequence left in bundle');
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${safeCss}</style>
</head>
<body>
<div id="app"><noscript>請允許 JavaScript 才能使用。</noscript></div>
${settings}
${body}
<script type="module">${safeJs}</script>
</body>
</html>
`;
}
