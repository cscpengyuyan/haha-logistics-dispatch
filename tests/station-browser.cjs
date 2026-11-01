/* Real shared HTTP sessions, no mocked routes. Usage: node tests/station-browser.cjs */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const trial=fs.mkdtempSync(path.join(os.tmpdir(),'v12-station-'));
const out=path.resolve('docs/evidence/station');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const server=spawn('python',['-B','-X','utf8','server.py','--demo','--port','0','--db',path.join(trial,'test.sqlite3')],{windowsHide:true});
 let browser;
 try{
  const base=await new Promise((ok,no)=>{server.stdout.on('data',chunk=>{const m=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)ok(m[0])});server.once('exit',code=>no(Error('server exit '+code)));server.stderr.on('data',c=>process.stderr.write(c))});
  browser=await chromium.launch({channel:'msedge',headless:true});
  async function session(role){
   const c=await browser.newContext({viewport:{width:1366,height:768}}),p=await c.newPage();
   p.setDefaultTimeout(10000);await p.goto(base+'/v12/#orders');
   await p.locator('#signin select').selectOption(role);await p.locator('#signin button').click();
   await p.locator('#section-title').waitFor();return p;
  }
  const ware=await session('warehouse'),buyer=await session('procurement'),dispatch=await session('dispatch');
  async function api(p,route,body,negative=false){
   const r=await p.request.fetch(base+route,{method:body?'POST':'GET',data:body});const v=await r.json();
   if(negative){assert.ok(r.status()>=400,JSON.stringify(v));return v}
   assert.ok(r.ok(),JSON.stringify(v));return v;
  }
  const {orders}=await api(ware,'/api/orders'),o=orders.find(o=>o.city==='New York');
  const url='/api/orders/'+o.id,order=async(p)=>(await api(p,url)).order;
  async function open(p,id){
   await p.goto(base+'/v12/#orders');await p.reload();await p.locator('[data-order="'+id+'"]').first().click();
   await p.locator('.wf-handoff').waitFor();
  }
  const dialog=ware.locator('dialog[open]').last();
  await open(ware,o.id);await dialog.locator('[data-cmd=station_receive]').first().click();
  for(const [k,val] of Object.entries({station_name:o.second_leg.station_name,custodian:'SIM NJ 仓管',receipt_ref:'SIM DOCK GRN',station_condition0:'完好',station_evidence0:'SIM-UNIT-DOCK'}))await dialog.locator('[name="'+k+'"]').fill(val);
  await dialog.locator('[type=submit]').click();
  await dialog.getByText('SIM DOCK GRN',{exact:false}).first().waitFor({state:'attached'});
  assert.equal((await order(ware)).status,'at_station');
  await api(dispatch,url+'/actions',{version:(await order(dispatch)).version,action:'station_release',driver:'driver',carrier:'未登记人',dispatch_ref:'假码'},true);
  async function arm(o,leg,driver,executor){
   const day=o.window_start.slice(0,10),resources=(await api(dispatch,'/api/ops/resources')).resources;
   const wh=resources.find(r=>r.type==='warehouse'&&r.name===(leg===2?o.station_name:o.warehouse));
   const res=async(type,cols)=>(await api(dispatch,'/api/ops/resources',{type,name:'TEST '+type+' '+driver+' '+o.id,...cols})).resource;
   const vehicle=await res('vehicle',{capacity_units:8,door_cm:240,payload_kg:2400,tie_slots:8,lift_capacity_kg:1000,equipment:'SIM liftgate',evidence:'SIM VEH',executor_id:executor});
   const crew=await res('crew',{coverage:o.zip,headcount:2,tools:'dolly,straps',equipment:'SIM crew x2',qualified_until:'2036-12-31',evidence:'SIM CREW',executor_id:executor});
   const plan=(await api(dispatch,'/api/ops/routes',{name:'TEST '+driver,warehouse:wh.name,date:day,start_time:'08:00',
     timezone:wh.timezone,resource_id:vehicle.id,crew_id:crew.id,executor_id:executor,order_ids:[o.id],order_versions:{[o.id]:o.version},road_basis:'carrier',
     checks:{driver,scope_ref:'TEST-SCOPE',handling_ref:'TEST-LIFT',shift_start:day+'T07:00',shift_end:day+'T19:00',warehouse_start:day+'T07:00',warehouse_end:day+'T15:00',return_min:20},
     stops:{[o.id]:{from_id:wh.id,road_ref:'ROAD',dock_ref:'DOCK',package_ref:'PACK',height:195,kg:165,required_people:2,required_tools:'straps,dolly',requires_lift:'yes',travel:35,admission:10,unload:10,service:30}}})).route;
   assert.deepEqual(plan.check_result.issues,[]);
   const plate='SIM-'+driver,link=(await api(buyer,'/api/gate/network',{executor_id:executor,crew_id:crew.id,vehicle_id:vehicle.id,driver,plate,
     warehouse_id:wh.id,zip:o.zip,model:o.model,level:o.level,product:'T2',valid_until:'2036-12-31',insurance_until:'2036-12-31',evidence:'SIM REG'})).link;
   const auth='/api/gate/'+o.id;
   const grant=(await api(buyer,auth+'/invite',{version:o.version,leg,link_id:link.id,evidence:'SIM invite'})).grant;
   await api(buyer,auth+'/accept',{version:o.version,grant_version:grant.version,evidence:'SIM accepted'});
   return {plan,driver,plate,crew_id:crew.id,vehicle_id:vehicle.id,sns:o.sn.split(',').map(s=>s.trim()),evidence:'SIM signed'};
  }
  async function issueStation(p,order,assigned){
    await open(p,order.id);const d=p.locator('dialog[open]').last();
    await d.locator('[data-cmd=station_release]').first().click();
    await d.locator('[name=route_id]').selectOption(assigned.plan.id);
    await d.locator('[name=driver]').selectOption(assigned.driver);
    await d.locator('[name=dispatch_ref]').fill('SIM-'+assigned.driver);
    await d.locator('[type=submit]').click();
    await d.locator('.wf-handoff').waitFor();
    const o=(await api(p,'/api/orders/'+order.id)).order;
    assert.equal(o.station_pending,true);return {...assigned,release_version:o.issue_version,pickup_code:o.pickup_code,version:o.version};
  }
  async function dock(p,id){
    await p.goto(base+'/v12/#gate');await p.reload();
    await p.locator('#dock-order').selectOption(id);await p.locator('#dock-detail .pilot-heading').filter({hasText:id}).waitFor();
  }
  const stationOrder=await order(dispatch),original=await arm(stationOrder,2,'driver',stationOrder.second_leg.executor_id);
  const originalIssue=await issueStation(dispatch,stationOrder,original),oldDriver=await session('driver');
  assert.equal((await api(oldDriver,url)).order.driver,'driver');
  await dock(dispatch,o.id);
  await dispatch.getByText('撤销未执行授权 / 换班').click();
  await dispatch.locator('details form [name=evidence]').fill('旧班组失约，撤销后重选');
  await dispatch.getByRole('button',{name:'撤销并释放原班'}).click();await dispatch.getByText('旧版本和提货号已失效。').waitFor();
  await api(ware,'/api/gate/'+o.id+'/verify',{...originalIssue,version:(await order(ware)).version},true);
  await api(oldDriver,url,null,true);
  const newSup=(await api(buyer,'/api/ops/resources',{type:'supplier',name:'SIM NJ Backup',address:'虚构 NJ 站',ability:'T2',qualification:'S3',evidence:'TEST-CAP'})).resource;
  const sid=newSup.id,day=o.window_end.slice(0,10),old=o.second_leg;
  await api(buyer,'/api/supply/qualify',{supplier_id:sid,executor_id:sid,product:'T2',warehouse_id:old.station_id,zip:o.zip,model:o.model,action:o.level,decision:'Y',insurance_until:day,valid_until:day,evidence:'SIM-BACKUP-CAP'});
  await open(buyer,o.id);const d=buyer.locator('dialog[open]').last();
  await d.locator('[data-cmd=second-leg]').click();
  for(const [k,v] of Object.entries({supplier_id:sid,station_id:old.station_id}))await d.locator('[name="'+k+'"]').selectOption(v);
  for(const [k,v] of Object.entries({executor_id:sid,acceptance_ref:'SIM-ACK',approved_ref:'SIM-BUDGET',quote_ref:'SIM-Q2',amount:'335',valid_until:day,change_reason:'原二程失约',waiver_ref:'SIM-280-WAIVED',storage_cost:'12'}))await d.locator('[name="'+k+'"]').fill(v);
  await d.screenshot({path:path.join(out,'14-station-reaward-form.png')});await d.locator('[type=submit]').click();
  await d.getByText(/二程改派后预算 USD 667/).waitFor({state:'attached'});
  assert.equal((await order(buyer)).approved_cost,667);
  await d.locator('summary').filter({hasText:'放行、派车与站序'}).click();await d.screenshot({path:path.join(out,'14-station-reaward.png')});
  const renewed=await order(dispatch),replacement=await arm(renewed,2,'driver_alt',sid);
  const newIssue=await issueStation(dispatch,renewed,replacement),newDriver=await session('driver_alt');
  assert.equal((await api(newDriver,url)).order.driver,'driver_alt');
  await dock(ware,o.id);
  async function verifyAtDock(p,data){
    const form=p.locator('#dock-detail form').filter({has:p.getByRole('button',{name:'核对并逐台放行'})});
    for(const k of ['pickup_code','release_version','driver','plate','crew_id','vehicle_id','evidence','identity_ref','bol_ref']){
      const field=form.locator('[name='+k+']');
      if(await field.count())await field.fill(String(data[k]||''));
    }
    for(const sn of data.sns)await form.locator('input[name=sn][value='+JSON.stringify(sn)+']').check();
    const wait=p.waitForResponse(r=>r.url().endsWith('/verify'));await form.getByRole('button',{name:'核对并逐台放行'}).click();const response=await wait;if(!response.ok())console.log('dock rejected',response.status(),await response.text());
  }
  await verifyAtDock(ware,originalIssue);await ware.locator('.dock-msg.net-error').waitFor();
  await ware.screenshot({path:path.join(out,'14-old-code-denied.png')});
  await verifyAtDock(ware,newIssue);await ware.getByText(/放行成功/).first().waitFor();
  assert.equal((await order(ware)).status,'last_mile');
  await ware.screenshot({path:path.join(out,'14-backup-handover.png')});
  const p=orders.find(o=>o.pickup);
  await open(ware,p.id);
  const wd=ware.locator('dialog[open]').last();
  await wd.locator('[data-cmd=pickup_gate]').click();
  for(const [k,v] of Object.entries({collector:'SIM Buyer',authority_ref:'SIM-AUTH',vehicle_ref:'SIM-VAN',secure_ref:'SIM-STRAP',door_cm:'210',package_height_cm:'223',gross_kg:'160',payload_kg:'700'}))await wd.locator('[name="'+k+'"]').fill(v);
  await wd.locator('[type=submit]').click();
  await wd.getByText(/F06 仓门禁装/).first().waitFor();
  await wd.screenshot({path:path.join(out,'16-pickup-block.png')});
  const pk=(await api(ware,'/api/orders/'+p.id)).order;assert.equal(pk.status,'exception');assert.equal(pk.custodian,pk.warehouse);
  const admin=await session('admin'),finance=await session('finance');
  const intake=async(mode,level='L1',n=1,addon_l5=false)=>{
   const label=mode+'-'+level,city='Dallas',warehouse='Dallas';
   const o=(await api(dispatch,'/api/orders',{customer:'SIM '+label,address:'SIM test dock',endpoint:'SIM dock A',zip:'75201',model:'M01',quantity:n,warehouse,
      route:'B',level,procurement_mode:mode,addon_l5,city,state:'TX',lat:32.78,lng:-96.80,window_start:day+'T09:00',window_end:day+'T16:00',timezone:'America/Chicago'})).order;
   const sns=[];for(let i=0;i<n;i++){
    const sn='TEST-'+label+'-'+i;sns.push(sn);
    await api(ware,'/api/lifecycle/assets',{action:'receive',sn,warehouse,model:'M01',bin:'SIM A',condition:'OK',batch:'SIM-'+label,evidence:'SIM GRN',state:'available'});
   }
   return (await api(ware,'/api/orders/'+o.id+'/actions',{action:'ready',version:o.version,sn:sns.join(','),release_ref:'TEST-GRN'})).order;
  };
  const caps=async(o,type,action,executorId,qualification='S3')=>{
    const wh=(await api(buyer,'/api/ops/resources')).resources.find(r=>r.type==='warehouse'&&r.name===o.warehouse);
    const r=(await api(buyer,'/api/ops/resources',{type:'supplier',name:'SIM '+type+' '+o.id,address:'SIM site',ability:type,qualification,evidence:'SIM-CRED'})).resource;
    const executor=executorId||r.id;
    await api(buyer,'/api/supply/qualify',{supplier_id:r.id,executor_id:executor,product:type,warehouse_id:wh.id,zip:o.zip,model:o.model,action,decision:'Y',insurance_until:day,valid_until:day,evidence:'SIM-CAP'});return r;
  };
  async function fillForm(form,values){
    for(const [k,v] of Object.entries(values)){
     const loc=form.locator('[name="'+k+'"]');
     if(await loc.evaluate(e=>e.tagName==='SELECT'))await loc.selectOption(String(v));else await loc.fill(String(v));
    }
  }
  async function actionUI(p,o,action,values){
    await open(p,o.id);const d=p.locator('dialog[open]').last();await d.locator('[data-cmd='+action+']').first().click();
    await fillForm(d,values);await d.locator('[type=submit]').click();await d.locator('.wf-handoff').waitFor();
    return (await api(p,'/api/orders/'+o.id)).order;
  }
  const img=await ware.evaluate(()=>{let c=document.createElement('canvas');c.width=200;c.height=60;c.getContext('2d').fillText('SIMULATED HANDOVER',5,32);return c.toDataURL().split(',')[1]});
  const resolvePickup=await api(dispatch,'/api/orders/'+p.id+'/actions',{action:'resolve',version:pk.version,resolution:'SIM replacement truck'});
  let po=await actionUI(ware,p,'pickup_gate',{collector:'SIM Buyer',authority_ref:'SIM-AUTH2',vehicle_ref:'SIM-VAN2',secure_ref:'SIM-STRAP',door_cm:'235',package_height_cm:'223',gross_kg:'160',payload_kg:'700'});
  async function podAndAttempts(pg,o){
   const url='/api/orders/'+o.id;
   if(o.driver)await api(pg,url+'/files',{version:o.version,release_version:0,category:'pod',base64:img,name:'stale.png'},true);
   const saved=await api(pg,url+'/files',{version:o.version,release_version:o.issue_version,category:'pod',base64:img,name:'SIM-pod.png'});
   const f=saved.file.id,request={arrival_local:day+'T11:00',finished_local:day+'T11:20',location:o.endpoint,evidence:'SIM-SIGNED',release_version:o.issue_version,
      units:o.sn.split(',').map(sn=>({sn:sn.trim(),location:o.endpoint,outcome:'success',details:'卸货、交接',pod_id:f}))};
   const attempted=await api(pg,'/api/ops/folder/'+o.id+'/attempts',{version:saved.order.version,...request});return attempted.order;
  }
  po=await podAndAttempts(ware,po);
  const done=await actionUI(ware,po,'pickup',{dispatch_ref:'SIM-AUTH2',approved_cost:'0',signer:'SIM Buyer',delivered_at:day+'T11:25',delivery_note:'仓口签收'});
  assert.equal(done.status,'delivered');assert.equal(done.release_route,undefined);
  async function instruction(pg,o,values){
   await open(pg,o.id);const d=pg.locator('dialog[open]').last();await d.locator('[data-cmd=platform-instruction]').click();
   await fillForm(d,values);await d.locator('[type=submit]').click();await d.locator('.wf-handoff').waitFor();
   return (await api(pg,'/api/orders/'+o.id)).order;
  }
  const checks=Object.fromEntries(['leg','stock','package','vehicle','endpoint','site','authority','window','papers','price','fallback','release'].map(k=>['check_'+k,'SIM CHECK '+k]));
  const completedOrders={};
  for(const mode of ['ltl','platform','brand_fleet']){
   let o=await intake(mode),sid,executor,carrier;
   if(mode==='ltl'){
    const sup=await caps(o,'T1','L1');sid=sup.id;executor=sid;carrier=sup.name;
    const q=(await api(buyer,'/api/ops/resources',{type:'quote',name:'LTL quote',order_id:o.id,carrier,path:o.route,scope:'SIM L1',comparison_ref:'R1',amount:80,origin_cost:0,station_cost:0,delivery_cost:80,special_cost:0,other_cost:0,valid_until:day,evidence:'SIM QUOTE',supplier_id:sid,executor_id:executor,product:'T1',accepted_ref:'SIM reply'})).resource;
    o=(await api(buyer,'/api/ops/award-quote',{id:q.id,version:o.version,quote_version:q.version,approval_ref:'SIM APPROVE'})).order;
   }else if(mode==='platform'){executor=sid='SIM-PLATFORM';carrier='SIM Platform Carrier'}else{executor=sid='SIM-OWN-FLEET';carrier='SIM Brand Fleet'}
   const values={account_ref:'SIM account',instruction_ref:'SIM '+mode,carrier,executor_id:executor,acceptance_ref:'SIM ACK',valid_until:day,
     ...(mode!=='brand_fleet'?{bol_ref:'LTL BOL',pickup_ref:'LTL PICK',identity_ref:'carrier badge'}:{cost_center:'SIM OPS',allocation:'80'})};
   if(mode==='brand_fleet')await api(buyer,'/api/ops/folder/'+o.id+'/platform-instruction',{...values,version:o.version},true);
   o=await instruction(mode!=='brand_fleet'?buyer:admin,o,values);
   let assigned=mode==='brand_fleet'?await arm(o,1,'driver',executor):null;
   o=await actionUI(dispatch,o,'dispatch',{...checks,carrier,approved_cost:'80',dispatch_ref:'SIM '+mode,...(assigned?{route_id:assigned.plan.id,driver:'driver'}:{})});
   await dock(ware,o.id);
   const actual={...(assigned||{}),sns:[o.sn],pickup_code:o.pickup_code,release_version:o.issue_version,evidence:'SIM-'+mode,bol_ref:'LTL BOL',identity_ref:'carrier badge'};
   console.log('checking gate',mode,o.status, o.gate_grant_id);await verifyAtDock(ware,{...actual,...(assigned?{plate:'BAD'}:{bol_ref:'BAD'})});await ware.locator('.dock-msg.net-error').waitFor();
   await verifyAtDock(ware,actual);await ware.getByText(/放行成功/).first().waitFor();
   await ware.screenshot({path:path.join(out,'16-'+mode+'-released.png')});
   o=(await api(dispatch,'/api/orders/'+o.id)).order;assert.equal(o.status,'in_transit');
   const pg=assigned?oldDriver:dispatch;
   o=await podAndAttempts(pg,o);o=await actionUI(pg,o,'deliver',{signer:'SIM Receiver',delivered_at:day+'T11:25',delivery_note:'SIM Delivered'});
   await actionUI(finance,o,'settle',{actual_cost:'80',invoice_ref:assigned?'SIM INTERNAL ALLOCATION':'SIM LTL invoice'});
   completedOrders[mode]=o;
   if(mode==='brand_fleet')assert.equal(o.platform_instruction?.payee_id??(await api(finance,'/api/orders/'+o.id)).order.platform_instruction.payee_id,'INTERNAL');
  }
  const tech=await intake('company','L3',1,true);
  const storage=await caps(tech,'T3','receive');
  await api(buyer,'/api/ops/folder/'+tech.id+'/technical',{version:tech.version,supplier_id:storage.id,executor_id:storage.id,acceptance_ref:'SIM',scope:'启用',amount:120},true);
  await open(buyer,tech.id);
  const td=buyer.locator('dialog[open]').last();await td.locator('[data-cmd=technical]').click();
  await fillForm(td,{supplier_id:storage.id,executor_id:storage.id,scope:'启用',acceptance_ref:'SIM',amount:'120'});
  await td.locator('[type=submit]').click();await td.locator('[role=alert]').getByText(/未书面核准/).waitFor();
  await td.screenshot({path:path.join(out,'16-storage-no-technician.png')});
  // Restore and repair records are independent of the signed transport ticket and invoice.
  const service=await session('service'),machine=completedOrders.platform,remote=completedOrders.ltl;
  async function serviceCase(o,kind,extra={}){
    return (await api(service,'/api/lifecycle/cases',{action:'open',kind,order_id:o.id,sn:o.sn,issue:'SIM test fault',custodian:'SIM receiver',owner:'service',
       next_step:'triage',due:day+'T17:00',evidence:'SIM F07',...extra})).record;
  }
  async function advanceCase(pg,record,to,extra){
   return (await api(pg,'/api/lifecycle/cases',{action:'advance',id:record.id,version:record.version,to,...extra})).record;
  }
  let online=await serviceCase(remote,'restore');
  online=await advanceCase(service,online,'authorized',{strategy:'remote',approval_ref:'SIM-A',next_step:'remote test'});
  await advanceCase(service,online,'closed',{test_result:'recovered online',customer_ref:'SIM accepted',recovered_at:day+'T12:00'});
  const decision=await advanceCase(service,await serviceCase(machine,'restore'),'authorized',{strategy:'machine',approval_ref:'SIM-M',next_step:'bench test'});
  let rma=await serviceCase(machine,'rma',{purpose:'repair',item_type:'machine',reason_ref:decision.id});
  const wh=(await api(ware,'/api/ops/resources')).resources.find(w=>w.type==='warehouse'&&w.name===machine.warehouse);
  rma=await advanceCase(service,rma,'authorized',{approval_ref:'SIM-RMA',return_to:wh.name,receiver_id:wh.id,receiver_acceptance:'SIM receipt-only',protection_ref:'upright pallet',redelivery_ref:'onsite retest',part_ref:machine.sn});
  rma=await advanceCase(service,rma,'shipped',{tracking:'SIM-RETURN',custodian:'SIM TEAM'});
  rma=await advanceCase(ware,rma,'received',{receipt_ref:'SIM-ARRIVED',inspection:'quarantine'});
  async function releaseDialog(){
   await service.goto(base+'/v12/#recovery');await service.reload();
   await service.locator('.lc-rows tr').filter({hasText:rma.id}).locator('[data-show]').click();
   await service.getByRole('button',{name:'返修复测与技术放行'}).click();
   const d=service.locator('dialog[open]').last();
   await fillForm(d,{test_result:'SIM retest OK',release_ref:'SIM-TECH-OK',protection_ref:'SIM packing',return_plan:'return to same endpoint'});
   await d.locator('[type=submit]').click();return d;
  }
  const quarantine=await releaseDialog();await quarantine.locator('[role=alert]').getByText(/保持隔离/).waitFor();
  await quarantine.screenshot({path:path.join(out,'11-warehouse-cannot-release-repair.png')});
  await api(admin,'/api/lifecycle/repair-benches',{warehouse_id:wh.id,model:machine.model,valid_until:day,technician:'service',evidence:'SIM bench grant'});
  const released=await releaseDialog();await released.waitFor({state:'hidden'});
  const assets=(await api(ware,'/api/lifecycle/assets')).records;
  assert.equal(assets.find(x=>x.sn===machine.sn).state,'redelivery_ready');
  assert.equal((await api(service,'/api/lifecycle/cases')).records.find(x=>x.id===decision.id).state,'authorized');
  await api(service,'/api/lifecycle/cases',{action:'advance',id:decision.id,version:decision.version,to:'closed',test_result:'bench only',
    customer_ref:'SIM premature',recovered_at:day+'T12:00'},true);
  await dispatch.goto(base+'/v12/#recovery');await dispatch.reload();
  await dispatch.locator('.lc-rows tr').filter({hasText:rma.id}).locator('[data-show]').click();
  await dispatch.getByRole('button',{name:'批准本台复送'}).click();
  const rf=dispatch.locator('dialog[open]').last();await fillForm(rf,{approval_ref:'SIM-R-REDELIVERY',window_start:day+'T10:30',
    window_end:day+'T15:00',delivery_actions:'原机位交接并调平',procurement_mode:'platform'});
  await rf.getByRole('button',{name:'生成复送任务'}).click();
  await dispatch.locator('.wf-handoff').waitFor();
  const linked=(await api(dispatch,'/api/lifecycle/cases')).records.find(x=>x.id===rma.id);
  let outbound=(await api(dispatch,'/api/orders/'+linked.redelivery_order_id)).order;
  assert.equal(outbound.sn,machine.sn);assert.equal(outbound.endpoint,machine.endpoint);
  const external={account_ref:'SIM-R',instruction_ref:'SIM-R-NETWORK',carrier:'SIM-R Carrier',executor_id:'SIM-R-NET',
    acceptance_ref:'SIM-R-ACK',valid_until:day,bol_ref:'R-BOL',pickup_ref:'R-PICK',identity_ref:'R-ID'};
  outbound=await instruction(buyer,outbound,external);
  outbound=await actionUI(dispatch,outbound,'dispatch',{...checks,carrier:external.carrier,approved_cost:'60',dispatch_ref:'SIM-R-ISSUE'});
  await dock(ware,outbound.id);
  await verifyAtDock(ware,{sns:[outbound.sn],pickup_code:outbound.pickup_code,release_version:outbound.issue_version,
    evidence:'SIM-R-SCAN',bol_ref:'R-BOL',identity_ref:'R-ID'});
  await ware.getByText(/放行成功/).first().waitFor();
  outbound=(await api(dispatch,'/api/orders/'+outbound.id)).order;
  const signed=await podAndAttempts(dispatch,outbound);
  outbound=await actionUI(dispatch,signed,'deliver',{signer:'SIM 客户接收人',delivered_at:day+'T11:25',delivery_note:'原机位复送逐台到位'});
  await service.goto(base+'/v12/#recovery');await service.reload();
  const row=service.locator('.lc-rows tr').filter({hasText:decision.id});await row.locator('[data-work]').click();
  const reconfirm=service.locator('dialog[open]').last();
  await fillForm(reconfirm,{test_result:'原机位复测原故障通过',customer_ref:'SIM-CUSTOMER-RESTORED',recovered_at:day+'T12:00'});
  await reconfirm.locator('[type=submit]').click();await reconfirm.waitFor({state:'hidden'});
  const recovered=(await api(service,'/api/lifecycle/cases')).records.find(x=>x.id===decision.id);
  assert.equal(recovered.state,'closed');assert.equal(recovered.redelivery_order_id,outbound.id);
  await row.locator('[data-show]').click();
  await service.locator('dialog[open]').screenshot({path:path.join(out,'11-redelivered-and-customer-restored.png')});
  console.log('PASS: seven independent role sessions, fleet/LTL to settlement, storage-only T5 denial, pickup signed, stale driver and old code denied, per-SN station intake, forbidden manual carrier, 600-280+335+12=667 re-award, 223cm pickup hold. '+browser.version());
 }finally{if(browser)await browser.close();server.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});







