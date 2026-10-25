/* HAHA V3 preview admin UI */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (v) => v == null || v === '' ? '—' : `$${Number(v).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const date = (v) => v ? String(v).slice(0,10) : '—';
const dt = (v) => v ? String(v).replace('T',' ').slice(0,16) : '—';
const statusTone = (s) => ({PASS:'green',CONDITIONAL:'amber',FAIL:'red',EXPIRED:'red',PENDING:'gray',ACTIVE:'green',DRAFT:'gray',COMMITTED:'green',DISPATCHED:'teal',DELIVERED:'green',REVIEW:'amber',MIGRATION_REVIEW:'red',OPEN:'red',SUBMITTED:'teal',CONVERTED:'green',AVAILABLE:'green',RESERVED:'amber',ASSIGNED:'teal',IN_TRANSIT:'amber',RECEIVED:'green',DRAFT_COMMIT:'amber'}[s] || 'gray');
const badge = (s) => `<span class="badge ${statusTone(s)}">${esc(s || '—')}</span>`;
const modeLabels = {A_STANDARD_DIRECT:'A 标准直发',B_PROFESSIONAL_DIRECT:'B 专业直送',C_STATION_TRANSFER:'C 专业站点中转',D_FORWARD_STOCK:'D 区域前置库存'};
const roleLabels = {ADMIN:'管理员',SALES:'销售',LOGISTICS:'物流运营',WAREHOUSE:'仓库',MANAGER:'经理'};

const state = { me:null, page:'dashboard', id:null, providers:[], warehouses:[], order:null, dashboard:null, globalQuery:'', orderStatus:'', orderDate:'' };

function toast(msg, tone='') {
  const el = $('#toast'); el.textContent = msg; el.className = `toast show ${tone}`;
  clearTimeout(toast.t); toast.t = setTimeout(()=>el.className='toast', 2800);
}

async function api(path, opts={}) {
  const res = await fetch(path, { credentials:'same-origin', ...opts });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) { state.me = null; renderLogin(); }
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body;
}

function modal(title, bodyHtml, onSubmit, submitLabel='保存') {
  const div = document.createElement('div');
  div.className = 'modal-backdrop';
  div.innerHTML = `<div class="modal"><div class="modal-h"><h3>${esc(title)}</h3><button class="btn sm" data-close>关闭</button></div>
    <form id="modal-form"><div class="modal-b">${bodyHtml}</div><div class="modal-f"><button type="button" class="btn" data-close>取消</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div></form></div>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => { if (e.target === div || e.target.closest('[data-close]')) div.remove(); });
  $('#modal-form', div).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await onSubmit(fd); div.remove(); }
    catch (err) { toast(err.message, 'err'); }
  });
}

async function boot() {
  try {
    const r = await api('/api/me');
    state.me = r.user;
    await loadLookups();
    if (!location.hash) history.replaceState(null, '', '#dashboard');
    const [page, id] = location.hash.slice(1).split('/');
    state.page = page || 'dashboard'; state.id = id || null;
    renderShell();
    await loadPage();
  } catch (e) {
    if (String(e.message).includes('401') || String(e.message).includes('登录')) renderLogin();
    else { console.error(e); renderLogin(); }
  }
}

async function loadLookups() {
  const [p, w] = await Promise.all([api('/api/providers'), api('/api/warehouses')]);
  state.providers = p.providers; state.warehouses = w.warehouses;
}

function renderLogin() {
  $('#app').innerHTML = `<div class="login"><div class="login-card">
    <div class="eyebrow">HAHA LOGISTICS · V3 PREVIEW</div>
    <h1>美国末端物流运营系统</h1>
    <p>V3 预览环境 · 真实流程 / 数据库 / 权限 / 证据链</p>
    <form id="login-form">
      <label class="field">邮箱<input class="input" name="email" value="logistics@haha.local" autocomplete="username"></label>
      <div style="height:8px"></div>
      <label class="field">密码<input class="input" type="password" name="password" value="Logistics123!" autocomplete="current-password"></label>
      <div style="height:12px"></div>
      <button class="btn primary" type="submit">登录 V3 预览</button>
    </form>
    <div class="small muted" style="margin-top:14px;line-height:1.7">演示账号：<br>管理员 admin@haha.local / Admin123!<br>物流 logistics@haha.local / Logistics123!<br>销售 sales@haha.local / Sales123!<br>仓库 warehouse@haha.local / Warehouse123!</div>
  </div></div>`;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.target);
    try {
      const r = await api('/api/auth/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:fd.get('email'),password:fd.get('password')})});
      state.me = r.user; await loadLookups(); state.page='dashboard'; state.id=null; location.hash='dashboard'; renderShell(); await loadPage();
    } catch (err) { toast(err.message,'err'); }
  });
}

function navGroups() {
  const groups = [
    { label:'运营', items:[['map','美国地图调度','◎'],['dashboard','控制塔','▦'],['orders','订单中心','▤'],['commitments','交付承诺','▣'],['exceptions','异常中心','!'],['analytics','运营分析','▥']] },
    { label:'仓储与网络', items:[['inventory','库存与仓网','▦'],['suppliers','供应商与站点','◇'],['requests','客户交付需求','✎']] },
    { label:'商务', items:[['catalog','服务目录','▤']] },
    { label:'系统', items:[['settings','设置与导出','⚙'], ...(state.me?.role==='ADMIN'?[['migration','V2 数据迁移','⇄']]:[]), ['help','系统说明','?']] }
  ];
  return groups;
}

