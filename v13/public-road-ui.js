'use strict';
window.PublicRoadUI = (() => {
  const storageKey='haha-v12-dallas-road-draft-v1';
  const point=(name,lat,lon,extra={})=>({name,lat,lon,verified:true,...extra});
  const stop=(name,lat,lon)=>point(name,lat,lon,{open:'08:00',close:'17:00',service:20,kg:220});
  const sample=()=>({
    origin:point('Dallas 出发仓 · 演练路口',32.781,-96.815),
    stops:[stop('市中心接货点 A',32.779,-96.802),stop('市中心接货点 B',32.787,-96.792),stop('市中心接货点 C',32.775,-96.789)],
    truck:{height:3.3,width:2.45,length:8,weight:7.5,axle_load:4},limit:1800,depart:'08:00',shiftEnd:'17:00',optimize:true
  });
  const mins=t=>{const [h,m]=t.split(':').map(Number);return h*60+m};
  const time=n=>Number.isFinite(n)?String(Math.floor(Math.round(n)/60)%24).padStart(2,'0')+':'+String(Math.round(n)%60).padStart(2,'0'):'—';
  const key=s=>JSON.stringify(s);
  function mount(host,ctx,script,selected,depot){
    const e=ctx.escape;
    const root=document.createElement('section');root.className='public-road';host.replaceChildren(root);
    let state=sample(),last=null,lastKey='',generation=0,busy=false,alive=true,rev=0;
    const ticket=ctx.focusOrderId&&(ctx.demo||ctx.publicDemo)&&ctx.orders?.find(o=>o.id===ctx.focusOrderId&&o.crm_ref==='DEMO-DAL-02'
      &&o.location_precision==='dock'&&o.coordinate_ref&&o.warehouse==='Dallas'&&Number(o.lat)===32.779&&Number(o.lng)===-96.799);
    if(ticket){
      state.stops=[{...stop(ticket.address||'Dallas 演练机位',Number(ticket.lat),Number(ticket.lng)),
        open:ticket.window_start?.slice(11,16)||'09:00',close:ticket.window_end?.slice(11,16)||'16:00',service:45,kg:440}];
    }
    const draftKey=ticket?storageKey+':'+ticket.id:storageKey;
    let map,lines,markers,base,controller,dragged,styleId='local',loadingBase=false;
    const pref=DispatchViews.prefs(ctx,'road'),layers={origin:true,stops:true,line:true,...pref.get('layers',{})};
    root.innerHTML='<div class="pr-bar"><div><b>Dallas 市区　·　'+(ticket?'本票试排 '+e(ticket.id):'公开演练')+'</b><p>样例使用演练入口。自选站请核实经纬度；未标注限高、限重的路段仍须车组复核。</p></div><button data-act="import">导入地图已选单（'+selected.length+'）</button></div>'+
      '<div class="pr-layout"><form class="pr-inputs"><div data-fields></div><div class="pr-tools"><button type="submit" class="primary">规划道路路线</button><button type="button" data-act="cancel" hidden>取消等待</button></div><p data-status role="status" aria-live="polite"></p></form>'+
      '<section class="pr-output"><div class="pr-tools">'+DispatchViews.html+'</div><div class="pr-map" aria-label="全国视野与达拉斯道路试排"></div><div class="pr-tools">'+Object.entries({origin:'出发仓',stops:'站序',line:'道路'}).map(([k,label])=>'<button type="button" data-map-layer="'+k+'" aria-pressed="'+layers[k]+'">'+label+'</button>').join('')+'<button type="button" data-act="retryBase">重试底图</button></div><p class="pr-base" role="status">正在载入街道底图…</p><div data-results></div>'+
      '<div class="pr-tools">'+(ticket?'<button type="button" data-act="saveTicket">保存本票道路试排</button>':'')+'<button data-act="save">保存演练草案</button><button data-act="restore">恢复已存草案</button></div><small data-saved></small></section></div>';
    const find=sel=>root.querySelector(sel),form=find('form'),status=find('[data-status]');
    const input=(label,type,section,k,val,props='')=>'<label><span>'+label+'</span><input type="'+type+'" data-row="'+section+'" data-k="'+k+'" '+props+' '+(type==='checkbox'?(val?'checked':''):'value="'+e(val??'')+'"')+'></label>';
    const coords=(p,i)=>input(i==='origin'?'仓址 / 演练入口':'交货地址 / 入口','text',i,'name',p.name,'required maxlength="160"')+
      '<div class="pr-pair">'+input('入口纬度','number',i,'lat',p.lat,'required min="-90" max="90" step="any"')+input('入口经度','number',i,'lon',p.lon,'required min="-180" max="180" step="any"')+'</div>'+
      input('已核入口坐标','checkbox',i,'verified',p.verified);
    function fields(){
      const vehicles=[['height','高 m'],['width','宽 m'],['length','长 m'],['weight','总重 t'],['axle_load','轴荷 t']];
      find('[data-fields]').innerHTML='<div class="pr-head"><b>出发仓与班次</b><small>美国中部时间</small></div>'+coords(state.origin,'origin')+
        '<div class="pr-pair">'+input('发车','time','plan','depart',state.depart,'required')+input('结束班次','time','plan','shiftEnd',state.shiftEnd,'required')+'</div>'+
        '<details class="pr-vehicle"><summary>车辆规格　·　载重 '+e(state.limit)+' kg</summary><div class="pr-pair">'+input('有效载重 kg','number','plan','limit',state.limit,'required min="1" step="any"')+vehicles.map(([k,t])=>input(t,'number','truck',k,state.truck[k],'required min=".01" step="any"')).join('')+'</div></details>'+
        '<div class="pr-head"><b>停靠点　'+state.stops.length+'</b><button data-act="add" type="button">＋ 加一站</button></div>'+
        state.stops.map((s,i)=>'<details class="pr-stop" data-index="'+i+'"><summary draggable="true" title="拖动调整站序，或展开后用上移和下移"><i>'+String(i+1).padStart(2,'0')+'</i><b>'+e(s.name||'待补交货地址')+'</b><span>'+e(s.open)+'–'+e(s.close)+'</span></summary>'+
          '<div class="pr-stop-body">'+coords(s,i)+'<div class="pr-pair">'+input('预约开始','time',i,'open',s.open,'required')+input('最迟交付完成','time',i,'close',s.close,'required')+
          input('作业分钟','number',i,'service',s.service,'required min="1" max="1440"')+input('货重 kg','number',i,'kg',s.kg,'required min="1" step="any"')+'</div>'+
          '<div class="pr-tools">'+[['up','上移',i===0],['down','下移',i===state.stops.length-1],['remove','移除',false]].map(([a,t,no])=>'<button type="button" data-act="'+a+'" data-index="'+i+'" '+(no?'disabled':'')+'>'+t+'</button>').join('')+'</div></div></details>').join('')+
        input('按车型和时窗选择可行站序（取消后按上列顺序）','checkbox','plan','optimize',state.optimize);
    }
    function drawMap(fit=false){
      if(!map)return;
      lines.clearLayers();markers.clearLayers();
      const valid=last&&lastKey===key(state),points=[state.origin,...state.stops];
      for(const [i,p] of points.entries()){
        if(!layers[i?'stops':'origin'])continue;
        if(p.lat===''||p.lon===''||!Number.isFinite(Number(p.lat))||!Number.isFinite(Number(p.lon)))continue;
        const index=i&&valid?last.order.indexOf(i)+1:i;
        const label=document.createElement('span');label.textContent=p.name||'待核址';
        L.marker([Number(p.lat),Number(p.lon)],{icon:L.divIcon({className:'pr-pin '+(!p.verified?'pr-unverified':i?'':'pr-warehouse'),html:i?String(index):'仓',iconSize:[24,24],iconAnchor:[12,12]})}).bindTooltip(label).addTo(markers);
      }
      if(layers.line&&valid&&last.geometry?.length){
        const shape=L.polyline(last.geometry,{pane:'roadGeometry',color:'#196e50',weight:5,opacity:.9}).addTo(lines);
        for(let index=30;index<last.geometry.length-1;index+=75){
          const a=last.geometry[index],b=last.geometry[index+1],from=map.project(a),to=map.project(b);
          const angle=Math.atan2(to.y-from.y,to.x-from.x)*180/Math.PI;
          L.marker(a,{interactive:false,keyboard:false,icon:L.divIcon({className:'pr-direction',html:'<span style="transform:rotate('+angle+'deg)">➤</span>',iconSize:[12,12],iconAnchor:[6,6]})}).addTo(lines);
        }
        if(fit)map.fitBounds(shape.getBounds(),{animate:false,padding:[25,25],maxZoom:15});
      }else if(fit&&markers.getLayers().length)map.fitBounds(markers.getBounds(),{animate:false,padding:[25,25],maxZoom:14});
    }
    function results(fit=false){
      find('[data-act=cancel]').hidden=!busy;
      form.querySelector('[type=submit]').disabled=busy;
      const target=find('[data-results]');
      if(!last||lastKey!==key(state)){
        target.innerHTML='<h2>路线预览</h2><p>'+(last?'上次结果 '+e(last.timestamp)+' 已失效，请重新计算。':'输入已核实的入口后点击规划，查看每站到离时间与道路里程。')+'</p>';
      }else{
        const total=last.legs.reduce((n,l)=>n+l.distance,0),final=last.legs.at(-1);
        let load=state.stops.reduce((n,s)=>n+Number(s.kg),0);
        target.innerHTML='<div class="pr-head"><h2>一仓 '+last.order.length+' 站</h2><b>'+e((total/1609.344).toFixed(1))+' mi　·　'+e(Math.round(final.departure-mins(state.depart)))+' 分钟</b></div>'+
        '<ol class="pr-timeline">'+last.order.map((idx,i)=>{
          const p=state.stops[idx-1],leg=last.legs[i];load-=Number(p.kg);
          return '<li><b>'+e(p.name)+'</b><p>到 '+time(leg.arrival)+'　离 '+time(leg.departure)+'　·　预约 '+e(p.open)+'–'+e(p.close)+'</p><small>'+e((leg.distance/1609.344).toFixed(1))+' mi　·　行车 '+e(Math.ceil(leg.duration/60))+' 分　·　作业 '+e(p.service)+' 分　·　车上 '+e(load)+' kg　·　可余载 '+e(state.limit-load)+' kg</small></li>';
        }).join('')+'</ol><small>道路来源　'+e(last.source)+'<br>计算时间　'+e(last.timestamp)+'</small>';
      }
      drawMap(fit);
    }
    function invalidate(){controller?.abort();generation++;busy=false;status.textContent='参数已修改，待重新计算。';results()}
    function bindChange(ev){
      const field=ev.target,k=field.dataset.k,i=field.dataset.row;if(!k)return;
      const obj=i==='origin'?state.origin:i==='truck'?state.truck:i==='plan'?state:state.stops[Number(i)];
      obj[k]=field.type==='checkbox'?field.checked:field.type==='number'&&field.value!==''?Number(field.value):field.value;
      if(['name','lat','lon'].includes(k)){
        obj.verified=false;const ck=form.querySelector('input[data-row="'+i+'"][data-k=verified]');if(ck)ck.checked=false;
      }
      const summary=field.closest('.pr-stop')?.querySelector('summary');
      if(summary){summary.querySelector('b').textContent=obj.name||'待补交货地址';summary.querySelector('span').textContent=obj.open+'–'+obj.close}
      invalidate();
    }
    form.addEventListener('input',bindChange);
    form.addEventListener('invalid',ev=>{const details=ev.target.closest('details');if(details)details.open=true},true);
    async function calculate(ev){
      ev.preventDefault();
      const points=[state.origin,...state.stops];
      if(!state.stops.length){status.textContent='请至少添加一个停靠点。';return}
      const missing=points.find(p=>!p.verified);
      if(missing){status.textContent=(missing.name||'交货入口')+' 待核址。请核对实际入口、勾选已核入口坐标。';return}
      controller?.abort();controller=new AbortController();
      const turn=++generation;busy=true;status.textContent='正在按所选车型和预约窗计算道路…';results();
      try{
        if(!window.DallasRoad)await script('./dallas-road.js');
        if(turn!==generation||!alive)return;
        const req={points:points.map(p=>({lat:Number(p.lat),lon:Number(p.lon)})),truck:{...state.truck},depart:mins(state.depart),shiftEnd:mins(state.shiftEnd),limit:Number(state.limit),optimize:state.optimize,
          stops:state.stops.map(p=>({open:mins(p.open),close:mins(p.close),service:Number(p.service),kg:Number(p.kg)}))};
        const route=await window.DallasRoad.plan(req,{signal:controller.signal});
        if(turn!==generation||!alive)return;
        last=route;lastKey=key(state);status.textContent='道路已计算，可核对并保存本设备草案。';results(true);
      }catch(err){if(turn===generation&&alive){status.textContent='无法规划　'+(err.message||err)+'　·　修正后可重试或保存输入。';lastKey=''}}
      finally{if(turn===generation&&alive){busy=false;results()}}
    }
    form.onsubmit=calculate;
    function editorChanged(){fields();invalidate();drawMap(true)}
    function save(){
      try{
        const payload={state,last,lastKey,revision:rev+1,savedAt:new Date().toISOString()};
        localStorage.setItem(draftKey,JSON.stringify(payload));rev=payload.revision;
        find('[data-saved]').textContent='已保存在本设备　v'+rev+'　'+payload.savedAt;status.textContent='演练草案已保存。';
      }catch(err){status.textContent='草案保存失败　'+err.message}
    }
    function restore(){
      try{
        const draft=JSON.parse(localStorage.getItem(draftKey));
        if(!draft){status.textContent='本设备尚无已存道路草案。';return}
        if(!draft.state?.origin||!Array.isArray(draft.state.stops)||!draft.state.truck)throw Error('无法识别草案版本');
        controller?.abort();generation++;busy=false;state=draft.state;last=draft.last;lastKey=draft.lastKey;rev=draft.revision;
        fields();results(true);status.textContent='已恢复 v'+rev+'　'+draft.savedAt;find('[data-saved]').textContent=status.textContent;
      }catch(err){status.textContent='无法恢复草案　'+err.message}
    }
    root.onclick=ev=>{
      const toggle=ev.target.closest('[data-map-layer]');
      if(toggle){const id=toggle.dataset.mapLayer;layers[id]=!layers[id];pref.set('layers',layers);toggle.setAttribute('aria-pressed',String(layers[id]));drawMap();return}
      const b=ev.target.closest('[data-act]');if(!b)return;
      const a=b.dataset.act,i=Number(b.dataset.index);
      if(a==='retryBase')base?base.retry():loadBase();
      if(a==='saveTicket'&&ticket){
        if(!last||lastKey!==key(state)||state.stops.length!==1||state.origin.lat!==32.781||state.origin.lon!==-96.815
          ||Number(state.stops[0].lat)!==Number(ticket.lat)||Number(state.stops[0].lon)!==Number(ticket.lng)){
          status.textContent='须以本票已核的仓和交付入口重算一站道路。';return;
        }
        b.disabled=true;
        ctx.api('/api/practice/ticket/'+encodeURIComponent(ticket.id)+'/road',{method:'POST',body:{version:ticket.version,
          kilometers:last.legs[0].distance/1000,duration_min:last.legs[0].duration/60,source:last.source,
          origin:[Number(state.origin.lat),Number(state.origin.lon)],stop:[Number(state.stops[0].lat),Number(state.stops[0].lon)]}})
          .then(()=>{status.textContent='本票演练道路已登记。';find('[data-saved]').textContent=ticket.id+' · '+(last.legs[0].distance/1609.344).toFixed(2)+' mi';})
          .catch(err=>{status.textContent=err.message;b.disabled=false});return;
      }
      if(a==='restore')restore();
      if(a==='save')save();
      if(a==='cancel'){controller?.abort();generation++;busy=false;status.textContent='已取消本次等待，输入保留。';results()}
      if(a==='add'){
        state.stops.push({...stop('','',''),verified:false});editorChanged();const item=root.querySelectorAll('.pr-stop')[state.stops.length-1];item.open=true;item.querySelector('input').focus();
      }
      if(a==='remove'){state.stops.splice(i,1);editorChanged()}
      if(a==='up'||a==='down'){
        const j=i+(a==='up'?-1:1);[state.stops[i],state.stops[j]]=[state.stops[j],state.stops[i]];state.optimize=false;editorChanged();
      }
      if(a==='import'){
        if(!selected.length){status.textContent='请先在地图调度勾选待排订单，再从该页进入试排。';return}
        if(depot)state.origin=point(depot.address||depot.name,depot.lat??'',depot.lng??'',{verified:false});
        state.stops=selected.map(o=>({...stop(o.address||o.customer||o.id,o.lat??'',o.lng??''),open:o.window_start?.slice(11,16)||'08:00',close:o.window_end?.slice(11,16)||'17:00',kg:'',verified:false}));
        editorChanged();status.textContent='已导入 '+selected.length+' 处候选站点。请核实入口、作业时长和实际货重。';
      }
    };
    root.ondragstart=ev=>{const row=ev.target.closest('.pr-stop');if(row){dragged=Number(row.dataset.index);ev.dataTransfer.setData('text/plain',String(dragged))}};
    root.ondragover=ev=>{if(Number.isInteger(dragged)&&ev.target.closest('.pr-stop'))ev.preventDefault()};
    root.ondrop=ev=>{const row=ev.target.closest('.pr-stop');if(!row||!Number.isInteger(dragged))return;
      ev.preventDefault();const target=Number(row.dataset.index);
      if(target!==dragged){const item=state.stops.splice(dragged,1)[0];state.stops.splice(target,0,item);state.optimize=false;editorChanged()}
      dragged=undefined;
    };
    root.ondragend=()=>{dragged=undefined};
    async function loadBase(){
      if(loadingBase||!alive||!map)return;
      loadingBase=true;
      try {
        if(!window.attachDFWBasemap)await script('./vendor/basemap/dfw-layer.js');
        if(alive)base=await window.attachDFWBasemap(map,msg=>{if(alive)find('.pr-base').textContent=msg},()=>alive,styleId);
        base?.setStyle(styleId);
      } catch(err){if(alive)find('.pr-base').textContent='底图加载失败，可重试。'+err.message}
      finally{loadingBase=false}
    }
    fields();results();
    (async()=>{
      if(!window.L)await script('./vendor/leaflet.js');if(!alive)return;
      if(!window.US_STATES)await script('./vendor/us-states.js');if(!alive)return;
      map=L.map(find('.pr-map'),{minZoom:1,maxZoom:18,zoomAnimation:false,fadeAnimation:false,scrollWheelZoom:true}).setView([32.78,-96.803],13);
      map.createPane('roadGeometry').style.zIndex=450;
      lines=L.layerGroup().addTo(map);markers=L.featureGroup().addTo(map);drawMap(true);
      L.geoJSON(window.US_STATES,{interactive:false,style:{color:'#abc2b7',weight:1,fillColor:'#eff3ee',fillOpacity:.75}}).addTo(map);
      const view=pref.get('view',null);
      if(view&&[view.lat,view.lng,view.zoom].every(Number.isFinite))map.setView([view.lat,view.lng],view.zoom,{animate:false});
      map.on('moveend',()=>{if(!alive)return;const pos=map.getCenter();pref.set('view',{lat:pos.lat,lng:pos.lng,zoom:map.getZoom()})});
      DispatchViews.bind(map,root,pref,{home:()=>{if(state.origin.lat!==''&&state.origin.lon!=='')map.setView([Number(state.origin.lat),Number(state.origin.lon)],13,{animate:false})},route:()=>drawMap(true),style:id=>{styleId=id;base?.setStyle(id)}});
      await loadBase();
    })().catch(err=>{if(alive)find('.pr-base').textContent='底图未载入。'+err.message+'；可继续核对地址与站序。'});
    return {destroy(){alive=false;generation++;controller?.abort();map?.stop();base?.remove();map?.remove()}};
  }
  return {mount,storageKey};
})();
