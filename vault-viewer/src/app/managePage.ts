import { clear, formatDateTime, h } from '../shared/dom';
import { api, servers, tokens, type RemoteLog, type RemoteVault, type ServerProfile } from './api';
import { loginDialog } from './serverPage';
import { confirmDialog, fromLocalInput, modal, section, toast, toLocalInput } from './ui';

let selectedServer = '';

function statusOf(v: RemoteVault, now: number): { label: string; cls: string } {
  if (v.revoked) return { label: '已收回', cls: 'danger' };
  if (v.locked) return { label: '已鎖定', cls: 'danger' };
  if (v.policy.expiresAt && now >= Date.parse(v.policy.expiresAt)) return { label: '已過期', cls: 'warn' };
  if (v.policy.maxOpens != null && v.opens >= v.policy.maxOpens) return { label: '次數用完', cls: 'warn' };
  if (v.policy.notBefore && now < Date.parse(v.policy.notBefore)) return { label: '尚未開始', cls: '' };
  return { label: '有效', cls: 'ok' };
}

const EVENT_LABEL: Record<string, string> = {
  open: '✅ 開啟',
  resume: '🔓 重新解鎖（不計次）',
  bad_proof: '❌ 密碼或金鑰錯誤',
  locked: '⛔ 錯誤太多次，已鎖定',
  denied: '🚫 被拒絕',
};
const DENY_LABEL: Record<string, string> = { revoked: '已收回', locked: '已鎖定', expired: '已過期', exhausted: '次數用完', not_yet: '尚未開始' };

function browserOf(ua = ''): string {
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' / ') || '未知';
}

export function renderManage(root: HTMLElement, rerender: () => void) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, '📋 管理封存檔'), h('p', { class: 'muted' }, '查看線上封存檔的開啟狀況，隨時收回、延長期限、調整次數或解除鎖定。離線封存檔無法遠端管理。')));
  const list = servers.list();
  if (!list.length) {
    root.append(h('p', { class: 'note' }, '還沒有設定伺服器。請先到 ', h('a', { href: '#servers' }, '伺服器設定'), '。'));
    return;
  }
  if (!servers.get(selectedServer)) selectedServer = servers.default()!.id;
  const server = servers.get(selectedServer)!;
  const sel = h('select', { class: 'input narrow' }, ...list.map((s) => h('option', { value: s.id, selected: s.id === server.id }, s.name)));
  sel.addEventListener('change', () => {
    selectedServer = sel.value;
    rerender();
  });
  root.append(h('div', { class: 'toolbar' }, h('span', null, '伺服器：'), sel, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: rerender }, '↻ 重新整理')));

  if (!tokens.get(server.id)) {
    root.append(h('div', { class: 'card section' }, h('p', null, '需要先登入這台伺服器的管理員。'), h('button', { class: 'btn primary', onclick: () => loginDialog(server).then((ok) => ok && rerender()) }, '登入')));
    return;
  }
  const body = h('div', null, h('div', { class: 'empty' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, '讀取中…')));
  root.append(body);
  void load(server, body, rerender);
}

async function load(server: ServerProfile, body: HTMLElement, rerender: () => void) {
  let data: { vaults: RemoteVault[]; serverTime: string };
  try {
    data = await api(server, '/api/admin/vaults', { auth: true });
  } catch (e) {
    clear(body);
    body.append(h('p', { class: 'error' }, (e as Error).message));
    if (!tokens.get(server.id)) body.append(h('button', { class: 'btn primary', onclick: () => loginDialog(server).then((ok) => ok && rerender()) }, '重新登入'));
    return;
  }
  clear(body);
  if (!data.vaults.length) {
    body.append(h('div', { class: 'empty' }, h('div', { class: 'big-icon' }, '🗂️'), h('p', null, '這台伺服器上還沒有封存檔'), h('a', { class: 'btn primary', href: '#create' }, '建立封存檔')));
    return;
  }
  const now = Date.parse(data.serverTime);
  const batches = new Map<string, RemoteVault[]>();
  for (const v of data.vaults) batches.set(v.batchId, [...(batches.get(v.batchId) ?? []), v]);

  const search = h('input', { class: 'input', type: 'search', placeholder: '搜尋封存名稱或收件人…' });
  const listEl = h('div');
  const draw = () => {
    clear(listEl);
    const q = search.value.trim().toLowerCase();
    for (const vaults of batches.values()) {
      const shown = q ? vaults.filter((v) => `${v.title} ${v.recipient}`.toLowerCase().includes(q)) : vaults;
      if (!shown.length) continue;
      listEl.append(batchCard(server, vaults[0].title, shown, now, rerender));
    }
    if (!listEl.childNodes.length) listEl.append(h('p', { class: 'muted' }, '找不到符合的封存檔'));
  };
  search.addEventListener('input', draw);
  draw();
  body.append(search, listEl);
}

