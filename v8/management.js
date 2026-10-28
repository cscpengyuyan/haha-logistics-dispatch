/* HAHA V7 management modules. All records, rates and approvals in this build are synthetic demo data. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error('日期须为 YYYY-MM-DD');
    const [y, m, d] = value.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d, 12);
    if (new Date(t).toISOString().slice(0, 10) !== value) throw new Error('日期不存在');
    return t;
  }
  function plusDay(value, count) { return new Date(validDate(value) + count * DAY).toISOString().slice(0, 10); }
  function difference(a, b) { return Math.round((validDate(b) - validDate(a)) / DAY); }
  function localDate(instant, zone) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(String(instant))) throw new Error('瞬间必须包含 UTC 或时区偏移');
    const date = new Date(instant);
    if (!Number.isFinite(date.getTime())) throw new Error('时间无效');
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = k => p.find(x => x.type === k).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function isWorkDay(date, contract) {
    const weekday = new Date(validDate(date)).getUTCDay();
    return (contract.workDays || [1, 2, 3, 4, 5]).includes(weekday) && !(contract.holidays || []).includes(date);
  }
  function freeDeadline(received, contract) {
    validDate(received);
    const days = Number(contract.freeDays);
    if (!Number.isInteger(days) || days < 0 || days > 366) throw new Error('免费天数须为 0–366 的整数');
    if (days === 0) return plusDay(received, -1);
    let d = contract.includeFirst !== false ? received : plusDay(received, 1), counted = 0;
    for (let i = 0; i < 2000; i++, d = plusDay(d, 1)) {
      if (contract.calendar !== 'business' || isWorkDay(d, contract)) counted++;
      if (counted === days) return d;
    }
    throw new Error('合同营业日历无法计算截止日');
  }
  function storageSnapshot(unit, contract, asOf) {
    validDate(asOf);
    const deadline = freeDeadline(unit.received, contract);
    const end = contract.endEvent === 'delivery' ? unit.deliveredDate : unit.outboundDate;
    const stopped = !!end && end <= asOf;
    const effectiveEnd = stopped ? end : asOf;
    validDate(effectiveEnd);
    let chargeDays = Math.max(0, difference(deadline, effectiveEnd));
    if (stopped && contract.includeEndDay === false) chargeDays = Math.max(0, chargeDays - 1);
    if (effectiveEnd < unit.received) chargeDays = 0;
    const fee = chargeDays ? Math.max(chargeDays * Number(contract.rate || 0), Number(contract.minimumCharge || 0)) : 0;
    return { deadline, remaining: difference(asOf, deadline), age: Math.max(0, difference(unit.received, effectiveEnd) + 1), chargeDays, fee, stopped, missingEnd: unit.status === '已出库' && !end };
  }
  function replenishment({ eligible, inbound, confirmedDemand, forecast, safety }) {
    const values = [eligible, inbound, confirmedDemand, forecast, safety].map(Number);
    if (values.some(x => !Number.isFinite(x) || x < 0)) throw new Error('补货参数必须为非负数');
    const [stock, coming, demand, future, buffer] = values;
    const S = future + buffer, P = stock + coming - demand;
    return { S, P, Q: Math.max(0, Math.ceil(S - P)) };
  }
  function costScenario(c) {
    const keys = ['baseline', 'proposed', 'saas', 'labor', 'bonus', 'unsettled'];
    if (keys.some(k => !Number.isFinite(Number(c[k])) || Number(c[k]) < 0)) throw new Error('金额须为非负有效数值');
    if (Number(c.unsettled) > Number(c.proposed)) throw new Error('已包含的未结预留不能高于候选总成本');
    const savings = Number(c.baseline) - Number(c.proposed);
    const incentive = Number(c.saas) + Number(c.labor) + Number(c.bonus);
    const cap = Math.max(0, savings * .2);
    const completed = Number(c.completed == null ? 10 : c.completed);
    if (!Number.isInteger(completed) || completed < 0) throw new Error('完成订单数须为非负整数');
    return { savings, incentive, cap, retained: savings - incentive, withinCap: incentive <= cap + 1e-8, actualKnown: Number(c.proposed) - Number(c.unsettled), completed, unitCost: completed ? (Number(c.proposed) + incentive) / completed : null };
  }
  function reserveValue(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('费用预留须为非负金额，未知请留空');
    return n;
  }
  function reserveSummary(rows) {
    return rows.reduce((sum, r) => { const n = reserveValue(r.reserve); if (n == null) sum.unknown++; else sum.knownTotal += n; return sum; }, { knownTotal: 0, unknown: 0 });
  }
  function neededTypes(order, scope = 'delivery') {
    if (scope === 'technical') return [...new Set((order.serviceLines || []).filter(x => x.mode === 'separate').map(x => x.capability).concat(order.L5 ? ['T5'] : []))].length ? [...new Set((order.serviceLines || []).filter(x => x.mode === 'separate').map(x => x.capability).concat(order.L5 ? ['T5'] : []))] : ['T5'];
    if (root?.HH?.services) return root.HH.services.requiredTypes(order);
    const t = [order.path === 'A' ? 'T1' : 'T2'];
    if (order.L4) t.push('T4');
    return t;
  }
  function supplierEligibility(s, o, model, scope = 'delivery', onDate) {
    if (!s || !o || !model) return { eligible: false, reasons: ['缺少供应商、订单或型号资料'] };
    const reasons = [], types = neededTypes(o, scope), at = onDate || o.date;
    if (!s.status.includes('已核验') && s.status !== '部分能力暂停') reasons.push('主体尚未完成核验');
    if (!s.expiry || s.expiry < at) reasons.push('核验凭证在执行日已过期');
    for (const type of types) {
      if (!(s.types || []).includes(type)) reasons.push(`缺少 ${type} 能力`);
      if ((s.pausedTypes || []).includes(type)) reasons.push(`${type} 能力已暂停`);
    }
    if (!(s.models || []).includes(o.model)) reasons.push(`${o.model} 不在已验证型号范围`);
    if (!(s.zips || []).includes(o.zip)) reasons.push(`ZIP ${o.zip} 未书面验证`);
    if (scope === 'delivery') {
      if (!(s.endpoints || []).includes(o.endpoint)) reasons.push(`${o.endpoint} 终点不在承接范围`);
      if (!(Number(s.door) >= Number(model.h))) reasons.push(`车门净高不足或未知（需 ≥ ${model.h} cm）`);
      if (!(Number(s.liftKg) >= Number(model.kg) + 100)) reasons.push('尾板载荷不足（演示计入 100 kg 工具/人员余量）');
      const fits = s.liftW >= model.l && s.liftD >= model.w;
      if (!fits) reasons.push('尾板有效面积与包装底座不匹配');
      if (Number(s.capacity) < Number(o.qty)) reasons.push('本日剩余承接台数不足');
    }
    return { eligible: !reasons.length, reasons, types };
  }
  function canReserve(units, orders, unit, order) {
    if (!unit || !order) return '请选择有效设备和订单';
    if (unit.status !== '可用') return '只有可用库存可被锁定，隔离货必须单独质检释放';
    if (unit.model !== order.model) return '设备型号与订单不一致';
    if (unit.warehouse !== order.warehouse) return '设备不在订单当前出货仓；先变更路径与核验';
    if (Number(order.qty) !== 1) return '当前示例锁定按单台执行；多台需逐台关联';
    if (['物理交付完成', '已派车', '执行中', '已放行（演示）'].includes(order.status)) return '已完成或执行中的订单不能更换库存';
    if (units.some(x => x !== unit && x.serial === unit.serial && x.status === '锁定')) return '序列号重复锁定';
    if (units.some(x => x !== unit && x.orderId === order.id && x.status === '锁定')) return '此订单已锁定其他设备，须先解除原关系';
    if (orders.some(x => x.id !== order.id && x.serial === unit.serial && x.status !== '物理交付完成')) return '其他有效订单已引用此序列号';
    return '';
  }
  const pure = { validDate, plusDay, difference, localDate, isWorkDay, freeDeadline, storageSnapshot, replenishment, costScenario, reserveValue, reserveSummary, neededTypes, supplierEligibility, canReserve };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.HH) return;
  const H = root.HH;
  H.management = pure;
  const e = H.e, money = H.money, pill = H.pill;
  const view = { supplierOrder: 'H26001', supplierScope: 'delivery', eligibleOnly: false, warehouse: '', model: '', inventoryQuery: '', riskStatus: '', riskSeverity: '', riskQuery: '' };
  const typeNames = { T1: '基础货运', T2: '专业末端', T3: '区域仓点', T4: '特殊搬运', T5: '授权技术' };
  const card = (title, body, extra = '') => `<section class="card"><div class="card-head"><h2>${title}</h2>${extra}</div><div class="card-body">${body}</div></section>`;
  const select = (label, name, values, value, attrs = '') => `<label class="field">${label}<select name="${name}" ${attrs}>${values.map(x => { const k = typeof x === 'object' ? x.value : x, label = typeof x === 'object' ? x.label : x; return `<option value="${e(k)}" ${String(k) === String(value) ? 'selected' : ''}>${e(label)}</option>`; }).join('')}</select></label>`;
  const check = (name, value, label, checked) => `<label class="mg-check"><input type="checkbox" name="${name}" value="${e(value)}" ${checked ? 'checked' : ''}>${label}</label>`;
  const number = (fd, name, min = 0, integer = false) => { const raw = fd.get(name); const v = Number(raw); if (raw == null || String(raw).trim() === '' || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) throw new Error(`${name} 数值无效`); return v; };
  const required = (fd, name, label) => { const s = String(fd.get(name) || '').trim(); if (!s) throw new Error(`请填写${label || name}`); return s; };
  function ensure() {
    H.state.warehouseContracts ||= {};
    H.state.supplierReviews ||= [];
    H.state.replenishments ||= [];
    H.state.benefits ||= [];
    for (const w of H.state.warehouses) if (!H.state.warehouseContracts[w.id]) H.state.warehouseContracts[w.id] = {
      id: `DEMO-${w.id}-V1`, freeDays: w.freeDays, calendar: 'calendar', includeFirst: true,
      startEvent: '实际入仓点检完成', endEvent: 'outbound', includeEndDay: true,
      workDays: [1, 2, 3, 4, 5], holidays: [], rate: w.rate, minimumCharge: 0,
      timezone: w.timezone, note: '演示条款；首次接收免费期，不因锁单或返站重置', version: 1
    };
    for (const u of H.state.inventory) if (!u.storageContract) u.storageContract = H.clone(H.state.warehouseContracts[u.warehouse]);
  }
  function contractFor(u) { ensure(); return u.storageContract || H.state.warehouseContracts[u.warehouse]; }
  function supplierCost(s, o, scope) {
    const lines=(o.serviceLines||[]).filter(x=>scope==='technical'?x.mode==='separate':x.mode==='withDelivery');
    const items=scope==='technical'?[]:[['本地提货与约定终点',Number(s.rate)],['等待及异常预留（演示）',20]];
    lines.forEach(x=>items.push([x.name+' ×'+x.quantity,x.price==null?null:x.price*x.quantity]));
    if(scope==='technical'&&!lines.length)items.push(['独立工单（范围尚未指定）',null]);
    const unknown=items.filter(x=>x[1]==null).length,known=items.reduce((n,x)=>n+(x[1]||0),0);
    return {items,total:unknown?null:known,known,unknown};
  }
  function fmtPercent(a, b) { return b ? `${(a / b * 100).toFixed(1)}%` : '无样本'; }
  function supplierOrder() { return H.order(view.supplierOrder) || H.state.orders[0]; }
  H.pages.suppliers = function () {
    ensure();
    const order = supplierOrder(), model = H.model(order.model);
    const results = H.state.suppliers.map(s => ({ s, check: supplierEligibility(s, order, model, view.supplierScope), price: supplierCost(s, order, view.supplierScope) }));
    const shown = results.filter(x => !view.eligibleOnly || x.check.eligible), ready = results.filter(x => x.check.eligible);
    const soon = H.state.suppliers.filter(s => s.expiry && difference(H.state.demoDate, s.expiry) <= 30).length;
    return H.heading('供应商能力与采购', '先核可执行范围，再比较同服务价格。企业名称、报价和核验记录全部为虚构示例。', '<button class="btn" id="mg-supplier-export">导出能力表</button><button class="btn primary" id="mg-supplier-add">＋ 添加候选供应商</button>') +
      `<div class="metrics">${H.metric('供应商主体', H.state.suppliers.length, '签约方、实际团队分别记录')}${H.metric('本单可询价', ready.length, `${order.id} · ${order.model} · ZIP ${order.zip}`, ready.length ? '' : 'warn')}${H.metric('30 天内需复核', soon, '含已到期凭证；按执行日复核', 'warn')}${H.metric('能力类型', 'T1–T5', '能力匹配，不是等级越高越好')}</div>` +
      `<div class="mg-toolbar">${select('用于准入核验的订单', 'supplierOrder', H.state.orders.map(o => ({ value: o.id, label: `${o.id} · ${o.city} · ${o.model} · ${o.endpoint}${o.L4 ? '+L4' : ''}${o.L5 ? '+L5' : ''}` })), order.id, 'id="mg-supplier-order"')}${select('采购范围', 'supplierScope', [{ value: 'delivery', label: '本次末端运输 / 搬运' }, { value: 'technical', label: '独立 L5 技术工单' }], view.supplierScope, 'id="mg-supplier-scope"')}<label class="mg-check"><input id="mg-eligible-only" type="checkbox" ${view.eligibleOnly ? 'checked' : ''}>仅看准入匹配</label></div>` +
      `<div class="notice">${pill(order.path)} ${pill(order.endpoint)} ${order.L4 ? pill('L4 特殊通道') : ''} ${order.L5 ? pill('L5 独立技术') : ''}　执行日期 ${e(order.date)} · ${e(order.timeZone)}。${view.supplierScope === 'technical' && !order.L5 ? '本单未采购 L5，技术筛选仅用于候选规划，不产生新增承诺。' : '设备、ZIP、终点、工具与执行日均须匹配。'} 本表是演示筛查，仍需实际团队接受本票包装与现场版本。</div>` +
      `<div class="mg-supplier-grid">${shown.map(({ s, check: c, price }) => `<article class="card mg-supplier"><div class="card-body"><div class="mg-between"><span class="mg-id">${e(s.id)} / ${e(s.region)}</span>${pill(c.eligible ? '准入匹配 · 演示' : '有阻断项', c.eligible ? 'green' : 'red')}</div><h2>${e(s.name)}</h2><p class="mg-muted">${e(s.role)} · 实际执行主体 ${e(s.actualEntity || s.name + ' 示例团队')}</p><div class="mg-tags">${s.types.map(t => pill(`${t} ${typeNames[t]}`, (s.pausedTypes || []).includes(t) ? 'red' : 'blue')).join('')}</div><div class="mg-capacity"><div><small>已验证 ZIP</small><b>${s.zips.length} 个</b></div><div><small>车门净高</small><b>${s.door ? s.door + ' cm' : '不适用 / 未核'}</b></div><div><small>尾板额定</small><b>${s.liftKg ? s.liftKg + ' kg' : '不适用 / 未核'}</b></div></div><div class="mg-match ${c.eligible ? 'ok' : ''}">${c.eligible ? '匹配本次采购范围；书面承接和报价仍需逐票确认。' : c.reasons.map(r => `<div>• ${e(r)}</div>`).join('')}</div><div class="mg-between mg-price"><span><small>${view.supplierScope === 'technical' ? '同技术范围估价' : '同末端范围估价'} · USD</small><strong>${c.eligible ? money(price.total) : '暂不比价'}</strong></span><span class="mg-muted">核验至<br>${e(s.expiry || '未提交')}</span></div><div class="mg-performance"><span>准时 ${fmtPercent(s.ontime, s.total)}<small>${s.ontime}/${s.total} 次</small></span><span>POD ${fmtPercent(s.pod, s.total)}<small>${s.pod}/${s.total} 次</small></span><span>损伤观察<small>${s.damage}/${s.total} 台次示例</small></span></div><div class="actions"><button class="btn" data-supplier-detail="${e(s.id)}">能力档案</button><button class="btn" data-supplier-edit="${e(s.id)}">编辑范围</button><button class="btn" data-supplier-review="${e(s.id)}">核验</button><button class="btn" data-supplier-pause="${e(s.id)}">暂停范围</button></div></div></article>`).join('') || H.empty('没有匹配供应商。取消筛选查看具体阻断项，或新增候选后完成核验。')}</div>` +
      `<div class="grid cols-2 mg-section">${card('同服务比价口径', `<p>统一对象：${e(order.model)} × ${order.qty}，${e(order.city)} ${e(order.zip)}，${view.supplierScope === 'technical' ? '已列明的技术工单' : `${e(order.endpoint)} 终点${order.L4 ? '＋L4' : ''}`}。</p><div class="mg-comparison">${ready.map(({ s, price }) => `<div><span>${e(s.name)}</span><b>${money(price.total)}</b><small>${price.items.map(x => `${e(x[0])} ${money(x[1])}`).join(' ＋ ')}</small></div>`).join('') || '<p class="mg-muted">暂无同范围可比报价。</p>'}</div><div class="mg-footnote">金额为演示估价，未连供应商实时报价。C 路径干线、站点接收、存储及退出费用另列；本表不把末端小计当全程总价。L5 独立采购，不因运输商缺 T5 而否定其运输能力。</div>`)}${card('采购与风险控制', `<ol class="mg-list"><li>先核实际主体、设备和服务范围，再核保险对应责任段。</li><li>保险、许可与合同不只检查一张到期日；复核货值、除外责任、仓储及技术风险。</li><li>分包事前披露团队；重大安全问题暂停相应能力范围。</li><li>同型号 × ZIP × 服务跟踪样本，保留一家有效备选；不给未承诺的最低单量。</li></ol><div class="mg-footnote">方案依据：V5 p12–14、36。样本均为演示，不代表真实公司履约表现。</div>`)}</div>`;
  };
  function supplierDetail(id) {
    const s = H.state.suppliers.find(x => x.id === id), order = supplierOrder(), price = supplierCost(s, order, view.supplierScope);
    H.modal(s.name + ' · 能力档案', `<div class="notice">虚构供应商档案，仅演示采购评估流程。</div><div class="mg-kv"><span>签约主体</span><b>${e(s.legalName || s.name + '（示例）')}</b><span>实际执行主体</span><b>${e(s.actualEntity || s.name + ' 示例团队')}</b><span>角色 / 分包</span><b>${e(s.role)} / ${e(s.subcontract)}</b><span>凭证及核验</span><b>${e(s.evidence || 'DEMO-QUAL-' + s.id)} · ${e(s.expiry)}</b><span>型号</span><b>${e(s.models.join(' / '))}</b><span>验证 ZIP</span><b>${e(s.zips.join('，') || '未核验；不得推定全国覆盖')}</b><span>终点</span><b>${e(s.endpoints.join(' / ') || '独立技术服务')}</b><span>工具 / 人员</span><b>${s.crew} 人；门高 ${s.door} cm；尾板 ${s.liftW} × ${s.liftD} cm / ${s.liftKg} kg</b><span>剩余日容量</span><b>${s.capacity} 台（演示排期）</b><span>保险范围</span><b>${e(s.insurance)}</b></div><h3>按责任段核验</h3><div class="mg-table-wrap"><table class="table"><thead><tr><th>责任段</th><th>必须核验</th><th>本档记录</th></tr></thead><tbody><tr><td>运输接管</td><td>实际承运人、货物险、声明货值与除外</td><td>${e(s.cargoEvidence || 'DEMO 运输责任凭证；生产待上传')}</td></tr><tr><td>区域仓保管</td><td>站址、仓储责任、入/出库接管、索赔</td><td>${s.types.includes('T3') ? e(s.warehouseEvidence || 'DEMO 仓储责任附件') : '无 T3，不推定已含仓储'}</td></tr><tr><td>现场搬运</td><td>人员器具、场地损害、楼梯/脱托方案</td><td>${s.types.some(x => ['T2', 'T4'].includes(x)) ? e(s.handlingEvidence || 'DEMO 作业与保险范围') : '未采购相应能力'}</td></tr><tr><td>技术服务</td><td>产品授权、适用人员、功能验收</td><td>${s.types.includes('T5') ? e(s.technicalEvidence || 'DEMO 产品授权；注意有效期') : '由独立 T5 团队执行'}</td></tr></tbody></table></div><h3>本次比价项目（估价）</h3><div class="mg-kv">${price.items.map(([k, v]) => `<span>${e(k)}</span><b>${money(v)}</b>`).join('')}<span>同范围小计</span><b>${money(price.total)}</b></div><h3>最近核验 / 暂停记录</h3>${(s.history || []).slice(-5).reverse().map(x => `<div class="mg-history"><b>${e(x.action)}</b><small>${e(x.date)}</small><p>${e(x.note)}</p></div>`).join('') || '<p class="mg-muted">初始演示数据，无真实审核凭证。</p>'}`);
  }
  function supplierEdit(id) {
    const s=H.state.suppliers.find(x=>x.id===id);
    H.modal('编辑承接范围 · '+s.name,`<div class="notice">资料可以修改。影响承接的变更会转为待复核，关联路线失效；保留旧记录供追溯。</div><div class="form-grid">${H.field('供应商名称','name',s.name,'text','required')}${H.field('区域','region',s.region,'text','required')}${H.field('已核验 ZIP（逐项）','zips',s.zips.join(','),'text','required')}${select('联系所在地时区','timeZone',[{value:'',label:'待确认'},...H.tz.zones],s.timeZone||'')}${H.field('城市级演示纬度（可留空）','lat',s.lat??'','number','min="18" max="72" step="any"')}${H.field('城市级演示经度（可留空）','lng',s.lng??'','number','min="-180" max="-60" step="any"')}<div class="field">采购能力<div class="mg-check-grid">${Object.entries(typeNames).map(([t,l])=>check('types',t,t+' '+l,s.types.includes(t))).join('')}</div></div><div class="field">型号<div class="mg-check-grid">${H.state.models.map(m=>check('models',m.id,m.id,s.models.includes(m.id))).join('')}</div></div><div class="field">交付终点<div class="mg-check-grid">${['L1','L2','L3'].map(t=>check('endpoints',t,t,s.endpoints.includes(t))).join('')}</div></div>${H.field('基础估价 USD','rate',s.rate,'number','required min="0" step="0.01"')}${H.field('现场人数','crew',s.crew,'number','required min="1" max="20"')}${H.field('车门净高 cm','door',s.door,'number','required min="0"')}${H.field('尾板额定 kg','liftKg',s.liftKg,'number','required min="0"')}${H.field('尾板有效宽 cm','liftW',s.liftW,'number','required min="0"')}${H.field('尾板有效深 cm','liftD',s.liftD,'number','required min="0"')}${H.field('当日承接容量','capacity',s.capacity,'number','required min="0"')}</div>${H.field('修改依据 / 负责人','reason','','text','required')}`,fd=>{
      const zips=required(fd,'zips').split(/[,，\s]+/).filter(Boolean),types=fd.getAll('types'),models=fd.getAll('models'),endpoints=fd.getAll('endpoints');
      if(zips.some(z=>!/^\d{5}$/.test(z))||!types.length||!models.length)throw Error('请填写有效ZIP并选择能力和型号');
      if(types.some(t=>['T1','T2','T4'].includes(t))&&!endpoints.length)throw Error('物理交付能力须明确终点');
      const previous=H.clone(s),next={name:required(fd,'name'),region:required(fd,'region'),zips:[...new Set(zips)],types,models,endpoints,timeZone:fd.get('timeZone'),status:'范围变更 · 待复核',version:(s.version||1)+1};
      for(const k of ['rate','crew','door','liftKg','liftW','liftD','capacity'])next[k]=number(fd,k,0,['crew','capacity'].includes(k));
      for(const k of ['lat','lng'])next[k]=String(fd.get(k)||'').trim()===''?null:Number(fd.get(k));
      if(next.lat!=null&&!Number.isFinite(next.lat)||next.lng!=null&&!Number.isFinite(next.lng))throw Error('坐标无效');
      const affected=new Set();for(const b of H.state.batches)if(b.config?.supplier===id){b.invalidated=true;b.invalidReason='供应商承接范围变更';(b.orderIds||[]).forEach(x=>affected.add(x));}
      for(const id of affected){const o=H.order(id);if(o&&o.status!=='物理交付完成')H.services?.invalidate(o,'承接供应商范围变更');}
      Object.assign(s,next);s.history||=[];s.history.push({action:'编辑范围后待复核',date:H.state.demoDate,note:required(fd,'reason'),previous});H.save('供应商范围变更',s.id,fd.get('reason'));
    });
  }
  function supplierAdd() {
    H.modal('添加候选供应商', `<div class="notice">新建后为“候选待审核”，不能直接进入可询价名单。</div><div class="grid cols-2">${H.field('企业名称', 'name', '', 'text', 'required maxlength="100"')}${H.field('签约主体', 'legalName', '', 'text', 'required')}${H.field('实际执行主体', 'actualEntity', '', 'text', 'required')}${select('采购角色', 'role', ['实际末端商', '仓点与末端', '经纪 / 干线', '授权技术方'], '实际末端商')}${H.field('具体区域', 'region', 'DFW', 'text', 'required')}${H.field('已申请核验 ZIP（逗号分隔）', 'zips', '75201,75039', 'text', 'required')}<div class="field">申请能力<div class="mg-check-grid">${Object.entries(typeNames).map(([t, label]) => check('types', t, t + ' ' + label, t === 'T2')).join('')}</div></div><div class="field">申请型号<div class="mg-check-grid">${H.state.models.map(m => check('models', m.id, m.id, true)).join('')}</div></div><div class="field">交付终点<div class="mg-check-grid">${['L1', 'L2', 'L3'].map(t => check('endpoints', t, t, t === 'L3')).join('')}</div></div>${H.field('基础估价 USD', 'rate', 280, 'number', 'required min="0" step="0.01"')}${H.field('实际车组人数', 'crew', 2, 'number', 'required min="1" max="20"')}${H.field('车门净高 cm（技术方填 0）', 'door', 235, 'number', 'required min="0"')}${H.field('尾板宽 cm', 'liftW', 160, 'number', 'required min="0"')}${H.field('尾板深 cm', 'liftD', 110, 'number', 'required min="0"')}${H.field('尾板额定 kg', 'liftKg', 750, 'number', 'required min="0"')}${H.field('每日可接台数', 'capacity', 8, 'number', 'required min="0"')}</div>`, fd => {
      const name = required(fd, 'name', '企业名称'), zips = required(fd, 'zips', 'ZIP').split(/[,，\s]+/).filter(Boolean);
      if (zips.some(z => !/^\d{5}$/.test(z))) throw new Error('ZIP 必须为五位数字，逐项列明，不接受全国或通配符');
      const types = fd.getAll('types'), models = fd.getAll('models'), endpoints = fd.getAll('endpoints');
      if (!types.length || !models.length || (!types.every(t => t === 'T5') && !endpoints.length)) throw new Error('请选能力、型号及适用交付终点');
      const s = { id: 'SP-' + Date.now().toString(36).toUpperCase(), name, legalName: required(fd, 'legalName'), actualEntity: required(fd, 'actualEntity'), role: fd.get('role'), region: required(fd, 'region'), zips: [...new Set(zips)], models, types, endpoints, expiry: '', status: '候选待审核', rate: number(fd, 'rate'), crew: number(fd, 'crew', 1, true), door: number(fd, 'door'), liftW: number(fd, 'liftW'), liftD: number(fd, 'liftD'), liftKg: number(fd, 'liftKg'), capacity: number(fd, 'capacity', 0, true), ontime: 0, total: 0, pod: 0, damage: 0, insurance: '待核验责任范围', subcontract: '未披露不得转包', history: [] };
      H.state.suppliers.push(s); H.save('新增候选供应商', s.id, name); H.toast('候选已保存，请完成能力与责任核验。');
    });
  }
  function supplierReview(id) {
    const s = H.state.suppliers.find(x => x.id === id);
    H.modal('核验供应商 · ' + s.name, `<p class="mg-muted">核验只记录本演示的证据和结论；不能替代真实合同、许可及保险审查。已有暂停范围不会自动解除。</p><div class="grid cols-2">${H.field('实际执行主体', 'actualEntity', s.actualEntity || s.name + ' 示例团队', 'text', 'required')}${H.field('核验有效至（执行日再校验）', 'expiry', s.expiry || '2027-03-31', 'date', 'required')}${H.field('核验人', 'reviewer', '采购主管（演示）', 'text', 'required')}${H.field('证据编号 / 文件引用', 'evidence', s.evidence || 'DEMO-QUAL-' + s.id, 'text', 'required')}${H.field('运输 / 现场 / 仓储 / 技术保险范围', 'insurance', s.insurance, 'text', 'required')}${H.field('分包规则', 'subcontract', s.subcontract, 'text', 'required')}</div><label class="field">审核结论与限制<textarea name="note" required placeholder="逐项写明已核验型号、ZIP、实际车组、场地作业限制及责任范围"></textarea></label>`, fd => {
      const expiry = required(fd, 'expiry'); validDate(expiry); if (expiry < H.state.demoDate) throw new Error('有效期早于演示基准日，不能设为有效核验');
      Object.assign(s, { actualEntity: required(fd, 'actualEntity'), expiry, evidence: required(fd, 'evidence'), insurance: required(fd, 'insurance'), subcontract: required(fd, 'subcontract'), status: (s.pausedTypes || []).length ? '部分能力暂停' : '已核验（演示）' });
      s.history ||= []; s.history.push({ action: '核验记录', date: H.state.demoDate, note: required(fd, 'note') + ' / ' + required(fd, 'reviewer') });
      H.save('供应商核验', id, s.evidence); H.toast('核验记录已保存；需逐票取得有效承接。');
    });
  }
  function supplierPause(id) {
    const s = H.state.suppliers.find(x => x.id === id);
    H.modal('管理暂停范围 · ' + s.name, `<p>选择要暂停的能力。取消已暂停项需在原因中填写复核证据。</p><div class="mg-check-grid">${s.types.map(t => check('paused', t, t + ' ' + typeNames[t], (s.pausedTypes || []).includes(t))).join('')}</div><label class="field">暂停 / 恢复原因与证据<textarea name="note" required></textarea></label>`, fd => {
      const next = fd.getAll('paused'), note = required(fd, 'note');
      s.pausedTypes = next; s.status = next.length ? '部分能力暂停' : s.expiry && s.expiry >= H.state.demoDate ? '已核验（演示）' : '候选待审核';
      s.history ||= []; s.history.push({ action: next.length ? '暂停 ' + next.join(' / ') : '恢复能力待逐票承接', date: H.state.demoDate, note });
      H.save('调整供应商能力暂停范围', id, note); H.toast('范围已更新，下一次匹配将使用新规则。');
    });
  }
  H.mounts.suppliers = function () {
    H.$('#mg-supplier-order').onchange = ev => { view.supplierOrder = ev.target.value; H.render(); };
    H.$('#mg-supplier-scope').onchange = ev => { view.supplierScope = ev.target.value; H.render(); };
    H.$('#mg-eligible-only').onchange = ev => { view.eligibleOnly = ev.target.checked; H.render(); };
    H.$('#mg-supplier-add').onclick = supplierAdd;
    H.$$('[data-supplier-edit]').forEach(b=>b.onclick=()=>supplierEdit(b.dataset.supplierEdit));
    H.$$('#mg-supplier-export').forEach(b => b.onclick = () => H.csv('HAHA-V7-供应商能力.csv', [['示例主体', '角色', '能力', '型号', 'ZIP', '终点', '核验截止', '状态', '车门cm', '尾板kg', '保险'], ...H.state.suppliers.map(s => [s.name, s.role, s.types.join('/'), s.models.join('/'), s.zips.join('/'), s.endpoints.join('/'), s.expiry, s.status, s.door, s.liftKg, s.insurance])]));
    H.$$('[data-supplier-detail]').forEach(b => b.onclick = () => supplierDetail(b.dataset.supplierDetail));
    H.$$('[data-supplier-review]').forEach(b => b.onclick = () => supplierReview(b.dataset.supplierReview));
    H.$$('[data-supplier-pause]').forEach(b => b.onclick = () => supplierPause(b.dataset.supplierPause));
  };

  function filteredInventory() { return H.state.inventory.filter(u => (!view.warehouse || u.warehouse === view.warehouse) && (!view.model || u.model === view.model) && (!view.inventoryQuery || `${u.serial} ${u.orderId || ''}`.toLowerCase().includes(view.inventoryQuery.toLowerCase()))); }
  H.pages.inventory = function () {
    ensure();
    const items = filteredInventory(), all = H.state.inventory, day = H.state.demoDate;
    const available = all.filter(u => u.status === '可用').length, locked = all.filter(u => u.status === '锁定').length, quarantine = all.filter(u => u.status === '隔离').length;
    const expiring = all.filter(u => u.status !== '已出库' && storageSnapshot(u, contractFor(u), day).remaining <= 3).length;
    const table = `<div class="mg-table-wrap"><table class="table"><thead><tr><th>序列号 / 型号</th><th>仓点 / 库存策略</th><th>状态 / 订单</th><th>入仓 / 仓龄</th><th>免费截止 / 当地时区</th><th>计费预估</th><th>操作</th></tr></thead><tbody>${items.map(u => { const c = contractFor(u), t = storageSnapshot(u, c, day), w = H.warehouse(u.warehouse); return `<tr><td><b class="mg-mono">${e(u.serial)}</b><small>${e(u.model)}</small></td><td>${e(w.name)}<small>${e(u.strategy)} · 配送路径另选 A/B/C</small></td><td>${pill(u.status)}<small>${e(u.orderId || '未分配订单')}</small></td><td>${e(u.received)}<small>${t.age} 个当地自然日</small></td><td>${c.freeDays ? e(t.deadline) + ' 23:59' : '无免费期'}<small>${e(c.timezone)} · ${c.freeDays} ${c.calendar === 'business' ? '工作日' : '自然日'}</small>${u.status !== '已出库' ? pill(t.remaining >= 0 ? '余 ' + t.remaining + ' 天' : '已超期 ' + Math.abs(t.remaining) + ' 天', t.remaining <= 3 ? 'amber' : 'green') : ''}</td><td><b>${money(t.fee)}</b><small>${t.chargeDays} 计费日 × ${money(c.rate)} / 台 / 日</small>${t.missingEnd ? pill('缺终止实绩 · 仍预留', 'red') : t.stopped ? pill('已按实绩停表', 'green') : ''}</td><td><div class="mg-table-actions">${u.status === '可用' ? `<button class="btn" data-stock-lock="${e(u.serial)}">锁定</button>` : u.status === '锁定' ? `<button class="btn" data-stock-release="${e(u.serial)}">解除锁定</button>` : u.status === '隔离' ? `<button class="btn" data-stock-quality="${e(u.serial)}">质检释放</button>` : ''}${u.status !== '隔离' && u.status !== '已出库' ? `<button class="btn" data-stock-isolate="${e(u.serial)}">隔离</button>` : ''}<button class="btn" data-stock-detail="${e(u.serial)}">记录</button></div></td></tr>`; }).join('') || '<tr><td colspan="7">无符合筛选的库存。</td></tr>'}</tbody></table></div>`;
    return H.heading('仓网、库存与免费期', '按序列号看货物状态，把客户预约、末端班次与仓租截止放在同一张计划表。', '<button class="btn" id="mg-inventory-export">导出库存台账</button><button class="btn primary" id="mg-inventory-add">＋ 录入到仓设备</button>') +
      `<div class="metrics">${H.metric('可用库存', available, '隔离、在途、已出库不计入')}${H.metric('订单锁定', locked, '序列号唯一，不重复扣库存位置')}${H.metric('质量隔离', quarantine, '须独立质检确认才能释放', 'warn')}${H.metric('免费期 ≤ 3 天', expiring, `各仓当地演示日 ${day}`, 'warn')}</div>` +
      `<div class="mg-warehouse-grid">${H.state.warehouses.map(w => { const c = H.state.warehouseContracts[w.id], units = all.filter(u => u.warehouse === w.id && u.status !== '已出库'); return `<section class="card"><div class="card-body"><div class="mg-between"><span class="mg-id">${e(w.id)}</span>${pill(w.type, w.type.includes('待验证') ? 'amber' : 'blue')}</div><h3>${e(w.name)}</h3><p class="mg-muted">${e(w.timezone)} · 台账 ${units.length} 台</p><div class="mg-warehouse-bar"><i style="width:${Math.min(100, w.used / w.capacity * 100)}%"></i></div><p class="mg-muted">仓点总体占位示例 ${w.used}/${w.capacity}；非本台账设备总数</p><div class="mg-contract-summary"><b>${c.freeDays ? c.freeDays + ' 天免费' : '按日收费'}</b><span>${money(c.rate)} / 台 / 日</span></div><p class="mg-muted">${c.calendar === 'business' ? '工作日' : '自然日'} · 入仓${c.includeFirst ? '当日计第 1 天' : '次日起算'} · ${c.endEvent === 'delivery' ? '实际完成配送' : '实际出库'}停表</p><button class="btn" data-contract="${e(w.id)}">查看 / 编辑合同卡</button></div></section>`; }).join('')}</div>` +
      `<div class="mg-toolbar">${select('仓点', 'warehouse', [{ value: '', label: '全部仓点' }, ...H.state.warehouses.map(w => ({ value: w.id, label: w.name }))], view.warehouse, 'id="mg-stock-wh"')}${select('型号', 'model', [{ value: '', label: '全部型号' }, ...H.state.models.map(m => m.id)], view.model, 'id="mg-stock-model"')}<label class="field">序列号 / 订单<input id="mg-stock-query" value="${e(view.inventoryQuery)}" placeholder="DEMO-M06 / H26004"></label></div>` + card('序列号台账', table, `<span class="mg-muted">${items.length} 条 · 不把待到货当可用库存</span>`) +
      `<div class="grid cols-2 mg-section">${card('D 前置补货计算', `<p class="mg-muted">目标 S = 预测新增需求 + 安全库存；位置 P = 合格现货（含锁定）+ 按时确认在途 − 未出库确认需求。预测不能重复包含已确认订单。</p><form id="mg-replenish-form"><div class="grid cols-2">${select('仓点', 'warehouse', H.state.warehouses.filter(w => !w.type.includes('待验证')).map(w => ({ value: w.id, label: w.name })), 'WH-DFW')}${select('SKU', 'model', H.state.models.map(m => m.id), 'M06')}${H.field('提前期＋复核期预测新增需求', 'forecast', 3, 'number', 'min="0" step="1" required')}${H.field('批准的安全库存', 'safety', 1, 'number', 'min="0" step="1" required')}${H.field('可按时到达的确认补货台数', 'inbound', 0, 'number', 'min="0" step="1" required')}${H.field('在途依据（填数量时必填）', 'inboundEvidence', '', 'text', 'placeholder="已确认调拨号 / 到仓日期"')}</div><div class="actions"><button type="submit" class="btn primary">计算补货建议</button></div><div id="mg-replenish-result" class="mg-result">选择节点与 SKU 后计算；建议不自动创建采购或调拨。</div></form>`)}${card('仓龄与隔离的处理原则', `<ul class="mg-list"><li>仓期按仓点 IANA 时区的当地日历计算；当前演示使用固定日期 ${e(day)}，不受查看者电脑时区影响。</li><li>库存逐台绑定接收时合同快照。修改合同只影响新到仓设备，原批次不静默改价。</li><li>终止计费需实际出库或配送凭证；建单、锁单、返站不重置仓龄。</li><li>隔离可解除订单锁定，但不会自动恢复可售；风险结案也不释放损坏货。</li><li>到期比较继续存放、批准调拨及退回完整成本，不为免租空搬货。</li></ul><div class="mg-footnote">V5 p14–17、22。表内费率与合同为演算；出库营业日默认周一至周五，节假日可在合同卡录入。</div>`)}</div>`;
  };
  function inventoryDetail(serial) {
    const u = H.state.inventory.find(x => x.serial === serial), c = contractFor(u), s = storageSnapshot(u, c, H.state.demoDate), w = H.warehouse(u.warehouse);
    H.modal(serial + ' · 库存记录', `<div class="mg-kv"><span>状态</span><b>${e(u.status)}</b><span>当前仓点 / 时区</span><b>${e(w.name)} / ${e(c.timezone)}</b><span>库存策略</span><b>${e(u.strategy)}；不替代 A/B/C 交付路径</b><span>锁定订单</span><b>${e(u.orderId || '无')}</b><span>入仓事实日期</span><b>${e(u.received)} · ${e(c.startEvent)}</b><span>合同快照</span><b>${e(c.id)} / v${c.version}</b><span>免费截止</span><b>${c.freeDays ? e(s.deadline) + ' 23:59 ' + e(c.timezone) : '无免费期'}</b><span>终止事件</span><b>${c.endEvent === 'delivery' ? '实际完成配送' : '实际出库'}；${c.includeEndDay ? '终止当日计费' : '终止当日不计费'}</b><span>已知出库实绩</span><b>${e(u.outboundDate || '未提供')}</b><span>已知配送实绩</span><b>${e(u.deliveredDate || '未提供')}</b><span>至演示基准日预估</span><b>${money(s.fee)} / ${s.chargeDays} 计费日</b></div><h3>状态变更证据</h3>${(u.history || []).slice(-8).reverse().map(x => `<div class="mg-history"><b>${e(x.action)}</b><small>${e(x.date)}</small><p>${e(x.note)}</p></div>`).join('') || '<p class="mg-muted">初始示例台账；无真实接管凭证。</p>'}<div class="notice">本弹窗不通过填写预计日期停止仓租。实际出库/交付由相应作业记录回传；历史出库但无日期时仍保留费用预估。</div>`);
  }
  function contractEdit(id) {
    const w = H.warehouse(id), c = H.state.warehouseContracts[id];
    H.modal(w.name + ' · 仓储合同卡', `<div class="notice">时区 ${e(w.timezone)}。修改生成新版本，仅用于后续新到仓设备；已接收库存保持原合同快照。</div><div class="grid cols-2">${H.field('合同编号', 'id', c.id, 'text', 'required')}${H.field('免费天数', 'freeDays', c.freeDays, 'number', 'required min="0" max="366" step="1"')}${select('免费期日历', 'calendar', [{ value: 'calendar', label: '自然日' }, { value: 'business', label: '工作日（按营业日历）' }], c.calendar)}${select('首日是否计入', 'includeFirst', [{ value: 'true', label: '实际入仓当日计第 1 天' }, { value: 'false', label: '入仓次日起算' }], String(c.includeFirst))}${select('计费终止事件', 'endEvent', [{ value: 'outbound', label: '实际出库' }, { value: 'delivery', label: '实际完成配送' }], c.endEvent)}${select('终止当日', 'includeEndDay', [{ value: 'true', label: '当日计费' }, { value: 'false', label: '当日不计费' }], String(c.includeEndDay))}${H.field('超期 USD / 台 / 自然日', 'rate', c.rate, 'number', 'required min="0" step="0.01"')}${H.field('产生超期后最低收费 USD / 台', 'minimumCharge', c.minimumCharge, 'number', 'required min="0" step="0.01"')}</div><div class="field">正常出库营业日<div class="mg-check-grid">${['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, day) => check('workDays', day, label, c.workDays.includes(day))).join('')}</div></div>${H.field('不营业日期（YYYY-MM-DD，逗号分隔）', 'holidays', c.holidays.join(','))}<label class="field">适用条件 / 退出规则<textarea name="note" required>${e(c.note)}</textarea></label>`, fd => {
      const workDays = fd.getAll('workDays').map(Number); if (!workDays.length) throw new Error('至少一个营业日');
      const holidays = String(fd.get('holidays') || '').split(/[,，\s]+/).filter(Boolean); holidays.forEach(validDate);
      const next = { ...c, id: required(fd, 'id'), freeDays: number(fd, 'freeDays', 0, true), calendar: fd.get('calendar'), includeFirst: fd.get('includeFirst') === 'true', endEvent: fd.get('endEvent'), includeEndDay: fd.get('includeEndDay') === 'true', rate: number(fd, 'rate'), minimumCharge: number(fd, 'minimumCharge'), workDays, holidays, timezone: w.timezone, note: required(fd, 'note'), version: c.version + 1 };
      freeDeadline(H.state.demoDate, next);
      H.state.warehouseContracts[id] = next; H.save('新增仓储合同版本', id, `${next.id} v${next.version}；不覆盖在库快照`); H.toast('新合同版本已保存，仅应用于后续接收。');
    });
  }
  function inventoryAdd() {
    H.modal('录入到仓设备（演示）', `<div class="notice">该动作模拟已取得入仓实绩，不把船期预测转成现货。资料不足请选择隔离。</div><div class="grid cols-2">${H.field('唯一序列号', 'serial', '', 'text', 'required')}${select('型号', 'model', H.state.models.map(m => m.id), 'M06')}${select('实际接收仓点', 'warehouse', H.state.warehouses.filter(w => !w.type.includes('待验证')).map(w => ({ value: w.id, label: w.name })), 'WH-DFW')}${H.field('仓点当地入仓日期', 'received', H.state.demoDate, 'date', 'required')}${select('库存策略', 'strategy', ['基础库存', 'C 已售暂存', 'D'], 'D')}${select('质量状态', 'status', ['隔离', '可用'], '隔离')}${H.field('接管 / 点检凭证编号', 'evidence', '', 'text', 'required')}${H.field('接收 / 点检责任人', 'owner', '', 'text', 'required')}</div>`, fd => {
      const serial = required(fd, 'serial'); if (H.state.inventory.some(x => x.serial === serial)) throw new Error('序列号已存在，不能重复收货或重置仓龄');
      const received = required(fd, 'received'); validDate(received); if (received > H.state.demoDate) throw new Error('不能把未来预计到仓录为实际接收');
      const wh = required(fd, 'warehouse'), status = fd.get('status');
      const u = { serial, model: fd.get('model'), warehouse: wh, received, status, orderId: null, strategy: fd.get('strategy'), contract: H.state.warehouseContracts[wh].id, storageContract: H.clone(H.state.warehouseContracts[wh]), history: [{ action: '实际接收（演示）', date: received, note: required(fd, 'evidence') + ' / ' + required(fd, 'owner') }] };
      H.state.inventory.push(u); H.save('录入到仓设备', serial, status); H.toast('设备已录入，并绑定当前仓储合同快照。');
    });
  }
  function inventoryAction(serial, action) {
    const u = H.state.inventory.find(x => x.serial === serial);
    if (action === 'lock') {
      const candidates = H.state.orders.filter(o => o.model === u.model && o.warehouse === u.warehouse && o.status !== '物理交付完成');
      H.modal('锁定序列号 · ' + serial, `${select('匹配订单', 'orderId', candidates.map(o => ({ value: o.id, label: o.id + ' · ' + o.customer })), candidates[0]?.id || '')}<label class="field">分配依据<textarea name="note" required></textarea></label><p class="mg-muted">同型号、同仓点且尚未锁定设备的订单才可成功；不自动改预约或放行。</p>`, fd => {
        const o = H.order(fd.get('orderId')), issue = canReserve(H.state.inventory, H.state.orders, u, o); if (issue) throw new Error(issue);
        const note = required(fd, 'note'); u.status = '锁定'; u.orderId = o.id; o.serial = u.serial; o.checks.inventory = true; o.version += 1;
        u.history ||= []; u.history.push({ action: '锁定给 ' + o.id, date: H.state.demoDate, note }); H.save('锁定序列号', serial, o.id); H.toast('锁定成功；订单版本已更新，后续放行须按新版本。');
      }); return;
    }
    const title = action === 'release' ? '解除订单锁定' : action === 'isolate' ? '隔离设备并停止放行' : '质检后释放隔离';
    H.modal(title + ' · ' + serial, `<div class="notice">${action === 'quality' ? '只有完成质检并确认可销售后才能释放。风险工单结案不会自动执行此动作。' : '设备仓龄与入仓合同保持不变。关联订单会被撤销库存核验，须重新配货。'}</div>${H.field('处理人', 'owner', '', 'text', 'required')}${H.field('证据 / 工单编号', 'evidence', '', 'text', 'required')}<label class="field">原因与处理结论<textarea name="note" required></textarea></label>${action === 'quality' ? check('passed', 'yes', '我确认已获得质检通过依据；这只是演示记录', false) : ''}`, fd => {
      if (u.status === '已出库') throw new Error('已出库设备需先按逆向流程确认接管，不能直接改在库状态');
      const o = H.order(u.orderId); if (action === 'release' && o && ['已派车', '执行中', '已放行（演示）'].includes(o.status)) throw new Error('执行中订单不能直接解锁，请先取消或变更有效放行指令');
      if (action === 'quality' && fd.get('passed') !== 'yes') throw new Error('请确认质检通过依据');
      const note = `${required(fd, 'note')} / ${required(fd, 'owner')} / ${required(fd, 'evidence')}`;
      if (o) {
        o.checks.inventory = false; o.version += 1; o.serial = ''; o.notes = `${o.notes || ''}；库存 ${serial} ${title}`;
        if (o.release) { o.history ||= []; o.history.push({ action: '库存变化撤销旧放行', date: H.state.demoDate, note: title, previousRelease: H.clone(o.release) }); delete o.release; }
        o.status = '待放行';
        for (const b of H.state.batches) if (b.status !== '已取消' && (b.orderIds || []).includes(o.id)) { b.status = '需重核（库存变化）'; b.reviewReason = `${o.id} 库存发生变化，旧版本不可执行`; }
      }
      u.status = action === 'isolate' ? '隔离' : '可用'; u.orderId = null;
      u.history ||= []; u.history.push({ action: title, date: H.state.demoDate, note });
      if (action === 'isolate') H.state.risks.unshift({ id: 'R-' + Date.now().toString(36).toUpperCase(), kind: '质量隔离', ref: serial, severity: '高', title: '设备质量隔离，禁止自动重新销售', owner: fd.get('owner'), backup: '待指派', custodian: H.warehouse(u.warehouse).name, next: '补齐检验与索赔证据，指定批准释放人', due: H.state.demoDate + ' 17:00', timeZone: H.warehouse(u.warehouse).timezone, status: '待接单', reserve: 0, history: [{ action: '隔离触发', date: H.state.demoDate, note }] });
      H.save(title, serial, note); H.toast(title + '已记录，免费期未重置。');
    });
  }
  H.mounts.inventory = function () {
    H.$('#mg-stock-wh').onchange = ev => { view.warehouse = ev.target.value; H.render(); };
    H.$('#mg-stock-model').onchange = ev => { view.model = ev.target.value; H.render(); };
    H.$('#mg-stock-query').onchange = ev => { view.inventoryQuery = ev.target.value.trim(); H.render(); };
    H.$('#mg-inventory-add').onclick = inventoryAdd;
    H.$$('#mg-inventory-export').forEach(b => b.onclick = () => H.csv('HAHA-V7-库存仓龄.csv', [['序列号', '型号', '仓点', '状态', '订单', '策略', '入仓当地日', '免费截止', 'IANA时区', '预估仓储USD', '合同版本'], ...filteredInventory().map(u => { const c = contractFor(u), t = storageSnapshot(u, c, H.state.demoDate); return [u.serial, u.model, u.warehouse, u.status, u.orderId, u.strategy, u.received, t.deadline, c.timezone, t.fee.toFixed(2), c.id + ' v' + c.version]; })]));
    H.$$('[data-contract]').forEach(b => b.onclick = () => contractEdit(b.dataset.contract));
    H.$$('[data-stock-detail]').forEach(b => b.onclick = () => inventoryDetail(b.dataset.stockDetail));
    for (const action of ['lock', 'release', 'isolate', 'quality']) H.$$(`[data-stock-${action}]`).forEach(b => b.onclick = () => inventoryAction(b.getAttribute('data-stock-' + action), action));
    H.$('#mg-replenish-form').onsubmit = ev => {
      ev.preventDefault();
      try {
        const fd = new FormData(ev.target), wh = fd.get('warehouse'), sku = fd.get('model'), list = H.state.inventory.filter(u => u.warehouse === wh && u.model === sku);
        const eligible = list.filter(u => ['可用', '锁定'].includes(u.status)).length, confirmedDemand = H.state.orders.filter(o => o.warehouse === wh && o.model === sku && o.status !== '物理交付完成').reduce((a, o) => a + Number(o.qty), 0);
        const inbound = number(fd, 'inbound', 0, true); if (inbound && !String(fd.get('inboundEvidence') || '').trim()) throw new Error('请输入按时到达在途的确认依据，不能直接使用船期预测');
        const r = replenishment({ eligible, inbound, confirmedDemand, forecast: number(fd, 'forecast', 0, true), safety: number(fd, 'safety', 0, true) });
        H.$('#mg-replenish-result').innerHTML = `<div class="mg-calc-grid"><div><small>目标库存 S</small><b>${r.S}</b></div><div><small>库存位置 P</small><b>${r.P}</b></div><div><small>建议补货 Q</small><b>${r.Q}</b></div></div><p>合格现货 ${eligible}（已含锁定） + 确认在途 ${inbound} − 未出库确认需求 ${confirmedDemand} = ${r.P}。隔离 ${list.filter(u => u.status === '隔离').length} 台未计入。${r.Q ? '请核需求、仓位、资金与退出成本后批准调拨。' : '暂无新增补货需求。'}</p><button class="btn" type="button" id="mg-replenish-save">保存测算记录</button>`;
        H.$('#mg-replenish-save').onclick = () => { H.state.replenishments.unshift({ id: 'RP-' + Date.now(), warehouse: wh, model: sku, eligible, inbound, confirmedDemand, ...r, date: H.state.demoDate, status: '测算草案', evidence: String(fd.get('inboundEvidence') || '') }); H.save('保存补货测算', sku, wh + ' Q=' + r.Q); H.$('#mg-replenish-save').disabled = true; H.$('#mg-replenish-save').textContent = '已保存测算草案'; H.toast('仅保存测算，未创建采购或调拨指令。'); };
      } catch (err) { H.toast(err.message); }
    };
  };

  function riskZone(r) {
    const inline = String(r.due || '').match(/(?:America|Pacific|Asia)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/)?.[0];
    const shipment = H.state.inbound.find(s => s.id === r.ref), unit = H.state.inventory.find(u => u.serial === r.ref);
    return r.timeZone || inline || (/\bET\b/.test(r.due || '') ? 'America/New_York' : /\bPT\b/.test(r.due || '') ? 'America/Los_Angeles' : /\bCT\b/.test(r.due || '') ? 'America/Chicago' : H.order(r.ref)?.timeZone || H.warehouse(shipment?.warehouse || unit?.warehouse)?.timezone || '');
  }
  function riskDue(r) {
    const zone = riskZone(r), match = String(r.due || '').match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    let beijing = '';
    if (H.tz && match) { try { const iso = r.dueUTC || H.tz.wallToUTC(match[1], match[2], zone); beijing = H.tz.format(iso, 'Asia/Shanghai'); } catch { beijing = '时刻需核实（夏令时或格式冲突）'; } }
    return { zone, local: match ? match[1] + ' ' + match[2] : r.due || '待设置', beijing };
  }
  function filteredRisks() { return H.state.risks.filter(r => (!view.riskStatus || r.status === view.riskStatus) && (!view.riskSeverity || r.severity === view.riskSeverity) && (!view.riskQuery || `${r.id} ${r.ref} ${r.title} ${r.owner}`.toLowerCase().includes(view.riskQuery.toLowerCase()))); }
  H.pages.risks = function () {
    ensure();
    const open = H.state.risks.filter(r => r.status !== '已结案'), high = open.filter(r => r.severity === '高'), noOwner = open.filter(r => !r.owner || !r.backup || r.backup === '待指派'), rows = filteredRisks(), reserves = reserveSummary(open);
    return H.heading('风险与异常处置', '始终知道货物由谁保管、谁接下一步，以及下一次反馈时间。', '<button class="btn" id="mg-risk-export">导出处置清单</button><button class="btn primary" id="mg-risk-add">＋ 新建风险工单</button>') +
      `<div class="metrics">${H.metric('待关闭事件', open.length, '海运、现场、仓龄与执行一处跟踪')}${H.metric('高风险', high.length, '先处理安全、保管与窗口冲突', 'warn')}${H.metric('主备联系人待补', noOwner.length, '认领时必须指定负责人和备班', 'warn')}${H.metric('已知费用预留小计', money(reserves.knownTotal), `另有 ${reserves.unknown} 项金额待核；预留不等于授权`, reserves.unknown ? 'warn' : '')}</div>` +
      `<div class="mg-risk-process"><span><b>01</b>记录触发事实</span><i>→</i><span><b>02</b>主责 / 备班接单</span><i>→</i><span><b>03</b>保管与处置</span><i>→</i><span><b>04</b>证据复核结案</span></div>` +
      `<div class="mg-toolbar">${select('状态', 'riskStatus', [{ value: '', label: '全部状态' }, '待接单', '处理中', '已结案'], view.riskStatus, 'id="mg-risk-status"')}${select('级别', 'riskSeverity', [{ value: '', label: '全部级别' }, '高', '中', '低'], view.riskSeverity, 'id="mg-risk-severity"')}<label class="field">搜索关联任务 / 责任人<input id="mg-risk-query" value="${e(view.riskQuery)}" placeholder="SEA-2602 / 仓龄"></label></div>` +
      `<div class="mg-risk-grid">${rows.map(r => { const due = riskDue(r); return `<article class="card mg-risk ${r.severity === '高' && r.status !== '已结案' ? 'high' : ''}"><div class="card-body"><div class="mg-between"><span class="mg-id">${e(r.id)} · ${e(r.kind)}</span><span>${pill(r.severity + '风险', r.severity === '高' ? 'red' : 'amber')} ${pill(r.status)}</span></div><h2>${e(r.title)}</h2><div class="mg-risk-ref">关联 <b>${e(r.ref)}</b> · 费用预留 ${money(reserveValue(r.reserve))}</div><div class="mg-risk-kv"><span>当前保管</span><b>${e(r.custodian || '待确认，必须补齐')}</b><span>主责 / 备班</span><b>${e(r.owner || '待认领')} / ${e(r.backup || '待指派')}</b><span>下一步</span><b>${e(r.next || '待明确')}</b><span>下一反馈</span><b>${e(due.local)}<small>${e(due.zone)}</small>${due.beijing ? `<small>北京 ${e(due.beijing)}</small>` : ''}</b></div>${r.status === '已结案' ? `<div class="mg-match ok">结案：${e(r.resolution)}<br>凭证：${e(r.closeEvidence)}</div>` : ''}<div class="actions"><button class="btn" data-risk-detail="${e(r.id)}">处置记录</button>${r.status !== '已结案' ? `<button class="btn" data-risk-claim="${e(r.id)}">${r.status === '待接单' ? '认领' : '调整责任人'}</button><button class="btn primary" data-risk-handle="${e(r.id)}">处置 / 结案</button>` : ''}</div></div></article>`; }).join('') || H.empty('没有匹配事件。筛选清空后查看全部记录。')}</div>` +
      `<div class="grid cols-2 mg-section">${card('现场异常处置底线', `<ul class="mg-list"><li>门洞、楼梯、卸货场地不符：停止受影响作业，拍证据；不擅自倾倒或拆机。</li><li>无人接收：记录真实到场与联系尝试，按等待额度执行；迟到不能记客户爽约。</li><li>货损：记录事实、隔离设备、保留包装；POD 备注不替代正式索赔。</li><li>车辆/天气：重新确认可收条件与安全保管，不为准点指标违规作业。</li></ul>`)}${card('15 分钟响应设计', `<p>现场事件主值班 15 分钟内接单，超时转备班；仍无人响应时执行预授权的安全保管方案。每次放行须带主备联系人、紧急保管站和费用上限。</p><div class="notice">当前为可操作演示：计时升级与通知 API 尚未部署后台任务。新建、认领、处置、费用授权和结案记录会保存在当前浏览器。</div><div class="mg-footnote">V5 p30、32。结案不自动释放隔离设备，也不取消已经赚取的客户权益。</div>`)}</div>`;
  };
  function riskFields(r = {}) {
    const due = riskDue(r), match = due.local.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    return `<div class="grid cols-2">${H.field('主责任人', 'owner', r.owner || '', 'text', 'required')}${H.field('备班负责人', 'backup', r.backup === '待指派' ? '' : r.backup || '', 'text', 'required')}${H.field('当前实际保管人 / 仓点', 'custodian', r.custodian || '', 'text', 'required')}${H.field('下一反馈日期（当地）', 'dueDate', match?.[1] || H.state.demoDate, 'date', 'required')}${H.field('下一反馈时间（当地）', 'dueTime', match?.[2] || '16:00', 'time', 'required')}${select('事件执行地 IANA 时区', 'timeZone', [{value:'',label:'请选择事件执行地时区'},...(H.tz?.zones||[])], due.zone)}${select('DST 重复小时处理', 'dst', [{value:'reject',label:'正常校验 / 歧义时阻止'},{value:'earlier',label:'重复小时中的第一次'},{value:'later',label:'重复小时中的第二次'}],r.dst||'reject')}${H.field('费用预留 USD（非授权；未知留空）', 'reserve', r.reserve == null ? '' : r.reserve, 'number', 'min="0" step="0.01" placeholder="待核；明确为零才填 0"')}${H.field('授权支出上限 USD', 'authorized', r.authorized || 0, 'number', 'required min="0" step="0.01"')}</div><label class="field">下一步具体动作<textarea name="next" required>${e(r.next || '')}</textarea></label>`;
  }
  function parseRiskFields(fd) {
    const dueDate = required(fd, 'dueDate'), dueTime = required(fd, 'dueTime'), zone = required(fd, 'timeZone'); validDate(dueDate);
    const dueUTC = H.tz?.wallToUTC(dueDate, dueTime, zone, fd.get('dst')||'reject');
    return { owner: required(fd, 'owner'), backup: required(fd, 'backup'), custodian: required(fd, 'custodian'), due: dueDate + ' ' + dueTime, timeZone: zone, dst:fd.get('dst')||'reject', dueUTC, reserve: reserveValue(fd.get('reserve')), authorized: number(fd, 'authorized'), next: required(fd, 'next') };
  }
  function riskAdd() {
    H.modal('创建风险工单', `<div class="grid cols-2">${H.field('风险标题', 'title', '', 'text', 'required')}${H.field('关联订单 / 海运 / 序列号', 'ref', '', 'text', 'required')}${select('风险分类', 'kind', ['海运延误', '查验 / 滞箱', '现场条件', '客户失联', '质量隔离', '供应商', '仓龄', '短信失败', '费用 / 账单', '其他'], '现场条件')}${select('优先级', 'severity', ['高', '中', '低'], '高')}</div>${riskFields()}${H.field('触发事实 / 证据编号', 'evidence', '', 'text', 'required')}`, fd => {
      const r = { id: 'R-' + Date.now().toString(36).toUpperCase(), title: required(fd, 'title'), ref: required(fd, 'ref'), kind: fd.get('kind'), severity: fd.get('severity'), ...parseRiskFields(fd), status: '待接单', history: [{ action: '新建工单', date: H.state.demoDate, note: required(fd, 'evidence') }] };
      H.state.risks.unshift(r); H.save('新建风险', r.id, r.title); H.toast('风险已建立，等待责任人认领。');
    });
  }
  function riskAction(id, action) {
    const r = H.state.risks.find(x => x.id === id);
    if (action === 'detail') {
      const d = riskDue(r);
      H.modal(r.id + ' · 处置记录', `<div class="notice">${e(r.title)} · ${e(r.ref)}</div><div class="mg-kv"><span>当前保管</span><b>${e(r.custodian)}</b><span>负责人 / 备班</span><b>${e(r.owner)} / ${e(r.backup || '待指派')}</b><span>下一反馈</span><b>${e(d.local)} ${e(d.zone)}</b><span>费用预留 / 授权上限</span><b>${money(reserveValue(r.reserve))} / ${money(r.authorized || 0)}</b><span>下一步</span><b>${e(r.next)}</b></div>${(r.history || []).slice().reverse().map(x => `<div class="mg-history"><b>${e(x.action)}</b><small>${e(x.date)}</small><p>${e(x.note)}</p></div>`).join('') || '<p class="mg-muted">初始示例事件，尚无追加处置记录。</p>'}${r.status === '已结案' ? `<p><b>结案结论：</b>${e(r.resolution)}<br><b>结案凭证：</b>${e(r.closeEvidence)}</p>` : ''}`); return;
    }
    H.modal(action === 'claim' ? '认领 / 调整主备责任' : '处置与结案', `<div class="notice">${e(r.id)} · ${e(r.title)}</div>${riskFields(r)}${action === 'handle' ? select('本次处理结果', 'outcome', ['继续处理中', '已结案'], '继续处理中') : ''}${H.field('费用授权人（上限 > 0 时必填）', 'approver', r.approver || '')}<label class="field">处置结论 / 本次进展<textarea name="resolution" required>${e(r.resolution || '')}</textarea></label>${H.field('本次证据编号 / 文件引用', 'evidence', '', 'text', 'required')}${action === 'handle' ? `<div class="notice">结案须保留当前保管人、具体结论与凭证。已损坏货仍保持隔离，需另走质检释放。</div>` : ''}`, fd => {
      const values = parseRiskFields(fd), resolution = required(fd, 'resolution'), evidence = required(fd, 'evidence');
      if (values.authorized > 0 && !String(fd.get('approver') || '').trim()) throw new Error('正数授权上限须填写授权人');
      Object.assign(r, values, { approver: String(fd.get('approver') || '').trim() });
      const closed = action === 'handle' && fd.get('outcome') === '已结案';
      r.status = closed ? '已结案' : '处理中'; r.resolution = resolution;
      if (closed) { r.closeEvidence = evidence; r.closedAt = new Date().toISOString(); }
      r.history ||= []; r.history.push({ action: closed ? '证据复核结案' : action === 'claim' ? '认领 / 交接' : '处置进展', date: H.state.demoDate, note: resolution + ' / ' + evidence + ' / ' + r.owner });
      H.save(closed ? '风险结案' : '风险处置', r.id, resolution); H.toast(closed ? '风险已结案；库存隔离状态保持原样。' : '处置已更新，下一次反馈时间已留存。');
    });
  }
  H.mounts.risks = function () {
    H.$('#mg-risk-add').onclick = riskAdd;
    H.$('#mg-risk-status').onchange = ev => { view.riskStatus = ev.target.value; H.render(); };
    H.$('#mg-risk-severity').onchange = ev => { view.riskSeverity = ev.target.value; H.render(); };
    H.$('#mg-risk-query').onchange = ev => { view.riskQuery = ev.target.value.trim(); H.render(); };
    H.$('#mg-risk-export').onclick = () => H.csv('HAHA-V7-风险处置.csv', [['事件', '分类', '关联对象', '标题', '等级', '状态', '主责', '备班', '当前保管', '下一步', '当地时限', 'IANA时区', 'UTC时限', '预留USD', '授权上限USD', '结案凭证'], ...filteredRisks().map(r => [r.id, r.kind, r.ref, r.title, r.severity, r.status, r.owner, r.backup, r.custodian, r.next, riskDue(r).local, riskZone(r), r.dueUTC, r.reserve, r.authorized, r.closeEvidence])]);
    for (const action of ['detail', 'claim', 'handle']) H.$$(`[data-risk-${action}]`).forEach(b => b.onclick = () => riskAction(b.getAttribute('data-risk-' + action), action));
  };

  const costLines = [['跨区专业直达 / 批量干线', 4200, 1000], ['原仓拣货出库 + 装车', 250, 250], ['区域接收检验 + 卸车', 0, 200], ['仓储', 60, 40], ['区域拣货出库 + 装车', 0, 200], ['本地专业末端', 0, 1800], ['现场拆包清运', 150, 150], ['资金占用', 80, 100], ['损坏 / 失败 / 退运预留', 120, 160], ['管理及合同分摊', 60, 80]];
  function costTiles(c) {
    const s = costScenario(c);
    return `<div class="mg-calc-grid mg-cost-tiles"><div><small>可避免费用（奖励前）</small><b>${money(s.savings)}</b></div><div><small>共同奖励预算上限 20%</small><b>${money(s.cap)}</b></div><div><small>客户 + 人工 + 供应商</small><b>${money(s.incentive)}</b></div><div class="${s.retained < 0 ? 'negative' : ''}"><small>预计净留存</small><b>${money(s.retained)}</b></div></div><div class="notice ${s.withinCap ? '' : 'mg-danger'}">${s.withinCap ? '共同激励在建议预算内。' : '共同激励超过建议预算：未承诺项目暂停，已承诺且达成条件的权益仍按约兑现。'} ${s.completed ? `含激励单票预计成本 ${money(s.unitCost)}，分母 ${s.completed} 个完成订单。` : '完成订单数为 0，不计算每单成本。'} 未结预留 ${money(c.unsettled)} 已包含在候选总成本内，不能再重复加一次；最终账单和异常费用仍待复核。</div>`;
  }
  H.pages.cost = function () {
    ensure();
    const c = H.state.cost, s = costScenario(c), benefitTotal = H.state.benefits.reduce((a, b) => a + b.amount, 0);
    return H.heading('成本、对账与权益', '用同一服务范围比较全程支出；看清预计、未结和实际，不靠删除失败单获得“降本”。', '<button class="btn" id="mg-cost-export">导出测算与权益</button><button class="btn primary" id="mg-benefit-add">＋ 登记批准权益</button>') +
      `<div class="metrics">${H.metric('同服务基线', money(c.baseline), '10 台 / 30 日的 V5 演算')}${H.metric('候选物流成本', money(c.proposed), `已含未结预留 ${money(c.unsettled)}`)}${H.metric('预计净留存', money(s.retained), '基线 − 候选 − 全部激励')}${H.metric('权益台账', H.state.benefits.length + ' 笔', money(benefitTotal) + ' · 本机演示独立台账')}</div>` +
      `<div class="notice">本页初始数值来自 V5 p27–28 的纯演算：10 台、10 个同区域 L3 室内就位订单，另购拆包清运，未采购 L4/L5。不是当前 12 个示例订单的真实财务结果，也不是市场报价。</div>` +
      `<div class="grid cols-2 mg-section">${card('预算情景 · 可编辑', `<form id="mg-cost-form"><div class="grid cols-2">${H.field('同服务基线总成本 USD', 'baseline', c.baseline, 'number', 'min="0" step="0.01" required')}${H.field('候选物流总成本（含预留）USD', 'proposed', c.proposed, 'number', 'min="0" step="0.01" required')}${H.field('客户 SaaS 实际让利 USD', 'saas', c.saas, 'number', 'min="0" step="0.01" required')}${H.field('新增处理人工 USD', 'labor', c.labor, 'number', 'min="0" step="0.01" required')}${H.field('供应商奖励 USD', 'bonus', c.bonus, 'number', 'min="0" step="0.01" required')}${H.field('候选总额内的未结预留 USD', 'unsettled', c.unsettled, 'number', 'min="0" step="0.01" required')}${H.field('完成订单数（成本分母）', 'completed', c.completed ?? 10, 'number', 'min="0" step="1" required')}${H.field('失败尝试次数（成本已计入）', 'failed', c.failed ?? 0, 'number', 'min="0" step="1" required')}${H.field('取消订单数（费用仍保留）', 'cancelled', c.cancelled ?? 0, 'number', 'min="0" step="1" required')}${H.field('同服务比较依据', 'scope', c.scope || '10 台 / 30 日 / L3 + 拆包清运', 'text', 'required')}</div><div class="actions"><button class="btn primary" type="submit">保存测算</button><button class="btn" type="button" id="mg-cost-reset">填入 V5 演算</button></div></form><div id="mg-cost-live" class="mg-result">${costTiles(c)}</div>`)}${card('成本账目如何核对', `<div class="mg-cost-waterfall"><div><span>同服务基线</span><b>${money(c.baseline)}</b><i style="width:100%"></i></div><div><span>候选物流总成本</span><b>${money(c.proposed)}</b><i style="width:${Math.min(100, c.baseline > 0 ? c.proposed / c.baseline * 100 : 0)}%"></i></div><div><span>共同激励</span><b>${money(s.incentive)}</b><i style="width:${Math.min(100, c.baseline > 0 ? s.incentive / c.baseline * 100 : 0)}%"></i></div><div class="saved"><span>预计净留存</span><b>${money(s.retained)}</b><i style="width:${Math.min(100, Math.max(0, c.baseline > 0 ? s.retained / c.baseline * 100 : 0))}%"></i></div></div><ul class="mg-list"><li>原报价 + 批准增项 + 实际服务 / POD 三方核对。</li><li>已知部分 ${money(s.actualKnown)}，未结预留 ${money(c.unsettled)}；两者合计为候选成本。</li><li>失败、返站、再派、未售库存和退出费用都进入观察期支出。</li><li>供应商应付、客户收款、SaaS 让利分列；运费转嫁不等于效率提升。</li><li>客户与供应商共享 20% 建议上限，不分别再提 20%。</li></ul>`)}</div>` +
      `<details class="card mg-detail"><summary>查看 V5 原始演算明细（固定参考表）</summary><div class="card-body mg-table-wrap"><table class="table"><thead><tr><th>成本项目 USD</th><th>B 原仓逐单专业直达</th><th>D 前置 + 当地交付</th></tr></thead><tbody>${costLines.map(r => `<tr><td>${r[0]}</td><td>${money(r[1])}${r[0] === '本地专业末端' ? '（含在直达价）' : ''}</td><td>${money(r[2])}</td></tr>`).join('')}<tr><td><b>奖励前总成本</b></td><td><b>$4,920.00</b></td><td><b>$3,980.00</b></td></tr><tr><td>客户 SaaS + 人工 + 供应商奖励</td><td>—</td><td>$70 + $20 + $80 = $170</td></tr><tr><td><b>预计净留存</b></td><td colspan="2"><b>$4,920 − $3,980 − $170 = $770</b></td></tr></tbody></table><p class="mg-muted">本固定参考表不会随情景输入改变；修改预算后以保存的情景总额为准。免费期算例：8 台期内出库、2 台各超期 10 日 × $2 = $40；取消或失败不被删除出账。</p></div></details>` +
      card('逐机权益台账', `<div class="mg-table-wrap"><table class="table"><thead><tr><th>设备 / 订单</th><th>规则与期间</th><th>计算 / 金额</th><th>资格证据 / 批准</th><th>状态</th><th>动作</th></tr></thead><tbody>${H.state.benefits.map(b => `<tr><td><b>${e(b.serial)}</b><small>${e(b.orderId)}</small></td><td>${e(b.days)} 天 SaaS<small>${e(b.period)} / ${e(b.rule)}</small></td><td>${money(b.monthly)} ÷ ${b.billingDays} × ${b.days}<small><b>${money(b.amount)}</b> · POS/SIM 不变</small></td><td>${e(b.evidence)}<small>${e(b.approver)} / ${money(b.budget)} 批准预算</small></td><td>${pill(b.status)}</td><td>${b.status !== '已模拟核销' ? `<button class="btn" data-benefit-redeem="${e(b.id)}">模拟核销</button>` : e(b.invoice || '已留记录')}</td></tr>`).join('') || '<tr><td colspan="6">尚无权益记录。预算情景不会自动给设备发放权益。</td></tr>'}</tbody></table></div><div class="mg-footnote">同序列号 × 同账期只允许一笔有效奖励，重复登记会被拦截。核销为演示，不调用 SaaS 账单接口。已赚取权益不因承运延误、货损报告或索赔而撤销。</div>`, '<span class="mg-muted">与上方预算情景独立，不自动入账</span>');
  };
  function parseCostForm(fd) {
    const c = {}; for (const key of ['baseline', 'proposed', 'saas', 'labor', 'bonus', 'unsettled']) c[key] = number(fd, key);
    for (const key of ['completed', 'failed', 'cancelled']) c[key] = number(fd, key, 0, true);
    c.scope = required(fd, 'scope'); costScenario(c); return c;
  }
  function benefitAdd() {
    H.modal('登记已批准 SaaS 权益（演示）', `<div class="notice">每台按合同 SaaS 日价计算。先有资格证据和预算，再登记；本操作不实际减免账单。</div><div class="grid cols-2">${select('对应设备订单', 'orderId', H.state.orders.map(o => ({ value: o.id, label: `${o.id} / ${o.serial}` })), H.state.orders[0].id)}${H.field('账期 YYYY-MM', 'period', '2026-10', 'month', 'required')}${select('获奖天数', 'days', [7, 14, 30], 14)}${H.field('合同 SaaS 月价 USD / 台', 'monthly', 15, 'number', 'min="0" step="0.01" required')}${H.field('合同折算账期天数', 'billingDays', 30, 'number', 'min="1" max="366" step="1" required')}${H.field('本笔已批准预算 USD', 'budget', 7, 'number', 'min="0" step="0.01" required')}${select('资格规则', 'rule', ['资料前置', '弹性日期合单', '同点多机例外'], '弹性日期合单')}${H.field('资格及节省 / 试点预算证据', 'evidence', '', 'text', 'required')}${H.field('批准人', 'approver', '', 'text', 'required')}${H.field('规则版本', 'ruleVersion', 'V5-TRIAL-1', 'text', 'required')}</div><p class="mg-muted">30 天例外需额外收益与批准预算。此处单笔预算仍受项目共同激励预算约束；上方情景不自动给本台账拨款。</p>`, fd => {
      const order = H.order(fd.get('orderId')); if (!order?.serial) throw new Error('订单缺少设备序列号');
      const period = required(fd, 'period'); if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('账期格式应为 YYYY-MM');
      const key = `${order.serial}|${period}`; if (H.state.benefits.some(x => x.key === key)) throw new Error('该序列号在此账期已有权益，禁止重复发放');
      const days = number(fd, 'days', 1, true), monthly = number(fd, 'monthly'), billingDays = number(fd, 'billingDays', 1, true), budget = number(fd, 'budget');
      const amount = Math.round(monthly / billingDays * days * 100) / 100;
      if (amount > budget + 1e-8) throw new Error(`本笔让利 ${money(amount)} 超过批准预算 ${money(budget)}`);
      if (days === 30 && fd.get('rule') !== '同点多机例外') throw new Error('30 天档位须选择已批准的例外规则');
      const b = { id: 'BEN-' + Date.now().toString(36).toUpperCase(), key, orderId: order.id, serial: order.serial, period, days, monthly, billingDays, amount, budget, rule: fd.get('rule'), evidence: required(fd, 'evidence'), approver: required(fd, 'approver'), ruleVersion: required(fd, 'ruleVersion'), status: '已批准 · 待核销', date: H.state.demoDate };
      H.state.benefits.push(b); H.save('登记批准权益', b.id, key + ' ' + money(amount)); H.toast('权益已登记，未调用真实账单接口。');
    });
  }
  H.mounts.cost = function () {
    const form = H.$('#mg-cost-form');
    form.oninput = () => { try { H.$('#mg-cost-live').innerHTML = costTiles(parseCostForm(new FormData(form))); } catch (err) { H.$('#mg-cost-live').innerHTML = `<div class="notice mg-danger">${e(err.message)}。未保存。</div>`; } };
    form.onsubmit = ev => { ev.preventDefault(); try { H.state.cost = parseCostForm(new FormData(form)); H.save('保存成本情景', 'COST', H.state.cost.scope); H.toast('预算测算已保存。'); H.render(); } catch (err) { H.toast(err.message); } };
    H.$('#mg-cost-reset').onclick = () => { const c = { baseline: 4920, proposed: 3980, saas: 70, labor: 20, bonus: 80, unsettled: 160, completed: 10, failed: 0, cancelled: 0, scope: '10 台 / 30 日 / L3 + 拆包清运' }; for (const [k, v] of Object.entries(c)) form.elements[k].value = v; form.oninput(); H.toast('已填入参考值，点击保存测算后持久化。'); };
    H.$('#mg-benefit-add').onclick = benefitAdd;
    H.$('#mg-cost-export').onclick = () => { const c = H.state.cost, s = costScenario(c); H.csv('HAHA-V7-成本与权益.csv', [['类别', '字段 / ID', '数值 / 金额', '说明'], ...Object.entries(c).map(([k, v]) => ['预算情景', k, v, '演算数据；未结预留已在候选总额内']), ['预算结果', '共同激励上限', s.cap, '奖励前节省×20%'], ['预算结果', '共同激励合计', s.incentive, '客户SaaS+人工+供应商'], ['预算结果', '预计净留存', s.retained, '非实际已结收益'], ...H.state.benefits.map(b => ['权益演示台账', b.id, b.amount, `${b.serial} / ${b.period} / ${b.status}`])]); };
    H.$$('[data-benefit-redeem]').forEach(btn => btn.onclick = () => { const b = H.state.benefits.find(x => x.id === btn.dataset.benefitRedeem); H.modal('模拟核销 · ' + b.id, `<p>金额 ${money(b.amount)}，设备 ${e(b.serial)}。不会修改真实 SaaS 账单。</p>${H.field('账单 / 贷项凭证编号', 'invoice', '', 'text', 'required')}${H.field('核销人', 'operator', '', 'text', 'required')}`, fd => { if (b.status === '已模拟核销') throw new Error('已核销，重复请求被阻止'); b.invoice = required(fd, 'invoice'); b.operator = required(fd, 'operator'); b.status = '已模拟核销'; b.redeemedAt = new Date().toISOString(); H.save('模拟权益核销', b.id, b.invoice); H.toast('模拟核销完成；重复核销已锁止。'); }); });
  };
})(typeof window !== 'undefined' ? window : null);
