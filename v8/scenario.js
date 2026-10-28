/* V7 nationwide demonstration. Every facility/customer/team below is synthetic; points are city centres. */
(function(S){
  S.schema=7;
  S.settings.viewZone='local';
  S.settings.businessInstant='2026-10-28T14:00:00Z';
  const warehouseRows=[
    ['WH-CHI','Chicago 中部协同仓','Chicago','IL',41.8781,-87.6298,'America/Chicago'],
    ['WH-DEN','Denver 山地协同仓','Denver','CO',39.7392,-104.9903,'America/Denver'],
    ['WH-PHX','Phoenix 区域协同仓','Phoenix','AZ',33.4484,-112.074,'America/Phoenix'],
    ['WH-SEA','Seattle 西北协同仓','Seattle','WA',47.6062,-122.3321,'America/Los_Angeles']
  ];
  for(const [id,name,city,state,lat,lng,timezone] of warehouseRows)S.warehouses.push({id,name,city,state,lat,lng,timezone,type:'供应商仓示例',capacity:40,used:10,freeDays:14,rate:2});
  S.warehouses.forEach(w=>Object.assign(w,{open:'08:00',close:'17:00',workDays:[1,2,3,4,5],active:!w.type.includes('待验证')}));
  const places=[
    ['Chicago','60601',41.886,-87.622,'IL','WH-CHI','America/Chicago'],
    ['Evanston','60201',42.045,-87.688,'IL','WH-CHI','America/Chicago'],
    ['Naperville','60540',41.75,-88.154,'IL','WH-CHI','America/Chicago'],
    ['Gary','46402',41.593,-87.347,'IN','WH-CHI','America/Chicago'],
    ['South Bend','46601',41.676,-86.252,'IN','WH-CHI','America/Indiana/Indianapolis'],
    ['Milwaukee','53202',43.039,-87.907,'WI','WH-CHI','America/Chicago'],
    ['Denver','80202',39.752,-104.999,'CO','WH-DEN','America/Denver'],
    ['Aurora','80012',39.705,-104.834,'CO','WH-DEN','America/Denver'],
    ['Boulder','80302',40.015,-105.27,'CO','WH-DEN','America/Denver'],
    ['Fort Collins','80521',40.585,-105.084,'CO','WH-DEN','America/Denver'],
    ['Phoenix','85004',33.453,-112.068,'AZ','WH-PHX','America/Phoenix'],
    ['Tempe','85281',33.425,-111.94,'AZ','WH-PHX','America/Phoenix'],
    ['Scottsdale','85251',33.494,-111.926,'AZ','WH-PHX','America/Phoenix'],
    ['Mesa','85201',33.425,-111.831,'AZ','WH-PHX','America/Phoenix'],
    ['Seattle','98101',47.61,-122.335,'WA','WH-SEA','America/Los_Angeles'],
    ['Bellevue','98004',47.61,-122.201,'WA','WH-SEA','America/Los_Angeles'],
    ['Tacoma','98402',47.253,-122.444,'WA','WH-SEA','America/Los_Angeles'],
    ['Everett','98201',47.979,-122.202,'WA','WH-SEA','America/Los_Angeles'],
    ['Pasadena','91101',34.147,-118.144,'CA','WH-LAX','America/Los_Angeles'],
    ['Anaheim','92805',33.835,-117.915,'CA','WH-LAX','America/Los_Angeles'],
    ['Irvine','92612',33.684,-117.827,'CA','WH-LAX','America/Los_Angeles'],
    ['Riverside','92501',33.981,-117.376,'CA','WH-LAX','America/Los_Angeles'],
    ['Brooklyn','11201',40.693,-73.99,'NY','WH-NJ','America/New_York'],
    ['Queens','11101',40.744,-73.949,'NY','WH-NJ','America/New_York'],
    ['Edison','08817',40.519,-74.412,'NJ','WH-NJ','America/New_York'],
    ['Philadelphia','19103',39.952,-75.17,'PA','WH-NJ','America/New_York'],
    ['Frisco','75034',33.151,-96.824,'TX','WH-DFW','America/Chicago'],
    ['McKinney','75069',33.197,-96.615,'TX','WH-DFW','America/Chicago'],
    ['Richardson','75080',32.949,-96.73,'TX','WH-DFW','America/Chicago'],
    ['Lewisville','75057',33.047,-96.994,'TX','WH-DFW','America/Chicago']
  ];
  places.forEach(([city,zip,lat,lng,state,warehouse,timeZone],i)=>{
    const id='H270'+String(i+1).padStart(2,'0'),model='M0'+(i%7+1),endpoint=i%5===0?'L2':'L3',L4=i%13===7,L5=i%7===2;
    const date=i===9||i===17?'2026-10-29':'2026-10-28';
    const o={id,crm:'CRM-DEMO-'+(900+i),customer:`${city} Demo ${i%2?'Workspace':'Market'}`,city,zip,lat,lng,state,model,qty:1,endpoint,path:i%9===7?'C2':'B',L4,L5,stockStrategy:i%8===0?'D':'基础库存',warehouse,timeZone,date,windowStart:i===4?660:540,windowEnd:1020,originalWindow:[540,1020],appointment:i%11===8?'待确认':'已确认',status:'待放行',techStatus:L5?'待技术验收':'未采购',version:1,serviceMins:L4?90:endpoint==='L3'?45:25,checks:{site:i%11!==8,provider:i%11!==8,budget:true,inventory:true,station:i%9!==7},serial:`DEMO-${model}-V7-${i+1}`,notes:city==='South Bend'?'跨时区示例：Chicago出车按CT，South Bend收货按ET，不能直接比较墙上钟时间。':city==='Phoenix'?'亚利桑那州 Phoenix 不使用夏令时；请按IANA时区计算。':'合成订单；城市级定位，不是实际客户地址。',phone:'+120255501'+String(20+i).padStart(2,'0'),consent:true,optedOut:false,notificationOwner:'实际末端商',geocodeStatus:'城市级演示',history:[]};
    o.appointmentVersion=o.appointment==='已确认'?1:null;
    o.firstConfirmedWindow=o.appointment==='已确认'?{date,start:o.windowStart,end:o.windowEnd,timeZone}:null;
    S.orders.push(o);S.inventory.push({serial:o.serial,model,warehouse,status:'锁定',orderId:id,received:'2026-10-20',deadline:'2026-11-02',contract:'DEMO-V7',strategy:o.stockStrategy});
  });
  S.orders.forEach(o=>{o.timezoneSource='演示人工核验';o.contactTimeZone=o.timeZone;o.contactTimezoneSource='合成场景设定，非按地址自动推断';o.geocodeStatus=o.geocodeStatus||'城市级演示';});
  S.suppliers.forEach(s=>{const w=S.warehouses.find(w=>w.city===s.region||(s.region==='DFW'&&w.id==='WH-DFW'));if(w){s.lat=w.lat+.02;s.lng=w.lng+.02;s.timeZone=w.timezone;s.warehouse=w.id;}s.timeZone=s.timeZone||'America/Chicago';s.hours={start:'08:00',end:'17:00'};});
  for(const w of S.warehouses.filter(w=>w.active)){
    const zips=[...new Set(S.orders.filter(o=>o.warehouse===w.id).map(o=>o.zip))];
    if(w.id==='WH-DFW'){S.suppliers.filter(s=>s.region==='DFW').forEach(s=>s.zips=[...new Set([...s.zips,...zips])]);continue;}
    const sid='SP-'+w.id.slice(3);
    S.suppliers.push({id:sid,name:w.city+' Professional Demo Team',role:'实际末端商',actualEntity:w.city+' 演示车组',types:['T2','T3','T4'],region:w.city,warehouse:w.id,lat:w.lat+.025,lng:w.lng+.025,timeZone:w.timezone,hours:{start:'08:00',end:'17:00'},zips,models:S.models.map(m=>m.id),endpoints:['L1','L2','L3'],expiry:'2027-03-31',status:'已核验（演示）',rate:280,ontime:18,total:20,pod:20,damage:0,crew:2,door:240,liftKg:900,liftW:170,liftD:120,insurance:'合成核验记录，非真实承保',subcontract:'实际车组须披露',capacity:16});
    S.vehicles.push({id:'V-'+w.id.slice(3),name:w.city+' 26 ft 示例车组',warehouse:w.id,capacityKg:3000,capacityUnits:8,doorHeight:240,liftKg:900,liftW:170,liftD:120,crew:2,L4:true,shiftMinutes:600,costFixed:260,costKm:1.5,costHour:45});
  }
  S.vehicles.forEach(v=>{v.active=true;v.supplier=v.warehouse==='WH-DFW'?'SP-01':'SP-'+v.warehouse.slice(3);});

  /* Two candidate plans on the first order: one adoptable B plan and one C2 plan
     that stays blocked until the station accepts custody and prices its leg. */
  S.fulfillmentPlans=[{
    id:'PL-DEMO-B',orderId:'H26001',path:'B',name:'专业公司直接配送',version:2,selected:true,
    conditions:'以批准包装、当日现场条件与客户当地收货窗为准；由一家实际末端商全程承接。',
    exclusions:'查验、等待、二次派送、额外搬运与拆包清运按实际条款另核，不视为已含。',
    legs:[{kind:'delivery',name:'末端运输 / 搬运',provider:'Metro Equipment Delivery',contact:'调度台 · +1 202 555 0117（演示）',custodian:'车组自起仓接管至客户签收',handoff:'L3 室内指定位置交付；客户签收影像与 POD 后责任结束',cost:310,quoteRef:'Q-2601-B',validUntil:'2026-11-12',expected:'2026-10-28T09:00',timeZone:'America/Chicago',tracking:'PRO-2601-B',status:'已承接',confirmation:'供应商书面承接 2026-10-26（演示）',receipt:''}]
  },{
    id:'PL-DEMO-C2',orderId:'H26001',path:'C2',name:'区域站点分段采购',version:1,selected:false,
    conditions:'先用 DFW 区域站点接收，再按客户窗口分段派送；站点须书面确认接收与保管。',
    exclusions:'站点保管费按日计；未取得站点接收授权前不得执行第一段。',
    legs:[
      {kind:'trunk',name:'干线：港口 / 起仓至 DFW 站点',provider:'Nationwide Freight Desk',contact:'干线调度 · +1 202 555 0142（演示）',custodian:'Nationwide Freight Desk 实际承运车组',handoff:'DFW 站点月台交接，需站点接收回执',cost:240,quoteRef:'Q-2601-T1',validUntil:'2026-11-05',expected:'2026-10-28T07:30',timeZone:'America/Chicago',tracking:'BOL-2601-T1',status:'已承接',confirmation:'经纪书面指派 2026-10-25（演示）',receipt:'站点月台回执待取得'},
      {kind:'storage',name:'站点接收 / 暂存',provider:'Regional Hub Services',contact:'站点主管 · +1 202 555 0163（演示）',custodian:'Regional Hub Services（DFW 站点）',handoff:'由末端段凭提货单提取，保管责任至装车完成',cost:null,quoteRef:'',validUntil:'',expected:'2026-10-28T08:30',timeZone:'America/Chicago',tracking:'',status:'待承接',confirmation:'',receipt:''},
      {kind:'delivery',name:'末端运输 / 搬运',provider:'Regional Hub Services',contact:'末端调度 · +1 202 555 0164（演示）',custodian:'Regional Hub Services 端到端车组',handoff:'L3 室内指定位置交付；技术服务另由授权方执行',cost:180,quoteRef:'Q-2601-C2B',validUntil:'2026-11-10',expected:'2026-10-28T09:30',timeZone:'America/Chicago',tracking:'',status:'草案',confirmation:'',receipt:''}
    ]
  }];

  /* Two historical SMS records so the ledger and failure handling are visible on
     first open; nothing was actually sent to a phone. */
  S.messages=[
    {id:'SMS-DEMO-1',orderId:'H26002',version:1,template:'T1',key:'H26002|T1|2026-10-28',phone:'+120255501002',owner:'实际末端商',body:'HAHA Delivery H26002: Please call +1 202 555 0199 (demo) to choose an available delivery date and review your site details.',status:'delivered',attempts:1,createdAt:'2026-10-26T15:10:00Z',testAt:'2026-10-26T15:10:00Z',timeZone:'America/Chicago',receivingTimeZone:'America/Chicago',events:[{status:'queued',at:'2026-10-26T15:10:00Z',simulation:true},{status:'delivered',at:'2026-10-26T15:11:00Z',simulation:true}]},
    {id:'SMS-DEMO-2',orderId:'H26004',version:1,template:'T2',key:'H26004|T2|2026-10-28',phone:'+120255501004',owner:'实际末端商',body:'HAHA Delivery H26004: Scheduled for 2026-10-28 10:00–14:00 (America/Chicago). Please call +1 202 555 0199 (demo) to confirm.',status:'failed',attempts:2,createdAt:'2026-10-27T09:05:00Z',testAt:'2026-10-27T09:05:00Z',timeZone:'America/Chicago',receivingTimeZone:'America/Chicago',events:[{status:'queued',at:'2026-10-27T09:05:00Z',simulation:true},{status:'failed',at:'2026-10-27T09:06:00Z',reason:'模拟运营商不可达',simulation:true}]}
  ];
})(window.HH_SEED);
