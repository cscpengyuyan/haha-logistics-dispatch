'use strict';
window.Team={async mount(h,c){
 const e=c.escape;if(['driver','supplier'].includes(c.user.role))return;
 const d=document.createElement('details');d.className='card';d.innerHTML='<summary><b>岗位移交与预约记录</b>　逐票认领、交班、登记客户实际回复</summary><div class="team-detail"></div>';h.append(d);
 d.ontoggle=async()=>{if(!d.open)return;const target=d.querySelector('.team-detail');
 target.innerHTML='<label class="field">选择订单<select data-o>'+c.orders.map(o=>'<option value="'+e(o.id)+'">'+e((o.crm_ref||o.id)+' · '+o.customer)+'</option>').join('')+'</select></label><div data-panel></div>';const select=target.querySelector('select'),panel=target.querySelector('[data-panel]');
 const names={claim:'认领',handoff:'移交',return:'退补',delegate:'代理',escalate:'升级交办',channel:'登记同意渠道',sent:'已发送（人工凭据）',delivered:'已送达',reply:'收到回复',confirmed:'预约成立',opt_out:'停用原渠道'};
 async function draw(){if(!select.value){panel.textContent='暂无订单';return}try{
 const path='/api/team/'+select.value,s=await c.api(path),o=(await c.api('/api/orders/'+select.value)).order;
 panel.innerHTML='<p>当前经办：'+e(s.owner||'待认领')+'　对外联络：'+e(s.contact_owner||'待认领')+'　客户渠道：'+e(s.channel||'待核')+'</p><form><div class="form-grid"><label class="field">操作<select name="action">'+Object.entries(names).map(([k,n])=>'<option value="'+k+'">'+n+'</option>').join('')+'</select></label><label class="field">说明或凭据<input name="evidence" required></label><div data-extra></div></div><button>登记事实</button><p role="alert"></p></form><ol>'+s.events.slice(-5).map(v=>'<li>'+e(names[v.action]+' · '+v.actor+' · '+v.evidence)+'</li>').join('')+'</ol>';
 const f=panel.querySelector('form'),sel=f.elements.action;sel.onchange=()=>{f.querySelector('[data-extra]').innerHTML=({handoff:['to'],return:['to'],delegate:['to'],escalate:['to'],channel:['channel','alternative','contact_hours']}[sel.value]||[]).map(k=>'<label class="field">'+({to:'接手人账号',channel:'客户同意渠道',alternative:'备用渠道',contact_hours:'当地可联系时段'}[k])+'<input name="'+k+'" required></label>').join('')};f.onsubmit=async ev=>{ev.preventDefault();try{await c.api(path,{method:'POST',body:{...Object.fromEntries(new FormData(f)),version:o.version,task_version:s.version}});await draw()}catch(x){f.querySelector('[role=alert]').textContent=x.message}};
 }catch(x){panel.textContent=x.message}}select.onchange=draw;await draw()};
}};
