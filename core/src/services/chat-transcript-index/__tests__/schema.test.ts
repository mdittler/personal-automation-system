import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, openWithPragmas, SCHEMA_VERSION } from '../schema.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

describe('ChatTranscriptIndex schema', () => {
  const dbs: Database.Database[] = [];
  const tmpFiles: string[] = [];

  function makeDb(path?: string): Database.Database {
    const db = new Database(path ?? ':memory:');
    dbs.push(db);
    return db;
  }

  function makeTmpPath(): string {
    const p = join(tmpdir(), `schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    dbs.forEach(db => { try { db.close(); } catch {} });
    dbs.length = 0;
    tmpFiles.forEach(f => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(f + suffix); } catch {}
      }
    });
    tmpFiles.length = 0;
  });

  it('applies schema from empty DB idempotently', () => {
    const db = makeDb();
    applyMigrations(db);
    applyMigrations(db); // second call is no-op
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
    // Tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toContain('sessions');
    expect(tables).toContain('messages');
    expect(tables).toContain('messages_fts');
  });

  it('is idempotent when user_version already matches', () => {
    const db = makeDb();
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });

  it('throws on unknown future user_version', () => {
    const db = makeDb();
    db.pragma(`user_version = 999`);
    expect(() => applyMigrations(db)).toThrow(/newer than supported/);
  });

  it('sets foreign_keys and journal_mode PRAGMAs on a file-backed connection', () => {
    // WAL mode requires a file-backed DB (not :memory:)
    const db = makeDb(makeTmpPath());
    openWithPragmas(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const jm = db.pragma('journal_mode', { simple: true });
    expect(jm).toBe('wal');
  });

  it('sets foreign_keys PRAGMA on an in-memory connection', () => {
    // journal_mode stays 'memory' for :memory: DBs — just verify foreign_keys
    const db = makeDb();
    openWithPragmas(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('foreign_keys ON enables cascade delete', () => {
    const db = makeDb();
    applyMigrations(db);
    db.prepare("INSERT INTO sessions(id,user_id,source,started_at) VALUES('s1','u1','telegram','2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO messages(session_id,turn_index,role,content,timestamp) VALUES('s1',0,'user','hello','2026-01-01T00:00:01Z')").run();
    db.prepare("DELETE FROM sessions WHERE id='s1'").run();
    const count = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id='s1'").get() as any;
    expect(count.c).toBe(0);
  });
});
