'use strict';
/* Date and map views consume the same plan; no independent routing heuristic. */
window.DispatchPlan = {
  mount(host, initial) {
    let ctx=initial;
    const W=window.DispatchWorkspace,store=W.open(ctx),s=store.state,e=W.esc;
    let panel,search=s.view.search||'';
    const canEdit=()=>['admin','dispatch'].includes(ctx.user?.role);
    const orderMap=()=>new Map((ctx.orders||[]).map(o=>[o.id,o]));
    const byDate=o=>(o.window_start||'').slice(0,10);
    const visible=()=> (ctx.orders||[]).filter(o=>{
      const d=byDate(o),v=s.view;
      return (!v.day||d===v.day)&&(!v.from||d>=v.from)&&(!v.to||d<=v.to)&&(!search||[o.id,o.customer,o.city,o.state,o.warehouse,o.route,o.path,o.level,o.selected_quote?.carrier].join(' ').toLowerCase().includes(search.toLowerCase()));
    });
    const timeline = r => W.timelineHTML(r, ctx.orders || [], s.timezone);
    function render() {
      panel?.destroy();
      const rows=visible(), map=orderMap(), ids=new Set(s.order_ids), hidden=s.order_ids.filter(id=>!rows.some(o=>o.id===id)).length;
      const confirmedRoutes=store.routes(),routes=[...confirmedRoutes,...store.drafts().map(r=>({...r,_draft:true}))],today=W.day(new Date(),s.timezone),dates=[...new Set((ctx.orders||[]).map(byDate).filter(Boolean))].sort();
      const selectedOrders=s.order_ids.map(id=>map.get(id)).filter(Boolean);
      host.innerHTML='<section class="dp-shell"><div data-unified-panel></div><div class="uw-filterbar"><div role="group" aria-label="日期视图">'+[['all','全部日期'],['today','今天'],['tomorrow','明天'],['7','未来 7 天'],['14','未来 14 天']].map(([v,t])=>'<button data-range="'+v+'">'+t+'</button>').join('')+'</div><label>从 <input type="date" data-filter="from" value="'+e(s.view.from)+'"></label><label>至 <input type="date" data-filter="to" value="'+e(s.view.to)+'"></label><label>搜索 <input type="search" data-filter="search" value="'+e(search)+'" placeholder="订单 / 仓点 / 城市 / 履约方式"></label></div>'+
        '<div class="uw-scope-note" role="status">当前视图 '+rows.length+' 票；本批计算 '+ids.size+' 票 / '+selectedOrders.reduce((n,o)=>n+Number(o.quantity||0),0)+' 台。'+(hidden?'<strong>其中 '+hidden+' 票在筛选范围之外，仍包含在计划中。</strong>':'')+' 日期切换仅改变视图。<button data-complete>返回完整批次</button></div>'+
        '<div class="dp-body"><section class="dp-rail"><header><h3>交付当地日期</h3><small>计划显示时区 '+e(s.timezone)+'</small></header><div class="dp-days"><button class="dp-day '+(!s.view.day?'on':'')+'" data-day="">全部日期</button>'+dates.map(d=>'<button class="dp-day '+(s.view.day===d?'on':'')+'" data-day="'+e(d)+'"><span class="dp-day-top"><b>'+e(d)+'</b>'+(d===today?'<em>计划地今天</em>':'')+'</span><span class="dp-day-meta">'+(ctx.orders||[]).filter(o=>byDate(o)===d).length+' 票 · 已选 '+selectedOrders.filter(o=>byDate(o)===d).length+' 票</span></button>').join('')+'</div><p class="dp-rail-foot">订单按其收货地原始当地日期分组。时间轴以明确 IANA 时区显示，浏览器时区不参与计算。</p></section>'+
        '<section class="dp-main"><header class="dp-main-head"><div><h3>本批订单池</h3><p>明确加入计算范围，再预检和生成方案。</p></div><div>'+ (canEdit()?'<button data-add-visible>加入当前 '+rows.length+' 票</button> <button data-remove-visible>移出当前视图订单</button>':'')+'</div></header><div class="uw-orders">'+rows.map(o=>'<label class="uw-order '+(ids.has(o.id)?'selected':'')+'"><input type="checkbox" data-order="'+e(o.id)+'" '+(ids.has(o.id)?'checked':'')+' '+(!canEdit()?'disabled':'')+'><span><b>'+e(o.id)+' · '+e(o.quantity||'—')+' 台 <em>'+e(o.pickup?'授权自提':o.route||o.path||o.mode||'履约待核')+'</em></b><span>'+e(o.warehouse||'实际起仓待补')+' → '+e(o.city||o.customer||'交付地待补')+' · '+e(o.level||'终点待核')+(o.addon_l4?' + L4':'')+(o.addon_l5||o.tech_required?' + L5':'')+'</span><small>'+e(o.window_start||'预约待补')+' — '+e(o.window_end||'')+' · '+e(o.timezone||'时区待核')+'</small><small>'+e(ctx.statusNames?.[o.status]||o.status)+' · '+e(o.selected_quote?.carrier||'供应商承接待核')+'</small></span><button type="button" data-open="'+e(o.id)+'">原单</button></label>').join('')+(rows.length?'':'<p class="dp-empty">当前视图无订单；本批选单保持不变。</p>')+'</div>'+
        '<header class="dp-main-head"><div><h3>计划车次与时间轴</h3><p>'+routes.length+' 条 · '+e(s.timezone)+' · '+e(W.label(s.validation_status||'pending'))+'</p></div></header>'+routes.map((r,i)=>'<article class="dp-wave"><header class="dp-wave-head"><div class="dp-wave-title"><span class="dp-wave-no">'+(r._draft?'待补资料草案':'车次 / 委托')+' '+(i+1)+'</span><b>'+e(r.name||r.id||r.warehouse||'候选车次')+'</b><small>'+(r.kind==='pickup'?'仓口自提 · 无配送车辆':r.kind==='supplier_commitment'?'承运商网络委托':e(r.vehicle_id||r.resource_id||'待定车辆')+' · 班组 '+e(r.crew_id||'待核'))+' · '+(r.order_ids||[]).length+' 票</small></div><div class="dp-wave-stats"><span><b>'+e(r.peak_units??r.units??'—')+'</b>峰值台数</span><span><b>'+e(r.distance_m==null?'待核':(r.distance_m/1609.344).toFixed(1))+'</b>道路 mi</span><span><b>'+W.money(r.total_minor,r.currency)+'</b>本车费用</span></div></header>'+timeline(r)+'<footer class="dp-wave-foot"><span>输入与费用变更后须重新校验；不会按站序直接签发。</span><button data-route="'+i+'" data-draft="'+(r._draft?i-confirmedRoutes.length:'')+'">地图查看整条路线</button></footer></article>').join('')+(routes.length?'':'<div class="dp-empty"><b>尚无候选车次</b><p>点击「检查资料」查看阻断项，再生成与地图共用的计划。没有核实的道路或费用显示待核。</p></div>')+'</section></div></section>';
      panel=W.panel(host.querySelector('[data-unified-panel]'),ctx);
    }
    function click(ev){const b=ev.target.closest('button');if(!b||b.disabled)return;
      if(b.hasAttribute('data-range')){const x=b.dataset.range,today=W.day(Date.now(),s.timezone);store.view({day:x==='today'?today:x==='tomorrow'?W.addDays(today,1):'',from:['7','14'].includes(x)?today:'',to:['7','14'].includes(x)?W.addDays(today,Number(x)-1):''});render();}
      else if(b.hasAttribute('data-day')){store.view({day:b.dataset.day,from:'',to:''});render();}
      else if(b.hasAttribute('data-complete')){search='';store.view({day:'',from:'',to:'',search:''});render();}
      else if(b.hasAttribute('data-add-visible')&&canEdit())store.selection([...s.order_ids,...visible().map(o=>o.id)]);
      else if(b.hasAttribute('data-remove-visible')&&canEdit()){const remove=new Set(visible().map(o=>o.id));store.selection(s.order_ids.filter(id=>!remove.has(id)));}
      else if(b.hasAttribute('data-open')){ev.preventDefault();ctx.openOrder?.(b.dataset.open);}
      else if(b.hasAttribute('data-route')){s.focus_route=Number(b.dataset.route);store.emit();ctx.navigate('map?plan='+encodeURIComponent(s.plan_id)+(b.dataset.draft!==''?'&draft='+b.dataset.draft:'&run='+s.focus_route));}
    }
    function change(ev){const el=ev.target;if(el.dataset.order&&canEdit()){store.selection(el.checked?[...s.order_ids,el.dataset.order]:s.order_ids.filter(id=>id!==el.dataset.order));}else if(el.dataset.filter){if(el.dataset.filter==='search')search=el.value;store.view({[el.dataset.filter]:el.value,day:''});render();}}
    host.addEventListener('click',click);host.addEventListener('change',change);
    const unsub=store.subscribe(render);store.checkVersions(ctx.orders||[]);render();
    return {update(next){ctx=next;store.checkVersions(ctx.orders||[]);render()},destroy(){unsub();panel?.destroy();host.removeEventListener('click',click);host.removeEventListener('change',change)}};
  }
};
