// Inlines the built viewer JS/CSS into one HTML template.
//   src/generated/viewer-template.html  -> imported by the packer (contains the payload marker)
//   dist-viewer/open.html               -> hosted page for phones (no payload; asks for a file)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inlinePage } from './inline.mjs';
import { readSettings, settingsTag } from './settings.mjs';

const js = readFileSync('dist-viewer/viewer.js', 'utf8');
const css = readFileSync('dist-viewer/viewer.css', 'utf8');
mkdirSync('src/generated', { recursive: true });
const { app } = readSettings();
const settings = settingsTag(app);
const name = app.appName || '隨身密閱';
writeFileSync('src/generated/viewer-template.html', inlinePage({ title: '__VAULT_TITLE__', js, css, settings, body: '<!--VAULT-PAYLOAD-->' }));
writeFileSync('dist-viewer/open.html', inlinePage({ title: `${name} 檢視器`, js, css, settings }));
console.log(`viewer template: ${(js.length / 1024).toFixed(0)} KB js, ${(css.length / 1024).toFixed(0)} KB css`);
