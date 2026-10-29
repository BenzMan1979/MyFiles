// Packer UI helpers: dialogs, toasts, copy buttons, QR codes.

import qrcode from 'qrcode-generator';
import { h } from '../shared/dom';

export function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export function copyButton(text: () => string, label = '複製') {
  const b = h('button', { type: 'button', class: 'btn small' }, label);
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text());
      b.textContent = '✓ 已複製';
    } catch {
      prompt('請手動複製：', text());
    }
    setTimeout(() => (b.textContent = label), 1500);
  });
  return b;
}

export function qrSvg(text: string, cell = 4): string {
  const qr = qrcode(0, 'M');
  qr.addData(text.toUpperCase(), 'Alphanumeric');
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

export function qrElement(text: string, size = 180) {
  const box = h('div', { class: 'qr', style: `width:${size}px;height:${size}px` });
  box.innerHTML = qrSvg(text);
  return box;
}

/**
 * Shows a modal dialog; resolves with the value of the button that closed it ('' on cancel).
 * `onAction` can veto closing (e.g. show a validation error) by returning false. Enter submits the
 * primary button.
 */
export function modal(
  title: string,
  body: (Node | string)[],
  buttons: { label: string; value: string; kind?: string }[] = [{ label: '關閉', value: '' }],
  onAction?: (value: string) => Promise<boolean> | boolean,
): Promise<string> {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal' });
    const close = (v: string) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const btns = buttons.map((b) => h('button', { type: 'button', class: `btn ${b.kind ?? ''}` }, b.label));
    const act = async (v: string) => {
      if (!v || !onAction) return close(v);
      btns.forEach((b) => (b.disabled = true));
      try {
        if (await onAction(v)) close(v);
      } finally {
        btns.forEach((b) => (b.disabled = false));
      }
    };
    btns.forEach((b, i) => b.addEventListener('click', () => act(buttons[i].value)));
    const primary = buttons.find((b) => b.kind?.includes('primary'));
    const form = h('form', { class: 'modal-body' }, ...body);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (primary) void act(primary.value);
    });
    form.append(h('button', { type: 'submit', hidden: true }));
    dlg.append(
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { type: 'button', class: 'btn ghost small', 'aria-label': '關閉', onclick: () => close('') }, '✕')),
      form,
      h('div', { class: 'modal-foot' }, ...btns),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close('');
    });
    document.body.append(dlg);
    dlg.showModal();
    (form.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
  });
}

export const confirmDialog = (title: string, message: string, ok = '確定', danger = false) =>
  modal(title, [h('p', null, message)], [
    { label: '取消', value: '' },
    { label: ok, value: 'ok', kind: danger ? 'danger solid' : 'primary' },
  ]).then((v) => v === 'ok');

/** Converts between <input type="datetime-local"> values and ISO strings. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export function section(title: string, ...children: (Node | string | null)[]) {
  return h('section', { class: 'card section' }, h('h2', null, title), ...children);
}

export function field(label: string, control: Node, hint?: string | Node) {
  return h('div', { class: 'field' }, h('label', { class: 'label' }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-ui' }), h('span', null, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'hint block' }, hint) : null));
}