function renderShell() {
  const titles = {map:['美国地图调度','全国/州内视图 · 订单、仓网、路线与批次'],dashboard:['控制塔总览','V3.1 真实业务闭环预览'],orders:['订单中心','订单、履约方案、供应商与证据'],order:['订单详情','闸门、责任链、报价、交接与证据'],requests:['客户交付需求','英文客户表单与销售协同'],inventory:['库存与仓网','中心仓 / 站点 / 区域前置库存'],commitments:['交付承诺','正式承诺 / 草案 / 有效期'],exceptions:['异常中心','责任人 / 时限 / 订单'],analytics:['运营分析','订单结构 / 闸门 / 库存 / 批次'],suppliers:['供应商与站点','服务能力 / 仓网 / 库存'],catalog:['服务目录','履约模式 / 等级 / 报价来源'],settings:['设置与导出','数据、环境与回滚'],migration:['V2 数据迁移','旧数据映射与待处理清单'],help:['系统说明','V3.1 范围、角色与边界']};
  const [title, sub] = titles[state.page] || titles.dashboard;
  $('#app').innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="eyebrow">HAHA LOGISTICS</div><div class="name">V3.1 控制塔</div><div class="sub">美国末端 · 地图调度优先</div></div>
      <nav class="nav">${navGroups().map(g=>`<div class="nav-label">${g.label}</div>${g.items.map(([k,l,i])=>`<button class="nav-item ${state.page===k?'active':''}" data-nav="${k}"><span class="ico">${i}</span><span>${l}</span></button>`).join('')}`).join('')}</nav>
      <div class="side-foot">V3.1 preview · SQLite<br>${esc(roleLabels[state.me.role]||state.me.role)} · ${esc(state.me.name)}</div>
    </aside>
    <main class="main">
      <header class="topbar"><div><h1>${title}</h1><div class="sub">${sub}</div></div>
        <div class="topbar-right"><input class="global-search" id="global-search" placeholder="搜索订单 / 客户 / 城市 / 地址" value="${esc(state.globalQuery||'')}"><span class="badge teal">V3.1 preview</span><button class="btn sm" id="logout">退出</button></div></header>
      <div class="content" id="content"><div class="empty">加载中…</div></div>
    </main>
  </div>`;
  $$('[data-nav]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.nav)));
  $('#global-search')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { state.globalQuery = e.target.value.trim(); if (state.page !== 'orders') go('orders'); else loadPage(); }
  });
  $('#logout').addEventListener('click', async()=>{ try{await api('/api/auth/logout',{method:'POST'});}catch{} state.me=null; renderLogin(); });
}

function go(page,id=null) {
  if (page !== 'map') window.HahaMap?.destroy();
  state.page=page; state.id=id; location.hash = id ? `${page}/${id}` : page; renderShell(); loadPage();
}

async function loadPage() {
  const c = $('#content'); if (!c) return;
  c.innerHTML = '<div class="empty">加载中…</div>';
  try {
    if (state.page==='map') return window.HahaMap.render();
    if (state.page==='dashboard') return renderDashboard(await api('/api/dashboard'));
    if (state.page==='orders') return renderOrders(await api('/api/orders'));
    if (state.page==='order') return renderOrder(await api(`/api/orders/${state.id}`));
    if (state.page==='requests') return renderRequests(await api('/api/delivery-requests'));
    if (state.page==='inventory') return renderInventory(await api('/api/inventory'));
    if (state.page==='commitments') return renderCommitments(await api('/api/commitments'));
    if (state.page==='exceptions') return renderExceptions(await api('/api/exceptions'));
    if (state.page==='analytics') return renderAnalytics(await api('/api/analytics'));
    if (state.page==='suppliers') return renderSuppliers(await api('/api/providers'));
    if (state.page==='catalog') return renderCatalog();
    if (state.page==='settings') return renderSettings();
    if (state.page==='migration') return renderMigration();
    if (state.page==='help') return renderHelp();
    return renderDashboard(await api('/api/dashboard'));
  } catch (e) { c.innerHTML=`<div class="alert red">${esc(e.message)}</div>`; }
}

function renderDashboard(d) {
  state.dashboard=d;
  const week = [];
  const now = new Date();
  const local = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  for (let i=0;i<7;i++) { const x=new Date(now); x.setDate(x.getDate()+i); const iso=local(x); week.push({iso, n:(d.by_date||[]).find(z=>z.planned_date===iso)?.n||0}); }
  $('#content').innerHTML = `<div class="page-head"><div><h2>控制塔总览</h2><div class="lead">V3.1：V2 地图调度已恢复，并与 A/B/C/D 履约、库存、闸门和批次共用同一数据。</div></div><div class="actions"><button class="btn primary" data-nav="map">◎ 进入美国地图调度</button><button class="btn" data-new-order>＋ 新建订单</button><button class="btn" data-nav="requests">客户表单</button></div></div>
    <div class="grid cols-4" style="margin-bottom:12px">
      ${kpi('订单',d.orders,'全部')}${kpi('待审核',d.review,'REVIEW','warn')}${kpi('已承诺',d.committed,'formal commitment','good')}${kpi('已派车',d.dispatched,'DISPATCHED')}
      ${kpi('已交付',d.delivered,'DELIVERED','good')}${kpi('客户需求',d.requests,'已提交待处理','warn')}${kpi('可用库存',d.inventory,'AVAILABLE','good')}${kpi('开启异常',d.exceptions,'OPEN',d.exceptions?'bad':'good')}
    </div>
    <div class="card" style="margin-bottom:12px"><div class="card-h"><h3>未来 7 天计划发货</h3><span class="extra">点击日期进入地图</span></div><div class="card-b"><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">${week.map((x,i)=>`<div data-map-date="${x.iso}" style="border:1px solid ${i===0?'#BFDCE2':'var(--line)'};border-radius:8px;padding:7px 8px;cursor:pointer;background:${i===0?'#F1FAFB':'#fff'}"><div class="small muted">${i===0?'今天':['周日','周一','周二','周三','周四','周五','周六'][new Date(x.iso+'T12:00:00').getDay()]}</div><div style="font-size:18px;font-weight:800;color:var(--navy)">${x.n}</div><div class="small muted">${x.iso.slice(5)}</div></div>`).join('')}</div><div class="small muted" style="margin-top:6px">待现场审核 ${d.pending_site||0} · 待供应商确认 ${d.pending_supplier||0} · 待报价 ${d.pending_quote||0}</div></div></div>
    <div class="grid cols-3" style="margin-bottom:12px">
      <div class="card" style="background:linear-gradient(135deg,#1F3A5F,#2F6F7E);color:#fff"><div class="card-b"><div style="font-size:9px;letter-spacing:1.2px;color:#BFD6E4;font-weight:800">DISPATCH MAP</div><div style="font-size:18px;font-weight:800;margin:3px 0">美国地图调度</div><div style="font-size:10px;color:#D6E6EE">州级分布 · 州内街道 · 路线 · 批次 · 仓网</div><button class="btn sm" data-nav="map" style="margin-top:8px;background:#fff;color:#1F3A5F;border-color:#fff">打开地图 →</button></div></div>
      <div class="card"><div class="card-h"><h3>履约模式</h3><span class="extra">A/B/C/D</span></div><div class="card-b">${d.modes.length?d.modes.map(m=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line2)"><span>${esc(modeLabels[m.mode]||m.mode)}</span><b>${m.n}</b></div>`).join(''):'<div class="empty">暂无订单</div>'}</div></div>
      <div class="card"><div class="card-h"><h3>V3 预览边界</h3></div><div class="card-b small muted">V3 使用本地 Node + SQLite + 文件存储，真实多用户/权限/附件已落在服务端；尚未接真实供应商 API、CRM、EDI、GPS。V2 静态演示站保持独立，不覆盖。</div></div>
      <div class="card"><div class="card-h"><h3>快捷入口</h3></div><div class="card-b"><button class="btn sm" data-nav="orders">订单中心</button> <button class="btn sm" data-nav="inventory">区域库存</button> <button class="btn sm" data-nav="requests">客户英文表单</button></div></div>
    </div>
    <div class="card"><div class="card-h"><h3>最近订单</h3><span class="extra">按创建时间</span></div><div class="table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>模式</th><th>状态</th><th>创建</th></tr></thead><tbody>${d.recent.map(o=>`<tr data-open-order="${o.id}" style="cursor:pointer"><td><b>${esc(o.order_no)}</b></td><td>${esc(o.customer_name||'—')}</td><td>${esc(modeLabels[o.mode]||o.mode||'—')}</td><td>${badge(o.status)}</td><td>${dt(o.created_at)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无订单</td></tr>'}</tbody></table></div></div>`;
  $$('[data-open-order]').forEach(e=>e.addEventListener('click',()=>go('order',e.dataset.openOrder)));
  $$('[data-new-order]').forEach(e=>e.addEventListener('click',openNewOrder));
  $$('[data-nav]').forEach(e=>e.addEventListener('click',()=>go(e.dataset.nav)));
  $$('[data-map-date]').forEach(e=>e.addEventListener('click',()=>{
    try { sessionStorage.setItem('haha_v31_map_context', JSON.stringify({ filters:{ state:null, date:e.dataset.mapDate, range:'day', level:'', type:'', city:'' }, selected:[], selectedOrder:null })); } catch {}
    go('map');
  }));
}

function kpi(label, value, hint, tone='') {
  return `<div class="kpi ${tone}"><div class="label">${esc(label)}</div><div class="num">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;
}

function renderOrders(d) {
  const statuses = [...new Set(d.orders.map(o=>o.status))];
  const q = (state.globalQuery || '').toLowerCase();
  const filtered = d.orders.filter(o => {
    if (state.orderStatus && o.status !== state.orderStatus) return false;
    if (state.orderDate && (o.planned_date || '') !== state.orderDate) return false;
    if (q && ![o.order_no,o.customer_name,o.city,o.state].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  $('#content').innerHTML = `<div class="page-head"><div><h2>订单中心</h2><div class="lead">订单、履约模式、分段供应商、承诺与库存关联。地图中没有坐标的订单也会在此保留。</div></div><button class="btn primary" data-new-order>＋ 新建订单</button></div>
    <div class="filters"><input class="input" id="order-q" placeholder="搜索订单、客户、城市…" value="${esc(state.globalQuery||'')}" style="max-width:280px"><select class="input" id="order-status" style="max-width:140px"><option value="">全部状态</option>${statuses.map(s=>`<option value="${s}" ${state.orderStatus===s?'selected':''}>${esc(s)}</option>`).join('')}</select><input class="input" type="date" id="order-date" value="${esc(state.orderDate||'')}" style="max-width:145px"><button class="btn sm" id="order-clear">清除</button><span class="small muted">${filtered.length} / ${d.orders.length} 单</span></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>模式</th><th>状态</th><th>计划日期</th><th>城市/州</th><th>创建</th><th></th></tr></thead><tbody id="order-rows">${orderRows(filtered)}</tbody></table></div></div>`;
  const rerender = () => { const f = d.orders.filter(o => (!state.orderStatus || o.status===state.orderStatus) && (!state.orderDate || (o.planned_date||'')===state.orderDate) && (!state.globalQuery || [o.order_no,o.customer_name,o.city,o.state].join(' ').toLowerCase().includes(state.globalQuery.toLowerCase()))); $('#order-rows').innerHTML=orderRows(f); bindOrderRows(); };
  $('#order-q').addEventListener('input',e=>{ state.globalQuery=e.target.value.trim(); rerender(); });
  $('#order-status').addEventListener('change',e=>{ state.orderStatus=e.target.value; rerender(); });
  $('#order-date').addEventListener('change',e=>{ state.orderDate=e.target.value; rerender(); });
  $('#order-clear').addEventListener('click',()=>{ state.orderStatus=''; state.orderDate=''; state.globalQuery=''; $('#order-q').value=''; $('#order-status').value=''; $('#order-date').value=''; rerender(); });
  $$('[data-new-order]').forEach(e=>e.addEventListener('click',openNewOrder)); bindOrderRows();
}
function orderRows(list){ return list.map(o=>`<tr data-open-order="${o.id}" style="cursor:pointer"><td><b>${esc(o.order_no)}</b><div class="small">${esc(o.id)}</div></td><td>${esc(o.customer_name||'—')}</td><td>${esc(modeLabels[o.mode]||o.mode||'—')}</td><td>${badge(o.status)}</td><td>${esc(o.planned_date||'—')}</td><td>${esc(o.city||'')} ${esc(o.state||'')}</td><td>${dt(o.created_at)}</td><td class="right"><span class="btn sm">打开 ›</span></td></tr>`).join('')||'<tr><td colspan="8" class="empty">暂无订单</td></tr>'; }
function bindOrderRows(){ $$('[data-open-order]').forEach(e=>e.addEventListener('click',()=>go('order',e.dataset.openOrder))); }

function openNewOrder() {
  modal('新建 V3 订单', `<div class="form-grid">
    <label class="field">客户名称 *<input class="input" name="customer_name" required></label>
    <label class="field">联系人<input class="input" name="contact"></label>
    <label class="field">电话<input class="input" name="phone"></label>
    <label class="field">邮箱<input class="input" name="email"></label>
    <label class="field full">地址<input class="input" name="address"></label>
    <label class="field">城市<input class="input" name="city"></label>
    <label class="field">州<input class="input" name="state" value="TX" maxlength="2"></label>
    <label class="field">ZIP<input class="input" name="zip" value="75201"></label>
    <label class="field">设备型号<select class="input" name="model">${['M01','M02','M03','M04','M05','M06','M07'].map(x=>`<option>${x}</option>`).join('')}</select></label>
    <label class="field">数量<input class="input" type="number" name="qty" value="1" min="1"></label>
    <label class="field">履约模式<select class="input" name="mode">${Object.entries(modeLabels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
    <label class="field">计划交付日期<input class="input" type="date" name="planned_date" value="${new Date().toISOString().slice(0,10)}"></label>
    <label class="field">服务等级<select class="input" name="service_level"><option>L1</option><option>L2</option><option selected>L3</option><option>L4</option><option>L5</option></select></label>
    <label class="field">序列号<input class="input" name="serial" placeholder="可选"></label>
  </div>`, async fd => {
    const r = await api('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      customer_name:fd.get('customer_name'),contact:fd.get('contact'),phone:fd.get('phone'),email:fd.get('email'),
      address:fd.get('address'),city:fd.get('city'),state:fd.get('state'),zip:fd.get('zip'),
      mode:fd.get('mode'),equipment_model:fd.get('model'),qty:fd.get('qty'),serial:fd.get('serial'),
      planned_date:fd.get('planned_date'),service_level:fd.get('service_level')
    })});
    toast('订单已创建','ok'); go('order',r.order.id);
  }, '创建订单');
}

function renderOrder(payload) {
  const d = payload.order || payload;
  state.order = d;
  const o = d.order || d;
  const c = d.customer || {};
  const gates = d.gates || [];
  const evaln = d.gateEvaluation || {};
  const plans = d.plans || [];
  const chain = plans.find(p=>p.selected) || plans[0];
  let reqAnswers = '';
  try {
    const a = JSON.parse(d.request?.answers_json || '{}');
    reqAnswers = Object.entries(a).filter(([k,v])=>k!=='photos' && v!=='' && v!=null).map(([k,v])=>`${k}: ${v}`).join(' · ');
  } catch { reqAnswers = d.request?.answers_json || ''; }
  $('#content').innerHTML = `<div class="crumb"><span data-nav="orders">订单中心</span> / ${esc(o.order_no)}</div>
    <div class="detail-head"><div><h2>${esc(o.order_no)}</h2><div class="sub">${esc(c.name||'—')} · ${esc(c.city||'')} ${esc(c.state||'')} · ${esc(modeLabels[o.mode]||o.mode||'—')}</div></div><div class="detail-actions">${badge(o.status)}<button class="btn sm" data-nav="map">◎ 返回地图</button><button class="btn sm" data-nav="orders">返回列表</button></div></div>
    <div class="summary">
      <div class="item"><div class="k">客户</div><div class="v">${esc(c.name||'—')}</div></div>
      <div class="item"><div class="k">模式</div><div class="v">${esc(modeLabels[o.mode]||o.mode||'—')}</div></div>
      <div class="item"><div class="k">项目</div><div class="v">${(d.items||[]).map(i=>esc(i.model)+' × '+i.qty).join(' / ')||'—'}</div></div>
      <div class="item"><div class="k">正式承诺</div><div class="v">${evaln.formal_allowed?'可生成':'被阻断'}</div></div>
      <div class="item"><div class="k">最新承诺</div><div class="v">${d.commitments?.[0]?badge(d.commitments[0].status):'—'}</div></div>
    </div>
    <div class="grid main-side">
      <div class="grid" style="gap:12px">
        <div class="card"><div class="card-h"><h3>五道闸门</h3><span class="extra">${evaln.formal_allowed?'可以正式承诺':'存在阻断项'}</span></div><div class="card-b"><div class="gate-list">${gates.map(g=>`<div class="gate ${String(g.status).toLowerCase()}"><div class="g">${g.gate}</div><div><div class="t">${esc(g.gate)} ${badge(g.status)}</div><div class="n">${esc(g.notes||'')}</div></div></div>`).join('')}</div>
          ${evaln.blockers?.length?`<div class="alert red" style="margin-top:9px">正式承诺阻断：${evaln.blockers.map(esc).join('；')}</div>`:''}
        </div></div>
        <div class="card"><div class="card-h"><h3>履约路径与责任链</h3><span class="extra">${chain?esc(modeLabels[chain.mode]):'未建方案'}</span></div><div class="card-b">
          ${chain?`<div class="leg-chain">${chain.legs.map((l,i)=>`${i?'<div class="leg-arrow">→</div>':''}<div class="leg ${chain.selected?'current':''}"><div class="seq">LEG ${l.seq} · ${esc(l.leg_type)}</div><div class="t">${esc(l.provider?.name||'待补充')}</div><div class="s">${esc(l.origin||'')} → ${esc(l.destination||'')}<br>${esc(l.responsibility||'')}<br>${l.quote?money(l.quote.total)+' · '+esc(l.quote.source):'待报价'}</div></div>`).join('')}</div>`:'<div class="empty">尚未创建履约方案</div>'}
          <div class="small muted" style="margin-top:8px">责任链：${chain?chain.legs.map(l=>esc(l.provider?.name||'待补充')).join(' → '):'—'} → 客户</div>
        </div></div>
        <div class="card"><div class="card-h"><h3>履约方案</h3><span class="extra">${plans.length} 个候选</span></div><div class="card-b">
          ${plans.length?plans.map(plan=>`<div class="quote-card"><div class="top"><div><b>${esc(modeLabels[plan.mode]||plan.mode)}</b> ${plan.selected?badge('SELECTED'):''}<div class="small">${esc(plan.id)} · ${plan.legs.length} 段 · ${money(plan.total)}</div></div><div>${plan.selected?'<span class="badge green">已选</span>':`<button class="btn sm" data-select-plan="${plan.id}">选择</button>`}</div></div>
            ${plan.legs.map(l=>`<div class="small" style="margin-top:4px">${l.seq}. ${esc(l.leg_type)} · ${esc(l.provider?.name||'—')} · ${money(l.quote?.total)} ${l.quote?badge(l.quote.status)+' '+badge(l.quote.source):'待报价'}</div>`).join('')}
          </div>`).join(''):'<div class="empty">尚未创建方案</div>'}
        </div></div>
        <div class="card"><div class="card-h"><h3>操作</h3><span class="extra">服务端校验</span></div><div class="card-b">
          <details class="action"><summary>现场审核 G1</summary><div class="body"><form data-form="site"><div class="form-grid"><label class="field">状态<select class="input" name="status"><option value="PASS">PASS</option><option value="CONDITIONAL">CONDITIONAL</option><option value="FAIL">FAIL</option></select></label><label class="field">备注<input class="input" name="notes"></label></div><button class="btn primary sm" style="margin-top:6px">提交审核</button></form></div></details>
          <details class="action"><summary>供应商书面确认 G2</summary><div class="body"><form data-form="confirm"><div class="form-grid"><label class="field">供应商<select class="input" name="provider_id">${state.providers.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.type)}</option>`).join('')}</select></label><label class="field">确认等级<select class="input" name="status"><option>WRITTEN</option><option>CONTRACT</option><option>TRIAL</option><option>VERBAL</option><option>ADVERTISED</option></select></label><label class="field full">范围<input class="input" name="scope" value="M03 / stairs / 2-person"></label></div><button class="btn primary sm" style="margin-top:6px">提交确认</button></form></div></details>
          <details class="action"><summary>新增履约方案</summary><div class="body"><form data-form="plan"><div class="form-grid"><label class="field">模式<select class="input" name="mode" id="plan-mode"><option value="A_STANDARD_DIRECT">A 标准直发</option><option value="B_PROFESSIONAL_DIRECT">B 专业直送</option><option value="C_STATION_TRANSFER">C 站点中转</option><option value="D_FORWARD_STOCK">D 区域前置库存</option></select></label><label class="field">第一段/直送供应商<select class="input" name="provider1">${state.providers.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.type)}</option>`).join('')}</select></label><label class="field">站点/区域仓<select class="input" name="station">${state.warehouses.filter(w=>w.type==='STATION'||w.type==='FORWARD').map(w=>`<option value="${w.id}">${esc(w.name)} · ${esc(w.type)}</option>`).join('')}</select></label><label class="field">最终配送供应商<select class="input" name="provider2">${state.providers.filter(p=>p.type==='PROFESSIONAL').map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label></div><div class="small muted" style="margin-top:5px">A/B 只需一个供应商；C 需第一段+站点+最终配送；D 需区域仓+专业配送。创建后仍需选择方案、现场审核、G2/G3 通过。</div><button class="btn primary sm" style="margin-top:6px">创建方案</button></form></div></details>
          <details class="action"><summary>录入分段报价 G3</summary><div class="body"><form data-form="quote"><div class="form-grid"><label class="field">方案<select class="input" name="plan_id">${plans.map(p=>`<option value="${p.id}">${esc(p.id)} · ${esc(p.mode)}</option>`).join('')}</select></label><label class="field">环节<select class="input" name="leg_id">${(plans[0]?.legs||[]).map(l=>`<option value="${l.id}">${l.seq}. ${esc(l.leg_type)} · ${esc(l.provider?.name||'')}</option>`).join('')}</select></label><label class="field">来源<select class="input" name="source"><option>SUPPLIER_QUOTE</option><option>CONTRACT_RATE</option><option>DEMO</option><option>BUDGETARY_ESTIMATE</option></select></label><label class="field">状态<select class="input" name="status"><option>CONFIRMED</option><option>DRAFT</option></select></label><label class="field">金额 USD<input class="input" type="number" name="total" min="1"></label><label class="field">有效期<input class="input" type="date" name="valid_until"></label></div><button class="btn primary sm" style="margin-top:6px">保存报价</button></form></div></details>
          <details class="action"><summary>正式/草案承诺 G4</summary><div class="body"><form data-form="commit"><div class="form-grid"><label class="field">形式<select class="input" name="formal"><option value="false">草案 / 有条件</option><option value="true">正式承诺</option></select></label><label class="field">有效期<input class="input" type="date" name="valid_until"></label><label class="field full">条件<input class="input" name="conditions" placeholder="例如 2-person, 8 steps, written provider confirmation"></label><label class="field full">不包含<input class="input" name="exclusions"></label></div><button class="btn primary sm" style="margin-top:6px">生成承诺</button></form></div></details>
          <details class="action"><summary>交接 / POD / 异常</summary><div class="body"><form data-form="handoff"><div class="form-grid"><label class="field">交出方<input class="input" name="from_party" value="DFW 中心仓"></label><label class="field">接收方<input class="input" name="to_party"></label><label class="field">地点<input class="input" name="location"></label><label class="field">包装状态<input class="input" name="condition" placeholder="GOOD / DAMAGED"></label><label class="field full">备注<input class="input" name="notes"></label></div><button class="btn sm" style="margin-top:6px">记录交接</button></form><div class="hr"></div><form data-form="pod"><div class="form-grid"><label class="field">签收人<input class="input" name="recipient"></label><label class="field">交付位置<input class="input" name="location"></label><label class="field">签名<input class="input" name="signature_name"></label><label class="field">异常<input class="input" name="exceptions"></label></div><button class="btn sm" style="margin-top:6px">登记 POD</button></form><div class="hr"></div><form data-form="exception"><div class="form-grid"><label class="field">异常代码<input class="input" name="code" value="E-OTHER"></label><label class="field">Owner<input class="input" name="owner" value="${esc(state.me.name)}"></label><label class="field full">说明<input class="input" name="notes"></label></div><button class="btn sm" style="margin-top:6px">开启异常</button></form></div></details>
        </div></div>
      </div>
      <div class="grid" style="gap:12px">
        <div class="card"><div class="card-h"><h3>操作按钮</h3></div><div class="card-b"><button class="btn primary" id="commit-btn" ${evaln.formal_allowed?'':'disabled'}>正式承诺</button> <button class="btn teal" id="dispatch-btn" ${(d.commitments||[]).some(c=>c.formal&&c.status==='ACTIVE')?'':'disabled'}>派车</button><div class="small muted" style="margin-top:6px">正式承诺与派车均由服务端再次校验；前端按钮不是权限。</div></div></div>
        <div class="card"><div class="card-h"><h3>客户交付需求</h3><span class="extra">${d.request?esc(d.request.status):'—'}</span></div><div class="card-b small">${d.request?`<b>${esc(d.request.customer_name)}</b><br>${esc(d.request.address)}, ${esc(d.request.city)} ${esc(d.request.state)} ${esc(d.request.zip)}<br>${esc(d.request.equipment_model)} × ${d.request.qty} · ${esc(d.request.location_type)}<br><span class="muted" style="word-break:break-word;white-space:pre-wrap">${esc(reqAnswers)}</span>`:'<span class="muted">无关联客户表单</span>'}</div></div>
        <div class="card"><div class="card-h"><h3>附件证据</h3><span class="extra">${d.attachments?.length||0}</span></div><div class="card-b"><input type="file" id="order-file" class="input"><button class="btn sm" id="upload-btn" style="margin-top:6px">上传</button><div style="margin-top:7px">${(d.attachments||[]).map(a=>`<a class="small" href="/api/attachments/${a.id}" target="_blank">${esc(a.filename)}</a>`).join('<br>')||'<span class="small muted">暂无附件</span>'}</div></div></div>
        <div class="card"><div class="card-h"><h3>交接 / 异常 / POD 记录</h3></div><div class="card-b small">${(d.handoffs||[]).map(h=>`<div>${dt(h.occurred_at)} · ${esc(h.from_party)} → ${esc(h.to_party)} · ${esc(h.condition||'')}</div>`).join('')||'<span class="muted">暂无交接</span>'}<div class="hr"></div>${(d.exceptions||[]).map(e=>`<div>${badge(e.status)} ${esc(e.code)} · ${esc(e.owner||'')}</div>`).join('')||'<span class="muted">暂无异常</span>'}<div class="hr"></div>${(d.pods||[]).map(p=>`<div>POD ${dt(p.delivered_at)} · ${esc(p.recipient||'')}</div>`).join('')||'<span class="muted">暂无 POD</span>'}</div></div>
      </div>
    </div>`;
  $$('[data-nav]').forEach(e=>e.addEventListener('click',()=>go(e.dataset.nav)));
  $$('[data-select-plan]').forEach(e=>e.addEventListener('click',()=>selectPlan(e.dataset.selectPlan)));
  bindOrderForms(d);
  $('#commit-btn')?.addEventListener('click',()=>postOrder('commit',{formal:true,conditions:'Formal V3 commitment',valid_until:new Date(Date.now()+14*86400000).toISOString().slice(0,10)}));
  $('#dispatch-btn')?.addEventListener('click',()=>postOrder('dispatch',{}));
  $('#upload-btn')?.addEventListener('click',()=>uploadOrderFile(o.id));
}

function bindOrderForms(d) {
  const o = d.order || d;
  $$('[data-form]').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault(); const fd = new FormData(form); const kind=form.dataset.form;
      try {
        if (kind==='site') await postOrder('site-review',{status:fd.get('status'),notes:fd.get('notes')});
        if (kind==='confirm') await postOrder('provider-confirm',{provider_id:fd.get('provider_id'),status:fd.get('status'),scope:fd.get('scope')});
        if (kind==='plan') await createPlanForm(fd);
        if (kind==='quote') await postPlanQuote(fd);
        if (kind==='commit') await postOrder('commit',{formal:fd.get('formal')==='true',conditions:fd.get('conditions'),exclusions:fd.get('exclusions'),valid_until:fd.get('valid_until')});
        if (kind==='handoff') await postOrder('handoff',{from_party:fd.get('from_party'),to_party:fd.get('to_party'),location:fd.get('location'),condition:fd.get('condition'),notes:fd.get('notes')});
        if (kind==='pod') await postOrder('pod',{recipient:fd.get('recipient'),location:fd.get('location'),signature_name:fd.get('signature_name'),exceptions:fd.get('exceptions')});
        if (kind==='exception') await postOrder('exception',{code:fd.get('code'),owner:fd.get('owner'),notes:fd.get('notes')});
      } catch (err) { toast(err.message,'err'); }
    });
  });
}

async function postOrder(action, body) {
  try {
    const r = await api(`/api/orders/${state.order.order.id}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    toast('操作成功','ok'); renderOrder({order:r.detail});
  } catch (err) { toast(err.message,'err'); }
}

