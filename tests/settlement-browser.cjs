'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),os=require('node:os');
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v12-settlement-')),out=process.argv[2]||'evidence/settlement';
 fs.mkdirSync(out,{recursive:true});
 const port=18949,base='http://127.0.0.1:'+port+'/v12/',sv=spawn('python',['-B','server.py','--demo','--db',path.join(tmp,'demo.sqlite'),'--port',String(port)],{windowsHide:true,stdio:'ignore'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
   for(let i=0;i<80;i++){try{if((await fetch(base)).ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
   const ctx=await browser.newContext({viewport:{width:1366,height:768},timezoneId:'America/Chicago'}),p=await ctx.newPage();p.setDefaultTimeout(10000);
   await p.goto(base+'#review');await p.locator('#signin select').selectOption('finance');await p.locator('#signin [type=submit]').click();
   const d=()=>p.locator('dialog[open]').last(),calc=async()=>{await d().getByRole('button',{name:'计算结果',exact:true}).click();await d().locator('.sc-grant[role=status]:not([hidden])').waitFor()};
   const worksheet=async label=>{await p.getByRole('button',{name:label,exact:true}).click()};
   await worksheet('共同费用分摊');await d().locator('summary').click();await d().locator('[name=ticket]').selectOption({index:1});await d().locator('[name=evidence]').fill('SIM-ALLOC-E');await calc();
   assert.match(await d().innerText(),/200\.00/);assert.match(await d().innerText(),/160\.00/);assert.match(await d().innerText(),/WORK-/);await p.keyboard.press('Escape');
   await worksheet('查随单工作表');await d().getByText('SIM-ALLOC-E',{exact:false}).waitFor();await p.keyboard.press('Escape');
   await worksheet('激励预算');await calc();for(const n of ['60.00','51.00','249.00'])assert((await d().innerText()).includes(n));
   await p.screenshot({path:path.join(out,'incentive-1366.png')});await p.keyboard.press('Escape');
   await worksheet('仓储月费');await calc();assert((await d().innerText()).includes('$5.00'));await d().locator('[name=orders]').fill('10');await calc();
   await d().getByText('$945.00',{exact:true}).waitFor();await p.keyboard.press('Escape');
   await worksheet('首派月验收');await d().getByRole('button',{name:'核验队列'}).click();await d().getByText('真实首派未达 20 票',{exact:true}).waitFor();
   await p.screenshot({path:path.join(out,'pilot-1366.png')});await p.keyboard.press('Escape');
   await p.goto(base+'#recovery');await worksheet('返修路径比价');await calc();const txt=await d().innerText();
   for(const n of ['700.00','625.00','565.00','790.00','715.00','655.00'])assert(txt.includes(n),n);
   await p.screenshot({path:path.join(out,'recovery-cost-1366.png')});console.log('PASS finance UX: conserved 200/160, saved/read worksheet, 51/249 incentive, 495+5/945 storage, pilot excludes demo, RMA 700/625/565');
 }finally{sv.kill();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
