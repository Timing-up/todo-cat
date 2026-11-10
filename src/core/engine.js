'use strict';
// Todo Cat 核心规则引擎：纯逻辑，不依赖 Electron，时钟可注入，便于单元测试。
const crypto = require('node:crypto');

const C = {
  TASK_REWARD: 10, // 每个计时完成的任务发一次
  DAILY_REWARD: 10, // 每个本地日一次，足够一次基础喂养
  FEED_COST: 10,
  FULL_MS: 12 * 3600e3, // 喂食后多久算「饱」
  HUNT_MS: 48 * 3600e3, // 多久没喂显示「外出打猎」
  GAP_MS: 30e3, // tick 间隔超过它视为不可用时段，不补算
  MAX_MIN: 1440,
};

const CATEGORIES = [
  { id: 'work', name: '工作' },
  { id: 'study', name: '学习' },
  { id: 'life', name: '生活' },
  { id: 'other', name: '其他' },
];

const pad = (n) => String(n).padStart(2, '0');
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptySession() {
  return {
    phase: 'idle', // idle | ready | running | review
    taskId: null,
    paused: false,
    runningSince: null,
    segId: null,
    thoughtOpenAt: null,
    review: null, // { batchId, taskId, reason, thoughtIds }
    lastTickAt: null,
    lastFinished: null, // { title, reason, at }
    notice: null,
  };
}

function emptyState(now = Date.now()) {
  return {
    tasks: [],
    thoughts: [],
    segments: [], // { id, taskId, start, end } 实际运行时段，删除任务后保留
    completions: [], // { taskId, at }
    ledger: [], // { key, delta, at, kind }
    session: emptySession(),
    settings: { alwaysOnTop: true, autoLaunch: false, desktopCat: false, telemetry: false, testCode: '', ball: null, shortcuts: true, sound: true, onboarded: false },
    cat: { createdAt: now, lastFedAt: null },
    meta: { installId: crypto.randomUUID(), createdAt: now },
  };
}

class Engine {
  constructor(state, opts = {}) {
    this.now = opts.now || Date.now;
    this.s = state || emptyState(this.now());
    this.emit = opts.emit || (() => {});
    this.uid = opts.uid || (() => crypto.randomUUID());
    this.saveError = false;
  }

  // ---------- 查询 ----------
  task(id) { return this.s.tasks.find((t) => t.id === id); }
  need(id) {
    const t = this.task(id);
    if (!t) throw new Error('任务不存在');
    return t;
  }
  kids(id) { return this.s.tasks.filter((t) => t.parentId === id).sort((a, b) => a.order - b.order); }
  isParent(t) { return this.s.tasks.some((x) => x.parentId === t.id); }
  validKids(t) { return this.kids(t.id).filter((k) => k.state !== 'cancelled'); }

  /** 父任务只进一个状态页，按 todo → pending → completed → cancelled 派生。 */
  status(t) {
    if (!this.isParent(t)) return t.state;
    if (t.cancelledExplicit) return 'cancelled';
    const v = this.validKids(t);
    if (!v.length) return 'cancelled'; // 空计划
    if (v.some((k) => k.state === 'todo')) return 'todo';
    if (v.some((k) => k.state === 'pending')) return 'pending';
    return 'completed';
  }

  progress(t) {
    const v = this.validKids(t);
    const totalMin = v.reduce((a, k) => a + k.plannedMin, 0);
    const done = v.filter((k) => k.state === 'completed');
    const doneMin = done.reduce((a, k) => a + k.plannedMin, 0);
    return { doneMin, totalMin, doneCount: done.length, validCount: v.length, ratio: totalMin ? doneMin / totalMin : 0 };
  }

  /** 可执行队列：按分类、任务、子任务顺序。 */
  queue() {
    const out = [];
    for (const c of CATEGORIES) {
      const tops = this.s.tasks.filter((t) => !t.parentId && t.categoryId === c.id).sort((a, b) => a.order - b.order);
      for (const t of tops) {
        if (this.isParent(t)) {
          if (!t.cancelledExplicit) out.push(...this.kids(t.id).filter((k) => k.state === 'todo'));
        } else if (t.state === 'todo') out.push(t);
      }
    }
    return out;
  }

