const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'../v8');
function setup(initial={}){
  const store=new Map(Object.entries(initial));
  const ctx={console,Intl,Date,Set,Map,URL,AbortController,setTimeout,clearTimeout,
    CustomEvent:class{constructor(name,options){this.type=name;this.detail=options?.detail;}},
    document:{querySelector:()=>null,querySelectorAll:()=>[],addEventListener:()=>{}},
    localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
    location:{hash:''},addEventListener:()=>{},dispatchEvent:()=>{},
  };
  ctx.window=ctx;vm.createContext(ctx);
  for(const name of ['seed.js','scenario.js','core.js','timezone.js','services.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),ctx,{filename:name});
  const H=ctx.HH;H.pages.settings=()=>'';H.mounts.settings=()=>{};H.toast=()=>{};
  for(const name of ['driver','portal','comms']){H.pages[name]=()=>name;H.mounts[name]=()=>{};}
  vm.runInContext(fs.readFileSync(path.join(root,'workspace-tools.js'),'utf8'),ctx,{filename:'workspace-tools.js'});
  return {ctx,H,store};
}
const clone=x=>JSON.parse(JSON.stringify(x));
test('first V8 load safely imports V7 state and all later saves use the V8 key',()=>{
  const seed=setup().H.state;seed.orders[0].customer='Existing V7 customer';
  const original=JSON.stringify(seed);const {H,store}=setup({'haha-v7':original});
  assert.equal(H.state.orders[0].customer,'Existing V7 customer');
  assert.equal(H.storageInfo.migratedFrom,'V7');
  H.state.orders[0].customer='V8 customer';H.save('edit');
  assert.equal(store.get('haha-v7'),original);
  assert.equal(JSON.parse(store.get('haha-v8')).orders[0].customer,'V8 customer');
});
test('backup validation rejects duplicate IDs, missing references and dangerous property names',()=>{
  const {H}=setup();
  const duplicate=clone(H.state);duplicate.orders[1].id=duplicate.orders[0].id;
  assert.throws(()=>H.validateState(duplicate),/重复/);
  const serial=clone(H.state);serial.inventory[1].serial=serial.inventory[0].serial;
  assert.throws(()=>H.validateState(serial),/重复/);
  const broken=clone(H.state);broken.orders[0].warehouse='MISSING';
  assert.throws(()=>H.validateState(broken),/引用/);
  const unsafe=JSON.parse(JSON.stringify(H.state).replace('"settings":{','"settings":{"__proto__":{"polluted":true},'));
  assert.throws(()=>H.validateState(unsafe),/不安全/);
  assert.equal({}.polluted,undefined);
});
test('replacing a workspace preserves a recoverable copy and local map credentials',()=>{
  const {H,store}=setup();H.state.settings.tiles={key:'LOCAL-ONLY',url:'https://tiles.example/{z}/{x}/{y}.png'};
  H.state.settings.viewZone='Asia/Shanghai';const original=H.state.orders[0].customer;
  const incoming=clone(H.state);incoming.orders[0].customer='Server version';delete incoming.settings.tiles;
  H.workspaceTools.applyState(incoming,'拉取服务器工作区');
  assert.equal(H.state.orders[0].customer,'Server version');
  assert.equal(JSON.parse(store.get(H.recoveryKey)).state.orders[0].customer,original);
  assert.equal(H.state.settings.tiles.key,'LOCAL-ONLY');
  assert.equal(H.state.settings.viewZone,'Asia/Shanghai');
  const recovery=JSON.parse(store.get(H.recoveryKey)).state;
  H.workspaceTools.applyState(recovery,'恢复上次工作区');
  assert.equal(H.state.orders[0].customer,original);
  assert.equal(JSON.parse(store.get(H.recoveryKey)).state.orders[0].customer,'Server version');
});
test('cloud payload excludes local map credentials and does not mutate the local workspace',()=>{
  const {H}=setup();H.state.settings.tiles={key:'SECRET'};H.state.settings.viewZone='Asia/Shanghai';
  const payload=H.workspaceTools.visibleState();
  assert.equal(payload.settings.tiles,undefined);assert.equal(payload.settings.viewZone,undefined);
  assert.equal(H.state.settings.tiles.key,'SECRET');
  assert.equal(payload.orders.length,42);
});
test('service URL validation requires HTTPS except for loopback development',()=>{
  const {H}=setup(),url=H.workspaceTools.baseURL;
  assert.equal(url('https://api.example.com/'),'https://api.example.com');
  assert.equal(url('http://localhost:8787'),'http://localhost:8787');
  assert.throws(()=>url('http://remote.example.com'),/HTTPS/);
  assert.throws(()=>url('https://user:password@example.com'),/账号/);
  assert.throws(()=>url('https://example.com?token=secret'),/查询/);
});
test('a damaged saved workspace surfaces a recoverable error without overwriting its source',()=>{
  const {H,store}=setup({'haha-v8':'{broken JSON'});
  assert.equal(H.storageInfo.error,true);assert.ok(H.storageInfo.loadError);
  assert.equal(store.get('haha-v8'),'{broken JSON');assert.equal(H.state.orders.length,42);
});
