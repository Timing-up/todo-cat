'use strict';
process.env.TZ = 'Asia/Shanghai';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, C } = require('../src/core/engine');
const { Store } = require('../src/main/store');

const MIN = 60000;
function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todocat-')), 'todocat.db');
}
function clock(start = new Date(2026, 10, 10, 9).getTime()) {
  let now = start;
  return { now: () => now, run(e, ms) { for (let l = ms; l > 0; l -= 1000) { now += 1000; e.tick(); } }, adv(ms) { now += ms; } };
}

test('保存后重新打开，状态完整还原', () => {
  const file = tmpDb();
  const ck = clock();
  const s1 = new Store(file);
  assert.equal(s1.load(), null);
  const e = new Engine(null, { now: ck.now });
  const p = e.addTask({ title: '父', minutes: 30, categoryId: 'study' });
  e.addTask({ title: '子', minutes: 1, categoryId: 'study', parentId: p });
  e.addTask({ title: '另一件', minutes: 25, categoryId: 'work' });
  e.start();
  e.openThought(); e.submitThought({ text: '想法 ✅' });
  ck.run(e, 20000);
  e.pause();
  s1.save(e.s);
  s1.close();

  const s2 = new Store(file);
  const loaded = s2.load();
  assert.deepEqual(loaded.tasks.sort((a, b) => a.id.localeCompare(b.id)), [...e.s.tasks].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(loaded.thoughts, e.s.thoughts);
  assert.deepEqual(loaded.segments, e.s.segments);
  assert.deepEqual(loaded.session, e.s.session);
  assert.equal(loaded.meta.installId, e.s.meta.installId);
  s2.close();
});

test('完成记录与发奖同事务落盘；保存失败回滚，重试不重发', () => {
  const file = tmpDb();
  const ck = clock();
  const store = new Store(file);
  const e = new Engine(null, { now: ck.now });
  e.addTask({ title: 'A', minutes: 1, categoryId: 'work' });
  store.save(e.s);
  e.start();
  ck.run(e, MIN);
  assert.equal(e.s.completions.length, 1);

  store.failNext = true;
  assert.throws(() => store.save(e.s));
  const n = (t) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.equal(n('completions'), 0); // 两者都没写入
  assert.equal(n('ledger'), 0);

  store.failNext = false;
  store.save(e.s);
  store.save(e.s); // 重试/重复保存
  assert.equal(n('completions'), 1);
  assert.equal(n('ledger'), 1);
  store.close();

  const s2 = new Store(file);
  const e2 = new Engine(s2.load(), { now: ck.now });
  assert.equal(e2.balance(), C.TASK_REWARD);
  assert.equal(e2.s.tasks[0].state, 'completed');
  s2.close();
});

test('已确认删除的内容不会因恢复再次出现；历史计时保留', () => {
  const file = tmpDb();
  const ck = clock();
  const store = new Store(file);
  const e = new Engine(null, { now: ck.now });
  const a = e.addTask({ title: '要删的', minutes: 25, categoryId: 'work' });
  e.start();
  e.openThought(); e.submitThought({ text: '要删的想法' });
  ck.run(e, 5 * MIN);
  store.save(e.s);
  e.deleteTask({ id: a });
  store.save(e.s);
  // 不走正常退出，直接重开
  const s2 = new Store(file);
  const st = s2.load();
  assert.equal(st.tasks.length, 0);
  assert.equal(st.thoughts.length, 0);
  assert.equal(st.segments.reduce((x, g) => x + g.end - g.start, 0), 5 * MIN);
  const dump = JSON.stringify([s2.db.prepare('SELECT * FROM tasks').all(), s2.db.prepare('SELECT * FROM thoughts').all(), s2.db.prepare('SELECT * FROM kv').all()]);
  assert.ok(!dump.includes('要删的'));
  s2.close(); store.close();
});

test('心跳保存 + 异常退出：恢复到最后保存点', () => {
  const file = tmpDb();
  const ck = clock();
  const store = new Store(file);
  const e = new Engine(null, { now: ck.now });
  const a = e.addTask({ title: 'A', minutes: 25, categoryId: 'work' });
  e.start();
  store.save(e.s);
  ck.run(e, 10 * MIN);
  store.save(e.s, { light: true }); // 心跳
  ck.run(e, 7000); // 心跳之后又跑了 7 秒，然后崩溃
  ck.adv(3600e3);
  const s2 = new Store(file);
  const e2 = new Engine(s2.load(), { now: ck.now });
  assert.equal(e2.recoverOnBoot(), true);
  assert.equal(e2.task(a).remainingMs, 15 * MIN);
  assert.equal(e2.s.session.notice.type, 'recovered');
  s2.close(); store.close();
});

test('上报队列：按事件 ID 去重，可清空', () => {
  const store = new Store(tmpDb());
  store.enqueueEvent('e1', { name: 'app_open' }, 1);
  store.enqueueEvent('e1', { name: 'app_open' }, 1);
  store.enqueueEvent('e2', { name: 'timer_started' }, 2);
  assert.equal(store.countEvents(), 2);
  store.deleteEvents(['e1']);
  assert.deepEqual(store.listEvents().map((x) => x.id), ['e2']);
  store.clearEvents();
  assert.equal(store.countEvents(), 0);
  store.close();
});
