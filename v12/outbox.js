'use strict';
// Track request receipts by digest; never store customer payloads in a receipt key.
window.SharedWrites=(()=>{
 let db;const ttl=24*3600*1000;
 const dbOpen=()=>db??=new Promise((ok,no)=>{const r=indexedDB.open('haha-evidence-outbox-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('pending',{keyPath:'key'});r.onerror=()=>no(r.error);r.onsuccess=()=>ok(r.result)});
 const store=async(mode,action)=>{const d=await dbOpen();return new Promise((ok,no)=>{const t=d.transaction('pending',mode),r=action(t.objectStore('pending'));t.oncomplete=()=>ok(r.result);t.onerror=t.onabort=()=>no(t.error)})};
 const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 async function send(path,opts,actor){
  const hash=await digest([actor,opts.method,path,opts.body].join('\n')),key='hh-pending-'+hash;
  let id=sessionStorage.getItem(key);if(!id){id=crypto.randomUUID();sessionStorage.setItem(key,id)}
  const headers={...opts.headers,'Idempotency-Key':id};
  try{const res=await fetch(path,{...opts,headers});if(res.status<500)sessionStorage.removeItem(key);return res}
  catch(err){
   if(opts.method==='POST'&&/^\/api\/orders\/[\w-]+\/files$/.test(path)&&JSON.parse(opts.body||'{}').category==='pod'){
    await store('readwrite',s=>s.put({key:id,actor,path,body:opts.body,at:Date.now()}));
    throw Error('网络中断：POD 仅暂存在本设备，尚未交付。恢复连接后从岗位待办重传。')
   }
   throw Error('共享服务未确认写入，请恢复连接后刷新或重试。')
  }
 }
 async function mount(h,ctx){if(ctx.publicDemo)return;let rows;
 try{const all=await store('readonly',s=>s.getAll());await Promise.all(all.filter(r=>Date.now()-r.at>ttl).map(r=>store('readwrite',s=>s.delete(r.key))));rows=all.filter(r=>r.actor===ctx.user.username&&Date.now()-r.at<=ttl)}catch{return}
 if(!rows.length)return;
 const card=document.createElement('section');card.className='card';h.prepend(card);card.innerHTML='<h3>待服务器确认的 POD</h3><p>以下凭据仅暂存在本设备；重传时服务器会复核订单版本和当前账号权限。</p>';
 for(const r of rows){const row=document.createElement('p'),send=document.createElement('button'),drop=document.createElement('button');row.textContent=JSON.parse(r.body).name+'　';send.textContent='重新提交';drop.textContent='移除本机暂存';row.append(send,drop);card.append(row);
 drop.onclick=async()=>{await store('readwrite',s=>s.delete(r.key));row.remove()};
 send.onclick=async()=>{send.disabled=true;try{const resp=await fetch(r.path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Idempotency-Key':r.key},body:r.body});const got=await resp.json();if(!resp.ok)throw Error(got.error||'服务器未确认');await store('readwrite',s=>s.delete(r.key));row.textContent='服务器已确认附件 #'+got.file.id;ctx.toast('凭据已入库')}catch(e){ctx.toast(e.message);send.disabled=false}};
 }
 }return {send,mount};
})();
