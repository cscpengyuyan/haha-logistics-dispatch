/* The pilot's street map is self-hosted. Leaflet retains the dispatcher selections and overlays. */
(() => {
  const base = new URL('./',document.currentScript.src);
  const file = name => new URL(name,base).href;
  let libs;
  function script(name){
    return new Promise((resolve,reject)=>{
      const tag=document.createElement('script');tag.src=file(name);
      tag.onload=resolve;tag.onerror=()=>{tag.remove();reject(new Error(name))};
      document.head.append(tag);
    });
  }
  async function ready(){
    if(!libs){
      libs=(async()=>{
        if(!document.querySelector('link[data-dfw-style]')){
          const css=document.createElement('link');css.dataset.dfwStyle='1';
          css.rel='stylesheet';css.href=file('maplibre.css');document.head.append(css);
        }
        await Promise.all([window.maplibregl||script('maplibre.js'),window.pmtiles||script('pmtiles.js')]);
        if(!L.maplibreGL)await script('leaflet-gl.js');
        maplibregl.setWorkerUrl(file('worker.js'));
        const protocol=new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles',protocol.tile);
      })().catch(err=>{libs=null;throw err});
    }
    return libs;
  }
  function style(){
    const paint=(id,layer,type,paint,extra={})=>({id,type,source:'dfw','source-layer':layer,paint,...extra});
    const name=['coalesce',['get','name:en'],['get','name'],''];
    const label={'text-font':['Noto Sans Regular'],'text-field':name,'text-size':11};
    const ink={'text-color':'#415565','text-halo-color':'#fffffa','text-halo-width':1.5};
    return {version:8,glyphs:file('fonts/')+'{fontstack}/{range}.pbf',
      sources:{dfw:{type:'vector',url:'pmtiles://'+file('dfw.pmtiles'),bounds:[-97.12,32.68,-96.65,32.98]}},
      layers:[
        paint('land-use','landuse','fill',{'fill-color':['match',['get','kind'],'park','#d7ebd8','forest','#cce4ca','industrial','#e1e4e8','residential','#f0ede6','#e3e9dd'],'fill-opacity':0.7}),
        paint('water','water','fill',{'fill-color':'#b2d9e6'}),
        paint('buildings','buildings','fill',{'fill-color':'#d7d5cf','fill-outline-color':'#c7c6c0'},{minzoom:12}),
        paint('streets','roads','line',{'line-color':'#fafbf8','line-width':['interpolate',['linear'],['zoom'],7,0.5,12,1.7,17,8]}),
        paint('major-roads','roads','line',{'line-color':['match',['get','kind'],'highway','#e0a665','#edc386'],'line-width':['interpolate',['linear'],['zoom'],7,1,12,2.2,17,9]},{filter:['in',['get','kind'],['literal',['highway','major_road']]]}),
        paint('street-names','roads','symbol',ink,{minzoom:12,layout:{...label,'symbol-placement':'line','symbol-spacing':170}}),
        paint('cities','places','symbol',ink,{layout:{...label,'text-size':13},filter:['in',['get','kind'],['literal',['locality','neighbourhood','neighborhood']]]})
      ]};
  }
  window.attachDFWBasemap=async(map,notify,alive)=>{
    await ready();if(!alive())return;
    const bounds=L.latLngBounds([[32.68,-97.12],[32.98,-96.65]]);
    map.createPane('dfwStreets').style.zIndex=415;
    const layer=L.maplibreGL({style:style(),interactive:false,pane:'dfwStreets',attributionControl:false,padding:0.08});
    let failed=false,loaded=false;
    const update=()=>{
      if(alive() && map.getZoom()>=8 && bounds.intersects(map.getBounds()))
        notify(failed?'部分街道瓦片未载入 · 移动地图或重试':loaded?'达拉斯街道 · Protomaps 2026-10-31':'正在加载达拉斯街道');
      else if(alive())notify('美国州界、城市与主干道');
    };
    layer.addTo(map);
    const gl=layer.getMaplibreMap();
    gl.on('idle',()=>{
      if(!alive() || !gl.getLayer('street-names'))return;
      const names=gl.queryRenderedFeatures({layers:['street-names']}).map(f=>f.properties?.['name:en']||f.properties?.name).filter(Boolean);
      const visible=[...new Set(names)].slice(0,5).join('、');
      map.getContainer().setAttribute('aria-description',visible?'当前街道 '+visible:'可缩放至达拉斯试点查看街名');
    });
    gl.on('error',()=>{failed=true;update()});
    gl.on('sourcedata',ev=>{if(ev.sourceId==='dfw' && ev.sourceDataType==='content'){loaded=true;failed=false;update()}});
    const credit='Protomaps · © <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap contributors</a>';
    map.attributionControl?.addAttribution(credit);
    map.on('moveend',update);update();
    return {retry(){gl.setStyle(style(),{diff:false});failed=false;update()},
      remove(){map.off('moveend',update);map.attributionControl?.removeAttribution(credit);layer.remove()}};
  };
})();
