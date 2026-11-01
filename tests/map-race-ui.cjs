const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const src=spawn(process.env.PYTHON||'python',['-B','tests/test_routing.py','serve'],{windowsHide:true});
 src.stderr.pipe(process.stderr);
 const rl=readline.createInterface({input:src.stdout});let b;
 try{
 const line=await new Promise((resolve,reject)=>{rl.once('line',resolve);src.once('exit',()=>reject(Error('fixture stopped')))});
 const f=JSON.parse(line);b=await chromium.launch({channel:'msedge',headless:true});
 const out='docs/evidence/map';fs.mkdirSync(out,{recursive:true});
 async function openPage(user){
  const c=await b.newContext({viewport:{width:1366,height:768},timezoneId:'America/Chicago'}),p=await c.newPage();p.setDefaultTimeout(16000);
  const res=await c.request.post(f.url+(user==='dispatch2'?'/api/login':'/api/demo-login'),{data:{username:user,password:'simulation-test-only'}});assert.equal(res.status(),200);
  await p.goto(f.url+'/v12/#map');await p.locator('[data-field=routeLoad]').waitFor();return p;
 }
 async function form(p,i,r){
  await p.goto(f.url+'/v12/#map');if(await p.locator('dialog[open]').count())await p.keyboard.press('Escape');await p.locator('nav [data-nav=map]').click();
  await p.locator('[data-field=routeLoad]').selectOption(f.routes[r]).catch(async e=>{throw Error(e.message+' '+(await p.locator('body').innerText()).slice(-800))});
  await p.locator('.dm-list [data-act=focus][data-id="'+f.orders[i]+'"]').click();
  await p.locator('.dm-detail [data-act=dispatch]').click();
  const form=p.locator('dialog[open] form');await form.locator('[name=route_id]').selectOption(f.routes[r]);
  await form.locator('[name=driver]').selectOption('driver');await form.locator('[name=dispatch_ref]').fill('SIM-UI-DISPATCH');
  await form.locator('[name=approved_cost]').fill('0');
  for(const x of await form.locator('[name^=check_]').all())await x.fill('SIM-UI-'+await x.getAttribute('name'));
  return form.locator('[type=submit]');
 }
 async function send(p,button,i){
   const response=p.waitForResponse(r=>r.url().endsWith('/api/orders/'+f.orders[i]+'/actions')&&r.request().method()==='POST');
   await button.click();const r=await response;return [r.status(),await r.json()];
 }
 const [a,c]=await Promise.all([openPage('dispatch'),openPage('dispatch2')]);
 const [ab,cb]=await Promise.all([form(a,0,0),form(c,1,1)]);
 const result=await Promise.all([send(a,ab,0),send(c,cb,1)]);
 assert.deepEqual(result.map(r=>r[0]).sort(),[200,409]);
 const losing=result[0][0]===409?a:c;
 assert.match(result.find(r=>r[0]===409)[1].error,/占用/);
 await losing.getByText(/车辆、司机或班组时段已由另一车次占用/).first().waitFor();
 await losing.screenshot({path:path.join(out,'shared-F04-conflict.png')});
 const next=await openPage('dispatch');
 for(const [i,r] of [[2,2],[3,2],[4,3]]){const button=await form(next,i,r);const response=await send(next,button,i);assert.equal(response[0],200,JSON.stringify(response))}
 console.log(JSON.stringify({browser:b.version(),accounts:2,racing_results:result.map(r=>r[0]),same_route_stops:2,later_assignment:'accepted'}));
 }finally{if(b)await b.close();src.stdin.end('\n');rl.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