async function selectPlan(id) {
  try { const r=await api(`/api/plans/${id}/select`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); toast('方案已选择','ok'); renderOrder({order:r.detail}); }
  catch(e){ toast(e.message,'err'); }
}

async function createPlanForm(fd) {
  const mode=fd.get('mode'), p1=fd.get('provider1'), p2=fd.get('provider2'), station=fd.get('station');
  let legs=[];
  if (mode==='A_STANDARD_DIRECT' || mode==='B_PROFESSIONAL_DIRECT') {
    legs=[{leg_type:'DIRECT',provider_id:p1,origin_warehouse_id:'wh-center',origin:'DFW 中心仓',destination:'Customer site',cost:0,responsibility:state.providers.find(p=>p.id===p1)?.name}];
  } else if (mode==='C_STATION_TRANSFER') {
    legs=[
      {leg_type:'LINEHAUL',provider_id:p1,origin_warehouse_id:'wh-center',dest_warehouse_id:station,origin:'DFW 中心仓',destination:'专业配送站',cost:0,responsibility:state.providers.find(p=>p.id===p1)?.name},
      {leg_type:'FINAL_DELIVERY',provider_id:p2,origin_warehouse_id:station,origin:'专业配送站',destination:'Customer site',cost:0,responsibility:state.providers.find(p=>p.id===p2)?.name}
    ];
  } else {
    legs=[{leg_type:'FINAL_DELIVERY',provider_id:p2,origin_warehouse_id:station,origin:'区域前置仓',destination:'Customer site',cost:0,responsibility:state.providers.find(p=>p.id===p2)?.name}];
  }
  const r=await api(`/api/orders/${state.order.order.id}/plans`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode,legs})});
  toast('方案已创建','ok'); renderOrder({order:r.detail});
}

