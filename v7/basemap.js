/* V7 basemap registry.
 *
 * Lessons from the two failures this file exists to prevent:
 *   - openstreetmap.org blocks unregistered apps (403 + broken-tile wall);
 *   - a US-government tile host is unreachable from mainland China (timeout).
 * So the page never commits to one vendor: it probes the candidate list with a
 * real image request and uses the first one that answers, caching the winner.
 *
 * Order matters. Esri raster endpoints answer from this network in ~2 s and have
 * worldwide road + imagery coverage; USGS is kept as a public-domain fallback for
 * networks where the reverse is true. 高德 is offered as an explicit option because
 * it is the fastest here, but its overseas detail is poor and it uses GCJ-02, so
 * it is not the default for a US map.
 *
 * Nothing loads until the user opens the map (or asks), and three failed tiles
 * drop the layer automatically.
 */
(function (H) {
  'use strict';
  const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const PROBE_KEY = 'haha-v7-tile-probe';
  const PROVIDERS = {
    'esri-street': {
      kind: 'road', label: '路网 · Esri', short: 'Esri',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19, attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a> — World Street Map'
    },
    'usgs-topo': {
      kind: 'road', label: '路网 · USGS', short: 'USGS',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 16, attribution: 'Tiles © <a href="https://www.usgs.gov/">USGS</a> The National Map'
    },
    'gaode-road': {
      kind: 'road', label: '路网 · 高德', short: '高德',
      url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      subdomains: '1234', maxZoom: 18, attribution: '© 高德地图（演示用，正式商用需授权）'
    },
    'esri-imagery': {
      kind: 'satellite', label: '卫星 · Esri', short: 'Esri',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19, attribution: 'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
    },
    'usgs-imagery': {
      kind: 'satellite', label: '卫星 · USGS', short: 'USGS',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 16, attribution: 'Imagery © <a href="https://www.usgs.gov/">USGS</a> The National Map'
    },
    'gaode-sat': {
      kind: 'satellite', label: '卫星 · 高德', short: '高德',
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      subdomains: '1234', maxZoom: 18, attribution: '© 高德地图（演示用，正式商用需授权）'
    }
  };
  const CHAINS = {
    road: ['esri-street', 'usgs-topo', 'gaode-road'],
    satellite: ['esri-imagery', 'usgs-imagery', 'gaode-sat']
  };
  const S = { kind: 'offline', id: 'offline', map: null, layer: null, fails: 0, busy: false, onChange: null, lastError: '' };

  function tiles() {
    const st = H.state.settings = H.state.settings || {};
    const t = st.tiles = st.tiles || {};
    ['url', 'name', 'attribution', 'subdomains', 'key'].forEach(k => { if (t[k] == null) t[k] = ''; });
    if (!t.maxZoom) t.maxZoom = 18;
    return t;
  }

  function expand(template, sub) {
    return String(template || '')
      .replace(/\{key\}/g, encodeURIComponent(tiles().key || ''))
      .replace(/\{s\}/g, sub || 'a');
  }

  function config(id) {
    if (!id || id === 'offline') return { id: 'offline', kind: 'offline', label: '离线', url: null };
    if (id === 'custom') {
      const t = tiles();
      if (!String(t.url).trim()) return null;
      return {
        id: 'custom', kind: 'custom', label: t.name || '自定义',
        url: expand(t.url, String(t.subdomains || 'a').charAt(0)),
        maxZoom: Number(t.maxZoom) || 18, subdomains: t.subdomains || '',
        attribution: t.attribution || '自定义瓦片源'
      };
    }
    const p = PROVIDERS[id];
    return p ? Object.assign({ id: id }, p) : null;
  }

  function label() { const c = config(S.id); return c ? c.label : '离线'; }

  function emit() {
    const info = { kind: S.kind, id: S.id, label: label(), online: S.kind !== 'offline', busy: S.busy, error: S.lastError };
    try { S.onChange && S.onChange(info); } catch (err) { console.warn('basemap onChange failed', err); }
    return info;
  }

  function detach() {
    if (S.layer && S.map) { try { S.map.removeLayer(S.layer); } catch (err) { /* already gone */ } }
    S.layer = null;
    S.fails = 0;
  }

  function fail(reason) {
    detach();
    S.kind = 'offline'; S.id = 'offline'; S.lastError = reason || '底图瓦片连续失败';
    if (H.toast) H.toast('底图不可达，已切回离线州界；可在「图层」里换一个源或配置自定义瓦片。');
    emit();
  }

  /** One real image request; resolves true only if pixels actually arrived. */
  function probe(cfg, timeout) {
    return new Promise(resolve => {
      if (!cfg || !cfg.url) return resolve(false);
      const sub = String(cfg.subdomains || 'a').charAt(0);
      const src = expand(cfg.url, sub)
        .replace(/\{z\}/g, '5').replace(/\{x\}/g, '8').replace(/\{y\}/g, '12').replace(/\{r\}/g, '');
      const img = new Image();
      let settled = false;
      const finish = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok && img.naturalWidth > 0); } };
      const timer = setTimeout(() => finish(false), timeout || 4000);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = src;
    });
  }

  function cached(id) {
    try {
      const x = JSON.parse(sessionStorage.getItem(PROBE_KEY));
      if (x && x.id === id && Date.now() - x.at < 10 * 60 * 1000) return true;
    } catch (err) { /* private mode */ }
    return false;
  }

  function remember(id) {
    try { sessionStorage.setItem(PROBE_KEY, JSON.stringify({ id: id, at: Date.now() })); } catch (err) { /* ignore */ }
  }

  function attach(cfg) {
    S.id = cfg.id; S.kind = cfg.kind; S.fails = 0; S.lastError = '';
    const layer = L.tileLayer(cfg.url, {
      maxZoom: cfg.maxZoom || 18,
      minZoom: 3,
      errorTileUrl: TRANSPARENT,
      attribution: cfg.attribution || '',
      subdomains: cfg.subdomains || 'abc',
      updateWhenIdle: true,
      keepBuffer: 3,
      className: 'dx-tile-layer'
    });
    layer.on('tileerror', () => { S.fails += 1; if (S.fails >= 3) fail('瓦片请求失败 ' + S.fails + ' 次'); });
    layer.on('load', () => { S.fails = 0; });
    layer.addTo(S.map);
    try { layer.bringToBack(); } catch (err) { /* older leaflet */ }
    S.layer = layer;
    remember(cfg.id);
    return emit();
  }

  /** 'road' / 'satellite' walk the candidate chain; a concrete id applies directly. */
  async function use(map, want) {
    if (map) S.map = map;
    if (!S.map) return emit();
    if (want === 'offline') { detach(); S.kind = 'offline'; S.id = 'offline'; return emit(); }
    if (want === 'custom') {
      const cfg = config('custom');
      if (!cfg) { if (H.toast) H.toast('自定义瓦片源还没配置地址，请到「接口与时区」页填写。'); return emit(); }
      detach();
      return attach(cfg);
    }
    const chain = CHAINS[want] ? CHAINS[want] : (PROVIDERS[want] ? [want] : []);
    if (!chain.length) return emit();
    detach();
    S.busy = true; S.kind = want; S.id = 'offline';
    emit();
    let chosen = null;
    try {
      for (const id of chain) {
        const cfg = config(id);
        if (!cfg) continue;
        if (cached(id) || await probe(cfg, 4000)) { chosen = cfg; break; }
      }
    } finally {
      S.busy = false;
    }
    if (chosen) return attach(chosen);
    fail('附近网络到 ' + want + ' 底图都不可达');
    return emit();
  }

  /** Called once from the map mount. Honours ?basemap=…, then the last probe winner. */
  function autoStart(map, fallback) {
    if (map) S.map = map;
    let want = fallback || 'road';
    try {
      const q = new URLSearchParams(location.search).get('basemap');
      if (q) want = q;
      else {
        const x = JSON.parse(sessionStorage.getItem(PROBE_KEY));
        if (x && x.id) want = PROVIDERS[x.id] ? PROVIDERS[x.id].kind : 'road';
      }
    } catch (err) { /* ignore */ }
    return use(null, want);
  }

  H.basemap = {
    providers: PROVIDERS,
    chains: CHAINS,
    tiles: tiles,
    config: config,
    label: label,
    use: use,
    autoStart: autoStart,
    detach: detach,
    probe: probe,
    info: function () { return { kind: S.kind, id: S.id, label: label(), online: S.kind !== 'offline', busy: S.busy, error: S.lastError }; },
    onChange: function (fn) { S.onChange = fn; }
  };
})(window.HH);
