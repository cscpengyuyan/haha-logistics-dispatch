(function(){
 const H=window.HH={pages:{},mounts:{},page:'dashboard',selectedOrder:'H26001'};
 H.clone=o=>JSON.parse(JSON.stringify(o));
 H.storageKey='haha-v8';
 H.recoveryKey='haha-v8-recovery';
 H.storageInfo={savedAt:null,error:false,migratedFrom:null};
 H.validateState=function(data){
   if(!data||typeof data!=='object'||Array.isArray(data)||![6,7].includes(data.schema))throw new Error('不是兼容的工作区备份');
   const required=['orders','inventory','inbound','suppliers','warehouses','models','vehicles','batches','risks','messages','forms','audit'];
   if(!required.every(k=>Array.isArray(data[k])&&data[k].length<=50000)||!data.settings||typeof data.settings!=='object'||!data.cost||typeof data.cost!=='object')throw new Error('工作区字段不完整或记录过多');
   const inspect=(v,depth=0)=>{if(depth>40)throw new Error('数据层级过深');if(v&&typeof v==='object'){for(const k of Object.keys(v)){if(['__proto__','prototype','constructor'].includes(k))throw new Error('备份包含不安全的字段');inspect(v[k],depth+1);}}};
   inspect(data);
   for(const [name,key] of [['orders','id'],['inventory','serial'],['warehouses','id'],['models','id'],['vehicles','id'],['suppliers','id']]){
     if(data[name].some(x=>!x||typeof x!=='object'||typeof x[key]!=='string'||!x[key].trim())||new Set(data[name].map(x=>x[key])).size!==data[name].length)throw new Error(name+' 的编号缺失或重复');
   }
   const models=new Set(data.models.map(x=>x.id)),warehouses=new Set(data.warehouses.map(x=>x.id));
   for(const o of data.orders){
     if(!models.has(o.model)||!warehouses.has(o.warehouse)||!o.checks||!Array.isArray(o.history)||!['L1','L2','L3'].includes(o.endpoint)||!Number.isInteger(o.version)||o.version<1||!Number.isFinite(Number(o.qty))||Number(o.qty)<=0)throw new Error('订单 '+o.id+' 的引用或字段不完整');
     if(H.tz)H.tz.window(o);
   }
   return data;
 };
 try{
   const current=localStorage.getItem(H.storageKey);
   if(current){H.state=H.validateState(JSON.parse(current));H.storageInfo.savedAt=H.state.workspaceMeta?.savedAt||null;}
   else{
     const old=localStorage.getItem('haha-v7');
     H.state=old?H.clone(H.validateState(JSON.parse(old))):H.clone(HH_SEED);
     if(old)H.storageInfo.migratedFrom='V7';
   }
 }catch(err){H.state=H.clone(HH_SEED);H.storageInfo.error=true;H.storageInfo.loadError=err.message;}
 H.state.schema=7;
 H.checkpoint=function(reason){
   const snapshot={createdAt:new Date().toISOString(),reason,state:H.clone(H.state)};
   try{localStorage.setItem(H.recoveryKey,JSON.stringify(snapshot));return true;}
   catch{throw new Error('无法保存恢复点。请先导出当前备份后释放浏览器空间。');}
 };
 H.persist=function(){
   const savedAt=new Date().toISOString();
   H.state.workspaceMeta={...H.state.workspaceMeta,appVersion:'8.0',savedAt,revision:(Number(H.state.workspaceMeta?.revision)||0)+1};
   try{localStorage.setItem(H.storageKey,JSON.stringify(H.state));H.storageInfo.savedAt=savedAt;H.storageInfo.error=false;return true;}
   catch{H.storageInfo.error=true;H.toast?.('浏览器存储不可用，请导出备份；本次更改仅在内存。');return false;}
 };
 H.e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 H.$=(s,r=document)=>r.querySelector(s);H.$$=(s,r=document)=>[...r.querySelectorAll(s)];
 H.money=n=>n==null?'待核':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
 H.time=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
 H.pill=(s,t='')=>`<span class="pill ${t||(/缺|风险|查验|隔离|过期|未确认|失败|高|暂停/.test(s)?'red':/待|中|情景|演示/.test(s)?'amber':/完成|确认|可用|通过|已核/.test(s)?'green':'blue')}">${H.e(s)}</span>`;
 H.order=id=>H.state.orders.find(x=>x.id===id);H.model=id=>H.state.models.find(x=>x.id===id);H.warehouse=id=>H.state.warehouses.find(x=>x.id===id);
 H.save=(action,ref='',detail='')=>{H.state.audit.unshift({id:Date.now()+'-'+Math.random().toString(36).slice(2,6),time:new Date().toISOString(),actor:H.collaboration?.user?.username||'本机 · 物流管理员',action,ref,detail});H.persist();window.dispatchEvent(new CustomEvent('haha:state-saved',{detail:{action,ref}}));};
 H.toast=msg=>{let el=H.$('#toast');if(!el)return;el.textContent=msg;el.classList.add('show');clearTimeout(H.toastTimer);H.toastTimer=setTimeout(()=>el.classList.remove('show'),4200);};
 H.download=(name,data,type='application/json')=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
 H.csv=(name,rows)=>{const clean=v=>{let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};H.download(name,'\ufeff'+rows.map(r=>r.map(clean).join(',')).join('\r\n'),'text/csv;charset=utf-8');};
 H.navigate=p=>{location.hash=p; if(H.page===p)H.render();};
 H.heading=(title,sub,buttons='')=>`<div class="page-heading"><div><div class="eyebrow">HAHA OPERATIONS / V8</div><h1>${title}</h1><p>${sub}</p></div><div class="actions">${buttons}</div></div>`;
 H.metric=(label,value,detail,tone='')=>`<div class="metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
 H.empty=t=>`<div class="empty">${t}</div>`;
 H.releaseIssues=o=>{const a=[];if(o.geocodeStatus==='待核验')a.push('地址坐标待核验');try{if(H.tz)H.tz.window(o);}catch{a.push('预约时间存在无效或夏令时歧义');}if(o.appointmentVersion&&o.appointmentVersion!==o.version)a.push('预约确认版本已失效'); if(!o.checks.site)a.push('现场与包装能力未核验');if(!o.checks.provider)a.push('实际执行方未承接当前版本');if(!o.checks.budget)a.push('费用权限未批准');if(!o.checks.inventory)a.push('序列号未锁定');if(o.path.startsWith('C')&&!o.checks.station)a.push('专业站点未确认接收');if(o.appointment!=='已确认')a.push('客户预约未确认');if(o.path==='A'&&(o.endpoint==='L3'||o.L4))a.push('A 路径不承接专业室内/特殊搬运');const inv=H.state.inventory.find(x=>x.serial===o.serial);if(inv&&inv.warehouse!==o.warehouse)a.push('锁定库存与出货仓不一致');if(!inv||inv.status!=='锁定'||inv.orderId!==o.id)a.push('库存锁定关系失效');if(H.state.orders.some(x=>x.id!==o.id&&x.serial===o.serial&&x.status!=='物理交付完成'))a.push('序列号被其他订单占用');return a;};
 H.modal=(title,body,submit,label='保存演示记录')=>{const close=/^[\x00-\x7F]+$/.test(title)?'Close':'关闭';H.$('#modal')?.remove();const host=document.createElement('div');host.id='modal';host.className='modal-backdrop';host.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-label="${H.e(title)}"><header><h2>${H.e(title)}</h2><button class="icon-btn" type="button" data-close aria-label="${close}">×</button></header><form><div class="modal-body">${body}</div><footer><button class="btn" type="button" data-close>${close}</button>${submit?`<button class="btn primary" type="submit">${label}</button>`:''}</footer></form></section>`;document.body.append(host);host.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>host.remove());host.addEventListener('click',e=>{if(e.target===host)host.remove();});host.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');if(button?.disabled)return;if(button)button.disabled=true;try{await submit(new FormData(e.target));host.remove();H.render();}catch(err){if(button)button.disabled=false;H.toast(err.message);}};host.querySelector('input,select,textarea,button')?.focus();};
 document.addEventListener('keydown',e=>{if(e.key==='Escape')H.$('#modal')?.remove();if(e.key==='Tab'&&H.$('#modal')){const a=H.$$('button,input,select,textarea,a[href]',H.$('#modal')).filter(x=>!x.disabled&&x.offsetParent);const f=a[0],l=a[a.length-1];if(e.shiftKey&&document.activeElement===f){e.preventDefault();l.focus();}else if(!e.shiftKey&&document.activeElement===l){e.preventDefault();f.focus();}}});
 H.addDays=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
 H.days=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);
 H.field=(label,name,value='',type='text',attrs='')=>`<label class="field">${label}<input name="${name}" type="${type}" value="${H.e(value)}" ${attrs}></label>`;
})();
