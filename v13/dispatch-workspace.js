'use strict';
/* One explicitly selected batch, shared by the map and date views. View filters
 * never mutate this record. Business validation remains in the Python service. */
window.DispatchWorkspace = (() => {
  const stores = new Map();
  const clone = x => JSON.parse(JSON.stringify(x));
  // Match planning.ROUTE_INPUT_FIELDS; solver output is not client input.
  const routeInputFields = new Set(['id','version','name','warehouse','date','start_time','timezone','order_ids','order_versions','resource_id','crew_id','executor_id','service_minutes','notes','road_basis','road_id','road','checks','stops','return_policy','collections','cost_scenario','rate_card_id']);
  const routeFacts = route => clone(Object.fromEntries(Object.entries(route).filter(([key])=>routeInputFields.has(key))));
  const adoptedCandidate = plan => plan.state==='adopted_pending_release'&&plan.validation_status!=='stale'&&typeof plan.adopted_candidate==='string'?plan.adopted_candidate:null;
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {no_feasible_candidates:'当前候选无可行方案',budget_exhausted_with_solution:'预算耗尽，已有可行解',timeout_no_solution:'限时未找到解',generated_candidates:'已生成候选集合内最优',verified_feasible:'已验证可行解',undetermined:'尚无最优性结论',lowest_cost:'低总价',earliest_finish:'较早完成',fewest_transfers:'少转运',delivery_complete:'完整履约',authorized_stage:'已授权阶段',passed:'校验通过',valid:'校验通过',pending:'条件待补',failed:'校验失败',stale:'输入已变更',completed:'计算完成',feasible:'已找到可行解',optimal:'候选集合内最优',not_proven:'未证明最优',not_started:'尚未计算',needs_confirmation:'条件待确认',conditions_pending:'条件待补',cancelled:'已取消'};
  const label = s => labels[s] || s || '待核';
  const day = (time, zone = 'America/Chicago') => new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
  const addDays = (value, n) => new Date(Date.parse(value+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  function open(ctx) {
    const dataset=ctx.dataset||(globalThis.location?new URLSearchParams(globalThis.location.search).get('dataset'):'')||'default';
    const key = 'haha-v13-plan:'+dataset+':'+ (ctx.publicDemo?'public':ctx.demo?'demo':'shared') + ':' + (ctx.user?.username || 'anonymous');
    if (stores.has(key)) return stores.get(key);
    let cached; try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
    const state = {plan_id:'LOCAL-'+(globalThis.crypto?.randomUUID?.()||Date.now()),version:0,order_ids:[],planning_scope:'delivery_complete',objective:'lowest_cost',timezone:'America/Chicago',candidates:[],routes:[],unassigned:[],assumptions:[],locks:{},view:{day:'',from:'',to:'',search:''},...cached,busy:false,error:'',listeners:new Set()};
    state.adopted_candidate_id=adoptedCandidate(state);
    const save = () => {try {const {listeners,busy,error,...data}=state;localStorage.setItem(key,JSON.stringify(data));} catch {}};
    const emit = () => {save();[...state.listeners].forEach(fn=>fn());};
    const invalidate = reason => {state.validation_status='stale';state.stale_reason=reason;state.precheck=null;state.adopted_candidate_id=null;state.adopted_candidate=null;state.version=(Number(state.version)||0)+1;};
    let pollEpoch=0;
    const inputKey=()=>JSON.stringify([state.order_ids,state.planning_scope,state.objective,state.locks,state.manual_routes||null]);
    const store = {state,emit,dataset,subscribe(fn){state.listeners.add(fn);return()=>state.listeners.delete(fn)},
      selection(ids, reason='订单范围已修改，请重新计算') {const next=[...new Set(ids.map(String))];if(JSON.stringify(next)===JSON.stringify(state.order_ids))return;state.undo={order_ids:state.order_ids.slice(),locks:clone(state.locks)};state.order_ids=next;invalidate(reason);emit();},
      edit(reason, patch={}) {Object.assign(state,patch);invalidate(reason);emit();},
      view(patch) {Object.assign(state.view,patch);save();},
      update(plan) {const selected=state.order_ids.slice();if(plan.validation_status==='passed')state.last_feasible=clone(plan);Object.assign(state,plan);state.plan_id=plan.plan_id||plan.id||state.plan_id;state.order_ids=plan.order_ids||selected;state.state=plan.state||null;state.adopted_candidate_id=adoptedCandidate(plan);state.adopted_candidate=state.adopted_candidate_id;state.stale_reason='';state.input_versions=plan.input_versions||state.input_versions;emit();},
      checkVersions(orders) {if(!state.input_versions)return;const map=new Map(orders.map(o=>[o.id,o.version]));if(state.validation_status!=='stale'&&Object.entries(state.input_versions).some(([id,v])=>map.get(id)!==v)){invalidate('订单版本已变化，请重新预检与计算');emit();}},
      active(){return state.candidates.find(c=>String(c.id)===String(state.active_candidate_id))||state.candidates[0]||null},
      routes(){return store.active()?.routes||state.routes||[]},
      drafts(){return (state.draft_routes||[]).filter(r=>!Array.isArray(r.issues)||r.issues.length>0)},
      stageRoute(route,index){const rows=state.manual_routes||clone(store.routes().length?store.routes():store.drafts());if(Number.isInteger(index)&&rows[index])rows[index]=clone(route);else {const old=rows.findIndex(r=>r._manual);route={...route,_manual:true};if(old>=0)rows[old]=clone(route);else rows.push(clone(route));}state.manual_routes=rows;save();},
      async pollJob(ctx,id) {
        const epoch=++pollEpoch;state.job_id=id;state.busy=true;emit();
        while(epoch===pollEpoch){
          const response=await ctx.api('/api/ops/jobs/'+encodeURIComponent(id));const job=response.job||response;
          state.job_state=job.state;emit();
          if(job.state==='completed')return job.result?.plan||job.result;
          if(job.state==='failed')throw Error(typeof job.error==='string'?job.error:job.error?.message||'计算任务失败，输入已保留');
          if(job.state==='cancelled')throw Error('计算已取消，原草案已保留');
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
        throw Error('计算结果已被更新的请求替代');
      },
      async cancel(ctx){if(!state.job_id)return;try{const response=await ctx.api('/api/ops/jobs/'+encodeURIComponent(state.job_id)+'/cancel',{method:'POST',body:{}});state.job_state=(response.job||response).state;emit();}catch(error){state.error=error.message;emit();}},
      async resume(ctx){if(!state.job_id||state.busy)return;const expected=state.job_input_key;try{const plan=await store.pollJob(ctx,state.job_id);if(!expected||inputKey()!==expected)throw Error('恢复的任务使用旧输入，结果未覆盖当前批次；请重新生成方案');if(plan){store.update(plan);state.input_versions=state.job_input_versions;state.manual_routes=null;state.active_candidate_id=state.candidates[0]?.id;}}catch(error){state.error=error.message;}finally{state.busy=false;emit();}},
      async act(ctx, action, candidateId) {
        if(state.busy)return;
        if(action==='optimize'&&!ctx.publicDemo&&state.job_id&&['queued','running'].includes(state.job_state)&&state.job_input_key===inputKey())return store.resume(ctx);
        if(action==='adopt'&&state.validation_status==='stale'){state.error='当前输入已变化，请重新生成方案后采用';emit();return;}
        if(!state.order_ids.length){state.error='请先明确加入本批计划的订单。';emit();return}
        state.busy=true;state.error='';const revision=state.version;emit();
        try {
          const payload={order_ids:state.order_ids.slice(),planning_scope:state.planning_scope,objective:state.objective,timezone:state.timezone,locks:state.locks,budget_seconds:ctx.publicDemo?30:120,calculate_roads:!ctx.publicDemo&&!!ctx.routingEnabled};if(state.manual_routes?.length)payload.route_candidates=state.manual_routes.map(routeFacts);
          if(action==='precheck'){const result=await ctx.api('/api/ops/plans/precheck',{method:'POST',body:payload});if(state.version!==revision)throw Error('预检期间输入已变化，请重新预检');state.precheck=result;}
          else if(action==='optimize') {let response;
            if(ctx.publicDemo)response=await ctx.api('/api/ops/plans/optimize',{method:'POST',body:payload});
            else {
              const key=inputKey();if(!state.pending_job_request||state.pending_job_request.input!==key)state.pending_job_request={input:key,idempotency_key:'ui:'+ (globalThis.crypto?.randomUUID?.()||Date.now())};
              state.job_input_key=key;state.job_input_versions=Object.fromEntries((ctx.orders||[]).filter(o=>state.order_ids.includes(o.id)).map(o=>[o.id,o.version]));emit();
              const created=await ctx.api('/api/ops/jobs',{method:'POST',body:{...payload,idempotency_key:state.pending_job_request.idempotency_key}});
              state.pending_job_request=null;state.job_state=(created.job||created).state;
              response=await store.pollJob(ctx,(created.job||created).id);
            }
            if(state.version!==revision)throw Error('计算期间订单或约束已变化；迟到结果未覆盖当前批次，请重新计算');
            store.update(response.plan||response);state.input_versions=Object.fromEntries((ctx.orders||[]).filter(o=>state.order_ids.includes(o.id)).map(o=>[o.id,o.version]));state.active_candidate_id=state.candidates[0]?.id;state.manual_routes=null;}
          else if(action==='adopt') {const response=await ctx.api('/api/ops/plans/'+encodeURIComponent(state.plan_id)+'/adopt',{method:'POST',body:{version:state.version,candidate_id:candidateId,idempotency_key:'adopt:'+state.plan_id+':'+state.version+':'+candidateId}});if(state.version===revision){store.update(response.plan||response);}else {state.error='原计划已采用为草案；当前修改后的批次已保留，请重新计算。';state.last_adopted_plan=(response.plan||response).plan_id;}ctx.toast?.('方案已采用为草案，正式签发仍须逐段核验。');await ctx.refresh?.();}
        } catch(error) {state.error=error.message||'请求失败，计划已保留。';}
        finally {state.busy=false;emit();}
      }
    };
    stores.set(key,store);return store;
  }
  function money(value,currency='USD') {if(value===null||value===undefined||!Number.isFinite(Number(value)))return '费用待齐';if(!/^[A-Z]{3}$/.test(currency))return (Number(value)/100).toFixed(2)+'（币种待核）';return new Intl.NumberFormat('zh-CN',{style:'currency',currency}).format(Number(value)/100);}
  function time(value, zone) {if(value===undefined||value===null||value==='')return '时间待核';const t=typeof value==='number'&&value<1e12?value*1000:value;if(typeof t==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)&&!/(Z|[+-]\d{2}:?\d{2})$/.test(t))return t.replace('T',' ')+'（原始当地时间）';if(!Number.isFinite(new Date(t).getTime()))return String(value);return new Intl.DateTimeFormat('zh-CN',{timeZone:zone||'America/Chicago',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t));}
  const issuesHTML = issues => (issues||[]).flatMap(x=>x?.reasons?.length?x.reasons.map(r=>({...r,object_id:r.object_id||x.order_id})): [x]).map(x=>'<li><b>'+esc(x.object_id||x.order_id||'本批')+' · '+esc(x.message||x.reason||x.code||x)+'</b>'+(x.field?'<code>'+esc(x.field)+'</code>':'')+'<small>'+esc(x.next_step||'打开原单补正后重新核验')+'</small></li>').join('');
  function routeSegments(route) {
    const base=route.segments?.length?route.segments:[route], future=route.future_segments||[], rows=[];
    const same=(a,b)=>a===b||Boolean(a.id&&b.id&&a.id===b.id);
    for(const segment of [...base,...future])if(!rows.some(x=>same(x.route,segment)))rows.push({route:segment,future:future.some(x=>same(x,segment))||base.indexOf(segment)>0});
    return rows;
  }
  function routeView(route) {
    const segments=routeSegments(route),special=segments.some(x=>['pickup','supplier_commitment'].includes(x.route.kind));
    const readOnly=special||segments.length>1||Boolean(route.technical_tasks?.length);
    const title=route.kind==='pickup'?'仓口自提 · 无配送车辆':route.kind==='supplier_commitment'?'承运商网络委托':segments.length>1?'完整履约链 · 分段执行':route.technical_tasks?.length?'配送与独立技术任务':'配送车次';
    return {segments,readOnly,title};
  }
  function roadPreview(route, ctx, now=Date.now()) {
    if(route.road_basis!=='valhalla_truck'||!Array.isArray(route.road?.geometry)||route.road.geometry.length<2)return null;
    const versions=new Map((ctx.resources||[]).map(x=>[x.id,x.version])),orders=new Map((ctx.orders||[]).map(x=>[x.id,x.version]));
    const reasons=[],road=route.road,stamp=Date.parse(road.timestamp);
    if(!ctx.routingEnabled)reasons.push('当前道路服务未启用');
    if(!road.resources||Object.entries(road.resources).some(([id,v])=>versions.get(id)!==v))reasons.push('道路资源版本缺失或已变');
    if((route.order_ids||[]).some(id=>route.order_versions?.[id]!==orders.get(id)))reasons.push('订单版本已变');
    if(!Number.isFinite(stamp)||now-stamp>3600000||stamp>now+300000)reasons.push('道路时效待重核');
    return {...road,stale:Boolean(road.stale||reasons.length),stale_reason:reasons.join('；')};
  }
  function timelineHTML(route, orders=[], zone='America/Chicago', mapMode=false) {
    const byId=new Map(orders.map(o=>[o.id,o])),view=routeView(route);
    const button=id=>id?(mapMode?'<button data-act="open" data-id="'+esc(id)+'">原单</button>':'<button data-open="'+esc(id)+'">原单</button>'):'';
    const item=(mark,title,lines,id='')=>'<li><span>'+esc(mark)+'</span><div><b>'+esc(title)+'</b>'+lines.map(x=>'<small>'+esc(x)+'</small>').join('')+'</div>'+button(id)+'</li>';
    let html='<p class="uw-capability">'+esc(view.title)+' · 时间轴显示 '+esc(zone)+'。以下为计划时刻，不代表实际签收或技术完成。</p>';
    for(const [index,{route:r,future}] of view.segments.entries()){
      const commitment=r.kind==='supplier_commitment',pickup=r.kind==='pickup';
      const title=pickup?'仓口授权交接':commitment?'承运商承诺时段':(future?'后程预排':'当前运段')+' · 第 '+(index+1)+' 段';
      html+='<section class="uw-timeline-stage"><h4>'+esc(title)+'</h4>';
      if(future)html+='<p class="uw-notice">后程依赖实际到站实收、站内处理和重新核验；当前采用不会自动签发后程。</p>';
      let stops=r.check_result?.timeline||r.timeline||r.schedule||[];
      if(!Array.isArray(stops)||!stops.length)stops=(r.order_ids||[]).map(id=>({id,...(r.stops?.[id]||{})}));
      html+='<ol class="uw-timeline">';
      if(pickup||commitment){
        html+=item(pickup?'▣':'◇',pickup?'仓口自提 · 无配送车辆':'承运商网络委托 · 具体车辆由承运方确认',[
          '交接仓 / 发仓：'+(r.warehouse||'待核'),
          '承诺 '+time(r.check_result?.start_utc||r.commitment?.start,zone)+' — '+time(r.check_result?.end_utc||r.commitment?.end,zone),
          pickup?'授权提货人 '+(r.commitment?.authorized_collector||'待核')+' · 身份依据 '+(r.commitment?.identity_ref||'待核'):'书面承接 '+(r.commitment?.acceptance_ref||'待核')+' · 容量池 '+(r.commitment?.pool_key||'待核'),
          '逐票 '+(r.order_ids||[]).join('、')+'；完成须回原单登记实际交接凭据'],r.order_ids?.[0]);
      }else{
        html+=item('▣','提货 · '+(r.warehouse||r.origin||'实际仓待核'),[time(r.check_result?.start_utc||r.start_utc||r.departure_utc,zone),'车辆 '+(r.resource_id||r.vehicle_id||'待核')+' · 班组 '+(r.crew_id||'待核')]);
        for(const [i,st] of stops.entries()){
          const id=st.order_id||st.id,o=byId.get(id)||{},fact=r.stops?.[id]||{},handoff=(r.first_leg_ids||[]).includes(id);
          const travel=st.travel_seconds==null?fact.travel:st.travel_seconds/60,admission=st.admission_seconds==null?fact.admission:st.admission_seconds/60;
          const elapsed=(Date.parse(st.service_start_utc??st.start_utc??st.start)-Date.parse(st.arrival_utc??st.arrival))/60000;
          const waiting=st.wait_seconds==null?(Number.isFinite(elapsed)&&admission!=null?Math.max(0,elapsed-Number(admission)):null):st.wait_seconds/60;
          html+=item(i+1,id+' · '+(handoff?'到站交接':st.action||o.city||'交付')+' · '+(o.quantity||st.quantity||'—')+' 台',[
            handoff?'接收站 '+(fact.station_id||route.dependencies?.find(d=>d.order_id===id)?.station_id||'待核')+'；客户末端仍需后程':(o.level||'终点待补')+(o.addon_l4?' + L4':'')+(o.addon_l5?' + L5':'')+' · '+(o.timezone||'地点时区待核'),
            '预约 '+((handoff?fact.window_start:o.window_start)||'待补')+' — '+((handoff?fact.window_end:o.window_end)||'待补'),
            '到场 '+time(st.arrival_utc??st.arrival,zone)+' → 开工 '+time(st.service_start_utc??st.start_utc??st.start,zone)+' → 离场 '+time(st.departure_utc??st.departure??st.end_utc??st.end,zone),
            '行驶 '+(travel??'待核')+' 分 · 准入 '+(admission??'待核')+' 分 · 候场 '+(waiting??'待核')+' 分',
            '作业 '+(st.service_minutes??fact.service??(st.service_seconds==null?'待核':st.service_seconds/60))+' 分 · 卸毕 '+time(st.unload,zone)],id);
        }
        html+=item('↩','本段结束 / 回程 · '+(r.end_location||r.return_warehouse||r.warehouse||'待核'),[time(r.check_result?.end_utc||r.return_utc||r.end_utc||r.finish,zone),r.road_basis||'道路依据待齐']);
      }
      html+='</ol></section>';
    }
    if(route.dependencies?.length)html+='<div class="uw-notice">'+route.dependencies.map(d=>esc(d.order_id+'：实际到站实收 '+(d.station_id||'待核站')+' → 站内处理 '+(d.processing_minutes??'待核')+' 分；容量依据 '+(d.capacity_evidence||'待核'))).join('<br>')+'</div>';
    if(route.technical_tasks?.length)html+='<section class="uw-timeline-stage"><h4>L5 独立技术预排 · 物理交付之后</h4><ol class="uw-timeline">'+route.technical_tasks.map(t=>item('L5',t.order_id+' · 技师 '+(t.technician||'待核'),['开始 '+time(t.start_utc,zone)+' → 完成 '+time(t.end_utc,zone),'委托 '+(t.authorization_ref||'待核')+'；须独立登记技术验收结果，物理签收不代表技术完成'],t.order_id)).join('')+'</ol></section>';
    return html;
  }
  function panel(host,ctx,onRoute) {
    const store=open(ctx), s=store.state;
    const edit=()=>['admin','dispatch'].includes(ctx.user?.role);
    function render() {
      const c=store.active(), coverage=c?.coverage||s.coverage||{}, unassigned=c?.unassigned||s.unassigned||[];
      const resultTotal=coverage.total??s.order_ids.length;
      const count=typeof coverage==='object'?(coverage.assigned??coverage.covered??coverage.covered_orders??Math.max(0,s.order_ids.length-unassigned.length)):coverage;
      host.innerHTML='<section class="uw-panel" aria-label="统一调度计划"><header><div><small>统一批次 · 地图 / 日期视图共享</small><b>'+esc(s.plan_id)+' <span>v'+esc(s.version)+'</span></b></div><div class="uw-links"><button data-uw="plan">日期与时间轴</button><button data-uw="map">地图视图</button></div></header>'+
        '<div class="uw-controls"><label>计算范围<select data-uw-field="planning_scope" '+(!edit()||s.busy?'disabled':'')+'><option value="delivery_complete" '+(s.planning_scope==='delivery_complete'?'selected':'')+'>完整履约</option><option value="authorized_stage" '+(s.planning_scope==='authorized_stage'?'selected':'')+'>已授权阶段</option></select></label><label>优化目标<select data-uw-field="objective" '+(!edit()||s.busy?'disabled':'')+'>'+['lowest_cost','earliest_finish','fewest_transfers'].map(x=>'<option value="'+x+'" '+(s.objective===x?'selected':'')+'>'+label(x)+'</option>').join('')+'</select></label><label>时间轴时区<select data-uw-field="timezone">'+['America/Chicago','America/Los_Angeles','America/New_York','Asia/Shanghai','UTC'].map(x=>'<option '+(s.timezone===x?'selected':'')+'>'+x+'</option>').join('')+'</select></label><div class="uw-buttons">'+(edit()?'<button data-uw="precheck" '+(s.busy?'disabled':'')+'>检查资料</button><button class="primary" data-uw="optimize" '+(s.busy?'disabled':'')+'>'+(s.busy?'处理中…':'生成方案')+'</button>':'')+''+(s.busy&&s.job_id&&!ctx.publicDemo?'<button data-uw="cancel">取消计算</button>':'')+'<button data-uw="full">查看完整批次</button><button data-uw="undo" '+(!s.undo||s.busy?'disabled':'')+'>撤销选单</button><button data-uw="restore" '+(!s.last_feasible||s.busy?'disabled':'')+'>恢复上次可行方案</button></div></div>'+
        '<div class="uw-status" role="status"><strong>'+s.order_ids.length+' 票纳入计算</strong><span>'+esc(label(s.planning_scope))+'</span><span>求解：'+esc(label(s.solve_status||'not_started'))+'</span><span>业务：'+esc(label(s.validation_status||'pending'))+'</span><span>最优性：'+esc(label(c?.optimality_scope||s.optimality_scope||'not_proven'))+'</span></div>'+
        (s.planning_scope==='authorized_stage'?'<p class="uw-notice">仅计算当前已授权运段。到站不表示客户末端交付已安排；后程采购、保管及费用单列。</p>':'')+
        (s.stale_reason?'<p class="uw-warning">⚠ '+esc(s.stale_reason)+'；旧结果保留供核对，采用按钮已停用。</p>':'')+
        (s.job_id&&!ctx.publicDemo?'<p class="uw-capability">任务 '+esc(s.job_id)+' · '+esc({queued:'排队中',running:'运行中',completed:'已完成',failed:'失败',cancelled:'已取消'}[s.job_state]||s.job_state)+(s.job_id&&!s.busy&&['queued','running'].includes(s.job_state)?' <button data-uw="resume">恢复任务状态</button>':'')+'</p>':'')+
        (s.error?'<p class="uw-warning" role="alert">'+esc(s.error)+'</p>':'')+
        (s.precheck?'<details class="uw-check" '+(s.candidates.length?'':'open')+'><summary>逐票预检 · '+(s.precheck.ready_count??'—')+' 票条件齐备 · '+(s.precheck.issues||[]).length+' 项待处理</summary><ul>'+issuesHTML(s.precheck.issues)+'</ul></details>':'')+
        '<details class="uw-compare" '+(s.candidates.length?'open':'')+'><summary>方案比较 · '+s.candidates.length+' 个候选 · '+(s.validation_status==='stale'?'旧输入结果；当前批次 ':'同一批 ')+s.order_ids.length+' 票</summary><div class="uw-candidates">'+s.candidates.map((x,i)=>'<article class="'+(x===c?'active':'')+'"><small>'+esc(label(x.objective))+'</small><b>'+money(x.total_minor,x.currency)+'</b><span>'+esc(label(x.validation_status))+' · '+(x.routes||[]).length+' 车次 / 委托</span><span>未排 '+(x.unassigned||[]).length+' 票 · '+esc(label(x.optimality_scope))+'</span><div><button data-uw="candidate" data-id="'+esc(x.id)+'">查看明细</button>'+(edit()?'<button data-uw="adopt" data-id="'+esc(x.id)+'" '+(s.busy||s.validation_status==='stale'||!['passed','valid'].includes(x.validation_status)?'disabled':'')+'>'+ (s.adopted_candidate_id===x.id?'已采用':'采用为草案')+'</button>':'')+'</div></article>').join('')+'</div>'+(s.candidates.length?'':'<p>先明确订单范围，再检查资料并生成候选；未齐费用不会按零参与低价比较。</p>')+'</details>'+
        (c?'<p class="uw-capability">整票覆盖 '+Number(coverage.order_complete??0)+' / '+resultTotal+'；阶段覆盖 '+Number(coverage.stage_assigned??count??0)+' / '+resultTotal+'。费用范围：'+esc(label(s.planning_scope))+'。</p><div class="uw-route-tabs">'+store.routes().map((r,i)=>'<button data-uw="route" data-index="'+i+'">'+(i+1)+'. '+esc(r.name||r.warehouse||r.id||'车次')+' · '+(r.order_ids||[]).length+' 票</button>').join('')+'</div>':'')+
        (store.drafts().length?'<details class="uw-drafts"><summary>待补资料草案 · '+store.drafts().length+' 条（尚未排定）</summary><div class="uw-route-tabs">'+store.drafts().map((r,i)=>'<button data-uw="draft" data-index="'+i+'">'+(i+1)+'. '+esc(r.name||r.warehouse||'草案')+' · '+(r.order_ids||[]).length+' 票</button>').join('')+'</div></details>':'')+
        (unassigned.length?'<details><summary>未分配 / 待安排 '+unassigned.length+' 票</summary><ul class="uw-issues">'+issuesHTML(unassigned)+'</ul></details>':'')+
        ((c?.cost_items||s.cost_items||[]).length?'<details><summary>费用明细与付款范围</summary><ul class="uw-costs">'+(c?.cost_items||s.cost_items).map(x=>'<li>'+esc(x.label||x.name||x.type||x.event||'费用')+' · '+esc(x.payee||x.supplier_id||'付款方待核')+' <b>'+money(x.amount_minor??x.total_minor,x.currency)+'</b></li>').join('')+'</ul></details>':'')+
        ((ctx.demo||ctx.publicDemo)?'<div class="uw-simulation">'+(store.dataset==='sim200'&&edit()?'<button data-uw="sampleSix" '+(s.busy?'disabled':'')+'>新建 6 票试排</button> ':'')+'<button data-uw="sim200" '+(s.busy||ctx.user?.role!=='sales'?'disabled':'')+'>载入 200 票演练</button> <span>'+ (ctx.user?.role==='sales'?'通过销售正常导入；重复导入不增加主单。':'切换销售岗位可导入；现有订单保留。')+'</span>'+ (s.sim_summary?'<span> 本库已导 '+s.sim_summary.orders+' / 200 票 · '+Object.entries(s.sim_summary.states||{}).map(([k,v])=>esc(ctx.statusNames?.[k]||k)+' '+v).join(' / ')+'</span>':'')+' <a href="./data/acceptance.html" target="_blank" rel="noopener">查看本机演练验收说明</a></div>':'')+
        '<p class="uw-capability">'+(ctx.publicDemo?'公开演练：本浏览器独立数据；候选计算使用浏览器可用引擎。Dallas 道路试排最多 6 站；全国底图不等于全国货车路网已覆盖。':'本机服务：道路及求解能力以启动健康检查和逐段依据为准。')+' 车辆位置显示业务记录，不代表实时 GPS。'+(store.dataset==='sim200'?' 订单、仓口核验和报价均为合成测试事实，非真实客户；测试坐标不能作为正式货车道路依据。':'')+'</p>'+
        ((c?.assumptions||s.assumptions||[]).length?'<details><summary>计算假设与范围</summary><ul>'+issuesHTML(c?.assumptions||s.assumptions)+'</ul></details>':'')+'</section>';
    }
    async function click(ev) {const b=ev.target.closest('[data-uw]');if(!b||b.disabled)return;const a=b.dataset.uw;
      if(a==='sampleSix'&&store.dataset==='sim200'&&(ctx.demo||ctx.publicDemo)&&edit()){
        const ids=['SIM200-053','SIM200-067','SIM200-081','SIM200-054','SIM200-068','SIM200-082'];
        if(!ids.every(id=>(ctx.orders||[]).some(o=>o.id===id))){s.error='请先通过销售导入 200 票演练。';store.emit();return;}
        store.selection(ids,'已明确改为 6 票演练批次');store.edit('六票演练按完整履约重新计算',{planning_scope:'delivery_complete',objective:'lowest_cost',locks:{},manual_routes:null});store.view({day:'',from:'',to:'',search:''});await store.act(ctx,'optimize');return;
      }
      if(a==='sim200'&&(ctx.demo||ctx.publicDemo)&&ctx.user?.role==='sales'){
        s.busy=true;s.error='';store.emit();try{await ctx.api('/api/simulation/import',{method:'POST',body:{}});s.sim_summary=await ctx.api('/api/simulation/summary');const data=await ctx.api('/api/orders');store.selection([...s.order_ids,...(data.orders||[]).filter(o=>/^SIM200-\d{3}$/.test(o.id)).map(o=>o.id)]);await ctx.refresh?.();ctx.toast?.('200 票已通过销售导入，原有订单保留。');}catch(error){s.error=error.message;}finally{s.busy=false;store.emit();}return;
      }
      if(a==='cancel'){await store.cancel(ctx);return;}
      if(a==='resume'){await store.resume(ctx);return;}
      if(a==='plan'||a==='map')ctx.navigate(a+'?plan='+encodeURIComponent(s.plan_id));
      else if(a==='full'){store.view({day:'',from:'',to:'',search:''});store.emit();}
      else if(a==='undo'&&s.undo){const saved=s.undo;s.undo=null;s.order_ids=saved.order_ids;s.locks=saved.locks;store.edit('已撤销选单修改，请重新预检');}
      else if(a==='restore'&&s.last_feasible){store.update(clone(s.last_feasible));store.edit('已恢复上次可行方案的输入与车次，请按当前版本重新验证');}
      else if(a==='draft'){s.focus_draft=Number(b.dataset.index);if(onRoute)onRoute(store.drafts()[s.focus_draft],s.focus_draft);else ctx.navigate('map?plan='+encodeURIComponent(s.plan_id)+'&draft='+s.focus_draft);}
      else if(a==='candidate'){s.active_candidate_id=b.dataset.id;store.emit();}
      else if(a==='route'){s.focus_route=Number(b.dataset.index);store.emit();if(onRoute)onRoute(store.routes()[s.focus_route],s.focus_route);else ctx.navigate('map?plan='+encodeURIComponent(s.plan_id)+'&run='+s.focus_route);}
      else if(['precheck','optimize','adopt'].includes(a)&&edit())await store.act(ctx,a,b.dataset.id);
    }
    function change(ev){const key=ev.target.dataset.uwField;if(!key)return;if(key==='timezone'){s.timezone=ev.target.value;store.emit();}else if(edit())store.edit('计算条件已修改',{[key]:ev.target.value});}
    host.addEventListener('click',click);host.addEventListener('change',change);
    const unsubscribe=store.subscribe(render);render();
    if((ctx.demo||ctx.publicDemo)&&!s.sim_summary)ctx.api('/api/simulation/summary').then(result=>{s.sim_summary=result;if(host.isConnected)render()}).catch(()=>{});
    return {render,update(next){ctx=next;store.checkVersions(ctx.orders||[]);render()},destroy(){unsubscribe();host.removeEventListener('click',click);host.removeEventListener('change',change)}};
  }
  return {open,panel,esc,label,money,time,day,addDays,issuesHTML,routeSegments,routeView,roadPreview,timelineHTML};
})();
