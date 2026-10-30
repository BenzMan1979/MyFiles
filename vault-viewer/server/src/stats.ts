// Numbers for the admin dashboard, worked out from the vault records and the open log.
// Pure functions so they can be tested without a server.

export interface StatVault {
  id: string;
  recipient: string;
  title: string;
  opens: number;
  locked: boolean;
  revoked: boolean;
  policy: { notBefore: string | null; expiresAt: string | null; maxOpens: number | null };
}

export interface StatLog {
  vaultId: string;
  t: string;
  ev: 'open' | 'resume' | 'bad_proof' | 'locked' | 'denied';
  detail?: string;
  ip?: string;
  country?: string;
}

export interface Counts {
  /** first opens of a vault, the ones that use up the open count */
  opens: number;
  /** unlocks inside a still-valid session (after an idle lock) */
  resumes: number;
  /** wrong password/key, lockouts and refusals */
  issues: number;
}

export interface DayStat extends Counts {
  /** local calendar day, YYYY-MM-DD */
  date: string;
}

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
  /** what went wrong, by cause */
  issues: { kind: string; count: number }[];
  recent: { t: string; vaultId: string; recipient: string; kind: string; ip?: string; country?: string }[];
}

const DAY = 86_400_000;
const TOP = 7;

export const issueKind = (l: Pick<StatLog, 'ev' | 'detail'>): string =>
  l.ev === 'denied' ? (l.detail ?? 'denied') : l.ev;

/** The local calendar day (YYYY-MM-DD) of an instant, for a viewer `tzOffset` minutes east of UTC. */
export function localDay(ms: number, tzOffset: number): string {
  return new Date(ms + tzOffset * 60_000).toISOString().slice(0, 10);
}

function top(counts: Map<string, number>): { name: string; count: number }[] {
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.slice(0, TOP).map(([name, count]) => ({ name, count }));
  const rest = sorted.slice(TOP).reduce((n, [, c]) => n + c, 0);
  return rest > 0 ? [...head, { name: '其他', count: rest }] : head;
}

export function buildStats(vaults: StatVault[], logs: StatLog[], opts: { days: number; tzOffset: number; now: number }): Stats {
  const days = Math.min(365, Math.max(1, Math.round(opts.days)));
  const tz = Math.min(14 * 60, Math.max(-12 * 60, Math.round(opts.tzOffset)));
  const today = localDay(opts.now, tz);

  // One bucket per local day, oldest first, ending today; the period before it is only summed.
  const daily: DayStat[] = [];
  const index = new Map<string, DayStat>();
  for (let i = days - 1; i >= 0; i--) {
    const d: DayStat = { date: localDay(opts.now - i * DAY, tz), opens: 0, resumes: 0, issues: 0 };
    daily.push(d);
    index.set(d.date, d);
  }
  const first = daily[0].date;
  const prevFirst = localDay(opts.now - (2 * days - 1) * DAY, tz);

  const period: Counts = { opens: 0, resumes: 0, issues: 0 };
  const previous: Counts = { opens: 0, resumes: 0, issues: 0 };
  const byId = new Map(vaults.map((v) => [v.id, v]));
  const countries = new Map<string, number>();
  const recipients = new Map<string, number>();
  const causes = new Map<string, number>();
  const recent: Stats['recent'] = [];

  for (const l of [...logs].sort((a, b) => b.t.localeCompare(a.t))) {
    const ms = Date.parse(l.t);
    if (Number.isNaN(ms)) continue;
    const day = localDay(ms, tz);
    const bucket = day >= first && day <= today ? index.get(day) : undefined;
    const into = bucket ? period : day >= prevFirst && day < first ? previous : null;
    if (!into) continue;
    const field = l.ev === 'open' ? 'opens' : l.ev === 'resume' ? 'resumes' : 'issues';
    into[field] += 1;
    if (!bucket) continue;
    bucket[field] += 1;

    const who = byId.get(l.vaultId)?.recipient || byId.get(l.vaultId)?.title || '（已刪除）';
    if (field === 'opens') {
      countries.set(l.country || '未知', (countries.get(l.country || '未知') ?? 0) + 1);
      recipients.set(who, (recipients.get(who) ?? 0) + 1);
    } else if (field === 'issues') {
      const kind = issueKind(l);
      causes.set(kind, (causes.get(kind) ?? 0) + 1);
      if (recent.length < 10) recent.push({ t: l.t, vaultId: l.vaultId, recipient: who, kind, ip: l.ip, country: l.country });
    }
  }

  const now = opts.now;
  const totals = { vaults: vaults.length, active: 0, revoked: 0, locked: 0, expired: 0, exhausted: 0, notYet: 0, opensEver: 0 };
  for (const v of vaults) {
    totals.opensEver += v.opens;
    // Same order the server checks in, so every vault is counted once, under its first reason.
    if (v.revoked) totals.revoked++;
    else if (v.locked) totals.locked++;
    else if (v.policy.expiresAt && now >= Date.parse(v.policy.expiresAt)) totals.expired++;
    else if (v.policy.maxOpens != null && v.opens >= v.policy.maxOpens) totals.exhausted++;
    else if (v.policy.notBefore && now < Date.parse(v.policy.notBefore)) totals.notYet++;
    else totals.active++;
  }

  return {
    days,
    from: first,
    to: today,
    totals,
    period,
    previous,
    daily,
    countries: top(countries),
    recipients: top(recipients),
    issues: [...causes].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    recent,
  };
}
