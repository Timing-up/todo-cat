'use strict';
/* global api, catSvg, parseQuick */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

let S = null;
let offset = 0;
const ui = {
  tab: 'todo', cat: 'work', closed: {}, openTh: {}, ctx: null, editId: null, confirmId: null,
  more: 'calendar', calView: 'week', calAnchor: null, cal: null,
  inboxQ: '', convId: null, flashId: null, lastFinAt: undefined,
};
const RING = 2 * Math.PI * 108;
const TABS = ['focus', 'todo', 'pending', 'completed', 'cancelled', 'more'];
if (new URLSearchParams(location.search).get('solid')) document.body.classList.add('solid');

// ---------- 工具 ----------
const now = () => Date.now() + offset;
const taskOf = (id) => S.tasks.find((t) => t.id === id);
const kidsOf = (id) => S.tasks.filter((t) => t.parentId === id).sort((a, b) => a.order - b.order);
const thoughtsOf = (id) => S.thoughts.filter((x) => x.taskId === id);
const catName = (id) => (S.categories.find((c) => c.id === id) || {}).name || '';
function fmtMin(m) {
  m = Math.round(m);
  if (m < 60) return `${m} 分`;
  return m % 60 ? `${Math.floor(m / 60)} 时 ${m % 60} 分` : `${m / 60} 小时`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function fmtRun(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}<small>分</small>` : `${Math.floor(m / 60)}<small>时</small>${m % 60}<small>分</small>`;
}
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const md = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; };
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function remaining(t) {
  if (S.clockRunning && S.session.taskId === t.id) return Math.max(0, t.remainingMs - (now() - S.session.runningSince));
  return t.remainingMs;
}
function setHTML(el, html) {
  const a = document.activeElement;
  if (a && el.contains(a) && /INPUT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox') { el.dataset.stale = '1'; return; } // 正在输入时不打断
  delete el.dataset.stale;
  el.innerHTML = html;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function cmd(name, args) {
  const r = await api.cmd(name, args);
  if (!r.ok) toast(r.error);
  return r;
}

// ---------- 任务行 ----------
function actsFor(t) {
  const a = [];
  const ss = S.session;
  const busy = ss.phase === 'running' || ss.phase === 'review';
  const isCur = ss.phase === 'running' && ss.taskId === t.id;
  if (t.isParent) {
    if (t.status === 'todo' || t.status === 'pending') a.push(['child', '子项']);
    a.push(['edit', '改']);
    if (t.status === 'todo' || t.status === 'pending') a.push(['cancel', '取消']);
  } else if (t.state === 'todo') {
    if (!busy && S.nextId === t.id) a.push(['start', '开始', 'go']);
    if (!t.parentId && !t.started) a.push(['child', '子项']);
    if (t.parentId && !t.started) a.push(['split', '拆分']);
    a.push(['edit', '改']);
    if (!isCur) a.push(['push', '推出']);
    a.push(['cancel', '取消']);
  } else if (t.state === 'pending') {
    a.push(['return', '送回 to-do', 'go'], ['edit', '改'], ['cancel', '取消']);
  }
  a.push(['del', '删', 'del']);
  return a.map(([act, label, cls]) => `<button data-act="${act}" class="${cls || ''}">${label}</button>`).join('');
}

function taskRow(t, { child = false, draggable = false } = {}) {
  const ss = S.session;
  const isCur = ss.phase === 'running' && ss.taskId === t.id;
  const isHead = !isCur && ss.phase !== 'review' && S.nextId === t.id && t.state === 'todo';
  const th = thoughtsOf(t.id);
  const cls = ['task'];
  if (child) cls.push('child');
  if (isCur) cls.push('cur'); else if (isHead) cls.push('head');
  const st = t.isParent ? t.status : t.state;
  if (st === 'completed') cls.push('done');
  if (st === 'cancelled') cls.push('dim');
  if (ui.flashId === t.id) cls.push('flash');
  let html = '';

  if (ui.editId === t.id) {
    const locked = t.isParent || t.started || (t.state !== 'todo' && t.state !== 'pending');
    html += `<div class="edit ${child ? 'child' : ''}" data-id="${t.id}">
      <input data-f="title" maxlength="200" value="${esc(t.title)}">
      ${locked ? `<span class="lock">${t.isParent ? '时长汇总自子项' : '时长已锁定'}</span>` : `<input data-f="min" inputmode="numeric" maxlength="4" value="${t.plannedMin}"><span class="lock">分钟</span>`}
      <button class="btn primary" data-act="save">保存</button><button class="btn ghost" data-act="unedit">取消</button></div>`;
  } else {
    let right = '';
    let sub = '';
    if (t.isParent) {
      const p = t.progress;
      sub = `<div class="t-sub"><div class="prog"><i style="width:${Math.round(p.ratio * 100)}%"></i></div><span>${p.doneCount}/${p.validCount} · ${fmtMin(p.doneMin)} / ${fmtMin(p.totalMin)}</span></div>`;
    } else if (st === 'todo') {
      const part = t.started && t.remainingMs < t.plannedMin * 60000;
      right = isCur ? `<span class="t-dur" data-timer="${t.id}">${fmtClock(remaining(t))}</span>`
        : `<span class="t-dur">${part ? `剩 ${fmtClock(t.remainingMs)}` : fmtMin(t.plannedMin)}</span>`;
    } else if (st === 'pending') {
      right = `<span class="t-dur">${t.started ? `剩 ${fmtClock(t.remainingMs)}` : fmtMin(t.plannedMin)}</span>`;
    } else if (st === 'completed') {
      right = `<span class="t-dur">${fmtMin(t.plannedMin)} · ${hm(t.completedAt)}</span>`;
    } else right = `<span class="t-dur">${fmtMin(t.plannedMin)}</span>`;
    const tags = [];
    if (isCur) tags.push(`<span class="tag ok">${S.clockRunning ? '执行中' : '已暂停'}</span>`);
    else if (isHead) tags.push('<span class="tag go">队首</span>');
    if (child && st === 'pending') tags.push('<span class="tag">pending</span>');
    if (child && st === 'cancelled') tags.push('<span class="tag">已取消</span>');
    if (th.length) tags.push(`<button class="tag" data-act="thoughts">想法 ${th.length}</button>`);
    html += `<div class="${cls.join(' ')}" data-id="${t.id}" data-grp="${t.parentId || `c:${t.categoryId}`}" ${draggable ? 'draggable="true"' : ''}>
      <div class="t-main"><div class="t-title" title="${esc(t.title)}">${esc(t.title)}</div>${sub}</div>
      ${tags.join('')}${right}<div class="acts">${actsFor(t)}</div></div>`;
  }
  if (ui.confirmId === t.id) {
    html += `<div class="confirm ${child ? 'child' : ''}" data-id="${t.id}">
      删除后，${t.isParent ? '这项任务和它的全部子项' : '这项任务'}连同想法都会清除，不能恢复；历史计时、完成数和已得积分保留。
      <div class="row-btns"><button class="btn ghost" data-act="undel">先不删</button><button class="btn danger" data-act="del-yes">确认删除</button></div></div>`;
  }
  if (ui.openTh[t.id] && th.length) {
    html += `<div class="th-hist">${th.map((x) => `<div><time>${md(x.at)} ${hm(x.at)}</time>${esc(x.text)}${x.reviewed ? ' ✓' : ''}</div>`).join('')}</div>`;
  }
  return html;
}

function parentBlock(t, { draggable = false, hideOldDone = false } = {}) {
  let html = taskRow(t, { draggable });
  for (const k of kidsOf(t.id)) {
    if (hideOldDone && k.state === 'completed' && dayKey(k.completedAt) !== S.today) continue; // 次日清出 to-do 视图
    html += taskRow(k, { child: true, draggable: draggable && k.state === 'todo' });
  }
  return html;
}
const block = (t, o) => (t.isParent ? parentBlock(t, o) : taskRow(t, o));

// ---------- 各页 ----------
function convHTML(th) {
  const made = th.taskCreatedId && taskOf(th.taskCreatedId);
  if (made) return '<span class="tag ok">已转待办</span>';
  if (ui.convId === th.id) return `<span class="conv">${[15, 25, 45, 60].map((m) => `<button data-conv-min="${m}">${m}分</button>`).join('')}<button data-act="conv-x">✕</button></span>`;
  return '<button class="tag" data-act="conv" title="把这条想法变成一条计时待办">转待办</button>';
}

function renderStrip() {
  const ts = S.todayStats || { runMs: 0, done: 0 };
  const parts = [`今天专注 <b>${Math.round(ts.runMs / 60000)}</b> 分`, `完成 <b>${ts.done}</b> 项`];
  if (S.streak > 1) parts.push(`连续 <b>${S.streak}</b> 天`);
  let eta = '';
  if (S.queue.length) eta = `<span class="eta">队列 ${fmtMin(Math.ceil(S.queueMs / 60000))} · 现在开始约 ${hm(now() + S.queueMs)} 做完</span>`;
  $('#today-strip').innerHTML = `<span>${parts.join(' · ')}</span>${eta}`;
  $('#onboard').innerHTML = S.settings.onboarded ? '' : `<div class="onb"><b>三步上手</b>
    <ol><li>记下标题，末尾写上时长直接回车，例如「写周报 25分」。</li><li>点队首任务的「开始」，一次只计时做一件事。</li><li>分心时点「记想法」，到点后再集中回顾。</li></ol>
    <div class="row-btns"><span class="hint">随时按 ${S.env.keys.add} 唤出，${S.env.keys.thought} 记想法</span><button class="btn primary" data-act="onboarded">知道了</button></div></div>`;
}

function renderTodo() {
  renderStrip();
  setHTML($('#cats'), S.categories.map((c) => `<button data-cat="${c.id}" class="${ui.cat === c.id ? 'on' : ''}">${c.name}</button>`).join(''));
  const ctx = $('#add-ctx');
  if (ui.ctx && !taskOf(ui.ctx.id)) ui.ctx = null;
  if (ui.ctx) {
    const t = taskOf(ui.ctx.id);
    ctx.hidden = false;
    ctx.innerHTML = `${ui.ctx.type === 'child' ? '添加子项到' : '拆分，新子项排在其后：'}「${esc(t.title)}」<button type="button" data-act="ctx-clear">✕ 改回普通任务</button>`;
  } else ctx.hidden = true;
  $('#add-title').placeholder = ui.ctx ? '子项标题，可直接写「标题 25分」' : `记一件事（${catName(ui.cat)}），如「写周报 25分」`;

  let html = '';
  let any = false;
  for (const c of S.categories) {
    const tops = S.tasks.filter((t) => !t.parentId && t.categoryId === c.id && t.status === 'todo').sort((a, b) => a.order - b.order);
    if (!tops.length) continue;
    any = true;
    const closed = !!ui.closed[c.id];
    const n = S.queue.filter((id) => taskOf(id).categoryId === c.id).length;
    html += `<div class="grp"><button class="grp-h ${closed ? 'closed' : ''}" data-fold="${c.id}"><span class="caret">▾</span>${c.name}<span class="cnt">${n} 项可执行</span></button>`;
    if (!closed) html += tops.map((t) => block(t, { draggable: true, hideOldDone: true })).join('');
    html += '</div>';
  }
  if (!any) html += `<div class="empty">${catSvg('full', 96)}<br>还没有待办。<br>在上面记下标题，再选一个时长。</div>`;
  // 当天完成的任务在底部划线展示，次日清出
  const doneToday = S.tasks.filter((t) => !t.parentId && t.status === 'completed' && t.completedAt && dayKey(t.completedAt) === S.today)
    .sort((a, b) => a.completedAt - b.completedAt);
  if (doneToday.length) html += `<div class="sep">今天完成</div>${doneToday.map((t) => block(t)).join('')}`;
  setHTML($('#todo-list'), html);
}

function renderStatus(status, el, emptyText) {
  const list = S.tasks.filter((t) => !t.parentId && t.status === status);
  if (status === 'completed') list.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  else if (status === 'cancelled') list.sort((a, b) => (b.cancelledAt || 0) - (a.cancelledAt || 0));
  let html = '';
  if (!list.length) html = `<div class="empty">${emptyText}</div>`;
  else if (status === 'completed') {
    let last = '';
    for (const t of list) {
      const k = dayKey(t.completedAt);
      if (k !== last) { html += `<div class="sep">${k === S.today ? '今天' : md(t.completedAt)}</div>`; last = k; }
      html += block(t);
    }
  } else html = list.map((t) => block(t)).join('');
  if (status === 'pending' && list.length) html = `<div class="hint">推出的任务在这里等待。回顾完想法后，可以送回 to-do 原位置继续。</div>${html}`;
  setHTML(el, html);
}

function renderFocus() {
  const ss = S.session;
  const body = $('#focus-body');
  const box = $('#thought-box');
  const list = $('#focus-thoughts');
  const fin = ss.lastFinished;
  const finHtml = !fin ? '' : fin.reason === 'timeup'
    ? `<div class="fin"><b>计时完成</b> · ${esc(fin.title)}<div class="hint">这段计时结束了。事情还没做完？<button class="link" data-act="again">另建一条计时待办</button></div></div>`
    : `<div class="fin push"><b>${fin.reason === 'pushout' ? '已推出到 pending' : '已取消'}</b> · ${esc(fin.title)}</div>`;
  let html = '';
  let listHtml = '';
  let showBox = false;

  if (ss.phase === 'running') {
    const t = taskOf(ss.taskId);
    const parent = t.parentId && taskOf(t.parentId);
    const writing = ss.thoughtOpenAt != null;
    showBox = writing;
    const state = S.saveError ? '保存失败，计时已暂停' : writing ? '记想法中，计时已暂停' : ss.paused ? '已暂停，点「继续」接着计时' : '计时中';
    html = `<div class="paper">
      <div class="p-cat">${catName(t.categoryId)}${parent ? ` · ${esc(parent.title)}` : ''} · 计划 ${fmtMin(t.plannedMin)}</div>
      <h1>${esc(t.title)}</h1>
      <div class="ring-wrap ${S.clockRunning ? '' : 'paused'}">
        <svg class="ring" viewBox="0 0 240 240"><circle class="bg" cx="120" cy="120" r="108"/><circle class="fg" id="ring-fg" cx="120" cy="120" r="108" stroke-dasharray="${RING}" stroke-dashoffset="${RING * (1 - Math.min(1, remaining(t) / (t.plannedMin * 60000)))}"/></svg>
        <div class="ring-in"><div class="clock ${S.clockRunning ? '' : 'paused'}" data-timer="${t.id}">${fmtClock(remaining(t))}</div>
        <div class="p-state">${state}</div></div></div>
      <div class="p-btns">
        ${ss.paused ? '<button class="btn big primary" data-act="resume">继续</button>' : `<button class="btn big" data-act="pause" ${writing ? 'disabled' : ''}>暂停计时</button>`}
        ${writing ? '' : '<button class="btn big" data-act="thought">记想法 <kbd>T</kbd></button>'}
        <button class="btn big ghost" data-act="pushout">推出</button>
      </div></div>`;
    const th = thoughtsOf(t.id).filter((x) => !x.reviewed);
    if (th.length) listHtml = `<div class="th-h">已记下的想法（结束后回顾）</div>${th.map((x) => `<div class="th"><div class="tx">${esc(x.text)}</div><time>${hm(x.at)}</time></div>`).join('')}`;
  } else if (ss.phase === 'review') {
    const items = ss.review.thoughtIds.map((id) => S.thoughts.find((x) => x.id === id)).filter(Boolean);
    const left = items.filter((x) => !x.reviewed).length;
    html = `${finHtml}<div class="review-h">回顾这些想法：认真想过或已经处理，就勾上。全部勾完后加载下一项（还剩 ${left} 条）。</div>`;
    listHtml = items.map((x) => `<div class="th ${x.reviewed ? 'ck' : ''}" data-thid="${x.id}"><label><input type="checkbox" data-th="${x.id}" ${x.reviewed ? 'checked' : ''}><div class="tx">${esc(x.text)}</div></label>${convHTML(x)}<time>${hm(x.at)}</time></div>`).join('');
  } else {
    const next = S.nextId && taskOf(S.nextId);
    html = finHtml;
    if (next) {
      const part = next.started && next.remainingMs < next.plannedMin * 60000;
      html += `<div class="next"><div class="lbl">${ss.phase === 'ready' ? '下一项' : '队首任务'} · ${catName(next.categoryId)}</div>
        <div class="ttl">${esc(next.title)}</div>
        <div class="hint">${part ? `继续，剩 ${fmtClock(next.remainingMs)}` : fmtMin(next.plannedMin)}</div>
        <div class="p-btns"><button class="btn big primary" data-act="start">开始</button><button class="btn big ghost" data-act="pushout-next">推出</button></div></div>`;
    } else {
      html += `<div class="empty">${catSvg(S.cat.status === 'hunting' ? 'hungry' : S.cat.status, 96)}<br>白纸一张。${fin ? '队列已经清空。' : ''}<br><br><button class="btn" data-act="goto-todo">去 to-do 记一件事</button></div>`;
    }
  }
  setHTML(body, html);
  box.hidden = !showBox;
  if (showBox && document.activeElement !== $('#thought-text')) $('#thought-text').focus();
  setHTML(list, listHtml);
}

function renderExecbar() {
  const bar = $('#execbar');
  const ss = S.session;
  if (ui.tab === 'focus' || ss.phase === 'idle') { bar.hidden = true; return; }
  bar.hidden = false;
  if (ss.phase === 'running') {
    const t = taskOf(ss.taskId);
    bar.innerHTML = `<span>${S.clockRunning ? '▶' : '❚❚'}</span><span class="ttl">${esc(t.title)}</span><span class="tm" data-timer="${t.id}">${fmtClock(remaining(t))}</span>`;
  } else if (ss.phase === 'review') {
    const left = ss.review.thoughtIds.filter((id) => { const x = S.thoughts.find((y) => y.id === id); return x && !x.reviewed; }).length;
    bar.innerHTML = `<span>✎</span><span class="ttl">回顾想法</span><span class="tm">还剩 ${left} 条</span>`;
  } else {
    const t = taskOf(ss.taskId);
    bar.innerHTML = `<span>→</span><span class="ttl">下一项：${esc(t ? t.title : '')}</span><span class="tm">待开始</span>`;
  }
}

function renderBanner() {
  const out = [];
  if (S.saveError) out.push('<div class="bn err"><span><b>保存失败</b>，计时已暂停，正在自动重试。恢复后请手动继续；这段时间不会补算。</span></div>');
  const n = S.session.notice;
  if (n) {
    const text = n.type === 'recovered'
      ? `上次没有正常退出，已恢复到 ${md(n.at)} ${hm(n.at)} 的保存点。之后的时段可能未记录，未提交的想法草稿可能已丢失。`
      : n.type === 'gap' ? `电脑在 ${hm(n.at)} 之后有一段时间不可用，计时已暂停，那段时间没有计入。`
        : '锁屏或睡眠期间计时已暂停，回到任务后点「继续」。';
    out.push(`<div class="bn"><span>${text}</span><button data-act="dismiss">知道了</button></div>`);
  }
  $('#banner').innerHTML = out.join('');
}

// ---------- 更多：日历 / 小猫 / 设置 ----------
async function loadCal() {
  ui.cal = await api.calendar(ui.calView, ui.calAnchor || now());
  if (ui.tab === 'more' && ui.more === 'calendar') renderMore();
}
function calTitle(c) {
  const a = new Date(c.from);
  if (c.view === 'day') return `${a.getFullYear()}年${md(c.from)} 周${'日一二三四五六'[a.getDay()]}`;
  if (c.view === 'week') return `${md(c.from)} – ${md(c.to - 1)}`;
  return `${a.getFullYear()}年${a.getMonth() + 1}月`;
}
function calendarHTML() {
  const c = ui.cal;
  if (!c || c.view !== ui.calView) return '<div class="empty">加载中…</div>';
  const nav = `<div class="cal-nav">
    <div class="seg">${[['day', '日'], ['week', '周'], ['month', '月']].map(([v, l]) => `<button data-view="${v}" class="${ui.calView === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <button class="ar" data-nav="-1">‹</button><div class="ttl">${calTitle(c)}</div><button class="ar" data-nav="1">›</button>
    <button class="btn" data-nav="0">今天</button></div>`;
  const stat = `<div class="stats">
    <div class="stat"><div class="v">${fmtRun(c.total.runMs)}</div><div class="k">实际运行时间</div></div>
    <div class="stat"><div class="v">${c.total.done}<small>项</small></div><div class="k">计时完成</div></div>
    <div class="stat"><div class="v">${c.total.thoughts}<small>条</small></div><div class="k">记下的想法</div></div></div>`;
  let body = '';
  if (c.view === 'day') {
    const max = Math.max(1, ...c.hours.map((h) => h.runMs));
    body = `<div class="chart"><h4>各小时运行分钟 · 蓝点为记下想法的时段</h4><div class="bars">${c.hours.map((h) => `<div class="b" title="${h.h}:00 · ${Math.round(h.runMs / 60000)} 分 · 想法 ${h.thoughts}"><i style="height:${Math.round((h.runMs / max) * 100)}%"></i>${h.thoughts ? '<u></u>' : ''}</div>`).join('')}</div>
      <div class="axis">${c.hours.map((h) => `<span>${h.h % 6 === 0 ? h.h : ''}</span>`).join('')}</div></div>`;
  } else if (c.view === 'week') {
    const max = Math.max(1, ...c.days.map((d) => d.runMs));
    body = `<div class="chart"><h4>每天运行分钟 · 下方为完成数</h4><div class="bars">${c.days.map((d) => `<div class="b ${d.key === S.today ? 'today' : ''}" data-day="${d.ts}"><em>${d.runMs ? Math.round(d.runMs / 60000) : ''}</em><i style="height:${Math.round((d.runMs / max) * 78)}%"></i></div>`).join('')}</div>
      <div class="axis">${c.days.map((d, i) => `<span class="${d.key === S.today ? 'today' : ''}">周${'一二三四五六日'[i]}<br>${d.done ? `✓${d.done}` : '·'}</span>`).join('')}</div></div>`;
  } else {
    const lead = (new Date(c.from).getDay() + 6) % 7;
    body = `<div class="month">${'一二三四五六日'.split('').map((w) => `<div class="wd">${w}</div>`).join('')}${'<div></div>'.repeat(lead)}${c.days.map((d) => `<button class="d ${d.key === S.today ? 'today' : ''}" data-day="${d.ts}" title="${d.key}"><b>${new Date(d.ts).getDate()}</b>${d.runMs ? `<span>${Math.round(d.runMs / 60000)}分</span>` : ''}${d.done ? `<span class="ok">✓${d.done}</span>` : ''}</button>`).join('')}</div>`;
  }
  return `${nav}${stat}${body}<div class="legend">运行时间按本地午夜拆分到各天；完成只计在到点当天；想法只统计仍保留的记录。</div>`;
}

function inboxListHTML() {
  const q = ui.inboxQ.trim().toLowerCase();
  const list = S.thoughts.filter((x) => !q || x.text.toLowerCase().includes(q)).sort((a, b) => b.at - a.at);
  if (!list.length) return `<div class="empty">${q ? '没有匹配的想法。' : '执行时记下的想法都会留在这里，随时可查。'}</div>`;
  let html = '';
  let last = '';
  for (const x of list) {
    const k = dayKey(x.at);
    if (k !== last) { html += `<div class="sep">${k === S.today ? '今天' : md(x.at)}</div>`; last = k; }
    const src = taskOf(x.taskId);
    html += `<div class="th" data-thid="${x.id}"><div class="tx">${esc(x.text)}<div class="hint">${hm(x.at)}${src ? ` · ${esc(src.title)}` : ''} · ${x.reviewed ? '已回顾' : '待回顾'}</div></div>${convHTML(x)}</div>`;
  }
  return html;
}
function inboxHTML() {
  return `<input id="inbox-q" placeholder="搜索想法…" value="${esc(ui.inboxQ)}"><div id="inbox-list">${inboxListHTML()}</div>
    <div class="legend">转成的待办会加到当前分类（${catName(ui.cat)}）。删除任务会连同它的想法一起清除。</div>`;
}

function catLine() {
  const h = new Date(now()).getHours();
  if (S.cat.status === 'hunting') return '（地上只有几个爪印）';
  if (S.session.phase === 'running') return S.clockRunning ? '嘘——你在专心，我不吵你。' : '歇一会儿也行，我等你。';
  if (S.streak >= 3) return `已经连续 ${S.streak} 天了，喵！`;
  if (S.cat.status === 'hungry') return '肚子有点咕咕叫……';
  if (h < 6 || h >= 23) return '这么晚了，早点休息呀。';
  if ((S.todayStats || {}).done) return `今天完成了 ${S.todayStats.done} 项，真不错。`;
  return S.queue.length ? '挑一件事，我陪你开始。' : '今天想做点什么？';
}

function catHTML() {
  const c = S.cat;
  const C = S.constants;
  const st = { full: ['吃饱了，在打呼噜', '它陪你一起做事。'], hungry: ['有点饿了', '喂一次就好，不喂也没关系，待办随时可用。'], hunting: ['外出打猎去了', '很久没喂，它自己出门找吃的了。喂一次它就回来。'] }[c.status];
  const can = S.balance >= C.FEED_COST;
  return `<div class="cat-card"><div class="bubble">${catLine()}</div><div class="cat-fig ${ui.fed ? 'fed' : ''}">${catSvg(c.status, 150)}</div>
    <div class="st">${st[0]}</div><div class="ds">${st[1]}${c.lastFedAt ? `<br>上次喂食：${md(c.lastFedAt)} ${hm(c.lastFedAt)}` : ''}</div>
    <button class="btn big primary" data-act="feed" ${can ? '' : 'disabled'}>喂一次（${C.FEED_COST} 积分）</button>
    <div class="pts"><div><b>${S.balance}</b>当前积分</div><div><b>${S.streak}</b>连续天数</div><div><b>+${C.TASK_REWARD}</b>每个计时完成的任务</div><div><b>+${C.DAILY_REWARD}</b>每天首次打开</div></div></div>
    <div class="set" style="margin-top:10px"><div class="tx"><b>把小猫显示到桌面</b><span>小猫会坐在悬浮球上；默认只在面板里。</span></div><button class="sw ${S.settings.desktopCat ? 'on' : ''}" data-set="desktopCat"></button></div>`;
}

function settingsHTML() {
  const s = S.settings;
  const sw = (k) => `<button class="sw ${s[k] ? 'on' : ''}" data-set="${k}"></button>`;
  return `
    <div class="set"><div class="tx"><b>置顶</b><span>悬浮球和面板保持在其他窗口之上。</span></div>${sw('alwaysOnTop')}</div>
    <div class="set"><div class="tx"><b>开机自启动</b><span>登录后自动启动 Todo Cat。${S.env.packaged ? '' : '（当前是开发运行，打包成 App 后生效）'}</span></div>${sw('autoLaunch')}</div>
    <div class="set"><div class="tx"><b>把小猫显示到桌面</b><span>小猫坐在悬浮球上。</span></div>${sw('desktopCat')}</div>
    <div class="set"><div class="tx"><b>到点提示音</b><span>计时完成时响一声系统提示音；通知和面板提醒不受影响。</span></div>${sw('sound')}</div>
    <div class="set"><div class="tx"><b>全局快捷键</b>
      <span><kbd>${S.env.keys.add}</kbd> 唤出并记一件事${s.shortcuts && !S.env.shortcutsOk.add ? '（被其他应用占用，未生效）' : ''}　<kbd>${S.env.keys.thought}</kbd> 记想法${s.shortcuts && !S.env.shortcutsOk.thought ? '（被占用，未生效）' : ''}</span>
      <span>面板内：<kbd>${S.env.keys.mod}1</kbd>–<kbd>${S.env.keys.mod}6</kbd> 切换标签　<kbd>N</kbd> 新待办　<kbd>Enter</kbd> 开始队首　<kbd>空格</kbd> 暂停/继续　<kbd>T</kbd> 记想法　<kbd>Esc</kbd> 收起</span></div>${sw('shortcuts')}</div>
    <div class="set"><div class="tx"><b>自愿上报使用数据（封闭测试）</b>
      <span>默认关闭，核心功能全程可离线使用。打开后只上报事件元数据（例如“开始计时”“回顾完成”及时长、条数），用于了解录入、计时和回顾流程是否顺畅。</span>
      <span>使用本次安装的随机 ID 和可选的测试码；<b style="display:inline">任务标题、想法正文、设备指纹都不采集</b>。原始事件保留 90 天。随时可以关闭，关闭即停止采集并清空本机排队的数据；需要删除已上报的数据，请把测试码告诉测试负责人。</span>
      <span>本机排队 ${S.env.telemetryQueued} 条${S.env.telemetryEndpoint ? '' : '（尚未配置接收服务，事件只留在本机）'}。</span>
      ${s.telemetry ? `<input type="text" id="test-code" maxlength="40" placeholder="测试码（可选）" value="${esc(s.testCode)}">` : ''}</div>${sw('telemetry')}</div>
    <div class="row-btns"><span class="hint">数据保存在本机 SQLite。</span><button class="btn" data-act="quit">退出 Todo Cat</button></div>`;
}

function renderMore() {
  const sub = `<div class="sub">${[['calendar', '日历'], ['thoughts', '想法'], ['cat', '小猫'], ['settings', '设置']].map(([k, l]) => `<button data-more="${k}" class="${ui.more === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const body = ui.more === 'calendar' ? calendarHTML() : ui.more === 'thoughts' ? inboxHTML() : ui.more === 'cat' ? catHTML() : settingsHTML();
  setHTML($('#p-more'), sub + body);
}

// ---------- 总渲染 ----------
function render() {
  if (!S) return;
  const counts = { todo: S.queue.length, pending: 0, completed: 0, cancelled: 0 };
  for (const t of S.tasks) if (!t.parentId && counts[t.status] !== undefined && t.status !== 'todo') counts[t.status] += 1;
  for (const b of $$('#tabs nav button')) {
    const k = b.dataset.tab;
    b.classList.toggle('on', ui.tab === k);
    const base = b.dataset.label || (b.dataset.label = b.textContent);
    b.innerHTML = base + (counts[k] ? `<span class="n">${counts[k]}</span>` : '');
  }
  for (const k of ['focus', 'todo', 'pending', 'completed', 'cancelled', 'more']) $(`#p-${k}`).hidden = ui.tab !== k;
  renderBanner();
  renderFocus();
  renderTodo();
  renderStatus('pending', $('#p-pending'), '没有等待中的任务。');
  renderStatus('completed', $('#p-completed'), '还没有计时完成的任务。');
  renderStatus('cancelled', $('#p-cancelled'), '没有取消的任务。');
  if (ui.tab === 'more') renderMore();
  renderExecbar();
}

function setTab(tab) {
  ui.tab = tab;
  if (tab === 'more') {
    if (ui.more === 'calendar') loadCal();
    if (ui.more === 'cat') claimDaily();
  }
  render();
}
async function claimDaily() {
  const r = await api.cmd('claimDaily');
  if (r.ok && r.result) toast(`今日积分 +${S.constants.DAILY_REWARD}，够喂一次猫`);
}

// ---------- 录入表单 ----------
const titleEl = $('#add-title');
const durEl = $('#add-dur');
const errEl = $('#add-err');
const composing = (e) => e.isComposing || e.keyCode === 229; // 输入法确认候选词：不跳步、不提交

function resetAdd(keepCtx) {
  titleEl.value = '';
  $('#add-h').value = '';
  $('#add-m').value = '';
  durEl.hidden = true;
  errEl.textContent = '';
  $('#add-hint').innerHTML = '';
  if (!keepCtx) ui.ctx = null;
}
function quickHint() {
  const q = parseQuick(titleEl.value);
  $('#add-hint').innerHTML = q ? `⏱ ${fmtMin(q.minutes)} · 回车直接添加「${esc(q.title)}」` : '';
  return q;
}
async function submitAdd(minutes, titleOverride) {
  const title = (titleOverride ?? titleEl.value).trim();
  if (!title) { errEl.textContent = '请先填写标题'; titleEl.focus(); return; }
  if (minutes === undefined) {
    const h = $('#add-h').value.trim(), m = $('#add-m').value.trim();
    if (!/^\d*$/.test(h) || !/^\d*$/.test(m) || (!h && !m)) { errEl.textContent = '请填写时长：选快捷项，或输入小时、分钟'; return; }
    minutes = Number(h || 0) * 60 + Number(m || 0);
  }
  if (!(minutes >= 1 && minutes <= 1440)) { errEl.textContent = '时长需为 1–1440 分钟'; return; }
  let r;
  if (ui.ctx && ui.ctx.type === 'split') r = await api.cmd('splitTask', { id: ui.ctx.id, title, minutes });
  else r = await api.cmd('addTask', { title, minutes, categoryId: ui.cat, parentId: ui.ctx ? ui.ctx.id : null });
  if (!r.ok) { errEl.textContent = r.error; return; }
  ui.flashId = r.result;
  setTimeout(() => { ui.flashId = null; }, 1200);
  resetAdd(ui.ctx && ui.ctx.type === 'child'); // 连续加子项时保留上下文
  titleEl.focus();
  render();
}
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (composing(e)) return;
    if (!titleEl.value.trim()) { errEl.textContent = '请先填写标题'; return; }
    const q = parseQuick(titleEl.value);
    if (q) { submitAdd(q.minutes, q.title); return; } // 标题里带了时长：一步完成
    errEl.textContent = '';
    durEl.hidden = false;
    $('#add-m').focus();
  } else if (e.key === 'Escape') { resetAdd(); titleEl.blur(); render(); }
});
titleEl.addEventListener('input', () => { const q = quickHint(); if (titleEl.value.trim()) { durEl.hidden = !!q; errEl.textContent = ''; } });
$('#add').addEventListener('submit', (e) => { e.preventDefault(); submitAdd(); });
$('#add').addEventListener('keydown', (e) => { if (e.key === 'Enter' && composing(e)) e.preventDefault(); });
$('#add').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-min]');
  if (chip) submitAdd(Number(chip.dataset.min));
  if (e.target.closest('[data-act="ctx-clear"]')) { ui.ctx = null; render(); }
});

