'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path'), os=require('node:os'), fs=require('node:fs/promises');
const {spawn}=require('node:child_process');

(async()=>{
  const root=path.resolve(__dirname,'..'),out=process.env.ROAD_RECORD_DIR;
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'dfw-accept-'));
  const services={...process.env,HH_ROAD_COVERAGE:'Dallas · OSM 试点'};
  if(!services.HH_VALHALLA_URL||!services.HH_VROOM_URL)throw Error('Set HH_VALHALLA_URL and HH_VROOM_URL to a real DFW service.');
  const server=spawn('python',['-u','server.py','--demo','--db',path.join(tmp,'demo.sqlite3'),'--port','0'],
    {cwd:root,env:services,windowsHide:true,stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    const base=await new Promise((ok,no)=>{
      server.stdout.once('data',s=>ok(String(s).match(/http:\/\/127\.0\.0\.1:\d+/)[0]));
      server.once('exit',n=>no(Error('server '+n)));
    });
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    for (const [key,width,height] of [['desktop',1440,900],['phone',390,844]]){
      if(out)await fs.mkdir(out,{recursive:true});
      const ctx=await browser.newContext({viewport:{width,height},isMobile:key==='phone',hasTouch:key==='phone'});
      const page=await ctx.newPage(),errors=[],tiles=[];
      let recorder,timer,completed;
      if(out){
        const cdp=await ctx.newCDPSession(page);
        recorder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-c:v','mjpeg','-framerate','8','-i','pipe:0','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-crf','27',path.join(out,key+'-route.mp4')],{windowsHide:true,stdio:['pipe','ignore','inherit']});
        completed=new Promise((ok,no)=>{recorder.once('error',no);recorder.once('exit',n=>n===0?ok():no(Error('ffmpeg '+n)))});
        let frame;
        cdp.on('Page.screencastFrame',ev=>{frame=Buffer.from(ev.data,'base64');cdp.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{})});
        await cdp.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:width,maxHeight:height});
        timer=setInterval(()=>{if(frame&&!recorder.stdin.writableNeedDrain)recorder.stdin.write(frame)},125);
        ctx.once('close',()=>{clearInterval(timer);recorder.stdin.end()});
      }
      page.on('pageerror',e=>errors.push(e.message));
      page.on('response',r=>{if(r.url().endsWith('/dfw.pmtiles'))tiles.push(r.status())});
      page.on('console',m=>{if(m.type()==='error')console.warn(m.text().slice(0,260))});
      page.on('response',async r=>{if(r.status()>=400 && r.url().includes('/api/'))console.log(r.status(),r.url(),await r.text())});
      const action=a=>page.locator('[data-act="'+a+'"]').first();
      await page.goto(base+'/v12/#map');
      await page.locator('[name=username]').selectOption('dispatch');
      await page.locator('#signin button[type=submit]').click();
      await action('truckDemo').waitFor();
      if(key==='desktop'&&out)await page.screenshot({path:path.join(out,'01-before-selection.png')});
      const setup=page.waitForResponse(r=>r.url().endsWith('/api/road/practice'));
      await action('truckDemo').click();const seeded=await setup;assert.equal(seeded.status(),200,await seeded.text());
      await page.waitForFunction(()=>document.querySelectorAll('.dm-stops>li').length===3);
      if(key==='phone')await action('jumpPlan').click();
      const call=page.waitForResponse(r=>r.url().endsWith('/api/road/plan'));
      await action('roads').click();
      const response=await call;
      assert.equal(response.status(),200,await response.text());
      await page.waitForFunction(()=>document.querySelector('[data-box=stops]')?.textContent.includes('Valhalla truck / VROOM'));
      await action('save').click();
      await page.waitForFunction(()=>document.querySelector('[data-box=decision]')?.textContent.includes('已核可行'));
      assert.equal(await page.locator('.dm-stops>li').count(),3);
      if(key==='phone')await action('jumpMap').click();
      await page.waitForFunction(()=>document.querySelector('[data-box=layer]')?.textContent.includes('Protomaps'),undefined,{timeout:20000});
      await page.waitForFunction(()=>document.querySelector('[data-box=map]')?.getAttribute('aria-description')?.startsWith('当前街道'),undefined,{timeout:16000});
      console.log(key,await page.locator('[data-box=map]').getAttribute('aria-description'));
      if(out)await page.screenshot({path:path.join(out,key+'-planned.png')});
      if(key==='phone')await action('jumpPlan').click();
      await page.locator('.dm-checks summary').first().click();
      const finish=page.locator('[data-prop=finish_by]').first();
      await finish.fill((await finish.inputValue()).slice(0,10)+'T08:03');
      await finish.press('Tab');
      const conflict=page.waitForResponse(r=>r.url().endsWith('/api/road/plan'));
      await action('roads').click();assert.equal((await conflict).status(),422);
      await page.locator('[data-box=message]').filter({hasText:'预约窗不足'}).waitFor();
      assert.equal(await page.locator('[data-box=decision] [data-act=dispatch]').count(),0);
      if(key==='desktop'&&out)await page.screenshot({path:path.join(out,'03-window-conflict.png')});
      assert.ok(tiles.includes(206),'PMTiles range responses');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');
      assert.deepEqual(errors,[]);
      console.log(key,'3 stops, valid truck plan, saved draft, finish cutoff conflict, PMTiles 206, no page errors');
      await ctx.close();if(out)await completed;
    }
  }finally{
    await browser?.close();server.kill();await fs.rm(tmp,{recursive:true,force:true,maxRetries:3,retryDelay:200});
  }
})().catch(e=>{console.error(e);process.exitCode=1});
