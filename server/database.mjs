import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const derive = promisify(scrypt);
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const ROLES = new Set(['admin', 'dispatcher', 'readonly']);

export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(username)) {
    throw new Error('用户名须为 3–64 位字母、数字、点、横线或下划线。');
  }
  return username.toLowerCase();
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) {
    throw new Error('密码须为 16–1024 个字符。');
  }
  const salt = randomBytes(32);
  const hash = await derive(password, salt, 64, scryptOptions);
  return `scrypt-v1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const parts = String(encoded).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt-v1' || !/^[a-f0-9]{64}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = await derive(password, Buffer.from(parts[1], 'hex'), expected.length, scryptOptions);
  return timingSafeEqual(expected, actual);
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','dispatcher','readonly')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS workspace (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL CHECK(version >= 0),
      state TEXT,
      updated_at TEXT,
      updated_by TEXT
    ) STRICT;
    INSERT OR IGNORE INTO workspace(id, version) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      version INTEGER,
      details TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}

export function appendAudit(db, actor, action, details = {}, version = null) {
  db.prepare('INSERT INTO audit(at,actor,action,version,details) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), actor, action, version, JSON.stringify(details));
}

export async function setUser(db, username, password, role, actor = 'local-administrator') {
  const name = validateUsername(username);
  if (!ROLES.has(role)) throw new Error('角色仅支持 admin、dispatcher 或 readonly。');
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT role,enabled FROM users WHERE username=?').get(name);
    if (existing?.role === 'admin' && existing.enabled && role !== 'admin' &&
        db.prepare("SELECT count(*) AS total FROM users WHERE role='admin' AND enabled=1").get().total <= 1) {
      throw new Error('不能降级最后一个启用的管理员。');
    }
    db.prepare(`INSERT INTO users(username,password_hash,role,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)
      ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,role=excluded.role,enabled=1,updated_at=excluded.updated_at`)
      .run(name, passwordHash, role, now, now);
    db.prepare('DELETE FROM sessions WHERE username=?').run(name);
    appendAudit(db, actor, existing ? 'user.updated' : 'user.created', { username: name, role });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { username: name, role };
}

export function disableUser(db, username) {
  const name = validateUsername(username);
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT role,enabled FROM users WHERE username=?').get(name);
    if (!user) throw new Error('未找到该用户。');
    if (user.role === 'admin' && user.enabled && db.prepare("SELECT count(*) AS total FROM users WHERE role='admin' AND enabled=1").get().total <= 1) {
      throw new Error('不能停用最后一个启用的管理员。');
    }
    db.prepare('UPDATE users SET enabled=0,updated_at=? WHERE username=?').run(new Date().toISOString(), name);
    db.prepare('DELETE FROM sessions WHERE username=?').run(name);
    appendAudit(db, 'local-administrator', 'user.disabled', { username: name });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
