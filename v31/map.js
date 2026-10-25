/* V3.1 map workspace: national/state dispatch, filters, clusters, OSRM route, batches */
const HM = {
  map: null, data: null, batches: [], selected: new Set(), selectedOrder: null,
  filters: { state: null, date: '', range: '7d', level: '', type: '', city: '', search: '' },
  layers: {}, route: null, clusters: [], countyLoaded: false, tileErrors: 0, base: 'light', renderSeq: 0
};
const MAP_CTX_KEY = 'haha_v31_map_context';

const mapEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mapMoney = (v) => v == null || v === '' ? '—' : `$${Number(v).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const mapStatusColor = (s) => ({REVIEW:'#B7791F',DRAFT_COMMIT:'#B7791F',COMMITTED:'#2F6F5E',DISPATCHED:'#2F6F7E',DELIVERED:'#5B6B7D',MIGRATION_REVIEW:'#A33A32'}[s] || '#6B7280');
const mapStatusLabel = (s) => ({REVIEW:'待审核',DRAFT_COMMIT:'草案承诺',COMMITTED:'已承诺',DISPATCHED:'运输中',DELIVERED:'已交付',MIGRATION_REVIEW:'迁期待审'}[s] || s || '—');
const mapModeLabel = (m) => ({A_STANDARD_DIRECT:'A 标准直发',B_PROFESSIONAL_DIRECT:'B 专业直送',C_STATION_TRANSFER:'C 站点中转',D_FORWARD_STOCK:'D 区域前置'}[m] || m || '—');
const mapLevelLabel = (l) => ({L1:'L1 基础',L2:'L2 尾板',L3:'L3 室内',L4:'L4 双人/楼梯',L5:'L5 安装/专项'}[l] || l || '—');
const mapTypeLabel = (t) => ({CURBSIDE:'路边',ENTRANCE:'楼门口',INSIDE:'室内',ROOM:'指定房间'}[t] || t || '—');
const mapToday = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const addDays = (iso,n) => { const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const haversine = (a,b) => { const R=6371000, p=Math.PI/180; const dLat=(b[0]-a[0])*p, dLng=(b[1]-a[1])*p; const s=Math.sin(dLat/2)**2+Math.cos(a[0]*p)*Math.cos(b[0]*p)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(s)); };
const fmtKm = (m) => m>=1000 ? `${(m/1000).toFixed(1)} km` : `${Math.round(m)} m`;
const fmtDur = (s) => { if(!s) return '—'; const h=Math.floor(s/3600), m=Math.round((s%3600)/60); return h?`${h}h ${m}m`:`${m} min`; };

function mapOrderLatLng(o) {
  const lat = Number(o.lat), lng = Number(o.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 ? [lat, lng] : null;
}
function mapOrderDate(o) { return o.planned_date || (o.created_at || '').slice(0,10) || mapToday(); }
function inMapDate(o) {
  const d = mapOrderDate(o), base = HM.filters.date || mapToday();
  if (HM.filters.range === '7d') return d >= base && d <= addDays(base, 6);
  return d === base;
}
function mapBaseOrders() {
  return (HM.data?.orders || []).filter(o => {
    if (!mapOrderLatLng(o)) return false;
    if (!inMapDate(o)) return false;
    if (HM.filters.level && o.service_level !== HM.filters.level) return false;
    if (HM.filters.type && o.location_type !== HM.filters.type) return false;
    const q = (HM.filters.search || '').toLowerCase();
    if (q && ![o.order_no,o.customer_name,o.city,o.state,o.address].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}
function mapFilteredOrders() {
  let arr = mapBaseOrders();
  if (HM.filters.state) arr = arr.filter(o => o.state === HM.filters.state);
  if (HM.filters.city) arr = arr.filter(o => o.city === HM.filters.city);
  return arr;
}
function stateCounts() {
  const c = {};
  mapBaseOrders().forEach(o => { c[o.state] = (c[o.state] || 0) + 1; });
  return c;
}
function stateFeature(abbr) { return window.US_STATES?.features.find(f => f.properties.abbr === abbr); }
function stateName(abbr) { return stateFeature(abbr)?.properties.name || abbr || ''; }
function stateCenter(feature) {
  const b = L.geoJSON(feature).getBounds();
  return b.getCenter();
}

window.HahaMap = {
  render: async function () { await renderMapPage(); },
  destroy: function () {
    HM.renderSeq++;
    if (HM.map) { try { HM.map.remove(); } catch {} HM.map = null; }
  }
};

function mapSkeleton() {
  return `<div class="map-page">
    <div class="map-toolbar">
      <div class="map-title"><div><div class="map-eyebrow" id="map-eyebrow">US NETWORK · 全国</div><h2 id="map-title">全国网络</h2><div class="sub" id="map-sub">11 单有坐标 · 点击州进入独立调度</div></div></div>
      <label class="map-tool">日期<input type="date" id="map-date"></label>
      <label class="map-tool">范围<select id="map-range"><option value="day">当日</option><option value="7d">未来 7 天</option></select></label>
      <label class="map-tool">等级<select id="map-level"><option value="">全部等级</option><option>L1</option><option>L2</option><option>L3</option><option>L4</option><option>L5</option></select></label>
      <label class="map-tool">交付位置<select id="map-type"><option value="">全部</option><option value="CURBSIDE">路边</option><option value="ENTRANCE">楼门口</option><option value="INSIDE">室内</option><option value="ROOM">指定房间</option></select></label>
      <label class="map-tool">底图<select id="map-base"><option value="street">街道</option><option value="light">浅色</option><option value="imagery">卫星</option></select></label>
      <label class="map-tool map-search-tool">搜索<input type="search" id="map-search" placeholder="订单/客户"></label>
      <button class="map-btn" id="map-rail-toggle">隐藏面板</button>
      <button class="map-btn" id="map-fit">全美视图</button>
      <button class="map-btn" id="map-full">全屏</button>
      <button class="map-btn" id="map-refresh">刷新</button>
      <span id="map-count" class="badge navy">—</span>
    </div>
    <div class="map-layout">
      <div class="map-canvas-wrap">
        <div id="v31-map"></div>
        <div class="map-notice" id="map-notice"></div>
        <div class="map-overlay map-layerbar">
          <div class="ttl">图层 / LAYERS</div>
          <label><input type="checkbox" id="ly-orders" checked> 订单点位</label>
          <label><input type="checkbox" id="ly-warehouses" checked> 仓/站点</label>
          <label><input type="checkbox" id="ly-clusters" checked> 聚合圈</label>
          <label><input type="checkbox" id="ly-zones"> 服务半径</label>
          <label><input type="checkbox" id="ly-cities"> 城市气泡</label>
          <label><input type="checkbox" id="ly-labels" checked> 州单量</label>
          <label><input type="checkbox" id="ly-counties"> 县界</label>
        </div>
        <div class="map-overlay map-legend">
          <span class="lg"><i class="dot" style="background:#B7791F"></i>待审核/草案</span>
          <span class="lg"><i class="dot" style="background:#2F6F5E"></i>已承诺</span>
          <span class="lg"><i class="dot" style="background:#2F6F7E"></i>运输中</span>
          <span class="lg"><i class="sq" style="background:#1F3A5F"></i>中心仓</span>
          <span class="lg"><i class="sq" style="background:#B7791F"></i>专业站点</span>
          <span class="lg"><i class="sq" style="background:#2F6F7E"></i>区域前置仓</span>
        </div>
        <div class="map-empty" id="map-empty" style="display:none"><div>当前筛选没有带坐标的订单<br><span class="small">可调整日期/等级，或检查地址坐标</span></div></div>
      </div>
      <aside class="map-rail">
        <div class="rail-tabs"><button class="rail-tab active" data-rail="dispatch">调度</button><button class="rail-tab" data-rail="batches">批次</button><button class="rail-tab" data-rail="guide">说明</button></div>
        <div class="rail-body" id="map-rail-body"></div>
      </aside>
    </div>
  </div>`;
}

async function renderMapPage() {
  const c = document.getElementById('content');
  if (!c) return;
  window.HahaMap.destroy();
  const seq = ++HM.renderSeq;
  c.innerHTML = mapSkeleton();

  if (!window.L || !window.US_STATES) {
    c.innerHTML = `<div class="alert red">地图组件未加载。请检查 /geo/leaflet.js 与 /geo/us-states.js 是否可访问。</div>`;
    return;
  }
  try {
    const [d, b] = await Promise.all([api('/api/map'), api('/api/route-batches')]);
    if (seq !== HM.renderSeq) return;
    HM.data = d;
    HM.batches = b.batches || [];
  } catch (e) {
    if (seq !== HM.renderSeq) return;
    c.innerHTML = `<div class="alert red">地图数据加载失败：${mapEsc(e.message)}</div>`;
    return;
  }
  restoreMapContext();
  if (!HM.filters.date) HM.filters.date = mapToday();
  document.getElementById('map-date').value = HM.filters.date;
  document.getElementById('map-range').value = HM.filters.range;
  document.getElementById('map-level').value = HM.filters.level;
  document.getElementById('map-type').value = HM.filters.type;

  initMap();
  bindMapToolbar();
  bindRail();
  renderMapAll({ fit: true });
}

function initMap() {
  const el = document.getElementById('v31-map');
  if (HM.map) { try { HM.map.remove(); } catch {} HM.map = null; }
  // Guard against a stale Leaflet container id if the page is re-rendered quickly.
  if (el._leaflet_id) { el.innerHTML = ''; delete el._leaflet_id; }
  HM.map = L.map(el, { zoomControl: true, minZoom: 3, maxZoom: 19, preferCanvas: true, worldCopyJump: false }).setView([39.2, -98.5], 4);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(HM.map);

  const esriAttr = '&copy; Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, and the GIS User Community';
  HM.baseLayers = {
    street: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: esriAttr }),
    light: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: esriAttr }),
    imagery: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: esriAttr })
  };
  HM.base = 'light';
  HM.baseLayers.light.addTo(HM.map);
  document.getElementById('map-base').value = 'light';
  HM.baseLayers.light.on('tileerror', () => {
    HM.tileErrors++;
    if (HM.tileErrors === 2) showMapNotice('底图瓦片加载失败；订单、州界和仓点仍可用。请检查网络或底图服务。');
  });

  HM.layers = {
    states: L.geoJSON(window.US_STATES, {
      style: feature => styleState(feature),
      onEachFeature: (feature, layer) => {
        layer.on('click', () => enterState(feature.properties.abbr));
        layer.bindTooltip(feature.properties.name, { sticky: true, direction: 'top', opacity: 0.9 });
      }
    }).addTo(HM.map),
    labels: L.layerGroup().addTo(HM.map),
    warehouses: L.layerGroup().addTo(HM.map),
    zones: L.layerGroup(),
    orders: (L.markerClusterGroup ? L.markerClusterGroup({
      maxClusterRadius: 38, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 13, chunkedLoading: true,
      iconCreateFunction: cluster => L.divIcon({
        className: 'order-cluster-wrap',
        html: `<div class="order-cluster">${cluster.getChildCount()}</div>`,
        iconSize: [34, 34], iconAnchor: [17, 17]
      })
    }) : L.layerGroup()).addTo(HM.map),
    cities: L.layerGroup(),
    clusters: L.layerGroup().addTo(HM.map),
    route: L.layerGroup().addTo(HM.map),
    counties: null
  };
  HM.map.on('click', () => { /* keep selected detail; don't clear on map pan */ });
}

function bindRail() {
  // Rail content is bound after each render; tabs are handled by delegation.
}

function bindMapToolbar() {
  const set = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
  set('map-date', 'change', e => { HM.filters.date = e.target.value || mapToday(); HM.filters.range = 'day'; document.getElementById('map-range').value='day'; renderMapAll({ fit: false }); });
  set('map-range', 'change', e => { HM.filters.range = e.target.value; renderMapAll({ fit: false }); });
  set('map-level', 'change', e => { HM.filters.level = e.target.value; renderMapAll({ fit: false }); });
  set('map-type', 'change', e => { HM.filters.type = e.target.value; renderMapAll({ fit: false }); });
  set('map-search', 'input', e => { HM.filters.search = e.target.value.trim(); renderMapAll({ fit: false }); });
  set('map-base', 'change', e => {
    Object.values(HM.baseLayers).forEach(l => HM.map.removeLayer(l));
    HM.base = e.target.value; HM.baseLayers[HM.base].addTo(HM.map);
  });
  set('map-rail-toggle', 'click', () => {
    const layout = document.querySelector('.map-layout');
    const collapsed = layout.classList.toggle('rail-collapsed');
    document.getElementById('map-rail-toggle').textContent = collapsed ? '显示面板' : '隐藏面板';
    setTimeout(()=>HM.map?.invalidateSize(), 160);
  });
  set('map-fit', 'click', () => { HM.filters.state = null; HM.filters.city = ''; renderMapAll({ fit: true }); });
  set('map-full', 'click', () => {
    const el = document.querySelector('.map-canvas-wrap');
    if (!document.fullscreenElement) el.requestFullscreen?.(); else document.exitFullscreen?.();
  });
  document.addEventListener('fullscreenchange', () => { setTimeout(()=>HM.map?.invalidateSize(), 120); });
  set('map-refresh', 'click', async () => {
    try {
      const [d, b] = await Promise.all([api('/api/map'), api('/api/route-batches')]);
      HM.data = d; HM.batches = b.batches || []; renderMapAll({ fit: false }); toast('地图数据已刷新','ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  ['orders','warehouses','clusters','labels','zones','cities','counties'].forEach(k => {
    const el = document.getElementById('ly-' + k);
    el?.addEventListener('change', () => toggleMapLayer(k, el.checked));
  });
  document.getElementById('ly-counties').checked = false;
}

function toggleMapLayer(k, on) {
  if (k === 'counties') {
    if (on) loadCounties();
    else if (HM.layers.counties) { HM.map.removeLayer(HM.layers.counties); HM.layers.counties = null; }
    return;
  }
  const layer = HM.layers[k];
  if (!layer) return;
  if (on) layer.addTo(HM.map); else HM.map.removeLayer(layer);
}

function loadCounties() {
  if (window.US_COUNTIES) {
    if (!HM.layers.counties) {
      HM.layers.counties = L.geoJSON(window.US_COUNTIES, { style: { color:'#9FB4C9', weight:0.4, fill:false, opacity:0.45 } }).addTo(HM.map);
    }
    return;
  }
  showMapNotice('县界数据加载中…');
  const s = document.createElement('script');
  s.src = './geo/us-counties.js';
  s.onload = () => {
    HM.countyLoaded = true;
    HM.layers.counties = L.geoJSON(window.US_COUNTIES, { style: { color:'#9FB4C9', weight:0.4, fill:false, opacity:0.45 } }).addTo(HM.map);
    showMapNotice('县界已加载');
  };
  s.onerror = () => showMapNotice('县界数据加载失败；不影响订单与州界。');
  document.head.appendChild(s);
}

function styleState(feature) {
  const count = stateCounts()[feature.properties.abbr] || 0;
  const active = HM.filters.state === feature.properties.abbr;
  const focused = !!HM.filters.state;
  if (focused && !active) {
    return { color:'#C7D4DF', weight:0.6, fillColor:'#DCE6EE', fillOpacity:0.18, opacity:1 };
  }
  return {
    color: active ? '#2F6F7E' : '#8FA6BC', weight: active ? 2.6 : 0.9,
    fillColor: count ? '#2F6F7E' : '#1F3A5F',
    fillOpacity: active ? 0.22 : count ? Math.min(0.40, 0.10 + count * 0.045) : 0.04,
    opacity: 1
  };
}

function renderMapAll({ fit = false } = {}) {
  const base = mapBaseOrders();
  const count = base.length;
  const stateCount = HM.filters.state ? mapFilteredOrders().length : count;
  document.getElementById('map-count').textContent = `${stateCount} 单`;
  document.getElementById('map-title').textContent = HM.filters.state ? `${stateName(HM.filters.state)} · 州内调度` : '全国网络';
  document.getElementById('map-eyebrow').textContent = HM.filters.state ? `STATE VIEW · ${HM.filters.state}` : 'US NETWORK · 全国';
  document.getElementById('map-sub').textContent = HM.filters.state
    ? `${HM.filters.state} · ${stateCount} 单 · ${new Set(mapFilteredOrders().map(o=>o.city)).size} 城市 · 点击订单查看责任链`
    : `${count} 单有坐标 · 点击州进入独立调度`;
  document.getElementById('map-empty').style.display = stateCount ? 'none' : 'flex';

  HM.layers.states.setStyle(styleState);
  renderStateLabels(base);
  renderWarehouses();
  renderClusters(mapFilteredOrders());
  renderCities();
  renderOrderMarkers(mapFilteredOrders());
  renderRouteLayer();
  renderRailContent();
  saveMapContext();
  if (fit) {
    if (HM.filters.state) {
      const f = stateFeature(HM.filters.state);
      if (f) HM.map.fitBounds(L.geoJSON(f).getBounds(), { padding: [24, 24] });
    } else {
      HM.map.fitBounds([[24.4, -125.0], [49.5, -66.5]], { padding: [8, 8] });
    }
  }
}

function renderStateLabels(base) {
  HM.layers.labels.clearLayers();
  const counts = stateCounts();
  if (HM.filters.state) return;
  for (const f of window.US_STATES.features) {
    const abbr = f.properties.abbr, n = counts[abbr] || 0;
    if (!n) continue;
    const c = stateCenter(f);
    L.marker(c, { icon: L.divIcon({ className:'state-label', html:`<div>${mapEsc(abbr)}<small>${n} 单</small></div>`, iconSize:[40,28], iconAnchor:[20,14] }), interactive:true, keyboard:false })
      .on('click', () => enterState(abbr)).addTo(HM.layers.labels);
  }
}

function renderWarehouses() {
  HM.layers.warehouses.clearLayers();
  HM.layers.zones.clearLayers();
  for (const w of HM.data.warehouses || []) {
    if (!Number.isFinite(Number(w.lat)) || !Number.isFinite(Number(w.lng))) continue;
    const letter = w.type === 'CENTER' ? 'C' : w.type === 'STATION' ? 'S' : 'F';
    const cls = w.type === 'CENTER' ? 'center' : w.type === 'STATION' ? 'station' : 'forward';
    const marker = L.marker([w.lat, w.lng], {
      icon: L.divIcon({ className:`wh-marker ${cls}`, html:`<div>${letter}</div>`, iconSize:[22,22], iconAnchor:[11,11] }),
      zIndexOffset: 600
    });
    marker.bindPopup(`<b>${mapEsc(w.name)}</b><div class="pop-sub">${mapEsc(w.type)} · ${mapEsc(w.operator || '')} · 示例/未核验</div>
      <div class="pop-row"><span>地址</span><span>${mapEsc(w.address)}, ${mapEsc(w.city)} ${mapEsc(w.state)}</span></div>
      <div class="pop-row"><span>可用库存</span><span>${w.available ?? 0} / ${w.total ?? 0} 台</span></div>
      <div class="pop-row"><span>能力</span><span>${w.capabilities_json ? '接收 / 库存 / 配送' : '—'}</span></div>
      <div class="pop-actions"><button data-goto-inventory>打开库存</button></div>`, { maxWidth: 260 });
    marker.on('popupopen', e => { e.popup.getElement()?.querySelector('[data-goto-inventory]')?.addEventListener('click', () => { saveMapContext(); go('inventory'); }); });
    marker.addTo(HM.layers.warehouses);
    const radius = w.type === 'CENTER' ? 80000 : w.type === 'STATION' ? 35000 : 50000;
    L.circle([w.lat, w.lng], { radius, color:'#2F6F7E', weight:1, dashArray:'3,7', fillColor:'#2F6F7E', fillOpacity:0.035, interactive:false })
      .bindTooltip(`${w.name} · 示例服务半径（非供应商承诺覆盖）`, { sticky:true })
      .addTo(HM.layers.zones);
  }
}

function renderCities() {
  HM.layers.cities.clearLayers();
  if (!HM.filters.state) return;
  const groups = {};
  mapFilteredOrders().forEach(o => {
    const key = o.city || 'Unknown';
    (groups[key] = groups[key] || []).push(o);
  });
  for (const [city, arr] of Object.entries(groups)) {
    const pts = arr.map(mapOrderLatLng).filter(Boolean);
    if (!pts.length) continue;
    // Offset city bubbles slightly NE so they don't sit on top of warehouse/station icons.
    const lat = pts.reduce((a,p)=>a+p[0],0)/pts.length + 0.10;
    const lng = pts.reduce((a,p)=>a+p[1],0)/pts.length + 0.09;
    L.marker([lat,lng], { icon: L.divIcon({ className:'city-bubble', html:`<div>${arr.length}</div>`, iconSize:[26,26], iconAnchor:[13,13] }), zIndexOffset: 450 })
      .bindTooltip(`${mapEsc(city)} · ${arr.length} 单`, { direction:'top' })
      .setZIndexOffset(900)
      .on('click', () => { HM.filters.city = city; document.getElementById('map-city') && (document.getElementById('map-city').value = city); renderMapAll({ fit:false }); })
      .addTo(HM.layers.cities);
  }
  if (document.getElementById('ly-cities')?.checked) HM.layers.cities.addTo(HM.map);
  else if (HM.map.hasLayer(HM.layers.cities)) HM.map.removeLayer(HM.layers.cities);
}

function renderOrderMarkers(orders) {
  HM.layers.orders.clearLayers();
  for (const o of orders) {
    const ll = mapOrderLatLng(o); if (!ll) continue;
    const selected = HM.selected.has(o.id);
    const color = mapStatusColor(o.status);
    const m = L.marker(ll, {
      icon: L.divIcon({
        className: `order-pin-wrap${selected ? ' selected' : ''}`,
        html: `<div class="order-pin" style="--pin:${color}"><span>${o.is_demo ? 'D' : ''}</span></div>`,
        iconSize: selected ? [26, 26] : [20, 20], iconAnchor: selected ? [13, 13] : [10, 10]
      }),
      riseOnHover: true, zIndexOffset: selected ? 800 : 400
    });
    m.bindPopup(orderPopup(o), { maxWidth: 290 });
    m.bindTooltip(`${mapEsc(o.order_no)} · ${mapEsc(o.customer_name || '')}`, { direction:'top', offset:[0,-8], opacity:0.92 });
    m.on('click', () => selectMapOrder(o.id));
    m.on('popupopen', e => {
      const el = e.popup.getElement();
      el?.querySelector('[data-open-order]')?.addEventListener('click', () => openOrderFromMap(o.id));
      el?.querySelector('[data-select-order]')?.addEventListener('click', () => { toggleMapOrder(o.id); });
    });
    m.addTo(HM.layers.orders);
  }
}

function orderPopup(o) {
  const batch = o.batch ? `<span class="route-badge">${mapEsc(o.batch.batch_no)}</span>` : '';
  return `<b>${mapEsc(o.order_no)}</b> ${batch}<div class="pop-sub">${mapEsc(o.customer_name || '')} · ${mapEsc(o.city || '')} ${mapEsc(o.state || '')}</div>
    <div class="pop-row"><span>状态</span><span>${mapEsc(mapStatusLabel(o.status))}</span></div>
    <div class="pop-row"><span>模式</span><span>${mapEsc(mapModeLabel(o.mode))}</span></div>
    <div class="pop-row"><span>设备</span><span>${mapEsc((o.items||[]).map(i=>i.model+' × '+i.qty).join(' / ') || '—')}</span></div>
    <div class="pop-row"><span>日期</span><span>${mapEsc(mapOrderDate(o))} · ${mapEsc(mapLevelLabel(o.service_level))}</span></div>
    <div class="pop-row"><span>交付</span><span>${mapEsc(mapTypeLabel(o.location_type))}</span></div>
    <div class="pop-row"><span>坐标</span><span>${o.geo_source==='manual'?'楼栋级':'近似 · 需核验'}</span></div>
    <div class="pop-actions"><button data-open-order>订单详情</button><button data-select-order>选中/取消</button></div>`;
}

function enterState(abbr) {
  HM.filters.state = abbr; HM.filters.city = '';
  renderMapAll({ fit: true });
}
function backNational() {
  HM.filters.state = null; HM.filters.city = '';
  renderMapAll({ fit: true });
}

function selectMapOrder(id) {
  HM.selectedOrder = id;
  if (!HM.selected.has(id)) HM.selected.add(id);
  refreshMarkerStyles();
  renderRailContent();
  saveMapContext();
  const o = HM.data.orders.find(x=>x.id===id);
  const ll = o && mapOrderLatLng(o);
  if (ll) HM.map.panTo(ll, { animate: true });
}
function toggleMapOrder(id) {
  if (HM.selected.has(id)) HM.selected.delete(id); else HM.selected.add(id);
  HM.selectedOrder = id;
  refreshMarkerStyles(); renderRailContent(); saveMapContext();
}
function refreshMarkerStyles() {
  renderOrderMarkers(mapFilteredOrders());
  renderRailContent();
}
function selectMany(ids) {
  ids.forEach(id=>HM.selected.add(id));
  HM.selectedOrder = ids[0] || null;
  refreshMarkerStyles(); saveMapContext();
}

function computeClusters(orders) {
  const arr = orders.filter(o=>mapOrderLatLng(o));
  const used = new Set(), clusters = [];
  for (let i=0;i<arr.length;i++) {
    if (used.has(i)) continue;
    const group = [arr[i]]; used.add(i);
    for (let j=i+1;j<arr.length;j++) {
      if (used.has(j)) continue;
      if (group.some(g => haversine(mapOrderLatLng(g), mapOrderLatLng(arr[j])) <= 12000)) { group.push(arr[j]); used.add(j); }
    }
    if (group.length >= 2) {
      const pts = group.map(mapOrderLatLng);
      clusters.push({ orders: group, lat: pts.reduce((a,p)=>a+p[0],0)/pts.length, lng: pts.reduce((a,p)=>a+p[1],0)/pts.length });
    }
  }
  return clusters;
}

function renderClusters(orders) {
  HM.layers.clusters.clearLayers();
  HM.clusters = computeClusters(orders);
  if (!HM.clusters.length) return;
  for (const c of HM.clusters) {
    const radius = Math.max(1000, ...c.orders.map(o => haversine([c.lat,c.lng], mapOrderLatLng(o))));
    L.circle([c.lat,c.lng], { radius, color:'#2F6F7E', weight:1, dashArray:'3,4', fillColor:'#2F6F7E', fillOpacity:0.07, interactive:true })
      .on('click', () => selectMany(c.orders.map(o=>o.id)))
      .bindTooltip(`地理接近 ${c.orders.length} 单（仅聚合，未批准合单）`, { sticky:true })
      .addTo(HM.layers.clusters);
  }
}

function renderRailContent() {
  const rail = document.getElementById('map-rail-body');
  if (!rail) return;
  const tab = document.querySelector('.rail-tab.active')?.dataset.rail || 'dispatch';
  if (tab === 'batches') return renderBatchesRail(rail);
  if (tab === 'guide') return renderGuideRail(rail);
  renderDispatchRail(rail);
}

function groupCityCounts(orders) {
  const m = {};
  orders.forEach(o => { const c = o.city || 'Unknown'; m[c] = (m[c] || 0) + 1; });
  return Object.entries(m).sort((a,b)=>b[1]-a[1]);
}

function renderDispatchRail(rail) {
  const orders = mapFilteredOrders();
  const base = mapBaseOrders();
  const counts = stateCounts();
  const cities = [...new Set(orders.map(o=>o.city).filter(Boolean))].sort();
  const selected = [...HM.selected].map(id=>HM.data.orders.find(o=>o.id===id)).filter(Boolean);
  const stateTop = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const detail = HM.selectedOrder ? HM.data.orders.find(o=>o.id===HM.selectedOrder) : null;
  rail.innerHTML = `
    ${HM.filters.state ? `<div class="map-state-head"><button class="back" id="map-back">← 全国</button><div><h3>${mapEsc(stateName(HM.filters.state))}</h3><span>${mapEsc(HM.filters.state)} · ${orders.length} 单 · ${cities.length} 个城市</span></div></div>` : ''}
    <div class="rail-stat"><div><b>${base.length}</b><span>当前范围</span></div><div><b>${orders.length}</b><span>${HM.filters.state ? '州内' : '全国'}</span></div><div><b>${selected.length}</b><span>已选</span></div></div>
    ${HM.filters.state ? `<div class="city-chips">${groupCityCounts(orders).map(([c,n])=>`<button class="city-chip ${HM.filters.city===c?'active':''}" data-city-chip="${mapEsc(c)}">${mapEsc(c)} <b>${n}</b></button>`).join('')}</div><div class="rail-filters"><select id="map-city"><option value="">全部城市</option>${cities.map(c=>`<option ${HM.filters.city===c?'selected':''}>${mapEsc(c)}</option>`).join('')}</select><button class="map-btn" id="map-clear-city">清除</button></div>` : ''}
    ${detail ? mapDetailHtml(detail) : `<div class="rail-section" style="background:#FBFDFE"><h4>调度提示 <span class="x">SELECT</span></h4><div class="small muted">点击地图点位或下方订单，查看设备、仓库、履约模式、闸门和成本。勾选多张订单可生成路线。</div></div>`}
    ${routePanelHtml(selected)}
    <div class="rail-section"><h4>订单 <span class="x">${orders.length} 单</span></h4>
      <div id="map-order-list">${orders.length ? orders.map(o=>orderRowHtml(o)).join('') : `<div class="rail-empty">当前日期/筛选无订单</div>`}</div>
    </div>
    ${!HM.filters.state && stateTop.length ? `<div class="rail-section"><h4>州排行 <span class="x">点击进入</span></h4>${stateTop.map(([s,n])=>`<div class="map-cluster" data-state="${s}"><span><b>${mapEsc(s)}</b> ${mapEsc(stateName(s))}</span><span>${n} 单 ›</span></div>`).join('')}</div>` : ''}
    ${HM.clusters.length ? `<div class="rail-section"><h4>地理聚合 <span class="x">仅接近，不是合单</span></h4>${HM.clusters.map((c,i)=>`<div class="map-cluster" data-cluster="${i}"><span><b>${c.orders.length} 单</b><div class="hint">${mapEsc(c.orders.map(o=>o.city).filter(Boolean).slice(0,2).join('/'))} · 约 ${(Math.max(...c.orders.map(o=>haversine([c.lat,c.lng],mapOrderLatLng(o))))/1000).toFixed(1)} km</div></span><span>选中 ›</span></div>`).join('')}</div>` : ''}
    <div class="rail-section"><h4>最近批次 <span class="x">${HM.batches.length}</span></h4>${batchMiniList()}</div>`;
  bindDispatchRail();
}

function orderRowHtml(o) {
  const checked = HM.selected.has(o.id);
  return `<div class="map-order-row ${checked?'selected':''}" data-order-row="${o.id}">
    <input class="chk" type="checkbox" data-order-check="${o.id}" ${checked?'checked':''}>
    <div class="body"><div class="top"><span class="no">${mapEsc(o.order_no)}</span><span class="badge ${o.status==='COMMITTED'?'green':o.status==='DISPATCHED'?'teal':o.status==='REVIEW'?'amber':'gray'}">${mapEsc(mapStatusLabel(o.status))}</span></div>
      <div class="name">${mapEsc(o.customer_name||'')} · ${mapEsc(o.city||'')} ${mapEsc(o.state||'')}</div>
      <div class="meta"><span>${mapEsc(mapModeLabel(o.mode))}</span><span>${mapEsc(o.service_level||'')}</span><span>${mapEsc(mapOrderDate(o))}</span>${o.is_demo?'<span class="tag demo">演示</span>':''}${o.batch?`<span class="tag batch">${mapEsc(o.batch.batch_no)}</span>`:''}</div>
    </div></div>`;
}

function mapDetailHtml(o) {
  const items = (o.items||[]).map(i=>`${i.model} × ${i.qty}`).join(' / ') || '—';
  const plan = o.plan;
  const wh = plan?.legs?.[0]?.origin || '未分配';
  const gates = Object.entries(o.gates||{}).map(([g,s])=>`${g}:${s}`).join(' · ');
  return `<div class="map-detail"><h4>${mapEsc(o.order_no)} ${badge(o.status)}</h4><div class="sub">${mapEsc(o.customer_name||'')} · ${mapEsc(o.city||'')} ${mapEsc(o.state||'')}</div>
    <div class="kv"><span>设备</span><span>${mapEsc(items)}</span></div>
    <div class="kv"><span>模式</span><span>${mapEsc(mapModeLabel(o.mode))}</span></div>
    <div class="kv"><span>仓库/起点</span><span>${mapEsc(wh)}</span></div>
    <div class="kv"><span>等级/位置</span><span>${mapEsc(mapLevelLabel(o.service_level))} · ${mapEsc(mapTypeLabel(o.location_type))}</span></div>
    <div class="kv"><span>坐标精度</span><span>${o.geo_source==='manual'?'楼栋级':'近似 · 需核验'}</span></div>
    <div class="kv"><span>闸门</span><span>${mapEsc(gates || '—')}</span></div>
    <div class="kv"><span>成本</span><span>${mapMoney(plan?.total)}</span></div>
    <div class="kv"><span>异常</span><span>${o.exceptions ? `${o.exceptions} 条` : '无'}</span></div>
    <div class="actions"><button class="map-btn primary" data-open-detail="${o.id}">打开订单详情</button><button class="map-btn" data-route-add="${o.id}">加入路线</button></div>
  </div>`;
}

function routePanelHtml(selected) {
  const whs = HM.data.warehouses || [];
  const stations = whs.filter(w=>w.type==='STATION');
  const origins = whs.filter(w=>['CENTER','STATION','FORWARD'].includes(w.type));
  return `<div class="route-box"><h4>路线规划 / ROUTE</h4>
    <div class="route-grid"><label>类型<select id="route-type"><option value="FINAL_DELIVERY">最终配送路线</option><option value="TRANSFER">仓库→站点转运</option></select></label>
      <label>起点<select id="route-origin">${origins.map(w=>`<option value="${w.id}" ${w.id==='wh-center'?'selected':''}>${mapEsc(w.name)}</option>`).join('')}</select></label>
      <label id="route-station-wrap" style="display:none">目的站点<select id="route-station">${stations.map(w=>`<option value="${w.id}">${mapEsc(w.name)}</option>`).join('')}</select></label>
      <label class="full" style="grid-column:1/-1">车辆参考<select id="route-vehicle">${(HM.data.vehicles||[]).map(v=>`<option value="${v.id}">${mapEsc(v.name)} · ${v.max_weight_kg}kg / ${v.max_stops}站 · ${v.status==='DEMO'?'演示':'已核验'}</option>`).join('')}</select></label></div>
    <div class="small muted" style="margin:-1px 0 5px">示例车辆不代表哈哈便利自有运力，也不代表供应商已确认；保存批次前需真实排线确认。</div>
    <div class="route-actions"><button class="map-btn teal" id="route-build" ${selected.length<2?'disabled':''}>生成路线建议</button><button class="map-btn" id="route-clear">清除</button></div>
    <div class="route-summary" id="route-summary">${HM.route ? routeSummaryHtml() : `已选 ${selected.length} 单。至少 2 单可生成多点路线；距离仅为路线建议，不是已确认 ETA。`}</div>
    ${HM.route ? `<button class="map-btn primary" id="route-save" style="margin-top:5px">保存为调度批次</button>` : ''}
  </div>`;
}

function batchMiniList() {
  if (!HM.batches.length) return `<div class="rail-empty">暂无批次</div>`;
  return HM.batches.slice(0,5).map(b=>`<div class="batch-row"><div class="top"><span class="no">${mapEsc(b.batch_no)}</span><span class="badge ${b.status==='CANCELLED'?'red':b.type==='TRANSFER'?'amber':'teal'}">${mapEsc(b.type==='TRANSFER'?'转运':'终配')} ${mapEsc(b.status)}</span></div><div class="meta">${b.orders?.length||0} 单 · ${b.total_distance_m?fmtKm(b.total_distance_m):'—'} · ${b.total_weight_kg?b.total_weight_kg+'kg':'—'} · ${mapEsc(b.route_mode||'')}</div></div>`).join('');
}

function bindDispatchRail() {
  document.getElementById('map-back')?.addEventListener('click', backNational);
  document.getElementById('map-clear-city')?.addEventListener('click', ()=>{ HM.filters.city=''; renderMapAll({fit:false}); });
  document.getElementById('map-city')?.addEventListener('change', e=>{ HM.filters.city=e.target.value; renderMapAll({fit:false}); });
  document.querySelectorAll('[data-city-chip]').forEach(el=>el.addEventListener('click',()=>{ HM.filters.city = HM.filters.city===el.dataset.cityChip ? '' : el.dataset.cityChip; renderMapAll({fit:false}); }));
  document.querySelectorAll('[data-order-row]').forEach(row=>{
    row.addEventListener('click', e=>{
      if (e.target.matches('[data-order-check]')) return;
      selectMapOrder(row.dataset.orderRow);
    });
  });
  document.querySelectorAll('[data-order-check]').forEach(chk=>{
    chk.addEventListener('click', e=>e.stopPropagation());
    chk.addEventListener('change', ()=>toggleMapOrder(chk.dataset.orderCheck));
  });
  document.querySelectorAll('[data-state]').forEach(el=>el.addEventListener('click',()=>enterState(el.dataset.state)));
  document.querySelectorAll('[data-cluster]').forEach(el=>el.addEventListener('click',()=>{ const c=HM.clusters[Number(el.dataset.cluster)]; if(c) selectMany(c.orders.map(o=>o.id)); }));
  document.querySelectorAll('[data-open-detail]').forEach(b=>b.addEventListener('click',()=>openOrderFromMap(b.dataset.openDetail)));
  document.querySelectorAll('[data-route-add]').forEach(b=>b.addEventListener('click',()=>{ HM.selected.add(b.dataset.routeAdd); refreshMarkerStyles(); }));
  const typeEl = document.getElementById('route-type');
  typeEl?.addEventListener('change',()=>{ document.getElementById('route-station-wrap').style.display = typeEl.value==='TRANSFER'?'flex':'none'; });
  document.getElementById('route-build')?.addEventListener('click', buildRoute);
  document.getElementById('route-clear')?.addEventListener('click',()=>{ HM.route=null; renderRouteLayer(); renderRailContent(); });
  document.getElementById('route-save')?.addEventListener('click', saveRouteBatch);
}

function routeSummaryHtml() {
  const r = HM.route;
  if (!r) return '';
  return `<div><span class="route-badge">${r.mode === 'OSRM' ? 'OSRM 道路路线' : '直线估算 · 非道路 ETA'}</span> ${mapEsc(r.type==='TRANSFER'?'仓库→站点转运':'最终配送路线')}</div>
    <div><b>${fmtKm(r.distance)}</b> · <b>${fmtDur(r.duration)}</b> · ${r.stops.length} 个停靠点 · 参考载重 ${r.weight||0} kg</div>
    <div>起点：${mapEsc(r.originName)}${r.type==='TRANSFER'?` → ${mapEsc(r.stationName)}`:''}</div>
    <div class="small">${r.mode==='OSRM'?'道路距离与时间来自 OSRM 演示服务，仍需供应商确认排线。':'OSRM 不可用，当前仅显示直线距离估算，不是实际道路距离/ETA，不能作为正式承诺。'}</div>`;
}

async function buildRoute() {
  const selected = [...HM.selected].map(id=>HM.data.orders.find(o=>o.id===id)).filter(o=>o && mapOrderLatLng(o));
  if (selected.length < 2) return toast('至少选择 2 张有坐标的订单','err');
  const type = document.getElementById('route-type').value;
  const originId = document.getElementById('route-origin').value;
  const vehicleId = document.getElementById('route-vehicle')?.value || null;
  const vehicle = (HM.data.vehicles||[]).find(v=>v.id===vehicleId);
  const totalWeight = selected.reduce((a,o)=>a+(o.items||[]).reduce((b,i)=>b+Number(i.weight_kg||0)*Number(i.qty||1),0),0);
  if (vehicle && totalWeight > Number(vehicle.max_weight_kg||0)) return toast(`参考载重 ${totalWeight}kg 超过 ${vehicle.name} 上限 ${vehicle.max_weight_kg}kg；请换车或拆分`,'err');
  if (vehicle && selected.length > Number(vehicle.max_stops||99)) return toast(`站点数超过 ${vehicle.name} 上限`,'err');
  const origin = (HM.data.warehouses||[]).find(w=>w.id===originId);
  const station = (HM.data.warehouses||[]).find(w=>w.id===document.getElementById('route-station')?.value);
  if (!origin) return toast('请选择起点仓库','err');
  if (type === 'TRANSFER' && !station) return toast('请选择目的专业站点','err');
  const start = [Number(origin.lat), Number(origin.lng)];
  let stops;
  if (type === 'TRANSFER') {
    stops = [start, [Number(station.lat), Number(station.lng)]];
  } else {
    // nearest-neighbour ordering from origin; no time-window optimisation
    const remaining = selected.slice();
    const ordered = [];
    let cur = start;
    while (remaining.length) {
      remaining.sort((a,b)=>haversine(cur,mapOrderLatLng(a))-haversine(cur,mapOrderLatLng(b)));
      const next = remaining.shift(); ordered.push(next); cur = mapOrderLatLng(next);
    }
    stops = [start, ...ordered.map(mapOrderLatLng)];
  }
  const btn = document.getElementById('route-build'); btn.disabled=true; btn.textContent='规划中…';
  let result = null;
  try { result = await osrmRoute(stops); } catch {}
  if (!result) {
    let distance = 0;
    for (let i=1;i<stops.length;i++) distance += haversine(stops[i-1], stops[i]);
    distance = distance * 1.22;
    result = { mode:'ESTIMATE', distance, duration: distance / 9.72, geometry: stops };
    showMapNotice('OSRM 不可用，已回退为直线里程估算；不是实际道路 ETA。');
  }
  HM.route = { type, originId, originName:origin.name, stationId:type==='TRANSFER'?station.id:null, stationName:type==='TRANSFER'?station.name:null,
    orderIds:selected.map(o=>o.id), stops: stops.slice(1), distance:result.distance, duration:result.duration, geometry:result.geometry, mode:result.mode,
    vehicleId, vehicleName:vehicle?.name||null, weight:totalWeight };
  renderRouteLayer(); renderRailContent();
  const b = document.querySelector('.map-canvas-wrap'); if (b) HM.map.fitBounds(L.latLngBounds(stops), { padding:[40,40] });
}

async function osrmRoute(stops) {
  const coords = stops.map(p=>`${p[1]},${p[0]}`).join(';');
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 9000);
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`, { signal:ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    if (j.code !== 'Ok' || !j.routes?.[0]) return null;
    const r = j.routes[0];
    return { mode:'OSRM', distance:r.distance, duration:r.duration, geometry:r.geometry.coordinates.map(([lng,lat])=>[lat,lng]) };
  } catch { return null; } finally { clearTimeout(timer); }
}