// ---------- 想法录入 ----------
const thEl = $('#thought-text');
async function submitThought() {
  if (!thEl.value.trim()) { toast('想法内容为空'); return; }
  const r = await cmd('submitThought', { text: thEl.value });
  if (r.ok) thEl.value = '';
}
async function cancelThought() { thEl.value = ''; await cmd('cancelThought'); }
thEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!composing(e)) submitThought(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelThought(); }
});
$('#thought-submit').addEventListener('click', submitThought);
$('#thought-cancel').addEventListener('click', cancelThought);

// ---------- 事件委托 ----------
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});
$('#collapse').addEventListener('click', () => api.ui('collapse'));
$('#execbar').addEventListener('click', () => setTab('focus'));
$('#banner').addEventListener('click', (e) => { if (e.target.closest('[data-act="dismiss"]')) cmd('dismissNotice'); });
$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) { ui.cat = b.dataset.cat; ui.ctx = null; render(); }
});

async function saveEdit(box) {
  const id = box.dataset.id;
  const title = $('[data-f="title"]', box).value;
  const minEl = $('[data-f="min"]', box);
  const args = { id, title };
  if (minEl) args.minutes = Number(minEl.value);
  const r = await cmd('editTask', args);
  if (r.ok) { ui.editId = null; document.activeElement && document.activeElement.blur(); render(); }
}

