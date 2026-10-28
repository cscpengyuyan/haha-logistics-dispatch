/* HAHA V8: clear workflow, persistent local workspace and UTC scheduling. */
(function () {
  'use strict';
  const H = window.HH;
  const D = { state:'',city:'',query:'',range:'7',endpoint:'',path:'',status:'',selected:new Set(['H26001','H26002','H26004','H26012']),warehouse:'WH-DFW',vehicle:'V-01',supplier:'SP-01',date:'2026-10-28',start:'08:00',mode:'draft',factor:1.28,speed:45,handling:25,buffer:10,breakMins:30,basemap:'road',paintState:null,paintBase:null,depotKey:'',labelsKey:'',sig:new Map(),result:null,map:null,layers:{},markers:new Map(),visible:{orders:true,warehouses:true,suppliers:false,cities:true,labels:true},tab:'route',mobile:'queue',scope:'local',detail:null,view:null,initial:true,busy:false,selectBox:false };
  const MAP_STORE='haha-v8-map';
  const PARAM_LIMITS={factor:[1,2],speed:[15,90],handling:[0,120],buffer:[0,120],breakMins:[0,120]};
  const rad = x => x * Math.PI / 180;
  const haversine = (a, b) => { const p = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(p), Math.sqrt(Math.max(0, 1 - p))); };
  const minute = value => { const m = /^(\d{2}):(\d{2})$/.exec(String(value)); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : NaN; };
  const rounded = n => Math.round(n * 100) / 100;
  const duration = n => `${Math.floor(n / 60)}h ${Math.round(n % 60)}m`;
  const activeBatch = b => b.mode !== 'draft' && b.status !== '预排草案' && !['取消', '已取消', 'CANCELLED', '完成'].includes(b.status);
  const staleBatch = b => b.invalidated || (b.orderIds || []).some(id => !H.order(id) || H.order(id).version !== b.versions?.[id]);
  function gate(order, input) {
    const { state, origin, vehicle, supplier, config } = input;
    const errors = [];
    const model = state.models.find(m => m.id === order.model);
    if (!model) return ['型号档案缺失'];
    if (['l','w','h','kg'].some(k=>!Number.isFinite(model[k])||model[k]<=0)) errors.push('完整包装的尺寸/重量资料无效');
    if (!Number.isFinite(Number(H.services?.duration(order) ?? order.serviceMins)) || Number(H.services?.duration(order) ?? order.serviceMins)<=0) errors.push('现场作业时长缺失');
    if (order.status === '物理交付完成') errors.push('物流已完成，不重复排车');
    if (order.warehouse !== origin.id) errors.push('库存不在本批次出发仓，须先建调拨段');


    if (order.appointment !== '已确认') errors.push('客户预约未确认');
    if (order.appointmentVersion && order.appointmentVersion !== order.version) errors.push('预约确认不属于当前订单版本');
    if (!Number.isFinite(order.windowStart) || !Number.isFinite(order.windowEnd) || order.windowStart < 0 || order.windowStart >= 1440 || order.windowEnd < 0 || order.windowEnd >= 1440 || (order.windowStart === order.windowEnd && !order.windowEndDate)) errors.push('有效当地收货时间窗缺失');
    if (!(Number(order.qty) > 0) || !Number.isFinite(Number(order.qty))) errors.push('设备数量无效');
    if (!Number.isFinite(order.lat) || !Number.isFinite(order.lng) || Math.abs(order.lat)>90 || Math.abs(order.lng)>180 || order.geocodeStatus === '待核验') errors.push('定位待人工核验');
    if (!order.checks?.site) errors.push('现场与包装能力未核验');
    if (!order.checks?.provider) errors.push('实际执行方未承接当前版本');
    if (!order.checks?.budget) errors.push('费用权限待批准');
    if (!order.checks?.inventory) errors.push('库存锁定证据缺失');
    if (order.path?.startsWith('C') && !order.checks?.station) errors.push('C 路径缺专业站点接收确认');
    if (order.path === 'A' && (order.endpoint === 'L3' || order.L4)) errors.push('A 路径不能替代专业室内或特殊搬运');
    const inv = state.inventory.find(x => x.serial === order.serial);
    if (!inv || inv.status !== '锁定' || inv.orderId !== order.id || inv.warehouse !== origin.id) errors.push('序列号与订单/仓点锁定关系无效');
    if (state.orders.some(x => x.id !== order.id && x.serial === order.serial && x.status !== '物理交付完成')) errors.push('序列号存在重复分配');
    if (state.batches.some(b => activeBatch(b) && (b.orderIds || []).includes(order.id))) errors.push('订单已在有效模拟批次中');
    if (vehicle.warehouse !== origin.id) errors.push('该车组尚未配置在本仓');
    if (['doorHeight','liftW','liftD','liftKg','capacityKg','capacityUnits','crew','shiftMinutes'].some(k=>!Number.isFinite(vehicle[k])||vehicle[k]<=0) || ['door','liftW','liftD','liftKg','crew','capacity'].some(k=>!Number.isFinite(supplier[k])||supplier[k]<=0)) errors.push('车组/供应商的尺寸、载荷或工时能力资料不完整');
    if (model.h > Math.min(vehicle.doorHeight, supplier.door)) errors.push(`包装高 ${model.h} cm 超过车组/供应商可用门高`);
    const liftW = Math.min(vehicle.liftW, supplier.liftW), liftD = Math.min(vehicle.liftD, supplier.liftD);
    if (!(model.l <= liftW && model.w <= liftD)) errors.push(`包装底面 ${model.l} × ${model.w} cm 不满足尾板有效面积（不假定旋转可行）`);
    if (model.kg + 100 > Math.min(vehicle.liftKg, supplier.liftKg)) errors.push('单台设备 + 100 kg 工具/人员情景载荷超过尾板能力');
    if (order.endpoint === 'L3' && (vehicle.crew < 2 || supplier.crew < 2 || !supplier.types.includes('T2'))) errors.push('缺已核验专业室内交付车组');
    if (order.L4 && (!vehicle.L4 || !supplier.types.includes('T4'))) errors.push('特殊通道缺 T4 能力/对应车组');
    // Match management.js procurement scopes: A buys T1; B/C physical last-mile buys T2;
    // L4 adds T4, while L5 is a separate technical work order. A paused capability
    // must not suspend unrelated, still-verified capabilities of the same company.
    const requiredTypes = H.services?.requiredTypes(order) || [order.path === 'A' ? 'T1' : 'T2', ...(order.L4 ? ['T4'] : [])];
    requiredTypes.forEach(type => { if (!(supplier.types || []).includes(type)) errors.push(`本次采购缺少 ${type} 能力`); if ((supplier.pausedTypes || []).includes(type)) errors.push(`本次采购所需 ${type} 能力已暂停`); });
    if (!supplier.models.includes(order.model)) errors.push('供应商未准入本型号');
    if (!supplier.zips.includes(order.zip)) errors.push('供应商未准入该 ZIP，不以覆盖半径代替确认');
    if (!supplier.endpoints.includes(order.endpoint)) errors.push('供应商未承接该交付终点');
    if (!String(supplier.status || '').includes('已核验') && supplier.status !== '部分能力暂停') errors.push('供应商主体尚未完成有效核验');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(supplier.expiry||'') || supplier.expiry < order.date) errors.push('供应商凭证/能力有效期不覆盖出车日');
    return [...new Set(errors)].filter(reason => config.mode !== 'draft' || !['客户预约未确认','预约确认不属于当前订单版本','现场与包装能力未核验','实际执行方未承接当前版本','费用权限待批准','库存锁定证据缺失','C 路径缺专业站点接收确认','序列号与订单/仓点锁定关系无效'].includes(reason));
  }
  const service = o => Number(H.services?.duration(o) ?? o.serviceMins);
  function solve(state,ids,config){
    const origin=state.warehouses.find(x=>x.id===config.warehouse),vehicle=state.vehicles.find(x=>x.id===config.vehicle),supplier=state.suppliers.find(x=>x.id===config.supplier);
    const r={orderIds:[],stops:[],rejected:[],pending:[],warnings:[],cost:0,baseline:0,saved:0,distanceKm:0,duration:0,weightKg:0,units:0,iterations:0,bounded:false,config:{...config},source:'OFFLINE_SCENARIO',mode:config.mode||'validated'};
    if(!origin||!vehicle||!supplier||!Number.isFinite(minute(config.start))||!config.date||!Number.isFinite(+config.factor)||+config.factor<1||+config.factor>2||!Number.isFinite(+config.speed)||+config.speed<15||+config.speed>90||['handling','buffer','breakMins'].some(k=>!Number.isFinite(+config[k])||+config[k]<0||+config[k]>120)){r.error='请设置有效起仓、车组、供应商及估算参数。';return r;}
    if(/待验证/.test(origin.type)){r.error='候选仓尚未验证，不能作为配送起仓。';return r;}
    if(state.batches.some(b=>activeBatch(b)&&b.date===config.date&&b.vehicleId===vehicle.id)){r.error='同一车组在该作业日已有有效模拟批次；先撤销旧批次或另选车组。';return r;}
    let begin;try{r.departureUTC=H.tz.wallToUTC(config.date,config.start,origin.timezone,config.departureDisambiguation||'reject');begin=Date.parse(r.departureUTC)/60000;}catch(err){r.error='起仓时间无效或夏令时存在歧义：'+err.message;return r;}
    r.timezone=origin.timezone;const iso=n=>new Date(n*60000).toISOString(),localMinute=(n,tz)=>{const p=H.tz.parts(iso(n),tz);return p.hour*60+p.minute;};
    const distance=(a,b)=>haversine(a,b)* +config.factor,travel=(a,b)=>Math.ceil(distance(a,b)/+config.speed*60),price=(km,mins)=>vehicle.costFixed+km*vehicle.costKm+mins/60*vehicle.costHour;
    const windows={},candidates=[],input={state,origin,vehicle,supplier,config};
    [...new Set(ids)].forEach(id=>{const o=state.orders.find(x=>x.id===id);if(!o){r.rejected.push({id,reasons:['订单已不存在']});return;}const reasons=gate(o,input);try{const win=H.tz.window(o);windows[id]={start:Date.parse(win.start)/60000,end:Date.parse(win.end)/60000};}catch(err){reasons.push('客户当地时间无效或夏令时歧义：'+err.message);}if(reasons.length)r.rejected.push({id,reasons});else{candidates.push(o);const pending=gate(o,{...input,config:{...config,mode:'validated'}});if(pending.length)r.pending.push({id,reasons:pending});}});
    const cap=Math.min(vehicle.capacityUnits,supplier.capacity),prep=+config.handling+ +config.breakMins;
    function evaluate(seq){r.iterations++;let current=begin+prep,last=origin,km=0,weight=0,units=0;const stops=[];for(const o of seq){const m=state.models.find(x=>x.id===o.model);weight+=m.kg*Number(o.qty);units+=Number(o.qty);if(weight>vehicle.capacityKg||units>cap)return {ok:false,reason:'合计载重或设备台数超过车组/供应商上限',id:o.id};const leg=distance(last,o),arrive=current+travel(last,o),start=Math.max(arrive,windows[o.id].start),finish=start+service(o)+ +config.buffer;if(finish>windows[o.id].end)return {ok:false,reason:'无法在客户当地收货窗内完成作业',id:o.id};if(finish+travel(o,origin)-begin>vehicle.shiftMinutes)return {ok:false,reason:'往返、等待与作业超过本班次工时',id:o.id};stops.push({id:o.id,version:o.version,serial:o.serial,arrival:localMinute(arrive,o.timeZone),start:localMinute(start,o.timeZone),finish:localMinute(finish,o.timeZone),arrivalUTC:iso(arrive),startUTC:iso(start),finishUTC:iso(finish),timeZone:o.timeZone,wait:start-arrive,service:service(o),buffer:+config.buffer,legKm:rounded(leg),lat:o.lat,lng:o.lng});km+=leg;current=finish;last=o;}const end=seq.length?current+travel(last,origin):begin;km+=seq.length?distance(last,origin):0;return {ok:true,route:seq,stops,km,end,weight,units,cost:seq.length?price(km,end-begin):0};}
    let best=evaluate([]),left=candidates.slice();
    if(config.fixedOrder){const seq=[...new Set(config.fixedOrder)].map(id=>candidates.find(o=>o.id===id)).filter(Boolean),trial=evaluate(seq);if(!trial.ok){r.error=`手动顺序不可行：${trial.id} · ${trial.reason}。请调整顺序或重新优化。`;r.manualConflict=trial;return r;}best=trial;left=candidates.filter(o=>!seq.includes(o));}
    else while(left.length&&best.route.length<24){let next=null,chosen=null;for(const o of left)for(let i=0;i<=best.route.length;i++){const seq=best.route.slice();seq.splice(i,0,o);const trial=evaluate(seq);if(trial.ok&&(!next||trial.cost<next.cost)){next=trial;chosen=o;}}if(!next)break;best=next;left=left.filter(o=>o!==chosen);}
    r.orderIds=best.stops.map(s=>s.id);r.stops=best.stops;r.distanceKm=rounded(best.km);r.duration=best.stops.length?best.end-begin:0;r.cost=rounded(best.cost);r.returnUTC=iso(best.end);r.returnTime=localMinute(best.end,origin.timezone);r.weightKg=best.weight;r.units=best.units;
    for(const o of best.route){const km=distance(origin,o),tm=travel(origin,o),depart=Math.max(begin,windows[o.id].start-tm-prep),finish=Math.max(depart+prep+tm,windows[o.id].start)+service(o)+ +config.buffer;r.baseline+=price(km*2,finish+tm-depart);}r.baseline=rounded(r.baseline);r.saved=rounded(r.baseline-r.cost);
    left.forEach(o=>{const one=evaluate([o]);r.rejected.push({id:o.id,reasons:[one.ok?'与已排单的时间窗或合计容量冲突；可另建批次':one.reason]});});r.pending=r.pending.filter(p=>r.orderIds.includes(p.id));
    if(best.route.length===24&&left.length){r.bounded=true;r.warnings.push('单批最多 24 个停靠点；其余请分批。');}
    if(best.route.some(o=>o.timeZone!==origin.timezone))r.warnings.push('跨时区按 UTC 实际经过时长计算；每站显示客户当地时间，回仓显示起仓时间。');
    if(best.route.some(o=>o.L5))r.warnings.push('独立技术服务需另建工单和验收，不计入本次物理配送时间。');
    r.warnings.push('可行插入启发式，不保证全局最优。球面距离 × 绕行系数，未含道路限高限重和交通，不可用于导航或到场承诺。');return r;
  }
  H.dispatchEngine={solve,gate,haversine,minute,activeBatch};
  const e=v=>H.e(v),option=(v,t,s)=>`<option value="${e(v)}" ${v===s?'selected':''}>${e(t)}</option>`;
  const CONFIG_KEYS=['warehouse','vehicle','supplier','date','start','factor','speed','handling','buffer','breakMins','mode'];
  const config=()=>Object.fromEntries(CONFIG_KEYS.map(k=>[k,D[k]]));
  const fingerprint=()=>JSON.stringify({c:config(),ids:[...D.selected],orders:H.state.orders,inventory:H.state.inventory,suppliers:H.state.suppliers,vehicles:H.state.vehicles,warehouses:H.state.warehouses,batches:H.state.batches});
  function zone(tz,date){try{return new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'short'}).formatToParts(new Date(date+'T12:00:00Z')).find(p=>p.type==='timeZoneName').value;}catch{return tz;}}
  function time(iso,tz){try{return H.tz.format(iso,tz);}catch{return '时间待核验';}}
  function auxiliary(iso){const tz=H.state.settings.viewZone==='UTC'?'UTC':'Asia/Shanghai';return time(iso,tz)+(tz==='UTC'?'':' · 北京');}
  function win(o){try{const w=H.tz.window(o);return {main:`${o.date.slice(5)} ${H.time(o.windowStart)}–${H.time(o.windowEnd)} ${zone(o.timeZone,o.date)}${o.windowEndDate&&o.windowEndDate!==o.date?' +跨日':''}`,sub:auxiliary(w.start)+' 起'};}catch{return {main:'当地时间待核验',sub:o.timeZone};}}
  function assigned(o){return H.state.batches.find(b=>activeBatch(b)&&(b.orderIds||[]).includes(o.id));}
  function readiness(o){if(o.status==='物理交付完成')return {label:'已交付',kind:'done'};if(assigned(o))return {label:'已排批次',kind:'assigned'};const a=H.releaseIssues(o);return a.length?{label:`待补 ${a.length} 项`,kind:'pending'}:{label:'可复核',kind:'ready'};}
  function baseOrders(){const end=H.addDays(D.date,Number(D.range)-1),q=D.query.toLowerCase();return H.state.orders.filter(o=>Number.isFinite(o.lat)&&Number.isFinite(o.lng)&&(!D.range||o.date>=D.date&&o.date<=end)&&(!D.endpoint||(D.endpoint==='L4'||D.endpoint==='L5'?o[D.endpoint]:o.endpoint===D.endpoint))&&(!D.path||o.path===D.path)&&(!q||[o.id,o.customer,o.city,o.zip,o.model,o.state].join(' ').toLowerCase().includes(q))&&(!D.status||readiness(o).kind===D.status));}
  function scopedOrders(){return baseOrders().filter(o=>D.scope==='national'||o.warehouse===D.warehouse);}
  function visibleOrders(){return scopedOrders().filter(o=>(!D.state||o.state===D.state)&&(!D.city||o.city===D.city));}
  function cities(){const groups={};scopedOrders().filter(o=>!D.state||o.state===D.state).forEach(o=>{(groups[o.city+' · '+o.state]||=[]).push(o);});return Object.entries(groups).sort((a,b)=>b[1].length-a[1].length);}
  function rememberSoon(){clearTimeout(D.rememberTimer);D.rememberTimer=setTimeout(remember,220);}
  function remember(){
    try{sessionStorage.setItem(MAP_STORE,JSON.stringify({...config(),state:D.state,city:D.city,range:D.range,endpoint:D.endpoint,path:D.path,status:D.status,query:D.query,selected:[...D.selected],view:D.view,tab:D.tab,mobile:D.mobile,scope:D.scope,detail:D.detail,basemap:D.basemap,visible:D.visible}));}catch{/* Keep the current session usable if browser storage is unavailable. */}
  }
  function syncResources(){
    if(!H.state.warehouses.some(w=>w.id===D.warehouse&&!/待验证/.test(w.type)))D.warehouse=H.state.warehouses.find(w=>!/待验证/.test(w.type))?.id||'';
    const vs=H.state.vehicles.filter(v=>v.warehouse===D.warehouse);if(!vs.some(v=>v.id===D.vehicle))D.vehicle=vs[0]?.id||'';
    if(!H.state.suppliers.some(s=>s.id===D.supplier))D.supplier=H.state.suppliers.find(s=>(s.types||[]).includes('T2'))?.id||'';
  }
  function restore(){
    if(!D.initial)return;D.initial=false;
    try{const x=JSON.parse(sessionStorage.getItem(MAP_STORE));if(x&&typeof x==='object'&&!Array.isArray(x)){
      for(const k of ['warehouse','vehicle','supplier','state','city','query'])if(typeof x[k]==='string')D[k]=x[k];
      if(/^\d{4}-\d{2}-\d{2}$/.test(x.date||'')&&!Number.isNaN(Date.parse(x.date+'T12:00:00Z')))D.date=x.date;
      if(Number.isFinite(minute(x.start)))D.start=x.start;
      const choices={mode:['draft','validated'],range:['','1','7','30'],endpoint:['','L1','L2','L3','L4','L5'],path:['','A','B','C1','C2'],status:['','ready','pending','assigned','done'],tab:['route','detail','batches'],mobile:['queue','map','plan'],scope:['local','national'],basemap:['offline','road','satellite','custom']};
      for(const [k,allowed]of Object.entries(choices))if(allowed.includes(x[k]))D[k]=x[k];
      for(const [k,[min,max]]of Object.entries(PARAM_LIMITS)){const n=Number(x[k]);if(x[k]!==null&&x[k]!==''&&Number.isFinite(n)&&n>=min&&n<=max)D[k]=n;}
      if(Array.isArray(x.selected))D.selected=new Set(x.selected.filter(id=>typeof id==='string'&&H.order(id)));
      if(typeof x.detail==='string'&&H.order(x.detail))D.detail=x.detail;
      if(x.visible&&typeof x.visible==='object')for(const k of Object.keys(D.visible))if(typeof x.visible[k]==='boolean')D.visible[k]=x.visible[k];
      if(Array.isArray(x.view?.center)&&x.view.center.length===2&&x.view.center.every(Number.isFinite)&&Math.abs(x.view.center[0])<=90&&Math.abs(x.view.center[1])<=180&&Number.isFinite(x.view.zoom)&&x.view.zoom>=3&&x.view.zoom<=16)D.view=x.view;
    }}catch{/* Malformed saved view data cannot block the workbench. */}
    syncResources();
  }
  function serviceLabel(o){return [({L1:'路边交接',L2:'门口交接',L3:'室内就位'})[o.endpoint]||o.endpoint,o.L4?'特殊搬运':'',o.L5?'技术服务另派':''].filter(Boolean).join(' · ');}
  function workflowHTML(){
    const r=D.result,route=!!r?.stops.length&&!r.error,checked=route&&D.mode==='validated',step=!D.selected.size?1:!route?2:!checked?3:4;
    return [['选择订单',`${D.selected.size} 单已选`],['生成预排',route?`${r.stops.length} 单可排`:'核对时窗与运力'],['放行前校验',checked?`${r.rejected.length} 单未排`:'逐项补齐资料'],['保存批次','仅保存模拟记录']].map(([label,hint],i)=>`<div class="dx-step ${i+1<step?'done':i+1===step?'active':''}" ${i+1===step?'aria-current="step"':''}><span>${i+1<step?'✓':i+1}</span><div><b>${label}</b><small>${hint}</small></div></div>`).join('');
  }
  function renderActions(){
    const queuePlan=H.$('#dx-queue-plan');if(queuePlan)queuePlan.disabled=!D.selected.size;
    const flow=H.$('#dx-workflow');if(flow)flow.innerHTML=workflowHTML();const footer=H.$('#dx-plan-actions');if(!footer)return;
    const r=D.result,route=!!r?.stops.length&&!r.error;
    let hint=D.selected.size?`已选 ${D.selected.size} 单，按客户当地收货窗预排。`:'先在左侧选择本次配送订单。';
    let buttons=`<button class="dx-btn primary" data-action="plan" ${!D.selected.size||D.busy?'disabled':''}>${D.busy?'正在计算…':D.mode==='validated'?'运行放行前校验':'生成预排'}${!D.busy&&D.selected.size?' · '+D.selected.size+' 单':''}</button>`;
    if(route&&D.mode==='draft'){hint=`预排 ${r.stops.length} 单${r.pending.length?' · '+r.pending.length+' 单待补资料':''}${r.rejected.length?' · '+r.rejected.length+' 单未排':''}`;buttons='<button class="dx-btn" data-action="save">保存草案</button><button class="dx-btn primary" data-action="validate">放行前校验 →</button>';}
    else if(route){hint=`${r.stops.length} 单通过本次校验${r.rejected.length?' · '+r.rejected.length+' 单未排':''}；保存前再次核验。`;buttons=`<button class="dx-btn" data-action="plan">重新校验</button><button class="dx-btn primary" data-action="save">保存 ${r.stops.length} 单模拟批次</button>`;}
    else if(r?.error||r?.rejected.length)hint='请先处理未排原因，再重新计算。';
    footer.innerHTML=`<div class="dx-action-hint" role="status" aria-live="polite">${e(hint)}</div><div class="dx-action-buttons">${buttons}</div><small>预排与校验均为演示，不发送真实派车指令。</small>`;
    const btn=H.$('.dx-toolbar [data-action="plan"]');if(btn){btn.disabled=D.busy||!D.selected.size;btn.textContent=D.busy?'正在计算…':D.mode==='validated'?'重新校验':'生成预排';}
  }
  H.pages.dispatch=()=>{
    restore();if(D.result&&D.fingerprint!==fingerprint())D.result=null;
    return `<section class="dx" aria-label="地图调度工作台">
      <header class="dx-toolbar"><div class="dx-brand"><span>HAHA LOGISTICS</span><h1>调度工作台</h1></div><label class="dx-date">客户当地日期<input type="date" data-filter="date" value="${e(D.date)}" aria-label="调度筛选日期"></label><select data-filter="range" aria-label="日期范围">${[['1','当日'],['7','未来 7 天'],['30','未来 30 天'],['','全部日期']].map(([v,t])=>option(v,t,D.range)).join('')}</select><select data-filter="endpoint" aria-label="服务筛选">${[['','全部服务'],['L1','路边交接'],['L2','门口交接'],['L3','室内就位'],['L4','特殊搬运'],['L5','技术服务']].map(([v,t])=>option(v,t,D.endpoint)).join('')}</select><select data-filter="path" aria-label="履约模式">${['','A','B','C1','C2'].map(v=>option(v,v?`${v} 履约`:'全部履约',D.path)).join('')}</select><div class="dx-toolbar-end"><button class="dx-btn" data-action="help">操作说明</button><button class="dx-btn primary" data-action="plan">生成预排</button></div></header>
      <div id="dx-workflow" class="dx-workflow" aria-label="调度流程">${workflowHTML()}</div>
      <nav class="dx-mobile-tabs" aria-label="调度视图">${[['queue','订单'],['map','地图'],['plan','计划']].map(([v,t])=>`<button data-mobile="${v}" class="${D.mobile===v?'active':''}" aria-pressed="${D.mobile===v}">${t}</button>`).join('')}</nav>
      <div class="dx-body" data-mobile-view="${D.mobile}"><aside class="dx-queue" aria-label="配送任务列表"><div class="dx-panel-head"><div><strong>配送任务</strong><span id="dx-queue-count"></span></div><button class="dx-icon" data-action="collapse-queue" aria-label="收起订单面板">‹</button></div><div class="dx-search"><input type="search" data-filter="query" value="${e(D.query)}" placeholder="订单、客户、城市、ZIP" aria-label="搜索调度订单"></div><div class="dx-queue-filter"><select data-filter="status" aria-label="任务状态">${[['','所有状态'],['ready','可复核'],['pending','待补资料'],['assigned','已排批次'],['done','已交付']].map(([v,t])=>option(v,t,D.status)).join('')}</select><button data-action="select-visible">全选</button><button data-action="clear">清空</button></div><div class="dx-city-chips" id="dx-city-chips"></div><div class="dx-order-list" id="dx-order-list"></div><div class="dx-queue-foot"><span id="dx-selected-count"></span><button data-action="select-origin">选本仓任务</button><button id="dx-queue-plan" class="dx-btn primary dx-queue-next" data-mobile="plan" ${D.selected.size?'':'disabled'}>查看计划 →</button></div></aside>
        <div class="dx-map-panel"><div class="dx-map-tools"><div class="dx-region-switch" role="group" aria-label="地图区域"><button data-action="local">出发仓区域</button><button data-action="national">全国仓网</button></div><div class="dx-map-buttons"><button class="dx-btn" data-action="expand-queue">订单</button><button class="dx-btn" data-action="select-box" id="dx-box-toggle">框选</button><button class="dx-btn" data-action="fit">适配</button><button class="dx-btn" data-action="full">全屏</button><button class="dx-btn" data-action="layers" aria-expanded="false">图层</button><button class="dx-btn" data-action="expand-plan">计划</button></div></div><div id="dx-breadcrumb" class="dx-breadcrumb"></div>
          <div class="dx-map-wrap"><div id="dispatch-map" aria-label="当前配送区域与订单地图"></div><div class="dx-map-title"><i></i><div><strong id="dx-map-label"></strong><small id="dx-map-subtitle"></small></div></div><div id="dx-layers" class="dx-layer-panel" hidden><b>地图图层</b>${[['orders','订单与聚合'],['warehouses','仓点 / 站点'],['suppliers','供应商参考区域'],['cities','城市名称'],['labels','州订单数量']].map(([k,t])=>`<label><input type="checkbox" data-layer="${k}" ${D.visible[k]?'checked':''}>${t}</label>`).join('')}<div class="dx-basemaps" role="group" aria-label="底图"><button data-basemap="offline" class="${D.basemap==='offline'?'active':''}">离线</button><button data-basemap="road" class="${D.basemap==='road'?'active':''}">路网</button><button data-basemap="satellite" class="${D.basemap==='satellite'?'active':''}">卫星</button><button data-basemap="custom" class="${D.basemap==='custom'?'active':''}">自定义</button></div><small>在线底图连接失败自动回退离线。供应商参考区域不能代替 ZIP 与型号准入。</small></div><div id="dx-map-empty" class="dx-map-empty" hidden><b>当前区域无匹配任务</b><span>可调整筛选，或查看全国仓网。</span><button class="dx-btn" data-action="reset-filter">重置筛选</button></div></div>
          <div class="dx-map-legend"><span><i></i>可复核</span><span><i class="pending"></i>待补证</span><span><i class="selected"></i>已选</span><span><i class="warehouse"></i>仓点</span><p class="dx-map-note">虚线是估算连接，不是道路导航；未计入实时路况与货车限行。</p></div><footer class="dx-map-footer"><span id="dx-context"></span><button data-action="export-visible">导出当前任务</button></footer>
        </div>
        <aside class="dx-plan" aria-label="路线计划与校验"><div class="dx-panel-head"><div><strong>路线计划</strong><span id="dx-plan-state"></span></div><button class="dx-icon" data-action="collapse-plan" aria-label="收起路线面板">›</button></div><div class="dx-plan-tabs"><button data-tab="route">排程</button><button data-tab="detail">订单详情</button><button data-tab="batches">批次 <span id="dx-batch-count"></span></button></div><div id="dx-plan-content" class="dx-plan-content"></div><footer id="dx-plan-actions" class="dx-plan-actions"></footer></aside>
      </div><div class="dx-statusbar"><span>● 演示数据 · 本机保存</span><span>客户当地执行 · UTC 排程 · 北京协同</span></div></section>`;
  };
  function queueHTML(){return visibleOrders().map(o=>{const r=readiness(o),w=win(o),issues=H.releaseIssues(o),locked=r.kind==='done'||r.kind==='assigned';return `<article class="dx-order ${D.selected.has(o.id)?'selected':''} ${D.detail===o.id?'focused':''}"><div class="dx-order-top"><label class="dx-select-hit"><input type="checkbox" data-select="${e(o.id)}" ${D.selected.has(o.id)?'checked':''} ${locked&&!D.selected.has(o.id)?'disabled':''} aria-label="选择 ${e(o.id)}"></label><button data-order="${e(o.id)}">${e(o.id)}</button><span class="dx-badge ${r.kind}">${r.label}</span></div><button class="dx-order-main" data-order="${e(o.id)}"><b>${e(o.customer)}</b><span>${e(o.city)}, ${e(o.state)} <small>${e(o.zip)}</small></span></button><div class="dx-order-service"><span>${e(serviceLabel(o))}</span><span>${e(o.model)} × ${o.qty}</span><span>${service(o)} 分钟</span></div><div class="dx-order-time"><b>${e(w.main)}</b><small>${e(w.sub)}</small></div>${issues.length&&!locked?`<button class="dx-order-issue" data-review="${e(o.id)}"><span>${e(issues[0])}${issues.length>1?' 等 '+issues.length+' 项':''}</span><b>补齐资料 →</b></button>`:''}</article>`;}).join('')||'<div class="dx-empty"><b>没有匹配任务</b><p>调整日期、服务或区域筛选。</p><button class="dx-btn" data-action="reset-filter">重置筛选</button></div>';}

  function renderQueue(){const el=H.$('#dx-order-list'),scroll=el.scrollTop;el.innerHTML=queueHTML();el.scrollTop=scroll;H.$('#dx-queue-count').textContent=visibleOrders().length+' 单';H.$('#dx-selected-count').innerHTML=`<b>${D.selected.size}</b> 已选择${[...D.selected].some(id=>!visibleOrders().some(o=>o.id===id))?' · 含隐藏任务':''}`;H.$('#dx-city-chips').innerHTML=cities().slice(0,12).map(([key,os])=>`<button data-city="${e(os[0].city)}" data-state="${e(os[0].state)}" class="${D.city===os[0].city?'active':''}">${e(os[0].city)} <span>${os.length}</span></button>`).join('');}
  function departHint(){try{return auxiliary(H.tz.wallToUTC(D.date,D.start,H.warehouse(D.warehouse).timezone));}catch{return '时间不存在或重复，请核验';}}
  function configHTML(){const w=H.warehouse(D.warehouse);return `<div class="dx-config"><label>出发仓<select data-config="warehouse" aria-label="出发仓">${H.state.warehouses.filter(w=>!/待验证/.test(w.type)).map(w=>option(w.id,w.city+' · '+w.name,D.warehouse)).join('')}</select></label><label>车组<select data-config="vehicle" aria-label="车组">${H.state.vehicles.filter(v=>v.warehouse===D.warehouse).map(v=>option(v.id,`${v.name} · ${v.capacityUnits} 台`,D.vehicle)).join('')}</select></label><label>实际配送方<select data-config="supplier" aria-label="实际配送供应商">${H.state.suppliers.filter(s=>(s.types||[]).some(t=>['T1','T2'].includes(t))).map(s=>option(s.id,s.name,D.supplier)).join('')}</select></label><div class="dx-config-row"><label>起仓日期<input data-config="date" type="date" value="${D.date}" aria-label="起仓当地日期"></label><label>起仓时间<input data-config="start" type="time" value="${D.start}" aria-label="起仓当地时间"></label></div><p class="dx-local-clock">${e(w?.timezone)} · ${e(zone(w?.timezone,D.date))}<small>${e(departHint())}</small></p><div class="dx-mode-switch"><button data-mode="draft" class="${D.mode==='draft'?'active':''}">预排草案</button><button data-mode="validated" class="${D.mode==='validated'?'active':''}">放行前校验</button></div><div class="dx-config-actions"><button data-action="parameters">里程 / 工时参数</button><button data-action="resources">仓点与运力 ↗</button></div></div>`;}
  function renderResult(){const el=H.$('#dx-plan-result');if(el)el.innerHTML=summaryHTML();renderActions();}
  function applyConfig(){D.result=null;renderPlan();renderQueue();renderMap();rememberSoon();}
  function summaryHTML(){
    const r=D.result;if(!r)return `<div class="dx-idle"><span>下一步 · 生成预排</span><h3>让每一趟车都有明确计划</h3><p>已选 ${D.selected.size} 单。核对出发仓、车组和时间后，点击底部按钮计算。</p><small>预排会列出资料缺项，不预占订单或车辆。</small></div>`;
    if(r.error)return `<div class="dx-alert" role="status"><b>需要调整计划</b><p>${e(r.error)}</p></div>`;
    return `<div class="dx-result"><div class="dx-result-title"><b>${r.stops.length}<small> / ${D.selected.size} 单</small></b><span>${D.mode==='draft'?'预排结果':'校验结果'} · 估算</span></div><div class="dx-result-stats"><div><small>往返里程</small><b>${r.distanceKm.toFixed(1)} <em>km</em></b></div><div><small>班次占用</small><b>${duration(r.duration)}</b></div><div><small>设备 / 载重</small><b>${r.units} <em>台</em> / ${r.weightKg.toFixed(0)} <em>kg</em></b></div><div><small>合单成本</small><b>${H.money(r.cost)}</b></div></div><div class="dx-savings"><span>单独派送 ${H.money(r.baseline)}</span><b>情景差额 ${H.money(r.saved)}</b></div><div class="dx-result-buttons"><button class="dx-btn" data-action="export-route" ${r.stops.length?'':'disabled'}>导出计划</button><button class="dx-btn" data-action="parameters">调整估算参数</button></div><small class="dx-fine">仅计算已排订单。金额为情景参数，非真实报价。</small></div>${['pending','rejected'].map(key=>r[key].length?`<details class="dx-exceptions ${key}" open><summary>${key==='pending'?'已预排 · 待补资料':'未排任务'} · ${r[key].length} 单</summary>${r[key].map(p=>`<div><button data-review="${e(p.id)}">${e(p.id)} · 查看并处理 →</button><ul>${p.reasons.map(t=>`<li>${e(t)}</li>`).join('')}</ul></div>`).join('')}</details>`:'').join('')}${stopsHTML()}<details class="dx-method"><summary>估算方式与排程边界</summary>${r.warnings.map(t=>`<p>${e(t)}</p>`).join('')}</details>`;
  }
  function stopsHTML(){const r=D.result;if(!r?.stops.length)return '';return `<div class="dx-stops"><h3>停靠顺序 <small>拖动或 ↑↓ 后重新校验</small></h3><div class="dx-depot"><span>起</span><div><b>${e(H.warehouse(D.warehouse).city)}</b><small>${e(time(r.departureUTC,r.timezone))}</small></div></div>${r.stops.map((s,i)=>{const o=H.order(s.id);return `<article class="dx-stop" draggable="true" data-stop="${e(s.id)}"><span class="dx-stop-num">${i+1}</span><div class="dx-stop-body"><button data-order="${e(o.id)}">${e(o.city)} <small>${e(o.id)}</small></button><b>${e(time(s.startUTC,o.timeZone))}</b><small>完成 ${e(time(s.finishUTC,o.timeZone))}</small><small>${e(auxiliary(s.startUTC))}</small><span class="dx-stop-window">收货 ${e(win(o).main)}</span><span>${s.service} min 作业 · 等待 ${s.wait} min · ${s.legKm.toFixed(1)} km</span></div><div class="dx-stop-arrows"><button data-move="${e(s.id)}" data-step="-1" ${i===0?'disabled':''} aria-label="上移 ${e(s.id)}">↑</button><button data-move="${e(s.id)}" data-step="1" ${i===r.stops.length-1?'disabled':''} aria-label="下移 ${e(s.id)}">↓</button></div></article>`;}).join('')}<div class="dx-depot"><span>回</span><div><b>${e(H.warehouse(D.warehouse).city)} 回仓</b><small>${e(time(r.returnUTC,r.timezone))}</small><small>${e(auxiliary(r.returnUTC))}</small></div></div></div>`;}
  function detailHTML(){const o=H.order(D.detail);if(!o)return '<div class="dx-empty"><span>◎</span><h3>选中一个任务</h3><p>点击点位或订单号查看时区、服务与责任链。</p></div>';const w=win(o),issues=H.releaseIssues(o);return `<div class="dx-detail"><span>${e(o.id)} · v${o.version}</span><h2>${e(o.customer)}</h2><p>${e(o.city)}, ${e(o.state)} ${e(o.zip)}</p><div class="dx-detail-window"><span>客户当地收货窗</span><b>${e(w.main)}</b><small>${e(o.timeZone)}</small><small>${e(w.sub)}</small></div><dl>${[['出货仓',H.warehouse(o.warehouse)?.name],['设备',o.model+' × '+o.qty+' · '+o.serial],['履约 / 库存',o.path+' / '+(o.stockStrategy||'基础库存')],['服务明细',H.services?.summary(o)||o.endpoint],['同行作业时间',service(o)+' min'],['通知责任人',o.notificationOwner||'待指定'],['现场备注',o.notes||'待补充']].map(([a,b])=>`<div><dt>${a}</dt><dd>${e(b)}</dd></div>`).join('')}</dl><div class="dx-detail-actions"><button class="dx-btn primary" data-action="toggle-detail">${D.selected.has(o.id)?'移出本次选单':'加入本次选单'}</button><button class="dx-btn" data-action="service">配置服务分项</button><button class="dx-btn" data-action="order-edit">查看 / 核验订单</button></div><div class="dx-detail-gates"><b>放行缺项 ${issues.length}</b>${issues.length?`<ul>${issues.map(t=>`<li>${e(t)}</li>`).join('')}</ul>`:'<p>基础核验通过，仍需确认实际承接与执行。</p>'}</div></div>`;}
  function batchHTML(){return H.state.batches.length?H.state.batches.slice().reverse().map(b=>`<article class="dx-batch"><div><b>${e(b.id)}</b><span class="dx-badge ${b.status==='已取消'?'done':staleBatch(b)?'pending':'ready'}">${e(staleBatch(b)?'版本失效':b.status)}</span></div><p>${e(b.date)} · ${e(b.timezone||'')}</p><ol>${(b.orderIds||[]).map(id=>`<li>${e(id)} ${e(H.order(id)?.city||'')}</li>`).join('')}</ol><small>${Number(b.distanceKm||0).toFixed(1)} km · ${H.money(b.cost)}</small><div class="dx-batch-actions"><button class="dx-btn" data-batch-export="${e(b.id)}">导出</button>${b.status!=='已取消'?`<button class="dx-btn" data-batch-cancel="${e(b.id)}">撤销</button>`:''}</div><small>${b.mode==='draft'?'草案不预占车辆和订单，不是发车指令。':'有效模拟批次已占用本地订单和车组。'}</small></article>`).join(''):'<div class="dx-empty"><h3>尚无批次</h3><p>生成路线后保存计划，可在这里追踪与撤销。</p></div>';}
  function renderPlan(){
    const box=H.$('#dx-plan-content');if(!box)return;const scroll=box.scrollTop;box.innerHTML=D.tab==='detail'?detailHTML():D.tab==='batches'?batchHTML():`<details class="dx-config-wrap" ${D.result?'':'open'}><summary>出发仓与运力 · ${e(H.warehouse(D.warehouse)?.city||'待配置')}</summary>${configHTML()}</details><div id="dx-plan-result">${summaryHTML()}</div>`;box.scrollTop=scroll;
    H.$('#dx-plan-state').textContent=D.mode==='draft'?'预排草案':'放行前校验';H.$('#dx-batch-count').textContent=H.state.batches.length||'';H.$$('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===D.tab);b.setAttribute('aria-pressed',String(b.dataset.tab===D.tab));});renderActions();
  }
  function markerIcon(o){const i=D.result?.orderIds.indexOf(o.id)??-1;return L.divIcon({className:'dx-marker-wrap',html:`<div class="dx-marker ${D.selected.has(o.id)?'selected':readiness(o).kind} ${D.detail===o.id?'focused':''}">${i>=0?i+1:''}</div>`,iconSize:[26,26],iconAnchor:[13,13]});}
  function stateStyle(f){const n=baseOrders().filter(o=>o.state===f.properties.abbr).length,a=D.state===f.properties.abbr;if(D.basemap!=='offline')return {color:a?'#2864ed':'#ffffff',weight:a?2.2:.7,opacity:a?.95:.5,fillOpacity:0};return {color:a?'#2864ed':'#bdccdc',weight:a?2:.8,fillColor:n?'#b7ccef':'#e5ebf2',fillOpacity:(a?0.6:0.5)};}
  function initMap(){if(!window.L||!window.US_STATES){H.$('#dispatch-map').innerHTML='本地地图库缺失，请检查交付文件。';return;}const map=L.map('dispatch-map',{zoomControl:false,preferCanvas:true,minZoom:3,maxZoom:16,zoomSnap:.5,doubleClickZoom:false}).setView(D.view?.center||[H.warehouse(D.warehouse)?.lat||38,H.warehouse(D.warehouse)?.lng||-98],D.view?.zoom||9);D.map=map;H.currentMap=map;L.control.zoom({position:'bottomleft'}).addTo(map);L.control.scale({position:'bottomleft',imperial:true,metric:true}).addTo(map);map.attributionControl.addAttribution('V3.1 内置州界 · 合成业务数据');D.layers.states=L.geoJSON(US_STATES,{style:stateStyle,onEachFeature:(f,l)=>{l.on('click',()=>focusState(f.properties.abbr));l.bindTooltip(f.properties.name+' · 点击进入',{sticky:true});}}).addTo(map);D.layers.orders=L.markerClusterGroup?L.markerClusterGroup({maxClusterRadius:36,showCoverageOnHover:false,disableClusteringAtZoom:12,chunkedLoading:true,animate:false,iconCreateFunction:c=>L.divIcon({className:'dx-cluster-wrap',html:`<div class="dx-cluster">${c.getChildCount()}</div>`,iconSize:[38,38]})}):L.layerGroup();['warehouses','suppliers','cities','labels','route'].forEach(k=>D.layers[k]=L.layerGroup());Object.entries(D.visible).forEach(([k,on])=>{if(on)D.layers[k].addTo(map);});D.layers.route.addTo(map);H.basemap.onChange(info=>{D.basemap=info.kind;if(D.layers.states)D.layers.states.setStyle(stateStyle);H.$$('[data-basemap]').forEach(x=>x.classList.toggle('active',x.dataset.basemap===info.kind));renderContext();});H.basemap.autoStart(map,D.basemap);map.on('moveend zoomend',()=>{D.view={center:[map.getCenter().lat,map.getCenter().lng],zoom:map.getZoom()};renderLabels();remember();});map.on('mousedown',ev=>{if(!D.selectBox)return;L.DomEvent.stop(ev.originalEvent);D.boxStart=ev.latlng;map.dragging.disable();D.rectangle=L.rectangle([ev.latlng,ev.latlng],{color:'#2864ed',weight:1.5,fillOpacity:.13}).addTo(map);});map.on('mousemove',ev=>{if(D.rectangle)D.rectangle.setBounds([D.boxStart,ev.latlng]);});map.on('mouseup',()=>{if(!D.rectangle)return;const bounds=D.rectangle.getBounds(),os=visibleOrders().filter(o=>o.status!=='物理交付完成'&&!assigned(o)&&bounds.contains([o.lat,o.lng]));os.forEach(o=>D.selected.add(o.id));D.rectangle.remove();D.rectangle=null;D.boxStart=null;D.selectBox=false;map.dragging.enable();H.$('#dx-box-toggle').classList.remove('active');map.getContainer().classList.remove('dx-box-mode');invalidate();H.toast(`已框选 ${os.length} 票任务。`);});D.resizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>D.map?.invalidateSize({pan:false})):null;D.resizeObserver?.observe(H.$('.dx-map-wrap'));renderMap();if(!D.view){if(D.scope==='national')map.fitBounds([[24,-126],[50,-66]],{padding:[35,35]});else fitOrigin(false);}}
  function markerSig(o){const i=(D.result&&D.result.orderIds.indexOf(o.id))??-1;return (D.selected.has(o.id)?'1':'0')+(D.detail===o.id?'1':'0')+readiness(o).kind+':'+i;}
  function refreshMarkerStyles(){D.markers.forEach((m,id)=>{const o=H.order(id);if(!o)return;const s=markerSig(o);if(D.sig.get(id)!==s){m.setIcon(markerIcon(o));D.sig.set(id,s);}});}
  function buildDepots(){D.layers.warehouses.clearLayers();H.state.warehouses.forEach(w=>{L.marker([w.lat,w.lng],{icon:L.divIcon({className:'dx-depot-wrap',html:`<div class="dx-depot-marker ${w.id===D.warehouse?'active':''}"><svg viewBox="0 0 24 24"><path d="M3 10 12 4l9 6v10H3z M8 20v-8h8v8"></path></svg></div>`,iconSize:[32,32],iconAnchor:[16,16]})}).bindTooltip(`${e(w.name)}<br>${e(w.timezone)}`).on('click',()=>{if(/待验证/.test(w.type)){H.toast('候选节点未准入，不能作为起仓。');return;}chooseWarehouse(w.id);}).addTo(D.layers.warehouses);});D.layers.suppliers.clearLayers();H.state.suppliers.forEach(s=>{const w=H.state.warehouses.find(w=>w.id===s.warehouse||w.city===s.region||w.id==='WH-'+s.region);const lat=Number(s.lat??w?.lat),lng=Number(s.lng??w?.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return;L.circleMarker([lat+.035,lng+.035],{radius:7,color:'#7d62b3',weight:2,fillColor:'#d9d0ee',fillOpacity:1}).bindTooltip(`${e(s.name)}<br>参考区域，不代表ZIP准入`).addTo(D.layers.suppliers);});}
  function renderMap(){if(!D.map)return;if(D.paintState!==D.state||D.paintBase!==D.basemap){D.layers.states.setStyle(stateStyle);D.paintState=D.state;D.paintBase=D.basemap;}const rows=visibleOrders(),visible=new Set(rows.map(o=>o.id));for(const [id,m]of D.markers)if(!visible.has(id)){D.layers.orders.removeLayer(m);D.markers.delete(id);D.sig.delete(id);}for(const o of rows){let m=D.markers.get(o.id);const s=markerSig(o);if(!m){m=L.marker([o.lat,o.lng],{icon:markerIcon(o),title:o.id+' '+o.city});m.on('click',()=>showDetail(o.id));m.on('dblclick',()=>toggleSelection(o.id));m.bindTooltip(`${e(o.id)} · ${e(o.city)}<br>${e(win(o).main)}`,{direction:'top'});D.markers.set(o.id,m);D.sig.set(o.id,s);D.layers.orders.addLayer(m);}else if(D.sig.get(o.id)!==s){m.setIcon(markerIcon(o));D.sig.set(o.id,s);}}const depotKey=[D.warehouse,D.basemap,H.state.warehouses.length,H.state.suppliers.length,D.visible.warehouses,D.visible.suppliers].join('|');if(D.depotKey!==depotKey){D.depotKey=depotKey;buildDepots();}const labelKey=[D.state,D.city,D.map.getZoom()>=7,D.visible.labels,D.visible.cities,rows.length].join('|');if(D.labelsKey!==labelKey){D.labelsKey=labelKey;renderLabels();}if(D.result)renderRoute();else D.layers.route.clearLayers();renderContext();}
  function renderLabels(){if(!D.map)return;D.layers.labels.clearLayers();D.layers.cities.clearLayers();if(D.map.getZoom()<7){const counts={};baseOrders().forEach(o=>counts[o.state]=(counts[o.state]||0)+1);Object.entries(counts).forEach(([abbr,n])=>{const f=US_STATES.features.find(x=>x.properties.abbr===abbr);if(!f)return;const b=L.geoJSON(f).getBounds(),at=[b.getNorth()-(b.getNorth()-b.getSouth())*.2,b.getWest()+(b.getEast()-b.getWest())*.2];L.marker(at,{icon:L.divIcon({className:'dx-state-label',html:`<b>${e(abbr)}</b><span>${n} 单</span>`,iconSize:[50,20],iconAnchor:[25,30]})}).on('click',()=>focusState(abbr)).addTo(D.layers.labels);});}else{const groups={};visibleOrders().forEach(o=>(groups[o.city]||=[]).push(o));Object.entries(groups).forEach(([city,os])=>L.marker([os.reduce((s,o)=>s+o.lat,0)/os.length,os.reduce((s,o)=>s+o.lng,0)/os.length],{interactive:false,icon:L.divIcon({className:'dx-city-label',html:e(city),iconSize:[130,22],iconAnchor:[65,-19]})}).addTo(D.layers.cities));}}
  function renderRoute(){D.layers.route?.clearLayers();if(!D.map||!D.result?.stops.length||D.result.error)return;const o=H.warehouse(D.warehouse),pts=[[o.lat,o.lng],...D.result.stops.map(s=>[s.lat,s.lng]),[o.lat,o.lng]];L.polyline(pts,{color:'#fff',weight:7,opacity:.9}).addTo(D.layers.route);L.polyline(pts,{color:'#2864ed',weight:3.5,opacity:.95,dashArray:'8 6'}).addTo(D.layers.route);}
  function renderContext(){
    const os=visibleOrders(),w=H.warehouse(D.warehouse),info=H.basemap.info(),local=D.scope==='local';
    H.$('#dx-breadcrumb').innerHTML=`<b>${local?e(w?.city||'出发仓')+' 出发区域':'全国仓网'}</b>${D.state?`<span>›</span><button data-focus-state="${e(D.state)}">${e(D.state)}</button>`:''}${D.city?`<span>›</span><b>${e(D.city)}</b>`:''}<span class="dx-area-count">${os.length} 单 · ${new Set(os.map(o=>o.city)).size} 个城市</span>`;
    H.$('#dx-map-label').textContent=D.city||D.state||(local?(w?.city||'当前仓')+' 配送区域':'美国履约网络');
    H.$('#dx-map-subtitle').textContent=info.busy?'底图连接中…':info.online?'在线底图 · '+H.basemap.label():'离线地图 · 订单与仓点仍可用';
    H.$('#dx-context').textContent=`${new Set(os.map(o=>o.timeZone)).size} 个客户时区 · 点击点位查看订单`;H.$('#dx-map-empty').hidden=os.length>0;
    H.$$('.dx-region-switch button').forEach(b=>{const active=local?b.dataset.action==='local':b.dataset.action==='national';b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  }
  function fitOrigin(animate=true){
    if(!D.map)return;const w=H.warehouse(D.warehouse);if(!w)return;
    const chosen=[...D.selected].map(id=>H.order(id)).filter(o=>o&&o.warehouse===w.id&&Number.isFinite(o.lat)&&Number.isFinite(o.lng));
    const nearby=chosen.length?chosen:visibleOrders().filter(o=>o.warehouse===w.id),pts=[[w.lat,w.lng],...nearby.map(o=>[o.lat,o.lng])];
    D.map.invalidateSize({pan:false});if(pts.length>1)D.map.fitBounds(pts,{padding:[45,50],maxZoom:11,animate,duration:.3});else D.map.setView([w.lat,w.lng],9,{animate});
  }
  function focusOrigin(reset=false){D.scope='local';D.state='';D.city='';D.view=null;D.depotKey='';if(reset)D.result=null;update();fitOrigin();}
  function chooseWarehouse(id){const before=D.selected.size;D.warehouse=id;syncResources();D.selected=new Set([...D.selected].filter(id=>H.order(id)?.warehouse===D.warehouse));D.detail=null;D.tab='route';focusOrigin(true);if(before>D.selected.size)H.toast('已切换出发仓，其他仓点的选单已移出本次计划。');}
  function resetFilters(){['state','city','query','endpoint','path','status','range'].forEach(k=>D[k]='');H.$$('[data-filter]').forEach(x=>{if(x.dataset.filter!=='date')x.value=D[x.dataset.filter];});update();if(D.scope==='local')fitOrigin();}

  function setBasemap(kind){if(!D.map)return;if(kind==='custom'&&!H.basemap.config('custom')){H.toast('自定义瓦片源还没配置地址，请到「接口与时区」页填写。');return;}D.basemap=kind;H.basemap.use(D.map,kind);}
  function focusState(abbr){D.scope='national';D.state=abbr;D.city='';update();const f=US_STATES.features.find(x=>x.properties.abbr===abbr);if(f&&D.map)D.map.fitBounds(L.geoJSON(f).getBounds(),{padding:[35,35],animate:true,duration:.3});}
  function setMobile(v){
    D.mobile=v;const body=H.$('.dx-body');if(body)body.dataset.mobileView=v;
    H.$$('[data-mobile]').forEach(b=>{b.classList.toggle('active',b.dataset.mobile===v);b.setAttribute('aria-pressed',String(b.dataset.mobile===v));});
    const root=H.$('.dx');if(v==='queue')root?.classList.remove('dx-hide-queue','dx-focus');if(v==='plan')root?.classList.remove('dx-hide-plan','dx-focus');requestAnimationFrame(()=>D.map?.invalidateSize({pan:false}));rememberSoon();
  }
  function showDetail(id){D.detail=id;D.tab='detail';setMobile('plan');renderQueue();renderPlan();refreshMarkerStyles();remember();}
  function update(parts){const p=parts||{};if(p.queue!==false)renderQueue();if(p.plan!==false)renderPlan();if(p.map!==false)renderMap();rememberSoon();}
  function invalidate(){D.result=null;update();}
  function syncCard(id){const box=H.$('#dx-order-list');if(!box)return;const cb=box.querySelector('[data-select="'+id+'"]');if(!cb)return;const card=cb.closest('.dx-order');if(card)card.classList.toggle('selected',D.selected.has(id));cb.checked=D.selected.has(id);}
  function updateSelectionUI(){const el=H.$('#dx-selected-count');if(el)el.innerHTML=`<b>${D.selected.size}</b> 已选择${[...D.selected].some(id=>!visibleOrders().some(o=>o.id===id))?' · 含其他筛选任务':''}`;renderActions();}
  function toggleSelection(id){
    const o=H.order(id);if(!o)return;if(!D.selected.has(id)&&(o.status==='物理交付完成'||assigned(o))){H.toast('已交付或已在有效批次中的订单不能重复选入。');return;}
    if(D.selected.has(id))D.selected.delete(id);else D.selected.add(id);D.result=null;syncCard(id);refreshMarkerStyles();D.layers.route?.clearLayers();renderPlan();updateSelectionUI();rememberSoon();
  }
  function runPlan(fixed){
    if(D.busy)return;if(!D.selected.size){H.toast('请先选择配送订单。');setMobile('queue');return;}D.busy=true;renderActions();
    requestAnimationFrame(()=>{try{
      D.result=solve(H.state,[...D.selected],{...config(),...(fixed?{fixedOrder:fixed}:{})});D.fingerprint=fingerprint();D.tab='route';setMobile('plan');renderPlan();refreshMarkerStyles();renderRoute();remember();
      if(D.result.stops.length&&D.map){const o=H.warehouse(D.warehouse);D.map.fitBounds([[o.lat,o.lng],...D.result.stops.map(s=>[s.lat,s.lng])],{padding:[55,50],maxZoom:11,animate:true,duration:.3});}
      if(D.result.error)H.toast(D.result.error);else H.toast(`${D.mode==='draft'?'预排':'校验'}完成：${D.result.stops.length} 单可排，${D.result.rejected.length} 单未排。`);
    }finally{D.busy=false;renderActions();}});
  }
  function moveStop(id,d){if(!D.result?.stops.length)return;const ids=D.result.orderIds.slice(),i=ids.indexOf(id),n=i+d;if(i<0||n<0||n>=ids.length)return;[ids[i],ids[n]]=[ids[n],ids[i]];runPlan(ids);}
  function exportRows(name,ids,result){H.csv(name,[['顺序','订单','客户','城市','州','型号','数量','服务','客户时区','客户日期','窗口开始','窗口结束','开始UTC','开始当地','北京时间','完成UTC','状态'],...ids.map((id,i)=>{const o=H.order(id),s=result?.stops?.find(s=>s.id===id);return [i+1,o.id,o.customer,o.city,o.state,o.model,o.qty,H.services?.summary(o)||o.endpoint,o.timeZone,o.date,H.time(o.windowStart),H.time(o.windowEnd),s?.startUTC||'',s?time(s.startUTC,o.timeZone):'',s?time(s.startUTC,'Asia/Shanghai'):'',s?.finishUTC||'',result?.mode==='draft'?'预排草案':'模拟，非派车'];})]);}
  function saveBatch(){if(!D.result?.stops.length)return;if(D.fingerprint!==fingerprint()){D.result=null;update();H.toast('数据已变化，请重新计算。');return;}const r=solve(H.state,D.result.orderIds,{...config(),fixedOrder:D.result.orderIds});if(r.error||r.stops.length!==D.result.stops.length){D.result=r;update();H.toast('保存前复核未通过。');return;}if(D.mode!=='draft'){const missing=r.orderIds.flatMap(id=>H.releaseIssues(H.order(id)));if(missing.length){H.toast('放行缺项未清除：'+missing[0]);return;}}const id='B8-'+Date.now().toString(36).toUpperCase(),b={id,status:D.mode==='draft'?'预排草案':'模拟待复核',mode:D.mode,date:D.date,timezone:r.timezone,warehouseId:D.warehouse,vehicleId:D.vehicle,supplierId:D.supplier,originVersion:H.warehouse(D.warehouse).version||1,vehicleVersion:H.state.vehicles.find(v=>v.id===D.vehicle).version||1,supplierVersion:H.state.suppliers.find(s=>s.id===D.supplier).version||1,orderIds:r.orderIds.slice(),versions:Object.fromEntries(r.orderIds.map(id=>[id,H.order(id).version])),stops:H.clone(r.stops),cost:r.cost,baseline:r.baseline,saved:r.saved,distanceKm:r.distanceKm,duration:r.duration,config:config(),departureUTC:r.departureUTC,returnUTC:r.returnUTC,createdAt:new Date().toISOString()};H.state.batches.push(b);H.save('保存'+b.status,id,b.orderIds.join(' → '));D.result=null;D.tab='batches';if(D.mode!=='draft')D.selected.clear();update();H.toast('已保存 '+b.status+'，未发出真实委托。');}
  function cancelBatch(id){const b=H.state.batches.find(x=>x.id===id);if(!b)return;H.modal('撤销本地批次',`<p>${e(id)} · 释放模拟占用，保留历史记录。</p>${H.field('撤销原因','reason','','text','required minlength="2"')}`,fd=>{b.status='已取消';b.cancelReason=String(fd.get('reason'));b.cancelledAt=new Date().toISOString();H.save('撤销批次',id,b.cancelReason);D.result=null;},'撤销并保留记录');}
  function parameters(){H.modal('路线估算参数',`<p class="notice">用于成本与工时情景比较，不代表实际路网、交通或驾驶员工时合规认证。</p><div class="grid cols-2">${H.field('绕行系数','factor',D.factor,'number','min="1" max="2" step="0.01" required')}${H.field('平均速度 km/h','speed',D.speed,'number','min="15" max="90" required')}${H.field('装车准备 min','handling',D.handling,'number','min="0" max="120" required')}${H.field('每站缓冲 min','buffer',D.buffer,'number','min="0" max="120" required')}${H.field('休息预留 min','breakMins',D.breakMins,'number','min="0" max="120" required')}</div>`,fd=>{const next={};for(const [k,[min,max]]of Object.entries(PARAM_LIMITS)){const raw=fd.get(k),n=Number(raw);if(raw===null||raw===''||!Number.isFinite(n)||n<min||n>max)throw new Error('请填写范围内的完整估算参数。');next[k]=n;}Object.assign(D,next);D.result=null;remember();H.toast('估算参数已保存，刷新页面后仍保留。');},'保存估算参数');}
  function help(){H.modal('地图调度操作说明','<div class="dx-help"><h3>1 · 选择本仓订单</h3><p>默认聚焦出发仓区域。切换“全国仓网”可查看其他仓点；切换出发仓后地图会回到该仓。按日期、服务、状态或城市筛选，勾选本次任务。</p><h3>2 · 生成预排</h3><p>设置车组、实际配送方与起仓当地时间。点击底部“生成预排”，查看可排订单和未排原因。预排可保留资料缺项，但不预占资源。</p><h3>3 · 放行前校验</h3><p>点击“补齐资料”直接核验订单，再运行放行前校验。未确认预约、库存锁定、供应商能力、载重和时间窗等条件仍会阻止排入。</p><h3>4 · 保存模拟批次</h3><p>保存前再次核对当前订单版本与约束。保存草案不占资源；校验后的模拟批次占用本机订单和车组。撤销释放占用并保留记录，不发送真实派车指令。</p><h3>地图与时间</h3><p>点击点位查看详情；双击点位或框选可加入选单。拖动停靠点后重新校验。虚线仅为估算连接，不能导航；每站按客户当地时间显示，跨时区按 UTC 实际经过时长计算。</p></div>');}
  H.mounts.dispatch=()=>{
    renderQueue();renderPlan();initMap();const root=H.$('.dx');
    root.addEventListener('click',ev=>{
      const b=ev.target.closest('button');if(!b||b.disabled)return;
      if(b.dataset.review){showDetail(b.dataset.review);H.showOrder?.(b.dataset.review);return;}
      if(b.dataset.order){showDetail(b.dataset.order);return;}
      if(b.dataset.city){D.city=D.city===b.dataset.city?'':b.dataset.city;D.state=b.dataset.state;update();const os=visibleOrders();if(os.length&&D.map)D.map.fitBounds(os.map(o=>[o.lat,o.lng]),{padding:[45,50],maxZoom:11,animate:true,duration:.3});return;}
      if(b.dataset.focusState){focusState(b.dataset.focusState);return;}
      if(b.dataset.tab){D.tab=b.dataset.tab;renderPlan();remember();return;}
      if(b.dataset.mobile){setMobile(b.dataset.mobile);return;}
      if(b.dataset.basemap){setBasemap(b.dataset.basemap);remember();return;}
      if(b.dataset.mode){D.mode=b.dataset.mode;invalidate();return;}
      if(b.dataset.move){moveStop(b.dataset.move,Number(b.dataset.step));return;}
      if(b.dataset.batchExport){const x=H.state.batches.find(x=>x.id===b.dataset.batchExport);if(x)exportRows(x.id+'.csv',x.orderIds,x);return;}
      if(b.dataset.batchCancel){cancelBatch(b.dataset.batchCancel);return;}
      const a=b.dataset.action;
      if(a==='plan')runPlan();
      else if(a==='validate'){D.mode='validated';D.result=null;runPlan();}
      else if(a==='clear'){D.selected.clear();invalidate();}
      else if(a==='select-visible'||a==='select-origin'){visibleOrders().filter(o=>o.status!=='物理交付完成'&&!assigned(o)&&(a==='select-visible'||o.warehouse===D.warehouse)).forEach(o=>D.selected.add(o.id));invalidate();}
      else if(a==='toggle-detail')toggleSelection(D.detail);
      else if(a==='service')H.services?.open(D.detail);
      else if(a==='order-edit')H.showOrder?.(D.detail);
      else if(a==='local')focusOrigin();
      else if(a==='national'){D.scope='national';D.state='';D.city='';update();D.map?.fitBounds([[24,-126],[50,-66]],{padding:[35,35],animate:true,duration:.3});}
      else if(a==='reset-filter')resetFilters();
      else if(a==='fit'){if(D.scope==='local')fitOrigin();else{const os=visibleOrders();if(os.length)D.map?.fitBounds(os.map(o=>[o.lat,o.lng]),{padding:[45,50],maxZoom:11,animate:true,duration:.3});}}
      else if(a==='layers'){const p=H.$('#dx-layers');p.hidden=!p.hidden;b.setAttribute('aria-expanded',String(!p.hidden));}
      else if(a==='select-box'&&D.map){D.selectBox=!D.selectBox;b.classList.toggle('active',D.selectBox);D.map.getContainer().classList.toggle('dx-box-mode',D.selectBox);if(!D.selectBox){D.rectangle?.remove();D.rectangle=null;D.map.dragging.enable();}else H.toast('拖动矩形框选任务。');}
      else if(['collapse-queue','expand-queue'].includes(a)){root.classList.remove('dx-focus');root.classList.toggle('dx-hide-queue',a==='collapse-queue');if(a==='expand-queue')setMobile('queue');D.map?.invalidateSize({pan:false});}
      else if(['collapse-plan','expand-plan'].includes(a)){root.classList.remove('dx-focus');root.classList.toggle('dx-hide-plan',a==='collapse-plan');if(a==='expand-plan')setMobile('plan');D.map?.invalidateSize({pan:false});}
      else if(a==='full'){root.classList.toggle('dx-focus');D.map?.invalidateSize({pan:false});}
      else if(a==='save')saveBatch();else if(a==='parameters')parameters();else if(a==='help')help();
      else if(a==='resources')H.navigate(H.pages.resources?'resources':'suppliers');
      else if(a==='export-visible')exportRows('V8-调度当前任务.csv',visibleOrders().map(o=>o.id));
      else if(a==='export-route'&&D.result)exportRows('V8-路线计划.csv',D.result.orderIds,D.result);
    });
    root.addEventListener('change',ev=>{
      const t=ev.target;if(t.dataset.select){toggleSelection(t.dataset.select);return;}
      if(t.dataset.filter){D[t.dataset.filter]=t.value;if(t.dataset.filter==='date')D.result=null;update();return;}
      if(t.dataset.config){D[t.dataset.config]=t.value;if(t.dataset.config==='warehouse'){chooseWarehouse(t.value);return;}if(t.dataset.config==='date')root.querySelector('[data-filter="date"]').value=D.date;applyConfig();return;}
      if(t.dataset.layer){D.visible[t.dataset.layer]=t.checked;if(D.map&&D.layers[t.dataset.layer])t.checked?D.layers[t.dataset.layer].addTo(D.map):D.map.removeLayer(D.layers[t.dataset.layer]);remember();}
    });
    root.addEventListener('input',ev=>{if(ev.target.dataset.filter!=='query')return;D.query=ev.target.value;clearTimeout(D.searchTimer);D.searchTimer=setTimeout(()=>{renderQueue();renderMap();remember();},140);});
    root.addEventListener('dragstart',ev=>{const el=ev.target.closest('[data-stop]');if(!el)return;D.dragId=el.dataset.stop;ev.dataTransfer.effectAllowed='move';ev.dataTransfer.setData('text/plain',D.dragId);el.classList.add('dragging');});
    root.addEventListener('dragover',ev=>{if(ev.target.closest('[data-stop]'))ev.preventDefault();});
    root.addEventListener('drop',ev=>{const t=ev.target.closest('[data-stop]');if(!t||!D.result||!D.dragId||D.dragId===t.dataset.stop)return;ev.preventDefault();const ids=D.result.orderIds.filter(id=>id!==D.dragId);ids.splice(ids.indexOf(t.dataset.stop),0,D.dragId);D.dragId=null;runPlan(ids);});
    root.addEventListener('dragend',()=>{D.dragId=null;H.$$('[data-stop]').forEach(x=>x.classList.remove('dragging'));});
  };
  H.unmounts=H.unmounts||{};H.unmounts.dispatch=()=>{
    clearTimeout(D.searchTimer);clearTimeout(D.rememberTimer);D.resizeObserver?.disconnect();
    if(D.map){if(!D.resetView)D.view={center:[D.map.getCenter().lat,D.map.getCenter().lng],zoom:D.map.getZoom()};remember();D.map.remove();}D.resetView=false;
    D.map=null;D.markers.clear();D.sig.clear();D.layers={};D.depotKey='';D.labelsKey='';D.paintState=null;D.paintBase=null;D.tileLayer=null;H.basemap.detach();D.rectangle=null;H.currentMap=null;
  };
  H.dispatchView={visibleOrders,state:D,remember,config};
  H.dispatch=Object.assign(H.dispatch||{},{
    refreshSize(){D.map?.invalidateSize({pan:false});},
    resetForDataChange(){
      D.result=null;D.fingerprint=null;D.selected=new Set([...D.selected].filter(id=>H.order(id)));if(!H.order(D.detail))D.detail=null;
      D.view=null;D.resetView=true;D.depotKey='';D.labelsKey='';D.state='';D.city='';syncResources();remember();
    }
  });
})();
