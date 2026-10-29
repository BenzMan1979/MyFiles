// Allow-list HTML sanitizer for Markdown output and .html files shown inside the viewer.

const TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol',
  'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'center', 'font', 'input',
]);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'link', 'meta', 'title', 'head', 'button', 'select', 'textarea', 'video', 'audio', 'canvas', 'base']);
const ATTRS = new Set(['alt', 'title', 'colspan', 'rowspan', 'align', 'start', 'type', 'checked', 'disabled', 'open']);

function safeUrl(v: string, forImage: boolean): string | null {
  const s = v.trim();
  if (forImage) return /^data:image\/(png|jpe?g|gif|webp);/i.test(s) ? s : null;
  return /^(https?:|mailto:|#)/i.test(s) ? s : null;
}

function clean(node: Node, doc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return null;
  const kids = Array.from(el.childNodes, (c) => clean(c, doc)).filter((c): c is Node => !!c);
  if (!TAGS.has(tag)) {
    const frag = doc.createDocumentFragment();
    kids.forEach((k) => frag.appendChild(k));
    return frag;
  }
  if (tag === 'input' && el.getAttribute('type') !== 'checkbox') return null;
  const out = doc.createElement(tag);
  for (const a of Array.from(el.attributes)) {
    const name = a.name.toLowerCase();
    if (ATTRS.has(name)) out.setAttribute(name, a.value);
    else if (name === 'href' && tag === 'a') {
      const u = safeUrl(a.value, false);
      if (u) {
        out.setAttribute('href', u);
        out.setAttribute('target', '_blank');
        out.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (name === 'src' && tag === 'img') {
      const u = safeUrl(a.value, true);
      if (u) out.setAttribute('src', u);
    }
  }
  if (tag === 'input') out.setAttribute('disabled', '');
  kids.forEach((k) => out.appendChild(k));
  return out;
}

export function sanitizeHtml(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  for (const c of Array.from(parsed.body.childNodes)) {
    const n = clean(c, document);
    if (n) frag.appendChild(n);
  }
  return frag;
}
