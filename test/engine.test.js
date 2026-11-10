'use strict';
process.env.TZ = 'Asia/Shanghai';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, emptyState, C } = require('../src/core/engine');
const { stats } = require('../src/core/calendar');

const MIN = 60000;
const T0 = new Date(2026, 10, 10, 9, 0, 0).getTime(); // 2026-11-10 09:00 本地

function make(start = T0) {
  let now = start;
  let n = 0;
  const events = [];
  const e = new Engine(emptyState(start), { now: () => now, uid: () => `id${++n}`, emit: (name, p) => events.push({ name, p }) });
  return {
    e, events,
    adv(ms) { now += ms; return e.tick(); },
    // 像真实运行一样每秒 tick 一次（避免触发挂起检测）
    run(ms) { for (let left = ms; left > 0; left -= 1000) { now += Math.min(1000, left); e.tick(); } },
    set(ts) { now = ts; },
    get now() { return now; },
  };
}
const add = (e, title, minutes = 25, extra = {}) => e.addTask({ title, minutes, categoryId: 'work', ...extra });

test('录入校验：标题必填，时长 1–1440 分钟', () => {
  const { e } = make();
  assert.throws(() => add(e, '  '), /标题/);
  assert.throws(() => add(e, 'a', 0), /1–1440/);
  assert.throws(() => add(e, 'a', 1441), /1–1440/);
  assert.throws(() => add(e, 'a', 1.5), /1–1440/);
  add(e, 'a', 1); add(e, 'b', 1440);
  assert.equal(e.queue().length, 2);
});

test('队列按分类、任务、子任务顺序；父任务不可计时', () => {
  const { e } = make();
  const life = e.addTask({ title: '买菜', minutes: 15, categoryId: 'life' });
  const p = add(e, '写报告', 60);
  const c1 = add(e, '提纲', 15, { parentId: p });
  const c2 = add(e, '正文', 45, { parentId: p });
  const w2 = add(e, '回邮件', 15);
  assert.deepEqual(e.queue().map((t) => t.id), [c1, c2, w2, life]);
  assert.equal(e.start(), c1);
  assert.throws(() => add(e, '孙任务', 5, { parentId: c1 }), /两层/);
});

test('计时：暂停不走表，到点记为完成并只发一次奖励', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 25);
  e.start();
  x.run(10 * MIN);
  e.pause();
  x.adv(20 * MIN); // 暂停期间
  assert.equal(e.task(a).remainingMs, 15 * MIN);
  e.resume();
  x.run(15 * MIN - 1000);
  assert.equal(e.task(a).state, 'todo');
  x.run(1000);
  assert.equal(e.task(a).state, 'completed');
  assert.equal(e.balance(), C.TASK_REWARD);
  assert.equal(e.s.completions.length, 1);
  assert.equal(x.events.filter((v) => v.name === 'timer_finished').length, 1);
  // 运行时段合计恰为计划时长
  const run = e.s.segments.reduce((s, g) => s + g.end - g.start, 0);
  assert.equal(run, 25 * MIN);
  // 没有想法：直接结束，队列空 → idle，悬停回 to-do
  assert.equal(e.s.session.phase, 'idle');
  assert.equal(e.hoverTarget(), 'todo');
});

test('想法录入暂停计时；提交记录打开时刻；只解除本次录入的暂停', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 25);
  e.start();
  x.run(5 * MIN);
  const openedAt = x.now;
  e.openThought();
  assert.equal(e.clockRunning(), false);
  x.adv(3 * MIN);
  e.submitThought({ text: '记得回电话' });
  assert.equal(e.s.thoughts[0].at, openedAt);
  assert.equal(e.clockRunning(), true);
  assert.equal(e.remainingMs(e.task(a)), 20 * MIN);

  // 手动暂停后再记想法：提交后仍保持手动暂停
  e.pause();
  e.openThought();
  e.submitThought({ text: '第二条' });
  assert.equal(e.clockRunning(), false);
  assert.equal(e.s.session.paused, true);

  // 取消录入同样只解除录入暂停
  e.resume();
  e.openThought();
  e.cancelThought();
  assert.equal(e.clockRunning(), true);
  assert.equal(e.s.thoughts.length, 2);
});

test('到点后回顾：全部勾完才加载下一项', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 1);
  const b = add(e, 'B', 1);
  e.start();
  e.openThought(); const t1 = e.submitThought({ text: 'x' });
  e.openThought(); const t2 = e.submitThought({ text: 'y' });
  x.run(MIN);
  assert.equal(e.task(a).state, 'completed');
  assert.equal(e.s.session.phase, 'review');
  assert.throws(() => e.start(), /回顾/);
  e.checkThought({ id: t1 });
  assert.equal(e.s.session.phase, 'review');
  e.checkThought({ id: t1, checked: false });
  e.checkThought({ id: t1 });
  e.checkThought({ id: t2 });
  assert.equal(e.s.session.phase, 'ready');
  assert.equal(e.s.session.taskId, b);
  assert.equal(e.hoverTarget(), 'focus'); // 同一轮下一项待开始
  assert.equal(e.clockRunning(), false); // 不自动启动
  assert.equal(x.events.filter((v) => v.name === 'review_completed').length, 1);
});

