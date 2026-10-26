/* V7 basemap registry.
 *
 * Design rules, learned from the OSM 403 incident:
 *   1. Default is offline. Nothing is requested until the user asks for it.
 *   2. Every provider is explicit about who serves it and under what terms.
 *   3. A provider that fails three tiles is dropped automatically; the map goes
 *      back to the offline geometry instead of showing broken tiles.
 *   4. No provider is hard-coded into the page: the same registry also accepts a
 *      user-supplied XYZ/WMTS template (Tianditu, MapTiler, an internal tile
 *      server) so a company deployment is not locked to a public endpoint.
 *
 * Public-domain default: USGS The National Map. No key, no per-app registration,
 * US coverage only — which matches this workspace.
 */
(function (H) {
  'use strict';
  const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const PRESETS = {
    'usgs-topo': {
      label: '路网 · USGS',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 16,
      attribution: 'Tiles © <a href="https://www.usgs.gov/">USGS</a> The National Map'
    },
    'usgs-imagery': {
      label: '卫星 · USGS',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 16,
      attribution: 'Imagery © <a href="https://www.usgs.gov/">USGS</a> The National Map'
    }
  };
  const S = { id: 'offline', map: null, layer: null, fails: 0, onChange: null, lastError: '' };

  function tiles() {
    const st = H.state.settings = H.state.settings || {};
    const t = st.tiles = st.tiles || {};
    if (t.url == null) t.url = '';
    if (t.name == null) t.name = '';
    if (t.attribution == null) t.attribution = '';
    if (t.subdomains == null) t.subdomains = '';
    if (t.key == null) t.key = '';
    if (!t.maxZoom) t.maxZoom = 18;
    return t;
  }

  function expand(template) {
    const key = tiles().key || '';
    return String(template || '').replace(/\{key\}/g, encodeURIComponent(key));
  }

  function config(id) {
    if (!id || id === 'offline') return { id: 'offline', label: '离线', url: null };
    if (id === 'custom') {
      const t = tiles();
      if (!String(t.url).trim()) return null;
      return {
        id: 'custom',
        label: t.name || '自定义',
        url: expand(t.url),
        maxZoom: Number(t.maxZoom) || 18,
        subdomains: t.subdomains || '',
        attribution: t.attribution || '自定义瓦片源'
      };
    }
    const p = PRESETS[id];
    return p ? Object.assign({ id: id }, p) : null;
  }

  function label() {
    const c = config(S.id);
    return c ? c.label : '离线';
  }

  function available(id) {
    if (id === 'offline') return true;
    return !!config(id);
  }

  function emit() {
    const info = { id: S.id, label: label(), online: S.id !== 'offline', error: S.lastError };
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
    S.id = 'offline';
    S.lastError = reason || '底图瓦片连续失败';
    if (H.toast) H.toast('底图不可达，已切回离线州界；可在「图层」里改用自定义瓦片源。');
    emit();
  }

  /** Attach (or detach) the basemap. Returns the resulting info object. */
  function apply(map, id) {
    if (map) S.map = map;
    if (!S.map) return emit();
    const wanted = id == null ? S.id : id;
    const cfg = config(wanted);
    detach();
    S.lastError = '';
    if (!cfg || !cfg.url) {
      S.id = 'offline';
      return emit();
    }
    S.id = wanted;
    S.fails = 0;
    const layer = L.tileLayer(cfg.url, {
      maxZoom: cfg.maxZoom || 16,
      minZoom: 3,
      errorTileUrl: TRANSPARENT,
      attribution: cfg.attribution || '',
      subdomains: cfg.subdomains || 'abc',
      updateWhenIdle: true,
      keepBuffer: 3,
      crossOrigin: true,
      className: 'dx-tile-layer'
    });
    layer.on('tileerror', function () {
      S.fails += 1;
      if (S.fails >= 3) fail('瓦片请求失败 ' + S.fails + ' 次');
    });
    layer.on('load', function () { S.fails = 0; });
    layer.addTo(S.map);
    try { layer.bringToBack(); } catch (err) { /* older leaflet */ }
    S.layer = layer;
    return emit();
  }

  function set(id) {
    if (!available(id)) {
      if (H.toast) H.toast('该底图源还没配置地址，请到「接口与时区」页填写后重试。');
      return false;
    }
    apply(null, id);
    return true;
  }

  H.basemap = {
    presets: PRESETS,
    tiles: tiles,
    config: config,
    label: label,
    available: available,
    apply: apply,
    set: set,
    detach: detach,
    info: function () { return { id: S.id, label: label(), online: S.id !== 'offline', error: S.lastError }; },
    onChange: function (fn) { S.onChange = fn; }
  };
})(window.HH);
