// Turns the packer build into a single dist/index.html and adds the hosted viewer page.
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inlinePage } from './inline.mjs';

const js = readFileSync('dist/app.js', 'utf8');
const css = readFileSync('dist/app.css', 'utf8');
writeFileSync('dist/index.html', inlinePage({ title: '隨身密閱 打包器', js, css }));
rmSync('dist/app.js');
rmSync('dist/app.css');
copyFileSync('dist-viewer/open.html', 'dist/open.html');
console.log(`packer: ${(js.length / 1024).toFixed(0)} KB`);
