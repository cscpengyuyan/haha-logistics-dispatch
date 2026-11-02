'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
(async()=>{
  const root=path.resolve(__dirname,'..'),out=process.env.FLOW_OUTPUT||path.resolve(root,'../../tmp/full-flow-acceptance');
  fs.mkdirSync(out,{recursive:true});
  const shared=process.argv.includes('--shared');
  const startup=shared?['server.py','--port','0','--demo','--db',path.join(out,'shared-'+Date.now()+'.sqlite3')]:['preview.py','--port','0'];
  const server=process.env.FLOW_URL?null:spawn('python',['-B','-u',...startup],{cwd:root,env:{...process.env,HH_APP_VERSION:'v12'},windowsHide:true,stdio:['ignore','pipe','ignore']});
  let browser,p,context,recorder,finished,timer;
  try{
    const base=process.env.FLOW_URL||await new Promise((ok,no)=>{server.stdout.once('data',b=>ok(shared?String(b).match(/http:\/\/127\.0\.0\.1:\d+/)[0]+'/v12/':String(b).trim().split('#')[0]));server.once('error',no)});
    browser=await chromium.launch({channel:'msedge',headless:true});
    context=await browser.newContext({viewport:{width:1440,height:900},...(process.env.FLOW_VIDEO?{recordVideo:{dir:out,size:{width:1100,height:690}}}:{})});
    p=await context.newPage();p.setDefaultTimeout(17000);p.on('pageerror',e=>console.warn(String(e)));
    if(process.argv.includes('--record')){
      const cdp=await context.newCDPSession(p);
      recorder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-c:v','mjpeg','-framerate','8','-i','pipe:0','-c:v','libx264','-vf','scale=1280:-2','-pix_fmt','yuv420p','-preset','fast','-crf','24',path.join(out,'Dallas-two-unit-flow.mp4')],{windowsHide:true,stdio:['pipe','ignore','inherit']});
      finished=new Promise((ok,no)=>{recorder.once('error',no);recorder.once('exit',n=>n?no(Error('ffmpeg '+n)):ok())});
      let frame;cdp.on('Page.screencastFrame',ev=>{frame=Buffer.from(ev.data,'base64');cdp.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{})});
      await cdp.send('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1440,maxHeight:900});
      timer=setInterval(()=>{if(frame&&!recorder.stdin.writableNeedDrain)recorder.stdin.write(frame)},125);
    }
    const button=name=>p.getByRole('button',{name,exact:true});
    const loc=sel=>p.locator(sel);
    const step=async(name)=>{await p.screenshot({path:path.join(out,name+'.png')});console.log(name);if(recorder)await p.waitForTimeout(850)};
    const to=async(page)=>{await p.goto(base+'#'+page)};
    const changeRole=async role=>{
      if(!shared)return;
      context=await browser.newContext({viewport:{width:1366,height:900}});
      const response=await context.request.post(new URL('/api/demo-login',base).href,{data:{username:role}});
      assert.equal(response.status(),200);
      p=await context.newPage();p.setDefaultTimeout(14000);
    };
    await changeRole('sales');await to('sales');await loc('[data-act=example]').waitFor({timeout:90000});
    let downloaded=p.waitForEvent('download');await loc('[data-act=example]').click();let file=path.join(out,'synthetic-dallas.xlsx');await (await downloaded).saveAs(file);
    await loc('[data-file]').setInputFiles(file);await loc('[data-act=confirm]').click();await p.locator('[data-line]').first().waitFor();await changeRole('dispatch');if(shared)await to('sales');await loc('[data-act=handoff]').first().click();
    await loc('select[name=level]').selectOption('L3');await loc('[name=confirm_demo_site]').check();await button('确认接手').click();await p.getByText('已接手',{exact:false}).first().waitFor();
    await step('01-import-handoff');await changeRole('warehouse');await to('rehearsal');await p.getByRole('button',{name:/仓管核对并锁定/}).click();
    if(shared){await p.getByText('待调度',{exact:true}).last().waitFor();await changeRole('procurement');await to('rehearsal')}
    await p.getByRole('link',{name:/采购 ·/}).click();await loc('[data-act=open]').click();await loc('.rfq-dialog [type=submit]').click();
    await loc('[data-act=sample]').click();await p.getByText('SIM Dallas B',{exact:false}).first().waitFor();await step('02-comparison');
    await p.locator('article').filter({hasText:'SIM Dallas B'}).filter({has:loc('[data-act=approve]')}).last().locator('[data-act=approve]').click();
    await loc('[name=approval_ref]').fill('SIM approval B');await loc('[name=reason]').fill('Same scope and window. C2 second leg pending.');
    if(await loc('[name=backup_id] option').count()>1)await loc('[name=backup_id]').selectOption({index:1});
    await loc('.rfq-dialog [type=submit]').click();await loc('[data-act=commission]').click();await loc('[name=commission_ref]').fill('SIM-MANDATE-B-510');await loc('.rfq-dialog [type=submit]').click();await loc('.rfq-dialog').waitFor({state:'hidden'});
    await changeRole('dispatch');await to('rehearsal');await p.getByRole('link',{name:/地图 ·/}).click();await button('规划道路路线').click();await p.waitForFunction(()=>document.querySelector('[data-results]')?.innerText.includes('mi'),null,{timeout:120000});
    await button('保存本票道路试排').click();await p.getByText('本票演练道路已登记。').waitFor();await step('03-dallas-road');
    await to('rehearsal');await p.getByRole('button',{name:/按演练人车/}).click();await p.getByRole('button',{name:/仓管逐台核验/}).waitFor();
    await p.getByRole('link',{name:/前一当地日/}).click();await loc('[data-example]').click();await button('保存预约版本').click();
    await loc('[data-action=queue]').click();await loc('[data-action=simulate]').click();await p.getByText(/T2 · v1 · 模拟送达/).waitFor();await step('04-sms-appointment');
    await changeRole('warehouse');await to('rehearsal');await p.getByRole('button',{name:/仓管逐台核验/}).click();
    if(shared){await p.locator('[data-actions] input').first().waitFor();await changeRole('driver');await to('rehearsal')}await loc('[data-actions] input').nth(0).check();await loc('[data-actions] input').nth(1).check();
    await button('提交两台演练签收凭证').click();if(shared){await p.getByText('已交付',{exact:true}).last().waitFor();await changeRole('finance');await to('rehearsal')}await p.getByRole('button',{name:/财务对照/}).click();await p.getByText(/演练发票 SIM-INV-510/).waitFor();await step('05-pod-invoice');
    console.log('PASS SAME ORDER',await loc('[data-actions]').innerText());
  }catch(err){
    if(p){console.error('PAGE',p.url(),(await p.locator('#content').innerText().catch(()=>'' )).slice(-2400),'NOTICE',await p.locator('#notice').textContent().catch(()=>''));await p.screenshot({path:path.join(out,'failed.png')}).catch(()=>{})}
    throw err;
  }finally{if(recorder){clearInterval(timer);recorder.stdin.end();await finished}await context?.close();await browser?.close();server?.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