document.addEventListener('click', async (e) => {
  const actEl = e.target.closest('[data-act]');
  if (actEl) {
    const act = actEl.dataset.act;
    const holder = actEl.closest('[data-id]');
    const id = holder && holder.dataset.id;
    switch (act) {
      case 'start': { const r = await cmd('start'); if (r.ok) setTab('focus'); break; }
      case 'pause': await cmd('pause'); break;
      case 'resume': await cmd('resume'); break;
      case 'thought': thEl.value = ''; await cmd('openThought'); break;
      case 'pushout': thEl.value = ''; await cmd('pushOut'); break;
      case 'pushout-next': await cmd('pushOut', { id: S.nextId }); break;
      case 'push': await cmd('pushOut', { id }); break;
      case 'return': await cmd('returnToTodo', { id }); break;
      case 'cancel': await cmd('cancelTask', { id }); break;
      case 'del': ui.confirmId = id; render(); break;
      case 'undel': ui.confirmId = null; render(); break;
      case 'del-yes': ui.confirmId = null; await cmd('deleteTask', { id }); break;
      case 'edit': ui.editId = id; render(); { const i = $(`.edit[data-id="${id}"] input`); if (i) { i.focus(); i.select(); } } break;
      case 'unedit': ui.editId = null; document.activeElement.blur(); render(); break;
      case 'save': await saveEdit(holder); break;
      case 'child': case 'split': {
        const t = taskOf(id);
        ui.ctx = { type: act, id };
        ui.cat = t.categoryId;
        setTab('todo');
        titleEl.focus();
        break;
      }
      case 'thoughts': ui.openTh[id] = !ui.openTh[id]; render(); break;
      case 'again': {
        const fin = S.session.lastFinished;
        setTab('todo');
        titleEl.value = fin ? `继续：${fin.title}` : '';
        durEl.hidden = false;
        titleEl.focus();
        break;
      }
      case 'goto-todo': setTab('todo'); titleEl.focus(); break;
      case 'feed': { ui.fed = true; const r = await cmd('feedCat'); if (r.ok) toast('喵～谢谢投喂'); setTimeout(() => { ui.fed = false; }, 900); break; }
      case 'onboarded': await cmd('setSetting', { key: 'onboarded', value: true }); break;
      case 'conv': ui.convId = actEl.closest('[data-thid]').dataset.thid; render(); refreshInbox(); break;
      case 'conv-x': ui.convId = null; render(); refreshInbox(); break;
      case 'quit': api.ui('quit'); break;
      default:
    }
    return;
  }
  const cv = e.target.closest('[data-conv-min]');
  if (cv) {
    const thid = cv.closest('[data-thid]').dataset.thid;
    ui.convId = null;
    const r = await cmd('thoughtToTask', { id: thid, minutes: Number(cv.dataset.convMin), categoryId: ui.cat });
    if (r.ok) toast(`已加入 to-do（${catName(ui.cat)}）`);
    refreshInbox();
    return;
  }
  const fold = e.target.closest('[data-fold]');
  if (fold) { ui.closed[fold.dataset.fold] = !ui.closed[fold.dataset.fold]; render(); return; }
  const more = e.target.closest('[data-more]');
  if (more) { ui.more = more.dataset.more; setTab('more'); return; }
  const view = e.target.closest('[data-view]');
  if (view) { ui.calView = view.dataset.view; loadCal(); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const dir = Number(nav.dataset.nav);
    if (!dir) ui.calAnchor = null;
    else {
      const d = new Date(ui.calAnchor || now());
      if (ui.calView === 'day') d.setDate(d.getDate() + dir);
      else if (ui.calView === 'week') d.setDate(d.getDate() + 7 * dir);
      else { d.setDate(1); d.setMonth(d.getMonth() + dir); }
      ui.calAnchor = d.getTime();
    }
    loadCal();
    return;
  }
  const day = e.target.closest('[data-day]');
  if (day) { ui.calView = 'day'; ui.calAnchor = Number(day.dataset.day) + 12 * 3600e3; loadCal(); return; }
  const set = e.target.closest('[data-set]');
  if (set) { const k = set.dataset.set; await cmd('setSetting', { key: k, value: !S.settings[k] }); }
});

