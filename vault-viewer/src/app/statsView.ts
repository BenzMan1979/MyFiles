// The statistics block above the vault list on the manage page: filter row, headline numbers,
// daily opens (stacked with problems), where and who, and what went wrong.
import { clear, h } from '../shared/dom';
import { api, type ServerProfile } from './api';

export interface Counts { opens: number; resumes: number; issues: number }
export interface DayStat extends Counts { date: string }
export interface Stats {
  days: number;
  from: string;
  to: string;
  totals: { vaults: number; active: number; revoked: number; locked: number; expired: number; exhausted: number; notYet: number; opensEver: number };
  period: Counts;
  previous: Counts;
  daily: DayStat[];
  countries: { name: string; count: number }[];
  recipients: { name: string; count: number }[];
  issues: { kind: string; count: number }[];
  recent: { t: string; vaultId: string; recipient: string; kind: string; ip?: string; country?: string }[];
}

const RANGES = [7, 30, 90];
let selectedDays = 30;

export const ISSUE_LABEL: Record<string, { icon: string; text: string; cls: 'warn' | 'danger' }> = {
  bad_proof: { icon: '⚠️', text: '密碼或金鑰錯誤', cls: 'warn' },
  locked: { icon: '⛔', text: '錯誤太多次，已鎖定', cls: 'danger' },
  revoked: { icon: '⛔', text: '已收回仍有人嘗試', cls: 'danger' },
  expired: { icon: '⚠️', text: '過期後仍有人嘗試', cls: 'warn' },
  exhausted: { icon: '⚠️', text: '次數用完後仍有人嘗試', cls: 'warn' },
  not_yet: { icon: '⚠️', text: '還沒開始就有人嘗試', cls: 'warn' },
};
const issueLabel = (kind: string) => ISSUE_LABEL[kind] ?? { icon: '⚠️', text: kind, cls: 'warn' as const };

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: Node[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.appendChild(k);
  return el;
}

const nf = (n: number) => n.toLocaleString('zh-TW');
const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** Rounds a maximum up to a tidy axis end (1, 2, 5, 10, 20, 50 …) so the gridlines fall on round numbers. */
export function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (n <= m * pow) return m * pow;
  return 10 * pow;
}