async function postPlanQuote(fd) {
  const r=await api(`/api/plans/${fd.get('plan_id')}/quote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    leg_id:fd.get('leg_id'),source:fd.get('source'),status:fd.get('status'),total:Number(fd.get('total')),valid_until:fd.get('valid_until')
  })});
  toast('报价已保存','ok'); renderOrder({order:r.detail});
}

async function uploadOrderFile(orderId) {
  const file=$('#order-file')?.files?.[0]; if(!file) return toast('请选择文件','err');
  try {
    await api(`/api/attachments?entity_type=order&entity_id=${encodeURIComponent(orderId)}&filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'content-type':file.type},body:file});
    toast('附件已上传','ok'); const r=await api(`/api/orders/${orderId}`); renderOrder({order:r.order});
  } catch(e){ toast(e.message,'err'); }
}


function renderCommitments(d) {
  const rows = d.commitments || [];
  $('#content').innerHTML = `<div class="page-head"><div><h2>交付承诺</h2><div class="lead">正式承诺与草案分开管理。只有 formal=1 且 ACTIVE 的承诺可作为派车依据。</div></div><button class="btn" data-nav="orders">订单中心</button></div>
    <div class="grid cols-4" style="margin-bottom:12px">${kpi('承诺总数',rows.length,'含草案')}${kpi('正式有效',rows.filter(x=>x.formal&&x.status==='ACTIVE').length,'formal / ACTIVE','good')}${kpi('草案',rows.filter(x=>!x.formal).length,'不能派车','warn')}${kpi('承诺金额',money(rows.filter(x=>x.formal&&x.status==='ACTIVE').reduce((a,x)=>a+Number(x.price||0),0)),'USD')}</div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>版本</th><th>形式</th><th>状态</th><th>金额</th><th>有效期</th><th>条件</th><th>创建</th></tr></thead><tbody>${rows.map(c=>`<tr data-open-order="${c.order_id}" style="cursor:pointer"><td><b>${esc(c.order_no)}</b><div class="small">${esc(c.mode||'')}</div></td><td>${esc(c.customer_name||'—')}<div class="small">${esc(c.city||'')} ${esc(c.state||'')}</div></td><td>v${esc(c.version)}</td><td><span class="badge ${c.formal?'green':'amber'}">${c.formal?'正式':'草案'}</span></td><td>${badge(c.status)}</td><td class="num-cell">${money(c.price)}</td><td>${date(c.valid_until)}</td><td class="small">${esc(c.conditions||'—')}</td><td>${dt(c.created_at)}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">暂无承诺</td></tr>'}</tbody></table></div></div>`;
  $$('[data-open-order]').forEach(e=>e.addEventListener('click',()=>go('order',e.dataset.openOrder)));
}

