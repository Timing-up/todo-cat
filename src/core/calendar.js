'use strict';
// 日历统计：实际运行时间跨本地午夜拆分，完成只计在到点当天，想法仅统计仍保留的记录。
const { dayKey } = require('./engine');

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** 返回 [from, to) 的本地日范围。周从周一开始。 */
function rangeFor(view, anchor) {
  const day = startOfDay(anchor);
  if (view === 'day') return { from: day, to: addDays(day, 1) };
  if (view === 'week') {
    const dow = (new Date(day).getDay() + 6) % 7;
    const from = addDays(day, -dow);
    return { from, to: addDays(from, 7) };
  }
  const d = new Date(day);
  d.setDate(1);
  const from = d.getTime();
  const e = new Date(from);
  e.setMonth(e.getMonth() + 1);
  return { from, to: e.getTime() };
}

/** 把一段运行时间按本地日（和小时）切开后回调。 */
function eachSlice(start, end, cb) {
  let cur = start;
  while (cur < end) {
    const d = new Date(cur);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    const next = Math.min(end, d.getTime());
    cb(cur, next);
    cur = next;
  }
}

function stats(state, view, anchor) {
  const { from, to } = rangeFor(view, anchor);
  const days = [];
  const idx = new Map();
  for (let t = from; t < to; t = addDays(t, 1)) {
    const o = { key: dayKey(t), ts: t, runMs: 0, done: 0, thoughts: 0 };
    idx.set(o.key, o);
    days.push(o);
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, runMs: 0, thoughts: 0 }));
  for (const s of state.segments) {
    if (s.end <= from || s.start >= to) continue;
    eachSlice(Math.max(s.start, from), Math.min(s.end, to), (a, b) => {
      const d = idx.get(dayKey(a));
      if (d) d.runMs += b - a;
      hours[new Date(a).getHours()].runMs += b - a;
    });
  }
  for (const c of state.completions) {
    const d = c.at >= from && c.at < to && idx.get(dayKey(c.at));
    if (d) d.done += 1;
  }
  for (const th of state.thoughts) {
    const d = th.at >= from && th.at < to && idx.get(dayKey(th.at));
    if (d) { d.thoughts += 1; hours[new Date(th.at).getHours()].thoughts += 1; }
  }
  const total = days.reduce((a, d) => ({ runMs: a.runMs + d.runMs, done: a.done + d.done, thoughts: a.thoughts + d.thoughts }), { runMs: 0, done: 0, thoughts: 0 });
  return { view, from, to, days, hours, total };
}

module.exports = { stats, rangeFor, startOfDay, addDays };
