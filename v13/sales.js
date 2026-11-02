/* Sales and logistics share the same workbook, mapping and preview contract. */
window.HHSales = (() => {
  'use strict';
  const e = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const options = (entries,selected='')=>Object.entries(entries).map(([k,v])=>`<option value="${e(k)}" ${k===selected?'selected':''}>${e(v)}</option>`).join('');
  const csvValue = text => '"'+String(text ?? '').replaceAll('"','""')+'"';
  const to64 = data => new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('无法读取文件'));reader.readAsDataURL(data);
  });
  function download(data,name) {
    const url=URL.createObjectURL(data),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  async function mount(host,ctx,params) {
    const api=(path,body)=>ctx.api('/api/sales/'+path,body?{method:'POST',body}:{});
    host.innerHTML='<section class="wf-board"><header class="wf-board-head"><div><small class="wf-overline">SALES INTAKE</small><h2>销售交单</h2></div></header><div class="wf-form"><div class="wf-full"><button type="button" data-act="template">下载交单模板</button> <button type="button" data-act="example">下载填写示例</button> <button type="button" data-act="online">在线填写</button></div><label class="field wf-full"><span>上传 XLSX / UTF-8 CSV 预检</span><input type="file" accept=".xlsx,.csv" data-file></label><p class="muted wf-full">工作簿第 5 行为表头。以 CRM 订单号、站点编号和明细行号匹配，保留编号前导零。公开演练请使用虚构数据。</p></div><div data-entry></div><div data-preview aria-live="polite"></div><div data-message role="status"></div></section><section class="wf-board"><header class="wf-board-head"><h2>销售交接记录</h2></header><div data-lines></div></section>';
    let fields={},enums={},lines=[],file=null,report=null,mapping={},busy=false;
    const at=s=>host.querySelector(s),message=t=>{at('[data-message]').textContent=t};
    function formFields(facts={},exclude=[]) {
      return Object.entries(fields).filter(([k])=>!exclude.includes(k)).map(([k,v])=>{
        const opts=enums[k],val=facts[k]??'';
        const input=opts?`<select name="${e(k)}">${options(Object.fromEntries(['',...new Set([...opts,val])].map(x=>[x,x||'待填写'])),val)}</select>`:`<input name="${e(k)}" maxlength="2000" value="${e(val)}">`;
        return `<label class="field"><span>${e(v)}</span>${input}</label>`;
      }).join('');
    }
    async function list() {
      const ledger=await api('lines');lines=ledger.lines;
      const chosen=params?.get('focus')||'';
      at('[data-lines]').innerHTML=lines.length?lines.map(l=>{
        const f=l.facts,status=l.pending?'范围变更待复核':l.rejected?'改版已驳回 · 保留原签约条件':l.status==='intake'?(l.missing.length?'待补资料':'待物流接手'):'已接手';
        return `<article class="wf-form" data-line="${e(l.id)}"><div class="wf-full"><strong>${e(f.crm_ref)} / ${e(f.site_id)} / ${e(f.line_id)}</strong> · ${e(f.model)} × ${e(f.quantity)} · ${e(f.zip)} · v${e(l.rev)} · ${status}</div>
          <div class="wf-full">${l.status==='intake'&&l.missing.length?'销售待补：'+l.missing.map(e).join('、'):e(l.accepted||'等待物流核对已购终点及证据')}</div>
          <div class="wf-full"><button data-act="open" data-id="${e(l.id)}">查看订单</button> <button data-act="history" data-id="${e(l.id)}">版本与原件</button>
          ${l.status==='intake'||l.pending?`<button data-act="correct" data-id="${e(l.id)}">修正销售事实</button>`:''}
          ${['dispatch','admin'].includes(ctx.user.role)&&(l.status==='intake'||l.pending&&['new','ready'].includes(l.status))?`<button data-act="handoff" data-id="${e(l.id)}">澄清终点并接手</button>`:''}
          ${l.pending&&['dispatch','admin'].includes(ctx.user.role)?`<label class="field"><span>客户确认继续执行原委托的书面依据</span><input data-reject-ref></label><button data-act="reject" data-id="${e(l.id)}">驳回改版，保留原委托</button>`:''}</div></article>`;
      }).join(''):'<p class="muted">暂无交单。先上传工作簿预检，或在线录入一条明细。</p>';
      if(ledger.unmatched.length)at('[data-lines]').insertAdjacentHTML('beforeend','<details><summary>待匹配的现场补充 · '+ledger.unmatched.length+'</summary><p>先登记销售主明细，再重新上传对应现场补充工作簿。</p>'+ledger.unmatched.map(s=>'<p>'+e(s)+'</p>').join('')+'</details>');
      if(chosen)Array.from(at('[data-lines]').children).find(el=>el.dataset.line===chosen)?.scrollIntoView({block:'nearest'});
    }
    function showPreview() {
      const p=report;
      const corrections=`<details class="wf-full"><summary>按原表行号校正单元格</summary><p>保留上传原件。校正仅作用于当前导入，经预检确认后记入字段来源。现场补充行如有门净宽或净高列，留空表示撤回该测量值。</p>
        <div class="wf-form"><label class="field">工作表<select data-fix-sheet>${options(Object.fromEntries(p.sheets.map(s=>[s,s])))}</select></label>
        <label class="field">原表行号<input data-fix-row type="number" min="2" value="${file.filename.toLowerCase().endsWith('.csv')?'2':'6'}"></label>
        <label class="field">原表已映射字段<select data-fix-key>${options(fields)}</select></label>
        <label class="field">校正值<input data-fix-value maxlength="2000"></label><button data-act="fix">应用校正并预检</button></div>
        ${p.corrections.map((c,i)=>`<p>${e(c.sheet)} · 第 ${e(c.row)} 行 · ${e(fields[c.field])} → ${e(c.value)||'（空）'} <button data-act="unfix" data-idx="${i}">撤销校正</button></p>`).join('')}</details>`;
      const maps=p.unmapped.length?`<details open><summary>未映射列 ${p.unmapped.length}</summary><p>可映射到系统字段或保留在原文件中。确认导入会记住映射。</p>${p.unmapped.map(h=>`<label class="field"><span>${e(h)}</span><select data-header="${e(h)}">${options({'':'仅留原件',...fields})}</select></label>`).join('')}<button data-act="map">应用映射并重新预检</button></details>`:'';
      at('[data-preview]').innerHTML=`<div class="wf-form"><h3 class="wf-full">导入预检 · ${p.count} 条明细</h3><div class="wf-full">${maps}${[...p.errors,...p.unmatched.map(x=>'待匹配：'+x)].map(x=>`<p>${e(x)}</p>`).join('')}
        ${p.rows.map(r=>`<article><strong>${e(r.key.join(' / '))}</strong> · ${e(r.state)} · ${e(r.rows.join('、'))}
          ${r.missing.length?'<p>销售待补：'+r.missing.map(e).join('、')+'</p>':''}
          ${Object.keys(r.changes).length?'<ul>'+Object.entries(r.changes).map(([k,[a,b]])=>`<li>${e(fields[k])}　${e(a)||'（空）'} → ${e(b)||'（空）'}</li>`).join('')+'</ul>':''}
          ${r.impact.length?'<p>待重新核验：'+r.impact.map(e).join('、')+'</p>':''}</article>`).join('')}</div>
        ${corrections}<div class="wf-full"><button data-act="confirm" class="primary" ${p.errors.length||!p.count&&!p.unmatched.length?'disabled':''}>确认导入</button> <button data-act="issues">导出预检结果</button></div></div>`;
    }
    async function preview() {
      report=await api('preview',{...file,mapping});showPreview();message('预检完成。请核对后确认。');
    }
    function online(line,receiving) {
      const details=at('[data-entry]'),facts=(receiving?line?.handoff_facts:line?.facts)||{};
      const isDemo=ctx.demo&&facts.crm_ref==='DEMO-DAL-02'&&facts.address==='Synthetic loading entrance · Main St';
      details.innerHTML=`<form class="wf-form"><h3 class="wf-full">${receiving?'物流接手 · 核对合同交接点':line?'销售修正事实':'在线交单'}</h3>
        ${receiving?`<label class="field"><span>已核服务终点</span><select name="level" required>${options({'':'选择合同层级',L1:'L1 基础交接',L2:'L2 指定入口',L3:'L3 指定机位'})}</select></label>
        ${isDemo?'<label class="field"><span>演练现场凭据</span><span><input type="checkbox" name="confirm_demo_site"> 核对 SIM-MAIN-ST-DOCK 合成装卸口与包装版本</span></label>':''}
        <details class="wf-full"><summary>查看或澄清交单事实</summary><div class="wf-form">${formFields(facts,['crm_ref','site_id','line_id'])}</div></details>`:formFields(facts)}
        <div class="wf-full"><button class="primary" type="submit">${receiving?'确认接手':'预检本行'}</button> <button type="button" data-act="close">收起</button></div></form>`;
      details.scrollIntoView({block:'nearest'});
      details.querySelector('form').onsubmit=async ev=>{
        ev.preventDefault();if(busy)return;busy=true;
        try {
          const values=Object.fromEntries(new FormData(ev.currentTarget));
          if(receiving) {
            const {level,confirm_demo_site,...facts}=values;
            await api('handoff',{id:line.id,version:line.version,level,confirm_demo_site:confirm_demo_site==='on',facts});
            details.replaceChildren();await ctx.refresh();ctx.toast('物流已接手，请由仓管确认可用实物。');return;
          }
          const columns=Object.keys(fields),csv=[columns.map(k=>csvValue(fields[k])).join(','),columns.map(k=>csvValue(values[k])).join(',')].join('\r\n');
          file={filename:'在线交单.csv',base64:await to64(new Blob([csv],{type:'text/csv;charset=utf-8'}))};mapping={};await preview();
        } catch(err){message(err.message)}finally{busy=false}
      };
    }
    at('[data-file]').onchange=async ev=>{
      const item=ev.target.files[0];if(!item)return;
      report=null;file=null;mapping={};at('[data-preview]').replaceChildren();
      try{if(item.size>4000000)throw Error('文件超过 4 MB');file={filename:item.name,base64:await to64(item)};await preview()}catch(err){message(err.message)}
    };
    host.onclick=async ev=>{
      const b=ev.target.closest('[data-act]');if(!b||busy)return;const what=b.dataset.act;
      busy=true;
      try {
        if(['template','example'].includes(what)){
          const res=await api(what);download(new Blob([Uint8Array.from(atob(res.base64),v=>v.charCodeAt(0))]),(what==='example'?'销售交单收集表_填写示例':'销售交单收集表_系统模板')+'.xlsx');return;
        }
        if(what==='map'){at('[data-preview]').querySelectorAll('[data-header]').forEach(s=>{if(s.value)mapping[s.dataset.header]=s.value});await preview();return}
        if(what==='fix'||what==='unfix'){
          const corrections=report.corrections.slice();
          if(what==='unfix')corrections.splice(Number(b.dataset.idx),1);
          else{
            const cell={sheet:at('[data-fix-sheet]').value,row:Number(at('[data-fix-row]').value),field:at('[data-fix-key]').value,value:at('[data-fix-value]').value};
            const index=corrections.findIndex(c=>c.sheet===cell.sheet&&c.row===cell.row&&c.field===cell.field);
            if(index===-1)corrections.push(cell);else corrections[index]=cell;
          }
          report=await api('preview',{...file,mapping,corrections});file.corrections=corrections;showPreview();message('校正后预检已更新。');return;
        }
        if(what==='confirm'){const r=await api('confirm',{...file,mapping,token:report.token});await ctx.refresh();ctx.toast(`已登记：新增 ${r.added} 条，变更 ${r.changed} 条。`);return}
        if(what==='issues'){download(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'交单逐行预检.json');return}
        if(what==='close'){at('[data-entry]').replaceChildren();return}
        if(what==='open'){ctx.openOrder(b.dataset.id);return}
        if(what==='history'){
          const {history}=await api('history/'+encodeURIComponent(b.dataset.id)),entry=at('[data-entry]');
          entry.innerHTML='<section class="wf-form"><h3 class="wf-full">交单版本及字段来源</h3>'+history.map(v=>
            `<details class="wf-full"><summary>v${v.rev} · ${e(v.ts)} · ${e(v.actor)} · ${e(v.name)}</summary>
             <button data-act="source" data-source="${e(v.source)}">下载这次的原件</button>
             <dl>${Object.entries(v.facts).filter(([,value])=>value).map(([k,value])=>`<dt>${e(fields[k]||k)} · ${e(v.origin[k]||'沿用前版')}</dt><dd>${e(value)}</dd>`).join('')}</dl></details>`).join('')+'<button data-act="close">收起</button></section>';
          entry.scrollIntoView({block:'nearest'});return;
        }
        if(what==='source'){const v=await api('source/'+encodeURIComponent(b.dataset.source));download(new Blob([Uint8Array.from(atob(v.base64),c=>c.charCodeAt(0))]),v.filename);return}
        if(what==='reject'){
          const line=lines.find(l=>l.id===b.dataset.id),evidence=b.closest('article').querySelector('[data-reject-ref]').value;
          if(!evidence.trim())throw Error('请先填写继续执行原委托的书面依据。');
          await api('reject-change',{id:line.id,version:line.version,evidence});await ctx.refresh();ctx.toast('已留存依据，原委托条件继续有效。');return;
        }
        if(['online','correct','handoff'].includes(what))online(lines.find(l=>l.id===b.dataset.id),what==='handoff');
      }catch(err){message(err.message)}finally{busy=false}
    };
    try{({fields,enums}=await api('schema'));await list()}catch(err){message(err.message)}
  }
  return {mount};
})();
