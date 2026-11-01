'use strict';
window.OceanDesk={
  mount(host,ctx){
    const e=ctx.escape;
    host.innerHTML='<section class="supply-card" data-multi></section><section class="supply-card" data-single></section><section class="supply-card" data-legacy></section>';
    const panel=host.querySelector('[data-multi]');
    const legacy=host.querySelector('[data-legacy]');
    legacy.innerHTML='<details><summary>历史海运交接登记 · '+(ctx.resources||[]).filter(r=>r.type==='inbound').length+' 条</summary><div></div></details>';
    window.Resources.mount(legacy.querySelector('details>div'),ctx,'ocean');
    function updateOverview(shipments){
      const savedWarehouse=panel.querySelector('select')?.value||'';
      const places=[...new Set(shipments.map(s=>s.warehouse))];
      panel.innerHTML='<small>OCEAN CAPACITY</small><h2>多航次到仓计划</h2><label>目的仓 <select><option value="">全部仓库</option>'+places.map(s=>'<option>'+e(s)+'</option>').join('')+'</select></label> <button data-export>导出当前排期 CSV</button><div data-lanes></div>';
      const select=panel.querySelector('select');
      if(places.includes(savedWarehouse))select.value=savedWarehouse;
      const rows=()=>shipments.filter(s=>!select.value||s.warehouse===select.value);
      const localDay=(t,z)=>new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.parse(t));
      function draw(){
        const set=rows(),loads=new Map();
        const lo=Math.min(...set.map(s=>Date.parse(s.planned_etd))),hi=Math.max(...set.map(s=>Math.max(Date.parse(s.warehouse_eta),Date.parse(s.planned_warehouse))));
        const scale=t=>100*(Date.parse(t)-lo)/Math.max(hi-lo,1);
        const lanes=set.map(s=>{
          const day=localDay(s.warehouse_eta,s.warehouse_zone),d=new Date(day+'T12:00:00Z');
          d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
          const key=s.warehouse+' · '+d.toISOString().slice(0,10),n=s.units.filter(u=>!u.receipt).length;
          const load=loads.get(key)||{n:0,count:0};load.n+=n;load.count++;loads.set(key,load);
          const p=scale(s.planned_etd),bar=(end,color)=>'<div style="margin-left:'+p.toFixed(2)+'%;width:'+Math.max(0,scale(end)-p).toFixed(2)+'%;height:4px;margin-block:3px;background:'+color+'"></div>';
          return '<tr><td><a href="#ocean?batch='+encodeURIComponent(s.id)+'">'+e(s.voyage)+'</a><br>'+e(s.asn)+'</td><td style="min-width:8em" aria-label="冻结与预测时间条">'+bar(s.planned_warehouse,'#777')+bar(s.warehouse_eta,'#0c786d')+'</td><td>'+e(localDay(s.planned_warehouse,s.warehouse_zone))+' → '+e(day)+'<br>'+e(s.warehouse_zone)+'</td><td>'+n+' / '+s.units.length+'</td><td>'+e((s.reviews||[]).filter(x=>!x.closed_at).map(x=>x.reason).join(' · ')||'—')+'</td></tr>';
        });
        panel.querySelector('[data-lanes]').innerHTML='<div class="sc-scroll"><table><thead><tr><th>航次 / ASN</th><th>冻结（灰）／预测（绿）</th><th>到仓日期</th><th>待收 / 预报</th><th>改约待办</th></tr></thead><tbody>'+lanes.join('')+'</tbody></table></div><p>每周到仓负荷（周一起）　'+[...loads].map(([k,v])=>e(k)+' · '+v.n+' 台 / '+v.count+' 批'+(v.count>1?'，请确认收货能力':'')).join('　')+'</p>';
      }
      draw();select.onchange=draw;
      panel.querySelector('[data-export]').onclick=()=>{
        const csv=[['航次','ASN','仓库','冻结到仓 UTC','预测到仓 UTC','预报台数'],...rows().map(s=>[s.voyage,s.asn,s.warehouse,s.planned_warehouse,s.warehouse_eta,s.units.length])];
        const quote=x=>'"'+String(x).replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
        const url=URL.createObjectURL(new Blob(['\ufeff'+csv.map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));let a=document.createElement('a');a.href=url;a.download='ocean-schedules.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
      };
    }
    window.Supply.sea(host.querySelector('[data-single]'),ctx,updateOverview);
  }
};
