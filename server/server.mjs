import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, appendAudit, setUser, hashPassword, verifyPassword } from './database.mjs';

export const DEFAULT_DATABASE = fileURLToPath(new URL('./data/workspace.sqlite', import.meta.url));
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const requiredArrays = ['orders', 'inventory', 'inbound', 'suppliers', 'warehouses', 'models', 'vehicles', 'batches', 'risks', 'messages', 'forms', 'audit'];
const maxBodyBytes = 5 * 1024 * 1024;
const capabilities = Object.freeze({ workspaceSync: true, auditLog: true, accounts: true,
  attachments: false, sms: false, truckRouting: false, orderScopedAccess: false });

class HttpError extends Error {
  constructor(status, code, message, extras = {}) { super(message); Object.assign(this, { status, code, extras }); }
}
function fail(status, code, message, extras) { throw new HttpError(status, code, message, extras); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Imports remain data. Refuse executable markup and prototype-related property names at every depth.
function validateTree(value, depth = 0, budget = { remaining: 200000 }) {
  if (depth > 30 || --budget.remaining < 0) fail(400, 'INVALID_STATE', '数据结构过深或项目过多。');
  if (typeof value === 'string') {
    if (value.length > 100000 || /<\s*\/?\s*[a-z][^>]*>/i.test(value) || /(?:javascript\s*:|data\s*:\s*text\/html)/i.test(value)) {
      fail(400, 'INVALID_STATE', '字段包含过长文本或不支持的可执行标记。');
    }
  } else if (Array.isArray(value)) {
    if (value.length > 20000) fail(400, 'INVALID_STATE', '单个数组最多允许 20000 项。');
    value.forEach(item => validateTree(item, depth + 1, budget));
  } else if (plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) fail(400, 'INVALID_STATE', '数据包含不允许的属性名称。');
      validateTree(item, depth + 1, budget);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) {
    fail(400, 'INVALID_STATE', '数值必须为有限数。');
  }
}

export function validateState(state) {
  if (!plainObject(state) || state.schema !== 7 || requiredArrays.some(key => !Array.isArray(state[key])) || !plainObject(state.settings) || !plainObject(state.cost)) {
    fail(400, 'INVALID_STATE', '需要 schema=7、完整业务集合以及 settings 和 cost 对象的完整工作区。');
  }
  validateTree(state);
  for (const key of requiredArrays) {
    if (state[key].some(row => !plainObject(row))) fail(400, 'INVALID_STATE', `${key} 中每项必须是对象。`);
  }
  const indexes = {};
  for (const collection of ['orders', 'inventory', 'models', 'warehouses', 'suppliers', 'vehicles', 'batches']) {
    const key = collection === 'inventory' ? 'serial' : 'id';
    const ids = indexes[collection] = new Set();
    for (const row of state[collection]) {
      if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 128 || ids.has(row[key])) {
        fail(400, 'INVALID_STATE', `${collection}.${key} 不能为空、重复或超过 128 个字符。`);
      }
      ids.add(row[key]);
    }
  }
  // Drafts may leave a reference empty, but a non-empty reference cannot point to a missing record.
  for (const [collection, key, target] of [
    ['orders', 'warehouse', 'warehouses'], ['orders', 'model', 'models'], ['orders', 'serial', 'inventory'],
    ['inventory', 'warehouse', 'warehouses'], ['inventory', 'model', 'models'], ['inventory', 'orderId', 'orders'],
    ['vehicles', 'warehouse', 'warehouses'], ['vehicles', 'supplier', 'suppliers'],
    ['inbound', 'warehouse', 'warehouses'], ['batches', 'warehouseId', 'warehouses'],
    ['batches', 'vehicleId', 'vehicles'], ['batches', 'supplierId', 'suppliers']
  ]) {
    for (const row of state[collection]) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== '' && (typeof value !== 'string' || !indexes[target].has(value))) {
        fail(400, 'INVALID_STATE', `${collection}.${key} 引用了不存在的 ${target} 记录。`);
      }
    }
  }
  for (const batch of state.batches) {
    if (batch.orderIds !== undefined && (!Array.isArray(batch.orderIds) || new Set(batch.orderIds).size !== batch.orderIds.length || batch.orderIds.some(id => !indexes.orders.has(id)))) {
      fail(400, 'INVALID_STATE', '批次中的订单号不存在或重复。');
    }
  }
  return state;
}

function parseOrigins(values) {
  const result = new Set();
  for (const input of values) {
    const value = input.trim();
    if (!value) continue;
    const url = new URL(value);
    if (value !== url.origin || !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('允许来源必须是完整 HTTPS origin（不带路径）；本机开发可用 HTTP localhost。');
    }
    result.add(value);
  }
  return result;
}

