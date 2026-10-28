'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

// Minimal DOM surface for exercising the real dispatch event handlers. It is
// deliberately not used to claim any browser/layout verification.
function harness({ session = storage(), dispatchVersion = 'v8' } = {}) {
  const nodes = new Map();
  function node(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const classes = new Set();
    const element = {
      innerHTML: '', textContent: '', value: '', scrollTop: 0, hidden: false, dataset: {}, events: {}, disabled: false,
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), toggle: (x, force) => force === false ? classes.delete(x) : classes.add(x) },
      setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn; },
      querySelector: child => node(child), querySelectorAll: () => [], closest: () => element,
    };
    nodes.set(selector, element);
    return element;
  }
  const context = {
    console, Intl, Date, dispatchEvent() {},
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    localStorage: storage(), sessionStorage: session,
    document: { addEventListener() {}, querySelector: node, querySelectorAll: () => [] },
    location: { hash: '' }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => fn(),
  };
  context.window = context;
  vm.createContext(context);
  for (const name of ['seed.js', 'scenario.js', 'core.js', 'timezone.js', 'services.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'v8', name), 'utf8'), context, { filename: name });
  }
  vm.runInContext(fs.readFileSync(path.join(root, dispatchVersion, 'dispatch.js'), 'utf8'), context, { filename: `${dispatchVersion}/dispatch.js` });
  const H = context.HH;
  H.pages.dispatch();
  function mount() { H.mounts.dispatch(); }
  function click(dataset) {
    const button = { dataset, disabled: false };
    node('.dx').events.click({ target: { closest: () => button } });
  }
  return { H, context, node, mount, click, session };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('five estimation parameters and useful filters survive a complete reload', () => {
  const a = harness();
  Object.assign(a.H.dispatchView.state, {
    factor: 1.63, speed: 58, handling: 37, buffer: 16, breakMins: 48,
    status: 'pending', range: '30', endpoint: 'L3', path: 'B', query: 'Dallas',
    scope: 'national', mobile: 'plan', tab: 'detail', detail: 'H26001',
    view: { center: [33, -97], zoom: 9 },
  });
  a.H.dispatchView.state.visible.cities = false;
  a.H.dispatchView.remember();
  assert.equal(a.session.getItem('haha-v7-map'), null);
  const b = harness({ session: a.session });
  const d = b.H.dispatchView.state;
  for (const key of ['factor', 'speed', 'handling', 'buffer', 'breakMins', 'status', 'range', 'endpoint', 'path', 'query', 'scope', 'mobile', 'tab', 'detail']) {
    assert.equal(d[key], a.H.dispatchView.state[key], key);
  }
  assert.deepEqual(plain(d.view), { center: [33, -97], zoom: 9 });
  assert.equal(d.visible.cities, false);
});

test('malformed storage and out-of-range restored parameters fall back safely', () => {
  const session = storage({ 'haha-v8-map': JSON.stringify({ factor: 0, speed: 999, handling: -2, buffer: 'bad', breakMins: null, mode: 'live', status: 'unknown', selected: ['H26001', 'removed-order'], view: { center: [999, 999], zoom: 100 } }) });
  const { H } = harness({ session });
  const d = H.dispatchView.state;
  assert.deepEqual([d.factor, d.speed, d.handling, d.buffer, d.breakMins], [1.28, 45, 25, 10, 30]);
  assert.equal(d.mode, 'draft');
  assert.equal(d.status, '');
  assert.equal(d.view, null);
  assert.deepEqual([...d.selected], ['H26001']);
  assert.doesNotThrow(() => harness({ session: storage({ 'haha-v8-map': '{broken' }) }));
});

test('default queue is scoped to the departure warehouse; national mode preserves the wider dataset', () => {
  const { H } = harness();
  const local = H.dispatchView.visibleOrders();
  assert.ok(local.length > 0);
  assert.ok(local.every(o => o.warehouse === H.dispatchView.state.warehouse));
  H.dispatchView.state.scope = 'national';
  const national = H.dispatchView.visibleOrders();
  assert.ok(national.length > local.length);
  assert.ok(national.some(o => o.warehouse !== H.dispatchView.state.warehouse));
});

test('V8 retains the V7 solver result for the seeded four-stop route', () => {
  const a = harness();
  const b = harness({ dispatchVersion: 'v7' });
  const ids = ['H26001', 'H26002', 'H26004', 'H26012'];
  for (const mode of ['draft', 'validated']) {
    const config = { ...a.H.dispatchView.config(), mode };
    const actual = a.H.dispatchEngine.solve(a.H.state, ids, config);
    const expected = b.H.dispatchEngine.solve(b.H.state, ids, config);
    assert.deepEqual(plain(actual), plain(expected));
    assert.equal(actual.stops.length, 4);
    assert.equal(actual.distanceKm, 183.19);
    assert.equal(actual.duration, 522);
    assert.equal(actual.cost, 926.29);
  }
});

test('draft exposes missing evidence while validated mode blocks the same order', () => {
  const { H } = harness();
  const order = H.order('H26001');
  order.checks.budget = false;
  const draft = H.dispatchEngine.solve(H.state, [order.id], H.dispatchView.config());
  assert.deepEqual(plain(draft.orderIds), [order.id]);
  assert.ok(draft.pending[0].reasons.some(reason => reason.includes('费用权限')));
  const checked = H.dispatchEngine.solve(H.state, [order.id], { ...H.dispatchView.config(), mode: 'validated' });
  assert.equal(checked.stops.length, 0);
  assert.ok(checked.rejected[0].reasons.some(reason => reason.includes('费用权限')));
});

test('validated planning still rejects broken serial locks and duplicate serial allocations', () => {
  const { H } = harness();
  const order = H.order('H26001');
  H.state.inventory.find(i => i.serial === order.serial).orderId = 'another-order';
  H.order('H26002').serial = order.serial;
  const result = H.dispatchEngine.solve(H.state, [order.id], { ...H.dispatchView.config(), mode: 'validated' });
  assert.equal(result.stops.length, 0);
  assert.ok(result.rejected[0].reasons.some(reason => reason.includes('锁定关系无效')));
  assert.ok(result.rejected[0].reasons.some(reason => reason.includes('重复分配')));
});

test('supplier capability and time-window constraints remain enforced', () => {
  const { H } = harness();
  const order = H.order('H26001');
  const supplier = H.state.suppliers.find(s => s.id === H.dispatchView.state.supplier);
  supplier.pausedTypes = ['T2'];
  let result = H.dispatchEngine.solve(H.state, [order.id], H.dispatchView.config());
  assert.equal(result.stops.length, 0);
  assert.ok(result.rejected[0].reasons.some(reason => reason.includes('能力已暂停')));
  supplier.pausedTypes = [];
  order.windowStart = 540; order.windowEnd = 545;
  result = H.dispatchEngine.solve(H.state, [order.id], H.dispatchView.config());
  assert.equal(result.stops.length, 0);
  assert.ok(result.rejected[0].reasons.some(reason => reason.includes('收货窗')));
});

test('a changed order version blocks saving a stale plan through the real save action', () => {
  const h = harness(); h.mount(); h.click({ action: 'plan' });
  assert.equal(h.H.dispatchView.state.result.stops.length, 4);
  h.H.order('H26001').version += 1;
  h.click({ action: 'save' });
  assert.equal(h.H.state.batches.length, 0);
  assert.equal(h.H.dispatchView.state.result, null);
  assert.match(h.node('#toast').textContent, /数据已变化/);
});

test('draft saving does not reserve resources; validated saving creates only a local simulated batch', () => {
  const draft = harness(); draft.mount(); draft.click({ action: 'plan' }); draft.click({ action: 'save' });
  assert.equal(draft.H.state.batches.length, 1);
  assert.equal(draft.H.state.batches[0].mode, 'draft');
  assert.equal(draft.H.dispatchEngine.activeBatch(draft.H.state.batches[0]), false);
  const checked = harness(); checked.mount(); checked.click({ action: 'validate' }); checked.click({ action: 'save' });
  const batch = checked.H.state.batches[0];
  assert.equal(batch.status, '模拟待复核');
  assert.equal(batch.mode, 'validated');
  assert.match(batch.id, /^B8-/);
  assert.equal(checked.H.dispatchEngine.activeBatch(batch), true);
  const conflict = checked.H.dispatchEngine.solve(checked.H.state, ['H26001'], { ...checked.H.dispatchView.config(), mode: 'validated' });
  assert.match(conflict.error, /已有有效模拟批次/);
});

test('data replacement invalidates the old plan and repairs stale selections and resource IDs', () => {
  const { H } = harness();
  const d = H.dispatchView.state;
  d.result = { stops: [{ id: 'removed' }] }; d.fingerprint = 'old';
  d.selected.add('removed'); d.detail = 'removed'; d.warehouse = 'missing'; d.vehicle = 'missing'; d.supplier = 'missing';
  H.dispatch.resetForDataChange();
  assert.equal(d.result, null); assert.equal(d.fingerprint, null); assert.equal(d.detail, null);
  assert.equal(d.selected.has('removed'), false);
  assert.ok(H.state.warehouses.some(w => w.id === d.warehouse));
  assert.ok(H.state.vehicles.some(v => v.id === d.vehicle && v.warehouse === d.warehouse));
  assert.ok(H.state.suppliers.some(s => s.id === d.supplier));
});
