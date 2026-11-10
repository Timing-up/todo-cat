'use strict';
// 本地 SQLite 存储。每次保存是一个事务：完成记录与发奖一起落盘，主键保证重试不重发。
const { DatabaseSync } = require('node:sqlite');
const { emptyState, emptySession } = require('../core/engine');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, category_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
  planned_min INTEGER NOT NULL, ord INTEGER NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL,
  remaining_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, cancelled_at INTEGER,
  cancelled_explicit INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
  reviewed INTEGER NOT NULL, reviewed_at INTEGER);
CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, task_id TEXT, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS completions (task_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (key TEXT PRIMARY KEY, delta INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telemetry_queue (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(SCHEMA);
    // 迁移：想法转待办的关联列
    if (!this.db.prepare('PRAGMA table_info(thoughts)').all().some((c) => c.name === 'task_created_id')) this.db.exec('ALTER TABLE thoughts ADD COLUMN task_created_id TEXT');
    this.segSaved = new Map();
    this.compSaved = new Set();
    this.ledgerSaved = new Set();
    this.failNext = false; // 测试用：模拟保存失败
  }

  load() {
    const kv = {};
    for (const r of this.db.prepare('SELECT key, value FROM kv').all()) kv[r.key] = JSON.parse(r.value);
    if (!kv.meta) return null;
    const base = emptyState();
    const state = {
      tasks: this.db.prepare('SELECT * FROM tasks').all().map((r) => ({
        id: r.id, categoryId: r.category_id, parentId: r.parent_id, title: r.title, plannedMin: r.planned_min,
        order: r.ord, state: r.state, started: !!r.started, remainingMs: r.remaining_ms, createdAt: r.created_at,
        completedAt: r.completed_at, cancelledAt: r.cancelled_at, cancelledExplicit: !!r.cancelled_explicit,
      })),
      thoughts: this.db.prepare('SELECT * FROM thoughts ORDER BY at').all().map((r) => ({
        id: r.id, taskId: r.task_id, text: r.text, at: r.at, reviewed: !!r.reviewed, reviewedAt: r.reviewed_at, taskCreatedId: r.task_created_id ?? null,
      })),
      segments: this.db.prepare('SELECT * FROM segments ORDER BY start_at').all().map((r) => ({ id: r.id, taskId: r.task_id, start: r.start_at, end: r.end_at })),
      completions: this.db.prepare('SELECT * FROM completions').all().map((r) => ({ taskId: r.task_id, at: r.at })),
      ledger: this.db.prepare('SELECT * FROM ledger ORDER BY at').all().map((r) => ({ key: r.key, delta: r.delta, at: r.at, kind: r.kind })),
      session: { ...emptySession(), ...(kv.session || {}) },
      settings: { ...base.settings, ...(kv.settings || {}) },
      cat: { ...base.cat, ...(kv.cat || {}) },
      meta: kv.meta,
    };
    for (const s of state.segments) this.segSaved.set(s.id, s.end);
    for (const c of state.completions) this.compSaved.add(c.taskId);
    for (const l of state.ledger) this.ledgerSaved.add(l.key);
    return state;
  }

  /** light=true 只写心跳需要的部分（会话与运行时段）。 */
  save(state, { light = false } = {}) {
    const db = this.db;
    const segs = state.segments.filter((s) => this.segSaved.get(s.id) !== s.end);
    const comps = state.completions.filter((c) => !this.compSaved.has(c.taskId));
    const led = state.ledger.filter((l) => !this.ledgerSaved.has(l.key));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (this.failNext) throw new Error('模拟保存失败');
      const putKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      putKv.run('session', JSON.stringify(state.session));
      const putSeg = db.prepare('INSERT INTO segments (id, task_id, start_at, end_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET end_at = excluded.end_at');
      for (const s of segs) putSeg.run(s.id, s.taskId, s.start, s.end);
      if (!light) {
        putKv.run('settings', JSON.stringify(state.settings));
        putKv.run('cat', JSON.stringify(state.cat));
        putKv.run('meta', JSON.stringify(state.meta));
        db.exec('DELETE FROM tasks; DELETE FROM thoughts;');
        const putTask = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const t of state.tasks) {
          putTask.run(t.id, t.categoryId, t.parentId, t.title, t.plannedMin, t.order, t.state, t.started ? 1 : 0,
            Math.round(t.remainingMs), t.createdAt, t.completedAt, t.cancelledAt, t.cancelledExplicit ? 1 : 0);
        }
        const putTh = db.prepare('INSERT INTO thoughts VALUES (?,?,?,?,?,?,?)');
        for (const x of state.thoughts) putTh.run(x.id, x.taskId, x.text, x.at, x.reviewed ? 1 : 0, x.reviewedAt, x.taskCreatedId ?? null);
        const putComp = db.prepare('INSERT OR IGNORE INTO completions (task_id, at) VALUES (?, ?)');
        for (const c of comps) putComp.run(c.taskId, c.at);
        const putLed = db.prepare('INSERT OR IGNORE INTO ledger (key, delta, at, kind) VALUES (?, ?, ?, ?)');
        for (const l of led) putLed.run(l.key, l.delta, l.at, l.kind);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务可能未开启 */ }
      throw e;
    }
    for (const s of segs) this.segSaved.set(s.id, s.end);
    if (!light) {
      for (const c of comps) this.compSaved.add(c.taskId);
      for (const l of led) this.ledgerSaved.add(l.key);
    }
  }

  // ---- 自愿上报的本地队列 ----
  enqueueEvent(id, payload, at) {
    this.db.prepare('INSERT OR IGNORE INTO telemetry_queue (id, payload, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(payload), at);
  }
  listEvents(limit = 100) {
    return this.db.prepare('SELECT id, payload FROM telemetry_queue ORDER BY created_at LIMIT ?').all(limit).map((r) => ({ id: r.id, payload: JSON.parse(r.payload) }));
  }
  deleteEvents(ids) {
    const del = this.db.prepare('DELETE FROM telemetry_queue WHERE id = ?');
    for (const id of ids) del.run(id);
  }
  pruneEvents(before, keep = 5000) {
    this.db.prepare('DELETE FROM telemetry_queue WHERE created_at < ?').run(before);
    this.db.prepare('DELETE FROM telemetry_queue WHERE id NOT IN (SELECT id FROM telemetry_queue ORDER BY created_at DESC LIMIT ?)').run(keep);
  }
  clearEvents() { this.db.exec('DELETE FROM telemetry_queue'); }
  countEvents() { return this.db.prepare('SELECT COUNT(*) AS n FROM telemetry_queue').get().n; }

  close() { this.db.close(); }
}

module.exports = { Store };
