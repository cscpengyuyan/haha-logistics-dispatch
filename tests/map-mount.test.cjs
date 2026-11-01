'use strict';
// Exercise the production mount, DOM restructure, restored candidate selection
// and timeline rendering in a real browser. No copied plan-render implementation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const bundled=fs.existsSync(chromium.executablePath());
const edgeAvailable=process.platform==='win32'&&fs.existsSync(edge);

test('real DOM mount restores nonempty map route and survives timeline timezone changes',
 {skip:!bundled&&!edgeAvailable?'Install Playwright Chromium or Microsoft Edge to run DOM integration':false,timeout:30000},async()=>{
 const browser=await chromium.launch({headless:true,...(!bundled?{executablePath:edge}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.route('http://dispatch.test/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body><main id="root"></main></body></html>'}));
  const scripts=['dispatch-workspace.js','map-controls.js','dispatch-map.js'];
  async function load(){await page.goto('http://dispatch.test/');for(const name of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(root,'v13',name),'utf8')});}
  await load();
  await page.evaluate(()=>{
   const ctx={user:{username:'dispatch',role:'dispatch'},dataset:'mount-regression'};
   const orders=['A','B'].map((id,i)=>({id,version:1,status:'ready',customer:'SIM customer',quantity:1,warehouse:'SIM origin',
    city:'Dallas',state:'TX',zip:'75201',address:'SIM dock',endpoint:'SIM confirmed position',level:'L3',route:'B',
    timezone:'America/Chicago',window_start:'2030-07-10T08:00',window_end:'2030-07-10T18:00',lat:32.78+i*.01,lng:-96.8,
    location_precision:'dock',coordinate_ref:'SIM-TEST'}));
   const route={id:'SIM-ROUTE',name:'SIM restored route',warehouse:'SIM origin',date:'2030-07-10',start_time:'08:00',
    timezone:'America/Chicago',order_ids:['A','B'],order_versions:{A:1,B:1},checks:{return_min:30},stops:{A:{travel:20,service:30},B:{travel:15,service:40}},check_result:{issues:[]}};
   localStorage.setItem('map-fixture',JSON.stringify({ctx,orders}));
   window.DispatchWorkspace.open(ctx).update({id:'PLAN-RESTORED',version:4,order_ids:['A','B'],validation_status:'passed',
    candidates:[{id:'C1',routes:[route],unassigned:[],validation_status:'passed',coverage:{assigned:2}}]});
  });
  // Reload clears all JS memory while retaining the actual localStorage plan.
  await load();
  const result=await page.evaluate(()=>{
   const fixture=JSON.parse(localStorage.getItem('map-fixture'));
   const ctx={...fixture.ctx,orders:fixture.orders,resources:[{id:'W1',type:'warehouse',name:'SIM origin',
    timezone:'America/Chicago',version:1,lat:32.75,lng:-96.82}],routes:[],routingEnabled:false,
    api:async path=>path==='/api/drivers'?{drivers:[]}:{sites:[]},navigate(){},toast(){}};
   window.mapHandle=window.DispatchMap.mount(document.getElementById('root'),ctx);
   return {selected:window.mapHandle.getSelection().map(o=>o.id),timeline:document.querySelector('[data-box="timeline"]').textContent,
    scope:document.querySelector('[data-box="batchScope"]').textContent,fallback:document.querySelector('[data-box="map"]').textContent};
  });
  assert.deepEqual(result.selected,['A','B']);
  assert.match(result.timeline,/A/);assert.match(result.timeline,/B/);assert.match(result.timeline,/America\/Chicago/);
  assert.match(result.scope,/计算批次 2 票/);assert.match(result.fallback,/地图资源未加载/);
  await page.locator('[data-uw-field="timezone"]').selectOption('Asia/Shanghai');
  assert.match(await page.locator('[data-box="timeline"]').innerText(),/Asia\/Shanghai/);
  // Date changes and narrow view keep both restored IDs, exercising repaint.
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-field="dayPick"]').fill('2030-07-11');
  await page.locator('[data-field="dayPick"]').dispatchEvent('change');
  assert.match(await page.locator('[data-box="batchScope"]').innerText(),/筛选外仍纳入 2 票/);
  assert.deepEqual(await page.evaluate(()=>window.mapHandle.getSelection().map(o=>o.id)),['A','B']);
  await page.evaluate(()=>window.mapHandle.destroy());
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
