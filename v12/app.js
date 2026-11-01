'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pages = {
    map:['地图调度','DISPATCH MAP','从可发订单组建线路，核对仓点、站序与收货窗口。','M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15m6-12v15'],
    dashboard:['运营总览','OPERATIONS OVERVIEW','查看当前岗位可见的订单、交付进度和待处理事项。','M3 3h7v8H3zm11 0h7v5h-7zM3 15h7v6H3zm11-3h7v9h-7z'],
    tasks:['岗位待办','MY WORK QUEUE','按当前登录岗位办理任务，交接结果写回同一张订单。','M4 5h16v16H4z M8 3v4m8-4v4m-9 5 2 2 4-4'],
    orders:['订单工作台','ORDER DESK','建单并核对交付范围，按设备和订单版本追踪每一次交接。','M5 3h14v18H5z M8 8h8m-8 4h8m-8 4h5'],
    exceptions:['异常跟进','EXCEPTION DESK','登记异常、现场保管和恢复安排，跟踪处理结果。','M12 3 2 20h20z M12 9v5m0 2v1'],
    finance:['费用核对','COST CONTROL','按订单核对委托、实际作业与发票，保留结算依据。','M3 6h18v13H3z M3 10h18m-8 5h4'],
    resources:['仓网与运力','NETWORK & CAPACITY','维护实际仓址、车组和服务商的可用条件。','M2 10l10-7 10 7M4 10v11h16V10M8 21v-8h8v8'],
    ledger:['海运与采购','INBOUND & SOURCING','登记海运节点、收货凭据与同一票的书面报价。','M3 5h18v13H3z M7 9h9m-9 4h6m-4 5v3m6-3v3'],
    inventory:['逐台库存','SERIAL INVENTORY','按 SN 核实实收、库位和货况，跟踪实际锁机与出库。','M3 7l9-5 9 5v11l-9 4-9-4zM3 7l9 4 9-4m-9 4v11'],
    recovery:['售后与返修','SERVICE RECOVERY','按实际需要启动恢复、索赔或整机移修，分别记录交接与结果。','M9 4H4v5m0-4a9 9 0 1 1-1 9m9-8v6l3 2'],
    review:['经营复盘','PERFORMANCE REVIEW','按同仓、交付范围和原预约窗复核成本与履约结果，从指标回到原单。','M3 4v16h18M7 16v-4m5 4V8m5 8V5'],
    guide:['使用手册','FIELD MANUAL','按岗位试跑一票，核对交接方式、数据来源和运行边界。','M3 4q5-2 9 1 4-3 9-1v15q-5-2-9 1-4-3-9-1zM12 5v15']
  };
  const roleNames={admin:'管理员',sales:'销售 / 订单',warehouse:'仓库',dispatch:'调度',driver:'执行车组',finance:'财务',service:'客服 / 技术'};
  const statusNames={draft:'待备货',pending:'待备货',new:'待备货',ready:'待调度',dispatched:'已派车',in_transit:'在途',at_station:'站点保管',last_mile:'二程运输',delivered:'已交付',settled:'已核账',closed:'已结案',exception:'异常处理',cancelled:'已撤销'};
  const icon = (d,size=18)=>'<svg aria-hidden="true" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="'+d+'"/></svg>';
  let session={},data={orders:[],resources:[],routes:[]},current='',mounted=null,refreshNo=0,noticeTimer,workingUser='',lastSync='';
  let pendingRefresh=false;
  const toast=msg=>{const n=$('#notice');n.textContent=msg;n.classList.add('on');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>n.classList.remove('on'),3600)};
  async function api(path,opts={}) {
    if(window.PublicDemo) return window.PublicDemo.api(path,opts);
    const headers={...opts.headers}; let body=opts.body;
    if(body && typeof body!=='string' && !(body instanceof FormData) && !(body instanceof Blob)){body=JSON.stringify(body);headers['Content-Type']='application/json'}
    if(typeof body==='string' && !headers['Content-Type'])headers['Content-Type']='application/json';
    const res=await fetch(path,{...opts,headers,body,credentials:'same-origin',cache:'no-store'});
    const out=await res.json().catch(()=>({error:'服务响应异常，请核查服务是否在线。'}));
    if(!res.ok){if(res.status===401&&session.user){session.user=null;data={orders:[],resources:[],routes:[]};login()}const e=new Error(out.error||out.message||('请求失败 '+res.status));e.status=res.status;throw e}
    return out;
  }
  const canAdd=()=>['admin','sales','dispatch'].includes(session.user?.role);
  const visible=p=>(p!=='review'||['admin','dispatch','finance'].includes(session.user?.role)) && (p!=='inventory'||session.user?.role!=='driver') && (p!=='recovery'||!['driver','sales'].includes(session.user?.role)) && !(['resources','ledger'].includes(p)&&['driver','service'].includes(session.user?.role)) && (p!=='finance'||['admin','finance','dispatch'].includes(session.user?.role));
  const openOrder=(id,a)=>window.Workflow.openOrder(ctx(),id,a);
  function ctx(){return {...data,user:session.user,publicDemo:!!window.PublicDemo,demo:session.demo,openOrder,navigate,toast,refresh:()=>refresh(true),api,
    saveRoute:async p=>{const result=await api('/api/ops/routes',{method:'POST',body:p});data.routes=(await api('/api/ops/routes')).routes;return result.route},
    downloadFile:window.PublicDemo?((id,name)=>window.PublicDemo.downloadFile(id,name)):undefined,statusNames,roleNames,escape:esc,routingEnabled:!!session.routing,tilesEnabled:!!session.tiles}}
  function destroy(){if(mounted?.destroy)mounted.destroy();mounted=null}
  function login(error=''){
    destroy();refreshNo++;workingUser='';current='';document.querySelectorAll('dialog').forEach(x=>x.remove());
    const demo=session.demo;const publicMode=!!window.PublicDemo;
    $('#root').innerHTML='<main class="auth-screen"><section class="auth-brand"><div class="brand"><img src="brand.svg" width="40" height="40" alt=""><div><strong>哈哈便利</strong><small>HAHA VENDING</small></div></div><div><div class="kicker">OPERATIONS CONTROL CENTER</div><h1>美国物流<br>协作中心</h1><p>从仓库放货，到设备交到约定位置。</p></div><small>SUPPLY CHAIN OPERATIONS &nbsp; / &nbsp; V12</small></section><section class="auth-side"><div class="auth-card"><span class="env '+(demo?'demo':'')+'">'+(publicMode?'公开演练 · 个人浏览器':demo?'本机演练库':'内部工作库')+'</span><h2>'+(demo?'进入岗位演练':'员工登录')+'</h2><p class="muted">'+(publicMode?'每位访客独立试跑。请只使用虚构订单与凭据。':demo?'以不同岗位接力办理同一笔示例订单。':'使用管理员分配的个人账号进入共享工作库。')+'</p><form id="signin">'+(demo?'<label class="field"><span>演练身份</span><select name="username">'+(session.demo_users||[]).map(u=>'<option value="'+esc(u.username||u)+'">'+esc(roleNames[u.role||u]||u.name||u)+'</option>').join('')+'</select></label>':'<label class="field"><span>员工账号</span><input name="username" autocomplete="username" required></label><label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label>')+'<div class="error-line" role="alert">'+esc(error)+'</div><button class="primary" type="submit">'+(demo?'进入工作台':'登录工作台')+' →</button></form><p class="login-note">'+(demo?'示例仓址、订单、车组与金额均用于操作演练。':'工作记录按账号与订单版本留痕。')+'</p></div></section></main>';
    $('#signin').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;try{await api(demo?'/api/demo-login':'/api/login',{method:'POST',body:Object.fromEntries(new FormData(f))});await boot()}catch(err){f.querySelector('.error-line').textContent=err.message}finally{b.disabled=false}};
  }
  function navigate(v){if(!pages[v]||!visible(v))v='map';if(location.hash.slice(1)!==v){location.hash=v;return}renderPage(v)}
  function navGroup(name,keys){return '<div class="nav-caption">'+name+'</div>'+keys.filter(visible).map(k=>'<button data-nav="'+k+'">'+icon(pages[k][3])+'<span>'+pages[k][0]+'</span></button>').join('')}
  function shell(){
    workingUser=session.user.username;
    $('#root').innerHTML='<div class="shell"><aside class="rail" id="rail"><div class="brand"><img src="brand.svg" alt="" width="37" height="37"><div><strong>哈哈便利</strong><small>LOGISTICS OPERATIONS</small></div></div><nav>'+navGroup('调度中心',['map','dashboard','tasks','orders'])+navGroup('业务协作',['inventory','resources','ledger','exceptions','recovery','finance'])+navGroup('工作空间',['review','guide'])+'</nav><div class="rail-bottom"><span class="avatar">'+esc(session.user.name?.slice(0,1)||'H')+'</span><div><b>'+esc(session.user.name)+'</b><small>'+esc(roleNames[session.user.role])+'</small></div><button id="signout" title="退出 / 切换岗位" aria-label="退出 / 切换岗位">'+icon('M9 3H4v18h5m4-14 5 5-5 5m-5-5h12')+'</button></div></aside><div class="main"><header class="topbar"><div class="crumb"><button class="menu-mobile btn-icon" aria-label="打开导航">'+icon('M3 6h18M3 12h18M3 18h18')+'</button>美国物流 <span>/</span> <b id="crumb"></b><span class="shell-version">V12</span></div><div class="top-rt"><button id="quick-find" aria-label="全局查单">⌕　查单 <kbd>Ctrl K</kbd></button><time id="clock"></time><span class="env '+(session.demo?'demo':'')+'">'+(window.PublicDemo?'公开演练 · 仅用虚构数据':session.demo?'本机演练库':'内部共享工作库')+'</span></div></header><div id="network"></div><main class="page-pad"><header class="mast"><div><div class="kicker" id="section-kicker"></div><h1 id="section-title"></h1><p id="section-hint"></p></div><div class="mast-actions"><button id="refresh" title="刷新共享数据">'+icon('M20 7v5h-5M4 17v-5h5M5.5 8a7 7 0 0 1 12-2L20 9M4 15l2.5 3a7 7 0 0 0 12-2',15)+'刷新</button>'+(canAdd()?'<button id="create" class="primary">＋ 新建订单</button>':'')+'</div></header><div id="content" class="content"></div></main></div></div>';
    $('.menu-mobile').onclick=()=>{const rail=$('#rail');rail.classList.add('open');const mask=document.createElement('button');mask.className='scrim';mask.setAttribute('aria-label','收起导航');mask.onclick=closeNav;rail.after(mask)};
    $('#signout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:{}});await boot()}catch(e){toast(e.message)}};
    $('#root').onclick=e=>{const n=e.target.closest('[data-nav]');if(n){if(n.dataset.resourceTab)window.Resources.focusTab(n.dataset.nav,n.dataset.resourceTab);closeNav();navigate(n.dataset.nav)}};
    $('#refresh').onclick=()=>refresh(true).catch(e=>toast(e.message));if($('#create'))$('#create').onclick=()=>window.Workflow.newOrder(ctx());
    $('#quick-find').onclick=()=>window.OrderFinder.open(ctx(),Object.keys(pages).filter(visible).map(key=>({key,label:pages[key][0],desc:pages[key][2]})));
    time();
  }
  function closeNav(){$('#rail')?.classList.remove('open');$('.scrim')?.remove()}
  function time(){if($('#clock'))$('#clock').textContent='达拉斯  '+new Intl.DateTimeFormat('zh-CN',{timeZone:'America/Chicago',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}
  function renderPage(v=location.hash.slice(1)){
    if(!session.user||!$('#content'))return;if(!pages[v]||!visible(v))v='map';
    destroy();current=v;const [title,en,hint]=pages[v];$('#crumb').textContent=title;$('#section-title').textContent=title;$('#section-hint').textContent=hint;$('#section-kicker').textContent=en+'   /   US OPERATIONS';
    document.querySelectorAll('nav [data-nav]').forEach(n=>n.dataset.nav===v?n.setAttribute('aria-current','page'):n.removeAttribute('aria-current'));
    const host=$('#content');host.onclick=null;host.replaceChildren();pendingRefresh=false;$('#network').replaceChildren();
    if(v==='map') mounted=window.DispatchMap.mount(host,ctx());else if(v==='inventory'||v==='recovery')mounted=window.Lifecycle.mount(host,ctx(),v);else if(v==='dashboard')dashboard(host);else if(v==='guide'){guide(host);guideLinks(host)}else if(v==='review')mounted=window.Review.mount(host,ctx());else if(['resources','ledger'].includes(v))window.Resources.mount(host,ctx(),v);else window.Workflow.mount(host,ctx(),v);
  }
  function dashboard(h){
    const orders=data.orders,ready=orders.filter(o=>o.status==='ready'),travel=orders.filter(o=>['dispatched','in_transit','at_station','last_mile'].includes(o.status)),issues=orders.filter(o=>o.status==='exception'||o.exceptions?.some(x=>!x.resolved)),counts=new Map();
    for(const o of orders)counts.set(o.warehouse||'待定仓址',(counts.get(o.warehouse||'待定仓址')||0)+1);
    const stats=[['可见订单',orders.length],['已就绪待交接',ready.length],['执行中',travel.length],['待跟进异常',issues.length]];
    h.innerHTML='<div class="stats">'+stats.map(([t,n],i)=>'<div class="stat '+(!i?'accent':'')+'"><small>'+t+'</small><b>'+n+'</b></div>').join('')+'</div><div class="dash-grid"><section class="card"><div class="eyebrow">DISPATCH QUEUE</div><div class="card-head"><h2>调度交接队列</h2><button class="text-btn" data-nav="orders">查看订单 →</button></div><div id="queue"></div></section><section class="card"><div class="eyebrow">WAREHOUSE NETWORK</div><h2>各仓订单量</h2>'+([...counts].map(([w,n])=>'<div class="dash-row"><span>'+esc(w)+'</span><b>'+n+' 票</b></div>').join('')||'<p class="empty">录入订单后，可在这里对照各仓工作量。</p>')+'</section></div><section class="dash-banner"><div><h2>交接下一票设备</h2><p>核实际起运仓、可发 SN、车组和收货窗口后，再到地图排线。</p></div><button data-nav="map">进入地图调度 →</button></section>';
    const work=[['F01–02','接单和备货','orders',orders.filter(o=>o.status==='new').length],['F03–04','核价与放行','map',ready.filter(o=>!o.pickup).length],['F05–07','执行与交接','tasks',travel.length],['F08','核对已交付费用','finance',orders.filter(o=>o.status==='delivered').length]].filter(r=>visible(r[2]));
    const belt=document.createElement('section');belt.className='flow-nav';belt.innerHTML='<div class="eyebrow">SHIFT HANDOVER</div><h2>本班交接</h2><div class="flow-steps">'+work.map(([code,name,view,n])=>'<button data-nav="'+view+'"><small>'+code+'</small><strong>'+n+' 票</strong><span>'+name+' →</span></button>').join('')+'</div>';
    h.querySelector('.dash-grid').before(belt);
    const q=[...issues,...ready,...travel].filter((x,i,a)=>a.indexOf(x)===i).slice(0,8);h.querySelector('#queue').innerHTML=q.map(o=>'<button class="dash-row" data-order="'+esc(o.id)+'"><span>'+esc(o.customer||o.id)+'<small>'+esc(o.id)+' · '+esc(o.warehouse)+'</small></span><span class="pill">'+esc(statusNames[o.status]||o.status)+'</span></button>').join('')||'<p class="empty">当前没有待调度、运输中或异常订单。</p>';
    h.querySelectorAll('[data-order]').forEach(n=>n.onclick=()=>openOrder(n.dataset.order));
    if(['finance','admin','dispatch'].includes(session.user.role)){
      const settled=orders.filter(o=>o.status==='settled'&&Number.isFinite(o.actual_cost)),units=settled.reduce((n,o)=>n+o.quantity,0);
      const total=settled.reduce((n,o)=>n+o.actual_cost,0);
      const approved=settled.reduce((n,o)=>n+(o.approved_cost||0)+(o.change_cost||0),0);
      const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
      const sheet=document.createElement('section');sheet.className='card';sheet.style.marginTop='16px';
      sheet.innerHTML='<div class="eyebrow">SETTLEMENT REVIEW</div><h2>已结订单费用</h2><p class="muted">统计当前可见、已完成费用核对的订单。实际金额取自逐单结算，差额以批准预算加变更额为基准。</p>'+
      (units?'<div class="dash-row"><span>已结订单 / 台数</span><b>'+settled.length+' 票 / '+units+' 台</b></div><div class="dash-row"><span>已结实际费用</span><b>'+money(total)+'</b></div><div class="dash-row"><span>平均每台已结费用</span><b>'+money(total/units)+'</b></div><div class="dash-row"><span>实结与批准差额</span><b>'+money(total-approved)+'</b></div>':'<p class="empty">暂无已结账单，单台成本与预算差额待核账后计算。</p>');
      h.append(sheet);
    }
  }
  function guide(h){
    h.innerHTML='<article class="card guide"><div class="eyebrow">V12 FIELD MANUAL</div><h2>从一笔销售订单开始</h2><p>每次操作由当前账号提交。跨岗位验收时，可退出并使用下一岗位登录。</p>'+[
    ['01　销售与订单','录入 CRM 参考、收货位置、型号和服务。L1 为基础交接，L2 为入口，L3 为室内机位。特殊搬运和技术启用分别勾选 L4、L5。'],
    ['02　仓库与询价','核对实际仓址、逐台 SN、包装与货况。海运与采购页按同一票、终点和窗口登记主备报价，条件未齐应继续补证。'],
    ['03　调度与车组','在地图按仓点筛可发订单，查看站序和时窗，保存排线草案。客户自提单在仓口交接。订单详情里核对发车条件，指定执行人并签发。'],
    ['04　交付与异常','逐段记录保管方和实际签收位置。经站单按路线办理到站与二程。出现货损、失约或未完成动作时，登记异常并明确下一步。L5 订单另留技术验收结果。'],
    ['05　财务与留痕','从费用核对进入已交付订单，核签收、发票与批准金额。使用订单时间线核对经办和版本，冲突时先刷新确认他人已提交的动作。'],
    ['地图与数据','州界底图可离线使用。订单点取自录入的坐标；缺坐标应先补录。草案里程、到点时间按界面标明的方法估算，实际行车受道路、车辆、作业耗时和预约影响。'],
    ['访问与演练',window.PublicDemo?'本链接使用虚构样例，改动只保存在访问者当前浏览器。请勿录入真实客户、地址或凭证。':'正式库由主管分配账号；演练库与正式库隔离。员工在同一台内网应用服务器办理，点击刷新可立即读取最新结果。']
    ].map(([t,b])=>'<details><summary>'+t+'</summary><p>'+esc(b)+'</p></details>').join('')+'</article>';
  }
  function guideLinks(h){
    const steps=[['F01','确认交付范围','销售 · 客户承诺','orders'],['F02','锁定实物','仓库 · SN 与库位','inventory'],['F03','同范围比价','调度 · 全程报价','ledger','quote'],['F04','核验与派车','调度 · 12 项放行','map'],['F05','逐台签交','车组 · 交付与 POD','orders'],['F06','变更与异常','客服 · 保管与恢复','exceptions'],['F07','技术与返修','售后 · 已购启用或报障','recovery'],['F08','核账与关单','财务 · 预算与差异','finance']];
    const box=document.createElement('div');box.className='guide-grid';box.innerHTML=steps.filter(r=>visible(r[3])).map(([code,title,owner,view,tab])=>'<button class="guide-step" data-nav="'+view+'" '+(tab?'data-resource-tab="'+tab+'"':'')+'><span class="step-code">'+code+'</span><b>'+title+'　↗</b><small>'+owner+'</small></button>').join('');h.prepend(box);
  }
  async function refresh(force=false){
    const n=++refreshNo;
    try{
      const [o,r,rt]=await Promise.all([api('/api/orders'),api('/api/ops/resources'),api('/api/ops/routes')]);
      if(n!==refreshNo||!session.user)return;
      const next={orders:o.orders||[],resources:r.resources||[],routes:rt.routes||[]};const changed=JSON.stringify(next)!==JSON.stringify(data);
      data=next;if(changed)pendingRefresh=true;lastSync=new Date().toLocaleTimeString('zh-CN');
      if(force||!current)renderPage(location.hash.slice(1));
      else if(pendingRefresh && $('#network')){$('#network').innerHTML='<div class="net-error">其他岗位已更新工作库，可刷新当前视图。<button>刷新视图</button></div>';$('#network button').onclick=()=>refresh(true).catch(e=>toast(e.message))}
      else if($('#network'))$('#network').replaceChildren();
    }catch(e){if(n===refreshNo&&session.user){if($('#network'))$('#network').innerHTML='<div class="net-error">工作库读取失败。'+esc(e.message)+' 请刷新重试。</div>'}throw e}
  }
  async function boot(){
    try{session=await api('/api/session');if(!session.user){login();return}shell();current='';await refresh(true)}
    catch(e){if(!workingUser)$('#root').innerHTML='<div class="boot"><div><h2>工作台暂未连接</h2><p>'+esc(e.message)+'</p><button id="retry">重新连接</button></div></div>';if($('#retry'))$('#retry').onclick=boot}
  }
  addEventListener('keydown',ev=>{if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='k'&&session.user&&!document.querySelector('dialog[open]')){ev.preventDefault();$('#quick-find')?.click()} if(ev.key==='Escape')closeNav()});
  addEventListener('hashchange',()=>{if(session.user)renderPage()});
  setInterval(time,30000);setInterval(()=>{if(session.user&&!document.hidden&&!document.querySelector('dialog[open]')&&!window.PublicDemo)refresh().catch(()=>{})},20000);
  boot();
})();




