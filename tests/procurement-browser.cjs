'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

(async()=>{
  const site=path.resolve(__dirname,'..');
  const server=spawn('python',['-u','preview.py','--port','0'],{cwd:site,windowsHide:true,stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    const url=await new Promise((yes,no)=>{
      server.stdout.once('data',d=>yes(d.toString().trim().split('#')[0]));
      server.once('exit',n=>no(Error('preview exited '+n)));
    });
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',err=>errors.push(err.message));page.setDefaultTimeout(45000);
    await page.goto(url+'#procurement');
    await page.getByRole('heading',{name:'待询价与委托'}).waitFor();
    // Isolate the UI under test on a fresh synthetic workbook ticket.
    const oid=await page.evaluate(async()=>{
      const api=window.PublicDemo.api.bind(window.PublicDemo),post=(url,body)=>api(url,{method:'POST',body});
      const file={filename:'synthetic-sales.xlsx',...(await api('/api/sales/example'))};
      const pre=await post('/api/sales/preview',file);
      const {tickets}=await post('/api/sales/confirm',{...file,token:pre.token});
      const oid=Object.values(tickets)[0],line=(await api('/api/sales/lines')).lines.find(l=>l.id===oid);
      const {order}=await post('/api/sales/handoff',{id:oid,version:line.version,level:'L3',confirm_demo_site:true});
      await post('/api/orders/'+oid+'/actions',{action:'ready',version:order.version,sn:'SIM-RFQ-M01-01,SIM-RFQ-M01-02',release_ref:'SIM-GRN'});
      await post('/api/demo-login',{username:'procurement'});
      return oid;
    });
    await page.goto(url+'#procurement?order='+oid);await page.reload();
    const open=page.getByRole('button',{name:'生成本票询价包',exact:true});
    await open.click();
    const dialog=page.locator('.rfq-dialog[open]');
    await dialog.locator('[type=submit]').click();
    await page.getByText('当前范围',{exact:false}).first().waitFor();
    const sample=page.getByRole('button',{name:'录入四份达拉斯演练回价',exact:true});
    await sample.click();
    const offers=page.locator('.rfq-offer');
    const b=offers.filter({has:page.getByRole('heading',{name:'SIM Dallas B',exact:true})});
    await b.getByText('可执行首选',{exact:true}).waitFor();
    assert.equal(await offers.count(),4);
    const c=offers.filter({has:page.getByRole('heading',{name:'SIM Dallas C2',exact:true})});
    assert.match(await c.innerText(),/待二程承接/);assert.match(await c.innerText(),/低 \$20/);
    await b.getByRole('button',{name:'选为主案并审批'}).click();
    await dialog.locator('[name=approval_ref]').fill('SIM-OK');
    await dialog.locator('[name=reason]').fill('Same window, insured pair, full machine placement.');
    await dialog.locator('[type=submit]').click();
    await page.getByRole('button',{name:'登记正式书面委托'}).click();
    await dialog.locator('[name=commission_ref]').fill('SIM-COMMISSION');
    await dialog.locator('[type=submit]').click();
    await page.getByText('已有委托 SIM-COMMISSION').waitFor();
    await page.reload();
    await page.getByText('已有委托 SIM-COMMISSION').waitFor();
    await page.goto(url+'#procurement?leg=ocean');
    await page.getByRole('button',{name:'从候选船期生成头程询价包'}).click();
    const candidate=await dialog.locator('[name=candidate_id]').inputValue();
    await dialog.locator('[name=units]').fill('2');await dialog.locator('[name=unloading]').fill('Doorside unloading included');
    await dialog.locator('[name=deadline]').fill('2036-12-31');await dialog.locator('[type=submit]').click();
    for(const [mode,basis,qty,rate] of [['FCL','container',1,900],['LCL','W/M',3,100]]){
      await page.getByRole('button',{name:'登记头程回价'}).click();
      await dialog.locator('[name=mode]').selectOption(mode);await dialog.locator('[name=basis]').selectOption(basis);
      const fields={supplier:'SIM head '+mode,basis_qty:qty,rate,origin_charge:0,port_charge:80,cfs_charge:0,inland_charge:150,other_charge:0,
                    included:'Origin and insurance included',excluded:'None',evidence:'SIM-QUOTE-'+mode,valid_until:'2036-12-31'};
      for(const [k,v] of Object.entries(fields))await dialog.locator('[name='+k+']').fill(String(v));
      await dialog.locator('[name=same]').check();await dialog.locator('[type=submit]').click();
    }
    await page.getByText('到仓合计 530 USD · 每台 265').waitFor();
    await page.locator('.rfq-grid article').filter({hasText:'SIM head LCL'}).getByRole('button',{name:'登记书面中选'}).click();
    await dialog.locator('[name=procurement_ref]').fill('SIM-OCEAN-BOOK');
    await dialog.locator('[name=reason]').fill('Same end, unloading and window confirmed');
    await dialog.locator('[type=submit]').click();await page.getByText('中选书证 SIM-OCEAN-BOOK',{exact:false}).waitFor();
    await page.evaluate(()=>window.PublicDemo.api('/api/demo-login',{method:'POST',body:{username:'warehouse'}}));
    await page.goto(url+'#ocean');await page.reload();
    await page.locator('[data-candidates]').click();await page.locator('[data-select="'+candidate+'"]').click();
    const booking=page.locator('.supply-dialog[open]');
    await booking.locator('[name=ocean_rfq_id]').selectOption({index:1});
    assert.equal(await booking.locator('[name=procurement_ref]').inputValue(),'SIM-OCEAN-BOOK');
    for(const [k,v] of Object.entries({batch:'SIM-HEAD-B',container:'SIM-HBL',asn:'SIM-HEAD-ASN',csv:'SIM-HEAD-1,M01\nSIM-HEAD-2,M01'}))
      await booking.locator('[name='+k+']').fill(v);
    await booking.locator('[name=inland]').selectOption('road');
    await booking.locator('[type=submit]').click();
    await page.getByText('SIM-HEAD-ASN',{exact:false}).first().waitFor();
    await page.evaluate(()=>window.PublicDemo.api('/api/demo-login',{method:'POST',body:{username:'procurement'}}));
    await page.goto(url+'#procurement?leg=ocean');await page.reload();
    await page.getByRole('link',{name:'查看已订批次'}).waitFor();
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS Edge UI: intake workbook fixture / zero quotes / 240-510-545-490 / approval / separate written commission / reload / FCL vs LCL / written award to warehouse manifest / batch back-link.');
  }finally{
    if(browser)await browser.close();
    server.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1});
