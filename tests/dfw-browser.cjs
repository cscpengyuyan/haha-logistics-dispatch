const { chromium }=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),evidence=path.join(root,'evidence','shared'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfw-v12-'));
(async()=>{fs.mkdirSync(evidence,{recursive:true});
const server=spawn(process.env.PYTHON||'python',['-X','utf8','-u',path.join(root,'server.py'),'--demo','--db',path.join(dir,'practice.sqlite3'),'--port','0'],{env:{...process.env,PYTHONUTF8:'1'},windowsHide:true});let b;
try{const port=await new Promise((resolve,reject)=>{server.stdout.on('data',x=>{const m=x.toString().match(/127\.0\.0\.1:(\d+)/);if(m)resolve(+m[1])});server.stderr.on('data',x=>process.stderr.write(x));server.on('close',c=>reject(Error('server exited '+c)))});
const url='http://127.0.0.1:'+port+'/v12/',contexts={},pages={};b=await chromium.launch({channel:'msedge',headless:true});
async function page(role,hash='tasks'){
 if(!pages[role]){const c=contexts[role]=await b.newContext({viewport:role==='driver'?{width:390,height:844}:{width:1366,height:768},timezoneId:'America/Chicago'});const p=pages[role]=await c.newPage();p.setDefaultTimeout(12000);p.on('pageerror',e=>console.error('PAGE',role,e.message));await p.goto(url+'#'+hash);await p.locator('#signin select').selectOption(role);await p.locator('#signin button').click();await p.locator('#section-title').waitFor()}
 const p=pages[role];await p.goto(url+'#'+hash);await p.reload();await p.locator('#section-title').waitFor();return p;
}
async function shot(p,name){await p.screenshot({path:path.join(evidence,name+'.png')})}
async function step(i,role){
 const p=await page(role);const s=p.locator('.pilot-card').first();await s.locator('form').waitFor();await s.locator('input[name=ref]').fill('SIM-Q01-'+(i+1));
 for(const ck of await s.locator('input[type=checkbox]').all())await ck.check();
 if(i===9)await shot(p,'05-driver-two-sn');
 await s.getByRole('button',{name:'确认并写入原单'}).click();try{await p.waitForFunction(n=>document.querySelector('.pilot-card .kicker')?.textContent?.includes(' /　'+n+' OF')||document.querySelector('.pilot-card .kicker')?.textContent?.includes('　'+n+' OF'),i+1,{timeout:5000})}catch(x){throw Error('step '+i+': '+await s.innerText())};console.log('OK',i,role);
}
for(const [i,r] of ['sales','warehouse','warehouse','warehouse','procurement','finance','procurement'].entries())await step(i,r);
async function dock(r){const p=await page(r,'gate');const sel=p.locator('#dock-order');await sel.selectOption({label:(await sel.locator('option').allTextContents()).find(v=>v.startsWith('DFW-Q01'))});await p.locator('#dock-detail .pilot-heading').waitFor();return p}
async function facts(p){const oid=await p.locator('#dock-order').inputValue();return p.evaluate(async id=>{const o=await(await fetch('/api/orders/'+id)).json(),a=await(await fetch('/api/lifecycle/assets')).json();return {oid:id,order:o.order,assets:a.records.filter(s=>s.order_id===id)}},oid)}
const w=await dock('warehouse');await w.locator('input[name=sn]').first().waitFor();for(const c of await w.locator('input[name=sn]').all())await c.check();await w.getByRole('button',{name:'核对并逐台放行'}).click();await w.getByRole('status').filter({hasText:'暂停放行'}).first().waitFor();const no=await facts(w);assert.equal(no.order.status,'ready');assert.deepEqual(no.assets.map(a=>a.state),['reserved','reserved']);await shot(w,'01-blocked-at-dock');
const p=await dock('procurement');await p.getByRole('button',{name:'发起本段指派'}).click();await p.getByRole('button',{name:'登记书面接受'}).click();await p.getByRole('button',{name:'前往 F04 签发'}).waitFor();await shot(p,'02-subcontract-accepted');
await step(7,'dispatch');const w2=await dock('warehouse');await w2.getByText('已签发 · 待仓口验放',{exact:false}).first().waitFor();for(const c of await w2.locator('input[name=sn]').all())await c.check();await w2.getByRole('button',{name:'核对并逐台放行'}).click();await w2.getByRole('status').filter({hasText:'放行成功'}).first().waitFor({timeout:5000}).catch(async()=>{throw Error(await w2.locator('#dock-detail').innerText())});const yes=await facts(w2);assert.equal(yes.order.status,'in_transit');assert.deepEqual(yes.assets.map(a=>a.state),['transit','transit']);await shot(w2,'03-authorized-pickup');
await step(8,'warehouse');
const d=await page('driver');await d.locator('.pilot-card [data-source]').click();await d.locator('dialog [data-cmd=upload]').click();
const up=d.locator('dialog form');await up.locator('input[type=file]').setInputFiles({name:'SIM-offline.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSIM synthetic retry')});
const filter='**/api/orders/*/files';await d.route(filter,route=>route.abort('internetdisconnected'));await up.locator('button[type=submit]').click();
await d.getByText(/POD 仅暂存在本设备/).first().waitFor();await d.unroute(filter);await d.reload();await d.locator('dialog[open] [data-close]').click();await d.locator('dialog[open]').waitFor({state:'detached'});const retry=d.getByRole('button',{name:'重新提交',exact:true});await retry.click();await d.getByText('服务器已确认附件 #',{exact:false}).waitFor();
const count=await d.evaluate(async()=>{const s=await(await fetch('/api/practice/dfw')).json();return (await(await fetch('/api/orders/'+s.id)).json()).files.filter(f=>f.name==='SIM-offline.pdf').length});assert.equal(count,1);
await step(9,'driver');await step(10,'service');await step(11,'finance');const f=await page('finance');await f.getByText('美国段已核账',{exact:true}).waitFor();await shot(f,'06-finance-settled');const out=await f.evaluate(async()=>{const s=await(await fetch('/api/practice/dfw')).json();const o=(await(await fetch('/api/orders/'+s.id)).json()).order;return {cursor:s.cursor,id:s.id,status:o.status,approved:o.approved_cost,actual:o.actual_cost,expression:o.cost_expression,issue_version:o.issue_version,units:o.service_units}});
assert.equal(out.approved,580);assert.equal(out.actual,595);assert.equal(out.units.length,2);assert.equal(out.cursor,12);const report=await f.evaluate(async()=> (await(await fetch('/api/review/query',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()));assert.equal(report.rows.find(r=>r.id===out.id).settled_diff,null);
fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({accounts:Object.keys(contexts),blocked:{status:no.order.status,sns:no.assets.map(x=>[x.sn,x.state])},released:{status:yes.order.status,sns:yes.assets.map(x=>[x.sn,x.state])},out},null,2));
console.log('PASS DFW + dock; '+JSON.stringify(out));}finally{await b?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
