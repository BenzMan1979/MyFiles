import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, deployButtonUrl, resolveSettings } from '../src/shared/settings';
// @ts-expect-error plain JS build helper
import { readSettings, settingsTag, wranglerArgs } from '../scripts/settings.mjs';

describe('app settings', () => {
  it('uses the defaults when nothing is configured, and hides the deploy button', () => {
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(deployButtonUrl(resolveSettings({}))).toBeNull();
  });
  it('overrides only what is given and keeps the rest', () => {
    const s = resolveSettings({ appName: '我的密閱', limits: { maxTotalMB: 50 }, defaults: { expiryDays: null, watermark: { text: '{收件人}', size: 24 } } });
    expect(s.appName).toBe('我的密閱');
    expect(s.limits).toEqual({ ...DEFAULT_SETTINGS.limits, maxTotalMB: 50 });
    expect(s.defaults.expiryDays).toBeNull();
    expect(s.defaults.watermark).toEqual({ ...DEFAULT_SETTINGS.defaults.watermark, text: '{收件人}', size: 24 });
    expect(s.workerName).toBe('vault-viewer');
    expect(s.projectDir).toBe('vault-viewer');
    expect(resolveSettings({ projectDir: '/apps/vault/' }).projectDir).toBe('apps/vault');
  });
  it('rejects wrong types and clamps numbers instead of breaking the page', () => {
    const s = resolveSettings({ appName: 42, limits: { maxRecipients: 99999, minPasswordLength: -3 }, defaults: { maxFailures: 'x', watermark: { density: 99, opacity: 5 } }, links: { cloudflareSignup: 'javascript:alert(1)', deployRepo: 'ftp://x' } });
    expect(s.appName).toBe(DEFAULT_SETTINGS.appName);
    expect(s.limits.maxRecipients).toBe(500);
    expect(s.limits.minPasswordLength).toBe(1);
    expect(s.defaults.maxFailures).toBe(5);
    expect(s.defaults.watermark).toMatchObject({ density: 5, opacity: 0.5 });
    expect(s.links.cloudflareSignup).toBe(DEFAULT_SETTINGS.links.cloudflareSignup); // only http(s) links are accepted
    expect(s.links.deployRepo).toBe('');
  });
  it('builds the deploy button from the configured repo and button base', () => {
    const s = resolveSettings({ links: { deployRepo: 'https://github.com/a/b/tree/main/vault-viewer', deployButtonBase: 'https://deploy.example.com/?repo=' } });
    expect(deployButtonUrl(s)).toBe('https://deploy.example.com/?repo=https://github.com/a/b/tree/main/vault-viewer');
  });
});

describe('build-time settings', () => {
  it('reads VAULT_SETTINGS and follows the building repo for the deploy link', () => {
    const r = readSettings({ VAULT_SETTINGS: '{"app":{"appName":"X"},"server":{"ADMIN_SESSION_HOURS":4},"worker":{"name":"w"}}', GITHUB_REPOSITORY: 'someone/fork', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }, '/nonexistent');
    expect(r.app).toEqual({ appName: 'X', links: { deployRepo: 'https://github.com/someone/fork/tree/main/vault-viewer' } });
    expect(r.server).toEqual({ ADMIN_SESSION_HOURS: 4 });
    expect(r.worker).toEqual({ name: 'w' });
  });
  it('builds the deploy link from the configured project folder', () => {
    const env = { GITHUB_REPOSITORY: 'a/b', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', VAULT_SETTINGS: '{"app":{"projectDir":"apps/vault"}}' };
    expect(readSettings(env, '/n').app.links.deployRepo).toBe('https://github.com/a/b/tree/main/apps/vault');
  });
  it('lets an explicit link win, including an empty one that turns the button off', () => {
    const env = { GITHUB_REPOSITORY: 'a/b', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' };
    expect(readSettings({ ...env, VAULT_SETTINGS: '{"app":{"links":{"deployRepo":"https://x/y"}}}' }, '/n').app.links.deployRepo).toBe('https://x/y');
    expect(readSettings({ ...env, VAULT_SETTINGS: '{"app":{"links":{"deployRepo":""}}}' }, '/n').app.links.deployRepo).toBe('');
    expect(readSettings({ ...env, VAULT_DEPLOY_REPO: 'https://z/z' }, '/n').app.links.deployRepo).toBe('https://z/z');
    expect(readSettings({}, '/n').app.links.deployRepo).toBeUndefined(); // local build: no button
    expect(readSettings({ ...env, GITHUB_HEAD_REF: 'feature' }, '/n').app.links.deployRepo).toBeUndefined(); // pull request builds
  });
  it('explains a broken value instead of building something wrong', () => {
    expect(() => readSettings({ VAULT_SETTINGS: '{oops' }, '/n')).toThrow(/VAULT_SETTINGS 不是有效的 JSON/);
    expect(() => readSettings({ VAULT_SETTINGS: '[]' }, '/n')).toThrow(/必須是 JSON 物件/);
    expect(() => readSettings({ VAULT_SETTINGS: '{"app":"x"}' }, '/n')).toThrow(/"app" 必須是物件/);
  });
  it('escapes the page-breaking sequence when writing settings into HTML', () => {
    expect(settingsTag({ appName: '</script><b>' })).not.toContain('</script><b>');
  });
});

describe('deploy arguments', () => {
  it('passes the name, domain and server variables to wrangler', () => {
    expect(wranglerArgs({ server: { ADMIN_SESSION_HOURS: 4, ADMIN_ORIGINS: 'https://a.example, https://b.example' }, worker: { name: 'my-vault', domain: 'vault.example.com' } })).toEqual([
      'wrangler', 'deploy', '--name', 'my-vault', '--domain', 'vault.example.com',
      '--var', 'ADMIN_SESSION_HOURS:4', '--var', 'ADMIN_ORIGINS:https://a.example, https://b.example',
    ]);
    expect(wranglerArgs({})).toEqual(['wrangler', 'deploy']);
  });
  it('refuses typos, secrets and unsafe names', () => {
    expect(() => wranglerArgs({ server: { ADMIN_SESION_HOURS: 4 } })).toThrow(/不認得的伺服器參數/);
    expect(() => wranglerArgs({ server: { ADMIN_PASSWORD: 'x' } })).toThrow(/機密/);
    expect(() => wranglerArgs({ worker: { name: 'bad name; rm -rf' } })).toThrow(/連字號/);
  });
});

describe('settings.example.json', () => {
  const example = JSON.parse(readFileSync('settings.example.json', 'utf8'));
  it('is safe to copy as it is: it equals the built-in defaults', () => {
    expect(resolveSettings(example.app)).toEqual(DEFAULT_SETTINGS);
    expect(wranglerArgs(example)).toEqual(['wrangler', 'deploy', '--name', 'vault-viewer', '--var', 'ADMIN_SESSION_HOURS:12', '--var', 'ADMIN_MAX_FAILURES:5', '--var', 'ADMIN_LOCK_MINUTES:15', '--var', 'LOG_RETENTION_DAYS:365']);
    expect(readSettings({ VAULT_SETTINGS: JSON.stringify(example) }, '/n').source).toBe('VAULT_SETTINGS');
  });
});
