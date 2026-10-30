// Reads the deployer's parameters. Where they come from, first match wins:
//   1. the VAULT_SETTINGS environment variable (JSON; a GitHub Actions variable or a Cloudflare
//      build variable)
//   2. a local settings.json next to package.json (not committed)
//   3. nothing: the built-in defaults
//
// Shape (every key optional; see settings.example.json):
//   { "app":    { ...packer and viewer settings, see src/shared/settings.ts... },
//     "server": { "ADMIN_SESSION_HOURS": 12, ... Worker variables, see server/src/hub.ts },
//     "worker": { "name": "my-vault", "route": "vault.example.com" } }
import { existsSync, readFileSync } from 'node:fs';

/** Worker variables the server reads (see Env in server/src/hub.ts). ADMIN_PASSWORD is a secret, not a variable. */
export const SERVER_KEYS = ['ADMIN_SESSION_HOURS', 'ADMIN_MAX_FAILURES', 'ADMIN_LOCK_MINUTES', 'ADMIN_ORIGINS'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function readSettings(env = process.env, cwd = '.') {
  let raw = (env.VAULT_SETTINGS ?? '').trim();
  let source = 'VAULT_SETTINGS';
  if (!raw && existsSync(`${cwd}/settings.json`)) {
    raw = readFileSync(`${cwd}/settings.json`, 'utf8');
    source = 'settings.json';
  }
  let cfg = {};
  if (raw) {
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${source} 不是有效的 JSON：${e.message}`);
    }
    if (!isObj(cfg)) throw new Error(`${source} 必須是 JSON 物件，例如 { "app": { "appName": "..." } }`);
  }
  for (const k of ['app', 'server', 'worker']) {
    if (cfg[k] !== undefined && !isObj(cfg[k])) throw new Error(`${source} 裡的 "${k}" 必須是物件`);
  }
  const app = { ...(cfg.app ?? {}), links: { ...(cfg.app?.links ?? {}) } };

  // The address of the folder that Cloudflare's one-click deploy copies. An explicit setting wins;
  // otherwise it follows whichever repo is building this, so a fork or a renamed repo needs no edit.
  if (app.links.deployRepo === undefined) {
    const fromCi =
      env.GITHUB_REPOSITORY && env.GITHUB_REF_TYPE === 'branch' && !env.GITHUB_HEAD_REF
        ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/tree/${env.GITHUB_REF_NAME}/${app.projectDir ?? env.VAULT_PROJECT_DIR ?? 'vault-viewer'}`
        : '';
    const repo = env.VAULT_DEPLOY_REPO ?? fromCi;
    if (repo) app.links.deployRepo = repo;
  }
  return { app, server: cfg.server ?? {}, worker: cfg.worker ?? {}, source: raw ? source : null };
}

/** The tag that carries the app settings into a page. */
export function settingsTag(app) {
  return `<script type="application/json" id="vv-settings">${JSON.stringify(app).replace(/</g, '\\u003c')}</script>`;
}

/** Turns the "server" and "worker" sections into `wrangler deploy` arguments (no shell involved, so any value is safe). */
export function wranglerArgs({ server = {}, worker = {} }) {
  const args = ['wrangler', 'deploy'];
  if (worker.name !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(String(worker.name))) throw new Error(`worker.name 只能用英文字母、數字和連字號：${worker.name}`);
    args.push('--name', String(worker.name));
  }
  for (const d of [].concat(worker.domain ?? [])) args.push('--domain', String(d));
  for (const r of [].concat(worker.route ?? [])) args.push('--route', String(r));
  for (const [k, v] of Object.entries(server)) {
    if (k === 'ADMIN_PASSWORD') throw new Error('ADMIN_PASSWORD 是機密，請放在 Secrets（VAULT_ADMIN_PASSWORD），不要寫在設定值裡');
    if (!SERVER_KEYS.includes(k)) throw new Error(`不認得的伺服器參數 "${k}"。可用的有：${SERVER_KEYS.join('、')}`);
    args.push('--var', `${k}:${v}`);
  }
  return args;
}
