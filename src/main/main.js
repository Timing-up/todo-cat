'use strict';
const { app, BrowserWindow, ipcMain, screen, powerMonitor, Notification, Menu, Tray, nativeImage, shell, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { Engine } = require('../core/engine');
const { stats } = require('../core/calendar');
const { Store } = require('./store');

const E2E = !!process.env.TODOCAT_E2E;
const MAC = process.platform === 'darwin';
const MOD_KEYS = MAC ? { add: '⌥⇧T', thought: '⌥⇧I', mod: '⌘' } : { add: 'Alt+Shift+T', thought: 'Alt+Shift+I', mod: 'Ctrl+' };
if (process.env.TODOCAT_DATA_DIR) app.setPath('userData', process.env.TODOCAT_DATA_DIR);
else if (E2E) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'todocat-e2e-')));

const BALL = 72;
const CAT_H = 58;
const PANEL_W = 430;
const PANEL_H = 640;
const TELEMETRY_URL = process.env.TODOCAT_TELEMETRY_URL || ''; // 第一方接收服务地址；未配置时事件只在本地排队
const RETAIN_MS = 90 * 86400e3;

let store, engine, ballWin, panelWin, tray;
let clockOffset = 0; // 仅 E2E 用来快进时钟
let ballPos = null;
let anchor = { dx: 0, dy: 0 };
let editing = false;
let lastInside = 0;
let holdUntil = 0;
let retryTimer = null;
let quitting = false;
let shortcutsOk = { add: false, thought: false };
let lastTray = '';
const SHORTCUTS = { add: 'Alt+Shift+T', thought: 'Alt+Shift+I' };

const now = () => Date.now() + clockOffset;

// ---------- 持久化 ----------
function persist(light = false) {
  try {
    store.save(engine.s, { light });
    if (engine.saveError) engine.saveRecovered();
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    return true;
  } catch (err) {
    console.error('[save failed]', err.message);
    engine.saveFailed(); // 暂停并持续警告
    if (!retryTimer) retryTimer = setInterval(() => { if (persist()) broadcast(); }, 5000);
    return false;
  }
}

function broadcast() {
  const snap = engine.snapshot();
  snap.env = { packaged: app.isPackaged, telemetryQueued: store.countEvents(), telemetryEndpoint: !!TELEMETRY_URL, shortcutsOk, keys: MOD_KEYS };
  snap.todayStats = stats(engine.s, 'day', now()).total;
  updateTray();
  for (const w of [ballWin, panelWin]) if (w && !w.isDestroyed()) w.webContents.send('state', snap);
  return snap;
}

// ---------- 自愿上报（默认关闭，仅事件元数据） ----------
function onEngineEvent(name, props = {}) {
  if (name === 'timer_finished') onTimeUp(props.title);
  if (!engine || !engine.s.settings.telemetry) return;
  const { title, ...meta } = props; // 任务标题、想法正文不进入采集范围
  const id = crypto.randomUUID();
  const payload = { id, name, ts: now(), installId: engine.s.meta.installId, testCode: engine.s.settings.testCode || null, props: meta };
  try { store.enqueueEvent(id, payload, payload.ts); } catch (e) { console.error('[telemetry]', e.message); }
}

async function flushTelemetry() {
  if (!engine.s.settings.telemetry) return;
  try {
    store.pruneEvents(now() - RETAIN_MS);
    if (!TELEMETRY_URL) return;
    const batch = store.listEvents(100);
    if (!batch.length) return;
    const res = await fetch(TELEMETRY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: batch.map((b) => b.payload) }) });
    if (res.ok) store.deleteEvents(batch.map((b) => b.id)); // 失败则留在队列里重试；服务端按事件 id 去重
  } catch { /* 断网：继续排队 */ }
}

function onTimeUp(title) {
  try {
    if (Notification.isSupported()) new Notification({ title: '计时完成', body: title || '', silent: false }).show();
  } catch { /* ignore */ }
  if (!E2E && engine.s.settings.sound) shell.beep();
  setTimeout(() => expand({ userInitiated: false, hold: 15000 }), 50);
}

// ---------- 窗口 ----------
function workAreaFor(pt) { return screen.getDisplayNearestPoint(pt).workArea; }

