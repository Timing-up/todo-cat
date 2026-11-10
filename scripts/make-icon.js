'use strict';
// 生成应用图标：electron scripts/make-icon.js → build/icon.png (1024)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const html = `<body style="margin:0;background:transparent"><svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3df"/><stop offset="1" stop-color="#f5b872"/></linearGradient></defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
<g transform="translate(182 215) scale(5.5)">
<path d="M92 80 q22 -4 14 -26" stroke="#e08e3c" stroke-width="8" fill="none" stroke-linecap="round"/>
<ellipse cx="60" cy="76" rx="30" ry="18" fill="#ee9f4a"/>
<path d="M34 30 L30 8 L50 22 Z M86 30 L90 8 L70 22 Z" fill="#ee9f4a"/>
<path d="M36 24 L34 14 L44 21 Z M84 24 L86 14 L76 21 Z" fill="#f7cfc0"/>
<ellipse cx="60" cy="46" rx="30" ry="25" fill="#f4ae5f"/>
<path d="M52 23 l2 9 M60 21 l0 10 M68 23 l-2 9" stroke="#c9742a" stroke-width="3" stroke-linecap="round"/>
<path d="M44 46 q5 -6 10 0 M66 46 q5 -6 10 0" stroke="#4a3320" stroke-width="2.6" fill="none" stroke-linecap="round"/>
<path d="M57.5 51 h5 l-2.5 3 z" fill="#d9634f"/>
<path d="M55 55 q5 5 10 0" stroke="#4a3320" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<path d="M30 92 l10 10 l20 -22" stroke="#2f9e6e" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</g></svg></body>`;
app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.exit(0);
});