test('推出：进 pending，丢草稿，想法留待回顾；回顾后送回原位置按剩余时长继续', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 25);
  const b = add(e, 'B', 25);
  e.start();
  x.run(10 * MIN);
  e.openThought(); const th = e.submitThought({ text: '想法' });
  e.openThought(); // 未提交草稿
  e.pushOut();
  assert.equal(e.task(a).state, 'pending');
  assert.equal(e.s.session.thoughtOpenAt, null);
  assert.equal(e.s.session.phase, 'review');
  assert.throws(() => e.returnToTodo({ id: a }), /回顾/);
  e.checkThought({ id: th });
  assert.equal(e.s.session.taskId, b);
  e.returnToTodo({ id: a });
  assert.deepEqual(e.queue().map((t) => t.id), [a, b]); // 回到原位置
  assert.equal(e.task(a).remainingMs, 15 * MIN);
  assert.equal(e.s.thoughts[0].reviewed, true); // 已回顾想法留在历史里
  assert.equal(e.balance(), 0); // 推出不发奖

  // 待开始的任务也能推出，送回后按原时长首次开始
  e.pushOut({ id: b });
  assert.equal(e.task(b).started, false);
  e.returnToTodo({ id: b });
  assert.equal(e.task(b).remainingMs, 25 * MIN);
});

test('同一任务推出后继续执行仍是同一任务，奖励只发一次', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 2);
  e.start(); x.run(MIN); e.pushOut();
  e.returnToTodo({ id: a });
  e.start(); x.run(MIN);
  assert.equal(e.task(a).state, 'completed');
  assert.equal(e.s.completions.length, 1);
  assert.equal(e.balance(), C.TASK_REWARD);
});

test('父任务：进度按计划分钟，状态派生，取消只影响未完成子项', () => {
  const x = make();
  const { e } = x;
  const p = add(e, '父', 30);
  const c1 = add(e, 'c1', 10, { parentId: p });
  const c2 = add(e, 'c2', 30, { parentId: p });
  const c3 = add(e, 'c3', 20, { parentId: p });
  assert.equal(e.status(e.task(p)), 'todo');
  e.start(); x.run(10 * MIN);
  assert.deepEqual(e.progress(e.task(p)), { doneMin: 10, totalMin: 60, doneCount: 1, validCount: 3, ratio: 10 / 60 });
  e.cancelTask({ id: c3 }); // 取消的子项不算有效
  assert.equal(e.progress(e.task(p)).totalMin, 40);
  e.pushOut({ id: c2 });
  assert.equal(e.status(e.task(p)), 'pending');
  e.returnToTodo({ id: c2 });
  e.start(); x.run(30 * MIN);
  assert.equal(e.status(e.task(p)), 'completed');
  assert.throws(() => add(e, '再加', 5, { parentId: p }), /已结束/);

  const q = add(e, '父2', 30);
  const d1 = add(e, 'd1', 1, { parentId: q });
  const d2 = add(e, 'd2', 1, { parentId: q });
  e.start(); x.run(MIN);
  e.cancelTask({ id: q });
  assert.equal(e.task(d1).state, 'completed');
  assert.equal(e.task(d2).state, 'cancelled');
  assert.equal(e.status(e.task(q)), 'cancelled');

  // 空计划：有效子项为零 → cancelled
  const r = add(e, '父3', 30);
  const f1 = add(e, 'f1', 1, { parentId: r });
  e.cancelTask({ id: f1 });
  assert.equal(e.status(e.task(r)), 'cancelled');
});

test('开始后锁定时长与层级，标题仍可改；拆分只在首次开始前', () => {
  const x = make();
  const { e } = x;
  const p = add(e, '父', 30);
  const c1 = add(e, 'c1', 10, { parentId: p });
  const s = e.splitTask({ id: c1, title: 'c1-b', minutes: 5 });
  assert.deepEqual(e.kids(p).map((k) => k.id), [c1, s]);
  e.editTask({ id: c1, minutes: 20 });
  assert.equal(e.task(c1).remainingMs, 20 * MIN);
  e.start(); x.run(MIN);
  e.editTask({ id: c1, title: '新标题' });
  assert.equal(e.task(c1).title, '新标题');
  assert.throws(() => e.editTask({ id: c1, minutes: 30 }), /锁定/);
  assert.throws(() => e.splitTask({ id: c1, title: 'x', minutes: 5 }), /不能再拆分/);
  const solo = add(e, '独立', 10);
  e.pause(); e.pushOut();
  e.returnToTodo({ id: c1 });
  assert.throws(() => add(e, '子', 5, { parentId: c1 }), /两层/);
  add(e, '子', 5, { parentId: solo }); // 未开始的独立任务可加子项
  assert.equal(e.isParent(e.task(solo)), true);
});

