'use strict';
// 端到端走查：在真实的 Electron 窗口里操作界面、快进时钟、截图并断言。
// 运行：npm run e2e（使用临时数据目录，不影响真实数据）
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function run(ctx) {
  const { app, engine, store, panelWin, ballWin, expand, collapse, advance, persist, quickAdd, setClock } = ctx;
  const mode = process.env.TODOCAT_E2E;
  const out = process.env.TODOCAT_E2E_OUT || path.join(process.cwd(), 'e2e-shots');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => panelWin.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const check = (name, cond, extra = '') => { results.push({ name, ok: !!cond, extra }); console.log(`${cond ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`); };
  const shot = async (win, name) => { await sleep(250); fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage()).toPNG()); };
  const click = async (sel) => { const ok = await js(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true;`); await sleep(180); return ok; };
  const hoverAct = async (title, act) => {
    const ok = await js(`const row = [...document.querySelectorAll('section:not([hidden]) .task')].find(r => r.querySelector('.t-title').textContent === ${JSON.stringify(title)});
      if (!row) return false; const b = row.querySelector('[data-act="${act}"]'); if (!b) return false; b.click(); return true;`);
    await sleep(180);
    return ok;
  };
  const key = (sel, k, extra = '{}') => js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${extra})));`);
  const type = (sel, text) => js(`const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true }));`);
  const text = (sel) => js(`const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.textContent.trim() : null;`);
  const clockSec = async () => { const t = await text('.clock'); if (!t) return -1; return t.split(':').reduce((a, v) => a * 60 + Number(v), 0); };
  const near = (a, b, tol = 5) => Math.abs(a - b) <= tol;
  const tab = () => js(`return document.querySelector('#tabs nav .on').dataset.tab;`);
  const titles = () => engine.queue().map((t) => t.title);
  const byTitle = (t) => engine.s.tasks.find((x) => x.title === t);
  const addViaEnter = async (title, minutes) => {
    await type('#add-title', title);
    await key('#add-title', 'Enter');
    await type('#add-m', String(minutes));
    await js(`document.querySelector('#add').requestSubmit();`);
    await sleep(200);
  };
  const addViaChip = async (title, min) => { await type('#add-title', title); await click(`#add .chips [data-min="${min}"]`); };

  try {
    await Promise.all([panelWin, ballWin].map((w) => (w.webContents.isLoading() ? new Promise((r) => w.webContents.once('did-finish-load', r)) : null)));
    await sleep(600);

    if (mode === 'recover') {
      // 第二阶段：上一阶段在计时中被强杀，这里验证恢复
      expand({ userInitiated: false });
      await sleep(400);
      const n = engine.s.session.notice;
      check('异常退出后显示恢复提示', n && n.type === 'recovered');
      check('恢复后计时保持暂停', engine.s.session.phase === 'running' && !engine.clockRunning() && engine.s.session.paused);
      const t = engine.task(engine.s.session.taskId);
      check('恢复到最后保存点的剩余时长', t && Math.abs(t.remainingMs - 8 * 60000) < 3000, t ? `${Math.round(t.remainingMs / 1000)}s` : '');
      check('已删除的任务没有因恢复再次出现', !byTitle('写周报'));
      check('悬停回到白纸执行', (await tab()) === 'focus');
      const banner = await text('#banner');
      check('提示包含保存时间与草稿丢失说明', /保存点/.test(banner) && /草稿/.test(banner));
      await shot(panelWin, '13-recovered');
      await click('#banner [data-act="dismiss"]');
      await click('[data-act="resume"]');
      check('手动继续后恢复计时', engine.clockRunning());
    } else {
      // 固定从当天上午 10 点开始，避免快进时钟时跨过午夜
      const ten = new Date(); ten.setHours(10, 0, 0, 0); setClock(ten.getTime());
      // ---- 悬浮球与展开 ----
      await shot(ballWin, '01-ball');
      expand({ userInitiated: true });
      await sleep(500);
      check('开始前悬停打开 to-do', (await tab()) === 'todo');
      check('首次主动展开发放当日积分', engine.balance() === 10);
      check('自愿上报默认关闭且零排队', engine.s.settings.telemetry === false && store.countEvents() === 0);

      // ---- 录入 ----
      await type('#add-title', '写周报');
      await key('#add-title', 'Enter', '{ isComposing: true, keyCode: 229 }');
      check('输入法确认候选词时不跳步、不提交', engine.s.tasks.length === 0 && (await js(`return document.activeElement.id;`)) === 'add-title');
      await key('#add-title', 'Enter');
      check('回车后进入时长步骤', (await js(`return document.activeElement.id;`)) === 'add-m');
      await js(`document.querySelector('#add').requestSubmit();`);
      await sleep(150);
      check('未填时长不能提交', engine.s.tasks.length === 0 && /时长/.test(await text('#add-err')));
      await type('#add-m', '25');
      await js(`document.querySelector('#add').requestSubmit();`);
      await sleep(200);
      await addViaChip('回复邮件', 15);
      await click('#cats [data-cat="study"]');
      await addViaEnter('读论文', 60);
      check('三个任务已录入', engine.s.tasks.length === 3);
      await hoverAct('读论文', 'child');
      await addViaEnter('读摘要', 1);
      await addViaChip('做笔记', 25);
      check('子项归到父任务下，父任务不再计时', titles().join('|') === '写周报|回复邮件|读摘要|做笔记', titles().join('|'));
      await type('#add-title', '草稿：买猫粮');
      await shot(panelWin, '02-todo');
      collapse();
      await sleep(300);
      check('悬浮球数字为可执行任务数', (await ballWin.webContents.executeJavaScript(`document.getElementById('num').textContent`)) === '4');
      expand({ userInitiated: true });
      await sleep(300);
      check('收起后保留待办草稿', (await js(`return document.querySelector('#add-title').value;`)) === '草稿：买猫粮');
      await key('#add-title', 'Escape');
      await click('[data-act="onboarded"]');
      check('新手引导可关闭', engine.s.settings.onboarded === true && (await text('#onboard')) === '');
      await click('#cats [data-cat="life"]');
      await type('#add-title', '买猫粮 10分钟');
      check('一行录入识别出时长', /10 分/.test(await text('#add-hint')), await text('#add-hint'));
      await key('#add-title', 'Enter');
      await sleep(250);
      check('带时长的标题回车一步添加', byTitle('买猫粮') && byTitle('买猫粮').plannedMin === 10 && byTitle('买猫粮').categoryId === 'life');
      check('今日概览显示队列预计完成时间', /做完/.test(await text('#today-strip')), await text('#today-strip'));
      await js(`document.activeElement.blur();`);

      // ---- 白纸执行 ----
      const nonHead = await hoverAct('回复邮件', 'start');
      check('队首才有开始按钮', !nonHead && await hoverAct('写周报', 'start'));
      check('开始后进入白纸执行', (await tab()) === 'focus' && engine.clockRunning());
      await shot(panelWin, '03-focus-running');
      advance(5 * 60000);
      await sleep(400);
      check('计时走了 5 分钟', near(await clockSec(), 1200), await text('.clock'));
      await click('[data-act="thought"]');
      check('记想法时计时暂停', !engine.clockRunning());
      advance(2 * 60000);
      await type('#thought-text', '记得问一下报销流程');
      await shot(panelWin, '04-thought-entry');
      await key('#thought-text', 'Enter');
      await sleep(250);
      check('提交想法后恢复计时，录入期间不走表', engine.clockRunning() && near(await clockSec(), 1200), await text('.clock'));
      check('想法记录的是打开录入的时刻', engine.s.thoughts.length === 1 && engine.now() - engine.s.thoughts[0].at >= 2 * 60000);
      await key('body', 't');
      await sleep(200);
      check('键盘 T 打开想法录入', engine.s.session.thoughtOpenAt != null);
      await type('#thought-text', '顺便订会议室');
      await key('#thought-text', 'Enter');
      await sleep(200);
      await js(`document.activeElement.blur();`);
      await key('body', ' ');
      await sleep(200);
      const pausedByKey = engine.s.session.paused;
      await key('body', ' ');
      await sleep(200);
      check('空格键暂停与继续', pausedByKey && engine.clockRunning() && engine.s.thoughts.length === 2);
      await shot(panelWin, '04b-focus-ring');
      await click('[data-tab="todo"]');
      check('切换页面不影响计时，执行条可见', engine.clockRunning() && !(await js(`return document.querySelector('#execbar').hidden;`)));
      await shot(panelWin, '05-todo-with-execbar');
      collapse();
      await sleep(1200);
      check('折叠不影响计时，悬浮球显示剩余分钟', engine.clockRunning() && /^20/.test(await ballWin.webContents.executeJavaScript(`document.getElementById('num').textContent`)));
      await shot(ballWin, '06-ball-running');
      expand({ userInitiated: true });
      await sleep(300);
      check('执行中悬停回到白纸执行', (await tab()) === 'focus');

      // ---- 到点与回顾 ----
      advance(20 * 60000 + 500);
      await sleep(500);
      check('到点记为计时完成并进入回顾', byTitle('写周报').state === 'completed' && engine.s.session.phase === 'review');
      check('完成奖励只发一次', engine.balance() === 20);
      check('计时完成有庆祝动效', await js(`return !!document.querySelector('.confetti');`));
      await shot(panelWin, '07-review');
      const r = await js(`return (await api.cmd('start')).error || '';`);
      check('回顾勾完前不能开始下一项', /回顾/.test(r), r);
      await click('#focus-thoughts [data-thid]:nth-child(2) [data-act="conv"]');
      await shot(panelWin, '07b-review-convert');
      await click('#focus-thoughts [data-conv-min="15"]');
      check('想法转待办后自动勾上，仍需勾完其余想法', !!byTitle('顺便订会议室') && engine.s.thoughts[1].reviewed && engine.s.session.phase === 'review');
      await click('#focus-thoughts input[type=checkbox]');
      check('勾完后加载下一项但不自动启动', engine.s.session.phase === 'ready' && byTitle('回复邮件').id === engine.s.session.taskId && !engine.clockRunning());
      await shot(panelWin, '08-next-ready');

      // ---- 推出与送回 ----
      await click('#focus-body [data-act="start"]');
      advance(3 * 60000);
      await sleep(300);
      await click('[data-act="pushout"]');
      check('推出后进入 pending，无想法直接加载下一项', byTitle('回复邮件').state === 'pending' && engine.s.session.taskId === byTitle('读摘要').id);
      await click('[data-tab="pending"]');
      await shot(panelWin, '09-pending');
      await hoverAct('回复邮件', 'return');
      check('送回 to-do 原位置并保留剩余时长', titles()[0] === '回复邮件' && near(byTitle('回复邮件').remainingMs / 1000, 720), titles().join('|'));

      // ---- 父任务进度 ----
      await click('[data-tab="focus"]');
      await click('#focus-body [data-act="start"]');
      check('已加载的下一项不因送回而改变', engine.task(engine.s.session.taskId).title === '读摘要');
      advance(60500);
      await sleep(400);
      const p = engine.progress(byTitle('读论文'));
      check('父任务进度按计划分钟汇总', p.doneCount === 1 && p.validCount === 2 && p.doneMin === 1 && p.totalMin === 26);
      await click('[data-tab="todo"]');
      await shot(panelWin, '10-todo-progress');

      // ---- 想法收件箱 ----
      await click('[data-tab="more"]');
      await sleep(300);
      check('更多默认打开日历', !!(await text('.cal-nav .ttl')));
      await click('[data-more="thoughts"]');
      check('想法收件箱列出保留的想法', (await js(`return document.querySelectorAll('#inbox-list .th').length;`)) === 2);
      await type('#inbox-q', '报销');
      check('收件箱可搜索', (await js(`return document.querySelectorAll('#inbox-list .th').length;`)) === 1);
      await shot(panelWin, '10b-inbox');
      await type('#inbox-q', '');
      await js(`document.activeElement.blur();`);

      // ---- 删除保留历史 ----
      await click('[data-tab="completed"]');
      await hoverAct('写周报', 'del');
      await shot(panelWin, '11-delete-confirm');
      await click('[data-act="del-yes"]');
      const cal = await js(`return await api.calendar('day');`);
      check('删除清除任务与想法', !byTitle('写周报') && engine.s.thoughts.length === 0);
      check('删除后历史计时、完成数、积分保留', Math.round(cal.total.runMs / 60000) === 29 && cal.total.done === 2 && cal.total.thoughts === 0 && engine.balance() === 30,
        `${Math.round(cal.total.runMs / 60000)}分 / ${cal.total.done}项 / ${engine.balance()}分`);

      // ---- 日历、猫、设置 ----
      await click('[data-tab="more"]');
      await click('[data-more="calendar"]');
      await sleep(300);
      await shot(panelWin, '12a-calendar-week');
      await click('[data-view="day"]'); await sleep(250);
      await shot(panelWin, '12b-calendar-day');
      await click('[data-view="month"]'); await sleep(250);
      await shot(panelWin, '12c-calendar-month');
      await click('[data-more="cat"]');
      await click('[data-act="feed"]');
      check('喂猫扣积分', engine.balance() === 20 && engine.s.cat.lastFedAt != null);
      await shot(panelWin, '12d-cat');
      await click('[data-more="settings"]');
      await click('[data-set="telemetry"]');
      await click('[data-set="desktopCat"]');
      check('同意后才开始排队上报事件，且不含标题', store.countEvents() >= 1 && !JSON.stringify(store.listEvents()).includes('回复邮件'));
      await shot(panelWin, '12e-settings');
      await click('[data-set="telemetry"]');
      check('撤回后清空本地队列', store.countEvents() === 0 && engine.s.settings.telemetry === false);
      collapse();
      await sleep(500);
      await shot(ballWin, '12f-ball-with-cat');

      quickAdd(true);
      await sleep(500);
      check('快捷键入口：展开到 to-do 并聚焦录入框', (await tab()) === 'todo' && (await js(`return document.activeElement.id;`)) === 'add-title');
      await js(`document.activeElement.blur();`);

      // ---- 留一个计时中的任务，随后强制退出，供恢复阶段验证 ----
      expand({ userInitiated: false });
      await click('[data-tab="focus"]');
      await click('#focus-body [data-act="start"]'); // 回复邮件，剩 12 分
      advance(4 * 60000);
      persist(true); // 心跳保存点
      await sleep(1500); // 保存点之后又跑了一会儿，然后被强杀
      check('强杀前处于执行中', engine.clockRunning() && engine.task(engine.s.session.taskId).title === '回复邮件');
    }
  } catch (err) {
    check('走查脚本未抛异常', false, err.stack || err.message);
  }

  const failed = results.filter((x) => !x.ok);
  fs.writeFileSync(path.join(out, `result-${mode === 'recover' ? 'recover' : 'main'}.json`), JSON.stringify(results, null, 2));
  console.log(`\nE2E(${mode}): ${results.length - failed.length}/${results.length} 通过`);
  app.exit(failed.length ? 1 : 0); // app.exit 不触发 before-quit，相当于异常退出
};