function refreshInbox() { const el = $('#inbox-list'); if (el && ui.tab === 'more' && ui.more === 'thoughts') el.innerHTML = inboxListHTML(); }
document.addEventListener('input', (e) => { if (e.target.id === 'inbox-q') { ui.inboxQ = e.target.value; refreshInbox(); } });
document.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.task');
  if (!row || e.target.closest('.acts') || !e.target.closest('.t-title')) return;
  ui.editId = row.dataset.id;
  render();
  const i = $(`.edit[data-id="${ui.editId}"] input`);
  if (i) { i.focus(); i.select(); }
});
// 面板内键盘操作
document.addEventListener('keydown', (e) => {
  if (!S) return;
  if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) { e.preventDefault(); setTab(TABS[Number(e.key) - 1]); return; }
  if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  const ss = S.session;
  if (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return; // 交给按钮自己处理
  if (e.key === 'Escape') api.ui('collapse');
  else if (e.key === 'n' || e.key === '/') { e.preventDefault(); setTab('todo'); titleEl.focus(); }
  else if (ss.phase === 'running' && ui.tab === 'focus' && e.key === ' ') { e.preventDefault(); cmd(ss.paused ? 'resume' : 'pause'); }
  else if (ss.phase === 'running' && ui.tab === 'focus' && e.key === 't') { e.preventDefault(); thEl.value = ''; cmd('openThought'); }
  else if (e.key === 'Enter' && ui.tab === 'focus' && (ss.phase === 'idle' || ss.phase === 'ready') && S.nextId) { e.preventDefault(); cmd('start'); }
});