function readJson(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON_REQUIRED', '请使用 application/json。');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415, 'ENCODING_UNSUPPORTED', '不接受压缩请求体。');
  const declared = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(declared) || declared > limit) fail(413, 'BODY_TOO_LARGE', '请求体超过允许大小。');
  return new Promise((resolveBody, reject) => {
    const chunks = []; let bytes = 0; let failed = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) {
        if (!failed) reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体超过允许大小。'));
        failed = true; chunks.length = 0;
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!plainObject(value)) throw new Error();
        resolveBody(value);
      } catch { reject(new HttpError(400, 'INVALID_JSON', '请求必须为有效 JSON 对象。')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'REQUEST_ABORTED', '请求已中断。')));
  });
}

export async function createApp(options = {}) {
  const databasePath = options.databasePath || process.env.HAHA_DATABASE_PATH || DEFAULT_DATABASE;
  const origins = parseOrigins(options.allowedOrigins ?? (process.env.HAHA_ALLOWED_ORIGINS || '').split(','));
  const sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 24 * 60 * 60 * 1000) throw new Error('会话有效期须在 1 秒至 24 小时之间。');
  const bodyLimit = options.bodyLimit ?? maxBodyBytes;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1024 || bodyLimit > maxBodyBytes) throw new Error('请求体上限须在 1 KB 至 5 MB 之间。');
  const db = openDatabase(databasePath);
  try {
    if (db.prepare('SELECT count(*) AS count FROM users').get().count === 0) {
      const password = options.adminPassword ?? process.env.HAHA_ADMIN_PASSWORD;
      if (!password) throw new Error('首次启动必须设置 HAHA_ADMIN_PASSWORD（至少 16 个字符），没有默认密码。');
      await setUser(db, options.adminUsername || process.env.HAHA_ADMIN_USERNAME || 'admin', password, 'admin', 'bootstrap');
    }
  } catch (error) { db.close(); throw error; }
  const dummyHash = await hashPassword(randomBytes(48).toString('base64url'));
  const attempts = new Map();
  function consumeAttempt(key, max) {
    const now = Date.now();
    if (attempts.size > 10000) {
      for (const [name, value] of attempts) if (value.until <= now) attempts.delete(name);
      if (attempts.size > 10000) fail(429, 'RATE_LIMITED', '登录请求过多，请稍后重试。', { retryAfter: 60 });
    }
    let bucket = attempts.get(key);
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + 60000 }; attempts.set(key, bucket); }
    if (++bucket.count > max) fail(429, 'RATE_LIMITED', '登录尝试过多，请稍后重试。', { retryAfter: Math.max(1, Math.ceil((bucket.until - now) / 1000)) });
  }

  function auth(req) {
    const token = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) fail(401, 'UNAUTHORIZED', '请先登录。');
    const hashed = tokenHash(token);
    const row = db.prepare(`SELECT s.username,s.expires_at,u.role,u.enabled FROM sessions s
      JOIN users u ON u.username=s.username WHERE s.token_hash=?`).get(hashed);
    if (!row || !row.enabled || row.expires_at <= Date.now()) {
      if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashed);
      fail(401, 'UNAUTHORIZED', '登录已失效，请重新登录。');
    }
    return { username: row.username, role: row.role, expiresAt: new Date(row.expires_at).toISOString(), tokenHash: hashed };
  }

  function workspace() {
    const row = db.prepare('SELECT * FROM workspace WHERE id=1').get();
    return { version: row.version, state: row.state === null ? null : JSON.parse(row.state), updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Vary', 'Origin');
    const json = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!origins.has(origin)) fail(403, 'ORIGIN_FORBIDDEN', '该网站来源未获许可。');
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (req.method === 'OPTIONS') {
        if (!origin) fail(400, 'ORIGIN_REQUIRED', '预检请求缺少 Origin。');
        const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        const method = req.headers['access-control-request-method'];
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || headers.some(header => !['authorization', 'content-type'].includes(header))) fail(403, 'PREFLIGHT_FORBIDDEN', '不支持的跨域请求。');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '300');
        res.statusCode = 204; res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/api/v1/health' && req.method === 'GET') {
        json(200, { ok: true, service: 'HAHA Logistics workspace API', version: '8.0', mode: 'server', capabilities }); return;
      }
      if (path === '/api/v1/session' && req.method === 'POST') {
        consumeAttempt(`ip:${req.socket.remoteAddress || 'unknown'}`, 20);
        const body = await readJson(req, 16 * 1024);
        const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(username) || typeof body.password !== 'string' || body.password.length > 1024) fail(400, 'INVALID_LOGIN', '请填写有效的用户名和密码。');
        consumeAttempt(`user:${username}`, 5);
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        const valid = await verifyPassword(body.password, user?.password_hash || dummyHash);
        if (!valid || !user?.enabled) fail(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
        const token = randomBytes(32).toString('base64url');
        const now = Date.now(); const expires = now + sessionTtlMs;
        db.exec('BEGIN IMMEDIATE');
        try {
          // A local administrator may have changed the account while scrypt was running.
          const currentUser = db.prepare('SELECT password_hash,enabled,role FROM users WHERE username=?').get(user.username);
          if (!currentUser?.enabled || currentUser.password_hash !== user.password_hash) fail(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
          db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
          db.prepare('INSERT INTO sessions(token_hash,username,created_at,expires_at) VALUES(?,?,?,?)').run(tokenHash(token), user.username, now, expires);
          user.role = currentUser.role;
          appendAudit(db, user.username, 'session.created', { role: currentUser.role });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        json(201, { token, expiresAt: new Date(expires).toISOString(), user: { username: user.username, role: user.role } }); return;
      }
      if (!['/api/v1/session', '/api/v1/workspace', '/api/v1/audit'].includes(path)) fail(404, 'NOT_FOUND', '接口不存在。');
      const user = auth(req);
      if (path === '/api/v1/session' && req.method === 'GET') {
        json(200, { user: { username: user.username, role: user.role }, expiresAt: user.expiresAt }); return;
      }
      if (path === '/api/v1/session' && req.method === 'DELETE') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.tokenHash);
        appendAudit(db, user.username, 'session.deleted');
        res.statusCode = 204; res.end(); return;
      }
      if (path === '/api/v1/workspace' && req.method === 'GET') { json(200, workspace()); return; }
      if (path === '/api/v1/workspace' && req.method === 'PUT') {
        if (!['admin', 'dispatcher'].includes(user.role)) fail(403, 'READ_ONLY', '此账号只有查看权限。');
        const body = await readJson(req, bodyLimit);
        if (!Number.isSafeInteger(body.version) || body.version < 0) fail(400, 'VERSION_REQUIRED', '请提供读取工作区时的非负整数 version。');
        validateState(body.state);
        const payload = JSON.stringify(body.state);
        const now = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT version FROM workspace WHERE id=1').get().version;
          if (current !== body.version) fail(409, 'VERSION_CONFLICT', '其他成员已更新工作区，请先读取最新版并核对差异。', { currentVersion: current });
          const version = current + 1;
          db.prepare('UPDATE workspace SET version=?,state=?,updated_at=?,updated_by=? WHERE id=1').run(version, payload, now, user.username);
          const counts = Object.fromEntries(Object.entries(body.state).filter(([, value]) => Array.isArray(value)).map(([name, value]) => [name, value.length]));
          appendAudit(db, user.username, current === 0 ? 'workspace.initialized' : 'workspace.updated', { counts, bytes: Buffer.byteLength(payload) }, version);
          db.exec('COMMIT');
          json(200, { version, updatedAt: now, updatedBy: user.username }); return;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      if (path === '/api/v1/audit' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 50);
        const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) fail(400, 'INVALID_QUERY', 'limit 应在 1–100 之间，before 须为正整数。');
        const rows = db.prepare('SELECT id,at,actor,action,version,details FROM audit WHERE id<? ORDER BY id DESC LIMIT ?').all(before, limit + 1);
        const items = rows.slice(0, limit).map(row => ({ ...row, details: JSON.parse(row.details) }));
        json(200, { items, nextBefore: rows.length > limit ? items.at(-1).id : null }); return;
      }
      fail(405, 'METHOD_NOT_ALLOWED', '该接口不支持此方法。');
    } catch (error) {
      if (error.extras?.retryAfter) res.setHeader('Retry-After', String(error.extras.retryAfter));
      if (!(error instanceof HttpError)) options.onError?.(error);
      json(error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '服务暂时不可用，请稍后重试。' }, ...(error.extras || {}) });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  let closed = false;
  return { server, db, databasePath, async close() {
    if (closed) return;
    closed = true;
    if (server.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    db.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.umask(0o077);
    const app = await createApp({ onError: error => console.error('API error:', error.message) });
    const host = process.env.HAHA_HOST || '127.0.0.1';
    const port = Number(process.env.HAHA_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HAHA_PORT 必须是有效端口。');
    app.server.listen(port, host, () => console.log(`HAHA workspace API listening on ${host}:${port}`));
    app.server.on('error', async error => { console.error('Server error:', error.message); await app.close(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
