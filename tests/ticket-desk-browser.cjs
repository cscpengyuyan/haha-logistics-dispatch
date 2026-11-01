'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');

const {spawn}=require('node:child_process');

(async()=>{
  const root=path.resolve(__dirname,'..'),out=process.env.DESK_RECORD_DIR;

  const server=spawn('python',['-u','preview.py','--port','0'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','ignore']});
  let browser;
  try{
    const base=await new Promise((ok,no)=>{server.stdout.once('data',s=>ok(String(s).trim().split('#')[0]));server.once('exit',n=>no(Error('preview '+n)))});
    browser=await chromium.launch({channel:'msedge',headless:true});
    for(const [name,width,height] of [['desktop',1366,768],['phone',390,844]]){
      const context=await browser.newContext({viewport:{width,height},isMobile:name==='phone',hasTouch:name==='phone'});
      const p=await context.newPage(),errors=[];p.on('pageerror',err=>errors.push(err.message));p.setDefaultTimeout(30000);
      let recorder,timer,recorded;
      if(out){
        await fs.mkdir(out,{recursive:true});
        const cdp=await context.newCDPSession(p);
        recorder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-c:v','mjpeg','-framerate','8','-i','pipe:0','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-crf','26',path.join(out,name+'.mp4')],{windowsHide:true,stdio:['pipe','ignore','inherit']});
        recorded=new Promise((ok,no)=>{recorder.once('error',no);recorder.once('exit',n=>n===0?ok():no(Error('ffmpeg '+n)))});
        let frame;
        cdp.on('Page.screencastFrame',ev=>{frame=Buffer.from(ev.data,'base64');cdp.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{})});
        await cdp.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:width,maxHeight:height});
        timer=setInterval(()=>{if(frame&&!recorder.stdin.writableNeedDrain)recorder.stdin.write(frame)},125);
        context.once('close',()=>{clearInterval(timer);recorder.stdin.end()});
      }
      const start=Date.now();await p.goto(base);
      const startRun=p.locator('[data-practice]');await startRun.waitFor();
      console.log(name,'first task visible ms',Date.now()-start);
      assert.equal(await p.locator('#section-title').innerText(),'我的待办');
      assert.equal(await p.locator('.td-steps button').count(),4);
      assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await p.locator('.td-steps [data-stage="3"]').click();
      assert.ok(p.url().endsWith('#dock?stage=3'));
      await p.locator('.td-row [data-ticket]').first().click();
      const drawer=p.locator('dialog[open]'),map=drawer.locator('[data-focus-map]');
      await map.waitFor();
      const deep=p.url();assert.match(deep,/stage=3&order=/);
      const id=new URLSearchParams(new URL(deep).hash.split('?')[1]).get('order');
      await p.reload();await map.waitFor();
      assert.equal(await drawer.locator('h2').innerText(),id);
      await map.click();await p.locator('.dm-item.active').first().waitFor({state:'attached'});await p.locator('.dm-mapcard').waitFor();
      assert.ok(p.url().endsWith('#map?focus='+id));
      await p.goBack();await map.waitFor();assert.equal(p.url(),deep);
      await drawer.getByRole('button',{name:'关闭窗口'}).click();await drawer.waitFor({state:'detached'});
      assert.equal(await p.locator('.td-steps [data-stage="3"]').getAttribute('aria-pressed'),'true');
      await p.locator('[data-stage="0"]').click();await startRun.click();
      let s=p.locator('.pilot-card').first();
      await s.locator('[data-switch]').click();await s.locator('form').waitFor();
      await s.getByRole('button',{name:'确认并写入原单'}).click();
      await s.getByRole('heading',{name:'登记装柜与海运'}).waitFor();
      await p.goto(base+'#dock');await startRun.filter({hasText:'续办达拉斯演练'}).waitFor();
      await startRun.click();await s.getByRole('heading',{name:'登记装柜与海运'}).waitFor();
      if(name==='desktop'){
        await s.locator('[data-switch]').click();await s.locator('form').waitFor();
        for(const title of ['休斯敦到港并办理提离','达拉斯收货并锁台','登记三份同范围报价']){
          await s.getByRole('button',{name:'确认并写入原单'}).click();await s.getByRole('heading',{name:title}).waitFor();
        }
        const shipment=await p.evaluate(async()=> (await PublicDemo.api('/api/supply/shipments')).shipments.find(s=>s.batch==='DFW-Q01-B'));
        assert.equal(shipment.units.length,28);
        assert.equal(shipment.units.filter(u=>u.receipt?.state==='hold').length,1);
        await p.goto(base+'#ledger?batch='+shipment.id);
        await p.locator('.sc-units').filter({hasText:'隔离实收'}).waitFor();
        await p.locator('.sc-units').scrollIntoViewIfNeeded();
      }
      await p.goto(base+'#dock');await p.locator('#road-entry').click();
      const panel=p.locator('.public-road'),arrive=panel.locator('[data-status]');
      const plan=panel.getByRole('button',{name:'规划道路路线'});
      await plan.click();
      await arrive.filter({hasText:/道路已计算|无法规划/}).waitFor({timeout:90000});
      assert.match(await arrive.innerText(),/道路已计算/);
      assert.equal(await panel.locator('.pr-timeline li').count(),3);
      await panel.locator('[data-act=save]').click();
      const stored=()=>p.evaluate(()=>JSON.parse(localStorage.getItem(PublicRoadUI.storageKey)));
      const first=await stored();
      assert.equal(first.last.order.length,3);assert.ok(first.last.geometry.length>8);assert.match(first.last.source,/Valhalla/);
      console.log(name,'Dallas 3-stop',first.last.order,'meters',Math.round(first.last.legs.reduce((s,l)=>s+l.distance,0)),first.last.geometry.length,'geometry points');
      const row=panel.locator('.pr-stop').first();await row.locator('summary').click();
      await row.locator('[data-k=close]').fill('08:03');await plan.click();
      await arrive.filter({hasText:'无法规划'}).waitFor();assert.match(await arrive.innerText(),/预约/);
      await panel.locator('[data-act=restore]').click();assert.equal(await panel.locator('.pr-timeline li').count(),3);
      await p.reload();await panel.locator('[data-act=restore]').click();assert.equal(await panel.locator('.pr-timeline li').count(),3);
      if(name==='desktop'){
        await row.locator('summary').click();await row.locator('[data-k=lon]').fill('-96.809');
        await row.locator('[data-k=verified]').check();await plan.click();
        await arrive.filter({hasText:/道路已计算|无法规划/}).waitFor({timeout:90000});
        assert.match(await arrive.innerText(),/道路已计算/);await panel.locator('[data-act=save]').click();
        const second=await stored();assert.notDeepEqual(first.last.geometry,second.last.geometry);
        assert.ok(second.revision>first.revision);
        console.log(name,'replanned point',second.last.order,'meters',Math.round(second.last.legs.reduce((s,l)=>s+l.distance,0)),second.last.geometry.length,'geometry points');
        // Cold-start the real worker with the routing dataset unavailable, while keeping UI and draft accessible.
        await p.reload();await panel.locator('[data-act=restore]').click();
        await context.route('**/vendor/dallas-road/**',rt=>rt.abort('internetdisconnected'));
        await plan.click();await arrive.filter({hasText:'无法规划'}).waitFor({timeout:90000});
        assert.deepEqual((await stored()).last,second.last);
        await context.unroute('**/vendor/dallas-road/**');
        await panel.locator('[data-act=restore]').click();
        assert.equal(await panel.locator('.pr-timeline li').count(),3);
        console.log('PASS road dataset outage preserved all draft inputs, geometry, order, timestamp and version');
      }
      assert.deepEqual(errors,[]);
      await context.close();
      if(recorded)await recorded;
      console.log('PASS',name,'default, stage, ticket URL/reload, map, back/close, practice handover and resume');
    }
  }finally{await browser?.close();server.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
