/* Shared order workbench. Every write uses the version last read by this dialog. */
(() => {
  'use strict';
  const stages = {
    new: '待仓库核验', ready: '已就绪', dispatched: '已派车', in_transit: '运输中',
    at_station: '站点保管', last_mile: '二程运输', delivered: '已签交', settled: '已结算', exception: '异常挂起'
  };
  const routes = {A: '普通卡派', B: '原仓专业直送', C1: '经站统包', C2: '经站分采'};
  const scope = {L1:'基础交接', L2:'指定入口', L3:'室内机位'};
  const cats = {pod:'签收回单 POD',release:'仓库放行',quote:'承运报价／委托',site:'现场条件',service:'技术服务',invoice:'费用凭据',other:'其他凭证'};
  const names = {ready:'核验并锁机', dispatch:'确认派车', depart:'登记发车', pickup:'授权自提交接', station_receive:'登记入站交接',
    station_release:'授权第二程', deliver:'登记签收', exception:'挂起异常', resolve:'处理并恢复', service_complete:'确认技术启用',
    settle:'核对并结算', note:'写协作记录', edit:'编辑订单', upload:'上传凭证', revise_window:'更改预约', unrelease:'撤回放行',
    attempt:'登记本次到场',platform_receipt:'核对平台实收'};
  const operationKeys = ['ready','dispatch','pickup','depart','station_receive','station_release','deliver','resolve','service_complete','settle'];
  const help = {
    ready:'按每台实物核查 SN、包装、货况与可提时段。缺损设备留仓隔离。',
    dispatch:'核本票机型、约定终点、原窗、车辆及人员。确认仓方可放货且实际执行方已书面接单。',
    depart:'核对派车授权、设备 SN 及实际接手车组。出库后由本段承运方保管。',
    pickup:'核提货授权、车辆净开口、载荷与固定方式。完成原仓签交后，按该合同终点关闭实物交付。',
    station_receive:'站方按 SN 核实件数、货况及库位，记录当前保管人；短损另开异常。',
    station_release:'核对站方已收 SN、第二程车组与有效委托。只放行本次已确认的运输段。',
    deliver:'按 SN 核实际到达位置、已购动作、签收人和现场凭证。未到合同终点或仅部分完成时，先挂起异常。',
    exception:'停止受影响环节，明确当前货物位置、保管人和下一步。恢复时保留原操作记录。',
    resolve:'记录处理结果和授权依据。发车前已派的单回到待调度并重签授权，其他工序按当前保管情况恢复。',
    service_complete:'根据所售机型、授权与现场条件完成测试，关联 SN、结果号与客户确认。',
    settle:'核报价、批准变更、作业回单和发票。按票填写已核实的美元全费用，未决差异先处理。',
    note:'记录已确认的事实、对方回执和下一位经办人。请勿写入密码或账户凭据。',
    revise_window:'记录改约原因、提出方和客户确认依据。首次承诺的窗口继续保留。已派且尚未发车时，需调度重新签发。',
    unrelease:'撤回当前放行并解除本票锁定的 SN。修改完成后需要重新核验。'
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const can = (o, key) => (o.allowed_actions || []).includes(key);
  const routeText = o => o.pickup ? 'A · 仓口自提' : [o.route,routes[o.route]].filter(Boolean).join(' · ');
  const issuedLine = r => r?`${r.date} · ${r.name} · 第 ${r.stop} / ${r.stops} 站`:'';
  const stageTag = o => `<span class="wf-status wf-${esc(o.status)}">${esc(stages[o.status] || o.status)}</span>`;
  const next = o => operationKeys.find(k => can(o,k));
  const btn = (key,label,style='') => `<button type="button" class="${style}" data-cmd="${esc(key)}">${esc(label)}</button>`;
  const zoneNames = {'America/New_York':'美国东部', 'America/Chicago':'美国中部','America/Denver':'美国山地','America/Phoenix':'亚利桑那',
    'America/Los_Angeles':'美国太平洋','America/Anchorage':'阿拉斯加','Pacific/Honolulu':'夏威夷',
    'America/Detroit':'底特律','America/Indiana/Indianapolis':'印第安纳波利斯','America/Boise':'博伊西','America/Adak':'埃达克','UTC':'UTC'};
  const zoneText = o => zoneNames[o.timezone] || o.timezone || '未填时区';
  function localTime(value) {return value ? String(value).replace('T',' ').slice(0,16) : '待确认';}
  function timestamp(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(+date)) return '—';
    return date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function options(values, selected) {
    return Object.entries(values).map(([k,v]) => `<option value="${esc(k)}"${k === selected?' selected':''}>${esc(v)}</option>`).join('');
  }
  const searchKeys = ['id','crm_ref','customer','address','city','state','zip','warehouse','model','sn','owner','carrier','driver'];
  const filters = new Map();
  function mount(container, ctx, view='orders') {
    const state = filters.get(view) || {search:'',status:'',route:''};
    filters.set(view,state);
    const orders = ctx.orders || [];
    let data = orders;
    if (view === 'tasks') data = orders.filter(o => next(o));
    if (view === 'exceptions') data = orders.filter(o => o.status === 'exception');
    if (view === 'finance') data = orders.filter(o => ['delivered','settled'].includes(o.status));
    const headings = {orders:'全部订单',tasks:'可执行任务',exceptions:'待处理异常',finance:'交付与核账'};
    const states = [...new Set(data.map(o=>o.status))];
    if (state.status && !states.includes(state.status)) state.status='';
    container.innerHTML = `<section class="wf-board">
      <header class="wf-board-head"><div><small class="wf-overline">OPERATIONS REGISTER</small><h2>${headings[view] || '订单'} <span>${data.length}</span></h2></div>
      <small class="wf-meta">${view === 'tasks'?'按当前身份列出可推进的工序':view === 'finance'?'金额单位 · USD':'共享业务库 · 当前可见范围'}</small></header>
      <div class="wf-filters"><label class="wf-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="查单号、CRM、客户、SN 或 ZIP" aria-label="搜索订单" value="${esc(state.search)}"></label>
      <select aria-label="按工序筛选" name="status">${options({'':'全部工序',...Object.fromEntries(states.map(k=>[k,stages[k] || k]))},state.status)}</select>
      <select aria-label="按路径筛选" name="route">${options({'':'全部路径',pickup:'A · 仓口自提',A:'A · 普通卡派',B:'B · 专业直送',C1:'C1 · 经站统包',C2:'C2 · 经站分采'},state.route)}</select></div>
      <div data-results aria-live="polite"></div></section>`;
    const result = container.querySelector('[data-results]');
    function rows() {
      const q=state.search.trim().toLowerCase();
      const list=data.filter(o=>(!state.status || o.status===state.status) && (!state.route || (o.pickup?'pickup':o.route)===state.route)
        && (!q || searchKeys.some(k=>String(o[k] ?? '').toLowerCase().includes(q)) || issuedLine(o.release_route).toLowerCase().includes(q)));
      if (!list.length) {
        const filtered=Boolean(q || state.status || state.route);
        result.innerHTML=`<div class="wf-empty"><b>${filtered?'没有匹配的订单':view==='tasks'?'本岗位暂无待办':view==='exceptions'?'当前没有挂起异常':view==='finance'?'暂无已签交订单':'还没有可见订单'}</b><p>${filtered?'可以更换关键词或清除筛选。':view==='tasks'?'其他岗位完成交接后，下一项任务会进入这里。':view==='orders'?'销售可以从“新建订单”开始录入。':'相关业务记录会自动出现在此处。'}</p>${filtered?btn('clear','清除筛选'):''}</div>`;
        return;
      }
      const finance=view==='finance', exception=view==='exceptions', tasks=view==='tasks';
      result.innerHTML=`<div class="wf-table-x"><table class="wf-table"><thead><tr><th>订单 / 客户</th><th>仓库 → 目的地</th><th>路径 / 服务</th><th>工序</th><th>${finance?'核账 USD':exception?'异常 / 保管人':tasks?'本岗任务':'预约开始 · 当地'}</th><th><span class="wf-sr">操作</span></th></tr></thead><tbody>${list.map(o => {
        const task=next(o);
        const col=finance? `<b>${o.actual_cost!=null && o.actual_cost!==''?esc(Number(o.actual_cost).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})):'待核'}</b><small>${esc(o.invoice_ref||'未登记发票')}</small>`:
          exception?`<b>${esc(o.reason || o.exception_reason || '查看异常记录')}</b><small>${esc(o.custodian || '见订单记录')}</small>`:
          tasks?esc(names[task]):`${esc(localTime(o.window_start))}<small>${esc(zoneText(o))}</small>`;
        return `<tr><td><button type="button" class="wf-link wf-id" data-order="${esc(o.id)}">${esc(o.id)}</button><small>${esc(o.customer)}</small></td><td>${esc([o.city,o.state,o.zip].filter(Boolean).join(' ')||o.address)}<small>从 ${esc(o.warehouse || '待定仓库')}</small></td>
        <td>${esc(routeText(o))}<small>${esc(o.level)}${o.addon_l4?' + L4':''}${o.addon_l5?' + L5':''} · ${esc(o.model)} × ${esc(o.quantity)}</small>${o.release_route?`<strong class="wf-issued-line">${esc(issuedLine(o.release_route))}</strong>`:''}</td>
        <td>${stageTag(o)}</td><td>${col}</td><td><button type="button" class="wf-link" data-order="${esc(o.id)}" data-start="${tasks?esc(task):''}">${tasks?'办理':'详情'} ›</button></td></tr>`;
      }).join('')}</tbody></table></div><div class="wf-count">显示 ${list.length} / ${data.length} 票</div>`;
    }
    rows();
    container.querySelector('input[type=search]').oninput=e=>{state.search=e.target.value;rows();};
    container.querySelectorAll('.wf-filters select').forEach(el=>el.onchange=()=>{state[el.name]=el.value;rows();});
    result.onclick=e=>{
      const link=e.target.closest('[data-order]'); if(link) openOrder(ctx,link.dataset.order,link.dataset.start);
      if(e.target.closest('[data-cmd="clear"]')) {filters.delete(view);mount(container,ctx,view);}
    };
  }

  let active;
  let dialogSerial=0;
  function dialog(title,subtitle) {
    if(active?.open) active.close();
    const el=document.createElement('dialog');
    active=el;
    const titleId='wf-title-'+ ++dialogSerial;
    el.className='wf-dialog';
    el.setAttribute('aria-labelledby',titleId);
    el.innerHTML=`<header class="wf-dialog-head"><div><small class="wf-overline">${esc(subtitle)}</small><h2 id="${titleId}">${esc(title)}</h2></div>
      <button type="button" class="wf-icon" aria-label="关闭窗口" data-close>×</button></header><div class="wf-dialog-body"></div>`;
    el.querySelector('[data-close]').onclick=()=>el.close();
    el.onclose=()=>{el.remove();if(active===el)active=null;};
    document.body.append(el);el.showModal();
    return {el,body:el.querySelector('.wf-dialog-body')};
  }
  function msg(err){return err?.message || String(err || '请求失败，请重试');}
  async function refreshAfterSave(ctx){
    try{await ctx.refresh();}catch{ctx.toast?.('操作已保存，列表暂时无法刷新。恢复连接后请重新读取。');}
  }
  function errBox(body,error){body.innerHTML=`<div class="wf-warning" role="alert">${esc(msg(error))}</div>`;}
  function field(key,label,value='',config={}) {
    const c=config;
    const attrs=`name="${esc(key)}" ${c.req?'required':''} ${c.extra||''}`;
    const inner=c.opts?`<select ${attrs}>${options(c.opts,String(value??''))}</select>`:c.area?
      `<textarea ${attrs} rows="${c.rows||2}" maxlength="2000" placeholder="${esc(c.ph||'')}">${esc(value)}</textarea>`:
      `<input ${attrs} type="${c.type||'text'}" value="${esc(value)}" placeholder="${esc(c.ph||'')}" ${['number','file','datetime-local'].includes(c.type)?'':'maxlength="2000"'}>`;
    return `<label class="wf-field ${c.full?'wf-full':''}"><span>${esc(label)}${c.req?'<em> *</em>':''}</span>${inner}${c.hint?`<small>${esc(c.hint)}</small>`:''}</label>`;
  }
  const section = (n,title,body) => `<section class="wf-form-section"><h3><span>${n}</span> ${title}</h3><div class="wf-grid">${body}</div></section>`;
  function submitter(form,run,onConflict) {
    const output=form.querySelector('[role=alert]');
    const submit=form.querySelector('[type=submit]');
    form.onsubmit=async e=>{
      e.preventDefault();
      if(submit.disabled || !form.reportValidity())return;
      submit.disabled=true;form.setAttribute('aria-busy','true');output.textContent='';
      try{await run(new FormData(form));}
      catch(error){
        output.textContent=msg(error);
        if(error?.status===409 && onConflict){
          const reload=document.createElement('button');reload.type='button';reload.textContent='读取最新订单';
          reload.onclick=onConflict;output.append(' ',reload);
        }
        output.scrollIntoView({block:'nearest'});
      }
      finally{submit.disabled=false;form.removeAttribute('aria-busy');}
    };
  }
  const formEnd = (label,cancel='back')=>`<div class="wf-form-end"><div class="wf-error" role="alert"></div><div>${btn(cancel,'取消')} <button type="submit" class="wf-primary">${esc(label)}</button></div></div>`;
  const req={req:true};
  const routeNotes={pickup:'仓库和授权提货人核实车门净空、直立固定和装车责任。后段由提货方安排。',
    A:'明确指定月台或入口及卸货责任。送平台仓时记录货件号、标签和有效仓约，现场交接与平台实收分别核对。',
    B:'从本台 SN 所在仓直接交付。核现场路线、人员、工具及可完成的已购动作。',
    C1:'一份主委托覆盖干线、接收站和第二程；主承方提供两段交接回执。',
    C2:'分别确认干线、接收站和第二程。首段出发前取得接站回执与第二程委托依据。'};
  function orderForm(ctx,o=null) {
    const editing=Boolean(o); const v=o||{};
    const {el,body}=dialog(editing?'编辑订单':'新建履约订单',editing?o.id:'ORDER INTAKE / F01');
    const warehouses=(ctx.resources || []).filter(x=>x.type==='warehouse').map(x=>x.name).filter(Boolean);
    const modes={pickup:'A · 客户到仓自提',A:'A · 普通卡派',B:'B · 原仓专业直送',C1:'C1 · 经站统包',C2:'C2 · 经站分采'};
    const mode=v.pickup?'pickup':(v.route||'B');
    const whList='wf-warehouse-'+dialogSerial;
    body.innerHTML=`<form class="wf-form">${section('01','客户与终点',
      field('customer','客户 / 收货单位',v.customer,req)+field('crm_ref','CRM / 原订单关联号',v.crm_ref,{ph:'用于销售交接或旧单迁入'})+
      field('contact','现场联系人与电话',v.contact,{full:true})+
      field('address','美国交付地址',v.address,{req:true,full:true,ph:'门牌、街道及楼栋'})+
      field('city','城市',v.city)+field('state','州代码',v.state,{extra:'pattern="[A-Za-z]{2}" title="两位州代码" maxlength="2"',ph:'TX'})+
      field('zip','目的 ZIP',v.zip,{req:true,extra:'pattern="[0-9]{5}(-[0-9]{4})?" inputmode="numeric"',ph:'75001'})+
      field('endpoint','合同约定交接点',v.endpoint,{req:true,ph:'例如一楼大厅东侧指定机位'})+
      field('lat','终点纬度',v.lat,{type:'number',extra:'min="-90" max="90" step="any"',ph:'例如 32.7767'})+
      field('lng','终点经度',v.lng,{type:'number',extra:'min="-180" max="180" step="any"',ph:'例如 -96.7970'}))}
      ${section('02','货物与已购范围',
      field('warehouse','设备持货仓',v.warehouse,{req:true,extra:'list="'+whList+'"'})+`<datalist id="${whList}">${warehouses.map(x=>`<option value="${esc(x)}"></option>`).join('')}</datalist>`+
      field('mode','履约路径',mode,{req:true,opts:modes})+'<div class="wf-hint wf-full" data-route-hint></div>'+
      field('model','设备型号',v.model||'',{req:true,opts:{'':'选择型号',...Object.fromEntries(Array.from({length:7},(_,i)=>['M0'+(i+1),'M0'+(i+1)]))}})+
      field('quantity','台数',v.quantity||1,{req:true,type:'number',extra:'min="1" max="999" step="1"'})+
      field('level','基础服务档',v.level||'L1',{req:true,opts:{L1:'L1 · 基础交接',L2:'L2 · 指定入口',L3:'L3 · 室内机位'}})+
      `<fieldset class="wf-addons"><legend>另购服务</legend><label><input type="checkbox" name="addon_l4" ${v.addon_l4?'checked':''}> L4 专项搬运</label><label><input type="checkbox" name="addon_l5" ${v.addon_l5?'checked':''}> L5 技术启用</label></fieldset>`+
      field('delivery_actions','已购作业',v.delivery_actions,{area:true,ph:'按合同填写卸车、拆托、摆位等'})+field('exclusions','范围外作业 / 责任方',v.exclusions,{area:true})+
      field('site_note','现场条件及专项承接',v.site_note,{area:true,full:true,ph:'限高、门宽、楼梯、停车、物业许可与复核人'}))}
      ${section('03','客户窗口与交接',
      field('timezone','作业地时区',v.timezone||'America/Chicago',{opts:{...zoneNames,...(v.timezone && !zoneNames[v.timezone]?{[v.timezone]:v.timezone}:{})},full:true})+
      field('window_start','预约开始（当地）',v.window_start,{type:'datetime-local'})+field('window_end','预约结束（当地）',v.window_end,{type:'datetime-local'})+
      field('notes','随单说明',v.notes,{area:true,full:true,ph:'硬性时窗、客户书面确认编号或待补资料'}))}
      ${formEnd(editing?'保存修改':'创建订单','cancel')}</form>`;
    const form=body.querySelector('form'), modeEl=form.elements.mode;
    const update=()=>{body.querySelector('[data-route-hint]').textContent=routeNotes[modeEl.value];};
    update();modeEl.onchange=update;
    body.querySelector('[data-cmd=cancel]').onclick=()=>{el.close();if(editing)openOrder(ctx,o.id);};
    submitter(form,async fd=>{
      const payload=Object.fromEntries(fd);const {mode}=payload;delete payload.mode;
      payload.pickup=mode==='pickup';payload.route=payload.pickup?'A':mode;
      if(payload.pickup && payload.level!=='L1')throw Error('仓口自提请选 L1 基础交接，并在合同终点中写明装车交接点。');
      if(payload.route==='A' && (payload.level==='L3' || fd.has('addon_l4')))throw Error('A 路径适配基础交接或入口交付。已购机位交付、专项搬运需确认专业承接路径。');
      if(payload.addon_l4 && !payload.site_note.trim())throw Error('L4 专项搬运需要填写现场条件及专项承接。');
      if(Boolean(payload.window_start)!==Boolean(payload.window_end)|| (payload.window_end && payload.window_end<=payload.window_start))throw Error('请同时填写预约起止时间，且结束晚于开始。');
      if(Boolean(payload.lng)!==Boolean(payload.lat))throw Error('地图定位需要同时填写经度和纬度。');
      for(const k of ['lng','lat'])payload[k]=payload[k]===''?null:Number(payload[k]);
      payload.quantity=Number(payload.quantity);payload.addon_l4=fd.has('addon_l4');payload.addon_l5=fd.has('addon_l5');payload.state=payload.state.toUpperCase();
      if(editing)payload.version=o.version;
      const res=await ctx.api(editing?'/api/orders/'+encodeURIComponent(o.id):'/api/orders',{method:editing?'PATCH':'POST',body:payload});
      el.close();ctx.toast?.(editing?'修改已保存':'订单已创建');await refreshAfterSave(ctx);openOrder(ctx,res.order.id);
    },editing?()=>openOrder(ctx,o.id):null);
  }

  const labels={customer:'客户',crm_ref:'CRM / 原订单关联号',contact:'现场联系人',address:'交付地址',city:'城市',state:'州',zip:'邮编',lat:'纬度',lng:'经度',
    warehouse:'持货仓',model:'型号',quantity:'台数',endpoint:'合同终点',level:'服务档',route:'路径',pickup:'客户自提',
    addon_l4:'专项搬运 L4',addon_l5:'技术启用 L5',site_note:'现场核验',delivery_actions:'已购作业',exclusions:'范围外责任',
    notes:'随单说明',owner:'建单人',status:'工序',sn:'设备 SN',release_ref:'验机 / 放行依据',driver:'执行司机',carrier:'承运团队',
    dispatch_ref:'委托 / 放行依据',release_route:'已签发线路',handoff_ref:'接站与二程依据',station_name:'接收站',custodian:'实物保管人',receipt_ref:'入站收据',
    signer:'签收人',delivered_at:'签交时刻（当地）',delivery_note:'实际位置与完成动作',result_ref:'技术验收结果号',invoice_ref:'发票 / 核账单号',
    approved_cost:'已批全价（USD）',change_cost:'批准变更（USD）',change_ref:'变更审批号',variance_cost:'结算差额（USD）',variance_ref:'差异处置依据',
    checks:'发车前核验',actual_cost:'已结费用（USD）',reason:'原因',next_step:'下一步 / 负责人',resolution:'处理结果',previous_status:'异常前工序',
    window_start:'预约开始',window_end:'预约结束',original_window_start:'原预约开始',original_window_end:'原预约结束',
    timezone:'作业时区',original_timezone:'首次预约时区',note:'协作记录',updated_at:'更新时间'};
  function val(k,v) {
    if(v==null || v==='')return '—';
    if(typeof v==='boolean')return v?'是':'否';
    if(k==='release_route')return issuedLine(v);
    if(k==='checks' && typeof v==='object')return Object.entries(v).map(([field,value])=>(checks[field]||field)+' · '+value).join('\n');
    if(['status','previous_status'].includes(k))return stages[v] || v;
    if(k==='updated_at')return timestamp(v);
    if(k==='timezone' || k==='original_timezone')return zoneNames[v] || v;
    if(k==='delivered_at' || k.includes('window_'))return localTime(v);
    return String(v);
  }
  function kv(o,keys) {
    return `<dl class="wf-kv">${keys.filter(k=>o[k]!=null && o[k]!=='').map(k=>`<div><dt>${esc(labels[k]||k)}</dt><dd>${esc(val(k,o[k]))}</dd></div>`).join('')}</dl>`;
  }
  function recordNote(e) {
    let n;try{n=JSON.parse(e.note);}catch{return esc(e.note);}
    if(!n || Array.isArray(n) || typeof n!=='object')return esc(e.note);
    return Object.entries(n).map(([k,v])=>`${esc(labels[k]||k)} · ${esc(Array.isArray(v)?v.map(x=>val(k,x)).join(' → '):val(k,v))}`).join('<br>') || '已登记';
  }
  function summary(o) {
    return `<div class="wf-order-hero"><div><span class="wf-overline">CONTRACT ENDPOINT</span><h3>${esc(o.customer)}</h3><p>${esc(o.endpoint)} · ${esc(o.address)}</p></div>${stageTag(o)}</div>
      <div class="wf-facts"><div><small>履约路径</small><b>${esc(routeText(o))}</b></div><div><small>承诺范围</small><b>${esc(o.level)} ${esc(scope[o.level] || '')}${o.addon_l4?' + L4':''}${o.addon_l5?' + L5':''}</b></div><div><small>设备</small><b>${esc(o.model)} × ${esc(o.quantity)}</b></div>${o.release_route?`<strong class="wf-full wf-issued-line">已签线路 · ${esc(issuedLine(o.release_route))}</strong>`:''}</div>`;
  }
  function facts(o,heading,keys) {
    const content=kv(o,keys);
    return content.includes('<dd>')? `<section class="wf-info"><h4>${heading}</h4>${content}</section>`:'';
  }
  const resultNames={success:'完成所购动作',partial:'部分完成',failed:'未能交付'};
  const assetNames={available:'在仓可用',reserved:'已锁机',transit:'交运中',station:'站方保管',hold:'隔离',delivered:'已签交',return_transit:'返运中',return_received:'退回查验'};
  const caseNames={restore:'客户恢复',claim:'承运索赔',rma:'退回 / RMA'};
  function handoff(o,f,files){
    const latest=f?.attempts?.at(-1);
    const pod=files.some(x=>x.category==='pod');
    const track={
      new:['F02','仓库','核验合格库存并锁定 '+o.quantity+' 台 '+o.model,'待录逐台 SN 与验机放行号'],
      ready:o.pickup?['F05','仓库','核提货授权并在原仓逐台签交',pod?'已关联 POD，请核对实际签收人':'待提货授权号、签收人和 POD']:
        ['F04','调度','核 12 项放行依据，签发本票委托','待实际执行车组、确认窗口与批准全价'],
      dispatched:['F04','执行车组','按本票委托提货并登记发车','核实到仓车组、货况与交接依据'],
      at_station:['F04','调度 / 仓库','由接收站签发第二程放行','待第二程执行人、承接方与放行凭据'],
      exception:['F06','调度 / 客服','按当前保管和已批准方案恢复作业',o.next_step || '待记录处理结果与恢复依据'],
      delivered:o.addon_l5&&!o.result_ref?['F07','技术服务','根据授权逐台测试并留存客户验收','待技术验收结果号']:
        ['F08','财务','核报价、批准变更、作业与发票','待登记实结金额及发票号'],
      settled:['F08','财务','已核账归档','已登记实结依据，可查随单凭证与操作记录']
    };
    if(o.status==='in_transit'&&['C1','C2'].includes(o.route))return ['F05','接收站 / 仓库','按 SN 核货况、接手人与库位','待接收站、当前保管人和入站回执'];
    const now=track[o.status] || ['F05','执行车组','逐台核合同终点，交接后登记签收',pod?'已关联 POD，请核对签收位置与未完成项':'待到场结果、签收人、实际位置及 POD'];
    if(o.status==='new' && !o.pickup && (o.lat==null||o.lng==null))now[3]+='。待补合同终点坐标，补齐后可地图排线。';
    if(latest && latest.outcome!=='success' && f.rights.attempt)now[3]='上次'+resultNames[latest.outcome]+' · '+latest.next_step;
    if(o.status==='settled' && f?.receipt?.state==='open')return ['F05','渠道 / 客服','跟进平台接收差异（运费已结）',f.receipt.next_step];
    const openCase=f?.cases?.find(c=>c.state!=='closed');
    if(o.status==='settled' && openCase)return [openCase.kind==='restore'?'F07':'F06',openCase.owner||'售后',
      caseNames[openCase.kind]+'工单待跟进 · '+openCase.id,openCase.next_step||'按关联工单的授权及期限办理'];
    return now;
  }
  const subnote = t=>`<p class="wf-subnote">${esc(t)}</p>`;
  function folderPanel(key,title,badge,content,focus){
    return `<details class="wf-stage"${key===focus?' open':''}><summary><span class="wf-code">${key}</span><strong>${title}</strong><small>${esc(badge)}</small></summary><div>${content}</div></details>`;
  }
  function fileRefs(files,category){
    const matches=files.filter(x=>x.category===category);
    return matches.length?`<div class="wf-refs">${matches.map(x=>`<button type="button" data-download="${esc(x.id)}">↓ ${esc(x.name)}</button>`).join('')}</div>`:'';
  }
  function folderBody(ctx,data,focus){
    const {order:o,files=[],events=[],folder:f}=data;
    const panel=(key,title,badge,content)=>folderPanel(key,title,badge,content,focus);
    const list=(arr,show)=>`<ul class="wf-related">${arr.map(x=>`<li>${show(x)}</li>`).join('')}</ul>`;
    const quotes=f?.quotes,assets=f?.assets,cases=f?.cases, attempts=f?.attempts||[],receipt=f?.receipt;
    const q=Array.isArray(quotes)?o.selected_quote:null;
    const ex=events.filter(x=>['exception','resolve','revise_window','unrelease'].includes(x.action));
    const pod=files.filter(x=>x.category==='pod').length;
    const tech=cases?.filter(c=>c.kind==='restore')||[], recovery=cases?.filter(c=>c.kind!=='restore')||[];
    const casesHtml=arr=>arr.length?list(arr,c=>`<b>${esc(caseNames[c.kind])} · ${esc(c.id)}</b><small>${esc(c.state==='closed'?'已关闭':'处理中')} · ${esc(c.sn)} · ${esc(c.owner)} · ${esc(c.issue)}</small>`):'';
    const work=attempts.length?list(attempts,a=>`<b>第 ${esc(a.ordinal)} 次 · ${esc(resultNames[a.outcome])}</b><small>${esc(localTime(a.arrival_local))} — ${esc(localTime(a.finished_local))} · ${esc(a.timezone)} · ${esc(a.location)}</small>
      ${a.units.map(u=>`<small>${esc(u.sn)} · ${esc(resultNames[u.outcome])} · ${esc(u.details)}</small>`).join('')}<small>凭据 ${esc(a.evidence)}${a.next_step?' · 当前保管 '+esc(a.custodian)+' · 待办 '+esc(a.next_step):''}</small>`):subnote('尚无独立的实际到场记录。');
    const rec=receipt?`<div class="wf-hint"><b>平台实收 · ${receipt.state==='closed'?'已核结':'待跟进'}</b><br>货件 ${esc(receipt.shipment_ref)} · 仓签 ${esc(receipt.signed_qty)} 台 / 平台 ${esc(receipt.received_qty)} 台<br>${esc(receipt.owner)} · ${esc(receipt.next_step||receipt.resolution)}${receipt.due?' · 当地期限 '+esc(localTime(receipt.due)):''}<br>依据 ${esc(receipt.evidence)}</div>`:'';
    const qLines=Array.isArray(quotes)?list(quotes,x=>`<b>${esc(x.carrier)} · USD ${esc(x.amount)} · ${esc(x.path)}</b><small>${esc(x.scope)} · 有效至 ${esc(x.valid_until)} · ${esc(x.evidence)}</small>`):'';
    return panel('F01','客户承诺与现场',o.level+(o.addon_l4?' + L4':'')+(o.addon_l5?' + L5':''),
        kv(o,['crm_ref','customer','contact','endpoint','address','city','state','zip','lat','lng','delivery_actions','exclusions','site_note','original_window_start','original_window_end','original_timezone','notes'])+fileRefs(files,'site'))+
      panel('F02','库存与持货仓',assets?assets.length+' 台已关联':(o.sn?'已录 SN':'待锁机'),
        kv(o,['warehouse','model','quantity','sn','release_ref'])+(assets?.length?list(assets,a=>`<b>${esc(a.sn)} · ${esc(assetNames[a.state]||a.state)}</b><small>${esc(a.model)} · 原仓 ${esc(a.warehouse)} / 库位 ${esc(a.bin)} · 入库批次 ${esc(a.batch)} · ${esc(a.evidence)}</small>`):'')+fileRefs(files,'release'))+
      panel('F03','选商与同范围报价',q?'已选报价':quotes?quotes.length+' 份关联报价':o.pickup?'仓口自提':'按权限可见',
        (q?subnote('中选 '+q.id+' · '+q.carrier+' · USD '+q.amount+' · 审批 '+q.approval_ref):o.checks?.price&&quotes?subnote('随单价格依据 · '+o.checks.price):'')+
        (quotes?.length?qLines:subnote(o.pickup?'仓口自提按约核仓口费用。':quotes?'尚无本票报价。':'报价明细由采购、调度与财务岗位查阅。'))+fileRefs(files,'quote'))+
      panel('F04','放行、派车与站序',o.release_route?'第 '+o.release_route.stop+' / '+o.release_route.stops+' 站':o.dispatch_ref?'已有委托号':'待确认',
        subnote(routeNotes[o.pickup?'pickup':o.route]||'')+kv(o,['carrier','driver','dispatch_ref','handoff_ref','station_name','receipt_ref','custodian','release_route','window_start','window_end','timezone','checks']))+
      panel('F05','到场、分段交接与签收',attempts.length+' 次到场 · '+pod+' 份 POD',
        kv(o,['signer','delivered_at','delivery_note','station_name','receipt_ref'])+work+rec+fileRefs(files,'pod')+
        `<div class="wf-refs">${f?.rights.attempt?btn('attempt','登记本次到场'):''}${f?.rights.receipt&&receipt?.state!=='closed'?btn('platform_receipt',receipt?'跟进平台实收':'登记平台实收 / 差异'):''}</div>`)+
      panel('F06','异常、改约与责任',ex.length+' 条可见记录'+(recovery.length?' · '+recovery.length+' 张工单':''),
        kv(o,['reason','next_step','resolution'])+(ex.length?list(ex,x=>`<b>${esc(names[x.action])} · ${esc(x.actor)}</b><small>${esc(timestamp(x.ts))}（查看地）</small>`):subnote('暂无可见异常记录。'))+casesHtml(recovery))+
      panel('F07','技术启用与客户恢复',o.result_ref?'已验收':o.addon_l5?'已购 L5':'未购 L5',
        (o.result_ref?kv(o,['result_ref']):subnote(o.addon_l5?'物理签交后由授权岗位登记技术验收结果。':'本票无另购技术启用。'))+
        (o.service_units?.length?list(o.service_units,u=>`<b>${esc(u.sn)} · ${esc(u.result)}</b>${u.customer_ref?`<small>客户确认 · ${esc(u.customer_ref)}</small>`:''}`):'')+casesHtml(tech)+fileRefs(files,'service'))+
      panel('F08','成本、发票与核账',o.status==='settled'?'已核账':ctx.user.role==='driver'?'财务经办':'待核账',
        (ctx.user.role==='driver'?subnote('财务核账依据按岗位查看。'):kv(o,['approved_cost','change_cost','change_ref','actual_cost','variance_cost','variance_ref','invoice_ref']))+fileRefs(files,'invoice'));
  }
  function details(ctx,data,modal,tab='overview') {
    const {order:o,events=[],files=[]}=data,{body,el}=modal;
    if (!el.open) return;
    const primary=next(o);
    const step=handoff(o,data.folder,files);
    const controls=['edit','upload','note','revise_window','unrelease','exception'].filter(k=>can(o,k));
    const tabs={overview:'随单作业夹',evidence:'凭证 · '+files.length,log:'轨迹 · '+events.length};
    body.innerHTML=summary(o)+`<div class="wf-handoff"><div class="wf-handoff-body"><small>${esc(step[0])} · ${o.status==='settled'&&step[0]==='F08'?'归档岗位':'下一经办岗'} / ${esc(step[1])}</small><b>${esc(step[2])}</b><p>${esc(step[3])}</p></div>
      <div class="wf-handoff-actions">${data.folder?.rights.attempt?btn('attempt','登记到场'):''}${primary?btn(primary,names[primary],'wf-primary'):''}</div></div>`+
      `<div class="wf-commands">${controls.map(k=>btn(k,names[k],k==='exception'?'wf-risk':'')).join('')}</div>
      <div class="wf-tabs">${Object.entries(tabs).map(([k,v])=>`<button type="button" data-tab="${k}" aria-pressed="${tab===k}">${esc(v)}</button>`).join('')}</div><div class="wf-tab-body"></div>`;
    const pane=body.querySelector('.wf-tab-body');
    if(tab==='log'){
      pane.innerHTML=events.length?`<ol class="wf-log">${events.map(e=>`<li><div><b>${esc(names[e.action] || (e.action==='create'?'创建订单':e.action))}</b> <small>${esc(e.actor)} · ${esc(timestamp(e.ts))}（查看地）</small></div><p>${recordNote(e)}</p></li>`).join('')}</ol>`:'<div class="wf-empty">当前身份暂无可见轨迹。</div>';
    }else if(tab==='evidence'){
      pane.innerHTML=files.length?`<ul class="wf-files">${files.map(f=>`<li><div><b>${esc(f.name)}</b><small>${esc(cats[f.category] || f.category)} · ${esc(f.actor)} · ${esc(timestamp(f.ts))}（查看地）</small></div><button data-download="${esc(f.id)}" type="button">下载</button></li>`).join('')}</ul>`:
        '<div class="wf-empty"><b>尚无可见凭证</b><p>上传按票归档的回单、委托或现场照片。签交前须有 POD。</p></div>';
    }else{
      pane.innerHTML=(o.status==='exception'?`<div class="wf-warning"><b>货物已挂起 · ${esc(o.reason || '见协作轨迹')}</b><p>当前保管 · ${esc(o.custodian || '待明确')}<br>下一步 · ${esc(o.next_step || '待确认')}</p></div>`:'')+
        (data.folderError?`<div class="wf-warning" role="alert">${esc(data.folderError)} <button data-reload>重新读取</button></div>`:
          folderBody(ctx,data,step[0]));
    }
    body.onclick=async e=>{
      const b=e.target.closest('button');if(!b)return;
      if(b.hasAttribute('data-reload'))loadDetail(ctx,o.id,modal);
      else if(b.dataset.tab)details(ctx,data,modal,b.dataset.tab);
      else if(b.dataset.download){
        const f=files.find(file=>String(file.id)===b.dataset.download);
        if(!f)return;
        if(ctx.downloadFile){try{await ctx.downloadFile(f.id,f.name);}catch(err){ctx.toast?.(msg(err));}}
        else {
          const a=document.createElement('a');
          a.href='/api/files/'+encodeURIComponent(f.id);a.download=f.name;document.body.append(a);a.click();a.remove();
        }
      }else if(['attempt','platform_receipt'].includes(b.dataset.cmd))folderForm(ctx,data,modal,b.dataset.cmd);
      else if(b.dataset.cmd)actForm(ctx,data,modal,b.dataset.cmd);
    };
  }
  function base64(file) {
    return new Promise((res,rej)=>{
      const reader=new FileReader();reader.onload=()=>res(String(reader.result).split(',')[1]);
      reader.onerror=()=>rej(Error('无法读取附件，请重新选择文件。'));reader.readAsDataURL(file);
    });
  }
  function folderForm(ctx,data,modal,cmd) {
    const {el,body}=modal,{order:o,folder}=data;
    const isAttempt=cmd==='attempt',r=folder?.receipt;
    if(!folder?.rights[isAttempt?'attempt':'receipt'] || (!isAttempt && r?.state==='closed'))return;
    const serials=String(o.sn||'').split(/[,，;；\r\n]+/).map(s=>s.trim()).filter(Boolean);
    const latest=folder.attempts.at(-1);
    const outcomeOptions={'':'按实际选择',success:resultNames.success,partial:resultNames.partial,failed:resultNames.failed};
    const qty={type:'number',req:true,extra:'min="0" max="'+Number(o.quantity)+'" step="1"'};
    body.onclick=null;
    body.innerHTML=`<form class="wf-form"><div class="wf-action-title"><small class="wf-overline">F05 / ${esc(o.id)}</small>
      <h3>${isAttempt?'登记第 '+(folder.attempts.length+1)+' 次实际到场':'核对平台实收'}</h3><p>${isAttempt?'记录每台 SN 在本次现场完成的动作。实际到场与作业结束均用订单当地时间。':'核对货件与逐台标签。仓口签收、平台接收数和运费各自留痕。'}</p></div>
      <div class="wf-hint">作业时区 · ${esc(o.timezone)}${isAttempt&&latest?' · 上次 '+esc(localTime(latest.arrival_local))+' / '+esc(resultNames[latest.outcome]):''}</div>
      <div class="wf-grid">${isAttempt?
        field('arrival_local','实际到场','',{req:true,type:'datetime-local'})+field('finished_local','本次作业结束','',{req:true,type:'datetime-local'})+
        field('location','实际交接位置','',req)+field('evidence','现场记录 / 影像凭据号','',req)+
        serials.map((sn,i)=>`<div class="wf-unit wf-full"><b>${esc(sn)}</b><div class="wf-grid">${field('outcome'+i,'本次结果','',{opts:outcomeOptions,req:true})}${field('details'+i,'实际位置、已做 / 未做及原因','',req)}</div></div>`).join('')+
        field('custodian','未完成时的实物保管人','')+field('next_step','未完成项、责任人及下次安排','') :
        (r?`<div class="wf-hint wf-full">货件 ${esc(r.shipment_ref)} · 原仓签 ${esc(r.signed_qty)} 台</div>`:field('shipment_ref','平台货件号','',req)+field('signed_qty','仓口签收台数',o.quantity,qty))+
        field('received_qty','平台当前接收台数',r?.received_qty??'',qty)+field('state','本次处理','open',{req:true,opts:{open:'继续跟进平台查询',closed:'已有明确结果 · 核结'}})+
        field('owner','经办人',r?.owner||ctx.user.name,req)+field('evidence','平台查询编号 / 处理凭据','',req)+
        '<div data-receipt-next class="wf-full wf-grid">'+field('next_step','下一步',r?.next_step||'',req)+field('due','下次反馈期限',r?.due||'',{req:true,type:'datetime-local'})+'</div>'+
        '<div data-receipt-end class="wf-full">'+field('resolution','最终接收、差异原因与批准处置','',{area:true,req:true})+'</div>'}</div>${formEnd(isAttempt?'保存实际到场':'保存实收记录')}</form>`;
    const form=body.querySelector('form');
    form.querySelector('[data-cmd=back]').onclick=()=>details(ctx,data,modal);
    if(!isAttempt){
      function visibility(){
        const closed=form.elements.state.value==='closed';
        for(const [name,visible] of [['next',!closed],['end',closed]]){
          const group=form.querySelector('[data-receipt-'+name+']');group.hidden=!visible;
          group.querySelectorAll('input,textarea').forEach(x=>x.disabled=!visible);
        }
      }
      form.elements.state.onchange=visibility;visibility();
    }
    submitter(form,async fd=>{
      const p=Object.fromEntries(fd);
      if(isAttempt){
        p.units=serials.map((sn,i)=>({sn,outcome:p['outcome'+i],details:p['details'+i]}));
        for(let i=0;i<serials.length;i++){delete p['outcome'+i];delete p['details'+i];}
        if(p.units.some(u=>u.outcome!=='success') && (!p.custodian.trim()||!p.next_step.trim()))throw Error('有未完成项，请补实物保管人与下一步安排。');
      }else{
        if(!r)p.signed_qty=Number(p.signed_qty);
        p.received_qty=Number(p.received_qty);
      }
      await ctx.api('/api/ops/folder/'+encodeURIComponent(o.id)+(isAttempt?'/attempts':'/receipts'),{method:'POST',body:{...p,version:o.version}});
      ctx.toast?.('已归入本票 F05');await refreshAfterSave(ctx);if(el.open)await loadDetail(ctx,o.id,modal);
    },()=>loadDetail(ctx,o.id,modal));
  }
  async function uploadFile(ctx,o,file,category) {
    if(!file?.size)throw Error('请选择附件。');
    if(file.size>5*1024*1024)throw Error('每份凭证上限 5 MiB。');
    return ctx.api('/api/orders/'+encodeURIComponent(o.id)+'/files',{method:'POST',body:{
      version:o.version,category,name:file.name,base64:await base64(file)
    }});
  }
  const rolesToFiles = role => role==='driver'?{pod:cats.pod,site:cats.site,other:cats.other}:cats;
  const checks={leg:'票号与本段委托',stock:'持货仓与 SN',package:'包装外廓及重量',vehicle:'车门、尾板与工具',
    endpoint:'合同交接点',site:'现场准入与通道',authority:'执行人与授权',window:'仓方与收货时窗',
    papers:'所需单据',price:'本段与全程报价',fallback:'失败及保管安排',release:'签发人及依据'};
  function actionFields(o,action,drivers,files,role,assets,plans) {
    const f=(k,c={})=>field(k,labels[k]||k,c.prefill?o[k]:'',{req:true,...c});
    const date=k=>f(k,{type:'datetime-local',prefill:true});
    const driver=()=>field('driver','司机账号','',{req:true,opts:{'':'选择实际执行的司机',...Object.fromEntries(drivers.map(d=>[d.username,d.name+' · '+d.username]))}});
    const planField=()=>field('route_id','关联已排线路（可选）','',{full:true,
      opts:{'':'独立派单',...Object.fromEntries(plans.map(p=>[p.id,p.name+' · '+p.date+' · 第 '+(p.order_ids.indexOf(o.id)+1)+' / '+p.order_ids.length+' 站']))},
      hint:plans.length?'签发后，司机可在本票查看线路名、日期和站序。':'暂无包含此票当前版本的同起点排线，可独立派单。'});
    const upload=(mandatory,label='选择凭证')=>field('file',label,'',{req:mandatory,full:true,type:'file',extra:'accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/jpeg,image/png"',hint:'支持 PDF、PNG、JPEG，单个文件不超过 5 MiB。'});
    switch(action) {
      case 'ready':return (assets.length?`<div class="wf-full wf-stock"><strong>${esc(o.warehouse)} · ${esc(o.model)} · 合格库存</strong>
        <div>${assets.map(a=>`<label><input type="checkbox" data-sn="${esc(a.sn)}"> <b>${esc(a.sn)}</b> <small>${esc(a.bin||'')}</small></label>`).join('')}</div></div>`:
        '<div class="wf-full wf-warning">当前没有同仓同型号的合格设备。先到逐台库存登记实收、库位和验收依据。 <button type="button" data-inventory>查看逐台库存</button></div>')+
        f('sn',{area:true,full:true,ph:'从合格库存勾选，或逐行录入序列号',hint:'订单台数 '+o.quantity+'，提交时会再次核实每台库存。'})+f('release_ref',{full:true,ph:'仓库验机单或放行凭证号'});
      case 'dispatch':return planField()+driver()+field('carrier',labels.carrier,o.selected_quote?.carrier||'',req)+f('dispatch_ref')+
        field('approved_cost','批准全价（USD）',o.selected_quote?.amount??'',{req:true,type:'number',extra:'min="0" max="999999999" step=".01"',hint:o.selected_quote?'依据已签选报价 '+o.selected_quote.id:undefined})+
        (['C1','C2'].includes(o.route)?f('handoff_ref',{full:true,ph:'接收人、站方与后续车组的确认依据'}):'')+date('window_start')+date('window_end')+
        '<div class="wf-full wf-hint"><b>F04 发车前核验</b><br>逐项填实测结果、回执号或不适用原因。同一份放行单可引用对应行号。</div>'+
        Object.entries(checks).map(([k,v],i)=>field('check_'+k,String(i+1).padStart(2,'0')+' · '+v,k==='price'&&o.selected_quote?[o.selected_quote.id,o.selected_quote.ref,o.selected_quote.approval_ref].filter(Boolean).join(' / '):'',{req:true,extra:'minlength="3" maxlength="512"',ph:'凭据号、实测值或说明'})).join('');
      case 'station_receive':return f('station_name')+f('custodian')+f('receipt_ref',{full:true});
      case 'station_release':return planField()+driver()+f('carrier')+f('dispatch_ref',{full:true});
      case 'pickup':case 'deliver':{
        const pod=files.filter(x=>x.category==='pod');
        return (action==='pickup'?f('dispatch_ref',{ph:'本次有效的授权提货号'})+
          field('approved_cost','仓口批准费（USD）','0',{req:true,type:'number',extra:'min="0" max="999999999" step=".01"'}):'')+f('signer')+
          f('delivered_at',{type:'datetime-local',hint:zoneText(o)})+
          f('delivery_note',{area:true,full:true,ph:'逐台 SN、签收位置、已完成动作及实物状态'})+
          (pod.length?`<div class="wf-hint wf-full">已关联签收回单 · ${pod.map(x=>esc(x.name)).join('、')}</div>`:'')+
          upload(!pod.length,pod.length?'补充 POD（可选）':'上传签收回单 POD');
      }
      case 'exception':return f('reason',{area:true,full:true,ph:'中断环节、发现时刻和已知事实'})+f('custodian',{full:true,ph:'当前位置与实际保管人'})+f('next_step',{area:true,full:true,ph:'下一位经办人、待办及回复时限'});
      case 'resolve':return f('resolution',{area:true,full:true,ph:'处置经过、批准人、客户确认和所恢复的工作'});
      case 'service_complete':{
        const serials=String(o.sn||'').split(/[,，;；\r\n]+/).map(x=>x.trim()).filter(Boolean);
        return f('result_ref',{full:true,ph:'授权人员、技术验收结论及客户签认的总回执号'})+(serials.length>1?serials.map((sn,i)=>
          `<div class="wf-unit wf-full"><b>${esc(sn)}</b><div class="wf-grid">${field('test_result'+i,'逐台复测结果','',req)}${field('customer_ref'+i,'客户确认号','',req)}</div></div>`).join(''):'');
      }
      case 'settle':return `<div class="wf-hint wf-full"><b>已批预算 · USD ${esc(o.approved_cost ?? '待核')}</b><br>核对原委托与获批变更，差异须注明处理依据。</div>`+
        f('actual_cost',{type:'number',extra:'min="0" max="999999999" step="0.01"',ph:'0.00'})+f('invoice_ref')+
        field('change_cost','批准调整额（USD，可为负）','0',{req:true,type:'number',extra:'min="-999999999" max="999999999" step="0.01"'})+
        field('change_ref','变更审批号','',{ph:'有批准调整时必填'})+field('variance_ref','结算差异处置依据','',{full:true,ph:'实结与调整后预算不同时必填'});
      case 'note':return f('note',{area:true,rows:4,full:true});
      case 'revise_window':return date('window_start')+date('window_end')+f('reason',{area:true,full:true,ph:'说明改约提出方、确认人、授权依据'});
      case 'unrelease':return f('reason',{area:true,full:true});
      case 'upload':return field('category','凭证类别','pod',{req:true,full:true,opts:rolesToFiles(role)})+upload(true);
      case 'depart':return `<div class="wf-full">${facts(o,'将按以下委托发车',['warehouse','sn','carrier','driver','dispatch_ref','release_route','handoff_ref','window_start','window_end'])}</div>`;
      default:return '';
    }
  }
  async function actForm(ctx,data,modal,action) {
    const {order:o,files=[]}=data,{el,body}=modal;
    if(!can(o,action))return details(ctx,data,modal);
    if(action==='edit')return orderForm(ctx,o);
    body.onclick=null;
    let drivers=[],assets=[],plans=[];
    if(['dispatch','station_release','ready'].includes(action)){
      body.innerHTML='<div class="wf-empty">正在读取可用资源…</div>';
      try {
        if(action==='ready')assets=((await ctx.api('/api/lifecycle/assets')).records||[]).filter(a=>a.state==='available' && a.model===o.model && a.warehouse===o.warehouse);
        else {
          const [driverResult,planResult]=await Promise.all([ctx.api('/api/drivers'),ctx.api('/api/ops/routes')]);
          drivers=driverResult.drivers || [];
          const origin=action==='station_release'?o.station_name:o.warehouse;
          plans=(planResult.routes||[]).filter(p=>p.warehouse===origin && p.order_ids?.includes(o.id) && p.order_versions?.[o.id]===o.version);
        }
      }catch(e){if(el.open){errBox(body,e);body.insertAdjacentHTML('beforeend',btn('back','返回订单'));body.querySelector('button').onclick=()=>details(ctx,data,modal);}return;}
      if(!el.open)return;
    }
    body.innerHTML=`<form class="wf-form"><div class="wf-action-title"><small class="wf-overline">${esc(o.id)} / REV ${esc(o.version)}</small><h3>${esc(names[action])}</h3><p>${esc(help[action] || '选择随单文件及其业务类别。')}</p></div>
      ${(['dispatch','station_release'].includes(action)&&!drivers.length)?'<div class="wf-warning">当前没有可选司机账号，请管理员先创建并启用执行账号。</div>':''}
      ${(['dispatch','revise_window'].includes(action))?`<div class="wf-hint">预约使用作业地时间 · ${esc(zoneText(o))}（${esc(o.timezone)}）</div>`:''}
      <div class="wf-grid">${actionFields(o,action,drivers,files,ctx.user.role,assets,plans)}</div>${formEnd(action==='upload'?'上传凭证':names[action])}</form>`;
    body.querySelector('[data-cmd=back]').onclick=()=>details(ctx,data,modal);
    const form=body.querySelector('form');
    if(action==='ready'){
      const go=form.querySelector('[data-inventory]');
      if(go)go.onclick=()=>{el.close();ctx.navigate('inventory');};
      form.querySelectorAll('[data-sn]').forEach(box=>box.onchange=()=>{
        const selected=new Set(form.elements.sn.value.split(/[,，;；\r\n]+/).map(s=>s.trim()).filter(Boolean));
        if(box.checked)selected.add(box.dataset.sn);else selected.delete(box.dataset.sn);
        form.elements.sn.value=[...selected].join('\n');
      });
    }
    submitter(form,async fd=>{
      const payload=Object.fromEntries(fd);delete payload.file;
      if(action==='service_complete' && Number(o.quantity)>1){
        const serials=String(o.sn).split(/[,，;；\r\n]+/).map(x=>x.trim()).filter(Boolean);
        payload.service_units=serials.map((sn,i)=>({sn,result:fd.get('test_result'+i),customer_ref:fd.get('customer_ref'+i)}));
        for(let i=0;i<serials.length;i++){delete payload['test_result'+i];delete payload['customer_ref'+i];}
      }
      if(payload.route_id){
        const p=plans.find(p=>p.id===payload.route_id);
        if(!p)throw Error('请重新读取已保存的线路。');
        payload.route_version=p.version;
      }else delete payload.route_id;
      if(action==='dispatch'){
        payload.checks={};
        for(const k of Object.keys(checks)){payload.checks[k]=payload['check_'+k];delete payload['check_'+k];}
      }
      if(action==='settle'){
        const cents=x=>Math.round(Number(x)*100);
        if(cents(payload.change_cost) && !payload.change_ref.trim())throw Error('有批准调整时需要变更审批号。');
        if(cents(payload.actual_cost)!==cents(o.approved_cost)+cents(payload.change_cost) && !payload.variance_ref.trim())throw Error('实结与调整后预算存在差额，请补处置依据。');
      }
      if(payload.window_end && payload.window_start>=payload.window_end)throw Error('结束时间须晚于开始时间。');
      if(action==='upload'){
        await uploadFile(ctx,o,fd.get('file'),fd.get('category'));
      }else{
        // Saving the POD is a separate versioned transaction. An action retry reuses it.
        if(fd.get('file')?.size) {
          const saved=await uploadFile(ctx,o,fd.get('file'),'pod');
          data.order=saved.order;o.version=saved.order.version;
          files.push(saved.file);form.elements.file.value='';form.elements.file.required=false;
          const hint=form.elements.file.closest('label').querySelector('small');
          if(hint)hint.textContent='POD 已归档，重试登记签交时无需重复上传。';
        }
        await ctx.api('/api/orders/'+encodeURIComponent(o.id)+'/actions',{method:'POST',body:{...payload,version:o.version,action}});
      }
      ctx.toast?.(names[action]+'已登记');
      await refreshAfterSave(ctx);
      if(el.open)await loadDetail(ctx,o.id,modal,'',action==='upload'?'evidence':action==='note'?'log':'overview');
    },()=>loadDetail(ctx,o.id,modal));
  }
  async function loadDetail(ctx,id,modal,action='',tab='overview'){
    const {el,body}=modal;
    try {
      const [orderRead,folderRead]=await Promise.allSettled([ctx.api('/api/orders/'+encodeURIComponent(id)),ctx.api('/api/ops/folder/'+encodeURIComponent(id))]);
      if(orderRead.status!=='fulfilled')throw orderRead.reason;
      const result=orderRead.value;
      if(folderRead.status!=='fulfilled')result.folderError='关联凭据未能读取。'+msg(folderRead.reason);
      else if(result.order.version!==folderRead.value.version)result.folderError='其他岗位刚更新了订单，请重新读取随单资料。';
      else result.folder=folderRead.value;
      if(!el.open)return;
      if(action && can(result.order,action))await actForm(ctx,result,modal,action);
      else details(ctx,result,modal,tab);
    } catch(err){
      if(!el.open)return;
      errBox(body,err);body.insertAdjacentHTML('beforeend',btn('retry','重新读取'));
      body.querySelector('button').onclick=()=>loadDetail(ctx,id,modal,action,tab);
    }
  }
  function openOrder(ctx,id,action){
    const modal=dialog(String(id),'FULFILLMENT RECORD / 订单档案');
    modal.body.innerHTML='<div class="wf-empty">正在读取订单及可见凭证…</div>';
    return loadDetail(ctx,id,modal,action);
  }
  window.Workflow={mount,openOrder,newOrder:ctx=>orderForm(ctx)};
})();