function batchCard(server: ServerProfile, title: string, vaults: RemoteVault[], now: number, rerender: () => void) {
  const patchAll = async (patch: object, msg: string) => {
    for (const v of vaults) await api(server, `/api/admin/vaults/${v.id}`, { method: 'PATCH', body: patch, auth: true });
    toast(msg);
    rerender();
  };
  const rows = vaults.map((v) => {
    const st = statusOf(v, now);
    return h('tr', null,
      h('td', null, h('strong', null, v.recipient || '（未命名）')),
      h('td', null, h('span', { class: `chip ${st.cls}` }, st.label)),
      h('td', null, `${v.opens}${v.policy.maxOpens != null ? ` / ${v.policy.maxOpens}` : ''} 次`),
      h('td', null, v.policy.expiresAt ? formatDateTime(v.policy.expiresAt) : '不限'),
      h('td', null, v.lastOpenAt ? formatDateTime(v.lastOpenAt) : h('span', { class: 'muted' }, '尚未開啟')),
      h('td', { class: 'actions' }, h('div', null,
        h('button', { class: 'btn small', onclick: () => showLogs(server, v) }, '紀錄'),
        h('button', { class: 'btn small', onclick: () => editPolicy(server, v).then((ok) => ok && rerender()) }, '調整'),
        v.locked ? h('button', { class: 'btn small', onclick: async () => { await api(server, `/api/admin/vaults/${v.id}`, { method: 'PATCH', body: { unlock: true }, auth: true }); toast('已解除鎖定'); rerender(); } }, '解除鎖定') : null,
        v.revoked
          ? h('button', { class: 'btn small', onclick: async () => { await api(server, `/api/admin/vaults/${v.id}`, { method: 'PATCH', body: { revoked: false }, auth: true }); toast('已恢復'); rerender(); } }, '恢復')
          : h('button', { class: 'btn small danger', onclick: async () => {
              if (!(await confirmDialog('收回封存檔', `收回後「${v.recipient}」就再也打不開這份封存檔（正在看的畫面下次上鎖後也會失效）。之後可以再恢復。`, '收回', true))) return;
              await api(server, `/api/admin/vaults/${v.id}`, { method: 'PATCH', body: { revoked: true }, auth: true });
              toast('已收回');
              rerender();
            } }, '收回'),
        h('button', { class: 'btn small ghost', title: '從伺服器刪除', onclick: async () => {
          if (!(await confirmDialog('刪除封存檔', `從伺服器刪除「${v.recipient}」的這份封存檔與開啟紀錄。刪除後檔案永遠打不開，而且無法復原。`, '永久刪除', true))) return;
          await api(server, `/api/admin/vaults/${v.id}`, { method: 'DELETE', auth: true });
          toast('已刪除');
          rerender();
        } }, '🗑'),
      )),
    );
  });
  const created = vaults.reduce((a, v) => (v.createdAt < a ? v.createdAt : a), vaults[0].createdAt);
  return section(`${title || '（未命名）'}`,
    h('p', { class: 'muted small' }, `建立於 ${formatDateTime(created)} · ${vaults.length} 位收件人`),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ...['收件人', '狀態', '已開啟', '到期', '最後開啟', ''].map((t) => h('th', null, t)))),
        h('tbody', null, ...rows),
      ),
    ),
    vaults.length > 1
      ? h('div', { class: 'row-buttons' },
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('全部收回', `收回「${title}」的全部 ${vaults.length} 份封存檔？`, '全部收回', true)) await patchAll({ revoked: true }, '已全部收回'); } }, '全部收回'),
          h('button', { class: 'btn small', onclick: async () => {
            const d = h('input', { type: 'date', class: 'input' });
            if ((await modal('全部延長到', [d], [{ label: '取消', value: '' }, { label: '套用', value: 'ok', kind: 'primary' }])) !== 'ok' || !d.value) return;
            await patchAll({ policy: { expiresAt: new Date(`${d.value}T23:59:59`).toISOString() } }, '已更新到期日');
          } }, '全部延長期限…'),
        )
      : null,
  );
}

