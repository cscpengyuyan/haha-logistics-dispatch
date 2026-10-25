/* Public static demo API. Read-only business data, browser-local route batches/forms. */
(function () {
  const S = window.V31_DEMO;
  if (!S) return;
  const KEY = 'haha_v31_public_demo_v1';
  const originalFetch = window.fetch.bind(window);
  const demoUser = { id: 'u-demo', email: 'demo@haha.local', name: '公开演示', role: 'LOGISTICS' };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { batches: S.batches || [], requests: S.requests || [], publicRequests: S.publicRequests || {} };
  }
  let store = load();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {} };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const error = (message, status = 501) => response({ error: message }, status);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : String(Date.now()) + Math.random().toString(16).slice(2));

  function activeBatchFor(orderId) {
    return (store.batches || []).find(b => b.status !== 'CANCELLED' && (b.orders || []).some(o => o.order_id === orderId)) || null;
  }
  function mapPayload() {
    return {
      ...S.map,
      orders: (S.map.orders || []).map(o => {
        const b = activeBatchFor(o.id);
        return { ...o, batch: b ? { id: b.id, batch_no: b.batch_no, type: b.type, status: b.status, total_weight_kg: b.total_weight_kg, vehicle_id: b.vehicle_id } : null };
      }),
      batches: store.batches || []
    };
  }
  function hydrateBatch(b) {
    return { ...b, orders: (b.orders || []).map(bo => {
      const d = S.details[bo.order_id]?.order;
      return { ...bo, order_no: d?.order_no || bo.order_id, status: d?.status || '', customer_name: d?.customer?.name || '', city: d?.customer?.city || '', state: d?.customer?.state || '' };
    }) };
  }

  window.fetch = async function (input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const u = new URL(raw, location.href);
    if (!u.pathname.startsWith('/api/')) return originalFetch(input, init);
    const p = u.pathname, method = String(init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch {}

    if (p === '/api/me' && method === 'GET') return response({ user: demoUser });
    if (p === '/api/auth/login' && method === 'POST') return response({ user: demoUser });
    if (p === '/api/auth/logout' && method === 'POST') return response({ ok: true });
    if (p === '/api/dashboard' && method === 'GET') return response(S.dashboard);
    if (p === '/api/orders' && method === 'GET') return response({ orders: S.orders });
    if (p === '/api/orders' && method === 'POST') return error('公开演示版为只读，不能创建正式订单。请使用本地 V3.1 服务端。');
    if (p === '/api/analytics' && method === 'GET') return response(S.analytics);
    if (p === '/api/commitments' && method === 'GET') return response({ commitments: S.commitments.commitments });
    if (p === '/api/exceptions' && method === 'GET') return response({ exceptions: S.exceptions.exceptions });
    if (p === '/api/providers' && method === 'GET') return response(S.providers);
    if (p === '/api/warehouses' && method === 'GET') return response(S.warehouses);
    if (p === '/api/vehicles' && method === 'GET') return response(S.vehicles);
    if (p === '/api/inventory' && method === 'GET') return response(S.inventory);
    if (p === '/api/map' && method === 'GET') return response(mapPayload());
    if (p === '/api/route-batches' && method === 'GET') return response({ batches: (store.batches || []).map(hydrateBatch) });
    if (p === '/api/route-batches' && method === 'POST') {
      const ids = [...new Set((body.order_ids || []).map(String))];
      if (!ids.length) return error('至少选择一个订单', 400);
      const duplicate = ids.find(id => activeBatchFor(id));
      if (duplicate) return error('订单已在批次中，不能重复加入', 409);
      const seq = (store.batches?.length || 0) + 1;
      const type = body.type || 'FINAL_DELIVERY';
      const batch = {
        id: 'batch_demo_' + uuid().slice(0, 12),
        batch_no: (type === 'TRANSFER' ? 'TRF' : 'FIN') + '-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + String(seq).padStart(3, '0'),
        type, status: 'SAVED', origin_warehouse_id: body.origin_warehouse_id || null,
        total_distance_m: Number(body.total_distance_m || 0), total_duration_s: Number(body.total_duration_s || 0),
        route_mode: body.route_mode || 'OSRM', total_weight_kg: ids.reduce((sum, id) => {
          const d = S.details[id]?.order;
          return sum + (d?.items || []).reduce((a, i) => a + Number(i.weight_kg || 0) * Number(i.qty || 1), 0);
        }, 0), vehicle_id: body.vehicle_id || null,
        orders: ids.map((id, i) => ({ order_id: id, seq: i + 1 }))
      };
      store.batches = [batch, ...(store.batches || [])];
      persist();
      return response({ batch }, 201);
    }
    const bm = p.match(/^\/api\/route-batches\/([^/]+)\/(cancel|split)$/);
    if (bm && method === 'POST') {
      const b = (store.batches || []).find(x => x.id === bm[1]);
      if (!b) return error('批次不存在', 404);
      if (bm[2] === 'cancel') {
        b.status = 'CANCELLED';
        persist();
        return response({ ok: true });
      }
      const ids = (body.order_ids || []).map(String);
      if (!ids.length) return error('请选择要拆出的订单', 400);
      const moved = b.orders.filter(o => ids.includes(o.order_id));
      if (!moved.length) return error('订单不在该批次', 400);
      b.orders = b.orders.filter(o => !ids.includes(o.order_id));
      const nb = { ...b, id: 'batch_demo_' + uuid().slice(0, 12), batch_no: 'SPL-' + Date.now(), status: 'SAVED', orders: moved };
      store.batches.unshift(nb);
      persist();
      return response({ batch: nb }, 201);
    }
    const om = p.match(/^\/api\/orders\/([^/]+)(?:\/([^/]+))?$/);
    if (om && method === 'GET' && !om[2]) {
      const d = S.details[om[1]];
      return d ? response({ order: d }) : error('订单不存在', 404);
    }
    if (om && method === 'POST') return error('公开演示版为只读，不能执行审核/承诺/派车。');
    if (p.match(/^\/api\/plans\//) && method === 'POST') return error('公开演示版为只读，不能修改履约方案。');
    if (p.match(/^\/api\/inventory\//) && method === 'POST') return error('公开演示版为只读，不能修改库存。');
    if (p === '/api/delivery-requests' && method === 'GET') return response({ requests: store.requests });
    if (p === '/api/delivery-requests' && method === 'POST') {
      const token = uuid().slice(0, 32);
      const r = {
        id: 'req_demo_' + uuid().slice(0, 10), token, customer_name: body.customer_name || '', contact: body.contact || '',
        email: body.email || '', phone: body.phone || '', address: body.address || '', city: body.city || '',
        state: String(body.state || '').toUpperCase(), zip: body.zip || '', equipment_model: body.equipment_model || 'M03',
        qty: Number(body.qty || 1), location_type: body.location_type || 'CURBSIDE', requested_date: body.requested_date || '',
        answers_json: '{}', status: 'DRAFT', version: 1, submitted_at: null, created_at: new Date().toISOString()
      };
      store.requests = [r, ...(store.requests || [])];
      store.publicRequests[token] = { ...r, answers: {}, attachments: [] };
      persist();
      const base = location.origin + location.pathname.replace(/\/$/, '');
      return response({ request: r, public_url: `${base}/delivery-requirements.html?token=${token}` }, 201);
    }
    const pr = p.match(/^\/api\/public\/request\/([a-f0-9]+)(?:\/(submit|upload))?$/);
    if (pr) {
      const r = store.publicRequests[pr[1]];
      if (!r) return error('链接无效', 404);
      if (method === 'GET' && !pr[2]) return response({ request: r });
      if (method === 'POST' && pr[2] === 'submit') {
        Object.assign(r, body, { status: 'SUBMITTED', submitted_at: new Date().toISOString(), version: (r.version || 1) + 1 });
        const list = store.requests.find(x => x.token === pr[1]);
        if (list) Object.assign(list, { status: 'SUBMITTED', submitted_at: r.submitted_at });
        persist();
        return response({ ok: true, request: r });
      }
      if (method === 'POST' && pr[2] === 'upload') return error('公开演示版不保存附件文件。');
    }
    if (p === '/api/attachments' && method === 'POST') return error('公开演示版不保存附件文件。');
    if (p.match(/^\/api\/attachments\//)) return error('演示版无附件文件。', 404);
    if (p === '/api/export' && method === 'GET') {
      return response({ ...S, batches: store.batches, requests: store.requests, exported_at: new Date().toISOString() });
    }
    return error('公开演示版不支持该操作。');
  };

  window.V31DemoExport = function () {
    const payload = { ...S, batches: store.batches, requests: store.requests, exported_at: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'haha-v31-public-demo.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('demo-mode');
    const ribbon = document.createElement('div');
    ribbon.className = 'demo-ribbon';
    ribbon.innerHTML = '<b>公开演示版</b> 数据为演示；地图/筛选/路线/批次可操作，正式业务写操作已关闭。<span>本地 V3.1 服务端才保存真实数据。</span>';
    document.body.appendChild(ribbon);
  });
})();
