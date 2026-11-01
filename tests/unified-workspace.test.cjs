'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function boot(seed=new Map()){
 const context={window:{},Intl,Date,JSON,Map,Set,setTimeout,crypto:require('node:crypto').webcrypto,localStorage:{getItem:k=>seed.get(k)||null,setItem:(k,v)=>seed.set(k,v)}};
 vm.runInNewContext(fs.readFileSync('v13/dispatch-workspace.js','utf8'),context);
 return context.window.DispatchWorkspace;
}
const user={username:'dispatch',role:'dispatch'};
test('map/date view filters preserve the explicitly selected batch and version',()=>{
 const W=boot(),a=W.open({user,publicDemo:true});a.selection(['SIM200-001','SIM200-002','SIM200-001']);
 const version=a.state.version,id=a.state.plan_id;
 a.view({day:'2026-11-02',search:'Houston'});
 const b=W.open({user,publicDemo:true});assert.equal(a,b);assert.equal(b.state.version,version);assert.equal(b.state.plan_id,id);
 assert.deepEqual(Array.from(b.state.order_ids),['SIM200-001','SIM200-002']);
});
test('role and environment workspaces are isolated, while a page refresh restores the batch',()=>{
 const storage=new Map(),W=boot(storage),a=W.open({user,publicDemo:true});a.selection(['SIM200-001']);
 assert.equal(W.open({user:{username:'sales',role:'sales'},publicDemo:true}).state.order_ids.length,0);
 assert.equal(W.open({user,demo:true}).state.order_ids.length,0);
 assert.deepEqual(Array.from(boot(storage).open({user,publicDemo:true}).state.order_ids),['SIM200-001']);
});
test('unknown prices and local wall times do not become zero costs or browser-local instants',()=>{
 const W=boot();assert.equal(W.money(null),'费用待齐');assert.equal(W.money(undefined),'费用待齐');
 assert.match(W.money(12345,'USD'),/123\.45/);
 assert.equal(W.time('2026-11-01T01:30','America/Chicago'),'2026-11-01 01:30（原始当地时间）');
 assert.equal(W.day('2026-11-02T02:00:00Z','America/Chicago'),'2026-11-01');
 assert.equal(W.day('2026-11-02T02:00:00Z','Asia/Shanghai'),'2026-11-02');
 assert.equal(W.addDays('2026-11-01',1),'2026-11-02');
});
test('precheck preserves exact selected scope and server diagnostics',async()=>{
 const W=boot(),ctx={user,publicDemo:true},store=W.open(ctx);store.selection(['A','B']);store.state.planning_scope='authorized_stage';
 ctx.api=async(path,{body})=>{assert.equal(path,'/api/ops/plans/precheck');assert.equal(body.planning_scope,'authorized_stage');assert.deepEqual(Array.from(body.order_ids),['A','B']);return {ready_count:1,issues:[{object_id:'B',code:'WINDOW_CONFLICT',message:'窗口不满足',field:'window_end'}]}};
 await store.act(ctx,'precheck');assert.equal(store.state.precheck.ready_count,1);assert.equal(store.state.precheck.issues[0].object_id,'B');assert.equal(store.state.busy,false);
});
test('a delayed solution never replaces a batch modified while computation was running',async()=>{
 const W=boot(),ctx={user,publicDemo:true,orders:[{id:'A',version:1},{id:'B',version:1}]},store=W.open(ctx);store.selection(['A']);
 let resolve;ctx.api=()=>new Promise(r=>resolve=r);const job=store.act(ctx,'optimize');store.selection(['B']);
 resolve({plan:{id:'PLAN-OLD',version:1,order_ids:['A'],candidates:[],routes:[],validation_status:'passed'}});await job;
 assert.deepEqual(Array.from(store.state.order_ids),['B']);assert.notEqual(store.state.plan_id,'PLAN-OLD');assert.match(store.state.error,/迟到结果/);
});
test('local optimization polls persisted jobs and consumes only terminal result plans',async()=>{
 const calls=[],W=boot(),ctx={user,orders:[{id:'A',version:1}]},store=W.open(ctx);store.selection(['A']);
 ctx.api=async(path,options)=>{calls.push(path);if(options?.method==='POST')return {job:{id:'JOB1',state:'queued'}};return {job:{id:'JOB1',state:'completed',result:{plan:{plan_id:'PLAN1',version:1,order_ids:['A'],candidates:[{id:'C1',routes:[],validation_status:'passed'}],validation_status:'passed'}}}};};
 await store.act(ctx,'optimize');assert.deepEqual(calls,['/api/ops/jobs','/api/ops/jobs/JOB1']);assert.equal(store.state.plan_id,'PLAN1');assert.equal(store.state.job_state,'completed');assert.equal(store.state.busy,false);
});
test('changed business versions invalidate the previous plan without removing its evidence',()=>{
 const W=boot(),store=W.open({user});store.update({id:'P1',version:1,order_ids:['A'],candidates:[{id:'C1'}],validation_status:'passed'});store.state.input_versions={A:1};
 store.checkVersions([{id:'A',version:2}]);assert.equal(store.state.validation_status,'stale');assert.equal(store.state.candidates[0].id,'C1');assert.equal(store.state.last_feasible.id,'P1');
});
test('manual route edits are sent through the same optimizer and null-cost candidates remain pending',async()=>{
 const W=boot(),ctx={user,publicDemo:true,orders:[{id:'A',version:1}]},store=W.open(ctx);store.selection(['A']);store.stageRoute({order_ids:['A'],warehouse:'W1',resource_id:'SMALL',stops:{A:{service:50}}},null);
 ctx.api=async(path,{body})=>{assert.equal(body.route_candidates[0].resource_id,'SMALL');assert.equal(body.route_candidates[0].stops.A.service,50);return {plan:{id:'P2',version:1,order_ids:['A'],validation_status:'conditions_pending',candidates:[],draft_routes:[{order_ids:['A'],total_minor:null}]}}};
 await store.act(ctx,'optimize');assert.equal(store.routes().length,0);assert.equal(store.drafts().length,1);assert.equal(store.state.validation_status,'conditions_pending');
});

