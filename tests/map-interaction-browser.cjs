'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
async function exercise(page,route,mode){
  const sel=route==='map'?'.dm-map':'.pr-map',map=page.locator(sel);
  await page.goto(page.url().split('#')[0]+'#'+route);
  await page.waitForFunction(sel=>document.querySelector(sel)?.dataset.zoom,sel,{timeout:35000}).catch(async err=>{console.warn(page.url(),(await page.locator('body').innerText()).slice(0,700));throw err});
  await map.scrollIntoViewIfNeeded();
  const zoom=async()=>Number(await map.getAttribute('data-zoom'));
  const before=await zoom(),box=await map.boundingBox();
  const x=box.x+box.width*.56,y=box.y+box.height*.52;
  if(mode==='wheel'){
    await page.mouse.move(x,y);await page.mouse.wheel(0,-220);
  }else{
    const cdp=await page.context().newCDPSession(page);
    const touch=async(type,d)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:d?[{x:x-d,y,id:1},{x:x+d,y,id:2}]:[]});
    await touch('touchStart',14);
    for(const d of [21,30,43,60,80]){await touch('touchMove',d);await page.waitForTimeout(45)}
    await touch('touchEnd');await cdp.detach();
  }
  await page.waitForFunction(({sel,before})=>Number(document.querySelector(sel).dataset.zoom)>before,{sel,before});
  const after=await zoom();
  const style=page.locator('[data-map-style]'),view=page.locator('[data-map-view]');
  const layer=page.locator(route==='map'?'[data-act=layer][data-key=orders]':'[data-map-layer=stops]');
  await layer.click();assert.equal(await layer.getAttribute('aria-pressed'),'false');
  await style.selectOption('light');await view.selectOption('ak');const alaska=await zoom();assert.ok(alaska<7,'AK extent should include the whole state');
  await page.reload();await page.waitForFunction(sel=>document.querySelector(sel)?.dataset.zoom,sel,{timeout:35000}).catch(async err=>{console.warn(page.url(),(await page.locator('body').innerText()).slice(0,700));throw err});
  assert.equal(await style.inputValue(),'light');assert.equal(await layer.getAttribute('aria-pressed'),'false');
  assert.equal(await zoom(),alaska);await view.selectOption('hi');await view.selectOption('lower48');await view.selectOption('us');
  console.log(route,mode,before,'->',after,'AK zoom',alaska,'layers/style/view persisted');
}
(async()=>{
  const endpoint=process.env.HH_PUBLIC_MAP_URL,root=path.resolve(__dirname,'..');
  const proc=endpoint?null:spawn('python',['-u','preview.py','--port','0'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','ignore']});
  let browser;
  try{
    const base=endpoint||await new Promise((ok,no)=>{proc.stdout.once('data',d=>ok(String(d).trim().split('#')[0]));proc.once('exit',n=>no(Error('preview '+n)))});
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    for(const touch of [false,true]){
      const ctx=await browser.newContext({viewport:touch?{width:390,height:844}:{width:1440,height:900},isMobile:touch,hasTouch:touch});
      const page=await ctx.newPage(),errors=[];page.on('pageerror',err=>{errors.push(err.message);console.warn(err)});page.on('console',msg=>{if(msg.type()==='error')console.warn(msg.text().slice(0,180))});page.setDefaultTimeout(60000);
      const response=await page.goto(base+'#map',{waitUntil:'domcontentloaded'});assert.equal(response.status(),200);
      for(const route of ['map','road'])await exercise(page,route,touch?'pinch':'wheel');
      await page.locator('.pr-map').dblclick();
      await page.evaluate(()=>{location.hash='dock'});await page.waitForTimeout(550);
      assert.deepEqual(errors,[]);await ctx.close();
    }
  }finally{await browser?.close();proc?.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