test('同级拖动只改后续顺序，不能跨级', () => {
  const { e } = make();
  const a = add(e, 'A'); const b = add(e, 'B'); const c = add(e, 'C');
  const l = e.addTask({ title: 'L', minutes: 5, categoryId: 'life' });
  e.start();
  assert.throws(() => e.moveTask({ id: a, targetId: c, place: 'after' }), /当前任务/);
  e.moveTask({ id: c, targetId: b, place: 'before' });
  assert.deepEqual(e.queue().map((t) => t.id), [a, c, b, l]);
  assert.throws(() => e.moveTask({ id: c, targetId: l }), /同级/);
  assert.equal(e.s.session.taskId, a);
});

test('删除：清除任务与想法，历史计时、完成数、积分保留；影响当前执行则加载下一项', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 1);
  const b = add(e, 'B', 25);
  const c = add(e, 'C', 25);
  e.start();
  e.openThought(); e.submitThought({ text: '机密想法' });
  x.run(MIN);
  assert.equal(e.s.session.phase, 'review');
  e.deleteTask({ id: a }); // 删除回顾对象 → 清除后加载下一项
  assert.equal(e.s.thoughts.length, 0);
  assert.equal(e.task(a), undefined);
  assert.equal(e.s.session.phase, 'ready');
  assert.equal(e.s.session.taskId, b);
  assert.equal(e.balance(), C.TASK_REWARD);
  assert.equal(e.s.completions.length, 1);
  const st = stats(e.s, 'day', T0);
  assert.equal(st.total.runMs, MIN);
  assert.equal(st.total.done, 1);
  assert.equal(st.total.thoughts, 0); // 想法统计只含仍保留的记录
  assert.ok(x.events.some((v) => v.name === 'review_ended_by_delete'));

  e.start(); x.run(5 * MIN);
  e.deleteTask({ id: b }); // 删除当前执行
  assert.equal(e.clockRunning(), false);
  assert.equal(e.s.session.phase, 'ready');
  assert.equal(e.s.session.taskId, c);
  assert.equal(stats(e.s, 'day', T0).total.runMs, 6 * MIN);

  // 父级删除覆盖整个子树
  const p = add(e, '父', 10);
  add(e, 'k1', 5, { parentId: p }); add(e, 'k2', 5, { parentId: p });
  e.deleteTask({ id: p });
  assert.equal(e.s.tasks.length, 1);
});

test('日历：运行时间跨本地午夜拆分，完成只计在到点当天', () => {
  const x = make(new Date(2026, 10, 10, 23, 50, 0).getTime());
  const { e } = x;
  add(e, '跨夜', 30);
  e.start();
  x.run(30 * MIN);
  const wk = stats(e.s, 'week', x.now);
  const d10 = wk.days.find((d) => d.key === '2026-11-10');
  const d11 = wk.days.find((d) => d.key === '2026-11-11');
  assert.equal(d10.runMs, 10 * MIN);
  assert.equal(d11.runMs, 20 * MIN);
  assert.equal(d10.done, 0);
  assert.equal(d11.done, 1);
  assert.equal(wk.days.length, 7);
  assert.equal(wk.days[0].key, '2026-11-09'); // 周一
  assert.equal(stats(e.s, 'month', x.now).days.length, 30);
});

test('异常退出恢复到最后保存点；正常退出/锁屏暂停后手动继续', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 25);
  e.start();
  x.run(10 * MIN);
  const saved = JSON.parse(JSON.stringify(e.s)); // 最后一次心跳保存
  const savedAt = x.now;
  // 崩溃后过了一小时才重启
  const e2 = new Engine(saved, { now: () => savedAt + 60 * MIN });
  assert.equal(e2.recoverOnBoot(), true);
  assert.equal(e2.task(a).remainingMs, 15 * MIN);
  assert.equal(e2.clockRunning(), false);
  assert.deepEqual(e2.s.session.notice, { type: 'recovered', at: savedAt });
  assert.equal(e2.s.segments[0].end, savedAt);
  e2.resume();
  assert.equal(e2.clockRunning(), true);

  // 锁屏：暂停，回来手动继续
  x.run(MIN);
  e.systemPause('lock');
  x.adv(30 * MIN);
  assert.equal(e.task(a).remainingMs, 14 * MIN);
  assert.equal(e.clockRunning(), false);
  // 正常退出后重启不提示恢复
  e.resume(); e.systemPause('quit');
  const e3 = new Engine(JSON.parse(JSON.stringify(e.s)), { now: () => x.now });
  assert.equal(e3.recoverOnBoot(), false);
});

