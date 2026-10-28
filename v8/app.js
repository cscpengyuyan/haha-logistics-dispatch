(function(H){
 const paths={dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',inbound:'M3 14l9 4 9-4-3 7H6z M5 14V8h14v6 M9 8V3h6v5 M1 23q3-3 6 0t6 0t6 0',orders:'M5 4h14v17H5z M9 2h6v4H9z M8 10h8 M8 14h8 M8 18h5',dispatch:'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2z M9 3v16 M15 5v16',inventory:'M3 9l9-6 9 6v12H3z M8 21V11h8v10 M3 9h18',suppliers:'M8 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8 M2 21v-3a6 6 0 0 1 12 0v3 M16 4a4 4 0 0 1 0 8 M17 15a5 5 0 0 1 5 5v1',comms:'M3 4h18v14H8l-5 4z M7 8h10 M7 12h7',portal:'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',risks:'M12 3L1 21h22z M12 9v5 M12 17v1',cost:'M3 21h18 M6 17V9 M12 17V3 M18 17v-7',driver:'M1 6h13v12H1z M14 10h5l4 4v4h-9 M4 18a2 2 0 1 0 4 0 M16 18a2 2 0 1 0 4 0',settings:'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',guide:'M4 3h7q2 0 2 3v16q-1-2-3-2H4z M13 6q0-3 3-3h5v17h-5q-2 0-3 2'};
 H.icon=n=>`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n]||paths.orders}"></path></svg>`;
 const nav=[
   ['daily','日常工作',[['dashboard','运营总览'],['dispatch','地图调度'],['orders','订单与交付'],['inbound','海运到仓'],['inventory','库存与仓网']]],
   ['resources','资源与方案',[['plans','履约方案'],['resources','仓网与运力'],['suppliers','供应商管理'],['services','服务项目']]],
   ['collaboration','协作与保障',[['comms','预约与短信'],['risks','风险与异常'],['cost','成本与激励']]],
   ['portals','客户与司机',[['portal','客户收集表'],['driver','司机工作台']]],
   ['settings','设置与帮助',[['settings','接口与时区'],['guide','使用指南']]]
 ];
 const title=p=>nav.flatMap(n=>n[2]).find(n=>n[0]===p)?.[1]||'运营总览';
 H.navExpanded=H.navExpanded||new Set(['daily']);
 /* SEARCH_ENGINE_START */
 function searchOrders(orders,query){
   const normalize=value=>String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/\s+/g,' ');
   const term=normalize(query),tokens=term.split(' ').filter(Boolean);
   if(!term)return [];
   return orders.map((order,index)=>{
     const id=normalize(order.id),customer=normalize(order.customer),city=normalize(order.city);
     const haystack=[id,customer,city,normalize(order.state),normalize(order.zip)].join(' ');
     if(!tokens.every(token=>haystack.includes(token)))return null;
     const score=id===term?0:id.startsWith(term)?1:customer===term?2:customer.startsWith(term)?3:city===term?4:5;
     return {order,index,score};
   }).filter(Boolean).sort((a,b)=>a.score-b.score||a.index-b.index).map(result=>result.order);
 }
 H.searchOrders=query=>searchOrders(H.state.orders,query);
 /* SEARCH_ENGINE_END */
 H.openOrderFromSearch=id=>{
   if(!H.order(id)){H.toast('该订单已不存在，请重新搜索。');return;}
   H.$('#modal')?.remove();
   if(H.page==='orders'){H.showOrder(id);return;}
   H.pendingOrderId=id;H.navigate('orders');
 };
 function searchRow(order,index){return `<button type="button" class="search-result" id="search-result-${index}" role="option" aria-selected="false" tabindex="-1" data-search-order="${H.e(order.id)}"><span class="search-result-main"><b>${H.e(order.id)}</b><strong>${H.e(order.customer)}</strong><small>${H.e(order.city)}${order.state?', '+H.e(order.state):''}${order.zip?' · '+H.e(order.zip):''}</small></span><span class="search-result-state">${H.e(order.status||'待处理')}</span></button>`;}
 function showSearchResults(query){
   const results=H.searchOrders(query);
   H.modal(`搜索结果 · ${results.length} 单`,`<p class="search-dialog-query">搜索“${H.e(query)}” · 选择订单查看完整信息</p><div class="search-dialog-results">${results.map((order,index)=>searchRow(order,index).replace('role="option"','')).join('')||H.empty('没有匹配的订单，试试订单号、客户、城市或 ZIP。')}</div>`,null);
   H.$$('.search-dialog-results [data-search-order]').forEach(button=>{button.removeAttribute('tabindex');button.removeAttribute('aria-selected');button.onclick=()=>H.openOrderFromSearch(button.dataset.searchOrder);});
 }
 function mountSearch(){
   H.searchCleanup?.();
   const input=H.$('#global-search'),panel=H.$('#global-search-panel');
   let matches=[],active=-1,query='';
   const close=()=>{panel.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
   const highlight=()=>{
     const options=H.$$('.search-result',panel);
     options.forEach((option,index)=>{option.classList.toggle('is-active',index===active);option.setAttribute('aria-selected',String(index===active));});
     if(active>=0&&options[active]){input.setAttribute('aria-activedescendant',options[active].id);options[active].scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
   };
   const update=()=>{
     query=input.value.trim();matches=H.searchOrders(query);active=-1;
     if(!query){close();return;}
     panel.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
     panel.innerHTML=`<div class="search-panel-heading" role="status">${matches.length?'找到 '+matches.length+' 张订单':'未找到匹配订单'}</div><div class="search-options" id="global-search-options" role="listbox" aria-label="匹配订单">${matches.slice(0,8).map(searchRow).join('')}</div>${matches.length?`<button type="button" class="search-all">查看全部 ${matches.length} 条结果 <span>↵</span></button>`:'<p class="search-empty">试试订单号、客户、城市或 ZIP。</p>'}`;
     H.$$('[data-search-order]',panel).forEach(button=>button.onclick=()=>{close();H.openOrderFromSearch(button.dataset.searchOrder);});
     const all=H.$('.search-all',panel);if(all)all.onclick=()=>{close();showSearchResults(query);};
   };
   input.oninput=update;input.onfocus=()=>{if(input.value.trim())update();};
   input.onkeydown=event=>{
     if(event.key==='Escape'){close();event.stopPropagation();return;}
     if(event.key==='ArrowDown'||event.key==='ArrowUp'){
       event.preventDefault();if(panel.hidden)update();
       const count=Math.min(matches.length,8);if(!count)return;
       active=event.key==='ArrowDown'?(active+1)%count:(active<0?count-1:(active-1+count)%count);highlight();return;
     }
     if(event.key==='Enter'){
       event.preventDefault();query=input.value.trim();if(!query)return;
       matches=H.searchOrders(query);
       if(active>=0&&matches[active]){const id=matches[active].id;close();H.openOrderFromSearch(id);}
       else if(matches.length===1){const id=matches[0].id;close();H.openOrderFromSearch(id);}
       else if(matches.length){close();showSearchResults(query);}else update();
     }
   };
   const pointer=event=>{if(!event.target.closest('.top-search'))close();};
   const key=event=>{
     if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(H.$('.shell')?.classList.contains('nav-open'))H.setNavOpen?.(false);input.focus();input.select();}
     if(event.key==='Escape'){close();if(H.$('.shell')?.classList.contains('nav-open'))H.setNavOpen?.(false);}
   };
   document.addEventListener('pointerdown',pointer);document.addEventListener('keydown',key);
   H.searchCleanup=()=>{document.removeEventListener('pointerdown',pointer);document.removeEventListener('keydown',key);};
 }
 H.pages.dashboard=()=>{const orders=H.state.orders,risks=H.state.risks.filter(x=>x.status!=='已结案'),transit=H.state.inbound.filter(s=>s.status!=='已入仓'),ready=orders.filter(o=>!H.releaseIssues(o).length&&o.status!=='物理交付完成');return H.heading('运营总览','先处理需要关注的事项，再进入区域调度。',`<button class="btn" data-nav="guide">操作指南</button><button class="btn primary" data-nav="dispatch">进入调度工作台 →</button>`)+`<div class="muted" style="font-size:12px;margin-bottom:8px">业务时刻对照 · 2026-10-28 14:00 UTC（演示时刻）</div><div class="zone-strip">${[['洛杉矶','America/Los_Angeles'],['达拉斯','America/Chicago'],['纽约','America/New_York'],['北京','Asia/Shanghai']].map(([name,zone])=>`<div class="zone-clock"><small>${name} · ${new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'short'}).formatToParts(new Date('2026-10-28T14:00:00Z')).find(p=>p.type==='timeZoneName').value}</small><b>${new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date('2026-10-28T14:00:00Z'))}</b></div>`).join('')}</div><div class="metrics">${H.metric('在途海运设备',transit.reduce((a,s)=>a+s.units,0)+' 台',transit.length+' 柜 · 预计到货，未计入可售')}${H.metric('待执行配送',orders.filter(o=>o.status!=='物理交付完成').length+' 单',ready.length+' 单符合演示核验条件')}${H.metric('需处理事项',risks.length+' 项',risks.filter(x=>x.severity==='高').length+' 项高风险 · 每项均有责任人','accent')}${H.metric('同服务预计净收益',H.money(H.state.cost.baseline-H.state.cost.proposed-H.state.cost.saas-H.state.cost.labor-H.state.cost.bonus),'V5 10 单纯演算 · 非实际降本','green')}</div><div class="overview-grid"><section class="card"><div class="card-head"><h3>美国履约网络</h3><div class="actions">${H.pill(H.state.warehouses.filter(w=>w.active!==false&&!w.type.includes('待验证')).length+' 个可用示例仓','teal')}<button class="text-link" data-nav="dispatch">打开地图 →</button></div></div><div id="overview-map" class="overview-map" aria-label="美国仓库与订单示意地图"></div><div class="flow-strip">${[['海运在途',transit.length+' 柜'],['目的仓接收','待点检'],['区域调度',orders.length+' 单'],['物理交付',orders.filter(o=>o.status==='物理交付完成').length+' 单']].map(([l,n])=>`<div class="flow-step">${l}<strong>${n}</strong></div>`).join('')}</div></section><section class="card"><div class="card-head"><h3>优先处理</h3><button class="text-link" data-nav="risks">全部事项 →</button></div><div class="card-body timeline-list">${risks.slice(0,3).map(r=>`<div class="timeline-item"><div class="actions" style="margin-bottom:6px">${H.pill(r.severity+'风险',r.severity==='高'?'red':'amber')}<small>${H.e(r.ref)}</small></div><b>${H.e(r.title)}</b><small style="margin-top:6px">${H.e(r.owner)} · ${H.e(r.next)}</small><small>${H.e(r.due)}</small></div>`).join('')||H.empty('所有风险已结案')}<button class="btn section-gap" data-nav="risks">处理异常与保管安排</button></div></section></div><div class="grid cols-2 section-gap"><section class="card"><div class="card-head"><h3>近期到仓计划</h3><button class="text-link" data-nav="inbound">船期甘特 →</button></div><div class="table-wrap"><table class="table"><thead><tr><th>批次 / 目的仓</th><th>数量</th><th>预计送仓</th><th>状态</th></tr></thead><tbody>${transit.slice().sort((a,b)=>a.delivery.localeCompare(b.delivery)).map(s=>`<tr><td><strong>${s.id}</strong><small>${H.warehouse(s.warehouse).city}</small></td><td>${s.units} 台</td><td>${s.delivery}<small>${s.hold?'查验情景，未承诺':'目的仓当地日期'}</small></td><td>${H.pill(s.status)}</td></tr>`).join('')}</tbody></table></div></section><section class="card"><div class="card-head"><h3>交付前的四个关口</h3><small>依据 V5 执行规则</small></div><div class="card-body">${[['01','现场与服务','明确终点、未知通道和包装；L4/L5 逐项列明。'],['02','库存与接管','序列号唯一锁定；C 路径先确认专业站点接收。'],['03','预约与时区','客户确认当地窗口；短信送达不自动确认。'],['04','成本与放行','完整报价、实际承接、异常保管和费用权限齐备。']].map(([n,a,b])=>`<div class="guide-step" style="padding:10px 0"><span class="guide-number" style="font-size:16px;width:25px">${n}</span><div><h3 style="font-size:14px">${a}</h3><p style="margin:0;font-size:13px">${b}</p></div></div>`).join('')}</div></section></div>`;};
 H.mounts.dashboard=()=>{if(!window.L)return;const map=L.map('overview-map',{zoomControl:false,scrollWheelZoom:false,dragging:false,attributionControl:true}).setView([38,-96],3);H.currentMap=map;L.geoJSON(US_STATES,{style:{color:'#bdcdcf',weight:.7,fillColor:'#e1ebe8',fillOpacity:1},filter:f=>!['AK','HI'].includes(f.properties.abbr)}).addTo(map);H.state.warehouses.forEach(w=>{const candidate=w.id==='WH-ATL',labelled=!w.type.includes('供应商仓示例')||candidate;L.circleMarker([w.lat,w.lng],{radius:candidate?4:7,color:'white',weight:2,fillColor:candidate?'#9caaa9':'#d65335',fillOpacity:1}).addTo(map).bindTooltip(w.city+(candidate?' · 待验证':' · 示例仓'),{permanent:labelled,direction:'top',className:'overview-tooltip',opacity:1});});H.state.orders.forEach(o=>L.circleMarker([o.lat,o.lng],{radius:3,color:'#247b73',weight:1,fillColor:'#247b73',fillOpacity:.55}).addTo(map));map.fitBounds([[25,-124],[49,-67]],{padding:[14,12]});map.attributionControl.addAttribution('边界：V3.1 内置 GeoJSON · 城市级虚构业务点');setTimeout(()=>map.invalidateSize(),50);};
 H.pages.guide=()=>H.heading('开始使用 V8','从一张订单出发，按明确的下一步完成预排、核验和交付。',`<button class="btn primary" data-nav="dispatch">打开地图调度 →</button>`)+`
   <div class="hero-note"><div><h2>把下一步放在眼前</h2><p>订单、区域地图和路线计划联动。预排结果用于比较方案，完整核验后才可进入批次流程。</p></div><span class="guide-version">V8 工作台</span></div>
   <div class="grid cols-2"><section class="card"><div class="card-head"><h3>调度工作的四个步骤</h3></div><div class="card-body">${[
     ['01','选择订单','选择出发仓和日期，查看当前区域的订单。检查收货窗口、服务范围和待补资料。','dispatch'],
     ['02','生成预排','设置车组、配送方和起仓时间，比较顺序、工时、装载和情景成本。','dispatch'],
     ['03','放行前校验','补齐现场、库存、接管、费用与预约依据。修改订单版本后，应重新核验。','orders'],
     ['04','保存批次','保存已检查的计划，交付后记录凭证并继续处理异常和技术验收。','dispatch']
   ].map(([n,t,d,p])=>`<div class="guide-step"><span class="guide-number">${n}</span><div><h3>${t}</h3><p>${d}</p><button class="text-link" data-nav="${p}">进入操作 →</button></div></div>`).join('')}</div></section>
   <div class="grid"><section class="card"><div class="card-head"><h3>更快找到需要的信息</h3></div><div class="card-body guide-tips"><p><b>全局搜索</b><br>输入订单号、客户、城市或 ZIP，查看全部匹配结果。↑↓ 选择，回车打开；没有选中结果时，回车查看完整列表。</p><p><b>键盘入口</b><br>使用 <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> 聚焦搜索，<kbd>Esc</kbd> 关闭搜索或弹窗。</p><p><b>分组导航</b><br>日常工作保持展开；资源、协作、客户与设置按需展开。手机点左上角菜单可进入全部模块。</p><p><b>手机调度</b><br>使用“订单 / 地图 / 计划”切换工作区；关键按钮保留足够的点击空间。</p></div></section>
   <section class="card"><div class="card-head"><h3>时间、资料和估算</h3></div><div class="card-body guide-tips"><p><b>业务当地时间为准</b><br>客户收货窗口与仓库出发时间各自保留所在时区；北京时间用于协同，UTC 用于内部比较。</p><p><b>草案与放行分开</b><br>“可复核”提示可以进一步检查。缺少现场、库存、预约或费用依据时，不应直接安排执行。</p><p><b>地图与金额说明</b><br>示例坐标为城市级位置，虚线是估算连接。情景里程、费用和预计时间不构成道路导航或正式报价。</p></div></section></div></div>
   <section class="card section-gap"><div class="card-head"><h3>继续完成协作闭环</h3></div><div class="card-body guide-links">${[['inbound','海运到仓','跟进船期与放行事件'],['inventory','库存与仓网','检查库存锁定与免费期'],['comms','预约与短信','区分通知回执与客户确认'],['risks','风险与异常','明确责任人与反馈时间'],['cost','成本与激励','按同服务范围核对成本'],['settings','接口与时区','查看数据保存与连接状态']].map(([p,t,d])=>`<button class="guide-shortcut" data-nav="${p}">${H.icon(p)}<span><b>${t}</b><small>${d}</small></span><span aria-hidden="true">→</span></button>`).join('')}</div></section>
   <div class="notice amber">此版本包含合成业务数据。客户、司机入口是演示视角；请在“接口与时区”核对连接状态后，再决定是否接入真实协作数据。</div>`;
 H.unmounts=H.unmounts||{};
 H.render=()=>{
   const previous=H.renderedPage;
   H.searchCleanup?.();H.searchCleanup=null;H.shellCleanup?.();H.shellCleanup=null;
   H.unmounts[previous]?.();
   H.currentMap?.remove();H.currentMap=null;
   const page=H.pages[H.page]?H.page:'dispatch';H.page=page;H.renderedPage=page;
   document.body.dataset.page=page;
   const app=H.$('#app'),compact=page==='dispatch';
   const navigation=nav.map(([key,group,items])=>{
     const open=H.navExpanded.has(key)||items.some(([p])=>p===page);
     return `<details class="nav-group" data-nav-group="${key}" ${open?'open':''}><summary>${group}<span class="nav-chevron" aria-hidden="true">⌄</span></summary><div class="nav-group-links">${items.map(([p,label])=>`<button type="button" data-nav="${p}" title="${label}" class="${page===p?'active':''}" ${page===p?'aria-current="page"':''}>${H.icon(p)}<span class="nav-full">${label}</span></button>`).join('')}</div></details>`;
   }).join('');
   app.innerHTML=`<a class="skip-link" href="#main">跳到主要内容</a><div class="shell ${compact?'map-shell':''}"><button class="nav-backdrop" type="button" aria-label="关闭导航"></button><aside class="sidebar" id="primary-sidebar"><div class="brand"><div class="brand-mark">H</div><div class="brand-copy"><strong>HAHA</strong><small>LOGISTICS</small></div><button class="sidebar-close" type="button" aria-label="关闭导航">×</button></div><nav class="nav" aria-label="主导航">${navigation}</nav><div class="side-bottom"><b>V8 工作台</b><span>公开演示 · 本机保存</span></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb"><button class="menu-trigger" id="menu-toggle" aria-label="展开导航" aria-controls="primary-sidebar" aria-expanded="false">☰</button><span class="workspace-tag">运营工作台 <span aria-hidden="true">/</span></span><b>${title(page)}</b></div><div class="top-actions"><div class="top-search"><svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg><input id="global-search" aria-label="搜索订单、客户或城市" placeholder="订单 / 客户 / 城市" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="global-search-options" aria-expanded="false"><kbd class="search-key">⌘ K</kbd><div class="global-search-panel" id="global-search-panel" hidden><div id="global-search-options" role="listbox" aria-label="匹配订单"></div></div></div><label class="zone-selector"><span>时间对照</span><select id="view-zone" aria-label="时间显示视角"><option value="local">业务当地</option><option value="Asia/Shanghai">北京时间</option><option value="UTC">UTC</option></select></label><span class="demo-indicator" data-save-status>演示 · 本机保存</span><button class="btn small portal-top" data-nav="portal">客户入口 ↗</button></div></header><main class="content" id="main" tabindex="-1" data-screen-label="${title(page)}">${H.pages[page]()}${compact?'':`<div class="footer-note"><span>HAHA V8 · 合成业务数据 · 城市级示例位置</span><span>业务当地执行 / UTC 比较 / 北京协同</span></div>`}</main></div></div>`;
   H.$$('[data-nav]').forEach(button=>button.onclick=()=>H.navigate(button.dataset.nav));
   H.$$('[data-nav-group]').forEach(group=>group.addEventListener('toggle',()=>{if(group.open)H.navExpanded.add(group.dataset.navGroup);else H.navExpanded.delete(group.dataset.navGroup);}));
   H.$('.skip-link').onclick=event=>{event.preventDefault();H.$('#main').focus();};
   mountSearch();
   const mobileNav=window.matchMedia('(max-width:1000px)');
   const syncNav=()=>{const open=H.$('.shell').classList.contains('nav-open');H.$('.sidebar').inert=mobileNav.matches&&!open;H.$('.workspace').inert=mobileNav.matches&&open;H.$('.sidebar').setAttribute('aria-hidden',String(mobileNav.matches&&!open));};
   const toggleNav=open=>{H.$('.shell').classList.toggle('nav-open',open);H.$('#menu-toggle').setAttribute('aria-expanded',String(open));syncNav();if(open)H.$('.sidebar button.active')?.focus();else if(mobileNav.matches)H.$('#menu-toggle').focus();setTimeout(()=>{H.currentMap?.invalidateSize();H.dispatch?.refreshSize?.();},180);};
   H.setNavOpen=toggleNav;syncNav();mobileNav.addEventListener('change',syncNav);
   H.shellCleanup=()=>mobileNav.removeEventListener('change',syncNav);
   H.$('#menu-toggle').onclick=()=>toggleNav(!H.$('.shell').classList.contains('nav-open'));
   H.$('.nav-backdrop').onclick=()=>toggleNav(false);H.$('.sidebar-close').onclick=()=>toggleNav(false);
   H.$('#view-zone').value=H.state.settings.viewZone||'local';
   H.$('#view-zone').onchange=event=>{H.state.settings.viewZone=event.target.value;H.save('切换辅助时间视角');H.render();};
   H.mounts[page]?.();
   H.afterRender?.(page);
   if(page==='orders'&&H.pendingOrderId){const id=H.pendingOrderId;H.pendingOrderId=null;H.showOrder(id);}
 };
 window.addEventListener('hashchange',()=>{H.page=location.hash.slice(1)||'dispatch';H.render();window.scrollTo(0,0);});
 window.addEventListener('storage',event=>{if(event.key===(H.storageKey||'haha-v8')){try{const state=H.validateState?H.validateState(JSON.parse(event.newValue)):JSON.parse(event.newValue);if(state?.schema===7){const editing=H.$('#modal')||document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');if(editing){H.toast('其他标签页已更新数据。当前编辑已保留，完成后请刷新查看。');return;}H.state=state;H.render();}}catch{}}});
 H.page=location.hash.slice(1)||'dispatch';H.render();
})(window.HH);