function renderRouteLayer() {
  HM.layers.route.clearLayers();
  if (!HM.route) return;
  const pts = HM.route.geometry;
  L.polyline(pts, { color: HM.route.mode==='OSRM'?'#1F6F8B':'#B7791F', weight:4, opacity:0.8, dashArray: HM.route.mode==='OSRM'?null:'7,6', className:'map-route-line' }).addTo(HM.layers.route);
  const origin = pts[0];
  L.marker(origin, { icon: L.divIcon({ className:'route-stop', html:'<div>起</div>', iconSize:[18,18], iconAnchor:[9,9] }) }).addTo(HM.layers.route);
  HM.route.stops.forEach((p,i)=>{
    if (HM.route.type==='TRANSFER') return;
    L.marker(p, { icon: L.divIcon({ className:'route-stop', html:`<div>${i+1}</div>`, iconSize:[18,18], iconAnchor:[9,9] }) }).addTo(HM.layers.route);
  });
}

async function saveRouteBatch() {
  if (!HM.route) return;
  try {
    const r = await api('/api/route-batches', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
      type: HM.route.type, origin_warehouse_id: HM.route.originId, order_ids: HM.route.orderIds,
      total_distance_m: HM.route.distance, total_duration_s: HM.route.duration, route_mode: HM.route.mode,
      vehicle_id: HM.route.vehicleId,
      notes: HM.route.type==='TRANSFER' ? `To station ${HM.route.stationId}` : 'Final delivery route suggestion'
    })});
    toast(`批次 ${r.batch.batch_no} 已保存`, 'ok');
    const [d,b] = await Promise.all([api('/api/map'),api('/api/route-batches')]); HM.data=d; HM.batches=b.batches;
    HM.route=null; renderMapAll({fit:false});
  } catch (e) { toast(e.message,'err'); }
}

