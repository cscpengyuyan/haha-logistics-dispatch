/* Shared dispatch map. Leaflet and the state boundaries are served by this application. */
(() => {
  'use strict';
  const statusNames = {new:'待核验', ready:'待调度', dispatched:'已派单', in_transit:'在途',at_station:'站点保管',last_mile:'二程运输', delivered:'已签收', settled:'已结算', exception:'异常'};
  const assetBase = new URL('.',document.currentScript?.src || document.baseURI);
  const regions={dfw:['达拉斯 / 沃思堡',32.88,-97.05,8.75],nj:['新泽西 / 纽约',40.70,-74.24,8.75],fife:['Fife / 西雅图',47.35,-122.31,9],la:['洛杉矶',34.03,-118.10,8.5]};
  let offlinePromise, demoPromise;
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
  const transitStages=new Set(['in_transit','last_mile']);
  const levels={L1:'基础交接',L2:'指定入口',L3:'室内机位'};
  const locationKey=o=>o?.address && o.zip ? [o.address,o.city,o.state,o.zip].join('|').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim() : '';
  const viaStation = o => ['C1','C2'].includes(o?.route);
  const dispatchOrigin = o => viaStation(o) ? o.station_name : o.warehouse;
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
  function gate(o,warehouse) {
    if (!o) return '订单已移除或无权查看';
    if (o.pickup) return '客户自提，无车组配送';
    if (viaStation(o)){
      if(o.status!=='at_station')return '经站单须入站交接后按二程排线';
      if(!o.station_name)return '接收站未登记';
    }else if (o.status!=='ready') return statusNames[o.status] || '当前状态不可排';
    if (!position(o)) return '待补交付点坐标';
    if (!dispatchOrigin(o)) return '待补出发仓';
    if (warehouse && dispatchOrigin(o)!==warehouse) return '与批次出发仓不符';
    return '';
  }
  function mount(root, initial) {
    let ctx=initial, map, pins, lines, labels, tile, observer, controller, road=null,demoCache=null,destroyed=false, busy=false, roadBusy=false;
    const cleanups=[];
    let records=new Map(), warehouses=[], fleet=[], routes=[], selected=[], focused='', filter='', search='', stateFilter='', warehouse='', vehicle='', routeId='', version=null;
    let name='', notes='', date='', start='08:00', zone='America/Chicago', service=45, message='';
    const canEdit=()=>['admin','dispatch'].includes(ctx.user?.role);
    const depot=()=>warehouses.find(x=>x.name===warehouse);
    const byKey=id=>records.get(String(id));
    const all=()=>Array.from(records.values());
    function sync() {
      records=new Map((ctx.orders||[]).map(o=>[orderKey(o),o]));
      warehouses=(ctx.resources||[]).filter(r=>r.type==='warehouse');
      fleet=(ctx.resources||[]).filter(r=>['vehicle','crew'].includes(r.type));
      routes=ctx.routes||[];
    }
    sync();
    warehouse=warehouses.find(w=>all().some(o=>o.warehouse===w.name && o.status==='ready'))?.name || warehouses[0]?.name || '';
    zone=depot()?.timezone || zone;
    try { date=localStamp(Date.now(),zone).slice(0,10); } catch {zone='America/Chicago';date=localStamp(Date.now(),zone).slice(0,10);}
    const available=o=>!gate(o,'') && warehouses.some(w=>w.name===dispatchOrigin(o)&&position(w));
    function accepts(o,key){
      if(key==='missing')return !position(o);
      if(key==='available')return available(o);
      if(key==='onroad')return transitStages.has(o.status);
      return !key || key===o.status;
    }
    const visible=()=>all().filter(o=>{
      const haystack=[o.id,o.customer,o.city,o.state,o.zip,o.warehouse].join(' ').toLowerCase();
      return accepts(o,filter) && (!stateFilter || o.state===stateFilter) && (!search || haystack.includes(search.trim().toLowerCase()));
    });
    const field=(title,key,body)=>`<label class="dm-field"><span>${title}</span>${body(key)}</label>`;
    const btn=(act,text,attrs='')=>`<button type="button" data-act="${act}" ${attrs}>${text}</button>`;
    const rowBtn=(act,id,text,attrs='')=>btn(act,text,`data-id="${e(id)}" ${attrs}`);
    const el=key=>root.querySelector('[data-box="'+key+'"]');
    const roadKey=()=>JSON.stringify([position(depot()),...selected.map(id=>position(byKey(id)))]);
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
    root.innerHTML=`<section class="dm">
      <div class="dm-command"><div class="dm-pulse" data-box="metrics"></div><div class="dm-route-head" data-box="trial"></div></div>
      <div class="dm-top"><label class="dm-search"><span aria-hidden="true">⌕</span><input data-field="search" placeholder="搜索单号、客户、城市或 ZIP" aria-label="搜索地图订单"></label>
        <select data-field="filter" aria-label="按任务状态筛选"><option value="">全部任务状态</option><option value="available">可加入批次</option><option value="onroad">全部在途</option><option value="missing">缺定位</option>${Object.entries(statusNames).map(([v,n])=>option(v,n,'')).join('')}</select>
        <select data-field="stateFilter" aria-label="按州筛选"></select>${btn('fit','定位筛选结果')}</div>
      <div class="dm-shortcuts" aria-label="调度区定位">${btn('jumpMap','地图')}${btn('jumpList','订单池')}${btn('jumpPlan','排线与保存')}</div>
      <div class="dm-grid"><section class="dm-mapcard"><header><div><small>DISPATCH COVERAGE</small><h3>交付点与仓点</h3></div><div class="dm-actions"><select data-field="region" aria-label="聚焦区域"><option value="">聚焦区域…</option>${Object.entries(regions).map(([k,v])=>option(k,v[0],'')).join('')}</select>${btn('nation','全美视图')}</div></header>
        <div class="dm-map" data-box="map" aria-label="美国交付点调度地图"></div>
        <footer><span class="dm-legend"><i class="wh"></i>仓点 <i></i>订单 <i class="ex"></i>异常 <i class="rp">1</i>已选站序</span><span class="dm-live" data-box="layer"></span><span data-box="routeCredit"></span><span data-box="counts"></span></footer><div class="dm-routebar" data-box="itinerary"></div></section>
        <section class="dm-queue"><header><div><small>ORDER POOL</small><h3>地图订单池</h3></div><b data-box="total"></b></header><div data-box="list" class="dm-list"></div></section></div>
      <section class="dm-detail" data-box="detail"></section>
      <section class="dm-plan"><header><div><small>MULTI-STOP ROUTE</small><h3>多站排线</h3></div><div class="dm-actions"><select data-field="routeLoad" aria-label="调出共享批次"></select>${btn('clear','新建草案')}</div></header>
       <div data-box="config" class="dm-config"></div><div data-box="stops"></div><div data-box="save" class="dm-save"></div>
       <p data-box="message" class="dm-msg" role="status"></p></section></section>`;
    function initMap(){
      if (!window.L || !window.US_STATES) {el('map').textContent='地图资源未加载。可继续在订单池查看订单和排线。';return;}
      map=L.map(el('map'),{minZoom:2,maxZoom:ctx.tilesEnabled?18:12,zoomSnap:0.25,scrollWheelZoom:false,attributionControl:false});
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
        tile.on('tileerror',()=>{tile.remove();el('layer').textContent='州界底图 · 瓦片不可用';});
        tile.addTo(map);
        // Keep interactive geography above roads, clearing the opaque polygon fills.
        tile.on('tileload',()=>{if(map.hasLayer(tile))states.setStyle({fillOpacity:0.08});});
        tile.on('remove',()=>states.setStyle({fillOpacity:1}));
      }
      const coords=[...all().map(position),...warehouses.map(position)].filter(Boolean);
      if(coords.length) fit(coords,8); else nationView();
      map.on('zoomend',drawMap);
      cleanups.push(()=>map.off('zoomend',drawMap));
      offlineData().then(data=>{
        if(!destroyed && map){
          cleanups.push(addGeography(map,data));attribution.addAttribution('道路及地名 U.S. Census 2025');
          if(!ctx.tilesEnabled)el('layer').textContent='离线公路与州界';
        }
      }).catch(()=>{if(!destroyed && !ctx.tilesEnabled)el('layer').textContent='离线州界 · 公路图层不可用';});
      let previousWidth=el('map').clientWidth;
      observer=new ResizeObserver(()=>{
        if(!map || destroyed)return;
        const width=el('map').clientWidth;
        if(width===previousWidth)return;
        previousWidth=width;
        map.invalidateSize({animate:false,debounceMoveend:false});
        if(selected.length)fit([eligibleDepot(),...selected.map(id=>position(byKey(id)))].filter(Boolean));
        else if(map.getZoom()<6)fit([...visible().map(position),...warehouses.map(position)].filter(Boolean),8);
      });observer.observe(el('map'));
    }
    function nationView(){if(map) map.fitBounds([[24.5,-125],[49.5,-66.5]],{padding:[8,8],animate:false});}
    function fit(points,max=10){if(map && points.length) map.fitBounds(L.latLngBounds(points),{padding:[34,34],maxZoom:max,animate:false});}
    function validRoad(){return road && road.key===roadKey()?road:null;}
    function drawMap(){
      el('routeCredit').innerHTML=validRoad()?.cached?'线路 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>':'';
      if(!map) return;
      pins.clearLayers();lines.clearLayers();
      const orders=[...new Map([...visible(),...selected.map(byKey).filter(Boolean)].map(o=>[orderKey(o),o])).values()];
      const points=[...warehouses.filter(position).map(w=>({w,p:position(w)})),...orders.filter(position).map(o=>({o,p:position(o)}))];
      const groups=[],radius=map.getZoom()<7?45:17;
      for(const item of points){
        const pixel=map.project(item.p);
        let group=groups.find(g=>g.pixel.distanceTo(pixel)<radius);
        if(!group){group={pixel,items:[]};groups.push(group);}
        group.items.push(item);
      }
      for(const {items} of groups){
        const os=items.filter(i=>i.o).map(i=>i.o), ws=items.filter(i=>i.w).map(i=>i.w), pos=items[0].p;
        const chosen=os.filter(o=>selected.includes(orderKey(o))),alerts=os.filter(o=>o.status==='exception');
        const plural=items.length>1,city=ws[0]?.name||os[0]?.city||'订单';
        const title=plural?`${city} · ${ws.length} 仓 / ${os.length} 票${alerts.length?' / 异常 '+alerts.length:''}`:ws[0]?.name||os[0].id;
        const index=chosen.length?selected.indexOf(orderKey(chosen[0]))+1:0;
        let html;
        if(plural){
          html=`<span class="dm-cluster ${alerts.length?'has-alert':''} ${index?'has-stops':''}"><b>${e(city)}</b><span>${ws.length?'▣ '+ws.length+' 仓 ':''}${os.length?'● '+os.length+' 票':''}${alerts.length?' · ⚠ '+alerts.length:''}</span></span>`;
        }else if(ws.length)html='<i class="dm-warehouse">仓</i>';
        else html=`<i class="dm-pin ${index?'picked':alerts.length?'alert':''} ${focused===orderKey(os[0])?'focus':''}">${index|| (alerts.length?'!':'')}</i>`;
        const size=plural?[76,38]:[26,26];
        const marker=L.marker(pos,{zIndexOffset:index?150:0,title,icon:L.divIcon({className:'dm-marker',html,iconSize:size,iconAnchor:[size[0]/2,size[1]/2]})}).addTo(pins);
        marker.bindTooltip(e(title));
        marker.on('click',()=>{
          if(!plural && os.length){focusOrder(orderKey(os[0]),false);return;}
          const different=items.some(({p})=>Math.abs(p[0]-pos[0])+Math.abs(p[1]-pos[1])>0.0002);
          if(plural && different && map.getZoom()<9){fit(items.map(i=>i.p),11);return;}
          const box=document.createElement('div');box.className='dm-pop';
          ws.forEach(w=>{const text=document.createElement('p');text.textContent='仓点 · '+w.name;box.appendChild(text);});
          for(const item of os){const b=document.createElement('button');b.type='button';b.textContent=`${item.city||''} · ${item.id}`;b.onclick=()=>{map.closePopup();focusOrder(orderKey(item),false);};box.appendChild(b);}
          marker.bindPopup(box).openPopup();
        });
      }
      if(selected.length && eligibleDepot() && selected.every(id=>position(byKey(id)))){
        const r=validRoad();
        const points=r?r.geometry:[eligibleDepot(),...selected.map(id=>position(byKey(id)))];
        L.polyline(points,{pane:'dispatchPlan',interactive:false,color:'#176d60',weight:3.5,opacity:0.92,dashArray:r?null:'7 7'}).addTo(lines);
      }else if(!selected.length && byKey(focused)){
        const pts=ticketPoints(byKey(focused));
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
      const rows=visible(), missing=rows.filter(o=>!position(o)).length;
      const metrics=[['available','可排订单','green'],['onroad','运输在途','blue'],['exception','异常待处理','rust'],['missing','待补定位','gold']];
      el('metrics').innerHTML=metrics.map(([key,label,tone])=>
        btn('slice',`<span><i></i>${label}</span><strong>${all().filter(o=>accepts(o,key)).length}</strong><small>票</small>`,`class="dm-kpi ${tone}" data-slice="${key}" aria-pressed="${filter===key}"`)
      ).join('');
      el('counts').textContent=`${rows.length-missing} 票已定位 · ${missing} 票缺定位`;
      el('total').textContent=rows.length+' 票';
      el('list').innerHTML=rows.length?rows.map(o=>{
        const id=orderKey(o), issue=gate(o,'');
        return `<div class="dm-item ${id===focused?'active':''}"><button type="button" class="dm-item-main" data-act="focus" data-id="${e(id)}"><b>${e(o.city||o.customer||'目的地待补')} <em>${e(o.state||'')} ${e(o.zip||'')}</em></b><span>${e(o.model||'型号待补')} × ${e(o.quantity||'—')} 台 · ${e(o.pickup?'客户自提':levels[o.level]||'终点待核')}</span><small>${e(id)} · ${e(o.customer||'客户待补')}</small></button>
          <div class="dm-item-end"><span class="dm-badge ${o.status==='exception'?'warn':''}">${e(!position(o)?'缺定位':statusNames[o.status]||o.status)}</span>
            ${canEdit()?rowBtn('toggle',id,selected.includes(id)?'移出':'＋ 排线',issue&&!selected.includes(id)?`disabled title="${e(issue)}"`:''):''}</div></div>`;
      }).join(''):'<p class="dm-empty">当前条件下没有订单。</p>';
    }
    function details(){
      const o=byKey(focused);
      if(!o){el('detail').innerHTML='<strong>单票调度</strong><span>点选地图标记或订单，核对交付点、预约窗和出发仓。</span>';return;}
      const pos=position(o);
      const near=pos?warehouses.filter(position).map(w=>({name:w.name,dist:miles(position(w),pos)})).sort((a,b)=>a.dist-b.dist):[];
      const itinerary=[o.warehouse||'仓点待补',...(viaStation(o)?[o.station_name||'接收站待核']:[]),o.pickup?'授权仓口自提':orderCity(o)].join(' → ');
      el('detail').innerHTML=`<div><small>单票交付 · ${e(o.id)}</small><h3>${e(o.customer||o.city||'交付点')} <span>${e(o.pickup?'授权自提':levels[o.level]||'终点待核')}</span></h3><p>${e(o.route||'')} · ${e(o.model||'机型待补')} × ${e(o.quantity||'—')} 台</p><p>${e(itinerary)}</p><p>交接位置 · ${e(o.endpoint||'待核验')}${o.addon_l4?' · 特殊通道':''}</p></div>
        <div><small>收货窗口 · ${e(o.timezone||'时区待核')}</small><p>${e((o.window_start||'未录入').replace('T',' '))} 至 ${e((o.window_end||'未录入').replace('T',' '))}</p>
        <small>${e(pos?'各仓直线参考（库存仍以订单锁定仓为准）':'交付点坐标缺失，需补录定位')}</small><p>${e(near.slice(0,3).map(w=>w.name+' '+fmtMi(w.dist)).join(' / ')||'—')}</p></div>
        <div class="dm-actions">${rowBtn('fitOrder',o.id,'定位运段',ticketPoints(o).every(Boolean)?'':'disabled title="需先补齐各段坐标"')}${rowBtn('open',o.id,'查看订单')}${canEdit() && o.allowed_actions?.includes('dispatch')?rowBtn('dispatch',o.id,'办理派单','class="dm-primary"'):''}${canEdit() && o.allowed_actions?.includes('station_release')?rowBtn('station_release',o.id,'办理二程放行','class="dm-primary"'):''}</div>`;
    }
    function focusOrder(id,pan){
      focused=id;list();details();drawMap();const p=position(byKey(id));if(map && pan && p)map.setView(p,Math.max(6,map.getZoom()),{animate:false});
    }
    function config(){
      const zoneOptions=[...new Set([...zones,zone])];
      const disabled=canEdit()?'':'disabled';
      const controls=[
        field('出发仓','warehouse',k=>`<select data-field="${k}" ${disabled}>${option('','选择已登记仓点',warehouse)}${warehouses.map(w=>option(w.name,w.name,warehouse)).join('')}</select>`),
        field('车组 / 车辆','vehicle',k=>`<select data-field="${k}" ${disabled}>${option('','待指定',vehicle)}${fleet.map(r=>option(r.id,r.name,vehicle)).join('')}</select>`),
        field('出发日期','date',k=>`<input type="date" data-field="${k}" value="${e(date)}" ${disabled}>`),
        field('当地发车','start',k=>`<input type="time" data-field="${k}" value="${e(start)}" ${disabled}>`),
        field('发仓时区','zone',k=>`<select data-field="${k}" ${disabled}>${zoneOptions.map(z=>option(z,z,zone)).join('')}</select>`),
        field('默认作业分钟 / 站','service',k=>`<input type="number" min="1" max="720" data-field="${k}" value="${e(service)}" ${disabled}>`)
      ];
      el('config').innerHTML=controls.join('');
      root.querySelector('[data-field="routeLoad"]').innerHTML=option('','调出共享批次…',routeId)+routes.map(r=>option(r.id,r.name+' · '+r.date,routeId)).join('');
      root.querySelector('[data-field="stateFilter"]').innerHTML=option('','全部州',stateFilter)+[...new Set(all().map(o=>o.state).filter(Boolean))].sort().map(s=>option(s,s,stateFilter)).join('');
    }
    function plan(){
      const d=depot(), r=validRoad(), rows=[], problems=[], totalUnits=selected.reduce((sum,id)=>sum+(Number(byKey(id)?.quantity)||0),0);
      let prev=position(d), cursor=instant(date+'T'+start,zone), totalDistance=0, complete=Boolean(prev), warnings=0;
      if(!prev)problems.push('请选择有经纬度的出发仓');
      if(!Number.isFinite(cursor))problems.push('发仓时间无效或处于夏令时切换的重复/跳过时段');
      if(!(Number(service)>=1&&Number.isInteger(Number(service))&&Number(service)<=720))problems.push('默认作业时长应为 1–720 整分钟');
      const resource=fleet.find(x=>String(x.id)===vehicle), cap=Number(resource?.capacity_units);
      if(cap>0 && totalUnits>cap)problems.push(`装载 ${totalUnits} 台，超过车组上限 ${cap} 台`);
      selected.forEach((id,i)=>{
        const o=byKey(id), p=position(o), reason=gate(o,warehouse);
        if(reason)problems.push(`${id} · ${reason}`);
        let distance, transit;
        if(r){distance=r.legs[i].distance/1609.344;transit=r.legs[i].duration/60;}
        else if(prev && p){distance=miles(prev,p);transit=distance*1.3/35*60;}
        if(Number.isFinite(distance))totalDistance+=distance;else complete=false;
        const arrival=cursor+transit*60000, ws=instant(o?.window_start,o?.timezone), we=instant(o?.window_end,o?.timezone);
        const validWindow=Number.isFinite(ws) && we>ws;
        const enter=validWindow?Math.max(arrival,ws):arrival;
        const job=Number(o?.service_minutes)>0?Number(o.service_minutes):Number(service);
        const exit=enter+job*60000;
        const late=validWindow && Number.isFinite(exit)?Math.max(0,Math.ceil((exit-we)/60000)):0;
        const wait=validWindow?Math.max(0,Math.ceil((ws-arrival)/60000)):0;
        const warn=reason || (!validWindow?'预约窗 / 时区待核':(!Number.isFinite(arrival)?'时间待核':late?`预计超窗 ${late} 分钟`:wait?`候场 ${wait} 分钟`:'预计窗内完成'));
        if(reason || !validWindow || !Number.isFinite(arrival) || late)warnings++;
        rows.push(`<li><b class="dm-num">${i+1}</b><div><button type="button" data-act="focus" data-id="${e(id)}" class="dm-link">${e(id)}</button> <b>${e(o?orderCity(o):'订单不可用')}</b><small>${e(o?.timezone||'时区待核')} · 预约 ${e((o?.window_start||'—').slice(5).replace('T',' '))} – ${e((o?.window_end||'—').slice(5).replace('T',' '))}</small></div>
          <div><b>${e(fmtMi(distance))} · 作业 ${e(job)} 分钟</b><small>预计到站 ${e(clock(arrival,o?.timezone))} / 离站 ${e(clock(exit,o?.timezone))}</small></div>
          <span class="dm-badge ${reason||!validWindow||late||!Number.isFinite(arrival)?'warn':''}">${e(warn)}</span>
          ${canEdit()?`<div class="dm-actions">${rowBtn('up',id,'↑',`aria-label="上移 ${e(id)}" ${i===0?'disabled':''}`)}${rowBtn('down',id,'↓',`aria-label="下移 ${e(id)}" ${i===selected.length-1?'disabled':''}`)}${rowBtn('toggle',id,'移出')}</div>`:''}</li>`);
        cursor=exit;prev=p;
      });
      el('stops').innerHTML=`<div class="dm-summary"><b>${selected.length} 票 / ${totalUnits} 台</b><span>${r?'路网里程':'直线合计'} <strong>${complete?e(fmtMi(totalDistance)):'—'}</strong></span><span>${warnings} 票待复核</span><div class="dm-actions">
        ${canEdit()?btn('nearest','就近排序',selected.length>1&&complete?'':'disabled'):''}${btn('fitPlan','查看全线',selected.length&&complete?'':'disabled')}
        ${cachedLegs()?btn('cached','按演练路网测算'):''}
        ${ctx.routingEnabled?btn('roads',roadBusy?'计算中…':'查询私有路网',!roadBusy&&selected.length&&complete?'':'disabled'):''}</div></div>
        ${rows.length?`<ol class="dm-stops">${rows.join('')}</ol>`:'<div class="dm-empty">从订单池选择同一出发点的待调度订单。经站单完成入站交接后，可由接收站排第二程。</div>'}
        <p class="dm-note">${r?(r.cached?`实线为 ${e(demoCache.date)} 的 Dallas 演练路网。按道路等级和限速估时，已计单行，未计转向限制、实时车况或卡车净高。道路数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>。`:'实线为内网 OSRM 的驾车参考，服务时长另计，车高限行和实时路况由车组复核。'):'虚线为站间直线。时窗参考按直线 × 1.3、均速 35 mph 估算，含候场和逐票作业，无返仓段。'} 预约按收货地时区核算；保存草案后逐票办理派单。</p>`;
      el('save').innerHTML=canEdit()?`${field('批次名称','name',k=>`<input maxlength="100" data-field="${k}" placeholder="如：达拉斯周一上午线" value="${e(name)}">`)}${field('交班备注','notes',k=>`<input maxlength="500" data-field="${k}" placeholder="车组、预约或限行待核事项" value="${e(notes)}">`)}
        ${btn('save',busy?'保存中…':routeId?'更新共享草案':'保存共享草案',`class="dm-primary" ${busy||!selected.length||problems.length?'disabled':''}`)}`: '<p class="dm-note">当前岗位可查阅已保存批次。调度岗负责排线和派单。</p>';
      el('message').textContent=[...new Set([...(selected.length?problems:[]),message].filter(Boolean))].join(' · ');
      const stops=selected.map(byKey).filter(Boolean);
      const sameSite=new Map();
      for(const o of stops){const key=locationKey(o);if(key)sameSite.set(key,(sameSite.get(key)||0)+1);}
      const shared=[...sameSite.values()].filter(n=>n>1).length;
      el('trial').innerHTML=demoOrders()?`<div><small>DALLAS · 路网演练</small><b>一仓两站，检查预约窗</b></div>${btn('sample','试排 Dallas 双站','class="dm-primary"')}`:
        `<div><small>MULTI-STOP · 当前批次</small><b>${selected.length?e(warehouse)+' · '+selected.length+' 票 / '+totalUnits+' 台':'按同仓、约窗与交接位置排线'}</b></div>${btn('jumpPlan',selected.length?'查看排线 ↓':'打开排线 ↓','class="dm-jump"')}`;
      el('itinerary').innerHTML=stops.length?`<div class="dm-flow-label"><b>计划站序</b><small>${r?'公路参考':'直线参考'} · ${complete?e(fmtMi(totalDistance)):'—'}</small></div><div class="dm-flow"><span class="dm-from">▣ ${e(warehouse)}</span>${stops.map((o,i)=>rowBtn('focus',o.id,`<i>${i+1}</i>${e(o.city||o.zip)}<small>× ${e(o.quantity)} 台</small>`)).join('')}</div><p class="dm-group-note">${shared?'发现 '+shared+' 处跨票同址。请核实同一入口与预约窗后合并现场安排；当前逐票计作业时长。':stops.some(o=>o.quantity>1)?'含同址多台订单。台数计入装载，逐票核对卸货与摆位时长。':''}</p>`:
        '<span class="dm-route-hint"><b>排线起点</b> 点选城市标记下钻，或在订单池中点「＋ 排线」。</span>';
    }
    function paint(){config();list();details();plan();drawMap();}
    function reset(){
      selected=[];routeId='';version=null;name='';notes='';message='';vehicle='';invalidateRoad();
    }
    function toggle(id){
      if(selected.includes(id)){selected=selected.filter(x=>x!==id);}
      else{
        const o=byKey(id);const why=gate(o,selected.length?warehouse:'');
        if(why){notice(why);plan();return;}
        if(!warehouses.some(w=>w.name===dispatchOrigin(o) && position(w))){notice('请先在资源台账登记实际出发仓或接收站的名称和坐标。');plan();return;}
        if(!selected.length){
          warehouse=dispatchOrigin(o);zone=depot()?.timezone || zone;date=o.window_start?.slice(0,10) || date;
        }
        selected.push(id);
      }
      invalidateRoad();message='';paint();
    }
    function nearest(){
      let p=eligibleDepot();if(!p || selected.some(id=>!position(byKey(id))))return;
      const todo=selected.slice(), sorted=[];
      while(todo.length){
        let best=0;for(let i=1;i<todo.length;i++){if(miles(p,position(byKey(todo[i])))<miles(p,position(byKey(todo[best]))))best=i;}
        const [id]=todo.splice(best,1);sorted.push(id);p=position(byKey(id));
      }
      selected=sorted;invalidateRoad();notice('已按离上一站的直线距离排序，请核对各站预约窗。');paint();
    }
    async function roads(){
      if(!ctx.routingEnabled || roadBusy || !selected.length || !eligibleDepot())return;
      const points=[eligibleDepot(),...selected.map(id=>position(byKey(id)))]; if(!points.every(Boolean))return;
      invalidateRoad();roadBusy=true;const key=roadKey(), req=new AbortController();controller=req;plan();
      const timer=setTimeout(()=>req.abort(),15000);
      try{
        const coords=points.map(p=>p[1].toFixed(6)+','+p[0].toFixed(6)).join(';');
        const res=await fetch(`routing/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`,{signal:req.signal,credentials:'same-origin',redirect:'error'});
        if(!res.ok)throw Error();const data=await res.json(), r=data.routes?.[0];
        if(data.code!=='Ok' || !r || r.legs?.length!==selected.length || r.geometry?.type!=='LineString' ||
           r.geometry.coordinates?.length<2 || !r.geometry.coordinates.every(p=>Array.isArray(p) && position({lat:p[1],lng:p[0]})) ||
           !r.legs.every(l=>Number.isFinite(l.duration)&&l.duration>=0&&Number.isFinite(l.distance)&&l.distance>=0))throw Error();
        if(data.waypoints?.some(w=>w.distance>1609))throw Error();
        if(!destroyed && controller===req && roadKey()===key){road={key,legs:r.legs,geometry:r.geometry.coordinates.map(([lon,lat])=>[lat,lon])};notice('已取得本批次的内网道路参考。');}
      }catch{if(!destroyed && controller===req)notice('路网查询失败或吸附点过远，仍显示直线与估算时窗。');}
      finally{clearTimeout(timer);if(!destroyed && controller===req){controller=null;roadBusy=false;drawMap();plan();}}
    }
    function loadRoute(id){
      const r=routes.find(x=>String(x.id)===String(id));if(!r)return;
      invalidateRoad();routeId=String(r.id);version=r.version;name=r.name;warehouse=r.warehouse;date=r.date;vehicle=String(r.resource_id??'');notes=r.notes||'';
      start=r.start_time||'08:00';zone=r.timezone||depot()?.timezone||'America/Chicago';service=r.service_minutes||45;
      selected=(r.order_ids||[]).map(String);
      const changed=selected.filter(id=>r.order_versions?.[id]!=null && r.order_versions[id]!==byKey(id)?.version);
      const hints=changed.length?['保存后订单已变更，请核对新版窗口与派单条件：'+changed.join('、')]:['已调出共享草案，时窗与停靠状态按当前订单重新核算。'];
      if(r.road_basis==='demo_cache'){
        const legs=cachedLegs();
        if(legs)road={key:roadKey(),legs,geometry:legs.flatMap(l=>l.geometry),cached:true};
        else hints.push('原草案使用演练路网，当前坐标或环境未命中，显示直线估算。');
      }else if(r.road_basis==='private_osrm')hints.push('原草案使用内网路网，当前显示估算。请重新查询私有路网复核最新里程。');
      message=hints.join(' ');paint();
      const points=[eligibleDepot(),...selected.map(id=>position(byKey(id)))].filter(Boolean);if(points.length)fit(points);
    }
    async function save(){
      if(busy || !canEdit() || typeof ctx.saveRoute!=='function')return;
      if(!name.trim()){notice('请先填写批次名称。');plan();root.querySelector('[data-field="name"]').focus();return;}
      busy=true;plan();const panel=root.querySelector('.dm');panel.inert=true;panel.setAttribute('aria-busy','true');
      const order_versions=Object.fromEntries(selected.map(id=>[id,byKey(id)?.version]));
      const r=validRoad(),road_basis=r?(r.cached?'demo_cache':'private_osrm'):'estimate';
      const payload={name:name.trim(),warehouse,date,resource_id:vehicle||'',order_ids:selected.slice(),order_versions,notes,start_time:start,timezone:zone,service_minutes:Number(service),road_basis};
      if(routeId){payload.id=routeId;payload.version=version;}
      try{
        const result=await ctx.saveRoute(payload), saved=result?.route||result;
        if(destroyed)return;
        if(!saved?.id)throw Error('服务端未返回保存凭证');
        routeId=String(saved.id);version=saved.version;
        routes=[...routes.filter(x=>String(x.id)!==routeId),saved];
        notice('共享批次已保存。');
      }catch(err){if(!destroyed)notice(err.message||'保存失败，请刷新复核后重试。');}
      finally{busy=false;panel.inert=false;panel.removeAttribute('aria-busy');if(!destroyed)paint();}
    }
    function click(ev){
      const b=ev.target.closest('[data-act]');if(!b || !root.contains(b) || b.disabled || busy)return;
      const id=b.dataset.id, a=b.dataset.act;
      if(a==='slice'){
        filter=filter===b.dataset.slice?'':b.dataset.slice;search='';stateFilter='';
        root.querySelector('[data-field="filter"]').value=filter;root.querySelector('[data-field="search"]').value='';root.querySelector('[data-field="stateFilter"]').value='';
        list();drawMap();const pts=visible().map(position).filter(Boolean);if(pts.length)fit(pts,8);
        if(window.innerWidth<=800 && filter==='missing')root.querySelector('.dm-queue').scrollIntoView({block:'start',behavior:'smooth'});
      }else if(['jumpMap','jumpList','jumpPlan'].includes(a))root.querySelector({jumpMap:'.dm-mapcard',jumpList:'.dm-queue',jumpPlan:'.dm-plan'}[a]).scrollIntoView({block:'start',behavior:'smooth'});
      else if(a==='focus')focusOrder(id,true);
      else if(['open','dispatch','station_release'].includes(a))ctx.openOrder?.(id,a==='open'?undefined:a);
      else if(a==='fitOrder' && byKey(id))fit(ticketPoints(byKey(id)).filter(Boolean));
      else if(a==='nation')nationView();
      else if(a==='fit'){const p=visible().map(position).filter(Boolean);if(p.length)fit(p);else{notice('筛选结果中没有可定位订单。');plan();}}
      else if(a==='fitPlan')fit([eligibleDepot(),...selected.map(id=>position(byKey(id)))].filter(Boolean));
      else if(a==='cached')showCached();
      else if(a==='sample'){
        const rows=demoOrders();if(rows){
          for(const o of rows)toggle(orderKey(o));name='Dallas 双站演练';showCached();
        }
      }
      else if(a==='roads')roads();
      else if(a==='clear'){reset();paint();}
      else if(canEdit()){
        if(a==='toggle')toggle(id);
        else if(a==='nearest')nearest();
        else if(a==='save')save();
        else if(a==='up'||a==='down'){const i=selected.indexOf(id), j=i+(a==='up'?-1:1);if(i>=0 && j>=0 && j<selected.length){[selected[i],selected[j]]=[selected[j],selected[i]];invalidateRoad();paint();}}
      }
    }
    function change(ev){
      const key=ev.target.dataset.field, value=ev.target.value;
      if(!key || busy)return;
      if(key==='region'){const r=regions[value];if(map && r)map.setView([r[1],r[2]],r[3],{animate:false});ev.target.value='';return;}
      if(key==='routeLoad'){if(value)loadRoute(value);return;}
      if(key==='filter'||key==='stateFilter'){if(key==='filter')filter=value;else stateFilter=value;list();drawMap();return;}
      if(!canEdit())return;
      if(key==='warehouse'){warehouse=value;zone=depot()?.timezone||zone;invalidateRoad();config();}
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
      if(key==='search'){search=ev.target.value;list();drawMap();}
      if(key==='name')name=ev.target.value;
      if(key==='notes')notes=ev.target.value;
    }
    initMap();el('layer').textContent=ctx.tilesEnabled?'内网街道底图':'离线州界';paint();
    if(ctx.demo || ctx.publicDemo)demoLegs().then(data=>{if(!destroyed){demoCache=data;plan();}}).catch(()=>{});
    root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);
    return {
      update(next){ctx=next;sync();if(road && !validRoad())invalidateRoad();paint();},
      destroy(){if(destroyed)return;destroyed=true;invalidateRoad();observer?.disconnect();cleanups.forEach(fn=>fn());map?.stop();map?.remove();map=null;root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('input',input);}
    };
  }
  window.DispatchMap={mount};
})();
