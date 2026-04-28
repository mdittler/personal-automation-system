import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  household_id TEXT,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  title TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_started ON sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_household_started ON sessions(household_id, started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  turn_index UNINDEXED,
  role UNINDEXED,
  user_id UNINDEXED,
  household_id UNINDEXED,
  timestamp UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, turn_index, role, user_id, household_id, timestamp)
  SELECT NEW.rowid, NEW.content, NEW.session_id, NEW.turn_index, NEW.role,
         s.user_id, s.household_id, NEW.timestamp
  FROM sessions s WHERE s.id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
  INSERT INTO messages_fts(rowid, content, session_id, turn_index, role, user_id, household_id, timestamp)
  SELECT NEW.rowid, NEW.content, NEW.session_id, NEW.turn_index, NEW.role,
         s.user_id, s.household_id, NEW.timestamp
  FROM sessions s WHERE s.id = NEW.session_id;
END;
`;

export function applyMigrations(db: Database.Database): void {
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (currentVersion === SCHEMA_VERSION) return;
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `chat-transcript-index: DB schema version ${currentVersion} is newer than supported ${SCHEMA_VERSION}. Upgrade the application.`
    );
  }
  // Apply PRAGMAs first (must be outside transaction)
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  // Apply DDL in a transaction
  db.exec(DDL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function openWithPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}