function renderExceptions(d) {
  const rows = d.exceptions || [];
  $('#content').innerHTML = `<div class="page-head"><div><h2>异常中心</h2><div class="lead">异常按订单、责任人、时限和状态记录；关闭必须有结论。当前为记录与追踪，不含完整索赔状态机。</div></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>代码</th><th>Owner</th><th>时限</th><th>状态</th><th>说明</th><th>创建</th></tr></thead><tbody>${rows.map(e=>`<tr data-open-order="${e.order_id}" style="cursor:pointer"><td><b>${esc(e.order_no)}</b></td><td>${esc(e.customer_name||'—')}</td><td><span class="badge red">${esc(e.code)}</span></td><td>${esc(e.owner||'—')}</td><td>${date(e.due)}</td><td>${badge(e.status)}</td><td class="small">${esc(e.notes||'')}</td><td>${dt(e.created_at)}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">暂无异常</td></tr>'}</tbody></table></div></div>`;
  $$('[data-open-order]').forEach(e=>e.addEventListener('click',()=>go('order',e.dataset.openOrder)));
}

function barList(rows, labelFn = x=>x.k) {
  const max = Math.max(1,...rows.map(r=>Number(r.n)||0));
  return rows.map(r=>`<div style="display:grid;grid-template-columns:90px 1fr 34px;gap:6px;align-items:center;margin:5px 0;font-size:9.5px"><span>${esc(labelFn(r)||'—')}</span><span style="height:6px;background:#EEF2F6;border-radius:4px;overflow:hidden"><i style="display:block;height:100%;width:${Math.round((Number(r.n)||0)/max*100)}%;background:#2F6F7E;border-radius:4px"></i></span><b style="text-align:right;color:var(--navy)">${r.n}</b></div>`).join('') || '<div class="empty">暂无数据</div>';
}

