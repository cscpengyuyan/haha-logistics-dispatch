const {chromium}=require('playwright'),{spawn}=require('node:child_process'),rl=require('node:readline'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const src=spawn('python',['-B','tests/test_routing.py','serve-perf'],{windowsHide:true});
 src.stderr.pipe(process.stderr);const lines=rl.createInterface({input:src.stdout});let b;
 try{const f=JSON.parse(await new Promise((r,j)=>{lines.once('line',r);src.once('exit',()=>j(Error('fixture stopped')))}));
 b=await chromium.launch({channel:'msedge',headless:true});
 const c=await b.newContext({viewport:{width:1366,height:768},timezoneId:'America/Chicago'}),p=await c.newPage();
 await c.request.post(f.url+'/api/demo-login',{data:{username:'dispatch'}});
 const t=performance.now();await p.goto(f.url+'/v12/#map');await p.locator('.dm-list .dm-item').first().waitFor();await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const cold=Math.round(performance.now()-t);
 const synthetic=await p.locator('[data-box=total]').innerText();assert.equal(await p.locator('.dm-list .dm-item').count(),40);
 const filters=[],reorder=[];
 for(let i=0;i<10;i++){const key='PERF-0'+String(i).padStart(3,'0');
 const d=await p.evaluate(k=>{const el=document.querySelector('[data-field=search]');const t=performance.now();el.value=k;el.dispatchEvent(new Event('input',{bubbles:true}));return performance.now()-t},key);
 assert.equal(await p.locator('.dm-list .dm-item').count(),1);filters.push(d)}
 await p.locator('[data-field=search]').fill('');
 await p.locator('[data-field=routeLoad]').selectOption(f.routes[2]);
 for(let i=0;i<10;i++){const d=await p.evaluate(()=>{const el=document.querySelector('[data-act=down]:not(:disabled)');const t=performance.now();el.click();return performance.now()-t});reorder.push(d)}
 const out={runtime:os.type()+' '+os.release(),cpu:os.cpus()[0].model,browser:b.version(),viewport:'1366x768',seed:'1000 deterministic synthetic + 12 fixture orders',display:synthetic,cold_to_orders_ms:cold,visible_rows_limit:40,filter_js_ms:filters,reorder_js_ms:reorder};
 fs.writeFileSync('docs/evidence/map/performance.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
 }finally{if(b)await b.close();src.stdin.end('\n');lines.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
