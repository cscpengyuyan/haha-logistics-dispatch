/* V7: explicit service scopes, versioned order snapshots, no implied services. */
(function (H) {
  'use strict';
  const E = H.e;
  const defaults = [
    ['SV-LIFT','尾板卸货','装卸',15,'T1','withDelivery','已核尾板有效尺寸、额定载荷及地面条件'],
    ['SV-UNPACK','拆外包装','包装',15,'T2','withDelivery','仅拆约定外包装；保留产品和运输保护要求'],
    ['SV-DEPALLET','去托盘','包装',20,'T2','withDelivery','按机型批准支撑点及安全方法，禁止临时倾斜'],
    ['SV-LEVEL','设备就位与找平','就位',10,'T2','withDelivery','地面承载和器具适配；不含电气连接'],
    ['SV-DEBRIS','包装材料清运','包装',10,'T2','withDelivery','范围、处置责任和物业要求已明确'],
    ['SV-PROTECT','地面与通道保护','就位',15,'T2','withDelivery','材料、铺设与撤回责任明确'],
    ['SV-SPECIAL','特殊通道搬运（L4）','特殊',45,'T4','withDelivery','楼梯、转角、坡道或专用器具需独立作业方案'],
    ['SV-TECH','安装、联网与功能验收（L5）','技术',60,'T5','separate','产品授权、适用资格、安装说明与测试结果'],
    ['SV-RETURN','约定旧机或包装返运','返运',20,'T2','withDelivery','返运对象、接收地点、载荷及费用另行批准']
  ].map(([id,name,category,minutes,capability,mode,conditions])=>({id,name,category,minutes,capability,mode,conditions,price:null,enabled:true,executor:'待指定',scope:'按书面范围执行',costOwner:'待确认'}));
  const englishNames={'SV-LIFT':'Tail-lift unloading','SV-UNPACK':'Outer packaging removal','SV-DEPALLET':'Pallet removal','SV-LEVEL':'Positioning and leveling','SV-DEBRIS':'Packaging debris removal','SV-PROTECT':'Floor and route protection','SV-SPECIAL':'Special access handling (L4)','SV-TECH':'Technical setup and acceptance (L5)','SV-RETURN':'Agreed equipment or packaging return'};
  defaults.forEach(x=>{x.englishName=englishNames[x.id];x.excluded='Unlisted work is not included';});
  const endpointNames={L1:'货运交接点',L2:'约定入口 / 门槛',L3:'室内指定位置'};
  const modes={withDelivery:'随配送作业',separate:'独立工单 / 不占配送路线时长'};
  const choose=(items,value)=>items.map(([v,l])=>`<option value="${E(v)}" ${v===value?'selected':''}>${E(l)}</option>`).join('');
  const options=(name,label,value)=>`<label class="field">${label}<select name="${name}">${choose([['T1','T1 基础运输'],['T2','T2 专业末端'],['T3','T3 区域仓储'],['T4','T4 特殊搬运'],['T5','T5 产品技术']],value)}</select></label>`;
  function init(state=H.state){
    state.schema=7; state.settings=state.settings||{};state.settings.viewZone=state.settings.viewZone||'local';
    state.serviceCatalog=Array.isArray(state.serviceCatalog)?state.serviceCatalog:H.clone(defaults);
    for(const o of state.orders||[]){
      if(!Array.isArray(o.serviceLines)){
        o.serviceLines=[];
        if(o.L4)o.serviceLines.push(snapshot(state.serviceCatalog.find(x=>x.id==='SV-SPECIAL')||defaults[6]));
        if(o.L5)o.serviceLines.push(snapshot(state.serviceCatalog.find(x=>x.id==='SV-TECH')||defaults[7]));
        const added=o.serviceLines.filter(x=>x.mode==='withDelivery').reduce((a,x)=>a+x.minutes*x.quantity,0);
        o.baseServiceMinutes=Math.max(1,(Number(o.serviceMins)||({L1:25,L2:30,L3:45}[o.endpoint]||25))-added);
      }
      o.baseServiceMinutes=Number(o.baseServiceMinutes)||({L1:25,L2:30,L3:45}[o.endpoint]||25);
      o.serviceMins=duration(o);
    }
    return state;
  }
  function snapshot(item){return {id:'SL-'+item.id,catalogId:item.id,name:item.name,englishName:item.englishName||'Custom service',excluded:item.excluded||'',quantity:1,minutes:item.minutes,price:item.price,executor:item.executor||'待指定',capability:item.capability,mode:item.mode,scope:item.scope||'按书面范围执行',conditions:item.conditions||'',costOwner:item.costOwner||'待确认'};}
  function duration(o){return Math.round((Number(o.baseServiceMinutes)||Number(o.serviceMins)||25)+(o.serviceLines||[]).filter(x=>x.mode==='withDelivery').reduce((sum,x)=>sum+Number(x.minutes)*Number(x.quantity),0));}
  function requiredTypes(o){return [...new Set([o.path==='A'?'T1':'T2',...(o.serviceLines||[]).filter(x=>x.mode==='withDelivery').map(x=>x.capability)].filter(Boolean))];}
  function summary(o){return [o.endpoint+' '+(endpointNames[o.endpoint]||''),...(o.serviceLines||[]).map(x=>x.name+(x.quantity>1?' ×'+x.quantity:'')+(x.mode==='separate'?'（独立）':''))].join(' · ');}
  function englishSummary(o){return [({L1:'Agreed freight handoff',L2:'Accessible entrance / threshold',L3:'Designated indoor position'}[o.endpoint]||o.endpoint),...(o.serviceLines||[]).map(x=>(x.englishName||x.name)+' ×'+x.quantity+(x.mode==='separate'?' (separate work order)':''))].join(' · ');}
  function quote(o){return (o.serviceLines||[]).reduce((a,x)=>a+(Number.isFinite(x.price)?x.price*x.quantity:0),0);}
  function invalidate(o,reason,previous){
    const oldVersion=o.version||1;
    o.history=o.history||[];o.history.push({time:new Date().toISOString(),action:'服务/计划范围变更',detail:reason,previous:previous||{version:oldVersion,endpoint:o.endpoint,serviceLines:H.clone(o.serviceLines||[])}});
    o.version=oldVersion+1;o.status='待放行';o.appointment='待重新确认';o.appointmentVersion=null;o.confirmedVersion=null;o.customerScopeReviewedVersion=null;
    o.checks={...o.checks,site:false,provider:false,budget:false};delete o.release;delete o.verifiedVersion;
    for(const b of H.state.batches||[]){if((b.orderIds||[]).includes(o.id)&&!['已取消','取消','完成'].includes(b.status)){b.needsReview=true;b.invalidatedReason=reason;}}
  }
  function syncLegacy(o){
    o.serviceLines=o.serviceLines||[];
    for(const [flag,id]of [['L4','SV-SPECIAL'],['L5','SV-TECH']]){
      const has=o.serviceLines.some(x=>x.catalogId===id);
      if(o[flag]&&!has)o.serviceLines.push(snapshot(H.state.serviceCatalog.find(x=>x.id===id)||defaults.find(x=>x.id===id)));
      if(!o[flag])o.serviceLines=o.serviceLines.filter(x=>x.catalogId!==id);
    }
    o.serviceMins=duration(o);return o;
  }
  function validateLines(lines){
    if(lines.length>30)throw new Error('单任务最多 30 个服务分项，请拆为独立工单。');
    lines.forEach(x=>{
      if(!x.name?.trim()||x.name.length>120)throw new Error('服务名称需为 1–120 个字符。');
      if(!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>100)throw new Error('服务数量须为 1–100 的整数。');
      if(!Number.isFinite(x.minutes)||x.minutes<0||x.minutes>480)throw new Error('分项时长须为 0–480 分钟。');
      if(x.price!==null&&(!Number.isFinite(x.price)||x.price<0||x.price>100000))throw new Error('服务单价应为非负金额；未知请留空。');
      if(!['withDelivery','separate'].includes(x.mode)||!['T1','T2','T3','T4','T5'].includes(x.capability))throw new Error('服务执行方式或能力类型无效。');
    });return lines;
  }
  function apply(o,change,reason){
    if(o.status==='物理交付完成')throw new Error('已交付服务范围保留历史；请另建后续服务任务。');
    if(!['L1','L2','L3'].includes(change.endpoint))throw new Error('请选择明确的物理交付终点。');
    if(!Number.isFinite(change.baseServiceMinutes)||change.baseServiceMinutes<1||change.baseServiceMinutes>480)throw new Error('基础作业时长须为 1–480 分钟。');
    validateLines(change.serviceLines);if(!reason?.trim())throw new Error('请记录本次服务范围变化原因。');
    const old={version:o.version,endpoint:o.endpoint,baseServiceMinutes:o.baseServiceMinutes,serviceLines:H.clone(o.serviceLines||[])};
    if(JSON.stringify({...old,version:undefined})===JSON.stringify({...change,version:undefined}))return false;
    invalidate(o,reason,old);Object.assign(o,change);
    o.L4=o.serviceLines.some(x=>x.catalogId==='SV-SPECIAL');o.L5=o.serviceLines.some(x=>x.catalogId==='SV-TECH');o.serviceMins=duration(o);
    o.techStatus=o.L5?'待技术验收':'未采购';H.save('变更服务明细',o.id,reason);return true;
  }
  function lineHTML(x,index){return `<div class="svc-line" data-svc-line="${index}"><div class="svc-line-title"><strong>${E(x.name)}</strong><button type="button" class="text-link danger" data-remove-line="${index}">移除分项</button></div><div class="svc-fields">${H.field('项目名称','name-'+index,x.name,'text','required maxlength="120"')}${H.field('English work description','englishName-'+index,x.englishName||'Custom service','text','required')}${H.field('数量','quantity-'+index,x.quantity,'number','min="1" max="100" step="1" required')}${H.field('每次作业分钟','minutes-'+index,x.minutes,'number','min="0" max="480" required')}${H.field('每次单价 USD（未知留空）','price-'+index,x.price??'','number','min="0" max="100000" step="0.01"')}${options('capability-'+index,'需要能力',x.capability)}<label class="field">作业安排<select name="mode-${index}">${choose(Object.entries(modes),x.mode)}</select></label>${H.field('实际执行方 / 团队','executor-'+index,x.executor)}${H.field('费用归属','costOwner-'+index,x.costOwner||'待确认')}${H.field('包含的范围','scope-'+index,x.scope||'')}${H.field('明确不包含','excluded-'+index,x.excluded||'')}${H.field('前提与核验条件','conditions-'+index,x.conditions||'')}</div></div>`;}
  function open(id){
    init();const o=H.order(id);if(!o)return;
    let lines=H.clone(o.serviceLines||[]);
    H.modal(o.id+' · 配置服务工作清单',`<div class="notice">L1–L3 选择物理交付终点；所有附加项目逐项配置。下列金额是演示估计，不代表报价。变更会重开当前版本的现场、承接、预算及预约核验。</div><div class="form-grid"><label class="field">物理交付终点<select name="endpoint">${choose(Object.entries(endpointNames).map(([k,v])=>[k,k+' · '+v]),o.endpoint)}</select></label>${H.field('基础交付作业分钟','baseServiceMinutes',o.baseServiceMinutes,'number','min="1" max="480" required')}</div><div id="svc-order-lines"></div><div class="svc-add"><label class="field">从已启用服务目录添加<select id="svc-add-catalog">${H.state.serviceCatalog.filter(x=>x.enabled).map(x=>`<option value="${E(x.id)}">${E(x.name)}</option>`).join('')}</select></label><button class="btn" type="button" id="svc-add">＋ 添加服务</button><button class="btn" type="button" id="svc-custom">＋ 自定义分项</button></div><div id="svc-total" class="notice"></div>${H.field('本次变更原因 / 需求依据','serviceReason','','text','required placeholder="如：客户要求拆包清运，由末端团队书面承接"')}`,fd=>{
      const values=readLines(fd);const change={endpoint:fd.get('endpoint'),baseServiceMinutes:Number(fd.get('baseServiceMinutes')),serviceLines:values};apply(o,change,String(fd.get('serviceReason')));H.toast('服务范围已保存，相关核验与预约需重新确认。');
    },'保存服务版本');
    const host=H.$('#svc-order-lines');
    function readLines(fd=new FormData(H.$('#modal form'))){return lines.map((x,i)=>({...x,name:String(fd.get('name-'+i)||'').trim(),englishName:String(fd.get('englishName-'+i)||'').trim(),excluded:String(fd.get('excluded-'+i)||'').trim(),quantity:Number(fd.get('quantity-'+i)),minutes:Number(fd.get('minutes-'+i)),price:String(fd.get('price-'+i)||'').trim()===''?null:Number(fd.get('price-'+i)),capability:fd.get('capability-'+i),mode:fd.get('mode-'+i),executor:String(fd.get('executor-'+i)||'').trim(),costOwner:String(fd.get('costOwner-'+i)||'').trim(),scope:String(fd.get('scope-'+i)||'').trim(),conditions:String(fd.get('conditions-'+i)||'').trim()}));}
    function totals(){try{const draft={baseServiceMinutes:Number(H.$('#modal [name="baseServiceMinutes"]').value),serviceLines:readLines()};H.$('#svc-total').textContent=`配送路线现场作业 ${duration(draft)} 分钟；${draft.serviceLines.filter(x=>x.mode==='separate').length} 个独立工单。已填写分项估计 ${H.money(quote(draft))}；${draft.serviceLines.filter(x=>x.price===null).length} 项价格待核。`; }catch{}}
    function renderLines(){host.innerHTML=lines.map(lineHTML).join('')||'<div class="empty">尚未选择附加服务。基础交付不自动包含拆包、去托、清运或技术服务。</div>';H.$$('[data-remove-line]',host).forEach(b=>b.onclick=()=>{lines=readLines();lines.splice(Number(b.dataset.removeLine),1);renderLines();});H.$$('input,select',host).forEach(x=>x.oninput=totals);totals();}
    H.$('#svc-add').onclick=()=>{lines=readLines();const item=H.state.serviceCatalog.find(x=>x.id===H.$('#svc-add-catalog').value);if(!item)return;if(lines.some(x=>x.catalogId===item.id)){H.toast('该项目已在清单中，可修改数量或明细。');return;}lines.push(snapshot(item));renderLines();};
    H.$('#svc-custom').onclick=()=>{lines=readLines();lines.push({id:'SL-CUSTOM-'+Date.now(),catalogId:null,name:'自定义服务',englishName:'Custom service',excluded:'Unlisted work is not included',quantity:1,minutes:15,price:null,executor:'待指定',capability:'T2',mode:'withDelivery',scope:'',conditions:'',costOwner:'待确认'});renderLines();};
    H.$('#modal [name="baseServiceMinutes"]').oninput=totals;renderLines();
  }
  function editCatalog(id){const old=H.state.serviceCatalog.find(x=>x.id===id);const item=old||{name:'',category:'自定义',minutes:15,price:null,capability:'T2',mode:'withDelivery',enabled:true,executor:'待指定',scope:'',conditions:'',costOwner:'待确认'};
    H.modal(old?'编辑服务目录 · '+item.name:'新增可选服务',`<div class="notice">目录是新选择的默认值。修改目录不会悄悄改写已确认订单；需到订单服务清单中重新应用并保留版本。</div><div class="form-grid">${H.field('服务名称','name',item.name,'text','required maxlength="120"')}${H.field('English work description','englishName',item.englishName||'Custom service','text','required')}${H.field('分类','category',item.category,'text','required')}${H.field('默认每次分钟','minutes',item.minutes,'number','min="0" max="480" required')}${H.field('默认单价 USD（未知留空）','price',item.price??'','number','min="0" step="0.01"')}${options('capability','所需能力',item.capability)}<label class="field">默认作业安排<select name="mode">${choose(Object.entries(modes),item.mode)}</select></label>${H.field('执行方 / 团队默认值','executor',item.executor)}${H.field('费用归属默认值','costOwner',item.costOwner)}${H.field('包含范围','scope',item.scope)}${H.field('明确不包含','excluded',item.excluded||'')}${H.field('前提及核验条件','conditions',item.conditions)}<label class="check-row"><input name="enabled" type="checkbox" ${item.enabled?'checked':''}>允许新订单选用</label></div>`,fd=>{const data={...item,name:String(fd.get('name')).trim(),englishName:String(fd.get('englishName')).trim(),excluded:String(fd.get('excluded')||'').trim(),category:String(fd.get('category')).trim(),minutes:Number(fd.get('minutes')),price:String(fd.get('price')||'').trim()===''?null:Number(fd.get('price')),capability:fd.get('capability'),mode:fd.get('mode'),executor:String(fd.get('executor')),costOwner:String(fd.get('costOwner')),scope:String(fd.get('scope')),conditions:String(fd.get('conditions')),enabled:fd.has('enabled')};validateLines([{...data,quantity:1}]);if(old)Object.assign(old,data);else H.state.serviceCatalog.push({...data,id:'SV-CUSTOM-'+Date.now()});H.save('更新可选服务目录',old?.id||'new','不改写已存订单服务快照');});
  }
  H.pages.services=()=>{init();return H.heading('服务工作清单','把服务拆清楚：做什么、谁执行、需什么能力、多少时间、由谁承担费用。',`<button class="btn primary" id="svc-catalog-new">＋ 新增服务项目</button>`)+`<div class="svc-intro"><div><span class="eyebrow">SCOPE BEFORE COMMITMENT</span><h2>基础交付 + 可组合的作业明细</h2><p>L1–L3 是终点，不是自动逐级包含的套餐。L4、L5 和所有附加项均可按订单配置。</p></div><div class="svc-intro-count"><strong>${H.state.serviceCatalog.filter(x=>x.enabled).length}</strong><span>可选服务项目</span></div></div><div class="svc-catalog">${H.state.serviceCatalog.map(x=>`<article class="svc-card ${x.enabled?'':'is-disabled'}"><div class="svc-card-top">${H.pill(x.category,'blue')}${H.pill(x.enabled?'可选':'暂停新选',x.enabled?'green':'amber')}</div><h3>${E(x.name)}</h3><p>${E(x.conditions)}</p><div class="svc-card-stats"><span>${x.minutes} min / 次</span><span>${x.price===null?'单价待核':H.money(x.price)}</span><span>${E(x.capability)}</span></div><small>${E(modes[x.mode])}</small><button class="btn small" data-edit-service="${E(x.id)}">编辑默认 / 启停</button></article>`).join('')}</div><section class="card section-gap"><div class="card-head"><h3>订单服务清单</h3><small>修改时保留服务快照与历史版本</small></div><div class="table-wrap"><table class="table"><thead><tr><th>订单 / 客户</th><th>当前服务</th><th>路线作业时长</th><th>明细估计</th><th></th></tr></thead><tbody>${H.state.orders.map(o=>`<tr><td><b>${E(o.id)}</b><small>${E(o.customer)} · v${o.version}</small></td><td>${E(summary(o))}</td><td>${duration(o)} min<small>${(o.serviceLines||[]).filter(x=>x.mode==='separate').length} 个独立工单</small></td><td>${H.money(quote(o))}<small>${(o.serviceLines||[]).filter(x=>x.price===null).length} 项价格待核；不含基础运价</small></td><td><button class="btn small" data-order-services="${E(o.id)}">配置服务</button></td></tr>`).join('')}</tbody></table></div></section>`;};
  H.mounts.services=()=>{H.$('#svc-catalog-new').onclick=()=>editCatalog();H.$$('[data-edit-service]').forEach(b=>b.onclick=()=>editCatalog(b.dataset.editService));H.$$('[data-order-services]').forEach(b=>b.onclick=()=>open(b.dataset.orderServices));};
  H.services={init,duration,requiredTypes,summary,englishSummary,quote,open,apply,invalidate,syncLegacy,validateLines,endpointNames};init();
})(window.HH);