function renderBatchesRail(rail) {
  rail.innerHTML = `<div class="rail-section"><h4>调度批次 <span class="x">转运 / 终配分开</span></h4>
    <div class="small muted" style="margin-bottom:6px">TRANSFER = 仓库→专业站点集中转运；FINAL_DELIVERY = 最终配送多点路线。两者不能混为同一概念。</div>
    ${HM.batches.length ? HM.batches.map(b=>`<div class="batch-row"><div class="top"><span class="no">${mapEsc(b.batch_no)}</span><span class="badge ${b.status==='CANCELLED'?'red':b.type==='TRANSFER'?'amber':'teal'}">${mapEsc(b.type==='TRANSFER'?'转运':'终配')} · ${mapEsc(b.status)}</span></div>
      <div class="meta">${b.orders?.length||0} 单 · ${b.orders?.map(o=>o.order_no).join(', ')||'—'}<br>${b.total_distance_m?fmtKm(b.total_distance_m):'—'} · ${fmtDur(b.total_duration_s)} · ${b.total_weight_kg?b.total_weight_kg+' kg':'—'} · ${mapEsc(b.route_mode||'')}</div>
      <div class="acts">${b.status!=='CANCELLED'?`<button data-batch-cancel="${b.id}">取消</button><button data-batch-split="${b.id}">拆出订单</button>`:''}<button data-batch-view="${b.id}">定位订单</button></div></div>`).join('') : `<div class="rail-empty">暂无批次</div>`}
  </div>`;
  document.querySelectorAll('[data-batch-cancel]').forEach(el=>el.addEventListener('click',()=>cancelBatch(el.dataset.batchCancel)));
  document.querySelectorAll('[data-batch-split]').forEach(el=>el.addEventListener('click',()=>splitBatch(el.dataset.batchSplit)));
  document.querySelectorAll('[data-batch-view]').forEach(el=>el.addEventListener('click',()=>viewBatch(el.dataset.batchView)));
}
function renderGuideRail(rail) {
  rail.innerHTML = `<div class="rail-section"><h4>地图说明</h4><div class="small muted" style="line-height:1.8">
    <b>全国视图</b>：州界颜色与单量表示订单密度，点击州进入独立视图。<br>
    <b>州内视图</b>：显示城市气泡、订单点、仓库/站点/区域仓。<br>
    <b>聚合圈</b>：仅代表地理位置接近，不等于已批准合单；合单仍需车辆、人员、服务、供应商确认。<br>
    <b>路线</b>：OSRM 道路路线为参考；OSRM 不可用时显示“直线估算”，不能作为正式 ETA。<br>
    <b>批次</b>：保存的是调度建议批次，不自动改变承诺或派车状态。<br>
    <b>数据</b>：标记“演示”的订单/仓/车辆不是真实客户或已核验资源。</div></div>
    <div class="rail-section"><h4>责任边界</h4><div class="small muted">地图展示订单、仓/站点与批次，不替代供应商书面确认、G1/G2/G3 闸门或正式承诺。所有业务动作以订单详情与服务端校验为准。</div></div>`;
}
function renderRail() { renderRailContent(); }