test('refresh recovery fences old job input after selection changes',async()=>{
 const W=boot(),ctx={user},store=W.open(ctx);store.selection(['A']);store.state.job_id='OLDJOB';store.state.job_state='running';store.state.job_input_key=JSON.stringify([['A'],'delivery_complete','lowest_cost',{},null]);store.selection(['B']);
 ctx.api=async()=>({job:{state:'completed',result:{plan:{id:'OLDPLAN',version:1,order_ids:['A'],candidates:[]}}}});
 await store.resume(ctx);assert.deepEqual(Array.from(store.state.order_ids),['B']);assert.match(store.state.error,/旧输入/);assert.notEqual(store.state.plan_id,'OLDPLAN');
});
test('completion winning a cancel race is displayed as completed, not cancelled',async()=>{
 const W=boot(),ctx={user,api:async()=>({job:{id:'J1',state:'completed'}})},store=W.open(ctx);store.state.job_id='J1';store.state.job_state='running';await store.cancel(ctx);assert.equal(store.state.job_state,'completed');
});
test('ambiguous enqueue retry reuses its idempotency key',async()=>{
 const W=boot(),ctx={user,orders:[{id:'A',version:1}]},store=W.open(ctx),keys=[];store.selection(['A']);let first=true;
 ctx.api=async(path,opts)=>{if(opts?.method==='POST'){keys.push(opts.body.idempotency_key);if(first){first=false;throw Error('response lost')}return {job:{id:'J1',state:'queued'}}}return {job:{id:'J1',state:'completed',result:{plan:{id:'P1',order_ids:['A'],version:1,candidates:[]}}}}};
 await store.act(ctx,'optimize');await store.act(ctx,'optimize');assert.equal(keys.length,2);assert.ok(keys[0]);assert.equal(keys[0],keys[1]);
});
test('nested unassigned diagnostics show the actual field and recovery action',()=>{
 const W=boot(),html=W.issuesHTML([{order_id:'SIM200-009',reasons:[{code:'LOAD_CONFLICT',message:'门宽不足',field:'door_width_cm',next_step:'更换适配车辆'}]}]);
 assert.match(html,/SIM200-009/);assert.match(html,/门宽不足/);assert.match(html,/door_width_cm/);assert.match(html,/更换适配车辆/);assert.doesNotMatch(html,/object Object/);
});
test('adoption completion does not overwrite edits made while it was in flight',async()=>{
 const W=boot(),ctx={user,publicDemo:true},store=W.open(ctx);store.update({id:'P1',version:1,order_ids:['A'],candidates:[{id:'C1',validation_status:'passed'}],validation_status:'passed'});let resolve;ctx.api=()=>new Promise(r=>resolve=r);
 const action=store.act(ctx,'adopt','C1');store.selection(['B']);resolve({plan:{plan_id:'P1',version:2,order_ids:['A'],candidates:[]}});await action;assert.deepEqual(Array.from(store.state.order_ids),['B']);assert.equal(store.state.last_adopted_plan,'P1');
});
test('SIM200 and default demo plans cannot leak into each other',()=>{
 const W=boot();W.open({user,publicDemo:true,dataset:'sim200'}).selection(['SIM200-001']);assert.equal(W.open({user,publicDemo:true,dataset:'default'}).state.order_ids.length,0);
});

