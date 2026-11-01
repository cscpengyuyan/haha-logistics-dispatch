'use strict';
// Public, synthetic loads only. All distances and times come from the local Valhalla truck graph.
window.DallasRoad = (() => {
  const assetRoot = new URL('./vendor/dallas-road/', document.currentScript.src);
  const manifest = new URL('dallas-20261031/manifest.json', assetRoot).href;
  const source = 'Valhalla 3.8.3 truck · Dallas OSM 2026-10-31 · 演练小队列穷举排序';
  let engine;
  async function router() {
    engine ??= import(new URL('dist/index.js', assetRoot).href)
      .then(m => m.createRouter({manifestUrl: manifest, transport:'individual-tiles', memoryBudgetBytes:64*1024*1024}))
      .catch(error => {engine = null; throw error});
    return engine;
  }
  function shape(encoded) {
    let pos=0, lat=0, lon=0;
    const result=[];
    function delta() {
      let n=0, shift=0, b;
      do {
        if (pos>=encoded.length || shift>30) throw Error('路网返回了无效几何');
        b=encoded.charCodeAt(pos++)-63; n|=(b&31)<<shift; shift+=5;
      } while (b>=32);
      return n&1 ? ~(n>>1) : n>>1;
    }
    while (pos<encoded.length) {lat+=delta(); lon+=delta(); result.push([lat/1e6,lon/1e6])}
    return result;
  }
  async function plan(input, {signal}={}) {
    const {points, stops, truck, depart, limit, shiftEnd, optimize} = input;
    if (!Array.isArray(stops) || !stops.length || stops.length>6 || points.length!==stops.length+1)
      throw Error('公开试排支持一仓 1 至 6 站');
    if (points.some(p=>!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||p.lat<32.73||p.lat>32.88||p.lon< -96.94||p.lon> -96.73))
      throw Error('站点超出 Dallas 市区演练路网，请核对入口坐标');
    if (![depart,shiftEnd,limit,...Object.values(truck)].every(Number.isFinite) || shiftEnd<=depart || limit<=0)
      throw Error('请核对发车时间、班次及车辆参数');
    if (stops.some(s=>![s.open,s.close,s.service,s.kg].every(Number.isFinite)||s.service<=0||s.kg<=0||s.close<s.open+s.service))
      throw Error('预约窗不足以完成作业，或作业时长、重量缺失');
    if (stops.reduce((v,s)=>v+s.kg,0)>limit) throw Error('总货重超过车辆可用载重，请拆线');
    const client=await router(), matrix=points.map(()=>[]);
    for (let i=0;i<points.length;i++){
      for (let j=1;j<points.length;j++){
        if (i===j || (!optimize && j!==i+1)) continue;
        signal?.throwIfAborted();
        const r=await client.route({origin:{lat:points[i].lat,lon:points[i].lon},destination:{lat:points[j].lat,lon:points[j].lon},
          costing:'truck',costing_options:{truck}}, {signal});
        const leg=r.native.trip.legs[0];
        matrix[i][j]={duration:leg.summary.time, distance:leg.summary.length*1000, geometry:shape(leg.shape)};
      }
    }
    let best;
    function visit(order,clock,driving,legs,geometry) {
      if (best && driving>=best.driving) return;
      if (order.length===stops.length) {best={order,driving,legs,geometry};return}
      const from=order.at(-1)??0;
      for (let j=1;j<points.length;j++) {
        if (order.includes(j) || (!optimize && j!==order.length+1)) continue;
        const leg=matrix[from][j], stop=stops[j-1];
        const arrival=clock+leg.duration/60, departure=Math.max(arrival,stop.open)+stop.service;
        if (departure>stop.close || departure>shiftEnd) continue;
        visit([...order,j],departure,driving+leg.duration,
          [...legs,{distance:leg.distance,duration:leg.duration,arrival,departure}],
          [...geometry,...leg.geometry.slice(geometry.length?1:0)]);
      }
    }
    visit([],depart,0,[],[]);
    if (!best) throw Error('按实际道路行时，无站序可同时满足预约完工窗和车组班次');
    return {...best,source,timestamp:new Date().toISOString()};
  }
  return {plan};
})();