async function cancelBatch(id) {
  if (!confirm('取消该批次？订单关联会解除，但不会改变订单承诺状态。')) return;
  try { await api(`/api/route-batches/${id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); toast('批次已取消','ok'); const [d,b]=await Promise.all([api('/api/map'),api('/api/route-batches')]); HM.data=d; HM.batches=b.batches; renderMapAll({fit:false}); }
  catch(e){ toast(e.message,'err'); }
}
async function splitBatch(id) {
  const b = HM.batches.find(x=>x.id===id);
  if (!b) return;
  const nos = (b.orders||[]).map(o=>o.order_no).join(', ');
  const input = prompt(`输入要拆出的订单号（当前：${nos}）`, b.orders?.[0]?.order_no || '');
  if (!input) return;
  const ids = String(input).split(',').map(s=>s.trim()).filter(Boolean).map(no=>b.orders.find(o=>o.order_no===no)?.order_id).filter(Boolean);
  if (!ids.length) return toast('未找到对应订单','err');
  try { await api(`/api/route-batches/${id}/split`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order_ids:ids})}); toast('已拆分为新批次','ok'); const [d,bb]=await Promise.all([api('/api/map'),api('/api/route-batches')]); HM.data=d; HM.batches=bb.batches; renderMapAll({fit:false}); }
  catch(e){ toast(e.message,'err'); }
}
function viewBatch(id) {
  const b = HM.batches.find(x=>x.id===id); if (!b) return;
  const ids = (b.orders||[]).map(o=>o.order_id);
  selectMany(ids);
  go('map');
}

function openOrderFromMap(id) { saveMapContext(); go('order', id); }
function saveMapContext() {
  try { sessionStorage.setItem(MAP_CTX_KEY, JSON.stringify({ filters:HM.filters, selected:[...HM.selected], selectedOrder:HM.selectedOrder })); } catch {}
}
function restoreMapContext() {
  try {
    const raw = sessionStorage.getItem(MAP_CTX_KEY); if (!raw) return;
    const c = JSON.parse(raw);
    if (c.filters) HM.filters = {...HM.filters, ...c.filters};
    if (Array.isArray(c.selected)) HM.selected = new Set(c.selected);
    HM.selectedOrder = c.selectedOrder || null;
    // If a state no longer exists, fall back national
    if (HM.filters.state && !stateFeature(HM.filters.state)) HM.filters.state = null;
  } catch {}
}
function showMapNotice(msg) {
  const el = document.getElementById('map-notice'); if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(showMapNotice.t);
  showMapNotice.t = setTimeout(()=>el.classList.remove('show'), 5000);
}

// Rail tab switching (bound once per page load via delegation)
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.rail-tab');
  if (!tab) return;
  document.querySelectorAll('.rail-tab').forEach(x=>x.classList.toggle('active', x===tab));
  renderRail();
});

// expose for debugging/automation
window.HM = HM;