function renderAnalytics(d) {
  const statusLabel = {REVIEW:'待审核',DRAFT_COMMIT:'草案承诺',COMMITTED:'已承诺',DISPATCHED:'运输中',DELIVERED:'已交付',MIGRATION_REVIEW:'迁期待审'};
  $('#content').innerHTML = `<div class="page-head"><div><h2>运营分析</h2><div class="lead">管理口径，不是财务审计。演示订单与真实订单在订单详情有标记，生产使用前需接入真实 POD/账单/GPS。</div></div><button class="btn" data-nav="map">地图调度</button></div>
    <div class="grid cols-4" style="margin-bottom:12px">${kpi('订单',d.orders,'全部')}${kpi('正式承诺',d.commitments,'ACTIVE','good')}${kpi('可用库存',d.inventory_available,'序列号级','good')}${kpi('开启异常',d.exceptions_open,'OPEN',d.exceptions_open?'bad':'good')}</div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>订单状态</h3><span class="extra">按状态</span></div><div class="card-b">${barList(d.by_status,r=>statusLabel[r.k]||r.k)}</div></div>
      <div class="card"><div class="card-h"><h3>履约模式</h3><span class="extra">A/B/C/D</span></div><div class="card-b">${barList(d.by_mode,r=>modeLabels[r.k]||r.k)}</div></div>
      <div class="card"><div class="card-h"><h3>州分布</h3><span class="extra">订单数</span></div><div class="card-b">${barList(d.by_state,r=>r.k||'—')}</div></div>
      <div class="card"><div class="card-h"><h3>服务等级</h3><span class="extra">L1–L5</span></div><div class="card-b">${barList(d.by_level,r=>r.k||'—')}</div></div>
      <div class="card"><div class="card-h"><h3>闸门结构</h3><span class="extra">PASS / CONDITIONAL / PENDING</span></div><div class="card-b"><table><thead><tr><th>闸门</th><th>状态</th><th>数量</th></tr></thead><tbody>${(d.gates||[]).map(g=>`<tr><td>${esc(g.gate)}</td><td>${badge(g.status)}</td><td class="num-cell">${g.n}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><div class="card-h"><h3>仓网库存</h3><span class="extra">按仓类型</span></div><div class="card-b"><table><thead><tr><th>类型</th><th>总台</th><th>可用</th></tr></thead><tbody>${(d.warehouses||[]).map(w=>`<tr><td>${esc(w.type)}</td><td class="num-cell">${w.units}</td><td class="num-cell">${w.available||0}</td></tr>`).join('')}</tbody></table><div class="small muted" style="margin-top:6px">正式承诺金额 ${money(d.total_commitment_value)} · 批次 ${d.batches}</div></div></div>
    </div>`;
  $$('[data-nav]').forEach(e=>e.addEventListener('click',()=>go(e.dataset.nav)));
}

async function renderSuppliers(p) {
  const inv = await api('/api/inventory');
  const providers = p.providers || [];
  $('#content').innerHTML = `<div class="page-head"><div><h2>供应商与站点</h2><div class="lead">供应商能力、保险、仓/站点类型和库存放在同一视图。示例供应商/仓库不是已核验的真实资源。</div></div><button class="btn" data-nav="inventory">库存与仓网</button></div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>供应商</h3><span class="extra">${providers.length}</span></div><div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>状态</th><th>保险</th><th>能力</th></tr></thead><tbody>${providers.map(x=>`<tr><td><b>${esc(x.name)}</b><div class="small">${esc(x.contact||'')}</div></td><td>${esc(x.type)}</td><td>${badge(x.status)}</td><td>${date(x.insurance)}</td><td class="small">${esc(x.capabilities_json||'')}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><div class="card-h"><h3>仓 / 站点</h3><span class="extra">${inv.warehouses.length}</span></div><div class="card-b">${inv.warehouses.map(w=>`<div style="border:1px solid var(--line);border-radius:8px;padding:7px 8px;margin-bottom:6px"><div style="display:flex;justify-content:space-between"><b>${esc(w.name)}</b><span class="badge ${w.type==='CENTER'?'navy':w.type==='STATION'?'amber':'teal'}">${esc(w.type)}</span></div><div class="small">${esc(w.address)}, ${esc(w.city)} ${esc(w.state)} ${esc(w.zip)}</div><div class="small muted">${esc(w.operator||'')} · 可用 ${inv.units.filter(u=>u.warehouse_id===w.id&&u.status==='AVAILABLE').length} 台</div></div>`).join('')}</div></div>
    </div>`;
  $$('[data-nav]').forEach(e=>e.addEventListener('click',()=>go(e.dataset.nav)));
}

function renderCatalog() {
  $('#content').innerHTML = `<div class="page-head"><div><h2>服务目录</h2><div class="lead">系统使用的履约模式、服务等级、报价来源和闸门语义。服务项与费率必须在使用前替换为真实合同数据。</div></div></div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>履约模式</h3></div><div class="card-b"><table><thead><tr><th>模式</th><th>路径</th><th>适用</th></tr></thead><tbody>
        <tr><td><b>A 标准直发</b></td><td>中心仓 → 标准运输 → 客户</td><td>商业、普通卸货</td></tr>
        <tr><td><b>B 专业直送</b></td><td>中心仓 → 专业配送 → 客户</td><td>住宅入户/双人/尾板</td></tr>
        <tr><td><b>C 站点中转</b></td><td>中心仓 → 站点 → 客户</td><td>C1 专业提货 / C2 独立送站</td></tr>
        <tr><td><b>D 区域前置</b></td><td>中心仓 → 区域仓 → 客户</td><td>提前备货、当地履约</td></tr>
      </tbody></table></div></div>
      <div class="card"><div class="card-h"><h3>服务等级</h3></div><div class="card-b"><table><thead><tr><th>等级</th><th>内容</th></tr></thead><tbody>
        <tr><td>L1</td><td>基础交付 / 路边</td></tr><tr><td>L2</td><td>尾板 / 楼门口</td></tr><tr><td>L3</td><td>室内 / 入门</td></tr><tr><td>L4</td><td>双人 / 楼梯 / 指定位置</td></tr><tr><td>L5</td><td>拆包 / 安装 / 专项服务</td></tr>
      </tbody></table></div></div>
      <div class="card"><div class="card-h"><h3>报价来源</h3></div><div class="card-b small">DEMO / HISTORICAL_REFERENCE / BUDGETARY_ESTIMATE 只能做草案；SUPPLIER_QUOTE / CONTRACT_RATE 且 CONFIRMED、未过期才能支持正式承诺；FINAL_INVOICE 用于账单稽核。</div></div>
      <div class="card"><div class="card-h"><h3>闸门</h3></div><div class="card-b small"><b>G0</b> 信息完整 · <b>G1</b> 现场可行 · <b>G2</b> 供应商书面确认 · <b>G3</b> 有效报价 · <b>G4</b> 正式承诺。CONDITIONAL ≠ PASS。</div></div>
    </div>`;
}

function renderSettings() {
  $('#content').innerHTML = `<div class="page-head"><div><h2>设置与导出</h2><div class="lead">V3.1 本地预览使用 SQLite 与本地附件；V2 线上演示站保持不变。</div></div></div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>数据导出</h3></div><div class="card-b"><div class="small muted">导出订单、客户、闸门、方案、承诺、库存、批次和交付需求（不含附件二进制）。用于备份和迁移，不包含真实客户生产数据。</div><button class="btn primary" id="export-json" style="margin-top:8px">下载 V3.1 JSON</button></div></div>
      <div class="card"><div class="card-h"><h3>环境</h3></div><div class="card-b small">前端：V3.1 控制塔<br>后端：Node + SQLite<br>地图：Leaflet + Esri + OSRM<br>V2 线上：<a href="https://cscpengyuyan.github.io/haha-logistics-dispatch/" target="_blank">GitHub Pages</a><br><span class="muted">V3 未替换 V2 线上地址。</span></div></div>
      <div class="card"><div class="card-h"><h3>地图上下文</h3></div><div class="card-b small">清除地图保存的州/筛选/选中订单；不会删除业务数据。<br><button class="btn" id="clear-map-ctx" style="margin-top:6px">清除地图上下文</button></div></div>
      <div class="card"><div class="card-h"><h3>迁移</h3></div><div class="card-b small">旧 V2 JSON 通过「V2 数据迁移」导入；P1–P4 映射到 A/B/C，历史报价保存在 legacy_json。<button class="btn sm" data-nav="migration" style="margin-left:6px">打开迁移</button></div></div>
    </div>`;
  $('#export-json')?.addEventListener('click',()=>{ window.V31DemoExport?.(); });
  $('#clear-map-ctx')?.addEventListener('click',()=>{ sessionStorage.removeItem('haha_v31_map_context'); toast('地图上下文已清除','ok'); });
  $$('[data-nav]').forEach(e=>e.addEventListener('click',()=>go(e.dataset.nav)));
}


function renderInventory(d) {
  const byWh = {};
  d.units.forEach(u=>{ (byWh[u.warehouse_id]=byWh[u.warehouse_id]||[]).push(u); });
  $('#content').innerHTML = `<div class="page-head"><div><h2>库存与仓网</h2><div class="lead">序列号级库存、状态、预留与补货。这里不是“某仓 10 台”的汇总，而是每台设备可追踪。</div></div></div>
    <div class="grid cols-3" style="margin-bottom:12px">${d.warehouses.map(w=>`<div class="card"><div class="card-h"><h3>${esc(w.name)}</h3><span class="badge ${w.type==='FORWARD'?'teal':w.type==='STATION'?'amber':'navy'}">${esc(w.type)}</span></div><div class="card-b small">${esc(w.city)}, ${esc(w.state)} ${esc(w.zip)}<br><span class="muted">${esc(w.operator||'')}</span><div style="margin-top:6px"><b>${(byWh[w.id]||[]).filter(u=>u.status==='AVAILABLE').length}</b> 可用 / ${(byWh[w.id]||[]).length} 台</div></div></div>`).join('')}</div>
    <div class="grid main-side">
      <div class="card"><div class="card-h"><h3>设备库存</h3><span class="extra">${d.units.length} 台</span></div><div class="table-wrap"><table><thead><tr><th>序列号</th><th>型号</th><th>仓库</th><th>状态</th><th>订单</th><th>更新</th></tr></thead><tbody>${d.units.map(u=>`<tr><td class="mono">${esc(u.serial)}</td><td>${esc(u.sku)}</td><td>${esc(u.warehouse_name)}</td><td>${badge(u.status)}</td><td class="mono">${esc(u.order_id||'—')}</td><td>${dt(u.updated_at)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">暂无库存</td></tr>'}</tbody></table></div></div>
      <div class="grid" style="gap:12px">
        <div class="card"><div class="card-h"><h3>预留库存</h3></div><div class="card-b"><form data-form="reserve"><label class="field">订单 ID<input class="input" name="order_id" placeholder="模式 D 的订单 ID"></label><label class="field">库存<select class="input" name="unit_id">${d.units.filter(u=>u.status==='AVAILABLE').map(u=>`<option value="${u.id}">${esc(u.serial)} · ${esc(u.warehouse_name)}</option>`).join('')}</select></label><button class="btn primary sm" style="margin-top:6px">预留</button></form></div></div>
        <div class="card"><div class="card-h"><h3>区域补货</h3></div><div class="card-b"><form data-form="replenish"><label class="field">从仓<select class="input" name="from">${d.warehouses.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label><label class="field">到仓<select class="input" name="to">${d.warehouses.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label><label class="field">设备 IDs（逗号分隔）<input class="input" name="unit_ids" placeholder="unit_id,unit_id"></label><button class="btn primary sm" style="margin-top:6px">创建补货</button></form></div></div>
      </div>
    </div>`;
  $('[data-form="reserve"]')?.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.target);try{await api('/api/inventory/reserve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order_id:fd.get('order_id'),unit_id:fd.get('unit_id')})});toast('库存已预留','ok');loadPage();}catch(err){toast(err.message,'err');}});
  $('[data-form="replenish"]')?.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.target);try{await api('/api/replenishments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from_warehouse_id:fd.get('from'),to_warehouse_id:fd.get('to'),unit_ids:String(fd.get('unit_ids')||'').split(',').map(s=>s.trim()).filter(Boolean)})});toast('补货已创建','ok');loadPage();}catch(err){toast(err.message,'err');}});
}

function renderRequests(d) {
  $('#content').innerHTML = `<div class="page-head"><div><h2>客户交付需求</h2><div class="lead">销售生成英文客户表单链接；客户只能访问自己的令牌范围，不能看到内部报价和成本。</div></div><button class="btn primary" id="new-request">＋ 新建客户表单</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>客户</th><th>地址</th><th>设备</th><th>状态</th><th>提交</th><th>链接</th><th></th></tr></thead><tbody>${d.requests.map(r=>`<tr><td><b>${esc(r.customer_name)}</b><div class="small">${esc(r.contact||'')}</div></td><td>${esc(r.address||'')}<div class="small">${esc(r.city||'')} ${esc(r.state||'')} ${esc(r.zip||'')}</div></td><td>${esc(r.equipment_model||'')} × ${r.qty||1}</td><td>${badge(r.status)}</td><td>${dt(r.submitted_at)}</td><td><button class="btn sm" data-copy="${esc(location.origin+location.pathname.replace(/\/$/,'')+'/delivery-requirements.html?token='+r.token)}">复制链接</button></td><td>${r.linked_order_id?`<span class="small">已转订单</span>`:`<button class="btn sm" data-convert="${r.id}">转订单</button>`}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">暂无客户需求</td></tr>'}</tbody></table></div></div>`;
  $$('[data-copy]').forEach(b=>b.addEventListener('click',()=>navigator.clipboard?.writeText(b.dataset.copy).then(()=>toast('链接已复制','ok')).catch(()=>toast('复制失败，请手动选择链接','err'))));
  $$('[data-convert]').forEach(b=>b.addEventListener('click',async()=>{try{const r=await api(`/api/delivery-requests/${b.dataset.convert}/convert`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'A_STANDARD_DIRECT'})});toast('已转订单','ok');go('order',r.order.id);}catch(e){toast(e.message,'err');}}));
  $('#new-request').addEventListener('click',()=>modal('新建客户交付需求',`<div class="form-grid"><label class="field">客户名称<input class="input" name="customer_name" required></label><label class="field">联系人<input class="input" name="contact"></label><label class="field">邮箱<input class="input" name="email"></label><label class="field">电话<input class="input" name="phone"></label><label class="field full">地址<input class="input" name="address"></label><label class="field">城市<input class="input" name="city"></label><label class="field">州<input class="input" name="state" value="TX"></label><label class="field">ZIP<input class="input" name="zip"></label><label class="field">型号<input class="input" name="equipment_model" value="M03"></label><label class="field">数量<input class="input" type="number" name="qty" value="1"></label><label class="field">交付位置<select class="input" name="location_type"><option>CURBSIDE</option><option>ENTRANCE</option><option>INSIDE</option><option>ROOM</option></select></label><label class="field">期望日期<input class="input" type="date" name="requested_date"></label></div>`,async fd=>{const r=await api('/api/delivery-requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))});toast('客户表单已创建','ok');try { await navigator.clipboard?.writeText(r.public_url); } catch { toast('链接已创建，请手动复制','warn'); }go('requests');},'创建并复制链接'));
}

function renderMigration() {
  $('#content').innerHTML = `<div class="page-head"><div><h2>V2 数据迁移</h2><div class="lead">上传 V2 导出的 JSON。P1→A，P2/P3→C（C1/C2），P4→B；历史报价/承诺保存在 legacy_json，不自动生成正式 V3 承诺。</div></div></div>
    <div class="card"><div class="card-b"><input type="file" id="v2-file" accept=".json,application/json" class="input"><button class="btn primary" id="migrate-btn" style="margin-top:8px">上传并迁移</button><div id="migrate-result" style="margin-top:12px"></div></div></div>`;
  $('#migrate-btn').addEventListener('click',async()=>{const f=$('#v2-file').files[0];if(!f)return toast('请选择 JSON','err');try{const text=await f.text();const r=await api('/api/migrate/v2',{method:'POST',headers:{'content-type':'application/json'},body:text});$('#migrate-result').innerHTML=`<div class="alert green">已创建 ${r.created.length} 单，待处理 ${r.pending.length} 项。</div><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(r,null,2))}</pre>`;toast('迁移完成','ok');}catch(e){toast(e.message,'err');}});
}

function renderHelp() {
  $('#content').innerHTML = `<div class="page-head"><div><h2>V3 预览说明</h2><div class="lead">这是真实可运行的服务端预览，不是 V2 静态演示站的替换。</div></div></div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>已实现</h3></div><div class="card-b small"><ul><li>A/B/C1/C2/D 履约模式与多段供应商</li><li>G0–G4 + 正式承诺/派车服务端阻断</li><li>报价来源隔离与分段报价</li><li>SQLite 数据库、会话、角色权限</li><li>附件真实文件存储与令牌访问</li><li>区域前置库存/序列号/预留/补货</li><li>英文客户交付需求表单</li><li>V2 JSON 迁移接口</li></ul></div></div>
      <div class="card"><div class="card-h"><h3>尚未完成</h3></div><div class="card-b small"><ul><li>真实供应商 API / CRM / EDI / GPS</li><li>生产级邮件/短信预约通知</li><li>完整索赔状态机与财务对账</li><li>地图与路线生产级服务</li><li>多租户、SSO、细粒度 RBAC</li><li>正式生产部署（当前本地预览）</li></ul><div class="alert" style="margin-top:8px">V2 线上地址保持独立；V3 后端部署前不应替换现有静态演示站。</div></div></div>
    </div>`;
}

window.addEventListener('hashchange',()=>{ if(!state.me)return; const [p,id]=location.hash.slice(1).split('/'); if(p && p!==state.page){state.page=p;state.id=id||null;renderShell();loadPage();} });
boot();
