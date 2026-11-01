/* Financial and service review. Only coarse fields explicitly listed below leave through CSV. */
(() => {
  'use strict';
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd=x=>x==null?'待核':new Intl.NumberFormat('zh-CN',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(x);
  const rate=(n,d)=>d?(100*n/d).toFixed(1)+'%':'—';
  const txt={on_time:'原窗内到场',outside:'原窗外到场',not_due:'未到期',unknown:'待核',no_window:'缺原窗',unissued:'到期未派',
    success:'首次送成',partial:'首次部分完成',failed:'首次失败',missing:'未锁基线',matched:'同口径已锁',scope_changed:'范围已变 · 待核',expired:'基线已过期'};
  const csvCell=v=>{
    let s=String(v??'');
    if(/^[\s]*[=+@-]/.test(s)&&!/^[-+]?\d+(\.\d+)?$/.test(s))s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  };
  const opt=(v,n)=>'<option value="'+esc(v)+'">'+esc(n)+'</option>';
  function mount(host,ctx){
    let report,filter={},seq=0,alive=true,dialog=null;
    function shutdown(){if(dialog){dialog.remove();dialog=null}}
    function csv(){
      if(!report?.rows.length)return;
      const headers=['平台单号','ZIP前3位','服务档','路径','机型','计划台数','已签交台数','首派UTC日期','原约截止日','到场判定','首派物理交付','核账额USD','比较依据','原价USD','备选价USD','报价差额USD','基线减核账USD'];
      const records=report.rows.map(r=>[r.id,r.zip.slice(0,3),r.level,r.route,r.model,r.units,r.success_units,r.first_dispatch.slice(0,10),r.original_end.slice(0,10),txt[r.timing],txt[r.first_result],r.actual,txt[r.comparison],r.main,r.alt,r.quote_diff,r.settled_diff]);
      const content='\uFEFF'+[headers,...records].map(row=>row.map(csvCell).join(',')).join('\r\n');
      const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download='物流批次复盘-'+report.as_of+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
    }
    function baseline(r){
      const qs=(ctx.resources||[]).filter(v=>v.type==='quote'&&v.order_id===r.id&&v.comparison_ref&&v.evidence&&v.amount!=null&&v.pricing_status!=='incomplete');
      if(qs.length<2){ctx.toast?.('请先在海运与采购登记同票、同范围版本的两份有效书面全价。');return}
      shutdown();dialog=document.createElement('dialog');dialog.className='rv-dialog';
      const list=qs.map(q=>opt(q.id,q.carrier+' · '+q.path+' · '+usd(q.amount)+' · '+q.comparison_ref)).join('');
      dialog.innerHTML='<form><div class="rv-eyebrow">BASELINE SNAPSHOT</div><h2>锁定首派前比较基线</h2><p>'+esc(r.id)+' · 保留同范围主供原路径与备选方案的完整报价版本。</p><label>原路径可执行全价<select required name="main">'+list+'</select></label><label>备选方案全价<select required name="alt">'+list+'</select></label><label>复核凭据与范围说明<textarea required maxlength="600" name="confirmation" placeholder="说明首台/加台、多点折扣、终点、动作、原窗和全程成本口径的核验依据"></textarea></label><p class="rv-error" role="alert"></p><footer><button type="button" data-close>取消</button><button type="submit" class="primary">确认并留存版本</button></footer></form>';
      document.body.append(dialog);dialog.showModal();const f=dialog.querySelector('form');f.elements.alt.selectedIndex=1;
      f.querySelector('[data-close]').onclick=shutdown;f.onsubmit=async e=>{
        e.preventDefault();const b=f.querySelector('[type=submit]');b.disabled=true;
        try{
          const main=qs.find(q=>q.id===f.elements.main.value),alt=qs.find(q=>q.id===f.elements.alt.value);
          await ctx.api('/api/review/baseline',{method:'POST',body:{order_id:r.id,order_version:r.order_version,baseline_version:r.baseline_version,
            main_id:main.id,main_version:main.version,alt_id:alt.id,alt_version:alt.version,confirmation:f.elements.confirmation.value}});
          shutdown();await load();ctx.toast?.('已锁定财务比较基线');
        }catch(err){f.querySelector('.rv-error').textContent=err.message;b.disabled=false}
      };
    }
    function draw(){
      const s=report.summary;
      const card=(label,big,detail)=>'<section><small>'+label+'</small><b>'+big+'</b><p>'+detail+'</p></section>';
      const legend='<details class="rv-method"><summary>指标口径与证据缺口</summary><ul><li>仅公司配送。原约期按订单首次承诺的当地结束日选票；首派期按第一次派车签发的 UTC 日期选票，重派保留原归属。选择日期范围时，缺少该队列日期的订单单列。</li><li>到期按所选当地截止日终了。原窗准时以 F05 第一次到场对照原始窗口；时区无法直接比较或缺记录均标待核。下方同时列全部到期票及可判定票。</li><li>首次送成以第 1 次实作结果为准，部分交付与失败均未计入首次成功。最终成功台数采用全票签交人、完成动作、POD 齐全的台数，尚未全票签交的部分完成单据回原单查看。</li><li>财务取查询时最新已核账订单，未核账留在总样本。全批核账且有成功台数时，才给出每成功台成本。此处未采集付款流水，核账额不表示已付款。</li><li>锁定基线用于财务复盘，中选委托用于实际派单。价格比较仅覆盖同范围书面基线与匹配票，新增固定费、让利、未赔损失仍需另核。这里不计算净节省。</li></ul></details>';
      host.innerHTML='<div class="rv-panel"><form class="rv-filter"><label>批次归属<select name="basis">'+opt('promise','原约到期日 · 当地')+opt('dispatch','首次派单日 · UTC')+'</select></label><label>起日<input name="start" type="date"></label><label>止日<input name="end" type="date"></label><label>到期统计截止日<input name="as_of" type="date" required></label><label>持货仓<select name="warehouse">'+opt('','全部仓点')+report.warehouses.map(w=>opt(w,w)).join('')+'</select></label><label>目的 ZIP<input name="zip" maxlength="10" placeholder="完整或前缀"></label><label>交付层级<select name="level">'+opt('','全部服务档')+['L1','L2','L3'].map(v=>opt(v,v)).join('')+'</select></label><label>合同终点<input name="endpoint" placeholder="按关键字筛选"></label><div><button type="submit" class="primary">应用筛选</button> <button type="button" data-csv '+(report.rows.length?'':'disabled')+'>导出脱敏明细</button></div></form>'+
        '<div class="rv-kpis">'+card('纳入订单',s.orders+' 票','计划 '+s.plan_units+' 台 · 已完整签交 '+s.success_units+' 台')+
        card('原窗内到场 / 到期应到',rate(s.on_time,s.due),s.on_time+' / '+s.due+' 票 · 可判定 '+s.timed+' 票')+
        card('首次送成 / 已知首次结果',rate(s.first_success,s.outcome_known),s.first_success+' / '+s.outcome_known+' 票 · 到期 '+s.due+' 票')+
        card('全批每成功台成本',usd(s.cost_per_success),'已核 '+s.settled+' 票 · 待核 '+s.pending+' 票')+'</div>'+
        '<div class="rv-strip"><span>已核账小计 <b>'+usd(s.actual)+'</b> / '+s.settled+' 票</span><span>主备报价差 <b>'+usd(s.quote_diff)+'</b> / '+s.pairs+' 票</span><span>基线减核账 <b>'+usd(s.settled_diff)+'</b> / '+s.settled_pairs+' 票</span></div>'+
        '<div class="rv-flags">到期未派 '+s.due_unissued+' 票 · 到期未能判定到场 '+(s.due-s.timed)+' 票 · 缺原窗 '+s.no_window+' 票 · 缺队列日期另计 '+s.no_basis_date+' 票</div>'+legend+
        '<div class="rv-head"><div><span class="rv-eyebrow">ORDER EVIDENCE</span><h3>逐票核对</h3></div><small>仅导出平台单号及业务指标，邮编保留前三位</small></div><div class="rv-table"></div></div>';
      const form=host.querySelector('.rv-filter');for(const [k,v] of Object.entries({...filter,basis:report.basis,as_of:report.as_of}))if(form.elements[k])form.elements[k].value=v;
      form.onsubmit=e=>{e.preventDefault();filter=Object.fromEntries(new FormData(form));load()};
      form.querySelector('[data-csv]').onclick=csv;
      const box=host.querySelector('.rv-table');
      if(!report.rows.length){box.innerHTML='<div class="rv-empty">当前口径下没有订单。可调整批次归属或日期范围。</div>';return}
      box.innerHTML='<table><thead><tr><th>订单 / 服务</th><th>原窗口 / 首次到场</th><th>首次物理交付</th><th>计划 / 已签</th><th>已核账</th><th>基线 / 差额</th><th>办理</th></tr></thead><tbody>'+
        report.rows.map((r,i)=>'<tr><td><b>'+esc(r.id)+'</b><small>'+esc(r.warehouse)+' · '+esc(r.zip)+' · '+esc(r.level)+(r.addon_l4?'+L4':'')+(r.addon_l5?'+L5':'')+'</small></td><td>'+esc(txt[r.timing])+'<small title="'+esc(r.original_start+' ～ '+r.original_end+' · '+r.timezone)+'">原窗止 '+esc(r.original_end?.replace('T',' ')||'缺证')+'<br>首到 '+esc(r.arrival?.replace('T',' ')||'缺证')+'</small></td><td>'+esc(txt[r.first_result])+'</td><td>'+r.units+' / '+r.success_units+'</td><td>'+usd(r.actual)+'</td><td>'+esc(txt[r.comparison])+(r.baseline_trace?'<details><summary>快照 v'+r.baseline_version+'</summary><small>同版 '+esc(r.baseline_trace.comparison_ref)+'<br>原价 '+esc(r.baseline_trace.main)+'<br>备选 '+esc(r.baseline_trace.alt)+'<br>复核 '+esc(r.baseline_trace.actor)+' · '+esc(r.baseline_trace.ts)+'<br>'+esc(r.baseline_trace.confirmation)+'</small></details>':'')+'<small>主备 '+usd(r.quote_diff)+' · 减核账 '+usd(r.settled_diff)+'</small></td><td><button data-detail="'+i+'">查原单</button>'+(r.can_lock?' <button data-lock="'+i+'">锁基线</button>':'')+'</td></tr>').join('')+'</tbody></table>';
      box.onclick=e=>{const b=e.target.closest('button');if(!b)return;if('detail' in b.dataset)ctx.openOrder(report.rows[Number(b.dataset.detail)].id);else baseline(report.rows[Number(b.dataset.lock)])};
    }
    async function load(){
      const token=++seq;
      try{const d=await ctx.api('/api/review/query',{method:'POST',body:filter});if(!alive||token!==seq)return;report=d;draw()}
      catch(err){if(alive&&token===seq){host.innerHTML='<div class="rv-empty" role="alert">'+esc(err.message)+' <button>重设筛选</button></div>';host.querySelector('button').onclick=()=>{filter={};load()}}}
    }
    host.innerHTML='<p class="rv-empty">正在读取订单与核账凭据…</p>';load();
    return {destroy(){alive=false;shutdown()},refresh:load};
  }
  window.Review={mount};
})();