function ballBounds() {
  const cat = engine.s.settings.desktopCat;
  return { x: ballPos.x, y: cat ? ballPos.y - CAT_H : ballPos.y, width: BALL, height: cat ? BALL + CAT_H : BALL };
}
function clampBall() {
  const wa = workAreaFor({ x: ballPos.x + BALL / 2, y: ballPos.y + BALL / 2 });
  ballPos.x = Math.min(Math.max(ballPos.x, wa.x), wa.x + wa.width - BALL);
  ballPos.y = Math.min(Math.max(ballPos.y, wa.y + (engine.s.settings.desktopCat ? CAT_H : 0)), wa.y + wa.height - BALL);
}
function placeBall() {
  clampBall();
  if (ballWin && !ballWin.isDestroyed()) ballWin.setBounds(ballBounds());
}

function applyOnTop() {
  const on = !!engine.s.settings.alwaysOnTop;
  for (const w of [ballWin, panelWin]) {
    w.setAlwaysOnTop(on, 'floating');
    if (MAC) w.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
  }
}

function createWindows() {
  const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false };
  const saved = engine.s.settings.ball;
  const wa = screen.getPrimaryDisplay().workArea;
  ballPos = saved ? { ...saved } : { x: wa.x + wa.width - BALL - 28, y: wa.y + 140 };
  clampBall();

  ballWin = new BrowserWindow({
    ...ballBounds(), frame: false, transparent: true, resizable: false, movable: true, hasShadow: false,
    skipTaskbar: true, fullscreenable: false, maximizable: false, minimizable: false, show: false,
    ...(MAC ? { type: 'panel' } : {}), focusable: false, webPreferences,
  });
  ballWin.loadFile(path.join(__dirname, '../renderer/ball.html'));

  panelWin = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, frame: false, resizable: false, show: false, skipTaskbar: true,
    fullscreenable: false, maximizable: false, minimizable: false, roundedCorners: true,
    // macOS 用系统毛玻璃；其他平台先用不透明底色
    ...(MAC ? { type: 'panel', vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000' } : { backgroundColor: '#23211e' }),
    webPreferences,
  });
  panelWin.loadFile(path.join(__dirname, '../renderer/panel.html'), { query: E2E || !MAC ? { solid: '1' } : {} });
  panelWin.on('move', () => {
    if (!panelWin.isVisible()) return;
    const b = panelWin.getBounds();
    ballPos = { x: b.x - anchor.dx, y: b.y - anchor.dy };
  });
  panelWin.on('moved', () => { engine.s.settings.ball = { ...ballPos }; persist(); });
  panelWin.on('close', (e) => { if (!quitting) { e.preventDefault(); collapse(); } });

  applyOnTop();
  ballWin.once('ready-to-show', () => ballWin.showInactive());
}

function expand({ userInitiated = true, hold = 0, tab = null, extra = {} } = {}) {
  if (!panelWin || panelWin.isDestroyed()) return;
  if (userInitiated && engine.claimDaily()) { // 首次主动展开：每个本地日发一次基础积分
    persist();
    panelWin.webContents.send('toast', `今日积分 +${engine.snapshot().constants.DAILY_REWARD}，够喂一次猫`);
  }
  if (!panelWin.isVisible()) {
    const wa = workAreaFor({ x: ballPos.x + BALL / 2, y: ballPos.y + BALL / 2 });
    const right = ballPos.x + BALL / 2 > wa.x + wa.width / 2;
    let x = right ? ballPos.x + BALL - PANEL_W : ballPos.x;
    let y = ballPos.y;
    x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - PANEL_W - 8);
    y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - PANEL_H - 8);
    anchor = { dx: x - ballPos.x, dy: y - ballPos.y };
    panelWin.setBounds({ x, y, width: PANEL_W, height: PANEL_H });
    panelWin.showInactive();
    ballWin.hide();
    panelWin.webContents.send('expanded', { target: tab || engine.hoverTarget(), fresh: true, ...extra });
  } else if (tab) panelWin.webContents.send('expanded', { target: tab, ...extra });
  lastInside = Date.now();
  holdUntil = Math.max(holdUntil, Date.now() + hold);
  broadcast();
}

function collapse() {
  if (!panelWin || !panelWin.isVisible()) return;
  panelWin.hide();
  holdUntil = 0;
  placeBall();
  ballWin.showInactive();
}

