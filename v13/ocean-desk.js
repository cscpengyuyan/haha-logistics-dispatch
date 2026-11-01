'use strict';
/* 海运计划看板 · OCEAN PLANNING BOARD (v13)
 * KPI strip + 甘特图（订舱节点 / 海上 / 内陆 / 到仓）+ 周负荷 + 改约待办。
 * Data contract unchanged: Supply.sea(host, ctx, onRecords) and Resources.mount.
 */
window.OceanDesk = {
  mount(host, ctx) {
    const e = ctx.escape;
    const DAY = 864e5;
    const ICON = {
      search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35',
      download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 21h16',
      ship: 'M3 16h18l-3 4H6zM6 14V7h12v7M12 3v4',
      alert: 'M12 3 2 20h20zM12 9v5m0 2v1',
    };
    const icon = (d, s = 15) => '<svg aria-hidden="true" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';

    host.innerHTML =
      '<section class="ob-shell" data-board></section>' +
      '<section class="supply-card" data-single></section>' +
      '<details class="ob-legacy" data-legacy-wrap><summary></summary><div data-legacy></div></details>';

    const board = host.querySelector('[data-board]');
    const legacy = host.querySelector('[data-legacy-wrap]');
    const legacyBody = host.querySelector('[data-legacy]');
    const legacyCount = (ctx.resources || []).filter(r => r.type === 'inbound').length;
    legacy.querySelector('summary').innerHTML =
      '<span>历史海运交接登记</span><span class="ob-legacy-count">' + legacyCount + ' 条</span>';
    window.Resources.mount(legacyBody, ctx, 'ocean');

    const state = { shipments: [], wh: '', q: '', filter: 'all', scale: 'week' };

    /* ---------- time helpers ---------- */
    const zoneOf = s => s.warehouse_zone || 'America/Chicago';
    const md = (t, z) => new Intl.DateTimeFormat('zh-CN', { timeZone: z, month: '2-digit', day: '2-digit' }).format(new Date(t));
    const ymd = (t, z) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
    const weekStart = (t, z) => {
      const d = new Date(ymd(t, z) + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.getTime();
    };
    const units = s => s.units || [];
    const pendingOf = s => units(s).filter(u => !u.receipt).length;
    const openRevs = s => (s.reviews || []).filter(r => !r.closed_at);
    const etaOf = s => Date.parse(s.warehouse_eta);
    const planOf = s => Date.parse(s.planned_warehouse);
    const isOverdue = (s, now = Date.now()) => pendingOf(s) > 0 && now > etaOf(s);
    const delayHours = s => Math.round((etaOf(s) - planOf(s)) / 36e5);
    const days = n => Math.max(1, Math.round(Math.abs(n) / DAY));
    const durDays = (a, b) => Math.max(1, Math.round((b - a) / DAY));

    /* ---------- filtering ---------- */
    function filtered() {
      const q = state.q.trim().toLowerCase();
      return state.shipments.filter(s => {
        if (state.wh && s.warehouse !== state.wh) return false;
        if (state.filter === 'pending' && pendingOf(s) === 0) return false;
        if (state.filter === 'overdue' && !isOverdue(s)) return false;
        if (state.filter === 'review' && openRevs(s).length === 0) return false;
        if (!q) return true;
        return [s.voyage, s.asn, s.container, s.batch, s.bill_of_lading, s.seal, s.port, s.warehouse, s.owner]
          .join(' ').toLowerCase().includes(q);
      });
    }

    /* ---------- header + KPI ---------- */
    function renderHead(rows, all) {
      const pending = rows.reduce((n, s) => n + pendingOf(s), 0);
      const total = rows.reduce((n, s) => n + units(s).length, 0);
      const overdue = rows.filter(s => isOverdue(s)).length;
      const revs = rows.reduce((n, s) => n + openRevs(s).length, 0);
      const thisWeek = rows.filter(s => weekStart(etaOf(s), zoneOf(s)) === weekStart(Date.now(), zoneOf(s))).length;
      const counts = {
        all: all.length,
        pending: all.filter(s => pendingOf(s) > 0).length,
        overdue: all.filter(s => isOverdue(s)).length,
        review: all.filter(s => openRevs(s).length).length,
      };
      const tile = (label, value, unit, sub, tone) =>
        '<div class="ob-kpi' + (tone ? ' ' + tone : '') + '">' +
          '<small>' + e(label) + '</small>' +
          '<b>' + value + '<em>' + e(unit) + '</em></b>' +
          '<span>' + e(sub) + '</span>' +
        '</div>';
      const places = [...new Set(all.map(s => s.warehouse))];
      const chips = [['all', '全部'], ['pending', '待收'], ['overdue', '超期'], ['review', '有改约']]
        .map(([k, label]) =>
          '<button type="button" data-filter="' + k + '" class="' + (state.filter === k ? 'on' : '') + '">' +
            e(label) + '<b>' + counts[k] + '</b></button>').join('');

      return '' +
        '<header class="ob-head">' +
          '<div class="ob-head-main">' +
            '<div class="kicker">OCEAN CAPACITY / 多航次到仓</div>' +
            '<h2>多航次到仓计划</h2>' +
            '<p>按航次展开订舱节点、海上与内陆段，对照冻结船期跟进逐柜收货与改约。</p>' +
          '</div>' +
          '<div class="ob-tools">' +
            '<div class="ob-seg" role="group" aria-label="按状态筛选">' + chips + '</div>' +
            '<label class="ob-field"><span>目的仓</span><select data-wh>' +
              '<option value="">全部仓库</option>' +
              places.map(p => '<option' + (state.wh === p ? ' selected' : '') + '>' + e(p) + '</option>').join('') +
            '</select></label>' +
            '<label class="ob-search">' + icon(ICON.search, 14) +
              '<input type="search" data-q value="' + e(state.q) + '" placeholder="航次 / ASN / 柜号 / 提单" aria-label="搜索航次">' +
            '</label>' +
            '<button type="button" class="primary" data-export>' + icon(ICON.download, 14) + '导出排期</button>' +
          '</div>' +
        '</header>' +
        '<div class="ob-kpis">' +
          tile('航次', rows.length, '柜', '共 ' + total + ' 台预报') +
          tile('待收台数', pending, '台', (total - pending) + ' / ' + total + ' 已实收') +
          (overdue
            ? tile('超期未收', overdue, '柜', '已过预测到仓日', 'warn')
            : tile('本周到仓', thisWeek, '柜', '按作业地周一至周日')) +
          tile('改约待办', revs, '项', revs ? '需仓库核对收货时段' : '暂无待办', revs ? 'warn' : 'calm') +
        '</div>';
    }

    /* ---------- gantt ---------- */
    function ticksFor(lo, hi, z0, scale) {
      const out = [];
      if (scale === 'day') {
        let t = Math.floor(lo / DAY) * DAY, i = 0;
        while (t <= hi && out.length < 130) {
          out.push({ t, left: 0, label: i % 4 === 0 ? md(t, z0) : '', major: i % 4 === 0 });
          t += DAY; i++;
        }
      } else {
        let t = weekStart(lo, z0);
        while (t <= hi && out.length < 40) {
          if (t >= lo) out.push({ t, left: 0, label: md(t, z0), major: true });
          t += 7 * DAY;
        }
      }
      return out;
    }

    function bar(l, w, cls, text, title) {
      const width = Math.max(w - l, 0.6);
      return '<span class="' + cls + '" style="left:' + l.toFixed(2) + '%;width:' + width.toFixed(2) + '%" title="' + e(title) + '">' +
        (width > 9 ? '<i>' + e(text) + '</i>' : '') + '</span>';
    }

    function renderBoard(rows) {
      if (!rows.length) {
        const empty = state.shipments.length
          ? '当前筛选没有匹配的航次，试试切换状态或清空搜索。'
          : '暂无海运航次。订舱并登记装箱清单后，这里会按到仓周展示航线与收货进度。';
        return '<section class="ob-board"><div class="ob-empty">' +
          '<div class="ob-empty-icon">' + icon(ICON.ship, 22) + '</div>' +
          '<b>没有可展示的航次</b><p>' + e(empty) + '</p>' +
          (state.shipments.length ? '<button type="button" data-reset>清空筛选</button>' : '') +
          '</div></section>';
      }
      const z0 = zoneOf(rows[0]);
      const marks = t => Date.parse(t) || 0;
      const edges = [];
      for (const s of rows) {
        const c = s.candidate || {};
        for (const t of [s.planned_etd, s.eta, s.planned_eta, s.warehouse_eta, s.planned_warehouse,
          c.doc_cutoff || s.doc_cutoff, c.gate_cutoff || s.gate_cutoff]) {
          const v = marks(t);
          if (v) edges.push(v);
        }
      }
      const lo = Math.min(...edges) - 2 * DAY;
      const latest = Math.max(...edges);
      const overdueAny = rows.some(s => isOverdue(s));
      const rawHi = Math.max(latest, overdueAny ? Date.now() : latest) + DAY;
      const hi = rawHi + 2 * DAY;
      const span = Math.max(hi - lo, DAY);
      const pct = t => ((t - lo) / span) * 100;

      const ticks = ticksFor(lo, hi, z0, state.scale).map(k => ({ ...k, left: pct(k.t) }));
      const today = Date.now() >= lo && Date.now() <= hi ? pct(Date.now()) : null;

      const laneRows = s => {
        const z = zoneOf(s);
        const cand = s.candidate || {};
        const start = Date.parse(s.planned_etd) || planOf(s);
        const arrive = Date.parse(s.eta) || Date.parse(s.planned_eta) || etaOf(s);
        const eta = etaOf(s), plan = planOf(s);
        const doc = cand.doc_cutoff || s.doc_cutoff;
        const gate = cand.gate_cutoff || s.gate_cutoff;
        const out = [];
        const rowHtml = (name, hint, inner) =>
          '<div class="og-row"><div class="og-task"><b>' + e(name) + '</b><small>' + e(hint) + '</small></div>' +
          '<div class="og-track">' + inner + '</div></div>';

        /* milestones */
        const ms = [];
        if (doc) ms.push({ t: Date.parse(doc), label: '截单', kind: 'doc' });
        if (gate) ms.push({ t: Date.parse(gate), label: '截关', kind: 'gate' });
        if (ms.length) {
          out.push(rowHtml('订舱与截关',
            ms.map(m => m.label + ' ' + md(m.t, z)).join(' · '),
            ms.map(m => '<span class="og-ms ' + m.kind + '" style="left:' + pct(m.t).toFixed(2) + '%" title="' + e(m.label + ' ' + md(m.t, z)) + '"></span>').join('')));
        }

        /* sea leg */
        out.push(rowHtml('海上运输',
          md(start, z) + ' → ' + md(arrive, z) + ' · ' + durDays(start, arrive) + ' 天',
          bar(pct(start), pct(arrive), 'og-bar sea', durDays(start, arrive) + ' 天',
            '装船 ' + md(start, z) + ' → 到港 ' + md(arrive, z))));

        /* drayage */
        if (eta - arrive > 6 * 36e5) {
          out.push(rowHtml('内陆派送',
            md(arrive, z) + ' → ' + md(eta, z) + ' · ' + durDays(arrive, eta) + ' 天',
            bar(pct(arrive), pct(eta), 'og-bar dray', durDays(arrive, eta) + ' 天',
              '到港 ' + md(arrive, z) + ' → 到仓 ' + md(eta, z))));
        }

        /* warehouse arrival: frozen vs forecast */
        const same = Math.abs(eta - plan) < 12 * 36e5;
        const late = delayHours(s);
        const pins =
          (same
            ? '<span class="og-pin both" style="left:' + pct(eta).toFixed(2) + '%" title="冻结 = 预测 · ' + e(md(eta, z)) + '"></span>'
            : '<span class="og-delta" style="left:' + pct(plan).toFixed(2) + '%;width:' + Math.max(pct(eta) - pct(plan), 0.2).toFixed(2) + '%"></span>' +
              '<span class="og-pin plan" style="left:' + pct(plan).toFixed(2) + '%" title="冻结到仓 ' + e(md(plan, z)) + '"></span>' +
              '<span class="og-pin eta" style="left:' + pct(eta).toFixed(2) + '%" title="预测到仓 ' + e(md(eta, z)) + '"></span>');
        out.push(rowHtml('到仓确认',
          '冻结 ' + md(plan, z) + ' · 预测 ' + md(eta, z) + (late ? ' · ' + (late > 0 ? '+' : '') + late + 'h' : ''),
          pins));

        return out.join('');
      };

      const groupBlock = s => {
        const z = zoneOf(s);
        const cand = s.candidate || {};
        const from = Math.min(Date.parse(s.planned_etd) || planOf(s), Date.parse(cand.doc_cutoff || s.doc_cutoff) || Infinity);
        const to = Math.max(etaOf(s), planOf(s));
        const pending = pendingOf(s), total = units(s).length;
        const flag = pending === 0
          ? { cls: 'ok', text: '已收清' }
          : isOverdue(s)
            ? { cls: 'bad', text: '超期 ' + days(Date.now() - etaOf(s)) + ' 天' }
            : { cls: 'calm', text: '距到仓 ' + days(etaOf(s) - Date.now()) + ' 天' };
        const revs = openRevs(s);
        return '<div class="og-voyage" data-open="' + e(s.id) + '" role="button" tabindex="0" aria-label="' + e(s.voyage + ' 到仓排期，查看详情') + '">' +
            '<div class="og-group">' +
            '<div class="og-gtask">' +
              '<div class="og-gtitle"><span class="og-gdot"></span><b>' + e(s.voyage) + '</b>' +
                (s.hold ? '<span class="pill bad">扣留</span>' : '') +
                (revs.length ? '<span class="pill warn">改约 ' + revs.length + '</span>' : '') +
              '</div>' +
              '<div class="og-gsub">' + e(s.batch) + ' · ' + e(s.container) + ' · ' + e(s.mode) +
                ' · ' + (total - pending) + '/' + total + ' 台已收</div>' +
            '</div>' +
            '<div class="og-track og-gtrack">' +
              '<span class="og-gbar" style="left:' + pct(from).toFixed(2) + '%;width:' + Math.max(pct(to) - pct(from), 1).toFixed(2) + '%"></span>' +
              '<span class="og-gflag ' + flag.cls + (pct(to) > 84 ? '' : ' left') + '"' +
                (pct(to) > 84 ? '' : ' style="left:calc(' + Math.max(pct(to), 0).toFixed(2) + '% + 10px)"') + '>' +
                e(flag.text) + '</span>' +
            '</div>' +
          '</div>' + laneRows(s) + '</div>';
      };

      const head =
        '<div class="og-head">' +
          '<div class="og-head-task">任务 / 航段</div>' +
          '<div class="og-head-axis">' +
            ticks.filter(k => k.label).map(k => '<span style="left:' + k.left.toFixed(2) + '%">' + e(k.label) + '</span>').join('') +
          '</div>' +
        '</div>';

      const plot =
        '<div class="og-plot" aria-hidden="true">' +
          ticks.map(k => '<span class="og-vl' + (k.major ? ' major' : '') + '" style="left:' + k.left.toFixed(2) + '%"></span>').join('') +
          (today !== null ? '<span class="og-today" style="left:' + today.toFixed(2) + '%"></span>' : '') +
        '</div>';

      return '<section class="ob-board">' +
        '<div class="ob-board-head">' +
          '<div><h3>到仓甘特</h3><p>按航段展开，灰色为冻结船期、绿色为最新预测；按作业地时区标注。</p></div>' +
          '<div class="ob-legend">' +
            '<span><i class="lg-sea"></i>海上</span>' +
            '<span><i class="lg-dray"></i>内陆</span>' +
            '<span><i class="lg-ms"></i>截关节点</span>' +
            '<span><i class="lg-plan"></i>冻结</span>' +
            '<span><i class="lg-eta"></i>预测</span>' +
            '<span class="og-scale" role="group" aria-label="时间刻度">' +
              '<button type="button" data-scale="week" class="' + (state.scale === 'week' ? 'on' : '') + '">周</button>' +
              '<button type="button" data-scale="day" class="' + (state.scale === 'day' ? 'on' : '') + '">日</button>' +
            '</span>' +
            '<span class="ob-asof">今日 ' + e(md(Date.now(), z0)) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="og">' + head + '<div class="og-body">' + plot + rows.map(groupBlock).join('') + '</div></div>' +
      '</section>';
    }

    /* ---------- side panels ---------- */
    function renderSide(rows) {
      const loads = new Map();
      for (const s of rows) {
        const z = zoneOf(s);
        const week = weekStart(etaOf(s), z);
        const key = s.warehouse + '|' + week;
        const cur = loads.get(key) || { wh: s.warehouse, week, units: 0, batches: 0 };
        cur.units += units(s).length;
        cur.batches += 1;
        loads.set(key, cur);
      }
      const list = [...loads.values()].sort((a, b) => a.week - b.week);
      const max = Math.max(...list.map(v => v.units), 1);
      const loadRows = list.map(v => {
        const label = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit' }).format(new Date(v.week));
        return '<div class="ob-load-row">' +
          '<div class="ob-load-lab"><b>' + e(label) + '</b><small>' + e(v.wh) + ' · 周一起</small></div>' +
          '<div class="ob-load-bar"><i style="width:' + Math.max(8, (v.units / max) * 100).toFixed(0) + '%"></i></div>' +
          '<div class="ob-load-val"><b>' + v.units + '</b><small>台 / ' + v.batches + ' 批</small></div>' +
        '</div>';
      }).join('');

      const revs = [];
      for (const s of rows) for (const r of openRevs(s)) revs.push({ s, r });
      const revList = revs.length
        ? revs.map(({ s, r }) => '<li data-open="' + e(s.id) + '">' +
            '<span class="ob-rev-icon">' + icon(ICON.alert, 13) + '</span>' +
            '<div><b>' + e(r.reason) + '</b><small>' + e(s.voyage) + ' · ' + e(s.asn) + '</small></div>' +
          '</li>').join('')
        : '<li class="ob-rev-empty">暂无改约待办，全部按冻结船期执行。</li>';

      const shifts = rows.map(delayHours);
      const lateN = shifts.filter(h => h > 0).length;
      const onTime = shifts.length - lateN;
      const avg = shifts.length ? Math.round(shifts.reduce((a, b) => a + b, 0) / shifts.length) : 0;
      const avgTxt = avg === 0 ? '0h' : (Math.abs(avg) >= 24 ? (avg > 0 ? '+' : '') + (avg / 24).toFixed(1) + 'd' : (avg > 0 ? '+' : '') + avg + 'h');

      return '<aside class="ob-side">' +
        '<section class="ob-panel">' +
          '<header><h3>到仓周负荷</h3><small>周一起算</small></header>' +
          (loadRows || '<p class="ob-note">暂无到仓计划。</p>') +
          (list.length === 1 && list[0].batches > 1
            ? '<p class="ob-note warn">同一周集中到仓 ' + list[0].batches + ' 批，请确认仓库收货与库位能力。</p>'
            : '') +
        '</section>' +
        '<section class="ob-panel">' +
          '<header><h3>排期健康度</h3><small>预测对冻结</small></header>' +
          '<div class="ob-health">' +
            '<div><b>' + onTime + '</b><small>准点航次</small></div>' +
            '<div' + (lateN ? ' class="warn"' : '') + '><b>' + lateN + '</b><small>延后航次</small></div>' +
            '<div><b>' + avgTxt + '</b><small>平均偏移</small></div>' +
          '</div>' +
        '</section>' +
        '<section class="ob-panel">' +
          '<header><h3>改约待办</h3><small class="' + (revs.length ? 'warn' : '') + '">' + revs.length + ' 项</small></header>' +
          '<ul class="ob-reviews">' + revList + '</ul>' +
        '</section>' +
        '<p class="ob-foot">时间取自签发版本；冻结与预测不一致时以最新回执为准，导出 CSV 可用于周会核对。</p>' +
      '</aside>';
    }

    /* ---------- main draw ---------- */
    function draw() {
      const all = state.shipments;
      const rows = filtered();
      if (state.wh && !all.some(s => s.warehouse === state.wh)) state.wh = '';
      board.innerHTML =
        renderHead(rows, all) +
        '<div class="ob-body">' + renderBoard(rows) + renderSide(rows) + '</div>';
    }

    function updateOverview(shipments) {
      state.shipments = shipments || [];
      draw();
    }

    /* ---------- events ---------- */
    board.addEventListener('click', ev => {
      const chip = ev.target.closest('[data-filter]');
      if (chip) { state.filter = chip.dataset.filter; draw(); return; }
      const sc = ev.target.closest('[data-scale]');
      if (sc) { state.scale = sc.dataset.scale; draw(); return; }
      if (ev.target.closest('[data-reset]')) { state.q = ''; state.filter = 'all'; state.wh = ''; draw(); return; }
      if (ev.target.closest('[data-export]')) { exportCsv(); return; }
      const open = ev.target.closest('[data-open]');
      if (open) openBatch(open.dataset.open);
    });
    board.addEventListener('input', ev => {
      if (ev.target.matches('[data-q]')) {
        state.q = ev.target.value;
        const pos = ev.target.selectionStart;
        draw();
        const next = board.querySelector('[data-q]');
        if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch (_) {} }
      }
    });
    board.addEventListener('change', ev => {
      if (ev.target.matches('[data-wh]')) { state.wh = ev.target.value; draw(); }
    });

    function openBatch(id) {
      location.hash = 'ocean?batch=' + encodeURIComponent(id);
      setTimeout(() => host.querySelector('[data-single]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 380);
    }

    function exportCsv() {
      const rows = filtered();
      const quote = x => '"' + String(x).replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
      const head = ['航次', 'ASN', '柜号', '仓库', '装船', '到港', '冻结到仓', '预测到仓', '延迟小时', '预报台数', '已收台数', '改约待办'];
      const body = rows.map(s => [
        s.voyage, s.asn, s.container, s.warehouse, s.planned_etd, s.eta, s.planned_warehouse, s.warehouse_eta,
        delayHours(s), units(s).length, units(s).length - pendingOf(s), openRevs(s).map(r => r.reason).join(' / '),
      ]);
      const csv = [head, ...body].map(r => r.map(quote).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'ocean-schedules.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      ctx.toast?.('已导出 ' + rows.length + ' 个航次的排期');
    }

    window.Supply.sea(host.querySelector('[data-single]'), ctx, updateOverview);
  },
};