  runnable(id) {
    const t = id && this.task(id);
    return !!t && !this.isParent(t) && t.state === 'todo';
  }
  nextId() {
    const ss = this.s.session;
    if (ss.phase === 'ready' && this.runnable(ss.taskId)) return ss.taskId;
    const q = this.queue();
    return q.length ? q[0].id : null;
  }
  clockRunning() { return this.s.session.phase === 'running' && this.s.session.runningSince != null; }
  balance() { return this.s.ledger.reduce((a, l) => a + l.delta, 0); }
  catStatus() {
    const since = this.now() - (this.s.cat.lastFedAt ?? this.s.cat.createdAt);
    return since < C.FULL_MS ? 'full' : since < C.HUNT_MS ? 'hungry' : 'hunting';
  }
  /** 连续有计时完成的本地日数（今天还没完成时从昨天算起）。 */
  streak() {
    const days = new Set(this.s.completions.map((c) => dayKey(c.at)));
    const d = new Date(this.now());
    d.setHours(12, 0, 0, 0);
    if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d.getTime()))) { n += 1; d.setDate(d.getDate() - 1); }
    return n;
  }
  /** 悬停落点：有当前执行、回顾或同一轮下一项待开始时回到白纸执行，否则 to-do。 */
  hoverTarget() { return this.s.session.phase === 'idle' ? 'todo' : 'focus'; }

  remainingMs(t) {
    const ss = this.s.session;
    if (this.clockRunning() && ss.taskId === t.id) return Math.max(0, t.remainingMs - (this.now() - ss.runningSince));
    return t.remainingMs;
  }

  snapshot() {
    const ss = this.s.session;
    return {
      now: this.now(),
      categories: CATEGORIES,
      constants: C,
      tasks: this.s.tasks.map((t) => {
        const isParent = this.isParent(t);
        const o = { ...t, isParent, status: this.status(t) };
        if (isParent) {
          o.progress = this.progress(t);
          const done = this.kids(t.id).filter((k) => k.state === 'completed').map((k) => k.completedAt);
          o.completedAt = done.length ? Math.max(...done) : null;
        }
        return o;
      }),
      queue: this.queue().map((t) => t.id),
      nextId: this.nextId(),
      thoughts: this.s.thoughts,
      session: { ...ss },
      clockRunning: this.clockRunning(),
      hoverTarget: this.hoverTarget(),
      balance: this.balance(),
      streak: this.streak(),
      queueMs: this.queue().reduce((a, t) => a + this.remainingMs(t), 0),
      cat: { ...this.s.cat, status: this.catStatus() },
      settings: { ...this.s.settings },
      saveError: this.saveError,
      today: dayKey(this.now()),
    };
  }

  // ---------- 录入与编辑 ----------
  _title(v) {
    const s = String(v ?? '').trim();
    if (!s) throw new Error('请先填写标题');
    return s.slice(0, 200);
  }
  _minutes(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > C.MAX_MIN) throw new Error('时长需为 1–1440 分钟');
    return n;
  }

  addTask({ title, minutes, categoryId, parentId = null, afterId = null }) {
    title = this._title(title);
    minutes = this._minutes(minutes);
    let cat = categoryId;
    let wasLeafParent = false;
    if (parentId) {
      const p = this.need(parentId);
      if (p.parentId) throw new Error('首版只支持两层任务');
      if (this.isParent(p)) {
        const st = this.status(p);
        if (st !== 'todo' && st !== 'pending') throw new Error('该父任务已结束，不能再加子项');
      } else {
        if (p.state !== 'todo' || p.started) throw new Error('任务开始后不能再加子项');
        wasLeafParent = true;
      }
      cat = p.categoryId;
    } else if (!CATEGORIES.some((c) => c.id === cat)) throw new Error('分类不存在');

    const t = {
      id: this.uid(), categoryId: cat, parentId, title, plannedMin: minutes, order: 0,
      state: 'todo', started: false, remainingMs: minutes * 60000,
      createdAt: this.now(), completedAt: null, cancelledAt: null, cancelledExplicit: false,
    };
    const sibs = this._siblings(t);
    const idx = afterId ? sibs.findIndex((x) => x.id === afterId) : -1;
    if (idx >= 0) sibs.splice(idx + 1, 0, t); else sibs.push(t);
    sibs.forEach((x, i) => { x.order = i; });
    this.s.tasks.push(t);
    // 待开始的独立任务变成了父任务：父任务只汇总，重新加载下一项
    if (wasLeafParent && this.s.session.phase === 'ready' && this.s.session.taskId === parentId) this._loadNext();
    this.emit('task_created', { minutes, level: parentId ? 2 : 1 });
    return t.id;
  }

  /** 父下叶子在首次开始前同父拆分：在它后面插入一个兄弟叶子。 */
  splitTask({ id, title, minutes }) {
    const t = this.need(id);
    if (!t.parentId) throw new Error('只有父任务下的子项可以同父拆分');
    if (t.started || t.state !== 'todo') throw new Error('开始后不能再拆分');
    return this.addTask({ title, minutes, parentId: t.parentId, afterId: id });
  }

  _siblings(t) {
    return this.s.tasks
      .filter((x) => x.id !== t.id && x.parentId === t.parentId && (t.parentId || x.categoryId === t.categoryId))
      .sort((a, b) => a.order - b.order);
  }

  editTask({ id, title, minutes }) {
    const t = this.need(id);
    if (title !== undefined) t.title = this._title(title);
    if (minutes !== undefined && minutes !== null && Number(minutes) !== t.plannedMin) {
      if (this.isParent(t)) throw new Error('父任务只汇总子项时长');
      if (t.started || (t.state !== 'todo' && t.state !== 'pending')) throw new Error('开始后时长已锁定');
      t.plannedMin = this._minutes(minutes);
      t.remainingMs = t.plannedMin * 60000;
    }
  }

  /** 同级拖动，只改后续顺序。 */
  moveTask({ id, targetId, place = 'before' }) {
    const t = this.need(id);
    const target = this.need(targetId);
    if (id === targetId) return;
    if (t.parentId !== target.parentId || t.categoryId !== target.categoryId) throw new Error('只能在同级内调整顺序');
    const ss = this.s.session;
    if ((ss.phase === 'running' || ss.phase === 'ready') && ss.taskId === id) throw new Error('当前任务的顺序不能调整');
    const sibs = this._siblings(t);
    const i = sibs.findIndex((x) => x.id === targetId);
    sibs.splice(place === 'after' ? i + 1 : i, 0, t);
    sibs.forEach((x, n) => { x.order = n; });
  }

  // ---------- 计时 ----------
  _startClock() {
    const ss = this.s.session;
    const now = this.now();
    const seg = { id: this.uid(), taskId: ss.taskId, start: now, end: now };
    this.s.segments.push(seg);
    ss.runningSince = now;
    ss.segId = seg.id;
    ss.lastTickAt = now;
  }
  _stopClock(at) {
    const ss = this.s.session;
    if (ss.runningSince == null) return;
    const t = this.task(ss.taskId);
    const end = Math.max(ss.runningSince, at);
    if (t) t.remainingMs = Math.max(0, t.remainingMs - (end - ss.runningSince));
    const seg = this.s.segments.find((x) => x.id === ss.segId);
    if (seg) seg.end = end;
    ss.runningSince = null;
    ss.segId = null;
  }
  _maybeStartClock() {
    const ss = this.s.session;
    if (ss.phase === 'running' && !ss.paused && ss.thoughtOpenAt == null && !this.saveError && ss.runningSince == null) this._startClock();
  }

  start() {
    const ss = this.s.session;
    if (ss.phase === 'running') throw new Error('同时只能执行一项');
    if (ss.phase === 'review') throw new Error('先回顾完想法，再开始下一项');
    if (this.saveError) throw new Error('保存尚未恢复，暂时不能开始');
    const id = this.nextId();
    if (!id) throw new Error('没有可开始的任务');
    const t = this.task(id);
    const first = !t.started;
    t.started = true;
    Object.assign(ss, { phase: 'running', taskId: id, paused: false, thoughtOpenAt: null, review: null, lastFinished: null });
    this._startClock();
    this.emit('timer_started', { minutes: t.plannedMin, first });
    return id;
  }

  pause() {
    const ss = this.s.session;
    if (ss.phase !== 'running') throw new Error('当前没有在计时');
    this._stopClock(this.now());
    ss.paused = true;
  }
  resume() {
    const ss = this.s.session;
    if (ss.phase !== 'running') throw new Error('当前没有在计时');
    if (this.saveError) throw new Error('保存尚未恢复，暂时不能继续');
    ss.paused = false;
    ss.notice = null;
    this._maybeStartClock();
  }

  /** 正常退出、锁屏、睡眠：暂停并等待用户手动继续。 */
  systemPause(kind = 'lock') {
    const ss = this.s.session;
    if (ss.phase !== 'running') return false;
    const was = !ss.paused;
    this._stopClock(this.now());
    ss.paused = true;
    if (kind === 'quit') ss.thoughtOpenAt = null;
    else if (was) ss.notice = { type: 'system', at: this.now() };
    return true;
  }

  /** 定时调用。返回状态是否有需要落盘/广播的变化。 */
  tick() {
    const ss = this.s.session;
    const now = this.now();
    let changed = false;
    if (this.clockRunning()) {
      const t = this.task(ss.taskId);
      if (ss.lastTickAt != null && now - ss.lastTickAt > C.GAP_MS) {
        // 进程被挂起过：不可用时段不补算
        this._stopClock(ss.lastTickAt);
        ss.paused = true;
        ss.notice = { type: 'gap', at: ss.lastTickAt };
        changed = true;
      } else if (t && now - ss.runningSince >= t.remainingMs) {
        this._complete(ss.runningSince + t.remainingMs);
        changed = true;
      }
    }
    ss.lastTickAt = now;
    return changed;
  }

  _award(key, delta, kind, at) {
    if (this.s.ledger.some((l) => l.key === key)) return false;
    this.s.ledger.push({ key, delta, at, kind });
    return true;
  }

  _complete(at) {
    const ss = this.s.session;
    const t = this.task(ss.taskId);
    this._stopClock(at);
    t.remainingMs = 0;
    t.state = 'completed';
    t.completedAt = at;
    // 完成记录与发奖在同一次状态变更里产生，并随同一个事务落盘
    if (!this.s.completions.some((c) => c.taskId === t.id)) this.s.completions.push({ taskId: t.id, at });
    this._award(`task:${t.id}`, C.TASK_REWARD, 'task', at);
    this.emit('timer_finished', { minutes: t.plannedMin, title: t.title });
    this._endRun(t, 'timeup', at);
  }

  _endRun(t, reason, at = this.now()) {
    const ss = this.s.session;
    const open = this.s.thoughts.filter((x) => x.taskId === t.id && !x.reviewed);
    ss.paused = false;
    ss.thoughtOpenAt = null;
    ss.lastFinished = { title: t.title, reason, at };
    if (open.length) {
      ss.phase = 'review';
      ss.taskId = null;
      ss.review = { batchId: this.uid(), taskId: t.id, reason, thoughtIds: open.map((x) => x.id) };
      this.emit('review_started', { reason, thoughts: open.length });
    } else {
      this.emit('review_direct', { reason });
      this._loadNext();
    }
  }

  _loadNext() {
    const ss = this.s.session;
    const q = this.queue();
    ss.review = null;
    ss.paused = false;
    ss.thoughtOpenAt = null;
    ss.runningSince = null;
    ss.segId = null;
    if (q.length) { ss.phase = 'ready'; ss.taskId = q[0].id; } else { ss.phase = 'idle'; ss.taskId = null; }
  }

  // ---------- 想法 ----------
  openThought() {
    const ss = this.s.session;
    if (ss.phase !== 'running') throw new Error('执行中才能记想法');
    if (ss.thoughtOpenAt != null) return;
    this._stopClock(this.now());
    ss.thoughtOpenAt = this.now();
  }
  cancelThought() {
    const ss = this.s.session;
    if (ss.thoughtOpenAt == null) return;
    ss.thoughtOpenAt = null;
    this._maybeStartClock(); // 只解除这次录入造成的暂停
  }
  submitThought({ text }) {
    const ss = this.s.session;
    if (ss.thoughtOpenAt == null) throw new Error('没有正在录入的想法');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('想法内容为空');
    const th = { id: this.uid(), taskId: ss.taskId, text: body.slice(0, 2000), at: ss.thoughtOpenAt, reviewed: false, reviewedAt: null, taskCreatedId: null };
    this.s.thoughts.push(th);
    ss.thoughtOpenAt = null;
    this._maybeStartClock();
    this.emit('thought_submitted', {});
    return th.id;
  }
  checkThought({ id, checked = true }) {
    const th = this.s.thoughts.find((x) => x.id === id);
    if (!th) throw new Error('想法不存在');
    const ss = this.s.session;
    if (!(ss.phase === 'review' && ss.review.thoughtIds.includes(id))) throw new Error('这条想法不在当前回顾里');
    th.reviewed = !!checked;
    th.reviewedAt = checked ? this.now() : null;
    const left = ss.review.thoughtIds.filter((tid) => {
      const x = this.s.thoughts.find((y) => y.id === tid);
      return x && !x.reviewed;
    });
    if (!left.length) {
      this.emit('review_completed', { reason: ss.review.reason, thoughts: ss.review.thoughtIds.length });
      this._loadNext();
    }
  }

  /** 把一条想法转成待办：算作已处理，回顾中会自动勾上。 */
  thoughtToTask({ id, minutes, categoryId }) {
    const th = this.s.thoughts.find((x) => x.id === id);
    if (!th) throw new Error('想法不存在');
    if (th.taskCreatedId && this.task(th.taskCreatedId)) throw new Error('这条想法已经转成待办了');
    const src = this.task(th.taskId);
    const cat = CATEGORIES.some((c) => c.id === categoryId) ? categoryId : (src ? src.categoryId : 'other');
    const tid = this.addTask({ title: th.text.replace(/\s+/g, ' ').slice(0, 200), minutes, categoryId: cat });
    th.taskCreatedId = tid;
    const ss = this.s.session;
    if (ss.phase === 'review' && ss.review.thoughtIds.includes(id) && !th.reviewed) this.checkThought({ id, checked: true });
    this.emit('thought_to_task', {});
    return tid;
  }

  // ---------- 推出 / 送回 / 取消 / 删除 ----------
  pushOut({ id } = {}) {
    const ss = this.s.session;
    const t = this.need(id || ss.taskId);
    if (this.isParent(t) || t.state !== 'todo') throw new Error('只有 to-do 里的可执行任务可以推出');
    const current = ss.taskId === t.id;
    if (current && ss.phase === 'running') {
      this._stopClock(this.now());
      t.state = 'pending';
      this.emit('pushed_out', { started: true });
      this._endRun(t, 'pushout'); // 未提交草稿在这里丢弃，已提交的想法留待回顾
    } else {
      t.state = 'pending';
      this.emit('pushed_out', { started: t.started });
      if (current && ss.phase === 'ready') this._loadNext();
    }
  }

  returnToTodo({ id }) {
    const t = this.need(id);
    if (this.isParent(t) || t.state !== 'pending') throw new Error('只有 pending 里的任务可以送回');
    const r = this.s.session.review;
    if (r && r.taskId === id) throw new Error('先回顾完这项任务的想法');
    t.state = 'todo'; // order 未变，回到原位置；按剩余时长继续或按原时长首次开始
    this.emit('returned_to_todo', { started: t.started });
  }

  _cancelLeaf(t) {
    if (t.state === 'completed' || t.state === 'cancelled') return;
    const ss = this.s.session;
    const current = ss.taskId === t.id;
    if (current && ss.phase === 'running') this._stopClock(this.now());
    t.state = 'cancelled';
    t.cancelledAt = this.now();
    if (current && ss.phase === 'running') this._endRun(t, 'cancel');
    else if (current && ss.phase === 'ready') this._loadNext();
  }

  cancelTask({ id }) {
    const t = this.need(id);
    if (this.isParent(t)) {
      if (this.status(t) === 'completed') throw new Error('已完成的任务不能取消');
      t.cancelledExplicit = true;
      t.cancelledAt = this.now();
      for (const k of this.kids(id)) this._cancelLeaf(k); // 只影响未完成子项
    } else {
      if (t.state === 'completed') throw new Error('已完成的任务不能取消');
      if (t.state === 'cancelled') return;
      this._cancelLeaf(t);
    }
    this.emit('task_cancelled', {});
  }

  /** 删除：清除任务与想法（正文、时刻、统计）；历史计时、完成数、已得积分保留。 */
  deleteTask({ id }) {
    const t = this.need(id);
    const ids = new Set([id, ...this.kids(id).map((k) => k.id)]);
    const parent = t.parentId ? this.task(t.parentId) : null;
    const parentStatusBefore = parent ? this.status(parent) : null;
    const ss = this.s.session;
    const hitRun = (ss.phase === 'running' || ss.phase === 'ready') && ids.has(ss.taskId);
    const hitReview = ss.phase === 'review' && ids.has(ss.review.taskId);
    if (hitRun && ss.phase === 'running') this._stopClock(this.now());

    this.s.tasks = this.s.tasks.filter((x) => !ids.has(x.id));
    this.s.thoughts = this.s.thoughts.filter((x) => !ids.has(x.taskId));

    if (parent && !this.isParent(parent)) {
      // 子项全部删除：父任务回到独立任务形态，保持删除前所在的状态页
      parent.state = parent.cancelledExplicit ? 'cancelled' : (parentStatusBefore === 'pending' ? 'todo' : parentStatusBefore);
      if (parent.state === 'completed') parent.completedAt = this.now();
      if (parent.state === 'cancelled') parent.cancelledAt = parent.cancelledAt ?? this.now();
      parent.started = parent.state !== 'todo';
      parent.remainingMs = parent.state === 'todo' ? parent.plannedMin * 60000 : 0;
    }
    if (hitRun || hitReview) {
      if (hitReview) this.emit('review_ended_by_delete', {});
      this._loadNext();
    }
    this.emit('task_deleted', { count: ids.size });
  }

  // ---------- 恢复与保存失败 ----------
  /** 启动时调用：上次若非正常退出，回到最后保存点并提示。 */
  recoverOnBoot() {
    const ss = this.s.session;
    if (ss.phase !== 'running') { ss.thoughtOpenAt = null; return false; }
    const unclean = ss.runningSince != null || ss.thoughtOpenAt != null;
    if (!unclean) return false;
    const savedAt = ss.lastTickAt ?? ss.runningSince ?? ss.thoughtOpenAt;
    this._stopClock(savedAt);
    ss.thoughtOpenAt = null; // 只恢复已提交的想法
    ss.paused = true;
    ss.notice = { type: 'recovered', at: savedAt };
    return true;
  }
  saveFailed() {
    if (this.saveError) return;
    this.saveError = true;
    const ss = this.s.session;
    if (ss.phase === 'running') { this._stopClock(this.now()); ss.paused = true; }
  }
  saveRecovered() { this.saveError = false; } // 仍保持暂停，由用户继续
  dismissNotice() { this.s.session.notice = null; }

  // ---------- 猫与积分 ----------
  claimDaily() {
    const now = this.now();
    return this._award(`daily:${dayKey(now)}`, C.DAILY_REWARD, 'daily', now);
  }
  feedCat() {
    if (this.balance() < C.FEED_COST) throw new Error('积分不够，完成一次计时或明天再来');
    const now = this.now();
    this.s.ledger.push({ key: `feed:${this.uid()}`, delta: -C.FEED_COST, at: now, kind: 'feed' });
    this.s.cat.lastFedAt = now;
    this.emit('cat_fed', {});
  }

  setSetting({ key, value }) {
    if (!(key in this.s.settings)) throw new Error('未知设置');
    this.s.settings[key] = value;
  }
}

module.exports = { Engine, emptyState, emptySession, CATEGORIES, C, dayKey };
