'use strict';
let py, store, revision=-1;
const reqValue=req => new Promise((ok,no)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error)});
async function initialize(){
  importScripts('./runtime/pyodide.js');
  py=await loadPyodide({indexURL:new URL('./runtime/',location.href).href});
  await py.loadPackage('sqlite3');
  for(const file of ["core.py", "operations.py", "browser_api.py", "demo_seed.py", "lifecycle.py", "review.py", "folder.py"]){
    const res=await fetch('./engine/'+file+location.search);if(!res.ok)throw Error('演练引擎未能加载：'+file);
    py.FS.writeFile('/home/pyodide/'+file,await res.text());
  }
  const open=indexedDB.open('haha-logistics-public-v12-2',1);
  open.onupgradeneeded=()=>open.result.createObjectStore('state');
  store=await reqValue(open);
  await py.runPythonAsync("import browser_api as platform");
}
async function readStored(){return reqValue(store.transaction('state').objectStore('state').get('db'))}
async function persist(){
  const bytes=py.FS.readFile('/practice.sqlite3');
  await new Promise((ok,no)=>{
    const t=store.transaction('state','readwrite'),s=t.objectStore('state'),get=s.get('db');let conflict=false;
    get.onsuccess=()=>{if((get.result?.revision??0)!==revision){conflict=true;t.abort();return}s.put({revision:revision+1,bytes},'db')};
    t.onabort=()=>no(Error(conflict?'其他标签页已更新演练库，请重试。':'浏览器没有足够的空间保存本次操作。'));
    t.oncomplete=ok;t.onerror=()=>no(t.error);
  });
  revision++;
}
async function sync(){
  const prev=await readStored(),n=prev?.revision??0;if(n===revision)return;
  py.runPython('if platform.db is not None: platform.db.close(); platform.db = None');
  if(prev)py.FS.writeFile('/practice.sqlite3',prev.bytes);
  else if(py.FS.analyzePath('/practice.sqlite3').exists)py.FS.unlink('/practice.sqlite3');
  py.runPython('platform.connect_demo()');revision=n;if(!prev)await persist()
}
let boot,chain=Promise.resolve();
async function processRequest(m){
  try{
    boot??=initialize();await boot;await sync();
    py.globals.set('request_json',JSON.stringify(m.request));
    const result=JSON.parse(py.runPython('platform.handle_json(request_json)'));
    if(!result.error && !['/api/logout','/api/demo-login'].includes(m.request.path) && m.request.method!=='GET')await persist();
    self.postMessage({id:m.id,...result});
  }catch(e){revision=-1;self.postMessage({id:m.id,error:e.message||String(e),status:503})}
}
self.onmessage=e=>{chain=chain.then(()=>processRequest(e.data))};

