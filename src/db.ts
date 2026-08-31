import { DatabaseSync } from "node:sqlite";

/**
 * Dev uses Node's built-in SQLite. The schema is written to be portable
 * to PostgreSQL for production with minimal changes.
 */
export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,               -- internal UUID
      player_code   TEXT NOT NULL UNIQUE,           -- public, permanent, e.g. PC-8K3F9Q
      email         TEXT NOT NULL UNIQUE,           -- normalized lowercase
      display_name  TEXT NOT NULL UNIQUE,           -- set once, locked
      password_hash TEXT,                           -- NULL if passwordless only
      role          TEXT NOT NULL DEFAULT 'player', -- player | admin
      chips         INTEGER NOT NULL DEFAULT 0,     -- play-money balance
      created_at    TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      email       TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      purpose     TEXT NOT NULL,                    -- login | signup
      expires_at  TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (email, purpose)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id   TEXT,
      ip          TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS clubs (
      id          TEXT PRIMARY KEY,
      club_code   TEXT NOT NULL UNIQUE,     -- public join code, e.g. CL-7XK2QF
      name        TEXT NOT NULL,
      description TEXT,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      join_mode   TEXT NOT NULL DEFAULT 'approval', -- open | approval | invite_only
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS club_members (
      club_id     TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'member',   -- owner | manager | member
      joined_at   TEXT NOT NULL,
      PRIMARY KEY (club_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS club_join_requests (
      club_id     TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message     TEXT,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (club_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS club_invites (
      club_id     TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- invitee
      invited_by  TEXT NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL,
      PRIMARY KEY (club_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_members_user ON club_members(user_id);

    CREATE TABLE IF NOT EXISTS tables (
      id           TEXT PRIMARY KEY,
      club_id      TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      small_blind  INTEGER NOT NULL,
      big_blind    INTEGER NOT NULL,
      min_buyin    INTEGER NOT NULL,
      max_buyin    INTEGER NOT NULL,
      max_seats    INTEGER NOT NULL DEFAULT 9,
      created_by   TEXT NOT NULL REFERENCES users(id),
      status       TEXT NOT NULL DEFAULT 'open',    -- open | closed
      created_at   TEXT NOT NULL,
      closed_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS hands (
      id           TEXT PRIMARY KEY,
      table_id     TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      club_id      TEXT NOT NULL,
      hand_no      INTEGER NOT NULL,
      pot          INTEGER NOT NULL,
      rake         INTEGER NOT NULL,
      board        TEXT NOT NULL,                   -- e.g. "Ks 9h 2c 9c 9s"
      winners      TEXT NOT NULL,                   -- JSON
      players      TEXT NOT NULL,                   -- JSON: [{playerCode, holeCards, net}]
      played_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hands_table ON hands(table_id);
    CREATE INDEX IF NOT EXISTS idx_hands_played ON hands(played_at);

    -- Platform rake ledger: one row per hand that took rake. Admin-only.
    CREATE TABLE IF NOT EXISTS rake_ledger (
      id           TEXT PRIMARY KEY,
      hand_id      TEXT NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
      table_id     TEXT NOT NULL,
      club_id      TEXT NOT NULL,
      amount       INTEGER NOT NULL,
      collected_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rake_table ON rake_ledger(table_id);
    CREATE INDEX IF NOT EXISTS idx_rake_club ON rake_ledger(club_id);
    CREATE INDEX IF NOT EXISTS idx_rake_time ON rake_ledger(collected_at);
  `);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function plusMinutes(mins: number): string {
  return new Date(Date.now() + mins * 60_000).toISOString();
}

export function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