export function deltaText(cur: number, prev: number, days: number): string {
  if (cur === 0 && prev === 0) return `前 ${days} 天也沒有`;
  if (prev === 0) return `前 ${days} 天沒有，新增 ${nf(cur)}`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `與前 ${days} 天相同`;
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%（前 ${days} 天 ${nf(prev)}）`;
}

export function statsPanel(server: ServerProfile): HTMLElement {
  const root = h('section', { class: 'card section stats' });
  const head = h('div', { class: 'stats-head' }, h('h2', null, '📈 使用統計'));
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': '統計期間' });
  const body = h('div', { class: 'stats-body' });
  head.append(h('span', { class: 'spacer' }), filters);
  root.append(head, body);

  let current: Stats | null = null;
  let token = 0;

  const drawFilters = () => {
    clear(filters);
    for (const d of RANGES) {
      filters.append(h('button', { type: 'button', class: `seg-btn${d === selectedDays ? ' on' : ''}`, 'aria-pressed': d === selectedDays, onclick: () => { selectedDays = d; drawFilters(); void load(); } }, `${d} 天`));
    }
  };

  async function load() {
    const mine = ++token;
    body.classList.add('loading');
    try {
      const tz = -new Date().getTimezoneOffset();
      const { stats } = await api<{ stats: Stats }>(server, `/api/admin/stats?days=${selectedDays}&tzOffset=${tz}`, { auth: true });
      if (mine !== token) return;
      current = stats;
      render();
    } catch (e) {
      if (mine !== token) return;
      const old = (e as { status?: number }).status === 404;
      clear(body);
      body.append(h('p', { class: old ? 'muted' : 'error' }, old ? '這台伺服器的版本比較舊，還沒有統計功能。重新部署一次最新版就會出現。' : `讀取統計失敗：${(e as Error).message}`));
    } finally {
      if (mine === token) body.classList.remove('loading');
    }
  }

  let ro: ResizeObserver | null = null;
  function render() {
    const s = current!;
    clear(body);
    ro?.disconnect();
    body.append(tiles(s), chartBlock(s), h('div', { class: 'stats-cols' }, rankBlock('開啟地區', s.countries, s.period.opens), rankBlock('收件人開啟排行', s.recipients, s.period.opens)), issuesBlock(s));
    // The chart is drawn at the width it actually has, so text never gets stretched.
    const chart = body.querySelector<HTMLElement>('.chart-host');
    if (chart && typeof ResizeObserver !== 'undefined') {
      let last = chart.clientWidth;
      ro = new ResizeObserver(() => {
        if (Math.abs(chart.clientWidth - last) > 8) {
          last = chart.clientWidth;
          drawChart(chart, s);
        }
      });
      ro.observe(chart);
    }
  }

  drawFilters();
  void load();
  return root;
}

// ---------- headline numbers ----------

function tile(label: string, value: string, sub: string, extra?: Node | null) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-sub' }, sub), extra);
}

function sparkline(values: number[]): SVGElement {
  const w = 120, hgt = 28, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 4) + 2},${hgt - 3 - (v / max) * (hgt - 6)}`).join(' ');
  return svg('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, 'aria-hidden': 'true' },
    svg('polyline', { points: pts, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

function tiles(s: Stats): HTMLElement {
  const t = s.totals;
  const attention = t.locked;
  return h('div', { class: 'tiles' },
    tile('有效的封存檔', nf(t.active), `共 ${nf(t.vaults)} 份，累計開啟 ${nf(t.opensEver)} 次`),
    tile(`近 ${s.days} 天開啟`, nf(s.period.opens), deltaText(s.period.opens, s.previous.opens, s.days), sparkline(s.daily.map((d) => d.opens))),
    tile(`近 ${s.days} 天異常`, nf(s.period.issues), deltaText(s.period.issues, s.previous.issues, s.days)),
    tile('需要你處理', nf(attention), attention ? '有封存檔因密碼錯誤太多次被鎖定' : '目前沒有被鎖定的封存檔'),
  );
}

// ---------- daily chart ----------

function chartBlock(s: Stats): HTMLElement {
  let asTable = false;
  const host = h('div', { class: 'chart-host' });
  const tableHost = h('div', { class: 'table-wrap', hidden: true });
  const toggle = h('button', { type: 'button', class: 'btn small ghost' }, '以表格檢視');
  toggle.addEventListener('click', () => {
    asTable = !asTable;
    host.hidden = asTable;
    tableHost.hidden = !asTable;
    toggle.textContent = asTable ? '以圖表檢視' : '以表格檢視';
    if (!asTable) drawChart(host, s);
  });
  tableHost.append(dailyTable(s));
  const legend = h('div', { class: 'legend' },
    h('span', { class: 'legend-item' }, h('i', { class: 'swatch s1' }), '成功開啟'),
    h('span', { class: 'legend-item' }, h('i', { class: 'swatch s2' }), '異常（密碼錯誤、被拒絕）'),
    h('span', { class: 'spacer' }), toggle);
  const el = h('div', { class: 'stat-block' }, h('h3', null, '每日開啟'), legend, host, tableHost);
  // Needs the element in the page to measure it.
  queueMicrotask(() => drawChart(host, s));
  return el;
}

function dailyTable(s: Stats): HTMLElement {
  return h('table', { class: 'table small' },
    h('thead', null, h('tr', null, ...['日期', '成功開啟', '異常', '重新解鎖（不計次）'].map((x) => h('th', null, x)))),
    h('tbody', null, ...[...s.daily].reverse().map((d) => h('tr', null, h('td', null, d.date), h('td', null, nf(d.opens)), h('td', null, nf(d.issues)), h('td', null, nf(d.resumes))))));
}

function drawChart(host: HTMLElement, s: Stats) {
  clear(host);
  const W = Math.max(280, host.clientWidth || 640);
  const H = 220, ml = 34, mr = 6, mt = 10, mb = 24;
  const pw = W - ml - mr, ph = H - mt - mb;
  const n = s.daily.length;
  const step = pw / n;
  const bw = Math.min(24, Math.max(2, step * 0.7));
  const max = niceMax(Math.max(0, ...s.daily.map((d) => d.opens + d.issues)));
  const y = (v: number) => mt + ph - (v / max) * ph;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `近 ${s.days} 天每日開啟與異常次數，共開啟 ${s.period.opens} 次、異常 ${s.period.issues} 次。可切換成表格檢視。` });
  const grid = svg('g');
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    grid.append(
      svg('line', { x1: ml, x2: W - mr, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }),
      Object.assign(svg('text', { x: ml - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'ax' }), { textContent: nf(Number.isInteger(v) ? v : Math.round(v * 10) / 10) }),
    );
  }
  root.append(grid);

  // x labels: a handful, never every day
  const every = Math.ceil(n / Math.max(2, Math.floor(pw / 64)));
  s.daily.forEach((d, i) => {
    if ((n - 1 - i) % every !== 0) return;
    root.append(Object.assign(svg('text', { x: ml + step * (i + 0.5), y: H - 6, 'text-anchor': 'middle', class: 'ax' }), { textContent: shortDate(d.date) }));
  });

  const cross = svg('rect', { y: mt, height: ph, width: step, fill: 'var(--hover)', visibility: 'hidden' });
  root.append(cross);

  s.daily.forEach((d, i) => {
    const cx = ml + step * (i + 0.5);
    const x = cx - bw / 2;
    const base = y(0);
    const hOpen = base - y(d.opens);
    const hIssue = base - y(d.opens + d.issues) - hOpen;
    if (d.opens > 0) root.append(segment(x, base - hOpen, bw, hOpen, d.issues === 0, 'var(--series-1)'));
    // the surface gap between stacked segments is a 2px stroke in the chart's own background colour
    if (d.issues > 0) root.append(segment(x, base - hOpen - hIssue, bw, hIssue, true, 'var(--series-2)', d.opens > 0));
  });

  const tip = h('div', { class: 'tooltip', hidden: true, role: 'status' });
  host.style.position = 'relative';
  const hit = svg('rect', { x: ml, y: mt, width: pw, height: ph, fill: 'transparent' });
  const show = (clientX: number) => {
    const box = root.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor((clientX - box.left - ml) / step)));
    const d = s.daily[i];
    cross.setAttribute('x', String(ml + step * i));
    cross.setAttribute('visibility', 'visible');
    clear(tip);
    tip.append(h('div', { class: 'tip-title' }, d.date),
      tipRow('s1', '成功開啟', d.opens), tipRow('s2', '異常', d.issues),
      ...(d.resumes ? [h('div', { class: 'tip-note' }, `另有 ${nf(d.resumes)} 次重新解鎖（不計次）`)] : []));
    tip.hidden = false;
    const left = ml + step * (i + 0.5);
    tip.style.left = `${Math.min(W - tip.offsetWidth - 4, Math.max(4, left - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(0, y(d.opens + d.issues) - tip.offsetHeight - 10)}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  root.append(hit);
  host.append(root, tip);

  if (s.period.opens + s.period.issues === 0) {
    host.append(h('div', { class: 'chart-empty' }, '這段期間還沒有人開啟封存檔'));
  }
}

function tipRow(cls: string, label: string, v: number) {
  return h('div', { class: 'tip-row' }, h('i', { class: `swatch ${cls}` }), h('span', { class: 'tip-label' }, label), h('strong', null, nf(v)));
}

/** A column segment. Only the top of the top-most segment is rounded (4px); the bottom sits square on the baseline. */
function segment(x: number, y: number, w: number, hgt: number, rounded: boolean, fill: string, gap = false): SVGElement {
  const r = rounded ? Math.min(4, w / 2, hgt) : 0;
  const d = `M${x},${y + hgt} V${y + r} ${r ? `Q${x},${y} ${x + r},${y}` : ''} H${x + w - r} ${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''} V${y + hgt} Z`;
  return svg('path', { d, fill, ...(gap ? { stroke: 'var(--surface)', 'stroke-width': 2, 'paint-order': 'stroke' } : {}) });
}

// ---------- ranked bars ----------

function rankBlock(title: string, rows: { name: string; count: number }[], total: number): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const list = rows.length
    ? h('ul', { class: 'rank' }, ...rows.map((r) =>
        h('li', null,
          h('span', { class: 'rank-name', title: r.name }, r.name),
          h('span', { class: 'rank-track' }, h('span', { class: 'rank-bar', style: `width:${Math.max(2, (r.count / max) * 100)}%` })),
          h('span', { class: 'rank-val' }, nf(r.count), h('span', { class: 'muted' }, total ? ` · ${Math.round((r.count / total) * 100)}%` : '')))))
    : h('p', { class: 'muted small' }, '這段期間沒有資料');
  return h('div', { class: 'stat-block' }, h('h3', null, title), list);
}

// ---------- problems ----------

function issuesBlock(s: Stats): HTMLElement {
  const wrap = h('div', { class: 'stat-block' }, h('h3', null, `異常事件（近 ${s.days} 天）`));
  if (!s.period.issues) {
    wrap.append(h('p', { class: 'muted small' }, '✅ 沒有異常。'));
    return wrap;
  }
  wrap.append(h('div', { class: 'chips' }, ...s.issues.map((i) => {
    const l = issueLabel(i.kind);
    return h('span', { class: `chip ${l.cls}` }, `${l.icon} ${l.text} ${nf(i.count)}`);
  })));
  wrap.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table small' },
    h('thead', null, h('tr', null, ...['時間', '收件人', '狀況', '地區', 'IP'].map((x) => h('th', null, x)))),
    h('tbody', null, ...s.recent.map((r) => {
      const l = issueLabel(r.kind);
      const when = new Date(r.t);
      const p = (v: number) => String(v).padStart(2, '0');
      return h('tr', null,
        h('td', null, `${when.getMonth() + 1}/${when.getDate()} ${p(when.getHours())}:${p(when.getMinutes())}`),
        h('td', null, r.recipient),
        h('td', null, h('span', { class: `chip ${l.cls}` }, `${l.icon} ${l.text}`)),
        h('td', null, r.country || '—'),
        h('td', { class: 'mono' }, r.ip || '—'));
    })))));
  if (s.period.issues > s.recent.length) wrap.append(h('p', { class: 'muted small' }, `只列出最近 ${s.recent.length} 筆；每份封存檔的完整紀錄請按下方的「紀錄」。`));
  return wrap;
}
