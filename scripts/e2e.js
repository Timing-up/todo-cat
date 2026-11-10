'use strict';
// 跨平台启动端到端走查：node scripts/e2e.js [recover]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todocat-e2e-'));
const run = (mode) => spawnSync(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, TODOCAT_E2E: mode, TODOCAT_DATA_DIR: dataDir } }).status;
// 第一阶段走完主流程后强制退出；第二阶段用同一份数据验证异常恢复
const a = run('1');
const b = a === 0 ? run('recover') : 1;
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(a || b);
