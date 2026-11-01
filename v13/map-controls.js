/* Shared map view controls. The basemap receives only tile requests from the viewport. */
window.DispatchViews = (() => {
  const extents = {
    us: [[18,-179.9],[72,-66]],
    lower48: [[24.3,-125],[49.6,-66.5]],
    ak: [[51,-179.9],[71.7,-129.7]],
    hi: [[18.8,-160.5],[22.4,-154.7]]
  };
  const styles={local:'本地州界 / Dallas 街道',light:'本地浅色调度',liberty:'标准街道 · OpenFreeMap',positron:'浅色调度 · OpenFreeMap'};
  function prefs(ctx,screen){
    const prefix=['haha-map',location.pathname,ctx.publicDemo?'public':ctx.demo?'training':'staff',ctx.user?.username||'guest',screen].join(':')+':';
    return {
      get(key,fallback){try{return JSON.parse(localStorage.getItem(prefix+key))??fallback}catch{return fallback}},
      set(key,value){try{localStorage.setItem(prefix+key,JSON.stringify(value))}catch{}}
    };
  }
  const html='<label>范围 <select data-map-view aria-label="地图范围"><option value="">选择视野</option><option value="us">美国全国</option><option value="lower48">本土48州</option><option value="ak">阿拉斯加</option><option value="hi">夏威夷</option><option value="home">当前仓</option><option value="route">适配全线</option></select></label> '+
    '<label>底图 <select data-map-style aria-label="底图样式">'+Object.entries(styles).map(([id,label])=>'<option value="'+id+'">'+label+'</option>').join('')+'</select></label>';
  function fit(map,id){if(extents[id])map.fitBounds(extents[id],{padding:[7,7],animate:false})}
  function bind(map,host,pref,{home,route,style}){
    const select=host.querySelector('[data-map-style]'),views=host.querySelector('[data-map-view]');
    select.value=Object.hasOwn(styles,pref.get('style','local'))?pref.get('style','local'):'local';
    function apply(){
      map.getContainer().dataset.basemap=select.value;
      style(select.value);
    }
    apply();
    select.onchange=()=>{pref.set('style',select.value);apply()};
    views.onchange=()=>{const id=views.value;if(id==='home')home();else if(id==='route')route();else fit(map,id);views.value=''};
    const el=map.getContainer();
    const describe=()=>{el.dataset.zoom=String(map.getZoom())};
    describe();map.on('zoomend',describe);
  }
  return {prefs,html,fit,bind};
})();
