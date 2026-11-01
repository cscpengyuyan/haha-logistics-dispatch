/* Shared dispatch map. Leaflet and the state boundaries are served by this application. */
(() => {
  'use strict';
  const statusNames = {new:'待核验', ready:'待调度', dispatched:'已派单', in_transit:'在途',at_station:'站点保管',last_mile:'二程运输', delivered:'已签收', settled:'已结算', exception:'异常'};
  const assetBase = new URL('.',document.currentScript?.src || document.baseURI);
  const regions={dfw:['达拉斯 / 沃思堡',32.88,-97.05,8.75],nj:['新泽西 / 纽约',40.70,-74.24,8.75],fife:['Fife / 西雅图',47.35,-122.31,9],la:['洛杉矶',34.03,-118.10,8.5]};
  let offlinePromise, demoPromise, basemapScript;
  function loadBasemap(){
    if(!basemapScript)basemapScript=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=new URL('vendor/basemap/dfw-layer.js',assetBase);
      script.onload=resolve;script.onerror=()=>{basemapScript=null;script.remove();reject(new Error('底图脚本未载入'))};document.head.append(script);
    });
    return basemapScript;
  }
  function demoLegs(){
    if(!demoPromise)demoPromise=fetch(new URL('vendor/dfw-demo-road-legs.json',assetBase),{credentials:'same-origin',redirect:'error'}).then(async res=>{
      if(!res.ok)throw Error();const data=await res.json();
      return {date:data.generated,legs:new Map(data.legs.map(item=>[JSON.stringify([item.start,item.end]),item]))};
    }).catch(err=>{demoPromise=null;throw err;});
    return demoPromise;
  }
  function offlineData(){
    if(!offlinePromise)offlinePromise=fetch(new URL('vendor/us-roads-2025.json',assetBase),{credentials:'same-origin',redirect:'error'}).then(async res=>{
      if(!res.ok)throw Error();const data=await res.json();
      const roads=data.roads.map(([name,kind,encoded])=>{
        let lat=0,lon=0,i=0,south=90,north=-90,west=180,east=-180;
        const points=[];
        const delta=()=>{let shift=0,v=0,c;do{c=encoded.charCodeAt(i++)-63;v|=(c&31)<<shift;shift+=5;}while(c>=32);return (v&1)?~(v>>1):(v>>1);};
        while(i<encoded.length){lat+=delta();lon+=delta();const y=lat/1e4,x=lon/1e4;points.push([y,x]);south=Math.min(south,y);north=Math.max(north,y);west=Math.min(west,x);east=Math.max(east,x);}
        return {name,kind,points,south,north,west,east};
      });
      return {roads,cities:data.cities};
    }).catch(err=>{offlinePromise=null;throw err;});
    return offlinePromise;
  }
  function addGeography(map,data){
    const roads=L.layerGroup().addTo(map), placeLabels=L.layerGroup().addTo(map);
    map.createPane('dispatchRoads').style.zIndex='405';
    map.createPane('dispatchPlaces').style.zIndex='445';
    // One SVG path per road class keeps the layer small and supports synchronous teardown.
    const renderer=L.svg({pane:'dispatchRoads',padding:0.2});
    const draw=()=>{
      const z=map.getZoom(), area=map.getBounds().pad(0.12), chunks=[[],[],[]], badges=[],occupied=[];
      roads.clearLayers();placeLabels.clearLayers();
      for(const r of data.roads){
        if(z<3.25 || (r.kind===0 && z<8) || (r.kind===1 && z<6.5) || r.south>area.getNorth() || r.north<area.getSouth() || r.west>area.getEast() || r.east<area.getWest())continue;
        chunks[r.kind].push(r.points);
        if(z>=7 && r.points.length>=5 && r.kind!==0 && badges.length<300)badges.push(r);
      }
      const styles=[{color:'#cbbfa5',weight:1.3,opacity:.83},{color:'#d39b66',weight:2.3,opacity:.88},{color:'#cc9565',weight:z<5?1.15:2,opacity:z<5?.60:.88}];
      for(let i=0;i<3;i++) if(chunks[i].length)L.polyline(chunks[i],{interactive:false,pane:'dispatchRoads',renderer,...styles[i]}).addTo(roads);
      function place(pos,text,cls,width){
        if(!area.contains(pos))return;
        const xy=map.latLngToContainerPoint(pos), box=[xy.x-3,xy.y-7,xy.x+width,xy.y+8];
        if(occupied.some(a=>a[0]<box[2] && box[0]<a[2] && a[1]<box[3] && box[1]<a[3]))return;
        occupied.push(box);
        L.marker(pos,{pane:'dispatchPlaces',keyboard:false,interactive:false,icon:L.divIcon({className:cls,html:e(text),iconSize:[width,15],iconAnchor:[0,7]})}).addTo(placeLabels);
      }
      for(const [name,y,x,min] of data.cities){if(z>=min)place([y,x],name,'dm-city',Math.ceil(name.length*6.2)+9);}
      const names=new Set();
      for(const r of badges){
        if(names.has(r.name)||names.size>=12)continue;
        const p=r.points[Math.floor(r.points.length/2)], n=occupied.length;place(p,r.name,'dm-highway',Math.ceil(r.name.length*5.6)+10);if(occupied.length>n)names.add(r.name);
      }
    };
    map.on('moveend',draw);draw();
    return ()=>map.off('moveend',draw);
  }
  const zones = ['America/Los_Angeles','America/Phoenix','America/Denver','America/Chicago','America/New_York','America/Anchorage','Pacific/Honolulu'];
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const option = (value,label,selected) => `<option value="${e(value)}" ${String(value)===String(selected)?'selected':''}>${e(label)}</option>`;
  const fmtMi = n => Number.isFinite(n) ? `${n.toLocaleString('en-US',{maximumFractionDigits:1})} mi` : '—';
  const orderCity = o => [o.city,o.state,o.zip].filter(Boolean).join(' ') || '地址待补';
  const orderKey = o => String(o.id);
  const precisionNames={zip:'ZIP 代表点',street:'街址',dock:'已核装卸口',unknown:'定位精度待核'};
  const transitStages=new Set(['in_transit','last_mile']);
  const levels={L1:'基础交接',L2:'指定入口',L3:'室内机位'};
  const locationKey=o=>o?.address && o.zip ? [o.address,o.city,o.state,o.zip].join('|').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim() : '';
  const viaStation = o => ['C1','C2'].includes(o?.route);
  const dispatchOrigin = o => viaStation(o) && o.status==='at_station' ? o.station_name : o.warehouse;
  function position(point) {
    if ([point?.lat,point?.lng].some(x => x == null || String(x).trim() === '')) return null;
    const lat = Number(point.lat), lng = Number(point.lng);
    return Number.isFinite(lat) && Math.abs(lat)<=85 && Number.isFinite(lng) && Math.abs(lng)<=180 && (lat!==0 || lng!==0) ? [lat,lng] : null;
  }
  function miles(a,b) {
    const rad = Math.PI/180;
    const h = Math.sin((b[0]-a[0])*rad/2)**2 + Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin((b[1]-a[1])*rad/2)**2;
    return 7917.5226 * Math.asin(Math.sqrt(Math.min(1,h)));
  }
  const dateFormats = new Map();
  function parts(time, zone) {
    if (!dateFormats.has(zone)) dateFormats.set(zone,new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
    return Object.fromEntries(dateFormats.get(zone).formatToParts(time).map(p=>[p.type,p.value]));
  }
  function localStamp(time, zone) {
    const p=parts(time,zone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  function instant(value,zone) {
    if (!value || !zone) return NaN;
    if (/(Z|[+-]\d\d:\d\d)$/i.test(value)) return Date.parse(value);
    const wall=value.slice(0,16), target=Date.parse(wall+'Z');
    if (!Number.isFinite(target) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(wall)) return NaN;
    // Try both offsets bordering the date. A DST gap or repeated local hour needs dispatcher confirmation.
    try {
      const offsets=new Set([-86400000,86400000].map(delta=>Date.parse(localStamp(target+delta,zone)+'Z')-(target+delta)));
      const candidates=Array.from(offsets,offset=>target-offset).filter(t=>localStamp(t,zone)===wall);
      return candidates.length===1 ? candidates[0] : NaN;
    } catch { return NaN; }
  }
  function clock(time,zone) {
    if (!Number.isFinite(time) || !zone) return '—';
    try { return localStamp(time,zone).slice(5).replace('T',' '); } catch { return '—'; }
  }
  function gate(o,warehouse,allowIncomplete=false) {
    if (!o) return '订单已移除或无权查看';
    if (['ltl','platform'].includes(o.procurement_mode) && o.status!=='at_station') return '第三方承运，仅登记约定交接点';
    if (o.pickup) return '客户自提，无车组配送';
    if (viaStation(o)){
      if(!['ready','at_station'].includes(o.status))return '经站单须在持货仓或已签收站点排线';
      if(o.status==='at_station' && !o.station_name)return '接收站未登记';
    }else if (o.status!=='ready') return statusNames[o.status] || '当前状态不可排';
    if (!allowIncomplete && !position(o)) return '待补交付点坐标';
    if (!dispatchOrigin(o)) return '待补出发仓';
    if (warehouse && dispatchOrigin(o)!==warehouse) return '与批次出发仓不符';
    return '';
  }
  function mount(root, initial) {
    let ctx=initial, map, pins, lines, labels, tile, observer, controller, road=null,demoCache=null,destroyed=false, busy=false, roadBusy=false;
    const cleanups=[];let streetLayer=null,streetBusy=false;
    let records=new Map(), warehouses=[], fleet=[], routes=[], selected=[], focused='', filter='', search='', stateFilter='', warehouse='', vehicle='', routeId='', version=null;
    let name='', notes='', date='', start='08:00', zone='America/Chicago', service=45, message='';
    let costDraft={}, crew='', executor='', routeChecks={}, stopFacts={}, lastCheck=null, drivers=[], grantNote='', pageNo=0, locked='', undoStack=[], splitOut=[];
    const showLayer={orders:true,warehouses:true,route:true,supplier:false,crew:false};
    let capabilities=null,capLoad=null,capError='',capFilter='';
    const maySeeScope=()=>['admin','dispatch','procurement','finance'].includes(ctx.user?.role);
    const keyPrefix='haha-map-v12:'+ctx.user?.username+':';
    function readPref(key,fallback){try{return JSON.parse(localStorage.getItem(keyPrefix+key))??fallback}catch{return fallback}}
    function writePref(key,value){try{localStorage.setItem(keyPrefix+key,JSON.stringify(value))}catch{}}
    function checkpoint(){undoStack.push({ids:[...selected],split:[...splitOut],facts:structuredClone(stopFacts),locked});if(undoStack.length>20)undoStack.shift();lastCheck=null}
    const canEdit=()=>['admin','dispatch'].includes(ctx.user?.role);
    const depot=()=>warehouses.find(x=>x.name===warehouse);
    const byKey=id=>records.get(String(id));
    const all=()=>Array.from(records.values());
    function sync() {
      warehouses=(ctx.resources||[]).filter(r=>r.type==='warehouse');
      records=new Map((ctx.orders||[]).map(o=>{
        if(o.status==='ready'&&viaStation(o)){
          const targetId=o.station_mandate?.station_id||o.second_leg?.station_id;
          const dest=warehouses.find(w=>w.id===targetId);
          return [orderKey(o),{...o,station_target:targetId,lat:dest?.lat,lng:dest?.lng,customer_city:o.city,city:dest?.name||'首程站点待核',zip:dest?.zip,timezone:dest?.timezone,window_start:'',window_end:''}];
        }
        return [orderKey(o),o];
      }));
      fleet=(ctx.resources||[]).filter(r=>['vehicle','crew'].includes(r.type));
      routes=ctx.routes||[];
    }
    sync();
    warehouse=warehouses.find(w=>all().some(o=>o.warehouse===w.name && o.status==='ready'))?.name || warehouses[0]?.name || '';
    zone=depot()?.timezone || zone;
    try { date=localStamp(Date.now(),zone).slice(0,10); } catch {zone='America/Chicago';date=localStamp(Date.now(),zone).slice(0,10);}
    const needsAddress=o=>!position(o)||(!o.station_target && (o.location_precision!=='dock'||!o.coordinate_ref));
    const available=o=>!needsAddress(o)&&!gate(o,'') && warehouses.some(w=>w.name===dispatchOrigin(o)&&position(w));
    function accepts(o,key){
      if(key==='missing')return needsAddress(o);
      if(key==='available')return available(o);
      if(key==='week'){
        const tz=depot()?.timezone||zone,day=localStamp(Date.now(),tz).slice(0,10),start=instant(day+'T00:00',tz);
        const endDay=new Date(Date.parse(day+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
        const end=instant(endDay+'T00:00',tz),from=instant(o.window_start,o.timezone),until=instant(o.window_end,o.timezone);
        return available(o)&&(!warehouse||dispatchOrigin(o)===warehouse)&&from<end&&until>=start;
      }
      if(key==='onroad')return transitStages.has(o.status);
      return !key || key===o.status;
    }
    const visible=()=>all().filter(o=>{
      const haystack=[o.id,o.crm_ref,o.sn,o.model,o.level,o.delivery_actions,o.window_start,o.window_end,o.customer,o.address,o.endpoint,o.city,o.state,o.zip,o.warehouse,o.selected_quote?.carrier,o.release_route?.name,o.release_route?.id].join(' ').toLowerCase();
      return accepts(o,filter) && (!stateFilter || o.state===stateFilter) && (!search || haystack.includes(search.trim().toLowerCase()));
    });
    const field=(title,key,body)=>`<label class="dm-field"><span>${title}</span>${body(key)}</label>`;
    const btn=(act,text,attrs='')=>`<button type="button" data-act="${act}" ${attrs}>${text}</button>`;
    const rowBtn=(act,id,text,attrs='')=>btn(act,text,`data-id="${e(id)}" ${attrs}`);
    const el=key=>root.querySelector('[data-box="'+key+'"]');
    const roadKey=()=>JSON.stringify([warehouse,depot()?.version,date,start,zone,vehicle,crew,executor,service,routeChecks,stopFacts,
      fleet.filter(x=>[crew,vehicle].includes(x.id)).map(x=>[x.id,x.version]),
      selected.map(id=>[id,byKey(id)?.version,position(byKey(id))])]);
    function cachedLegs(){
      if(!demoCache || !selected.length || !(ctx.demo || ctx.publicDemo))return null;
      const pts=[position(depot()),...selected.map(id=>position(byKey(id)))];
      const legs=pts.slice(1).map((to,i)=>demoCache.legs.get(JSON.stringify([pts[i],to])));
      return legs.every(Boolean)?legs:null;
    }
    function showCached(){
      const legs=cachedLegs();if(!legs)return;
      invalidateRoad();road={key:roadKey(),legs,geometry:legs.flatMap(l=>l.geometry),cached:true};
      message='已按演练道路测算，预计时刻使用各站当地时间。';drawMap();plan();
      fit(road.geometry);
    }
    function demoOrders(){
      if(!canEdit() || !demoCache || !(ctx.demo || ctx.publicDemo) || selected.length || routeId)return null;
      const wh=warehouses.find(w=>JSON.stringify(position(w))==='[32.83,-96.91]');
      if(!wh)return null;
      const rows=['[32.778,-96.806]','[32.735,-97.079]'].map(key=>all().find(o=>!gate(o,wh.name) && JSON.stringify(position(o))===key));
      return rows.every(Boolean)?rows:null;
    }
    function invalidateRoad(){if(controller) controller.abort(); controller=null; road=null; roadBusy=false;}
    function eligibleDepot(){return position(depot());}
    function notice(s){message=s; if(ctx.toast) ctx.toast(s);}
    root.innerHTML=`<section class="dm" data-mobile="map">
      <div class="dm-command"><div class="dm-pulse" data-box="metrics"></div><div class="dm-route-head" data-box="trial"></div></div>
      <div class="dm-top"><label class="dm-search"><span aria-hidden="true">⌕</span><input data-field="search" placeholder="搜索单号、SN、ZIP、仓、供应商或路线" aria-label="搜索地图订单"></label>
        <select data-field="filter" aria-label="按任务状态筛选"><option value="">全部任务状态</option><option value="available">可加入批次</option><option value="week">当前仓 · 未来七日原窗</option><option value="onroad">全部在途</option><option value="missing">缺定位</option>${Object.entries(statusNames).map(([v,n])=>option(v,n,'')).join('')}</select>
        <select data-field="stateFilter" aria-label="按州筛选"></select>${btn('fit','定位结果')}${btn('prefs','保存筛选')}${btn('unfilter','重置')}${btn('pool','展开 / 收起订单池')}</div>
      <div class="dm-decision" data-box="decision" aria-live="polite"></div>
      <div class="dm-shortcuts" aria-label="调度区定位">${btn('jumpList','选单')}${btn('jumpMap','看图')}${btn('jumpPlan','站序')}</div>
      <div class="dm-grid"><section class="dm-mapcard"><header><div><small>DISPATCH COVERAGE</small><h3>交付点与仓点</h3></div><div class="dm-actions"><select data-field="region" aria-label="聚焦区域"><option value="">聚焦区域…</option>${Object.entries(regions).map(([k,v])=>option(k,v[0],'')).join('')}</select>${btn('home','回到本仓')}${btn('nation','全美视图')}</div></header>
        <div class="dm-map" data-box="map" aria-label="美国交付点调度地图"></div>
        <footer><span class="dm-legend" aria-label="图层开关">${['warehouses','orders','route'].map((k,i)=>btn('layer',['▣ 仓点','● 订单','➝ 站序'][i],`data-key="${k}" aria-pressed="true"`)).join('')}${maySeeScope()?['supplier','crew'].map((k,i)=>btn('capLayer',['◇ 供应商','◆ 班组'][i],`data-key="${k}" aria-pressed="false"`)).join(''):''}<label>底图 <input data-field="opacity" type="range" min="20" max="100" value="80" aria-label="底图透明度"></label></span><span class="dm-live" data-box="layer"></span><button type="button" data-box="retryMap">重试街道底图</button><span data-box="routeCredit"></span><span data-box="counts"></span></footer><div data-box="capabilities" class="dm-capabilities" hidden></div><div class="dm-routebar" data-box="itinerary"></div></section>
        <section class="dm-queue"><header><div><small>ORDER POOL</small><h3>地图订单池</h3></div><b data-box="total"></b></header><div data-box="list" class="dm-list"></div></section></div>
      <section class="dm-detail" data-box="detail"></section>
      <section class="dm-plan"><header><div><small>MULTI-STOP ROUTE</small><h3>多站排线</h3></div><div class="dm-actions"><select data-field="routeLoad" aria-label="调出共享批次"></select>${btn('clear','新建草案')}</div></header>
       <details class="dm-checks"><summary>车辆、班次及逐段承运依据</summary><div data-box="config" class="dm-config"></div><div data-box="facts"></div></details><div data-box="stops"></div><details class="dm-checks"><summary>同范围路线费用试算</summary><div class="dm-config" data-box="cost"></div><p data-box="costResult" role="status"></p></details><div data-box="save" class="dm-save"></div>
       <p data-box="message" class="dm-msg" role="status"></p></section></section>`;
    function initMap(){
      if (!window.L || !window.US_STATES) {el('map').textContent='地图资源未加载。可继续在订单池查看订单和排线。';return;}
      map=L.map(el('map'),{minZoom:2,maxZoom:18,zoomSnap:0.25,scrollWheelZoom:false,attributionControl:false});
      const attribution=L.control.attribution({position:'bottomright',prefix:false}).addTo(map).addAttribution('Leaflet · 离线州界');
      map.createPane('dispatchPlan').style.zIndex='430';
      const activeStates=new Set(all().map(o=>o.state));
      const states=L.geoJSON(window.US_STATES,{interactive:false,style:f=>({color:'#99b8aa',weight:1,fillColor:activeStates.has(f.properties.abbr)?'#c1d8c3':'#e1e9dc',fillOpacity:1})}).addTo(map);
      labels=L.layerGroup();
      states.eachLayer(layer=>{
        const {abbr}=layer.feature.properties;
        if (!abbr || ['DC','DE','RI','NJ','CT','MA','NH','VT','MD'].includes(abbr)) return;
        L.marker(layer.getBounds().getCenter(),{icon:L.divIcon({className:'dm-state',html:e(abbr),iconSize:[25,12]}),interactive:false,keyboard:false}).addTo(labels);
      });
      const paintLabels=()=>{if(map.getZoom()>=3.4 && map.getZoom()<=6.5) labels.addTo(map);else labels.remove();};
      map.on('zoomend',paintLabels);
      cleanups.push(()=>map.off('zoomend',paintLabels));
      lines=L.layerGroup().addTo(map);pins=L.layerGroup().addTo(map);
      L.control.scale({position:'bottomleft',metric:false,imperial:true,maxWidth:80}).addTo(map);
      if(ctx.tilesEnabled){
        tile=L.tileLayer('map-tiles/{z}/{x}/{y}.png',{maxZoom:18});
        const missingTiles=new Set();
        tile.on('tileerror',({tile:image,coords})=>{
          const key=coords.z+'/'+coords.x+'/'+coords.y;
          missingTiles.add(key);el('layer').textContent='局部瓦片加载失败，其他区域可继续使用';
          if(!image.dataset.retried){
            image.dataset.retried='1';
            const timer=setTimeout(()=>{if(!destroyed && image.isConnected)image.src=tile.getTileUrl(coords)+'?retry=1';},650);
            cleanups.push(()=>clearTimeout(timer));
          }
        });
        tile.on('tileunload',({coords})=>missingTiles.delete(coords.z+'/'+coords.x+'/'+coords.y));
        tile.on('tileload',({coords})=>{missingTiles.delete(coords.z+'/'+coords.x+'/'+coords.y);if(!missingTiles.size)el('layer').textContent='街道底图';});
        tile.addTo(map);
        // Keep interactive geography above roads, clearing the opaque polygon fills.
        tile.on('tileload',()=>{if(map.hasLayer(tile))states.setStyle({fillOpacity:0.08});});
        tile.on('remove',()=>states.setStyle({fillOpacity:1}));
      }
      const coords=[...all().map(position),...warehouses.map(position)].filter(Boolean);
      const view=readPref('view',null);
      if(view && position(view))map.setView([view.lat,view.lng],view.zoom);
      else if(position(depot()))map.setView(position(depot()),10);
      else if(coords.length)fit(coords,8);else nationView();
      map.on('moveend',()=>{const p=map.getCenter();writePref('view',{lat:p.lat,lng:p.lng,zoom:map.getZoom()})});
      map.on('zoomend',drawMap);
      cleanups.push(()=>map.off('zoomend',drawMap));
      offlineData().then(data=>{
        if(!destroyed && map){
          cleanups.push(addGeography(map,data));attribution.addAttribution('道路及地名 U.S. Census 2025');
          if(!ctx.tilesEnabled&&!streetLayer)el('layer').textContent='离线公路与州界';
        }
      }).catch(()=>{if(!destroyed && !ctx.tilesEnabled)el('layer').textContent='离线州界 · 公路图层不可用';});
      function streetMap(){
        if(streetBusy||streetLayer)return;
        streetBusy=true;
        loadBasemap().then(()=>destroyed?null:window.attachDFWBasemap(map,msg=>{
          if(!destroyed)el('layer').textContent=msg;
        },()=>!destroyed)).then(layer=>{
          if(!layer || destroyed)return;streetLayer=layer;cleanups.push(()=>streetLayer.remove());
        }).catch(()=>{if(!destroyed)el('layer').textContent='街道底图未载入，仍可使用州界和主干道';})
          .finally(()=>{streetBusy=false;});
      }
      streetMap();
      const retry=()=>streetLayer?streetLayer.retry():streetMap();
      el('retryMap').onclick=retry;
      let previousWidth=el('map').clientWidth;
      observer=new ResizeObserver(()=>{
        if(!map || destroyed)return;
        const width=el('map').clientWidth;
        if(width===previousWidth)return;
        previousWidth=width;
        map.invalidateSize({animate:false,debounceMoveend:false});
        // Keep the operator's viewport when panels change size.
      });observer.observe(el('map'));
    }
    function nationView(){if(map) map.fitBounds([[24.5,-125],[49.5,-66.5]],{padding:[8,8],animate:false});}
    function fit(points,max=10){if(map && points.length) map.fitBounds(L.latLngBounds(points),{padding:[34,34],maxZoom:max,animate:false});}
    function validRoad(){return road && road.key===roadKey()?road:null;}
    function drawCapabilities(){
      const box=el('capabilities'),active=maySeeScope()&&(showLayer.supplier||showLayer.crew);
      box.hidden=!active;if(!active)return;
      const visibleCards=(capabilities||[]).filter(s=>showLayer[s.kind]),groups=new Map();
      for(const item of visibleCards){
        if(item.located&&!groups.has(item.warehouse_id))groups.set(item.warehouse_id,[]);
        if(item.located)groups.get(item.warehouse_id).push(item);
      }
      box.innerHTML=`<header><b>库址能力 · ${visibleCards.length} 项</b><small>仅标实际起仓；ZIP 为登记适用范围。无定位 ${visibleCards.filter(s=>!s.located).length} 项</small>${capFilter?btn('capAll','显示全部库址'):''}</header>`;
      if(!capabilities){box.append(document.createTextNode(capError||'加载能力登记…'));return}
      const rows=visibleCards.filter(r=>!capFilter||r.warehouse_id===capFilter);
      const list=document.createElement('div');list.className='dm-cap-list';
      list.innerHTML=rows.map(r=>`<div><b>${e(r.kind==='crew'?'◆ 班组':'◇ 供应商')} · ${e(r.name)}</b><span>${e(r.warehouse)} · ${e(r.located?'已定位起仓':'未定位')} · ZIP ${e(r.zip||'待核')}</span><small>${[r.product,r.model,r.action,r.status,r.until&&'至 '+r.until,r.evidence].filter(Boolean).map(e).join(' · ')}</small></div>`).join('')||'<p>当前图层无登记记录。</p>';
      box.append(list);
      if(!map)return;
      for(const [id,rows] of groups){
        const first=rows[0],title=first.warehouse+' · '+rows.length+' 项范围';
        const marker=L.marker([first.lat,first.lng],{zIndexOffset:400,title,icon:L.divIcon({className:'dm-scope-marker',html:'◆ '+rows.length,iconSize:[31,19],iconAnchor:[-11,25]})}).addTo(pins);
        marker.bindTooltip(e(title));marker.on('click',()=>{capFilter=id;drawMap()});
      }
    }
    async function capLayer(b){
      const k=b.dataset.key;showLayer[k]=!showLayer[k];b.setAttribute('aria-pressed',String(showLayer[k]));
      capFilter='';drawMap();await fetchScope();
    }
    async function fetchScope(){
      if(!capabilities&&!capLoad&&(showLayer.supplier||showLayer.crew)){
        capLoad=ctx.api('/api/ops/map-capabilities');try{const r=await capLoad;capabilities=r.sites||[];capError=''}catch(err){capError=err.message||'无法读取范围，请重试'}
        finally{capLoad=null;if(!destroyed)drawMap()}
      }
    }
    function drawMap(){
      el('routeCredit').innerHTML=validRoad()?'线路 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>':'';
      if(!map){drawCapabilities();return}
      pins.clearLayers();lines.clearLayers();drawCapabilities();
      const orders=[...new Map([...visible(),...selected.map(byKey).filter(Boolean)].map(o=>[orderKey(o),o])).values()];
      const points=[...warehouses.filter(w=>showLayer.warehouses&&position(w)).map(w=>({w,p:position(w)})),...orders.filter(o=>showLayer.orders&&position(o)).map(o=>({o,p:position(o)}))];
      const cells=new Map(),radius=map.getZoom()<7?45:17;
      for(const item of points){
        const pixel=map.project(item.p);
        const key=Math.floor(pixel.x/radius)+'/'+Math.floor(pixel.y/radius);
        let group=cells.get(key);
        if(!group){group={items:[]};cells.set(key,group);}
        group.items.push(item);
      }
      for(const {items} of cells.values()){
        const os=items.filter(i=>i.o).map(i=>i.o), ws=items.filter(i=>i.w).map(i=>i.w), pos=items[0].p;
        const chosen=os.filter(o=>selected.includes(orderKey(o))),alerts=os.filter(o=>o.status==='exception');
        const plural=items.length>1,city=ws[0]?.name||os[0]?.city||'订单';
        const title=plural?`${city} · ${ws.length} 仓 / ${os.length} 票${alerts.length?' / 异常 '+alerts.length:''}`:ws[0]?.name||os[0].id;
        const index=chosen.length?selected.indexOf(orderKey(chosen[0]))+1:0;
        let html;
        if(plural){
          html=`<span class="dm-cluster ${alerts.length?'has-alert':''} ${index?'has-stops':''}"><b>${e(city)}</b><span>${ws.length?'▣ '+ws.length+' 仓 ':''}${os.length?'● '+os.length+' 票':''}${alerts.length?' · ⚠ '+alerts.length:''}</span></span>`;
        }else if(ws.length)html=all().some(o=>o.station_target===ws[0].id)?'<i class="dm-station">站</i>':'<i class="dm-warehouse">仓</i>';
        else html=`<i class="dm-pin ${index?'picked':alerts.length?'alert':''} ${focused===orderKey(os[0])?'focus':''}">${index|| (alerts.length?'!':needsAddress(os[0])?'?':'')}</i>`;
        const size=plural?[76,38]:[26,26];
        const marker=L.marker(pos,{zIndexOffset:index?150:0,title,icon:L.divIcon({className:'dm-marker',html,iconSize:size,iconAnchor:[size[0]/2,size[1]/2]})}).addTo(pins);
        marker.bindTooltip(e(title));
        marker.on('click',()=>{
          if(!plural && os.length){focusOrder(orderKey(os[0]),false);return;}
          const different=items.some(({p})=>Math.abs(p[0]-pos[0])+Math.abs(p[1]-pos[1])>0.0002);
          if(plural && different && map.getZoom()<9){fit(items.map(i=>i.p),11);return;}
          const box=document.createElement('div');box.className='dm-pop';
          ws.forEach(w=>{const button=document.createElement('button');button.type='button';button.textContent='▣ '+w.name+' · 库存与装卸口';button.onclick=()=>{map.closePopup();warehouseDetail(w)};box.appendChild(button)});
          for(const item of os){const b=document.createElement('button');b.type='button';b.textContent=`${item.city||''} · ${item.id}`;b.onclick=()=>{map.closePopup();focusOrder(orderKey(item),false);};box.appendChild(b);}
          marker.bindPopup(box).openPopup();
        });
      }
      if(selected.length && eligibleDepot() && selected.every(id=>position(byKey(id)))){
        const r=validRoad();
        if(!showLayer.route)return;const points=r?r.geometry:[eligibleDepot(),...selected.map(id=>position(byKey(id)))];
        L.polyline(points,{pane:'dispatchPlan',interactive:false,color:'#176d60',weight:3.5,opacity:0.92,dashArray:r?null:'7 7'}).addTo(lines);
        if(r && points.length>3){
          for(const fraction of [0.23,0.55,0.81]){
            const idx=Math.min(points.length-2,Math.floor(points.length*fraction));
            const from=map.project(points[idx]),to=map.project(points[idx+1]);
            if(from.equals(to))continue;
            const angle=Math.atan2(to.y-from.y,to.x-from.x)*180/Math.PI;
            L.marker(points[idx],{pane:'dispatchPlan',keyboard:false,interactive:false,
              icon:L.divIcon({className:'dm-direction',html:`<i style="transform:rotate(${angle.toFixed(1)}deg)">➤</i>`,iconSize:[12,12],iconAnchor:[6,6]})}).addTo(lines);
          }
        }
      }else if(!selected.length && byKey(focused)){
        if(!showLayer.route)return;const pts=ticketPoints(byKey(focused));
        if(pts.every(Boolean))L.polyline(pts,{pane:'dispatchPlan',interactive:false,color:'#486b99',weight:3,dashArray:'4 6'}).addTo(lines);
      }
    }
    function ticketPoints(o){
      const points=[position(warehouses.find(w=>w.name===o.warehouse))];
      if(o.pickup)return points;
      if(viaStation(o))points.push(position(warehouses.find(w=>w.name===o.station_name)));
      points.push(position(o));return points;
    }
    function list(){
      const rows=visible(), missing=rows.filter(needsAddress).length;
      const metrics=[['available','可排订单','green'],['onroad','运输在途','blue'],['exception','异常待处理','rust'],['missing','待补定位','gold']];
      el('metrics').innerHTML=metrics.map(([key,label,tone])=>
        btn('slice',`<span><i></i>${label}</span><strong>${all().filter(o=>accepts(o,key)).length}</strong><small>票</small>`,`class="dm-kpi ${tone}" data-slice="${key}" aria-pressed="${filter===key}"`)
      ).join('');
      el('counts').textContent=`${rows.length-missing} 票已核入口 · ${missing} 票待核址`;
      el('total').textContent=rows.length+' 票';pageNo=Math.min(pageNo,Math.max(0,Math.ceil(rows.length/40)-1));
      el('list').innerHTML=rows.length?rows.slice(pageNo*40,(pageNo+1)*40).map(o=>{
        const id=orderKey(o), issue=gate(o,'',true) || (ctx.routingEnabled&&needsAddress(o)?'请先核实装卸入口':'');
        return `<div class="dm-item ${id===focused?'active':''}"><button type="button" class="dm-item-main" data-act="focus" data-id="${e(id)}"><b>${e(o.city||o.customer||'目的地待补')} <em>${e(o.state||'')} ${e(o.zip||'')}</em></b><span>${e(o.model||'型号待补')} × ${e(o.quantity||'—')} 台 · ${e(o.pickup?'客户自提':levels[o.level]||'终点待核')}</span><small>${e(id)} · ${e(o.customer||'客户待补')}</small></button>
          <div class="dm-item-end"><span class="dm-badge ${o.status==='exception'?'warn':''}">${e(needsAddress(o)?'待核址':statusNames[o.status]||o.status)}</span>
            ${canEdit()?rowBtn('toggle',id,selected.includes(id)?'移出':'＋ 排线',issue&&!selected.includes(id)?`disabled title="${e(issue)}"`:''):''}</div></div>`;
      }).join('')+(rows.length>40?`<div class="dm-actions">${btn('prev','上一页',pageNo?'':'disabled')} ${pageNo+1}/${Math.ceil(rows.length/40)} ${btn('next','下一页',(pageNo+1)*40<rows.length?'':'disabled')}</div>`:''):'<p class="dm-empty">当前条件下没有订单。</p>';
    }
    function details(){
      const o=byKey(focused);
      if(!o){el('detail').innerHTML='<strong>单票调度</strong><span>点选地图标记或订单，核对交付点、预约窗和出发仓。</span>';return;}
      const pos=position(o);
      const near=pos?warehouses.filter(position).map(w=>({name:w.name,dist:miles(position(w),pos)})).sort((a,b)=>a.dist-b.dist):[];
      const itinerary=[o.warehouse||'仓点待补',...(viaStation(o)?[o.station_name||'接收站待核']:[]),o.pickup?'授权仓口自提':orderCity(o)].join(' → ');
      const leg=viaStation(o)&&o.status==='at_station'?2:1;
      el('detail').innerHTML=`<div><small>第 ${leg} 运段 · 单票交付 · ${e(o.id)}</small><h3>${e(o.customer||o.city||'交付点')} <span>${e(o.pickup?'授权自提':levels[o.level]||'终点待核')}</span></h3><p>${e(o.route||'')} · ${e(o.model||'机型待补')} × ${e(o.quantity||'—')} 台</p><p>${e(itinerary)}</p><p>定位 · ${e(pos?(precisionNames[o.location_precision]||'定位精度待核'):'未定位')} · ${e(o.endpoint||'待核验')}${o.addon_l4?' · 特殊通道':''}</p></div>
        <div><small>${e(o.sn||'SN 待锁')} · 签发 ${e(o.issue_version?'v'+o.issue_version:'待签')}</small>
        ${o.approved_cost!=null||o.actual_cost!=null?`<p>本票预算 ${e(o.approved_cost??'待核')} / 已结美国段 ${e(o.actual_cost??'待结')} USD</p>`:''}
        <small>收货窗口 · ${e(o.timezone||'时区待核')}</small><p>${e((o.window_start||'未录入').replace('T',' '))} 至 ${e((o.window_end||'未录入').replace('T',' '))}</p>
        <small>${e(pos?'各仓直线参考（库存仍以订单锁定仓为准）':'交付点坐标缺失，需补录定位')}</small><p>${e(near.slice(0,3).map(w=>w.name+' '+fmtMi(w.dist)).join(' / ')||'—')}</p></div>
        <div class="dm-actions">${rowBtn('fitOrder',o.id,'定位运段',ticketPoints(o).every(Boolean)?'':'disabled title="需先补齐各段坐标"')}${rowBtn('open',o.id,'查看订单')}${canEdit()?rowBtn('bindGrant',o.id,'带入本段已接受人车'):''}${canEdit() && o.allowed_actions?.includes('dispatch')?rowBtn('dispatch',o.id,'办理派单','class="dm-primary"'):''}${canEdit() && o.allowed_actions?.includes('station_release')?rowBtn('station_release',o.id,'办理二程放行','class="dm-primary"'):''}</div>`;
    }
    async function warehouseDetail(w){
      const box=el('detail');focused='';box.textContent=w.name+' · 正在读取仓内 SN…';
      try{
        const assets=ctx.user?.role==='driver'||ctx.user?.role==='sales'?[]:(await ctx.api('/api/lifecycle/assets')).records||[];
        if(destroyed||focused)return;
        const stock=assets.filter(a=>a.warehouse===w.name),skus=[...new Set(stock.map(a=>a.model))];
        box.innerHTML=`<div><small>实物仓 · ${e(w.id)}</small><h3>${e(w.name)}</h3><p>${e(w.address||'待核')} · ${e(w.timezone||'时区待核')}</p><small>${e(w.evidence||'装卸口核实依据待补')}</small></div><div>${skus.map(s=>{const rows=stock.filter(x=>x.model===s);return `<p><b>${e(s)}</b>　可发 ${rows.filter(x=>x.state==='available').length}　已锁 ${rows.filter(x=>x.state==='reserved').length}　隔离 ${rows.filter(x=>x.state==='hold').length}</p>`}).join('')||'当前岗位无可见库存明细'}</div>${ctx.user?.role!=='driver'?btn('inventory','查看逐台库存'):''}`;
      }catch(err){box.textContent=w.name+' · '+err.message}
    }
    function focusOrder(id,pan){
      focused=id;list();details();drawMap();const p=position(byKey(id));if(map && pan && p)map.setView(p,Math.max(6,map.getZoom()),{animate:false});
    }
    function config(){
      const zoneOptions=[...new Set([...zones,zone])];
      const disabled=canEdit()?'':'disabled';
      const controls=[
        field('出发仓','warehouse',k=>`<select data-field="${k}" ${disabled}>${option('','选择已登记仓点',warehouse)}${warehouses.map(w=>option(w.name,w.name,warehouse)).join('')}</select>`),
        field('实际执行方 ID','executor',k=>`<input data-field="${k}" value="${e(executor)}" ${disabled}>`),
        field('实名司机','driver',k=>`<select data-field="${k}" ${disabled}>${option('','待指定',routeChecks.driver)}${drivers.map(d=>option(d.username,d.name||d.username,routeChecks.driver)).join('')}</select>`),
        field('执行班组','crew',k=>`<select data-field="${k}" ${disabled}>${option('','待指定',crew)}${fleet.filter(r=>r.type==='crew').map(r=>option(r.id,r.name+' · '+(r.coverage||'覆盖待核'),crew)).join('')}</select>`),
        field('车辆','vehicle',k=>`<select data-field="${k}" ${disabled}>${option('','待指定',vehicle)}${fleet.filter(r=>r.type==='vehicle').map(r=>option(r.id,r.name,vehicle)).join('')}</select>`),
        field('出发日期','date',k=>`<input type="date" data-field="${k}" value="${e(date)}" ${disabled}>`),
        field('当地发车','start',k=>`<input type="time" data-field="${k}" value="${e(start)}" ${disabled}>`),
        field('发仓时区','zone',k=>`<select data-field="${k}" ${disabled}>${zoneOptions.map(z=>option(z,z,zone)).join('')}</select>`),
        field('默认作业分钟 / 站','service',k=>`<input type="number" min="1" max="720" data-field="${k}" value="${e(service)}" ${disabled}>`)
      ];
      const labels={shift_start:'班次开始',shift_end:'班次结束',warehouse_start:'可提开始',warehouse_end:'可提截止',return_min:'回程分钟',handling_ref:'固定/尾板/工具核验',scope_ref:'作业授权依据'};
      for(const [key,label] of Object.entries(labels))controls.push(field(label,key,k=>`<input data-check="${k}" type="${k.endsWith('_start')||k.endsWith('_end')?'datetime-local':k==='return_min'?'number':'text'}" value="${e(routeChecks[k]||'')}" ${disabled}>`));
      el('config').innerHTML=controls.join('');
      const fields={merge_ref:'跨票同停确认凭据（可空）',required_people:'本次所需人数',required_tools:'所需工具代码（逗号分隔）',requires_lift:'需要尾板（yes/no）',travel:'路程分钟',admission:'停车及准入分钟',unload:'开工→卸毕分钟',service:'开工→完工离场分钟',site_end:'物业最晚开工',finish_by:'合同最晚完工（有要求时填）',height:'包装高 cm',kg:'每台毛重 kg',length_cm:'直立不叠放 · 托盘长 cm',width_cm:'托盘宽 cm',road_ref:'卡车路段依据',dock_ref:'装卸点核实凭据',package_ref:'包装版本凭据'};
      el('facts').innerHTML=selected.map((id,i)=>`<fieldset><legend>第 ${stopNumber(i)} 站 · ${e(id)} · ${e(byKey(id)?.city)}</legend><div class="dm-config">${Object.entries(byKey(id)?.station_target?{window_start:'站方接收窗起',window_end:'站方最晚开工',...fields}:fields).map(([k,label])=>field(label,k,()=>`<input data-leg="${e(id)}" data-prop="${k}" type="${['site_end','finish_by','window_start','window_end'].includes(k)?'datetime-local':['travel','admission','service','height','length_cm','width_cm','kg','unload'].includes(k)?'number':'text'}" value="${e(stopFacts[id]?.[k]??'')}" ${disabled}>`)).join('')}</div></fieldset>`).join('');
      root.querySelector('[data-field="routeLoad"]').innerHTML=option('','调出已存草案…',routeId)+routes.map(r=>option(r.id,r.name+' · '+r.date+' · '+(r.phase||'草案'),routeId)).join('');
      root.querySelector('[data-field="stateFilter"]').innerHTML=option('','全部州',stateFilter)+[...new Set(all().map(o=>o.state).filter(Boolean))].sort().map(s=>option(s,s,stateFilter)).join('');
    }
    const costLabels={original:'原线全价',transport:'新线运输',extra:'附加服务',coordination:'新增协调',incentive:'激励人工'};
    function costResult(){
      const keys=Object.keys(costLabels),ok=keys.every(k=>costDraft[k]!=null&&costDraft[k]!==''&&Number.isFinite(Number(costDraft[k]))&&Number(costDraft[k])>=0);
      const cents=k=>Math.round(Number(costDraft[k])*100),candidate=keys.slice(1).reduce((n,k)=>n+cents(k),0);
      el('costResult').textContent=ok?'原线 $'+(cents('original')/100).toFixed(2)+' · 新线 $'+(candidate/100).toFixed(2)+' · '+(candidate>=cents('original')?'按试算保留原线':'候选较低，须另核覆盖、原窗及同范围书面回价')+'。不计财务实绩。':'录入两条同范围全价及新增费用。核定基线请到原单比价。';
    }
    function costs(){
      el('cost').innerHTML=Object.entries(costLabels).map(([k,v])=>field(v+' USD',k,()=>`<input data-cost="${k}" type="number" step=".01" min="0" value="${e(costDraft[k]??'')}" ${canEdit()?'':'disabled'}>`)).join('');
      costResult();
    }
    function sameStop(i){
      if(i<1)return false;
      const a=byKey(selected[i-1]),b=byKey(selected[i]),x=stopFacts[a?.id]||{},y=stopFacts[b?.id]||{};
      return a&&b&&!a.station_target&&!b.station_target&&dispatchOrigin(a)===dispatchOrigin(b)&&position(a)&&position(b)&&a.lat===b.lat&&a.lng===b.lng&&
        ['customer','contact','address','state','city','zip','endpoint','window_start','window_end','timezone'].every(k=>a[k]&&a[k]===b[k])&&['original_window_start','original_window_end','original_timezone'].every(k=>a[k]===b[k])&&x.dock_ref&&x.dock_ref===y.dock_ref&&(x.site_end||'')===(y.site_end||'');
    }
    function grouped(i){const x=stopFacts[selected[i]];return !!(i&&x?.merge_ref&&x.merge_after===selected[i-1]&&sameStop(i))}
    function stopNumber(i){return selected.slice(0,i+1).reduce((n,_,j)=>n+(grouped(j)?0:1),0)}
    function plan(){
      const d=depot(), r=validRoad(), rows=[], problems=[], totalUnits=selected.reduce((sum,id)=>sum+(Number(byKey(id)?.quantity)||0),0);
      let prev=position(d), cursor=instant(date+'T'+start,zone), totalDistance=0, complete=Boolean(prev), warnings=0;
      if(!prev)problems.push('请选择有经纬度的出发仓');
      if(!Number.isFinite(cursor))problems.push('发仓时间无效或处于夏令时切换的重复/跳过时段');
      if(!(Number(service)>=1&&Number.isInteger(Number(service))&&Number(service)<=720))problems.push('默认作业时长应为 1–720 整分钟');
      const resource=fleet.find(x=>String(x.id)===vehicle), cap=Number(resource?.capacity_units);
      if(cap>0 && totalUnits>cap)problems.push(`装载 ${totalUnits} 台，超过车组上限 ${cap} 台`);
      let remainingKg=selected.reduce((sum,id)=>sum+Number(stopFacts[id]?.kg)*Number(byKey(id)?.quantity),0);
      selected.forEach((id,i)=>{
        const o=byKey(id), p=position(o), reason=gate(o,warehouse);
        if(reason)problems.push(`${id} · ${reason}`);
        let distance, transit;
        if(r){distance=r.legs[i].distance/1609.344;transit=r.legs[i].duration/60;}
        else if(prev && p){distance=miles(prev,p);}
        if(Number.isFinite(distance))totalDistance+=distance;else complete=false;
        const f=stopFacts[id]||{}, from=i?selected[i-1]:depot()?.id;
        const manual=f.from_id===from && f.road_ref && f.travel!=='' && Number.isFinite(Number(f.travel));
        const joined=grouped(i);if(joined)transit=0;else if(!r && manual && !/^[a-f0-9]{32}$/.test(f.road_ref))transit=Number(f.travel);
        if(f.merge_after&&!joined)problems.push('同停确认失效，重核收货方、原窗及装卸点');
        if(!r&&!manual&&!joined)problems.push('第 '+stopNumber(i)+' 站待承运方证实行车时间');
        const arrival=cursor+transit*60000, ws=instant(o?.station_target?f.window_start:o?.window_start,o?.timezone), we=Math.min(instant(o?.station_target?f.window_end:o?.window_end,o?.timezone),f.site_end?instant(f.site_end,o?.timezone):Infinity);
        const validWindow=Number.isFinite(ws) && we>ws;
        const admit=arrival+(joined?0:Number(f.admission||0))*60000;const enter=validWindow?Math.max(admit,ws):admit;
        const job=Number(f.service)||Number(o?.service_minutes)||Number(service);
        const exit=enter+job*60000;
        const cutoff=f.finish_by?instant(f.finish_by,o?.timezone):Infinity;
        const late=validWindow && Number.isFinite(exit)?Math.max(0,Math.ceil((enter-we)/60000),Math.ceil((exit-cutoff)/60000)):0;
        const wait=validWindow?Math.max(0,Math.ceil((ws-arrival)/60000)):0;
        const warn=reason || (!validWindow?'预约窗 / 时区待核':(!Number.isFinite(arrival)?'时间待核':late?`超窗 ${late} 分钟`:wait?`候场 ${wait} 分钟`:'预计窗内完成'));
        if(late)problems.unshift('第 '+stopNumber(i)+' 站超窗 '+late+' 分钟');
        if(reason || !validWindow || !Number.isFinite(arrival) || late)warnings++;
        remainingKg-=Number(f.kg)*Number(o?.quantity);
        rows.push(`<li draggable="${canEdit()}" data-stop="${e(id)}"><b class="dm-num">${stopNumber(i)}</b><div><button type="button" data-act="focus" data-id="${e(id)}" class="dm-link">${e(id)}</button> <b>${e(o?orderCity(o):'订单不可用')}</b><small>${e(o?.timezone||'时区待核')} · 预约 ${e((o?.window_start||'—').slice(5).replace('T',' '))} – ${e((o?.window_end||'—').slice(5).replace('T',' '))}</small></div>
          <div><b>${e(fmtMi(distance))} · 行驶 ${Number.isFinite(transit)?Math.ceil(transit):'—'} / 作业 ${e(job)} 分钟</b><small>卸毕后在车 ${Number.isFinite(remainingKg)?Math.round(remainingKg)+' kg':'待核'}</small><small>到场 ${e(clock(arrival,o?.timezone))} / 开工 ${e(clock(enter,o?.timezone))} / 离场 ${e(clock(exit,o?.timezone))}</small></div>
          <span class="dm-badge ${reason||!validWindow||late||!Number.isFinite(arrival)?'warn':''}">${e(warn)}</span>
          ${canEdit()?`<div class="dm-actions">${(sameStop(i)||f.merge_after)?rowBtn('mergeStop',id,f.merge_after?'取消同停':'确认同停'):''}${rowBtn('lock',id,locked===id?'解锁':'锁站')}${rowBtn('up',id,'↑',`aria-label="上移 ${e(id)}" ${i===0?'disabled':''}`)}${rowBtn('down',id,'↓',`aria-label="下移 ${e(id)}" ${i===selected.length-1?'disabled':''}`)}${rowBtn('toggle',id,'移出')}</div>`:''}</li>`);
        cursor=exit;prev=p;
      });
      const elapsed=(cursor-instant(date+'T'+start,zone))/60000;
      el('stops').innerHTML=`<div class="dm-summary"><b>${selected.length} 票 / ${totalUnits} 台</b><span>${r?'路网里程':'直线合计'} <strong>${complete?e(fmtMi(totalDistance)):'—'}</strong></span><span>含作业 / 等待 ${Number.isFinite(elapsed)?Math.ceil(elapsed)+' 分钟':'—'}</span><span>${warnings} 票待复核</span><div class="dm-actions">
        ${btn('fitPlan','查看全线',selected.length&&complete?'':'disabled')}
        ${cachedLegs()?btn('cached','按演练路网测算'):''}
        ${canEdit()?btn('roads',roadBusy?'计算中…':'规划货车路线',ctx.routingEnabled&&!roadBusy&&selected.length&&complete?'class="dm-primary"':'disabled')+
          btn('orderedRoad','按当前站序重算',ctx.routingEnabled&&!roadBusy&&selected.length&&complete?'':'disabled'):''}</div></div>
        ${rows.length?`<ol class="dm-stops">${rows.join('')}</ol>`:'<div class="dm-empty">从订单池选择同一出发点的待调度订单。经站单完成入站交接后，可由接收站排第二程。</div>'}
        <p class="dm-note">${r?(r.cached?`实线为 ${e(demoCache?.date||'保存时')} 的 Dallas 演练路网。按道路等级和限速估时，已计单行，未计转向限制、实时车况或卡车净高。道路数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>。`:'实线为已计算的货车道路。OSM 未记录的施工和限行须由车组复核。'):'虚线只表示站点关系。道路里程和行驶时长待计算。'} ${r?.source?e(r.source)+' · '+e(r.timestamp)+(r.stale?' · 历史计划，须重算':''):''} 地图范围：美国。货车路网：${ctx.routingEnabled?'已配置，覆盖 '+e(ctx.roadCoverage||'由运营方登记'):'未配置'}。预约按收货地时区核算。</p>`;
      if(selected.length && (!r || r.cached || r.stale))problems.unshift('须取得当前货车路网结果才能按地图派车');
      renderDecision(problems);
      el('save').innerHTML=canEdit()?`${field('批次名称','name',k=>`<input maxlength="100" data-field="${k}" placeholder="如：达拉斯周一上午线" value="${e(name)}">`)}${field('交班备注','notes',k=>`<input maxlength="500" data-field="${k}" placeholder="车组、预约或限行待核事项" value="${e(notes)}">`)}
        ${btn('save',busy?'保存中…':routeId?'更新排线草案':'保存排线草案',`class="dm-primary" ${busy||!selected.length?'disabled':''}`)}`: '<p class="dm-note">当前岗位可查阅已保存批次。调度岗负责排线和派单。</p>';
      el('message').textContent=[...new Set([...(selected.length?problems:[]),message].filter(Boolean))].join(' · ');
      const stops=selected.map(byKey).filter(Boolean);
      const sameSite=new Map();
      for(const o of stops){const key=locationKey(o);if(key)sameSite.set(key,(sameSite.get(key)||0)+1);}
      const shared=[...sameSite.values()].filter(n=>n>1).length;
      el('trial').innerHTML=ctx.demo && !ctx.publicDemo && canEdit() && !selected.length?
        `<div><small>DALLAS · 路线演练</small><b>一仓三站 · 已配车组和预约窗</b></div>${btn('truckDemo','装入达拉斯三站','class="dm-primary"')}`:demoOrders()?`<div><small>DALLAS · 路网演练</small><b>一仓两站，检查预约窗</b></div>${btn('sample','试排 Dallas 双站','class="dm-primary"')}`:
        `<div><small>MULTI-STOP · 当前批次</small><b>${selected.length?e(warehouse)+' · '+selected.length+' 票 / '+totalUnits+' 台':'按同仓、约窗与交接位置排线'}</b></div>${btn('jumpPlan',selected.length?'查看排线 ↓':'打开排线 ↓','class="dm-jump"')}`;
      el('itinerary').innerHTML=stops.length?`<div class="dm-flow-label"><b>计划站序</b><small>${r?'公路参考':'直线参考'} · ${complete?e(fmtMi(totalDistance)):'—'}</small></div><div class="dm-flow"><span class="dm-from">▣ ${e(warehouse)}</span>${stops.map((o,i)=>rowBtn('focus',o.id,`<i>${stopNumber(i)}</i>${e(o.city||o.zip)}<small>× ${e(o.quantity)} 台</small>`)).join('')}</div><p class="dm-group-note">${shared?'发现 '+shared+' 处跨票同址。收货方、原窗和同一装卸口一致时可登记确认同停。各票作业与 SN 分开记录。':stops.some(o=>o.quantity>1)?'含同址多台订单。台数计入装载，逐票核对卸货与摆位时长。':''}</p>`:
        '<span class="dm-route-hint"><b>排线起点</b> 点选城市标记下钻，或在订单池中点「＋ 排线」。</span>';
    }
    function paint(){config();list();details();plan();costs();drawMap();}
    function reset(){
      selected=[];costDraft={};grantNote='';routeChecks={};stopFacts={};crew='';executor='';lastCheck=null;undoStack=[];splitOut=[];locked='';routeId='';version=null;name='';notes='';message='';vehicle='';invalidateRoad();
    }
    function toggle(id){
      checkpoint();if(selected.includes(id)){selected=selected.filter(x=>x!==id);}
      else{
        const o=byKey(id);const why=gate(o,selected.length?warehouse:'',true) || (ctx.routingEnabled&&needsAddress(o)?'请先核实装卸入口':'');
        if(why){notice(why);plan();return;}
        if(!selected.length){
          warehouse=dispatchOrigin(o);zone=depot()?.timezone || zone;date=o.window_start?.slice(0,10) || date;
        }
        if(o.station_target)stopFacts[id]={...stopFacts[id],station_id:o.station_target,timezone:o.timezone};
        selected.push(id);
      }
      invalidateRoad();message='';paint();
    }
    function planPayload(){
      return {warehouse,date,resource_id:vehicle,crew_id:crew,executor_id:executor,
        checks:routeChecks,stops:stopFacts,start_time:start,timezone:zone,service_minutes:Number(service),
        order_ids:selected.slice(),order_versions:Object.fromEntries(selected.map(id=>[id,byKey(id)?.version]))};
    }
    async function roads(optimize){
      if(!ctx.routingEnabled || roadBusy || !selected.length || !canEdit())return;
      if(locked && optimize){notice('有锁定站，请按当前站序重算或先解锁');return}
      const previous=validRoad();
      invalidateRoad();lastCheck=null;roadBusy=true;
      const key=roadKey(), req=new AbortController();controller=req;plan();
      try{
        const {road:found}=await ctx.api('/api/road/plan',{method:'POST',signal:req.signal,body:{...planPayload(),optimize}});
        if(destroyed||controller!==req||roadKey()!==key)return;
        checkpoint();selected=found.order_ids;
        splitOut.push(...found.unassigned);
        road={...found,key:roadKey()};
        notice(found.unassigned.length?'以下票未分配，请核对车容、班次、技能和约窗：'+found.unassigned.join('、'):'已取得逐段货车路线，请核验装卸与司机授权后保存。');
        config();list();fit(road.geometry,15);
      }catch(err){if(!destroyed && controller===req){
        if(previous?.id && previous.key===roadKey())road={...previous,stale:true};
        notice((err.message||'道路服务暂不可用')+'。草案已保留，可重试。');
      }}
      finally{if(!destroyed && controller===req){controller=null;roadBusy=false;drawMap();plan();}}
    }
    function loadRoute(id){
      const r=routes.find(x=>String(x.id)===String(id));if(!r)return;
      invalidateRoad();routeId=String(r.id);version=r.version;name=r.name;warehouse=r.warehouse;date=r.date;vehicle=String(r.resource_id??'');notes=r.notes||'';
      start=r.start_time||'08:00';zone=r.timezone||depot()?.timezone||'America/Chicago';service=r.service_minutes||45;
      selected=(r.order_ids||[]).map(String);costDraft=structuredClone(r.cost_scenario||{});crew=r.crew_id||'';executor=r.executor_id||'';routeChecks=structuredClone(r.checks||{});stopFacts=structuredClone(r.stops||{});lastCheck=r.check_result;
      const changed=selected.filter(id=>r.order_versions?.[id]!=null && r.order_versions[id]!==byKey(id)?.version);
      const hints=changed.length?['保存后订单已变更，请核对新版窗口与派单条件：'+changed.join('、')]:['已调出共享草案，时窗与停靠状态按当前订单重新核算。'];
      if(r.road_basis==='valhalla_truck' && r.road?.geometry){
        const resourceVersions=new Map((ctx.resources||[]).map(x=>[x.id,x.version]));
        const stale=changed.length || !ctx.routingEnabled || Object.entries(r.road.resources).some(([id,v])=>resourceVersions.get(id)!==v) || Date.now()-Date.parse(r.road.timestamp)>3600000;
        road={...r.road,key:roadKey(),stale};
        if(stale){lastCheck=null;hints.push('历史路线仅供查阅，须按当前输入重算。')}
      }else if(r.road_basis==='demo_cache'){
        const legs=cachedLegs();
        if(legs)road={key:roadKey(),legs,geometry:legs.flatMap(l=>l.geometry),cached:true};
        else hints.push('原草案使用演练路网，当前坐标或环境未命中，显示直线估算。');
      }else if(r.road_basis==='private_osrm')hints.push('原草案为历史驾车参考，请重新规划货车路线。');
      message=hints.join(' ');paint();
      const points=[eligibleDepot(),...selected.map(id=>position(byKey(id)))].filter(Boolean);if(points.length)fit(points);
    }
    async function save(){
      if(busy || !canEdit() || typeof ctx.saveRoute!=='function')return;
      if(!name.trim()){notice('请先填写批次名称。');plan();root.querySelector('[data-field="name"]').focus();return;}
      busy=true;plan();const panel=root.querySelector('.dm');panel.inert=true;panel.setAttribute('aria-busy','true');
      const order_versions=Object.fromEntries(selected.map(id=>[id,byKey(id)?.version]));
      const r=validRoad(),road_basis=r&&!r.stale?(r.cached?'demo_cache':'valhalla_truck'):'estimate';
      const payload={name:name.trim(),warehouse,date,resource_id:vehicle||'',order_ids:selected.slice(),order_versions,notes,cost_scenario:costDraft,crew_id:crew,executor_id:executor,checks:routeChecks,stops:stopFacts,start_time:start,timezone:zone,service_minutes:Number(service),road_basis,road_id:r?.id};
      if(routeId){payload.id=routeId;payload.version=version;}
      try{
        const result=await ctx.saveRoute(payload), saved=result?.route||result;
        if(destroyed)return;
        if(!saved?.id)throw Error('服务端未返回保存凭证');
        routeId=String(saved.id);version=saved.version;
        routes=[...routes.filter(x=>String(x.id)!==routeId),saved];
        lastCheck=saved.check_result;notice(lastCheck?.issues?.length?'草案已保存，请补齐核验项。':'草案已核可行，请到原单 F04 签发。');
      }catch(err){if(!destroyed)notice(err.message||'保存失败，请刷新复核后重试。');}
      finally{busy=false;panel.inert=false;panel.removeAttribute('aria-busy');if(!destroyed)paint();}
    }
    function renderDecision(problems){
      const issues=[...new Set([...(problems||[]),...(lastCheck?.issues||[])])];
      if(selected.length&&(!vehicle||!crew||!routeChecks.driver))issues.push('车辆、班组及司机须完整');
      const trouble=issues.length>0;
      el('decision').innerHTML=selected.length?`<div><small>ROUTE CONTROL · ${stopNumber(selected.length-1)} 站 · ${selected.length} 票 / ${selected.reduce((n,id)=>n+(byKey(id)?.quantity||0),0)} 台</small><strong>${trouble?'⚠ '+e(issues[0]):lastCheck?'已核可行 · 到原单 F04 签发':'草案 · 待服务端复核'}</strong><small>${e(issues.slice(1,3).join(' · ')||'原单签发将再次核验库存、授权及时段占用')}${splitOut.length?' · 已拆出 '+splitOut.length+' 票待另排':''}</small></div><div class="dm-actions">${btn('jumpPlan','核对排线')}${canEdit()?btn('split','拆出末站',selected.length<2?'disabled':'')+btn('undo','撤销',undoStack.length?'':'disabled'):''}${lastCheck&&!trouble&&canEdit()?rowBtn(byKey(selected[0])?.status==='at_station'?'station_release':'dispatch',selected[0],'原单签发'):''}</div>`:
      '<div><small>ROUTE CONTROL</small><strong>当班排线</strong><small>选择仓点与订单，核对装卸口及硬窗后签发。</small></div>';
      if(grantNote){const note=document.createElement('small');note.className='dm-grant-note';note.textContent=grantNote;el('decision').append(note)}
      el('decision').classList.toggle('has-conflict',selected.length>0&&trouble);
    }
    async function bindGrant(id){
      const o=byKey(id);if(!o||!canEdit())return;
      try{
        const {grant:g,leg}=await ctx.api('/api/gate/'+encodeURIComponent(id));
        if(destroyed)return;
        if(!g||g.state!=='accepted'){grantNote='本段尚无已接受的人车授权，请到仓口验放核对。';plan();return}
        if(!selected.includes(id))toggle(id);
        if(!selected.includes(id))return;
        crew=g.crew_id;vehicle=g.vehicle_id;executor=g.executor_id;routeChecks.driver=g.driver;lastCheck=null;
        grantNote='第 '+leg+' 段 · '+g.executor_id+' / '+(g.plate||'')+' / '+g.driver+' · 授权 '+g.id;
        paint();
      }catch(err){notice(err.message||'无法读取本段授权');plan()}
    }
    function click(ev){
      const b=ev.target.closest('[data-act]');if(!b || !root.contains(b) || b.disabled || busy)return;
      const id=b.dataset.id, a=b.dataset.act;
      if(a==='capLayer'){capLayer(b);return}
      if(a==='capAll'){capFilter='';drawMap();return}
      if(a==='mergeStop'&&canEdit()){
        const i=selected.indexOf(id),s=stopFacts[id]||{};
        if(!s.merge_after&&(!sameStop(i)||!s.merge_ref?.trim())){notice('请核齐相邻两票的收货方、原窗、坐标及装卸口依据，并填写跨票同停确认凭据。');plan();return}
        checkpoint();s.merge_after=s.merge_after?'':selected[i-1];stopFacts[id]=s;paint();return
      }
      if(a==='truckDemo'){
        b.disabled=true;
        ctx.api('/api/road/practice',{method:'POST',body:{}}).then(async result=>{
          await ctx.refresh();if(destroyed)return;loadRoute(result.route_id);
          notice('三个模拟停靠点已带入，点击「规划货车路线」。');plan();
        }).catch(err=>{notice(err.message);b.disabled=false});
        return;
      }
      if(a==='inventory'){ctx.navigate?.('inventory');return}
      if(a==='bindGrant'){bindGrant(id);return}
      if(a==='prev'||a==='next'){pageNo=Math.max(0,pageNo+(a==='next'?1:-1));list();return}
      if(a==='prefs'){writePref('filters',{filter,search,stateFilter});notice('已保存当前账号的筛选');return}
      if(a==='unfilter'){filter='';stateFilter='';search='';pageNo=0;writePref('filters',{});root.querySelector('[data-field=filter]').value='';root.querySelector('[data-field=search]').value='';paint();return}
      if(a==='pool'){root.querySelector('.dm-grid').classList.toggle('hide-pool');return}
      if(a==='layer'){const k=b.dataset.key;showLayer[k]=!showLayer[k];b.setAttribute('aria-pressed',String(showLayer[k]));drawMap();return}
      if(a==='undo'&&undoStack.length){const x=undoStack.pop();selected=x.ids;splitOut=x.split;stopFacts=x.facts;locked=x.locked;lastCheck=null;invalidateRoad();paint();return}
      if(a==='split'&&selected.length>1){if(locked===selected.at(-1)){notice('请先解锁末站');return}checkpoint();splitOut.push(selected.pop());invalidateRoad();paint();return}
      if(a==='lock'){locked=locked===id?'':id;plan();return}
      if(a==='slice'){
        pageNo=0;
        filter=filter===b.dataset.slice?'':b.dataset.slice;search='';stateFilter='';
        root.querySelector('[data-field="filter"]').value=filter;root.querySelector('[data-field="search"]').value='';root.querySelector('[data-field="stateFilter"]').value='';
        list();drawMap();const pts=visible().map(position).filter(Boolean);if(pts.length)fit(pts,8);
        if(window.innerWidth<=800 && filter==='missing')root.querySelector('.dm-queue').scrollIntoView({block:'start',behavior:'smooth'});
      }else if(['jumpMap','jumpList','jumpPlan'].includes(a)){
        root.querySelector('.dm').dataset.mobile={jumpMap:'map',jumpList:'pool',jumpPlan:'plan'}[a];
        if(a==='jumpMap')map?.invalidateSize({animate:false});
        root.querySelector({jumpMap:'.dm-mapcard',jumpList:'.dm-queue',jumpPlan:'.dm-plan'}[a]).scrollIntoView({block:'nearest',behavior:'instant'});
      }
      else if(a==='focus')focusOrder(id,true);
      else if(['open','dispatch','station_release'].includes(a))ctx.openOrder?.(id,a==='open'?undefined:a);
      else if(a==='fitOrder' && byKey(id))fit(ticketPoints(byKey(id)).filter(Boolean));
      else if(a==='home'&&position(depot()))map?.setView(position(depot()),12);
      else if(a==='nation')nationView();
      else if(a==='fit'){const p=visible().map(position).filter(Boolean);if(p.length)fit(p);else{notice('筛选结果中没有可定位订单。');plan();}}
      else if(a==='fitPlan')fit([eligibleDepot(),...selected.map(id=>position(byKey(id)))].filter(Boolean));
      else if(a==='cached')showCached();
      else if(a==='sample'){
        const rows=demoOrders();if(rows){
          for(const o of rows)toggle(orderKey(o));name='Dallas 双站演练';start='09:00';costDraft={original:650,transport:580,extra:55,coordination:25,incentive:10};
          rows.forEach((o,i)=>{stopFacts[o.id]={from_id:i?rows[i-1].id:depot()?.id,travel:i?35:20,admission:i?15:0,service:i?30:60,unload:10,site_end:i?date+'T11:00':'',height:193,kg:180,required_people:2,required_tools:'dolly,straps',requires_lift:'yes',road_ref:'SIM-TRUCK-'+(i+1),dock_ref:'SIM-DOCK-'+(i+1),package_ref:'SIM-PACK-1'}});
          showCached();paint();
        }
      }
      else if(a==='roads'||a==='orderedRoad')roads(a==='roads');
      else if(a==='clear'){reset();paint();}
      else if(canEdit()){
        if(a==='toggle')toggle(id);
        else if(a==='save')save();
        else if(a==='up'||a==='down'){const i=selected.indexOf(id), j=i+(a==='up'?-1:1);if(i>=0 && j>=0 && j<selected.length && ![selected[i],selected[j]].includes(locked)){checkpoint();[selected[i],selected[j]]=[selected[j],selected[i]];invalidateRoad();paint();}}
      }
    }
    function change(ev){
      const key=ev.target.dataset.field, value=ev.target.value;
      if(ev.target.dataset.cost){costDraft[ev.target.dataset.cost]=value;costResult();return}
      if(ev.target.dataset.check){invalidateRoad();routeChecks[ev.target.dataset.check]=value;lastCheck=null;plan();return}
      if(ev.target.dataset.leg){invalidateRoad();const {leg,prop}=ev.target.dataset;const s=stopFacts[leg]||={};s[prop]=value;if(prop==='road_ref'){const i=selected.indexOf(leg);s.from_id=i?selected[i-1]:depot()?.id}lastCheck=null;plan();return}
      if(!key || busy)return;
      if(key==='opacity'){el('map').style.setProperty('--basemap-opacity',String(Number(value)/100));return}
      if(key==='region'){const r=regions[value];if(map && r)map.setView([r[1],r[2]],r[3],{animate:false});ev.target.value='';return;}
      if(key==='routeLoad'){if(value)loadRoute(value);return;}
      if(key==='filter'||key==='stateFilter'){pageNo=0;if(key==='filter')filter=value;else stateFilter=value;list();drawMap();return;}
      if(!canEdit())return;
      lastCheck=null;
      if(['driver','crew','vehicle','executor','date','zone','start','service'].includes(key))invalidateRoad();
      if(key==='driver')routeChecks.driver=value;
      else if(key==='executor')executor=value;
      else if(key==='crew')crew=value;
      else if(key==='warehouse'){warehouse=value;zone=depot()?.timezone||zone;invalidateRoad();config();}
      else if(key==='vehicle')vehicle=value;
      else if(key==='date')date=value;
      else if(key==='start')start=value;
      else if(key==='zone')zone=value;
      else if(key==='service')service=value;
      else return;
      plan();drawMap();
    }
    function input(ev){
      const {field:key}=ev.target.dataset;
      if(key==='search'){pageNo=0;search=ev.target.value;list();drawMap();}
      if(key==='name')name=ev.target.value;
      if(key==='notes')notes=ev.target.value;
    }
    const pref=readPref('filters',{});filter=pref.filter||'';search=pref.search||'';stateFilter=pref.stateFilter||'';
    root.querySelector('[data-field=filter]').value=filter;root.querySelector('[data-field=search]').value=search;
    if(canEdit())ctx.api?.('/api/drivers').then(result=>{if(!destroyed){drivers=result.drivers||[];config()}}).catch(()=>{});
    initMap();el('layer').textContent=ctx.tilesEnabled?'内网街道底图':'离线州界';paint();
    if(ctx.demo || ctx.publicDemo)demoLegs().then(data=>{if(!destroyed){demoCache=data;plan();}}).catch(()=>{});
    if(ctx.focusOrderId && byKey(ctx.focusOrderId))focusOrder(ctx.focusOrderId,true);
    function dragStart(ev){const row=ev.target.closest('[data-stop]');if(row && canEdit())ev.dataTransfer.setData('text/plain',row.dataset.stop)}
    function dragOver(ev){if(ev.target.closest('[data-stop]'))ev.preventDefault()}
    function drop(ev){
      const row=ev.target.closest('[data-stop]');if(!row || !canEdit() || busy)return;ev.preventDefault();
      const id=ev.dataTransfer.getData('text/plain'),from=selected.indexOf(id),to=selected.indexOf(row.dataset.stop);
      if(from<0||to<0||from===to)return;
      const next=selected.slice();next.splice(to,0,next.splice(from,1)[0]);
      if(locked && next.indexOf(locked)!==selected.indexOf(locked)){notice('锁定站不可移动');return}
      checkpoint();selected=next;invalidateRoad();paint();
    }
    root.addEventListener('dragstart',dragStart);root.addEventListener('dragover',dragOver);root.addEventListener('drop',drop);
    cleanups.push(()=>{root.removeEventListener('dragstart',dragStart);root.removeEventListener('dragover',dragOver);root.removeEventListener('drop',drop)});
    root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);
    return {
      getSelection(){return selected.map(byKey).filter(Boolean)},
      getDepot(){return depot()},
      focusOrder(id){if(byKey(id))focusOrder(id,true)},
      update(next){ctx=next;sync();capabilities=null;fetchScope();if(road && !validRoad())invalidateRoad();paint();},
      destroy(){if(destroyed)return;destroyed=true;invalidateRoad();observer?.disconnect();cleanups.forEach(fn=>fn());map?.stop();map?.remove();map=null;root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('input',input);}
    };
  }
  window.DispatchMap={mount};
})();
