'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
 const [base,baselineDir,outDir]=process.argv.slice(2),out=outDir||'evidence/supply';fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true}),pw=[];
 let old=null;
 try{
   if(baselineDir){
     old=spawn('python',['-B','-m','http.server','18947','--bind','127.0.0.1','--directory',baselineDir],{windowsHide:true,stdio:'ignore'});
     for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:18947/v12/')).ok)break}catch{}await new Promise(r=>setTimeout(r,150))}
   }
   const widths=[[1440,900],[1366,768],[390,844]];
   const recording=process.env.SUPPLY_RECORD==='1';
   const context=await browser.newContext({viewport:{width:1440,height:900},timezoneId:'America/Chicago',...(recording?{recordVideo:{dir:require('node:os').tmpdir(),size:{width:1280,height:800}}}:{})}),p=await context.newPage();p.setDefaultTimeout(30000);p.on('pageerror',e=>pw.push(e.message));
   if(baselineDir){
     const oldPage=await context.newPage();await oldPage.goto('http://127.0.0.1:18947/v12/#ledger');await oldPage.getByRole('button',{name:'登记海运交接',exact:false}).waitFor({timeout:90000});
     for(const [w,h] of widths){await oldPage.setViewportSize({width:w,height:h});await oldPage.screenshot({path:path.join(out,'before-ledger-'+w+'.png')})}
     await oldPage.close();
   }
   await p.goto(base+'#ocean');const sel=p.locator('#signin select');await sel.waitFor();await sel.selectOption('admin');await p.locator('#signin [type=submit]').click();
   await p.getByRole('button',{name:'登记订舱',exact:true}).waitFor();
   const sn='DEMO-SCREEN-A',asn='SCREEN-ASN',bulk=Array.from({length:26},(_,i)=>'SCREEN-GOOD-'+String(i+1).padStart(2,'0'));
   const dlg=()=>p.locator('dialog[open]').last();
   const fill=async f=>{for(const [k,v] of Object.entries(f))await dlg().locator('[name="'+k+'"]').fill(v)};
   const submit=async label=>{await dlg().getByRole('button',{name:label,exact:true}).click();await dlg().waitFor({state:'hidden',timeout:8000})};
   const milestone=async(k,time)=>{await p.getByRole('button',{name:'登记节点 / ETA'}).click();await dlg().locator('[name=kind]').selectOption(k);
     await fill({at:time,custodian:'合成仓运岗',evidence:'SIM-'+k});
     if(k==='eta'){await dlg().getByRole('button',{name:'预览延误影响'}).click();await dlg().getByText('本次改约影响').waitFor();await submit('确认更新预测')}
     else await submit('保存本次节点')};
   if(await p.locator('[name=voyage]').count()===0||!(await p.locator('[name=voyage]').textContent()).includes('SCREEN-B')){
     await p.getByRole('button',{name:'比较候选航次'}).click();
     await fill({origin:'Shanghai',requiredBy:'2026-10-23'});await dlg().getByText('预计送仓晚于要求').waitFor();
     await dlg().locator('.sc-option').filter({hasText:'SIM-SHA-HOU-01'}).getByRole('button',{name:'选此航次并订舱'}).click();
     await fill({batch:'SCREEN-B',container:'SCREEN-BOX',asn,seal:'SIM-SEAL',bill_of_lading:'SIM-BL',pickup_site:'SIM terminal',inland_owner:'SIM crew',
       procurement_ref:'SIM-BOOK',csv:[sn,'DEMO-SCREEN-B',...bulk].map(x=>x+',M01,').join('\n')});
     await dlg().locator('[name=mode]').selectOption('FCL');await dlg().locator('[name=inland]').selectOption('road');
     await submit('登记订舱');const overview=p.locator('[data-lanes] tr').filter({hasText:asn});
     await overview.getByText('28 / 28').waitFor();const originalDates=await overview.locator('td').nth(2).innerText();
     await milestone('shipping_docs','2026-09-29T10:00:00+08:00');
     await milestone('loaded','2026-10-01T10:00:00+08:00');await milestone('eta','2026-10-24T10:00:00-05:00');
     assert.notEqual(await overview.locator('td').nth(2).innerText(),originalDates,'ETA change must refresh multi-batch forecast');
     await milestone('arrived','2026-10-24T10:00:00-05:00');
     await milestone('handoff_site','2026-10-24T10:10:00-05:00');
     await p.getByRole('button',{name:'登记节点 / ETA'}).click();await dlg().locator('[name=kind]').selectOption('pickup');await fill({at:'2026-10-24T14:00:00-05:00',custodian:'模拟',evidence:'TEST-REF'});
     await dlg().getByRole('button',{name:'保存本次节点'}).click();await dlg().getByRole('alert').getByText('缺少前序回执',{exact:false}).waitFor();await p.keyboard.press('Escape');
     for(const [i,k] of ['customs','carrier_release','terminal_ready','pickup','warehouse_arrival'].entries())await milestone(k,'2026-10-24T'+(11+i)+':00:00-05:00');
     for(const [unit,state] of [[sn,'available'],['DEMO-SCREEN-B','hold']]){
       await p.getByRole('button',{name:'逐台验收',exact:true}).click();await dlg().locator('[name=sn]').selectOption(unit);await dlg().locator('[name=state]').selectOption(state);
       await fill({bin:'S-01',condition:state==='hold'?'模拟外包装受损':'逐项通过',evidence:'SIM-'+unit,custodian:'演练库管'});await submit('确认收货');
     }
     await p.getByRole('button',{name:'批量扫码验收',exact:true}).click();
     await fill({serials:bulk.join('\n')+'\nUNKNOWN-SN',bin:'S-01',condition:'合格',custodian:'演练库管',evidence:'SIM-GRN-MULTI'});
     await dlg().locator('[name=state]').selectOption('available');
     await dlg().getByRole('button',{name:'确认本批收货',exact:true}).click();await dlg().getByRole('alert').getByText('SN 与该 ASN 不符',{exact:false}).waitFor();
     await fill({serials:bulk.join('\n')+'\n'+bulk[0]});await submit('确认本批收货');
     await overview.getByText('0 / 28').waitFor();await p.locator('.sc-arrivals').getByText(/当前可用 27.*隔离 1/).waitFor();
   }else await p.locator('[name=voyage]').selectOption({label:'SIM-SHA-HOU-01 / SCREEN-B / SCREEN-BOX'});
   await p.getByText('晚 48 小时',{exact:true}).waitFor();
   for(const [w,h] of widths){
     await p.setViewportSize({width:w,height:h});await p.locator('[data-single]').scrollIntoViewIfNeeded();
     const overflow=await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,'page overflow '+overflow);
     await p.screenshot({path:path.join(out,'after-gantt-'+w+'.png')});
   }
   await p.getByRole('button',{name:'登记复核回执'}).first().click();await fill({evidence:'SIM-rebook-phone'});await submit('完成复核');
   await p.setViewportSize({width:1366,height:768});
   await p.getByRole('button',{name:'作业表03 · 海运交接'}).click();
   const download=p.waitForEvent('download');await dlg().getByRole('button',{name:'导出 CSV'}).click();
   const file=await download;assert(file.suggestedFilename().includes(asn));assert((await fs.promises.readFile(await file.path(),'utf8')).includes(sn));await p.keyboard.press('Escape');
   await p.getByRole('button',{name:'查看仓内 SN'}).first().click();
   const stockSearch=p.getByRole('searchbox',{name:'搜索台账'});await stockSearch.waitFor();assert.equal(await stockSearch.inputValue(),sn);await p.screenshot({path:path.join(out,'after-inventory-1366.png')});
   const [stock,manifest]=await Promise.all(['/api/lifecycle/assets','/api/supply/shipments'].map(async path=>(await context.request.get(new URL(path,base).href)).json()));
   const warehouse='Dallas',model='M01',units=stock.records.filter(r=>r.warehouse===warehouse&&r.model===model);
   const expected=manifest.shipments.filter(s=>s.warehouse===warehouse).flatMap(s=>s.units).filter(u=>u.model===model&&!u.receipt).length;
   const totals=[String(expected),...['pending_qc','available','reserved','hold','transfer'].map(state=>String(units.filter(r=>r.state===state).length))];
   const cells=await p.locator('.lc-panel table tbody tr').filter({has:p.getByRole('cell',{name:warehouse,exact:true})}).filter({has:p.getByRole('cell',{name:model,exact:true})}).locator('td').allTextContents();
   assert.deepEqual(cells,[warehouse,model,...totals]);
   await p.locator('.lc-rows [data-show]').first().click();await dlg().getByRole('button',{name:'追溯海运 ASN'}).click();await p.getByText('晚 48 小时',{exact:true}).waitFor();
   // Supplier matrix reached by the normal directory view.
   await p.goto(base+'#resources');await p.getByRole('button',{name:'供应商',exact:true}).click();await p.getByRole('button',{name:'查看',exact:true}).first().click();
   await dlg().getByText('仓址 × 机型 × 动作',{exact:true}).waitFor();await p.screenshot({path:path.join(out,'after-supplier-1366.png')});
   await dlg().getByRole('button',{name:'作业表02',exact:true}).click();
   await dlg().getByText('实际 ZIP',{exact:true}).waitFor();await dlg().getByRole('button',{name:'导出 CSV'}).waitFor();
   assert.deepEqual(pw,[]);await context.close();
   if(recording){const video=p.video();await video.saveAs(path.join(out,'航次比较到逐台收货.webm'));await video.delete()}
   console.log('PASS real UI: candidate booking, ETA +48h preview, pickup gate, 28 ASN receipts (27 available, one quarantine, duplicate scan, bad batch rolled back), rescheduling, Gantt→SN, supplier matrix, responsive layouts');
 }finally{await browser.close();if(old)old.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
