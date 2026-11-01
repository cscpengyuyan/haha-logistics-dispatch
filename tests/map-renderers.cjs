/* Controlled offline renderer comparison. Pass the extracted MapLibre 5.24.0 dist directory.
 * Run node tests/map-renderers.cjs <dist>. The deployed app never imports this benchmark. */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),os=require('node:os');
const {chromium}=require('playwright');
const vendor=path.resolve('v12/vendor'),glDir=path.resolve(process.argv[2]);
const sdk={Leaflet:[path.join(vendor,'leaflet.js'),path.join(vendor,'leaflet.css')],MapLibre:[path.join(glDir,'maplibre-gl.js'),path.join(glDir,'maplibre-gl.css')]};
const us=JSON.parse(fs.readFileSync(path.join(vendor,'us-states.js'),'utf8').split('=').slice(1).join('=').trim().replace(/;$/,''));
const roadfile=JSON.parse(fs.readFileSync(path.join(vendor,'us-roads-2025.json')));
const roads=[];
for(const [name,kind,encoded] of roadfile.roads){
 let i=0,x=0,y=0;const points=[];
 function delta(){let shift=0,v=0,c;do{c=encoded.charCodeAt(i++)-63;v|=(c&31)<<shift;shift+=5}while(c>=32);return (v&1)?~(v>>1):v>>1}
 while(i<encoded.length){y+=delta();x+=delta();points.push([x/1e4,y/1e4])}
 if(points.some(([lng,lat])=>lng>-97.9&&lng<-96.25&&lat>32.4&&lat<33.3))roads.push({type:'Feature',properties:{name,kind},geometry:{type:'LineString',coordinates:points}});
}
const pts=Array.from({length:1000},(_,i)=>({type:'Feature',properties:{},geometry:{type:'Point',coordinates:[-97.57+(i%40)*.029,32.50+Math.floor(i/40)*.028]}}));
const feat=features=>({type:'FeatureCollection',features}),payload=JSON.stringify({us,roads:feat(roads),orders:feat(pts)});
const html='<!doctype html><meta charset=utf-8><title>Offline renderer A/B</title><style>*{box-sizing:border-box}body{margin:0;font:16px Segoe UI;color:#123c36}header{height:54px;background:#eef4ed;padding:15px 24px;font-weight:bold}#map{height:calc(100vh - 90px);background:#e4ece7}footer{font:12px Segoe UI;padding:9px 20px}</style><header>Dallas · 1,000 synthetic delivery points · <span id=name></span></header><div id=map></div><footer>Geography: U.S. Census · 2025 offline roads and state boundaries. Synthetic sites, no traffic or live geocoding.</footer>';
(async()=>{
 const server=http.createServer((req,res)=>{
  const pathname=req.url.split('?')[0];if(pathname==='/data'){res.setHeader('Content-Type','application/json');res.end(payload);return}
  const match=pathname.match(/^\/(Leaflet|MapLibre)\.(js|css)$/);
  if(match){res.setHeader('Content-Type',match[2]==='js'?'text/javascript':'text/css');res.end(fs.readFileSync(sdk[match[1]][match[2]==='js'?0:1]));return}
  res.setHeader('Content-Type','text/html');res.end(html)
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const b=await chromium.launch({channel:'msedge',headless:true});const results={device:os.cpus()[0].model,browser:b.version(),viewport:'1366x768',orders:1000,roads:roads.length,states:us.features.length,source:'Identical local GeoJSON in a fresh context for each renderer. Time includes local SDK/CSS/data transfer to first frame; pan includes next draw. Three trials per renderer.'};
 try{for(const name of ['Leaflet','MapLibre']){
   const bytes=sdk[name].map(p=>fs.readFileSync(p)).reduce((sum,x)=>sum+x.length,0),gz=sdk[name].reduce((sum,p)=>sum+zlib.gzipSync(fs.readFileSync(p)).length,0);
   results[name]={version:name==='Leaflet'?'1.9.4':'5.24.0',sdk_css_bytes:bytes,gzip_bytes:gz,trials:[]};
   for(let n=0;n<3;n++){
     const c=await b.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1}),p=await c.newPage();
     await p.goto(url);const measured=await p.evaluate(async name=>{
       const t=performance.now();document.querySelector('#name').textContent=name;
       const css=document.createElement('link');css.rel='stylesheet';css.href='/'+name+'.css';
       const lib=document.createElement('script');lib.src='/'+name+'.js';
       const d=await Promise.all([new Promise((r,j)=>{css.onload=r;css.onerror=j;document.head.append(css)}),new Promise((r,j)=>{lib.onload=r;lib.onerror=j;document.head.append(lib)}),fetch('/data').then(r=>r.json())]).then(x=>x[2]);
       const frame=()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
       let m;const canvas=name==='Leaflet',points=[-96.98,32.84];
       if(canvas){m=L.map('map',{preferCanvas:true,zoomControl:false,attributionControl:false,zoomAnimation:false}).setView(points.slice().reverse(),10);
         L.geoJSON(d.us,{interactive:false,style:{fillColor:'#e4ece1',fillOpacity:1,color:'#a9b8b0',weight:1}}).addTo(m);
         L.geoJSON(d.roads,{interactive:false,style:{color:'#b8a78a',weight:2}}).addTo(m);
         L.geoJSON(d.orders,{pointToLayer:(_,ll)=>L.circleMarker(ll,{radius:3,stroke:false,fillColor:'#127963',fillOpacity:.9})}).addTo(m);await frame();
       }else{
         const get=data=>({type:'geojson',data});
         try{m=new maplibregl.Map({container:'map',center:points,zoom:9,attributionControl:false,style:{version:8,sources:{state:get(d.us),road:get(d.roads),orders:get(d.orders)},layers:[{id:'state',type:'fill',source:'state',paint:{'fill-color':'#e4ece1'}},{id:'road',type:'line',source:'road',paint:{'line-color':'#b8a78a','line-width':2}},{id:'dots',type:'circle',source:'orders',paint:{'circle-radius':3,'circle-color':'#127963','circle-opacity':.9}}]}})}catch(err){return {error:String(err)}}
         await Promise.race([m.once('idle'),new Promise((_,bad)=>setTimeout(()=>bad(Error('No WebGL frame in 12 s')),12000))]);await frame();
       }
       const ready=performance.now()-t,t2=performance.now();
       if(canvas)m.panBy([90,20],{animate:false});else {const next=m.once('idle');m.panBy([90,20],{duration:0});await next}
       await frame();return {first_frame_ms:Math.round(ready),pan_frame_ms:Math.round(performance.now()-t2)};
     },name).catch(e=>({error:e.message}));
     results[name].trials.push(measured);
     if(n===2)await p.screenshot({path:'docs/evidence/map/renderer-'+name+'.png'});
     await c.close();
   }
 }fs.writeFileSync('docs/evidence/map/renderers.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
 }finally{await b.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