test('shared chain timeline contains each physical segment once, receipt dependencies and independent L5 task',()=>{
 const W=boot(),orders=[{id:'A',quantity:1,city:'Customer site',level:'L3',addon_l5:true,timezone:'America/Chicago',window_start:'2030-07-10T09:00',window_end:'2030-07-10T17:00'}];
 const first={id:'FIRST',order_ids:['A'],warehouse:'ORIGIN',first_leg_ids:['A'],stops:{A:{station_id:'STATION',window_start:'2030-07-10T08:00',window_end:'2030-07-10T09:00'}},check_result:{start_utc:'2030-07-10T12:00:00Z',end_utc:'2030-07-10T13:00:00Z',timeline:[{id:'A',arrival:'2030-07-10T12:30:00Z',start:'2030-07-10T12:30:00Z',departure:'2030-07-10T13:00:00Z'}]}};
 const second={id:'SECOND',warehouse:'STATION',order_ids:['A'],resource_id:'VEHICLE-2',crew_id:'CREW-2',check_result:{start_utc:'2030-07-10T14:00:00Z',end_utc:'2030-07-10T15:00:00Z',timeline:[{id:'A',departure:'2030-07-10T15:00:00Z'}]}};
 const chain={id:'CHAIN',order_ids:['A'],segments:[first,second],future_segments:[structuredClone(second)],dependencies:[{order_id:'A',event:'actual_station_receipt',station_id:'STATION',processing_minutes:30,capacity_evidence:'CAPACITY-REF'}],technical_tasks:[{order_id:'A',technician:'TECH-1',start_utc:'2030-07-10T16:00:00Z',end_utc:'2030-07-10T17:00:00Z',authorization_ref:'TECH-AUTH'}]};
 const html=W.timelineHTML(chain,orders,'America/Chicago',true);
 assert.equal(W.routeSegments(chain).length,2);assert.equal(W.routeView(chain).readOnly,true);
 assert.match(html,/到站交接/);assert.match(html,/后程预排/);assert.match(html,/实际到站实收/);assert.match(html,/站内处理 30 分/);
 assert.match(html,/VEHICLE-2/);assert.match(html,/TECH-1/);assert.match(html,/TECH-AUTH/);assert.match(html,/物理签收不代表技术完成/);
 assert.equal((html.match(/第 2 段/g)||[]).length,1);assert.ok(html.indexOf('L5 独立技术预排')>html.indexOf('第 2 段'));
 assert.match(html,/data-act="open" data-id="A"/);assert.doesNotMatch(html,/data-open=/);
});

test('pickup and supplier commitments are read-only without invented vehicle or return stages',()=>{
 const W=boot();
 for(const kind of ['pickup','supplier_commitment']){
  const route={kind,order_ids:['A'],warehouse:'WAREHOUSE',commitment:{authorized_collector:'AUTHORIZED',identity_ref:'ID-REF',acceptance_ref:'ACCEPT',pool_key:'POOL'},check_result:{start_utc:'2030-07-10T10:00:00Z',end_utc:'2030-07-10T11:00:00Z'}};
  assert.equal(W.routeView(route).readOnly,true);
  const html=W.timelineHTML(route,[],'UTC');assert.doesNotMatch(html,/车辆 待核|班组 待核|本段结束 \/ 回程/);
  assert.match(html,kind==='pickup'?/仓口自提 · 无配送车辆/:/具体车辆由承运方确认/);assert.match(html,/逐票 A/);
 }
 assert.equal(W.routeView({order_ids:['A'],resource_id:'V'}).readOnly,false);
 assert.equal(W.routeView({order_ids:['A'],technical_tasks:[{order_id:'A'}]}).readOnly,true);
});

test('native road geometry is retained and stale order/resource/time evidence is explicit',()=>{
 const W=boot(),now=Date.parse('2030-07-10T12:00:00Z'),route={road_basis:'valhalla_truck',order_ids:['A'],order_versions:{A:3},road:{id:'ROAD',geometry:[[32,-96],[33,-97]],legs:[{distance:1000,duration:200}],resources:{V:2},timestamp:'2030-07-10T11:59:00Z'}},ctx={routingEnabled:true,orders:[{id:'A',version:3}],resources:[{id:'V',version:2}]};
 const fresh=W.roadPreview(route,ctx,now);assert.equal(fresh.stale,false);assert.deepEqual(JSON.parse(JSON.stringify(fresh.geometry)),route.road.geometry);assert.equal(fresh.legs[0].duration,200);
 ctx.orders[0].version=4;assert.match(W.roadPreview(route,ctx,now).stale_reason,/订单版本/);ctx.orders[0].version=3;
 ctx.resources[0].version=3;assert.match(W.roadPreview(route,ctx,now).stale_reason,/道路资源版本/);ctx.resources[0].version=2;
 delete route.road.resources;assert.equal(W.roadPreview(route,ctx,now).stale,true);
 route.road.resources={V:2};route.road.timestamp='invalid';assert.match(W.roadPreview(route,ctx,now).stale_reason,/道路时效/);
 assert.equal(W.roadPreview({kind:'pickup'},ctx,now),null);
});

test('shared timeline escapes order, resource and technical references in both surfaces',()=>{
 const W=boot(),r={order_ids:['<unsafe>'],warehouse:'<script>',technical_tasks:[{order_id:'<unsafe>',technician:'<img>',authorization_ref:'<AUTH>'}]};
 const html=W.timelineHTML(r,[],'UTC');assert.doesNotMatch(html,/<script>|<img>|<AUTH>/);assert.match(html,/&lt;AUTH&gt;/);assert.match(html,/data-open="&lt;unsafe&gt;"/);
});
