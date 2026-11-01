const {chromium}=require('playwright'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path');
(async()=>{const root=path.resolve(__dirname,'..'),s=spawn('python',['-u',path.join(root,'preview.py'),'--port','0'],{windowsHide:true});let b;
try{const addr=await new Promise((ok,no)=>{s.stdout.once('data',d=>ok(d.toString().trim().split('#')[0]));s.once('exit',n=>no(Error('preview exited '+n)))});
b=await chromium.launch({channel:'msedge',headless:true});const a=await b.newContext(),c=await b.newContext(),page=await a.newPage(),other=await c.newPage(),foreign=[],errors=[];a.on('request',r=>{if(r.url().startsWith('http')&&!r.url().startsWith(addr))foreign.push(r.url())});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(60000);
await page.goto(addr+'#tasks');await page.locator('.pilot-card [data-switch]').waitFor();
const state=await page.evaluate(async()=>{const api=window.PublicDemo.api.bind(window.PublicDemo);
for(const [i,role] of ['sales','warehouse','warehouse','warehouse','procurement','finance','procurement'].entries()){await api('/api/demo-login',{method:'POST',body:{username:role}});const v=await api('/api/practice/dfw');await api('/api/practice/dfw',{method:'POST',body:{cursor:i,version:v.version,reference:'SIM-OFFLINE-'+i}})}
return api('/api/practice/dfw')});assert.equal(state.cursor,7);await page.reload();await page.locator('.pilot-heading').first().waitFor();assert.equal(await page.evaluate(async()=> (await PublicDemo.api('/api/practice/dfw')).cursor),7);
await page.goto(addr+'#map');await page.locator('[data-field=region]').waitFor();await page.goBack();await page.locator('.pilot-card').first().waitFor();
await other.goto(addr+'#tasks');await other.locator('.pilot-heading').first().waitFor();assert.equal(await other.evaluate(async()=> (await PublicDemo.api('/api/practice/dfw')).cursor),0);assert.equal(foreign.length,0);assert.equal(errors.length,0);console.log('PASS public Pyodide: sales through RFQ, IndexedDB refresh, map deep link, back, isolated browser, zero external requests');
}finally{await b?.close();s.kill()}})().catch(e=>{console.error(e);process.exitCode=1})