test('进程挂起造成的 tick 空档不补算', () => {
  const x = make();
  const { e } = x;
  const a = add(e, 'A', 25);
  e.start();
  x.run(5 * MIN);
  x.adv(40 * MIN); // 睡眠事件没收到
  assert.equal(e.task(a).state, 'todo');
  assert.equal(e.task(a).remainingMs, 20 * MIN);
  assert.equal(e.s.session.notice.type, 'gap');
});

test('保存失败时暂停，恢复后由用户继续', () => {
  const x = make();
  const { e } = x;
  add(e, 'A', 25);
  e.start();
  e.saveFailed();
  assert.equal(e.clockRunning(), false);
  assert.throws(() => e.resume(), /保存/);
  e.saveRecovered();
  assert.equal(e.clockRunning(), false);
  e.resume();
  assert.equal(e.clockRunning(), true);
});

test('想法转待办：建出任务，回顾中自动勾上，不能重复转', () => {
  const x = make();
  const { e } = x;
  add(e, 'A', 1);
  e.start();
  e.openThought(); const t1 = e.submitThought({ text: '订  会议室\n周四' });
  e.openThought(); const t2 = e.submitThought({ text: '另一条' });
  x.run(MIN);
  assert.equal(e.s.session.phase, 'review');
  const tid = e.thoughtToTask({ id: t1, minutes: 15, categoryId: 'life' });
  assert.equal(e.task(tid).title, '订 会议室 周四');
  assert.equal(e.task(tid).categoryId, 'life');
  assert.equal(e.s.thoughts[0].reviewed, true);
  assert.equal(e.s.session.phase, 'review');
  assert.throws(() => e.thoughtToTask({ id: t1, minutes: 15 }), /已经转成/);
  e.checkThought({ id: t2 });
  assert.equal(e.s.session.phase, 'ready');
  assert.equal(e.s.session.taskId, tid); // 新待办进入队列
  // 回顾之外也能转，默认沿用来源任务的分类
  const tid2 = e.thoughtToTask({ id: t2, minutes: 25 });
  assert.equal(e.task(tid2).categoryId, 'work');
});

test('连续天数：按有计时完成的本地日计算', () => {
  const x = make();
  const { e } = x;
  assert.equal(e.streak(), 0);
  for (let d = 0; d < 3; d++) {
    add(e, `T${d}`, 1); e.start(); x.run(MIN);
    assert.equal(e.streak(), d + 1);
    x.adv(24 * 3600e3); e.tick();
  }
  assert.equal(e.streak(), 3); // 今天还没完成，从昨天算起
  x.adv(24 * 3600e3);
  assert.equal(e.streak(), 0); // 断了一天
});

test('一行录入解析时长', () => {
  const { parseQuick } = require('../src/renderer/parse');
  assert.deepEqual(parseQuick('写周报 25分'), { title: '写周报', minutes: 25 });
  assert.deepEqual(parseQuick('写周报25分钟'), { title: '写周报', minutes: 25 });
  assert.deepEqual(parseQuick('读论文 1h30'), { title: '读论文', minutes: 90 });
  assert.deepEqual(parseQuick('备课 1.5小时'), { title: '备课', minutes: 90 });
  assert.deepEqual(parseQuick('review PR 45m'), { title: 'review PR', minutes: 45 });
  assert.deepEqual(parseQuick('散步半小时'), { title: '散步', minutes: 30 });
  assert.deepEqual(parseQuick('开会 2小时15分'), { title: '开会', minutes: 135 });
  assert.equal(parseQuick('写周报'), null);
  assert.equal(parseQuick('买 2 瓶水'), null);
  assert.equal(parseQuick('abc25m'), null); // 英文单词里的数字不算
  assert.equal(parseQuick('25分'), null); // 没有标题
  assert.equal(parseQuick('长跑 3000分'), null); // 超过 1440
  assert.equal(parseQuick('复习 3 小时的课'), null);
});

test('猫：每个本地日发一次基础积分，喂食扣分，久未喂养外出打猎', () => {
  const x = make();
  const { e } = x;
  assert.equal(e.claimDaily(), true);
  assert.equal(e.claimDaily(), false);
  assert.equal(e.balance(), C.DAILY_REWARD);
  assert.equal(e.catStatus(), 'full');
  x.adv(49 * 3600e3);
  assert.equal(e.catStatus(), 'hunting');
  assert.equal(e.claimDaily(), true);
  e.feedCat(); e.feedCat();
  assert.equal(e.balance(), 0);
  assert.equal(e.catStatus(), 'full');
  assert.throws(() => e.feedCat(), /积分不够/);
});
