import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { createApp } from '../server/server.mjs';
import { setUser } from '../server/database.mjs';

const password = 'integration-test-only-password-8';
const allowedOrigin = 'https://cscpengyuyan.github.io';
const state = { schema: 7, orders: [{ id: 'H-TEST-1', customer: '测试客户', version: 1 }], inventory: [],
  inbound: [], suppliers: [], warehouses: [], models: [], vehicles: [], batches: [], risks: [], messages: [], forms: [], audit: [],
  settings: {}, cost: {}, customExtension: { futureField: 'retained' } };

async function listen(options) {
  const app = await createApp(options);
  await new Promise((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolveListen);
  });
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}` };
}

async function request(app, path, { method = 'GET', body, token, origin = allowedOrigin, raw, headers = {} } = {}) {
  const response = await fetch(app.url + path, { method, headers: {
    ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), ...headers
  }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
}

async function login(app, username = 'admin', pass = password) {
  const response = await request(app, '/api/v1/session', { method: 'POST', body: { username, password: pass } });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.token;
}

test('backend HTTP integration: authorization, sync, audit, limits, persistence and backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'haha-server-test-'));
  const databasePath = join(directory, 'workspace.sqlite');
  let app = await listen({ databasePath, adminPassword: password, allowedOrigins: [allowedOrigin] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let adminToken;

  await t.test('health reports actual capabilities and does not expose workspace', async () => {
    const result = await request(app, '/api/v1/health');
    assert.equal(result.status, 200);
    assert.equal(result.data.capabilities.workspaceSync, true);
    assert.equal(result.data.capabilities.attachments, false);
    assert.equal(result.data.capabilities.sms, false);
    assert.equal(result.data.capabilities.truckRouting, false);
    assert.equal(result.data.capabilities.orderScopedAccess, false);
    assert.equal(result.data.state, undefined);
    assert.equal((await request(app, '/api/v1/workspace')).status, 401);
  });

  await t.test('CORS permits only exact configured origins and supported headers', async () => {
    const allowed = await request(app, '/api/v1/health');
    assert.equal(allowed.headers.get('access-control-allow-origin'), allowedOrigin);
    const blocked = await request(app, '/api/v1/health', { origin: 'https://evil.example' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
    const preflight = await request(app, '/api/v1/workspace', { method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type'
    } });
    assert.equal(preflight.status, 204);
    assert.equal((await request(app, '/api/v1/workspace', { method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-unknown'
    } })).status, 403);
  });

  await t.test('login uses generic failure, issued tokens are not stored in plaintext', async () => {
    const failed = await request(app, '/api/v1/session', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
    assert.equal(failed.status, 401);
    assert.equal(failed.data.error.code, 'INVALID_CREDENTIALS');
    adminToken = await login(app);
    assert.equal(adminToken.length, 43);
    const session = app.db.prepare('SELECT token_hash FROM sessions').get();
    assert.notEqual(session.token_hash, adminToken);
    assert.match(session.token_hash, /^[a-f0-9]{64}$/);
    const user = app.db.prepare('SELECT password_hash FROM users').get();
    assert.match(user.password_hash, /^scrypt-v1:/);
    assert.equal(user.password_hash.includes(password), false);
    const identity = await request(app, '/api/v1/session', { token: adminToken });
    assert.deepEqual(identity.data.user, { username: 'admin', role: 'admin' });
  });

  await t.test('state sync preserves unknown fields and prevents stale overwrites', async () => {
    const empty = await request(app, '/api/v1/workspace', { token: adminToken });
    assert.equal(empty.data.version, 0);
    assert.equal(empty.data.state, null);
    const first = await request(app, '/api/v1/workspace', { method: 'PUT', token: adminToken, body: { version: 0, state } });
    assert.equal(first.status, 200);
    assert.equal(first.data.version, 1);
    const second = await request(app, '/api/v1/workspace', { method: 'PUT', token: adminToken, body: { version: 0, state: { ...state, orders: [] } } });
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'VERSION_CONFLICT');
    assert.equal(second.data.currentVersion, 1);
    const read = await request(app, '/api/v1/workspace', { token: adminToken });
    assert.deepEqual(read.data.state, state);
  });

  await t.test('readonly role is enforced by the server and dispatcher can write', async () => {
    await setUser(app.db, 'viewer', password, 'readonly');
    await setUser(app.db, 'operator', password, 'dispatcher');
    const viewerToken = await login(app, 'viewer');
    assert.equal((await request(app, '/api/v1/workspace', { token: viewerToken })).status, 200);
    const blocked = await request(app, '/api/v1/workspace', { method: 'PUT', token: viewerToken, body: { version: 1, state } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'READ_ONLY');
    const operatorToken = await login(app, 'operator');
    const changed = await request(app, '/api/v1/workspace', { method: 'PUT', token: operatorToken, body: { version: 1, state } });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.version, 2);
    assert.equal(changed.data.updatedBy, 'operator');
  });

  await t.test('imports reject prototype keys, executable markup, duplicate IDs and invalid schema', async () => {
    for (const badState of [
      { ...state, schema: 8 },
      { ...state, orders: [{ id: 'same' }, { id: 'same' }] },
      { ...state, inventory: [{ serial: 'DUPLICATE' }, { serial: 'DUPLICATE' }] },
      { ...state, orders: [{ id: 'MISSING-REF', warehouse: 'UNKNOWN' }] },
      { ...state, inventory: [{ serial: 'NEW', orderId: 'UNKNOWN' }] },
      { ...state, batches: [{ id: 'B-1', orderIds: ['UNKNOWN'] }] },
      { ...state, settings: null },
      { ...state, customExtension: { text: '<img src=x onerror=alert(1)>' } },
      { ...state, inventory: 'invalid' }
    ]) {
      assert.equal((await request(app, '/api/v1/workspace', { method: 'PUT', token: adminToken, body: { version: 2, state: badState } })).status, 400);
    }
    const poisonedState = { ...state, extra: JSON.parse('{"__proto__":{"polluted":true}}') };
    const poisoned = await request(app, '/api/v1/workspace', { method: 'PUT', token: adminToken,
      raw: JSON.stringify({ version: 2, state: poisonedState }) });
    assert.equal(poisoned.status, 400);
    assert.equal({}.polluted, undefined);
    assert.equal((await request(app, '/api/v1/workspace', { token: adminToken })).data.version, 2);
  });

  await t.test('the actual V8 synthetic dataset is accepted without dropping extensions', async () => {
    const context = vm.createContext({ window: {} });
    for (const file of ['seed.js', 'scenario.js']) vm.runInContext(await readFile(new URL(`../v8/${file}`, import.meta.url), 'utf8'), context);
    const seed = JSON.parse(JSON.stringify(context.window.HH_SEED));
    const result = await request(app, '/api/v1/workspace', { method: 'PUT', token: adminToken, body: { version: 2, state: seed } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.version, 3);
    const stored = await request(app, '/api/v1/workspace', { token: adminToken });
    assert.deepEqual(stored.data.state, seed);
  });

  await t.test('audit is server-authored and does not record passwords or bearer tokens', async () => {
    const result = await request(app, '/api/v1/audit?limit=100', { token: adminToken });
    assert.equal(result.status, 200);
    assert.equal(result.data.items.filter(item => item.action.startsWith('workspace.')).length, 3);
    assert.ok(result.data.items.some(item => item.actor === 'operator' && item.action === 'workspace.updated'));
    assert.equal(JSON.stringify(result.data).includes(password), false);
    assert.equal(JSON.stringify(result.data).includes(adminToken), false);
    assert.equal((await request(app, '/api/v1/audit?limit=999', { token: adminToken })).status, 400);
  });

  await t.test('login limits apply across unknown usernames and repeated account attempts', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await request(app, '/api/v1/session', { method: 'POST', body: { username: 'missing-user', password: 'invalid' } })).status, 401);
    }
    const limited = await request(app, '/api/v1/session', { method: 'POST', body: { username: 'missing-user', password: 'invalid' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });

  await t.test('logout immediately invalidates the session', async () => {
    const result = await request(app, '/api/v1/session', { method: 'DELETE', token: adminToken });
    assert.equal(result.status, 204);
    assert.equal((await request(app, '/api/v1/workspace', { token: adminToken })).status, 401);
  });

  await t.test('SQLite data survives service restart and online backup captures current version', async () => {
    await app.close();
    app = await listen({ databasePath, allowedOrigins: [allowedOrigin] });
    adminToken = await login(app);
    const stored = await request(app, '/api/v1/workspace', { token: adminToken });
    assert.equal(stored.data.version, 3);
    assert.equal(stored.data.state.schema, 7);
    assert.equal(stored.data.state.orders.length, 42);
    const backupPath = join(directory, 'backup.sqlite');
    const backup = spawnSync(process.execPath, [resolve('server/backup.mjs'), backupPath], {
      cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, HAHA_DATABASE_PATH: databasePath }
    });
    assert.equal(backup.status, 0, backup.stderr);
    const copy = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(copy.prepare('SELECT version FROM workspace').get().version, 3);
    copy.close();
  });

  await t.test('user CLI does not need a plaintext password argument and revokes old sessions', async () => {
    const cli = spawnSync(process.execPath, ['server/manage-user.mjs', 'set', 'reviewer', '--role', 'readonly'], {
      cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, HAHA_DATABASE_PATH: databasePath, HAHA_NEW_USER_PASSWORD: password }
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.includes(password), false);
    const token = await login(app, 'reviewer');
    const disable = spawnSync(process.execPath, ['server/manage-user.mjs', 'disable', 'reviewer'], {
      cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, HAHA_DATABASE_PATH: databasePath }
    });
    assert.equal(disable.status, 0, disable.stderr);
    assert.equal((await request(app, '/api/v1/workspace', { token })).status, 401);
  });
});

test('missing bootstrap password, untrusted origins, invalid JSON and oversized body fail safely', async t => {
  await assert.rejects(createApp({ databasePath: ':memory:', adminPassword: '' }), /HAHA_ADMIN_PASSWORD/);
  await assert.rejects(createApp({ databasePath: ':memory:', adminPassword: password, allowedOrigins: ['https://example.com/path'] }), /origin/);
  const app = await listen({ databasePath: ':memory:', adminPassword: password, allowedOrigins: [allowedOrigin], bodyLimit: 1024 });
  t.after(() => app.close());
  const token = await login(app);
  assert.equal((await request(app, '/api/v1/workspace', { method: 'PUT', token, raw: '{broken' })).status, 400);
  assert.equal((await request(app, '/api/v1/workspace', { method: 'PUT', token, body: { version: 0, state: { ...state, notes: 'x'.repeat(3000) } } })).status, 413);
  assert.equal((await request(app, '/api/v1/workspace', { method: 'PUT', token, raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
});
