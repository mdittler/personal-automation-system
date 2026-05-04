import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, applyMigrations, openWithPragmas } from '../schema.js';

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
		for (const db of dbs) {
			try {
				db.close();
			} catch {}
		}
		dbs.length = 0;
		for (const f of tmpFiles) {
			for (const suffix of ['', '-wal', '-shm']) {
				try {
					rmSync(f + suffix);
				} catch {}
			}
		}
		tmpFiles.length = 0;
	});

	it('applies schema from empty DB idempotently', () => {
		const db = makeDb();
		applyMigrations(db);
		applyMigrations(db); // second call is no-op
		const version = db.pragma('user_version', { simple: true });
		expect(version).toBe(SCHEMA_VERSION);
		// Tables exist
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table'")
			.all()
			.map((r: any) => r.name);
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
		db.pragma('user_version = 999');
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
		db.prepare(
			"INSERT INTO sessions(id,user_id,source,started_at) VALUES('s1','u1','telegram','2026-01-01T00:00:00Z')",
		).run();
		db.prepare(
			"INSERT INTO messages(session_id,turn_index,role,content,timestamp) VALUES('s1',0,'user','hello','2026-01-01T00:00:01Z')",
		).run();
		db.prepare("DELETE FROM sessions WHERE id='s1'").run();
		const count = db
			.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id='s1'")
			.get() as any;
		expect(count.c).toBe(0);
	});

	// C.1 — fresh DB includes parent_session_id TEXT NULL column
	it('P8c — fresh DB has a parent_session_id TEXT NULL column', () => {
		const db = makeDb(makeTmpPath());
		applyMigrations(db);
		const cols = db
			.prepare("PRAGMA table_info('sessions')")
			.all() as Array<{ name: string; type: string; notnull: number }>;
		const col = cols.find((c) => c.name === 'parent_session_id');
		expect(col).toBeDefined();
		expect(col!.type).toBe('TEXT');
		expect(col!.notnull).toBe(0);
	});

	// C.2 — v1→v2 migration preserves existing row and adds column
	it('P8c — migrates existing v1 DB: ALTER adds column AND preserves rows', () => {
		const dbPath = makeTmpPath();
		// Seed a real v1 DB by hand
		const v1 = new Database(dbPath);
		v1.exec(
			`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      household_id TEXT, source TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, model TEXT, title TEXT)`,
		);
		v1.prepare(
			'INSERT INTO sessions (id, user_id, source, started_at) VALUES (?, ?, ?, ?)',
		).run('20260101_010101_deadbeef', 'u1', 'telegram', '2026-01-01T01:01:01.000Z');
		v1.pragma('user_version = 1');
		v1.close();

		// Open via applyMigrations — should upgrade to v2
		const db = makeDb(dbPath);
		applyMigrations(db);
		const cols = db
			.prepare("PRAGMA table_info('sessions')")
			.all() as Array<{ name: string }>;
		expect(cols.find((c) => c.name === 'parent_session_id')).toBeDefined();
		expect(db.pragma('user_version', { simple: true })).toBe(2);

		// Existing row survived; parent_session_id is NULL
		const row = db
			.prepare('SELECT id, parent_session_id FROM sessions WHERE id = ?')
			.get('20260101_010101_deadbeef') as { id: string; parent_session_id: string | null };
		expect(row).toBeDefined();
		expect(row.id).toBe('20260101_010101_deadbeef');
		expect(row.parent_session_id).toBeNull();
	});

	// C.3 — btree index exists for lineage queries
	it('P8c — sessions_parent_session btree index exists', () => {
		const db = makeDb(makeTmpPath());
		applyMigrations(db);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
			.all() as Array<{ name: string }>;
		expect(indexes.map((r) => r.name)).toContain('sessions_parent_session');
	});
});
