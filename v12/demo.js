'use strict';
(()=>{
  const w=new Worker('./demo-worker.js?v=7ce145208e05'),pending=new Map();let counter=0,failed='';
  w.onmessage=e=>{const v=e.data,p=pending.get(v.id);if(!p)return;pending.delete(v.id);if(v.error){const err=Error(v.error);err.status=v.status;p.reject(err)}else p.resolve(v.value)};
  w.onerror=e=>{failed='公开演练运行库未能启动，请刷新后重试。';for(const p of pending.values())p.reject(Error(failed));pending.clear()};
  window.PublicDemo={async api(path,opts={}){
    if(failed)throw Error(failed);const id=++counter,username=sessionStorage.getItem('haha-v12-role')??'admin';
    let body=opts.body||{};if(typeof body==='string')body=JSON.parse(body);
    const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});w.postMessage({id,request:{path,body,method:opts.method||'GET',username}})});
    if(path==='/api/demo-login')sessionStorage.setItem('haha-v12-role',body.username);
    if(path==='/api/logout')sessionStorage.setItem('haha-v12-role','');
    return result;
  },async downloadFile(id,name){
    const file=await this.api('/api/files/'+id),blob=new Blob([Uint8Array.from(atob(file.base64),s=>s.charCodeAt(0))],{type:file.mime});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }};
})();

