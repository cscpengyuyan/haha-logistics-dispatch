/* Run against a static archive of main@5fb83b0, never against production data. */
'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),path=require('node:path');
(async()=>{
 const archive=path.resolve(process.argv[2]);let browser;
 const server=spawn('python',['-u','-c','import http.server as h; s=h.ThreadingHTTPServer(("127.0.0.1",0),h.SimpleHTTPRequestHandler);print(s.server_port);s.serve_forever()'],{cwd:archive,windowsHide:true,stdio:['ignore','pipe','ignore']});
 try{
 const port=await new Promise((ok,no)=>{server.stdout.once('data',d=>ok(Number(d)));server.once('exit',()=>no(Error('baseline server failed')))});
 const base='http://127.0.0.1:'+port;browser=await chromium.launch({channel:'msedge',headless:true});
 const p=await browser.newPage({viewport:{width:1366,height:768}});p.setDefaultTimeout(10000);
 await p.goto(base+'/v12/#dock');await p.locator('[data-box=layer]').waitFor();
 assert.equal(await p.locator('#section-title').innerText(),'地图调度');
 console.log('V12 #dock ->',await p.locator('#section-title').innerText());
 await p.evaluate(async()=>{const api=PublicDemo.api.bind(PublicDemo);
   const o=(await api('/api/orders')).orders.find(o=>o.city==='Fort Worth');
   const u=(await api('/api/lifecycle/assets')).records.find(u=>u.state==='available'&&u.model===o.model&&u.warehouse===o.warehouse);
   await api('/api/orders/'+o.id+'/actions',{method:'POST',body:{action:'ready',version:o.version,sn:u.sn,release_ref:'SIM-BASELINE-FW'}})});
 await p.reload();await p.locator('.dm-item').filter({hasText:'Fort Worth'}).locator('[data-act=toggle]').click();
 await p.locator('.dm-note').filter({hasText:'35 mph'}).waitFor();
 console.log('V12 Fort Worth uncached:',await p.locator('.dm-note').filter({hasText:'35 mph'}).innerText());
 await p.goto(base+'/v12/#ledger');await p.locator('#section-title').filter({hasText:'海运与采购'}).waitFor();
 assert.equal(await p.getByRole('button',{name:'船期甘特'}).count(),0);
 console.log('V12 ledger view:',(await p.locator('#content').innerText()).slice(0,100).replace(/\s+/g,' '));
 await p.goto(base+'/v12/#inventory');await p.getByText('逐台库存',{exact:true}).first().waitFor();
 const units=await p.evaluate(async()=> (await PublicDemo.api('/api/lifecycle/assets')).records);
 console.log('V12 inventory records in isolated seed',units.length,'states:',[...new Set(units.map(x=>x.state))]);
 // Enable the optional tile branch against a synthetic tile endpoint. Only its first response fails.
 await p.route('**/demo.js*',async rt=>{const res=await rt.fetch();await rt.fulfill({response:res,body:await res.text()+
 ';{const fn=PublicDemo.api.bind(PublicDemo); PublicDemo.api=async(p,o)=>{const x=await fn(p,o);if(p==="/api/session")x.tiles=true;return x}}'})});
 let count=0;
 await p.route('**/map-tiles/**/*.png',rt=>++count===1?rt.abort():rt.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK9sAAAAASUVORK5CYII=','base64')}));
 await p.goto(base+'/v12/#map');await p.reload();await p.locator('[data-box=layer]').filter({hasText:'瓦片不可用'}).waitFor();
 assert.equal(await p.locator('.leaflet-tile-pane .leaflet-layer').count(),0);
 console.log('V12 simulated tile fault: first response aborted, full layer count 0; status:',await p.locator('[data-box=layer]').innerText());
 await p.goto(base+'/v8/#inbound');await p.locator('table.gantt').waitFor();
 console.log('V8 voyage Gantt rendered:',await p.locator('table.gantt tbody tr').count(),'batch rows; warehouse load panel visible:',await p.getByRole('heading',{name:'目的仓 · 到货负荷'}).count());
 await p.locator('[data-sea-view=table]').click();
 const detail=p.locator('[data-sea-detail]').first(),sid=await detail.getAttribute('data-sea-detail');
 const snapshot=()=>p.evaluate(id=>{const s=HH.state.inbound.find(s=>s.id===id);return {baseline:s.baselineDelivery,eta:s.eta,delivery:s.delivery,risks:HH.state.risks.length}},sid);
 const before=await snapshot();await detail.click();await p.locator('#sea-event').click();
 await p.locator('#modal [name=note]').fill('SIM-BASELINE · 人工回执，晚靠两天');
 await p.locator('#modal [type=submit]').click();await p.waitForFunction(n=>HH.state.risks.length>n,before.risks);
 const after=await snapshot();assert.equal(before.baseline,after.baseline);assert.equal((Date.parse(after.delivery)-Date.parse(before.delivery))/86400000,2);
 console.log('V8 table -> batch -> late arrival +2:',sid,before,'=>',after);
 await p.goto(base+'/v8/#inventory');await p.locator('[data-stock-detail]').first().click();
 console.log('V8 inventory detail:',(await p.locator('#modal h2').innerText()));await p.locator('#modal [data-close]').first().click();
 assert.ok(await p.getByRole('columnheader',{name:'入仓 / 仓龄'}).isVisible());
 await p.locator('#mg-replenish-form button[type=submit]').click();console.log('V8 replenishment:',(await p.locator('#mg-replenish-result').innerText()).slice(0,160).replace(/\s+/g,' '));
 const pair=await p.evaluate(()=>{for(const u of HH.state.inventory)for(const o of HH.state.orders)if(!HH.management.canReserve(HH.state.inventory,HH.state.orders,u,o))return [u.serial,o.id]});
 if(pair){await p.locator('[data-stock-lock="'+pair[0]+'"]').click();await p.locator('#modal [name=orderId]').selectOption(pair[1]);await p.locator('#modal [name=note]').fill('SIM-BASELINE');await p.locator('#modal [type=submit]').click();await p.waitForFunction(([sn,id])=>HH.state.inventory.find(u=>u.serial===sn).orderId===id,pair);console.log('V8 SN lock succeeded',pair)}
 else {await p.locator('[data-stock-lock]').first().click();console.log('V8 lock form opened; no eligible pair in this seed');await p.locator('#modal [data-close]').first().click()}
 await p.goto(base+'/v8/#suppliers');await p.locator('#mg-supplier-scope').selectOption({index:1});await p.locator('[data-supplier-detail]').first().click();
 console.log('V8 capability scope changed, supplier detail:',await p.locator('#modal h2').innerText());
 }finally{await browser?.close();server.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
