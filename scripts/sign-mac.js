'use strict';
// 给打包出的 macOS App 做本地临时签名（Apple Silicon 上未签名的 App 无法启动）
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dist = path.join(__dirname, '../dist');
for (const dir of fs.readdirSync(dist).filter((d) => d.includes('-darwin-'))) {
  const app = path.join(dist, dir, 'Todo Cat.app');
  execFileSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'inherit' });
  console.log('signed', app);
}
