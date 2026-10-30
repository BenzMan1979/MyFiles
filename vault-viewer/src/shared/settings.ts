// Everything that differs between deployments lives here, not in the code: names, links, limits
// and the defaults the packer starts from. The deployer (CI or Cloudflare's build) writes the
// values it wants into the page as <script type="application/json" id="vv-settings"> at build time
// (see scripts/inline.mjs); anything missing or invalid falls back to the defaults below.

export interface AppSettings {
  /** product name shown in the packer and on every vault's unlock screen */
  appName: string;
  /** name of the Worker, only used in hints such as "https://<name>.<you>.workers.dev" */
  workerName: string;
  links: {
    /** repo folder that Cloudflare's one-click deploy copies; empty hides the deploy button */
    deployRepo: string;
    /** prefix the repo address is appended to; Cloudflare's deploy button by default */
    deployButtonBase: string;
    cloudflareSignup: string;
    cloudflareDashboard: string;
  };
  limits: {
    maxRecipients: number;
    maxTotalMB: number;
    minPasswordLength: number;
  };
  defaults: {
    /** null = no expiry */
    expiryDays: number | null;
    maxFailures: number;
    sessionMinutes: number;
    idleLockMinutes: number;
    blurLockSeconds: number;
    allowCopy: boolean;
    allowPrint: boolean;
    allowDownload: boolean;
    watermark: { enabled: boolean; text: string; opacity: number; size: number; density: number };
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  appName: '隨身密閱',
  workerName: 'vault-viewer',
  links: {
    deployRepo: '',
    deployButtonBase: 'https://deploy.workers.cloudflare.com/?url=',
    cloudflareSignup: 'https://dash.cloudflare.com/sign-up',
    cloudflareDashboard: 'https://dash.cloudflare.com/',
  },
  limits: { maxRecipients: 500, maxTotalMB: 300, minPasswordLength: 6 },
  defaults: {
    expiryDays: 30,
    maxFailures: 5,
    sessionMinutes: 30,
    idleLockMinutes: 10,
    blurLockSeconds: 0,
    allowCopy: false,
    allowPrint: false,
    allowDownload: false,
    watermark: { enabled: true, text: '{收件人}  {時間}', opacity: 0.16, size: 18, density: 3 },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Takes the value only if it has the right type; otherwise keeps the fallback. */
function str(v: unknown, fallback: string, max = 300): string {
  return typeof v === 'string' && v.length <= max ? v.trim() : fallback;
}
function url(v: unknown, fallback: string): string {
  const s = str(v, fallback, 1000);
  return s === '' || /^https?:\/\//i.test(s) ? s : fallback;
}
function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function resolveSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  const r = isObj(raw) ? raw : {};
  const l = isObj(r.links) ? r.links : {};
  const lim = isObj(r.limits) ? r.limits : {};
  const def = isObj(r.defaults) ? r.defaults : {};
  const wm = isObj(def.watermark) ? def.watermark : {};
  return {
    appName: str(r.appName, d.appName, 40) || d.appName,
    workerName: str(r.workerName, d.workerName, 63) || d.workerName,
    links: {
      deployRepo: url(l.deployRepo, d.links.deployRepo),
      deployButtonBase: url(l.deployButtonBase, d.links.deployButtonBase),
      cloudflareSignup: url(l.cloudflareSignup, d.links.cloudflareSignup) || d.links.cloudflareSignup,
      cloudflareDashboard: url(l.cloudflareDashboard, d.links.cloudflareDashboard) || d.links.cloudflareDashboard,
    },
    limits: {
      maxRecipients: num(lim.maxRecipients, d.limits.maxRecipients, 1, 500), // the server accepts 500 per batch
      maxTotalMB: num(lim.maxTotalMB, d.limits.maxTotalMB, 1, 2000),
      minPasswordLength: num(lim.minPasswordLength, d.limits.minPasswordLength, 1, 64),
    },
    defaults: {
      expiryDays: def.expiryDays === null ? null : num(def.expiryDays, d.defaults.expiryDays!, 1, 3650),
      maxFailures: num(def.maxFailures, d.defaults.maxFailures, 0, 1000),
      sessionMinutes: num(def.sessionMinutes, d.defaults.sessionMinutes, 0, 1440),
      idleLockMinutes: num(def.idleLockMinutes, d.defaults.idleLockMinutes, 0, 1440),
      blurLockSeconds: num(def.blurLockSeconds, d.defaults.blurLockSeconds, 0, 3600),
      allowCopy: bool(def.allowCopy, d.defaults.allowCopy),
      allowPrint: bool(def.allowPrint, d.defaults.allowPrint),
      allowDownload: bool(def.allowDownload, d.defaults.allowDownload),
      watermark: {
        enabled: bool(wm.enabled, d.defaults.watermark.enabled),
        text: str(wm.text, d.defaults.watermark.text, 200),
        opacity: typeof wm.opacity === 'number' && Number.isFinite(wm.opacity) ? Math.min(0.5, Math.max(0.04, wm.opacity)) : d.defaults.watermark.opacity,
        size: num(wm.size, d.defaults.watermark.size, 10, 48),
        density: num(wm.density, d.defaults.watermark.density, 1, 5),
      },
    },
  };
}

/** The deploy button address, or null when no repo is configured. */
export function deployButtonUrl(s: AppSettings): string | null {
  return s.links.deployRepo ? `${s.links.deployButtonBase}${s.links.deployRepo}` : null;
}

function readInline(): unknown {
  if (typeof document === 'undefined') return null;
  try {
    return JSON.parse(document.getElementById('vv-settings')?.textContent ?? 'null');
  } catch {
    return null;
  }
}

/** The settings of this build. */
export const settings: AppSettings = resolveSettings(readInline());
