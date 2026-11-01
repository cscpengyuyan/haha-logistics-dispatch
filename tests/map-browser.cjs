const {chromium}=require('playwright');
const {join}=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const [base,stage='before',out='docs/evidence/map']=process.argv.slice(2);
 fs.mkdirSync(out,{recursive:true});
 const b=await chromium.launch({channel:'msedge',headless:true});
 try {
 for(const [width,height] of [[1440,900],[1366,768],[390,844]]){
  const c=await b.newContext({viewport:{width,height},timezoneId:'America/Chicago'});
  const p=await c.newPage();p.setDefaultTimeout(40000);const t=Date.now();
  await p.goto(base+'#map');await p.locator('[data-act=sample]').first().waitFor();
  const ready=Date.now()-t;
  if(stage==='after'){
    await p.locator('.dm-list [data-act=toggle]:enabled').first().click();
    await p.locator('.dm-command').scrollIntoViewIfNeeded();
    await p.screenshot({path:join(out,stage+'-'+width+'-selected.png')});
    await p.locator('.dm-list [data-act=toggle]').filter({hasText:'移出'}).click();
  }
  await p.locator('[data-act=sample]').click();
  await p.locator('.dm-stops>li').nth(1).waitFor();
  const take=async(label)=>{await p.screenshot({path:join(out,stage+'-'+width+'-'+label+'.png')})};
  await p.locator('.dm-command').scrollIntoViewIfNeeded();if(stage==='before')await take('selected');
  if(stage==='before'){await p.locator('.dm-stops').scrollIntoViewIfNeeded();await take('plan')}
  else{
   assert.match(await p.locator('[data-box=costResult]').textContent(),/650.00.*670.00.*保留原线/);
   const conflict=p.getByText(/晚 10 分钟/).first();await conflict.waitFor();
   await p.locator('[data-box=decision]').scrollIntoViewIfNeeded();await take('conflict');
   await p.locator('[data-act=split]').click();
   assert.equal(await p.locator('.dm-stops>li').count(),1);
   await p.locator('[data-box=decision]').scrollIntoViewIfNeeded();await take('split');
   await p.locator('[data-act=undo]').click();assert.equal(await p.locator('.dm-stops>li').count(),2);
  }
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  console.log(JSON.stringify({stage,width,height,ready_ms:ready,browser:b.version()}));
  await c.close();
 }
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
