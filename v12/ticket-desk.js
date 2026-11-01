/* Role queue derived from the shared records. The API rechecks every operation. */
'use strict';
window.TicketDesk = (() => {
  const stages = [
    ['工厂 → 美国卸货港','订舱、装船与到港','S01–S03'],
    ['提货场站 → 库存仓','提离、到仓与实收','S04 · ASN'],
    ['客户订单 → 美国履约','锁机、选线与放行','F01–F04'],
    ['签收、核账与异常','逐台回单、启用与核账','F05–F08']
  ];
  const seaRoles = ['admin','warehouse','dispatch','sales','procurement','finance','inbound'];
  const mayReadSea = role => seaRoles.includes(role);
  function due(value,zone) {
    if(!value)return '待约定';
    if(!/(Z|[+-]\d\d:\d\d)$/.test(value))return value.slice(0,16).replace('T',' ')+' · '+(zone||'当地');
    try{return new Intl.DateTimeFormat('zh-CN',{timeZone:zone||'UTC',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))+' · '+(zone||'UTC')}catch{return value}
  }
  function orderTask(o,ctx) {
    const can = a => o.allowed_actions?.includes(a);
    const remaining = Math.max(0,o.quantity-(o.completed_sns?.length||0));
    const row = (stage,node,owner,reason,label,action,url,rank=3) => ({
      stage,node,owner,reason,label,action,url,rank,order:o.id,ref:o.crm_ref||o.id,
      subtitle:[o.warehouse,o.model+' × '+o.quantity,o.customer].filter(Boolean).join(' · '),
      dueLabel:'预约截止',due:due(o.window_end,o.timezone)
    });
    if(can('settle'))return row(4,'F08 · 核账','财务','核报价、变更、现场凭据与发票。','核对本票费用','settle','',0);
    if(can('service_complete'))return row(4,'F07 · 技术启用','技师','已购 L5，待测试和客户确认。','核对 '+o.quantity+' 台技术验收','service_complete');
    if(can('resolve'))return row(4,'F06 · 异常','调度 / 客服',o.reason||o.next_step||'待登记恢复依据。','办理异常恢复','resolve');
    if(can('deliver'))return row(4,'F05 · 到场签收',o.driver||'执行车组','待核合同终点、逐台签名与照片。','审核 '+remaining+' 台签收回单','deliver');
    if(can('station_release'))return row(3,'F04 · 二程放行','调度',o.second_leg?'待核二程承接与放行凭据。':'待二程承接人、分段委托及报价。','核对二程承接资料',o.second_leg?'station_release':'');
    if(can('station_receive'))return row(3,'F04 · 站点交接','仓管','待接收方按 SN 验收及接管。','核收 '+remaining+' 台入站设备','station_receive');
    if(can('depart'))return row(3,'F04 · 离仓',o.driver||'执行车组','待核派车授权、实际人车和设备。','核对离仓交接','depart');
    if(o.status==='dispatched'&&ctx.user.role==='warehouse')return row(3,'F04 · 仓口验放','仓管','待核本段提货号与实到车组。','验放 '+remaining+' 台设备','','gate?focus='+encodeURIComponent(o.id));
    if(can('pickup'))return row(3,'F04 · 客户自提','仓管','自提在原库存仓交接，须核人车和提货授权。','核验自提授权',o.pickup_gate?'pickup':'pickup_gate');
    if(can('dispatch'))return row(3,'F04 · 待调度','调度','库存已锁定，核对线路、车组与书面承接。','定位本票并排线','','map?focus='+encodeURIComponent(o.id),1);
    if(o.status==='ready'&&ctx.user.role==='procurement'&&!o.pickup&&!o.selected_quote)return row(3,'F03 · 比价与委托','采购','待同范围同窗报价与书面承接。','核对本票采购资料','');
    if(can('ready'))return row(3,'F02 · 锁定实物','仓管','待核实际库存仓、机型及合格 SN。','核对 '+o.quantity+' 台可锁设备','ready');
    if(o.status==='new'&&can('edit')&&!o.endpoint)return row(3,'F01 · 交接点','销售','客户交接终点待确认。','补录客户交接点','edit');
  }
  function seaTasks(s,role) {
    const rows=[],done=new Set(s.events.map(x=>x.kind)),ref=s.batch||s.asn;
    const url='ledger?batch='+encodeURIComponent(s.id);
    const missing=s.units.filter(u=>!u.receipt).length;
    const row=(stage,node,owner,reason,label,rank=2)=>({stage,node,owner,reason,label,rank,ref,url,
      subtitle:[s.asn,s.voyage,s.warehouse].filter(Boolean).join(' · '),dueLabel:'预计到仓',due:due(s.warehouse_eta,s.warehouse_zone)});
    for(const r of s.reviews||[]){
      if(!r.closed_at&&(role==='admin'||role===r.role)){
        rows.push({...row(2,'改约复核',r.role==='warehouse'?'仓管':'调度',r.reason,'复核原预约',1),dueLabel:'复核截止',due:due(r.due,s.warehouse_zone)});
      }
    }
    if(!['admin','warehouse','inbound'].includes(role))return rows;
    if(done.has('warehouse_arrival')){
      if(missing)rows.unshift(row(2,'ASN · 待实收','仓管',missing+' 台预报 SN 尚无实收回执。','核对 '+missing+' 台到仓设备',0));
    } else if(done.has('pickup'))rows.push(row(2,'S04 · 内陆运输',s.owner,'已提离，待仓库签到。','登记实际到仓'));
    else if(done.has('arrived'))rows.push(row(2,'S04 · 提货场站',s.owner,s.hold?'监管扣留，待记录解除依据。':'待核监管路径、场站及放货回执。','核对场站提货条件'));
    else rows.push(row(1,done.has('loaded')?'S03 · 待到港':'S02 · 待装运',s.owner,done.has('loaded')?'已装船，待目的港实际到港回执。':'待核装运凭据和实际装船。',done.has('loaded')?'登记实际到港':'核对装运凭据'));
    return rows;
  }
  function mount(host,ctx,params) {
    const role=ctx.user.role,e=ctx.escape,requested=Number(params.get('stage')),filter=[1,2,3,4].includes(requested)?requested:0;
    const section=document.createElement('section');section.className='ticket-desk';host.append(section);
    let shipments=[],seaError='',loading=mayReadSea(role),practiceTitle='跟做一票达拉斯演练';
    const orderRows=ctx.orders.map(o=>orderTask(o,ctx)).filter(Boolean);
    function draw(){
      if(!section.isConnected)return;
      const all=[...shipments.flatMap(s=>seaTasks(s,role)),...orderRows].sort((a,b)=>a.rank-b.rank);
      const rows=all.filter(r=>!filter||r.stage===filter);
      section.innerHTML='<nav class="td-steps" aria-label="按全程阶段筛选">'+stages.map(([title,sub,code],i)=>
        '<button type="button" data-stage="'+(i+1)+'" aria-pressed="'+(filter===i+1)+'"><span class="td-step-top"><i>0'+(i+1)+'</i><small>'+code+'</small></span><b>'+title+'</b><span>'+sub+'</span></button>'
      ).join('')+'</nav><section class="td-queue"><header><div><span class="td-kicker">WORK QUEUE　/　'+e(ctx.roleNames[role]||role)+'</span><h2>'+(filter?stages[filter-1][0]:'待我办理')+' <em>'+rows.length+'</em></h2></div>'+(ctx.demo?'<button data-practice class="td-practice">'+e(practiceTitle)+'　→</button>':'')+'</header>'+
      (filter?'<button class="td-all" data-stage="0">← 全部阶段</button>':'')+
      (loading?'<p role="status" class="td-message">正在读取海运与收货任务…</p>':'')+
      (seaError?'<p class="td-message" role="alert">海运待办读取失败 · '+e(seaError)+' <button data-retry>重试</button></p>':'')+
      (rows.length?rows.map((r,i)=>'<article class="td-row"><div class="td-row-ref"><small>阶段 0'+r.stage+'　/　'+e(r.node)+'</small>'+
        (r.order?'<button data-ticket="'+i+'">'+e(r.ref)+'</button>':'<b>'+e(r.ref)+'</b>')+'<span>'+e(r.subtitle)+'</span></div><div class="td-row-body"><p>'+e(r.reason)+'</p><small>负责　'+e(r.owner||'待认领')+'　·　'+e(r.dueLabel)+'　'+e(r.due)+'</small></div><button data-do="'+i+'" class="td-do">'+e(r.label)+'　›</button></article>').join(''):
        '<div class="td-empty"><b>本岗位在'+(filter?'这一阶段':'当前队列')+'暂无待办</b><p>其他岗位完成交接后，新任务会按当前业务状态出现。</p></div>')+'</section>';
      section.onclick=ev=>{
        const b=ev.target.closest('button');if(!b)return;
        if(b.hasAttribute('data-stage')){const st=Number(b.dataset.stage);ctx.navigate(st?'dock?stage='+st:'dock')}
        else if(b.hasAttribute('data-practice'))ctx.navigate('tasks');
        else if(b.hasAttribute('data-retry'))loadSea();
        else if(b.hasAttribute('data-ticket'))ctx.openOrder(rows[Number(b.dataset.ticket)].order);
        else if(b.hasAttribute('data-do')){const r=rows[Number(b.dataset.do)];if(r.url)ctx.navigate(r.url);else ctx.openOrder(r.order,r.action)}
      };
    }
    async function loadSea(){
      loading=true;seaError='';draw();
      try{shipments=(await ctx.api('/api/supply/shipments')).shipments}catch(err){seaError=err.message}
      loading=false;draw();
    }
    draw();if(mayReadSea(role))loadSea();
    if(ctx.demo)ctx.api('/api/practice/dfw').then(s=>{
      if(s.cursor)practiceTitle=s.cursor<s.steps.length?'续办达拉斯演练 · '+s.cursor+'/'+s.steps.length:'查看达拉斯演练记录';
      const b=section.querySelector('[data-practice]');if(b)b.textContent=practiceTitle+'　→';
    }).catch(()=>{});
  }
  return {mount,mayReadSea};
})();
