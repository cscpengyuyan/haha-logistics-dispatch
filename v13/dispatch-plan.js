'use strict';
/* 派单计划 · DISPATCH PLANNING (v13)
 * 交付日 → 车次（多站聚合）→ 站序与时窗核算 → 保存为地图排线草案。
 * 只读订单与运力，不改任何业务状态。
 */
window.DispatchPlan = {
  mount(host, ctx) {
    const e = ctx.escape;
    const AVG_MPH = 35;
    const DAY_START = 6 * 60, DAY_END = 20 * 60;
    const ICON = {
      calendar: 'M3 5h18v16H3zM3 10h18M8 3v4m8-4v4',
      truck: 'M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 7 19zm10 0a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 17 19z',
    };
    const icon = (d, s = 15) => '<svg aria-hidden="true" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';

    const orders = (ctx.orders || []).filter(o =>
      o.status === 'ready' && !o.pickup && o.window_start && o.window_end &&
      Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)));
    const warehouses = (ctx.resources || []).filter(r => r.type === 'warehouse');
    const vehicles = (ctx.resources || []).filter(r => r.type === 'vehicle');
    const crews = (ctx.resources || []).filter(r => r.type === 'crew');
    const canEdit = ['admin', 'dispatch'].includes(ctx.user?.role);
    const cap = Math.max(1, ...vehicles.map(v => Number(v.capacity_units) || 0), 6);

    const state = { horizon: 7, day: '', saved: new Map(), busy: false };

    /* ---------- helpers ---------- */
    const dayKeyOf = o => (o.window_start || '').slice(0, 10);
    const hm = s => (s || '').slice(11, 16);
    const zip3 = z => String(z || '').slice(0, 3);
    const qty = o => Number(o.quantity) || 1;
    const localToday = () => {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };
    const addDays = (key, n) => {
      const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n);
      const p = x => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };
    const weekday = key => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(key + 'T12:00:00').getDay()];
    const mmdd = key => key.slice(5).replace('-', '/');
    const clock = t => {
      if (!Number.isFinite(t)) return '—';
      const d = new Date(t);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    const miles = (a, b) => {
      if (!a || !b) return 0;
      const R = 3958.8, r = Math.PI / 180;
      const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    };
    const whOf = name => warehouses.find(w => w.name === name) || null;
    const pointOf = w => (w && Number.isFinite(Number(w.lat)) && Number.isFinite(Number(w.lng)))
      ? { lat: Number(w.lat), lng: Number(w.lng) } : null;
    const levelName = { L1: 'L1 卸货区', L2: 'L2 入口门厅', L3: 'L3 室内机位', L4: 'L4 特殊搬运', L5: 'L5 技术启用' };
    const cmpWindow = (a, b) => String(a.window_start).localeCompare(String(b.window_start)) || String(a.zip).localeCompare(String(b.zip));
    const midnight = key => Date.parse(key + 'T00:00:00');

    /* ---------- schedule ---------- */
    function simulate(block, dateKey, startMin) {
      const depot = whOf(block[0].warehouse);
      const dp = pointOf(depot);
      let cursor = midnight(dateKey) + startMin * 60000;
      let prev = dp, dist = 0, late = 0, waitMin = 0;
      const stops = [];
      for (const o of block) {
        const p = { lat: Number(o.lat), lng: Number(o.lng) };
        const leg = miles(prev, p);
        dist += leg;
        const arrive = cursor + (leg / AVG_MPH) * 60 * 60000;
        const ws = Date.parse(o.window_start + ':00');
        const we = Date.parse(o.window_end + ':00');
        const enter = Math.max(arrive, ws);
        const svc = Number(o.service_minutes) || 45;
        const exit = enter + svc * 60000;
        const isLate = Number.isFinite(we) && exit > we;
        const isWait = arrive < ws;
        if (isLate) late++;
        if (isWait) waitMin += Math.round((ws - arrive) / 60000);
        stops.push({ o, leg, arrive, enter, exit, isLate, isWait, ws, we, svc });
        cursor = exit; prev = p;
      }
      const back = miles(prev, dp);
      dist += back;
      const departure = midnight(dateKey) + startMin * 60000;
      return { stops, dist, late, waitMin, departure, finish: cursor + (back / AVG_MPH) * 60 * 60000 };
    }

    function routeDistance(seq, dp) {
      let cur = dp, d = 0;
      for (const o of seq) { const p = { lat: Number(o.lat), lng: Number(o.lng) }; d += miles(cur, p); cur = p; }
      return d + miles(cur, dp);
    }

    function twoOpt(seq, dp) {
      let best = seq.slice(), improved = true, guard = 0;
      while (improved && guard++ < 30) {
        improved = false;
        const base = routeDistance(best, dp);
        for (let i = 0; i < best.length - 1; i++) {
          for (let j = i + 1; j < best.length; j++) {
            const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
            if (routeDistance(cand, dp) + 0.05 < base) { best = cand; improved = true; }
          }
        }
      }
      return best;
    }

    function nearestOrder(block, dp) {
      const rest = block.slice(), out = [];
      let cur = dp;
      while (rest.length) {
        let bi = 0, bd = Infinity;
        rest.forEach((o, i) => {
          const d = miles(cur, { lat: Number(o.lat), lng: Number(o.lng) });
          if (d < bd) { bd = d; bi = i; }
        });
        const o = rest.splice(bi, 1)[0];
        out.push(o);
        cur = { lat: Number(o.lat), lng: Number(o.lng) };
      }
      return out;
    }

    /* 站序：时窗顺序 vs 最近邻+2-opt，按「超窗数 → 里程」择优 */
    function sequenceFor(block, dateKey) {
      const dp = pointOf(whOf(block[0].warehouse));
      const byWindow = block.slice().sort(cmpWindow);
      const byGeo = twoOpt(nearestOrder(block, dp), dp);
      let best = byWindow, bestScore = Infinity;
      for (const cand of [byWindow, byGeo]) {
        const sim = simulate(cand, dateKey, startFor(cand, dateKey));
        const score = sim.late * 1000 + sim.dist;
        if (score < bestScore) { bestScore = score; best = cand; }
      }
      return refine(best, dateKey);
    }

    /* 以「超窗数 → 里程」为目标做 2-opt 局部搜索（成车后只跑一次） */
    function refine(seq, dateKey) {
      const cost = list => {
        const sim = simulate(list, dateKey, startFor(list, dateKey));
        return sim.late * 1000 + sim.dist;
      };
      let best = seq.slice(), bestCost = cost(best), improved = true, guard = 0;
      while (improved && guard++ < 24) {
        improved = false;
        for (let i = 0; i < best.length - 1; i++) {
          for (let j = i + 1; j < best.length; j++) {
            const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
            const c = cost(cand);
            if (c < bestCost - 0.01) { best = cand; bestCost = c; improved = true; }
          }
        }
      }
      return best;
    }

    function startFor(block, dateKey) {
      const base = 8 * 60;
      const probe = simulate(block, dateKey, base);
      const first = probe.stops[0];
      if (!first) return base;
      const wait = Math.round((first.ws - first.arrive) / 60000);
      return base + Math.min(Math.max(0, wait), 300);
    }

    function buildWaves(list, dateKey) {
      const pool = list.slice().sort(cmpWindow);
      const waves = [];
      let guard = 0;
      while (pool.length && guard++ < 40) {
        const seed = pool.shift();
        const block = [seed];
        let units = qty(seed);
        let improved = true;
        while (improved && pool.length) {
          improved = false;
          let bestIdx = -1, bestScore = Infinity;
          for (let i = 0; i < pool.length; i++) {
            const o = pool[i];
            if (units + qty(o) > cap) continue;
            const trial = [...block, o].sort(cmpWindow);
            const sim = simulate(trial, dateKey, startFor(trial, dateKey));
            const dur = (sim.finish - sim.departure) / 60000;
            if (dur > 600) continue;
            const levels = new Set(trial.map(x => x.level || '--')).size - 1;
            const score = sim.late * 10000 + dur * 1.2 + sim.dist * 2.2 + levels * 26 + sim.waitMin * 0.35;
            if (score < bestScore) { bestScore = score; bestIdx = i; }
          }
          if (bestIdx >= 0) {
            const picked = pool.splice(bestIdx, 1)[0];
            block.push(picked); units += qty(picked); improved = true;
          }
        }
        const ordered = sequenceFor(block, dateKey);
        const sim = simulate(ordered, dateKey, startFor(ordered, dateKey));
        const zipCount = new Map();
        for (const o of ordered) zipCount.set(zip3(o.zip), (zipCount.get(zip3(o.zip)) || 0) + 1);
        const mainZip = [...zipCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
        const levels = [...new Set(ordered.map(o => o.level).filter(Boolean))];
        waves.push({ ...sim, block: ordered, units, mainZip, levels, warehouse: ordered[0].warehouse });
      }
      return waves;
    }

    function assignVehicles(waves) {
      const used = new Map();
      for (const w of waves) {
        const pool = vehicles.filter(v => Number(v.capacity_units) >= w.units);
        const pick = (pool.length ? pool : vehicles).slice().sort((a, b) =>
          (used.get(a.id) || 0) - (used.get(b.id) || 0) ||
          Number(b.capacity_units || 0) - Number(a.capacity_units || 0))[0] || null;
        w.vehicle = pick;
        if (pick) used.set(pick.id, (used.get(pick.id) || 0) + 1);
        const zips = [...new Set(w.block.map(o => String(o.zip || '')))].filter(Boolean);
        w.crew = crews.find(c => zips.every(z => String(c.coverage || '').split(',').map(s => s.trim()).includes(z))) || null;
        w.zips = zips;
      }
      return waves;
    }

    function planDay(dateKey) {
      const list = orders.filter(o => dayKeyOf(o) === dateKey);
      const waves = assignVehicles(buildWaves(list, dateKey));
      waves.forEach((w, i) => {
        w.index = i + 1;
        w.id = dateKey + '|' + w.warehouse + '|' + w.mainZip + '|' + i;
        w.name = w.warehouse + ' ' + mmdd(dateKey) + ' · ' + w.mainZip + ' 片区 · ' + w.stops.length + ' 站 · 第 ' + (i + 1) + ' 车';
      });
      return { dateKey, orders: list, waves };
    }

    /* ---------- render ---------- */
    function days() {
      const today = localToday(), out = [];
      for (let i = 0; i < state.horizon; i++) out.push(addDays(today, i));
      return out;
    }

    function render() {
      const today = localToday();
      const list = days();
      const all = new Map(list.map(d => [d, planDay(d)]));
      if (!state.day || !list.includes(state.day)) {
        state.day = list.find(d => all.get(d).orders.length) || today;
      }
      const rows = list.map(d => all.get(d));
      const sel = all.get(state.day) || planDay(state.day);
      const totalOrders = rows.reduce((n, r) => n + r.orders.length, 0);
      const totalUnits = rows.reduce((n, r) => n + r.orders.reduce((m, o) => m + qty(o), 0), 0);
      const totalWaves = rows.reduce((n, r) => n + r.waves.length, 0);
      const totalLate = rows.reduce((n, r) => n + r.waves.reduce((m, w) => m + w.late, 0), 0);
      const overload = rows.filter(r => r.waves.length > Math.max(1, vehicles.length)).length;
      const maxUnits = Math.max(1, ...rows.map(r => r.orders.reduce((n, o) => n + qty(o), 0)));

      const kpi = (label, value, unit, sub, tone) =>
        '<div class="dp-kpi' + (tone ? ' ' + tone : '') + '"><small>' + e(label) + '</small><b>' + value +
        '<em>' + e(unit) + '</em></b><span>' + e(sub) + '</span></div>';

      const dayRow = r => {
        const units = r.orders.reduce((n, o) => n + qty(o), 0);
        const late = r.waves.reduce((n, w) => n + w.late, 0);
        const on = r.dateKey === state.day;
        return '<button type="button" class="dp-day' + (on ? ' on' : '') + '" data-day="' + r.dateKey + '">' +
          '<span class="dp-day-top"><b>' + e(mmdd(r.dateKey)) + '</b><i>' + e(weekday(r.dateKey)) + '</i>' +
            (r.dateKey === today ? '<em>今天</em>' : '') + '</span>' +
          '<span class="dp-day-bar"><i style="width:' + Math.max(2, (units / maxUnits) * 100).toFixed(0) + '%"></i></span>' +
          '<span class="dp-day-meta">' + r.orders.length + ' 票 · ' + units + ' 台 · ' + r.waves.length + ' 车次' +
            (late ? ' · <b class="late">' + late + ' 超窗</b>' : '') + '</span>' +
        '</button>';
      };

      const band = w => {
        const base = midnight(state.day);
        const span = (DAY_END - DAY_START) * 60000;
        const pct = t => Math.max(0, Math.min(100, ((t - base - DAY_START * 60000) / span) * 100));
        const ticks = [8, 10, 12, 14, 16, 18].map(h =>
          '<span class="dp-band-tick" style="left:' + pct(base + h * 3600000).toFixed(2) + '%"><i>' + h + ':00</i></span>').join('');
        const wins = w.stops.map(s =>
          '<span class="dp-band-win" style="left:' + pct(s.ws).toFixed(2) + '%;width:' +
            Math.max(0.8, pct(s.we) - pct(s.ws)).toFixed(2) + '%" title="' +
            e(s.o.city + ' 收货窗 ' + hm(s.o.window_start) + '–' + hm(s.o.window_end)) + '"></span>').join('');
        const dots = w.stops.map((s, i) =>
          '<span class="dp-band-dot' + (s.isLate ? ' bad' : '') + '" style="left:' + pct(s.enter).toFixed(2) + '%" title="' +
            e('第 ' + (i + 1) + ' 站 ' + s.o.city + ' ' + clock(s.enter)) + '">' + (i + 1) + '</span>').join('');
        return '<div class="dp-band">' + ticks +
          '<span class="dp-band-route" style="left:' + pct(w.departure).toFixed(2) + '%;width:' +
            Math.max(1, pct(w.finish) - pct(w.departure)).toFixed(2) + '%"></span>' + wins + dots + '</div>';
      };

      const stopRow = (st, i) => {
        const o = st.o;
        const late = Math.round((st.exit - st.we) / 60000);
        const wait = Math.round((st.ws - st.arrive) / 60000);
        const flag = st.isLate
          ? '<span class="dp-flag bad">超窗 ' + late + ' 分</span>'
          : st.isWait && wait >= 5 ? '<span class="dp-flag warn">候场 ' + wait + ' 分</span>'
          : '<span class="dp-flag ok">窗内</span>';
        return '<li class="dp-stop' + (st.isLate ? ' bad' : '') + '">' +
          '<span class="dp-stop-no">' + (i + 1) + '</span>' +
          '<span class="dp-stop-main"><b>' + e(o.city || '—') + ' ' + e(o.zip || '') + ' · ' +
            e(levelName[o.level] || o.level || '—') + ' · ' + qty(o) + ' 台</b>' +
            '<small>' + e(o.id) + ' · ' + e(o.model || '—') + ' · 收货窗 ' + e(hm(o.window_start)) + '–' + e(hm(o.window_end)) +
            ' · 车程 ' + Math.round(st.leg) + ' mi</small></span>' +
          '<span class="dp-stop-time">' + e(clock(st.enter)) + '<i>开</i><small>' + e(clock(st.exit)) + ' 离</small></span>' +
          flag +
        '</li>';
      };

      const waveCard = (w, i) => {
        const saved = state.saved.get(w.id);
        const depot = whOf(w.warehouse);
        return '<article class="dp-wave">' +
          '<header class="dp-wave-head">' +
            '<div class="dp-wave-title"><span class="dp-wave-no">车次 ' + (i + 1) + '</span>' +
              '<b>' + e(w.warehouse) + ' ' + e(w.mainZip) + ' 片区 · ' + w.stops.length + ' 站 · ' +
                w.levels.map(l => e(l)).join(' / ') + '</b>' +
              '<small>' + e([...new Set(w.block.map(o => o.city))].slice(0, 3).join(' · ')) + '</small></div>' +
            '<div class="dp-wave-stats">' +
              '<span><b>' + w.units + '</b> 台</span>' +
              '<span><b>' + Math.round(w.dist) + '</b> mi</span>' +
              '<span><b>' + e(clock(w.departure)) + '–' + e(clock(w.finish)) + '</b> 出发—回仓</span>' +
            '</div>' +
          '</header>' +
          band(w) +
          '<div class="dp-wave-meta">' +
            '<span class="dp-chip">' + icon(ICON.truck, 13) + e(w.vehicle?.name || '待指派车辆') +
              (w.vehicle ? ' · ' + (w.vehicle.capacity_units || '—') + ' 台' : '') + '</span>' +
            '<span class="dp-chip' + (w.crew ? '' : ' warn') + '">班组 ' + (w.crew ? e(w.crew.name) : '待指派 / 覆盖待核') + '</span>' +
            '<span class="dp-chip">出车 ' + e(depot?.name || w.warehouse) + ' ' + e(clock(w.departure)) + '</span>' +
            (w.late ? '<span class="dp-chip bad">' + w.late + ' 站超窗</span>' : '<span class="dp-chip ok">时间窗可行</span>') +
            (w.waitMin ? '<span class="dp-chip warn">候场合计 ' + w.waitMin + ' 分</span>' : '') +
          '</div>' +
          '<ol class="dp-stops">' + w.stops.map(stopRow).join('') + '</ol>' +
          '<footer class="dp-wave-foot">' +
            '<span class="dp-save-note">' + (saved
              ? '已保存草案 · ' + e(saved) + ' · 到「地图调度」调出即可排线'
              : '草案只记录站序与时间，签发仍走原单 F04') + '</span>' +
            '<span class="dp-wave-actions">' +
              (canEdit ? '<button type="button" data-save="' + e(w.id) + '">' + e(saved ? '重新保存' : '保存为草案') + '</button>' : '') +
              '<button type="button" data-map="' + e(w.id) + '">去地图排线</button>' +
            '</span>' +
          '</footer>' +
        '</article>';
      };

      const main = sel.orders.length
        ? sel.waves.map(waveCard).join('')
        : '<div class="dp-empty">' + icon(ICON.calendar, 22) + '<b>这一天没有待排订单</b>' +
          '<p>待备货、客户自提或缺少坐标的订单不进入排车队列。</p></div>';

      host.innerHTML =
        '<section class="dp-shell">' +
          '<header class="dp-head">' +
            '<div class="dp-head-main">' +
              '<div class="kicker">DISPATCH PLANNING / 时间 · 片区 · 车次</div>' +
              '<h2>派单计划</h2>' +
              '<p>先按<b>交付日</b>取待排票，再按<b>同片区相邻</b>装车、按<b>收货窗</b>排序，最后交给地图排线与签发。</p>' +
            '</div>' +
            '<div class="dp-tools">' +
              '<div class="dp-seg" role="group" aria-label="计划视野">' +
                [[1, '今天'], [2, '明天'], [7, '未来 7 天'], [14, '未来 14 天']].map(([n, t]) =>
                  '<button type="button" data-h="' + n + '" class="' + (state.horizon === n ? 'on' : '') + '">' + t + '</button>').join('') +
              '</div>' +
              '<button type="button" data-refresh>刷新</button>' +
            '</div>' +
          '</header>' +
          '<div class="dp-kpis">' +
            kpi('待排票数', totalOrders, '票', '未来 ' + state.horizon + ' 天 · ' + rows.filter(r => r.orders.length).length + ' 天有单') +
            kpi('待收台数', totalUnits, '台', '按订单台数累计') +
            kpi('建议车次', totalWaves, '车次', overload ? overload + ' 天车次超过现有车辆' : '现有 ' + vehicles.length + ' 台车可覆盖', overload ? 'warn' : '') +
            kpi('超窗风险', totalLate, '站', totalLate ? '需调整出车时间或拆车' : '按当前窗全部可行', totalLate ? 'warn' : 'calm') +
          '</div>' +
          '<div class="dp-body">' +
            '<section class="dp-rail">' +
              '<header><h3>交付日</h3><small>按收货窗日期</small></header>' +
              '<div class="dp-days">' + rows.map(dayRow).join('') + '</div>' +
              '<p class="dp-rail-foot">条形＝当日待收台数；红字＝超窗站数。</p>' +
            '</section>' +
            '<section class="dp-main">' +
              '<header class="dp-main-head">' +
                '<div><h3>' + e(state.day) + ' ' + e(weekday(state.day)) + '</h3>' +
                  '<p>' + sel.orders.length + ' 票 · ' + sel.orders.reduce((n, o) => n + qty(o), 0) + ' 台 · ' +
                    sel.waves.length + ' 车次 · ' + sel.waves.reduce((n, w) => n + w.stops.length, 0) + ' 站</p></div>' +
                '<span class="dp-main-note">车辆 ' + vehicles.length + ' 台（' + cap + ' 台/车）· 班组 ' + crews.length + ' 条</span>' +
              '</header>' + main +
            '</section>' +
          '</div>' +
        '</section>';

      bind();
    }

    /* ---------- actions ---------- */
    function waveById(id) {
      return planDay(state.day).waves.find(w => w.id === id);
    }

    async function saveWave(w) {
      const depot = whOf(w.warehouse);
      const payload = {
        name: w.name,
        warehouse: w.warehouse,
        date: state.day,
        resource_id: w.vehicle?.id || '',
        crew_id: w.crew?.id || '',
        executor_id: '',
        order_ids: w.block.map(o => o.id),
        order_versions: Object.fromEntries(w.block.map(o => [o.id, o.version])),
        notes: '派单计划：' + w.mainZip + ' 片区 · ' + w.stops.length + ' 站 · ' + w.units + ' 台（' + state.day + '）',
        cost_scenario: {},
        checks: {},
        stops: {},
        start_time: clock(w.departure),
        timezone: depot?.timezone || 'America/Chicago',
        service_minutes: 45,
        road_basis: 'estimate',
      };
      const res = await ctx.saveRoute(payload);
      const route = res?.route || res;
      return route?.id ? String(route.id) : 'saved';
    }

    function bind() {
      host.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { state.horizon = Number(b.dataset.h); render(); });
      host.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { state.day = b.dataset.day; render(); });
      const rf = host.querySelector('[data-refresh]');
      if (rf) rf.onclick = () => ctx.refresh?.();
      host.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
        if (state.busy) return;
        state.busy = true; b.disabled = true; b.textContent = '保存中…';
        try {
          const w = waveById(b.dataset.save);
          const id = await saveWave(w);
          state.saved.set(w.id, id.slice(-6));
          ctx.toast?.('已保存草案，可到「地图调度 → 调出已存草案」继续排线');
          render();
        } catch (err) {
          ctx.toast?.(err.message || '保存失败');
          b.disabled = false; b.textContent = '保存为草案';
        } finally { state.busy = false; }
      });
      host.querySelectorAll('[data-map]').forEach(b => b.onclick = () => {
        const w = waveById(b.dataset.map);
        if (w?.block?.length) ctx.navigate('map?focus=' + encodeURIComponent(w.block[0].id));
      });
    }

    render();
  },
};