// 鼠标离开面板一会儿且没有在编辑时自动收起
function watchCursor() {
  if (E2E || !panelWin || !panelWin.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = panelWin.getBounds();
  const m = 14;
  const inside = p.x >= b.x - m && p.x <= b.x + b.width + m && p.y >= b.y - m && p.y <= b.y + b.height + m;
  const t = Date.now();
  if (inside) { lastInside = t; holdUntil = 0; return; }
  if (!editing && t > holdUntil && t - lastInside > 700) collapse();
}

// ---------- 快捷入口：全局快捷键、悬浮球右键菜单、菜单栏倒计时 ----------
function quickAdd(force = false) {
  if (!force && panelWin.isVisible() && panelWin.isFocused()) { collapse(); return; }
  expand({ userInitiated: true, hold: 2500, tab: 'todo', extra: { focusAdd: true } });
  panelWin.focus();
}
function quickThought() {
  if (engine.s.session.phase !== 'running') {
    quickAdd(true);
    panelWin.webContents.send('toast', '执行中才能记想法，先记成待办吧');
    return;
  }
  try { engine.openThought(); persist(); } catch { /* 已在录入 */ }
  expand({ userInitiated: true, hold: 2500, tab: 'focus' });
  panelWin.focus();
}
function runCmd(name) {
  try { engine[name]({}); persist(); broadcast(); } catch (err) { panelWin.webContents.send('toast', err.message); }
}
function applyShortcuts() {
  globalShortcut.unregisterAll();
  shortcutsOk = { add: false, thought: false };
  if (E2E || !engine.s.settings.shortcuts) return;
  try {
    shortcutsOk.add = globalShortcut.register(SHORTCUTS.add, () => quickAdd());
    shortcutsOk.thought = globalShortcut.register(SHORTCUTS.thought, quickThought);
  } catch (e) { console.error('[shortcut]', e.message); }
  console.log('[shortcuts]', JSON.stringify(shortcutsOk));
}
function ballMenu() {
  const ss = engine.s.session;
  const items = [];
  if (ss.phase === 'running') {
    items.push({ label: ss.paused ? '继续计时' : '暂停计时', click: () => runCmd(ss.paused ? 'resume' : 'pause') });
    items.push({ label: '记想法…', click: quickThought });
  } else if (ss.phase === 'review') {
    items.push({ label: '回顾想法…', click: () => expand({ userInitiated: true, hold: 2500, tab: 'focus' }) });
  } else {
    const next = engine.nextId() && engine.task(engine.nextId());
    if (next) items.push({ label: `开始：${next.title.slice(0, 24)}`, click: () => runCmd('start') });
  }
  items.push({ label: '记一件事…', click: () => quickAdd(true) }, { type: 'separator' }, { label: '退出 Todo Cat', click: () => app.quit() });
  Menu.buildFromTemplate(items).popup({ window: ballWin });
}
function updateTray() {
  if (!tray) return;
  const ss = engine.s.session;
  let t = '🐱';
  if (ss.phase === 'running') {
    const task = engine.task(ss.taskId);
    const s = Math.ceil(engine.remainingMs(task) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    t = `🐱 ${engine.clockRunning() ? '' : '❚❚ '}${mm}:${String(s % 60).padStart(2, '0')}`;
  } else if (ss.phase === 'review') t = '🐱 待回顾';
  if (t !== lastTray) {
    lastTray = t;
    if (MAC) tray.setTitle(t, { fontType: 'monospacedDigit' });
    else tray.setToolTip(t.replace('🐱', 'Todo Cat').trim());
  }
}

// ---------- IPC ----------
const COMMANDS = new Set(['addTask', 'splitTask', 'editTask', 'moveTask', 'start', 'pause', 'resume', 'openThought', 'cancelThought',
  'submitThought', 'checkThought', 'thoughtToTask', 'pushOut', 'returnToTodo', 'cancelTask', 'deleteTask', 'feedCat', 'dismissNotice', 'claimDaily']);

function applySetting(key, value) {
  engine.setSetting({ key, value });
  if (key === 'alwaysOnTop') applyOnTop();
  if (key === 'desktopCat') placeBall();
  if (key === 'autoLaunch' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!value });
    if (app.getLoginItemSettings().openAtLogin !== !!value) { // 系统没有接受（例如 App 没有正式签名）
      engine.setSetting({ key, value: !value });
      throw new Error('系统没有允许登记开机自启动，这个版本的 App 需要正式签名后才能用');
    }
  }
  if (key === 'shortcuts') applyShortcuts();
  if (key === 'telemetry') {
    if (value) onEngineEvent('telemetry_opt_in');
    else store.clearEvents(); // 撤回：停止采集并清空本地队列
  }
}