async function editPolicy(server: ServerProfile, v: RemoteVault): Promise<boolean> {
  const exp = h('input', { type: 'datetime-local', class: 'input', value: toLocalInput(v.policy.expiresAt) });
  const nb = h('input', { type: 'datetime-local', class: 'input', value: toLocalInput(v.policy.notBefore) });
  const max = h('input', { type: 'number', class: 'input narrow', min: 1, value: v.policy.maxOpens ?? '', placeholder: '不限' });
  const fails = h('input', { type: 'number', class: 'input narrow', min: 0, value: v.policy.maxFailures });
  const sess = h('input', { type: 'number', class: 'input narrow', min: 0, value: v.policy.sessionMinutes });
  const reset = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'error' });
  const row = (label: string, ctl: Node, hint?: string) => h('div', { class: 'field' }, h('label', { class: 'label' }, label), ctl, hint ? h('p', { class: 'hint' }, hint) : null);
  const r = await modal(`調整：${v.recipient}`, [
    row('到期時間', exp, '清空表示不限期'),
    row('開始時間', nb, '清空表示立刻可以開啟'),
    row('可開啟次數', max, `目前已開啟 ${v.opens} 次。清空表示不限`),
    h('label', { class: 'check' }, reset, ' 把已開啟次數歸零'),
    row('密碼錯誤幾次鎖定', fails, '0 表示不鎖定'),
    row('上鎖後免重算時間（分鐘）', sess),
    err,
  ], [{ label: '取消', value: '' }, { label: '儲存', value: 'ok', kind: 'primary' }], async () => {
    const maxV = max.value ? Number(max.value) : null;
    if (maxV != null && (!Number.isInteger(maxV) || maxV < 1)) return (err.textContent = '次數至少 1 次，或清空表示不限'), false;
    try {
      await api(server, `/api/admin/vaults/${v.id}`, {
        method: 'PATCH',
        auth: true,
        body: {
          resetOpens: reset.checked,
          policy: { expiresAt: fromLocalInput(exp.value), notBefore: fromLocalInput(nb.value), maxOpens: maxV, maxFailures: Number(fails.value) || 0, sessionMinutes: Number(sess.value) || 0 },
        },
      });
      return true;
    } catch (e) {
      err.textContent = (e as Error).message;
      return false;
    }
  });
  if (r === 'ok') toast('已更新');
  return r === 'ok';
}

async function showLogs(server: ServerProfile, v: RemoteVault) {
  const box = h('div', null, h('div', { class: 'spinner' }));
  const p = modal(`開啟紀錄：${v.recipient}`, [box]);
  try {
    const { logs } = await api<{ logs: RemoteLog[] }>(server, `/api/admin/vaults/${v.id}/logs`, { auth: true });
    clear(box);
    if (!logs.length) box.append(h('p', { class: 'muted' }, '還沒有任何紀錄'));
    else
      box.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table small' },
        h('thead', null, h('tr', null, ...['時間', '事件', '地區', 'IP', '瀏覽器'].map((t) => h('th', null, t)))),
        h('tbody', null, ...logs.map((l) => h('tr', null,
          h('td', null, formatDateTime(l.t)),
          h('td', null, EVENT_LABEL[l.ev] ?? l.ev, l.ev === 'denied' && l.detail ? `（${DENY_LABEL[l.detail] ?? l.detail}）` : ''),
          h('td', null, l.country || '—'),
          h('td', { class: 'mono' }, l.ip || '—'),
          h('td', null, browserOf(l.ua)),
        ))),
      )));
  } catch (e) {
    clear(box);
    box.append(h('p', { class: 'error' }, (e as Error).message));
  }
  await p;
}