function celebrate() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#d9782d', '#2f9e6e', '#5b7fd6', '#e8b93c', '#d65b8a'];
  box.innerHTML = Array.from({ length: 26 }, (_, i) => `<i style="left:${50 + (Math.random() - 0.5) * 30}%;background:${colors[i % 5]};--dx:${Math.round((Math.random() - 0.5) * 360)}px;--dy:${Math.round(-120 - Math.random() * 220)}px;--r:${Math.round(Math.random() * 720)}deg;animation-delay:${Math.round(Math.random() * 120)}ms"></i>`).join('');
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1900);
}

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-th]')) cmd('checkThought', { id: e.target.dataset.th, checked: e.target.checked });
  if (e.target.id === 'test-code') cmd('setSetting', { key: 'testCode', value: e.target.value.trim() });
});
document.addEventListener('keydown', (e) => {
  const box = e.target.closest && e.target.closest('.edit');
  if (!box) return;
  if (e.key === 'Enter') { e.preventDefault(); if (!composing(e)) saveEdit(box); }
  if (e.key === 'Escape') { ui.editId = null; e.target.blur(); render(); }
});

// 点击面板时确保它拿到键盘焦点
document.addEventListener('pointerdown', () => api.ui('focus'), true);

// 编辑时保持展开
function reportEditing() {
  const a = document.activeElement;
  const on = !!(a && /INPUT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox') || !$('#thought-box').hidden;
  api.ui('editing', on);
}
document.addEventListener('focusin', reportEditing);
document.addEventListener('focusout', () => setTimeout(() => {
  reportEditing();
  if ($$('[data-stale]').length) render();
}, 0));

// 同级拖动排序
let dragId = null;
const listEl = $('#todo-list');
const clearDrop = () => $$('.drop-before, .drop-after', listEl).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
listEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.task[draggable]');
  if (!row) return;
  dragId = row.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
listEl.addEventListener('dragover', (e) => {
  const row = e.target.closest('.task');
  const src = dragId && $(`.task[data-id="${dragId}"]`, listEl);
  if (!row || !src || row === src || row.dataset.grp !== src.dataset.grp) return;
  e.preventDefault();
  clearDrop();
  const r = row.getBoundingClientRect();
  row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
listEl.addEventListener('drop', async (e) => {
  const row = e.target.closest('.task');
  if (!row || !dragId) return;
  e.preventDefault();
  const place = row.classList.contains('drop-after') ? 'after' : 'before';
  clearDrop();
  await cmd('moveTask', { id: dragId, targetId: row.dataset.id, place });
  dragId = null;
});
listEl.addEventListener('dragend', () => { dragId = null; clearDrop(); });

// ---------- 与主进程同步 ----------
api.on('state', (snap) => {
  S = snap;
  offset = snap.now - Date.now();
  const fin = snap.session.lastFinished;
  const finAt = fin && fin.reason === 'timeup' ? fin.at : null;
  if (ui.lastFinAt !== undefined && finAt && finAt !== ui.lastFinAt) celebrate(); // 计时完成：撒一把彩纸
  ui.lastFinAt = finAt;
  render();
  if (ui.tab === 'more' && ui.more === 'calendar') loadCal();
});
api.on('expanded', ({ target, fresh, focusAdd }) => {
  if (fresh) { document.body.classList.remove('pop'); void document.body.offsetWidth; document.body.classList.add('pop'); }
  if (target) setTab(target);
  if (focusAdd) setTimeout(() => titleEl.focus(), 60);
});
api.on('toast', toast);
api.snapshot();

setInterval(() => {
  if (!S || S.session.phase !== 'running') return;
  const t = taskOf(S.session.taskId);
  if (!t) return;
  const text = fmtClock(remaining(t));
  for (const el of $$(`[data-timer="${t.id}"]`)) if (el.textContent !== text) el.textContent = text;
  const fg = $('#ring-fg');
  if (fg) fg.style.strokeDashoffset = RING * (1 - Math.min(1, remaining(t) / (t.plannedMin * 60000)));
}, 250);
