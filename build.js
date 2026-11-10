// 從 inject.js 產生：
//   dist/pokesurvivor-autofarm.user.js   油猴腳本（Greasy Fork 從 GitHub 同步這個檔案）
//   dist/pokesurvivor-autofarm-v<版本>.zip  Chrome 擴充（GitHub Releases 附件）
// 用法：node build.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const src = fs.readFileSync(path.join(root, 'inject.js'), 'utf8');
const version = (src.match(/const VERSION = '([^']+)'/) || [])[1];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (!version) throw new Error('inject.js 裡找不到 VERSION');
if (manifest.version !== version) throw new Error(`版本不一致：inject.js ${version}，manifest.json ${manifest.version}`);

const repo = 'https://github.com/b0933223169-coder/pokesurvivor-autofarm';
const header = `// ==UserScript==
// @name         PokéSurvivor 自動掛機 (PSBot)
// @name:en      PokéSurvivor Auto-Farm (PSBot)
// @namespace    ${repo}
// @version      ${version}
// @description  PokéSurvivor 自動走位躲招、選卡、綁羈絆、進神祕裂縫、處理事件（Gholdengo、求救、祭壇…）、自動再開一局
// @description:en Auto movement & dodging, card picks, bonds, rifts, events (Gholdengo, rescues, altars…) and auto restart for PokéSurvivor
// @author       BoundlessEgret
// @license      MIT
// @match        https://pokesurvivor.com/*
// @match        https://www.pokesurvivor.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @homepageURL  ${repo}
// @supportURL   ${repo}/issues
// @updateURL    ${repo}/releases/latest/download/pokesurvivor-autofarm.user.js
// @downloadURL  ${repo}/releases/latest/download/pokesurvivor-autofarm.user.js
// ==/UserScript==

`;

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'pokesurvivor-autofarm.user.js'), header + src);

const zip = path.join(dist, `pokesurvivor-autofarm-v${version}.zip`);
fs.rmSync(zip, { force: true });
try {
  execFileSync('zip', ['-q', '-X', zip, 'manifest.json', 'inject.js', 'README.md', 'LICENSE'], { cwd: root });
} catch (e) {
  if (process.platform !== 'win32' || e.code !== 'ENOENT') throw e;
  // Windows 沒有 zip 指令，改用 PowerShell 的 Compress-Archive
  const relZip = path.relative(root, zip).replace(/\\/g, '\\\\');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path 'manifest.json','inject.js','README.md','LICENSE' -DestinationPath '${relZip}' -Force`], { cwd: root });
}

console.log(`v${version}\n  ${path.relative(root, path.join(dist, 'pokesurvivor-autofarm.user.js'))}\n  ${path.relative(root, zip)}`);
