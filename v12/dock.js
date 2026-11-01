'use strict';
window.Dock={
 async mount(h,ctx){
  const e=ctx.escape, role=ctx.user.role;
  if(!['procurement','warehouse','dispatch','admin','finance'].includes(role)){h.textContent='当前岗位不办理仓口验放';return}
  const orders=ctx.orders.filter(o=>!o.pickup),opt=(v,t)=>'<option value="'+e(v)+'">'+e(t)+'</option>';
  const field=(k,t,val='',req=true)=>'<label class="field"><span>'+e(t)+'</span><input name="'+k+'" value="'+e(val)+'" '+(req?'required':'')+' autocomplete="off"></label>';
  let oid=ctx.focusOrderId||sessionStorage.getItem('dockOrder');if(!orders.some(o=>o.id===oid))oid=(orders.find(o=>o.crm_ref==='DFW-Q01')||orders[0])?.id;
  h.innerHTML='<section class="card"><div class="kicker">WAREHOUSE RELEASE DESK</div><h2>仓口验放</h2><p>以当前运段的授权、人车和逐台交接记录决定是否出库。</p><form data-scan class="pilot-action"><label>扫描或输入提货号 <input name="pickup_code" required></label><button>查当前 F04</button></form><p data-scan-msg role="alert"></p><label class="field">选择本票<select id="dock-order">'+orders.map(o=>opt(o.id,(o.crm_ref||o.id)+' · '+o.warehouse+' → '+o.zip)).join('')+'</select></label><div id="dock-detail"></div></section>';
  const sel=h.querySelector('#dock-order');sel.value=oid||'';sel.onchange=()=>{oid=sel.value;sessionStorage.setItem('dockOrder',oid);load()};
  const req=(url,body)=>ctx.api(url,{method:'POST',body});
  h.querySelector('[data-scan]').onsubmit=async ev=>{ev.preventDefault();const msg=h.querySelector('[data-scan-msg]');try{const r=await req('/api/gate/lookup',Object.fromEntries(new FormData(ev.target)));sel.value=r.order_id;sel.onchange();msg.textContent=''}catch(x){msg.textContent=x.message}};
  let requestNo=0;
  async function load(flash=''){
   const request=++requestNo,id=oid;
   const box=h.querySelector('#dock-detail');if(!oid){box.textContent='没有可办理的订单';return}
   try{
    const [{order:o},a,net]=await Promise.all([ctx.api('/api/orders/'+id),ctx.api('/api/gate/'+id),ctx.api('/api/gate/network')]);
    if(request!==requestNo||oid!==id)return;
    const g=a.grant||{},q=a.leg===2?o.second_leg:o.selected_quote||o.platform_instruction||{},links=net.links.filter(x=>x.executor_id===(q||{}).executor_id);
    const leg=a.leg,paid=(q||{}).payee_id||(q||{}).supplier_id,st={invited:'待执行方回函',accepted:'已书面接受 · 待调度签发',issued:'已签发 · 待仓口验放',released:'已逐台交接'}[g.state]||'待本段授权';
    const display=(k)=>e(k||'待核');const sns=(o.sn||'').split(/[,，;；\n]+/).map(x=>x.trim()).filter(Boolean);
    box.innerHTML='<div class="pilot-card" style="margin-top:16px"><div class="pilot-heading"><strong>第 '+leg+' 程　·　'+e(st)+'</strong><small>'+e(o.id)+'</small></div><div class="pilot-body"><div><div class="kicker">当前保管与责任</div><h2>'+e(o.status==='in_transit'||o.status==='last_mile'?'在途 · '+(o.custodian||o.driver):o.custodian||o.station_name||o.warehouse)+'</h2><p>'+e(sns.join(' / '))+'</p><small>签约 / 应付主体：'+display(paid)+'<br>实际执行方：'+display(g.executor_id)+'<br>司机 / 车牌：'+display(g.driver)+' / '+display(g.plate)+'</small></div><div><b>当前 F04</b><p>签发版 '+display(g.issue_version)+' · 提货号 '+display(g.pickup_code)+'</p><button data-src>查原单与回执 ↗</button></div></div></div><p class="dock-msg" role="status"></p><div data-form></div><details><summary>查看本票授权与交接历史</summary>'+a.history.map(x=>'<p>'+e(x.ts+' · '+x.actor+' · '+x.action)+'</p>').join('')+'</details>';
    const msg=box.querySelector('.dock-msg');msg.textContent=flash;box.querySelector('[data-src]').onclick=()=>ctx.openOrder(oid);
    const body=box.querySelector('[data-form]'),form=(title,fields,button)=>'<form class="card"><h3>'+title+'</h3><div class="form-grid">'+fields+'</div><button class="primary">'+button+'</button></form>';
    async function submit(ev,url,data,ok){ev.preventDefault();const btn=ev.target.querySelector('button');btn.disabled=true;try{await req(url,data);await load(ok)}catch(x){msg.className='dock-msg net-error';msg.textContent=x.message+'　｜　未移交设备。';msg.scrollIntoView({block:'nearest'});btn.disabled=false}}
    const base='/api/gate/'+id+'/',demo=ctx.demo&&o.crm_ref==='DFW-Q01';
    if(['admin','procurement','dispatch'].includes(role)){
     if(!g.state){body.innerHTML=form('提名本段实际执行方','<label class="field">已登记的人车关系<select name="link_id" required>'+links.map(l=>opt(l.id,l.zip+' · '+l.driver+' · '+l.plate)).join('')+'</select></label>'+field('contract_ref','客户合同允许分包的依据',demo?'SIM-CONTRACT-ALLOW':'',false)+field('delegation_ref','甲对乙的本票书面授权',demo?'SIM-A-TO-B-Q01':'',false)+field('evidence','本段委托 / 邀约编号',demo?'SIM-Q01-INVITE':''),'发起本段指派');body.querySelector('form').onsubmit=ev=>submit(ev,base+'invite',{...Object.fromEntries(new FormData(ev.target)),version:o.version,leg},'已发出指派；仍需执行方书面接受。')}
     if(g.state==='invited'){body.innerHTML=form('登记执行方回复',field('evidence','乙接受本票、本段及人车的书面回函',demo?'SIM-B-ACCEPT-Q01':''),'登记书面接受');body.querySelector('form').onsubmit=ev=>submit(ev,base+'accept',{...Object.fromEntries(new FormData(ev.target)),version:o.version,grant_version:g.version},'已确认承接；调度须重新核准并签发。')}
     if(g.state==='accepted'){body.innerHTML='<button data-f04>前往 F04 签发</button>';body.firstChild.onclick=()=>ctx.openOrder(oid,leg===2?'station_release':'dispatch')}
     if(['invited','accepted','issued'].includes(g.state)){body.insertAdjacentHTML('beforeend','<details><summary>撤销未执行授权 / 换班</summary>'+form('撤回此版',field('evidence','变更原因及下一步'),'撤销并释放原班')+'</details>');const f=body.querySelector('details form');f.onsubmit=ev=>submit(ev,base+'revoke',{...Object.fromEntries(new FormData(f)),version:o.version,grant_version:g.version},'旧版本和提货号已失效。')}
    }
    if(['warehouse','admin'].includes(role)&&g.state!=='released'){
     const papers=['ltl','platform'].includes(g.mode);
     body.insertAdjacentHTML('beforeend',form('核实实到车组与设备',field('pickup_code','实到提货号',demo?(g.pickup_code||'SIM-NO-GRANT'):'')+field('release_version','实到签发版本',demo?(g.issue_version||1):'')+(papers?field('bol_ref','BOL / PRO')+field('identity_ref','实到身份核验凭据'):field('driver','实到司机账号',demo?'driver':'')+field('plate','实到车牌',demo?'SIM-TX-201':'')+field('crew_id','实到班组 ID',demo?(g.crew_id||links[0]?.crew_id||'未确认'):'')+field('vehicle_id','实到车辆 ID',demo?(g.vehicle_id||links[0]?.vehicle_id||'未确认'):''))+field('evidence','交接凭据',demo?'SIM-DOCK-RECEIPT':'')+sns.map(x=>'<label class="field"><span><input type="checkbox" name="sn" value="'+e(x)+'" required> '+e(x)+' 已核</span></label>').join(''),'核对并逐台放行'));
     const f=body.lastElementChild;f.onsubmit=ev=>{const data=new FormData(f);submit(ev,base+'verify',{...Object.fromEntries(data),sns:data.getAll('sn'),release_version:Number(data.get('release_version')),version:o.version},'放行成功：本段 SN 已交实到车组，库存同步转在途。')}
    }
   }catch(x){if(request===requestNo)box.textContent=x.message}
  }await load();
 }
};
