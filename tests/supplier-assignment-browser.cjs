const {chromium}=require('playwright'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path');
(async()=>{
 const port=18953,server=spawn('python',['-B','walkthrough.py','--port',String(port)],{stdio:'ignore',windowsHide:true});
 const b=await chromium.launch({channel:'msedge',headless:true});try{
   const url='http://127.0.0.1:'+port+'/v12/';
   for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break}catch{}await new Promise(r=>setTimeout(r,150))}
   const ctx=await b.newContext({viewport:{width:1366,height:768},timezoneId:'America/Chicago'}),p=await ctx.newPage();p.setDefaultTimeout(12000);
   await p.goto(url+'#resources');await p.locator('#signin select').selectOption('procurement');await p.locator('#signin [type=submit]').click();
   await p.getByRole('button',{name:'供应商',exact:true}).click();
   await p.getByRole('row').filter({hasText:'DFW样例 B直送'}).getByRole('button',{name:'查看',exact:true}).click();
   const d=()=>p.locator('dialog[open]').last();
   const rates=async(wh,zip)=>{
     await p.getByRole('button',{name:'按 ZIP 查合同价'}).click();await d().locator('[name=warehouse_id]').selectOption({label:wh});await d().locator('[name=zip]').fill(zip);
     await d().locator('[name=product]').selectOption('T2');await d().locator('[name=model]').selectOption('M01');await d().getByRole('button',{name:'查当前版本'}).click();
     await d().getByRole('heading',{name:'合同价匹配结果'}).waitFor();
   };
   await rates('New Jersey','06103');await d().getByRole('button',{name:'登记 / 更正书面合同价'}).click();
   for(const [k,v] of Object.entries({zone:'H',rate_version:'SIM-corrected',amount:'111',valid_until:'2036-12-31',evidence:'SIM-FICTITIOUS'}))await d().locator('[name='+k+']').fill(v);
   await d().getByRole('button',{name:'保存书面价区'}).click();await rates('New Jersey','06103');assert((await d().innerText()).includes('价区 H · 本产品金额 USD 111'));
   await p.screenshot({path:path.join('evidence','supply','tariff-NJ-06103.png')});await p.keyboard.press('Escape');
   await rates('Dallas','');assert((await d().innerText()).includes('缺五位 ZIP'));await d().getByRole('button',{name:'转本票人工询价'}).click();
   const target=await d().locator('[name=order_id] option').evaluateAll(opts=>opts.find(o=>o.textContent.includes('M01')&&o.textContent.includes('75201')).value);
   await d().locator('[name=order_id]').selectOption(target);await d().locator('[name=scope_ref]').fill('SIM-RFQ-current');await d().locator('[name=evidence]').fill('SIM-incomplete-zip');
   await d().getByRole('button',{name:'建立询价记录'}).click();
   await p.locator('dialog.wf-dialog[open]').filter({hasText:target}).waitFor();await p.keyboard.press('Escape');await p.locator('dialog.wf-dialog[open]').waitFor({state:'hidden'});
   await p.getByRole('row').filter({hasText:'DFW样例 B直送'}).getByRole('button',{name:'查看',exact:true}).click();
   await d().getByRole('heading',{name:'逐票询价记录'}).waitFor();
   await p.getByRole('button',{name:'按本票登记分包 / 执行提名'}).click();
   await d().locator('[name=order_id]').selectOption({index:1});
   const match=await d().locator('[name=link_id] option').evaluateAll(o=>o.find(n=>n.textContent.includes('SIM-SUB-B')&&n.textContent.includes('75201')).value);
   await d().locator('[name=link_id]').selectOption(match);
   await d().locator('[name=evidence]').fill('SIM-PO-NOMINATION');
   await d().getByRole('button',{name:'登记提名，等待承接'}).click();await d().locator('.error-line').filter({hasText:/缺少/}).waitFor();
   await d().locator('[name=contract_ref]').fill('SIM-CLIENT-ALLOW-SUB');await d().locator('[name=delegation_ref]').fill('SIM-PRIME-NAME-SUB');await d().getByRole('button',{name:'登记提名，等待承接'}).click();
   const card=p.locator('.sc-grant').filter({hasText:'SIM-SUB-B'});await card.getByRole('button',{name:/打开订单/}).waitFor();
   assert((await card.innerText()).includes('待书面接受'));await card.scrollIntoViewIfNeeded();await p.screenshot({path:path.join('evidence','supply','grant-drilldown-1366.png')});
   const id=(await card.locator('[data-order]').getAttribute('data-order'));await card.getByRole('button',{name:/打开订单/}).click();
   await p.locator('dialog[open]').filter({hasText:id}).waitFor();
   console.log('PASS Procurement supplier→crew→order: missing permission blocked, named subcontract nomination persisted and remains awaiting acceptance');
 }finally{server.kill();await b.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