function registerIpc() {
  ipcMain.handle('cmd', (_e, name, args) => {
    try {
      let result;
      if (name === 'setSetting') result = applySetting(args.key, args.value);
      else if (name === 'clearTelemetry') result = store.clearEvents();
      else if (COMMANDS.has(name)) result = engine[name](args || {});
      else throw new Error(`未知命令 ${name}`);
      persist();
      broadcast();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('snapshot', () => broadcast());
  ipcMain.handle('calendar', (_e, view, anchorTs) => stats(engine.s, view, anchorTs || now()));
  ipcMain.on('ui', (_e, name, payload) => {
    if (name === 'hover') expand({ userInitiated: true });
    else if (name === 'collapse') collapse();
    else if (name === 'editing') editing = !!payload;
    else if (name === 'focus') { if (panelWin.isVisible() && !panelWin.isFocused()) panelWin.focus(); }
    else if (name === 'dragStart') { ballWin._drag = { ...ballPos }; }
    else if (name === 'drag' && ballWin._drag) {
      ballPos = { x: Math.round(ballWin._drag.x + payload.dx), y: Math.round(ballWin._drag.y + payload.dy) };
      ballWin.setBounds(ballBounds());
    } else if (name === 'dragEnd') {
      ballWin._drag = null;
      const wa = workAreaFor({ x: ballPos.x + BALL / 2, y: ballPos.y + BALL / 2 });
      if (ballPos.x - wa.x < 30) ballPos.x = wa.x + 6; // 靠近屏幕边缘时贴边
      else if (wa.x + wa.width - (ballPos.x + BALL) < 30) ballPos.x = wa.x + wa.width - BALL - 6;
      placeBall();
      engine.s.settings.ball = { ...ballPos };
      persist();
    } else if (name === 'ballMenu') ballMenu();
    else if (name === 'quit') app.quit();
  });
}

function buildTray() {
  try {
    // macOS 菜单栏用文字标题显示倒计时；Windows 托盘需要图标，倒计时放在悬停提示里
    tray = new Tray(MAC ? nativeImage.createEmpty() : nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png')).resize({ width: 16, height: 16 }));
    if (MAC) tray.setTitle('🐱');
    else tray.on('click', () => expand({ userInitiated: true, hold: 4000 }));
    tray.setToolTip('Todo Cat');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Todo Cat', click: () => expand({ userInitiated: true, hold: 4000 }) },
      { label: '日历', click: () => expand({ userInitiated: true, hold: 4000, tab: 'more' }) },
      { type: 'separator' },
      { label: '退出 Todo Cat', click: () => app.quit() },
    ]));
  } catch (e) { console.error('[tray]', e.message); }
}

// ---------- 启动 ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => expand({ userInitiated: true, hold: 4000 }));
  app.whenReady().then(async () => {
    if (!MAC) app.setAppUserModelId('com.todocat.app'); // Windows 通知需要
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    store = new Store(path.join(dir, 'todocat.db'));
    engine = new Engine(store.load(), { now, emit: onEngineEvent });
    engine.recoverOnBoot(); // 异常退出：回到最后保存点并提示
    persist();

    registerIpc();
    createWindows();
    if (!E2E) buildTray();
    applyShortcuts();
    onEngineEvent('app_open');

    setInterval(() => { if (engine.tick()) { persist(); broadcast(); } updateTray(); }, 500);
    setInterval(() => { if (engine.clockRunning()) persist(true); }, 10000); // 心跳保存点
    setInterval(() => { broadcast(); flushTelemetry(); }, 60000);
    setInterval(watchCursor, 200);

    const sysPause = (kind) => () => { if (engine.systemPause(kind)) { persist(); broadcast(); } };
    powerMonitor.on('lock-screen', sysPause('lock'));
    powerMonitor.on('suspend', sysPause('sleep'));
    app.on('activate', () => expand({ userInitiated: true, hold: 4000 }));

    if (E2E) {
      require('../../test/e2e.js')({
        app, engine, store, panelWin, ballWin, expand, collapse, persist, broadcast, quickAdd, quickThought,
        setClock(ts) { clockOffset = ts - Date.now(); },
        advance(ms) { clockOffset += ms; if (engine.s.session.lastTickAt != null) engine.s.session.lastTickAt += ms - 500; if (engine.tick()) persist(); broadcast(); },
      });
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    if (!engine) return;
    engine.systemPause('quit'); // 正常退出：暂停并保存
    persist();
    try { store.close(); } catch { /* ignore */ }
  });
  app.on('window-all-closed', () => {});
}
