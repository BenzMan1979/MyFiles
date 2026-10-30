// The deployer: builds nothing, just ships what `npm run build` produced to Cloudflare, with the
// deployer's parameters (see settings.mjs). Used by the GitHub workflow; works the same on a laptop.
//   needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment
//   optional: VAULT_SETTINGS (JSON), VAULT_ADMIN_PASSWORD (set as the Worker's admin password)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readSettings, wranglerArgs } from './settings.mjs';

if (!existsSync('dist/index.html')) {
  console.error('找不到 dist/index.html，請先執行 npm run build');
  process.exit(1);
}
const settings = readSettings();
const args = wranglerArgs(settings);
if (process.env.VAULT_DRY_RUN) args.push('--dry-run', '--outdir', process.env.VAULT_DRY_RUN);
console.log(`> npx ${args.join(' ')}`);
const run = (a, input) => spawnSync('npx', a, { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input, shell: process.platform === 'win32' });

let r = run(args);
if (r.status !== 0) process.exit(r.status ?? 1);

const pw = process.env.VAULT_ADMIN_PASSWORD;
if (pw && !process.env.VAULT_DRY_RUN) {
  const name = settings.worker.name ? ['--name', String(settings.worker.name)] : [];
  console.log('> npx wrangler secret put ADMIN_PASSWORD');
  r = run(['wrangler', 'secret', 'put', 'ADMIN_PASSWORD', ...name], pw);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
