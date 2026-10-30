// Word documents, drawn by docx-preview (embedded images, tables, headers and footers).

import { renderAsync } from 'docx-preview';
import { h } from '../shared/dom';

export async function renderDocx(box: HTMLElement, data: Uint8Array): Promise<() => void> {
  const holder = h('div', { class: 'docx-view' });
  box.append(holder);
  await renderAsync(data, holder, undefined, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    useBase64URL: true, // images inline, nothing stays behind as a blob address
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    ignoreLastRenderedPageBreak: false,
  });
  // A document can carry any link target: keep real web links, drop the rest (javascript:, file:, ...)
  for (const a of Array.from(holder.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else if (!href.startsWith('#')) a.removeAttribute('href');
  }
  return () => holder.remove();
}
