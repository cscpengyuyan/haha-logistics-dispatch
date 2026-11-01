'use strict';
(() => {
  const types={warehouse:'仓点',vehicle:'车辆',crew:'车组',supplier:'供应商',inbound:'海运交接',quote:'承运报价'};
  const fields={warehouse:['address','lat','lng','timezone','evidence','notes'],vehicle:['capacity_units','door_cm','payload_kg','equipment','evidence','notes'],crew:['capacity_units','coverage','equipment','evidence','notes'],supplier:['address','coverage','model','ability','qualification','evidence','notes'],inbound:['batch','warehouse','stage','serials','custodian','evidence','notes'],quote:['order_id','carrier','path','scope','comparison_ref','amount','valid_until','evidence','notes']};
  const required={warehouse:['address','timezone'],vehicle:['capacity_units'],crew:['coverage'],supplier:['address','ability','qualification'],inbound:['batch','warehouse','stage','custodian','evidence'],quote:['order_id','carrier','path','scope','valid_until','evidence']};
  const labels={comparison_ref:'同范围询价版本号（用于横向比价）',name:'记录名称',address:'实际库址 / 执行地址',lat:'纬度',lng:'经度',timezone:'库址时区',evidence:'书面回执 / 原始凭据号',notes:'限制、条件与下次跟进',capacity_units:'核定可载台数',door_cm:'车门净高（cm）',payload_kg:'核定载重（kg）',equipment:'人员、工具及尾板条件',coverage:'服务区域 / ZIP',model:'适用机型',ability:'采购能力（T1–T5）',qualification:'准入状态',batch:'海运批次 / 分单号',warehouse:'指定收货仓',stage:'当前节点',serials:'设备序列号 / 清单引用',custodian:'当前保管人',order_id:'关联订单',carrier:'实际承运 / 报价方',path:'报价路径',scope:'终点、动作、窗口及全价包含项',amount:'全价（USD）',valid_until:'报价有效期'};
  const editors={warehouse:['warehouse','dispatch'],vehicle:['dispatch'],crew:['dispatch'],supplier:['dispatch'],inbound:['warehouse'],quote:['dispatch','finance']};
  const zones=['America/Chicago','America/Los_Angeles','America/New_York','America/Denver','America/Phoenix','America/Anchorage','Pacific/Honolulu'];
  const variants={timezone:zones,qualification:['S0 候选','S1 基础资格通过','S2 限定试单','S3 同范围常规','SX 暂停'],stage:['S01 订舱','S02 装运','S03 清关与放货','S04 提货入仓'],path:['A','B','C1','C2']};
  let active={resources:'warehouse',ledger:'inbound'};
  function dialog(title,ctx){
    const d=document.createElement('dialog');d.className='r-dialog';d.innerHTML='<div class="dialog-head"><h2>'+ctx.escape(title)+'</h2><button aria-label="关闭窗口">×</button></div><div class="dialog-body"></div>';
    document.body.append(d);d.querySelector('button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();return d
  }
  function formField(ctx,k,value,options,needed){
    const e=ctx.escape;let values=options||variants[k];const req=needed?' required':'';
    let input;
    if(values){input='<select name="'+k+'"'+req+'><option value="">请选择</option>'+values.map(item=>{
      const [v,t]=Array.isArray(item)?item:[item.split(' ')[0],item];return '<option value="'+e(v)+'" '+(String(v)===String(value)?'selected':'')+'>'+e(t)+'</option>'}).join('')+'</select>'}
    else if(['notes','scope','serials'].includes(k)){input='<textarea maxlength="2000" name="'+k+'"'+req+'>'+e(value)+'</textarea>'}
    else {const num=['lat','lng','capacity_units','amount','door_cm','payload_kg'].includes(k);input='<input name="'+k+'" type="'+(num?'number':k==='valid_until'?'date':'text')+'" '+(num?'step="'+(k==='capacity_units'?'1':'any')+'"':'maxlength="2000"')+' value="'+e(value)+'"'+req+'>'}
    return '<label class="field '+(['notes','scope','serials','address'].includes(k)?'full':'')+'"><span>'+e(labels[k]||k)+(needed?' *':'')+'</span>'+input+'</label>';
  }
  const costLabels={origin_cost:'原仓、干线及附加费',station_cost:'经站收发与短存',delivery_cost:'末端首台、加台及逐站费',special_cost:'专项、技术及税费净额',other_cost:'协调及其他未含费用'};
  Object.assign(labels,costLabels);
  function costPanel(d,ctx,row){
    const form=d.querySelector('form'),box=document.createElement('fieldset');box.className='quote-lines';
    box.innerHTML='<legend>F03 · 归一化全程费用 / USD</legend><p class="r-help">已含项填 0，并注明报价行。未知费用留空，待补齐后才能中选。</p><div class="form-grid">'+Object.entries(costLabels).map(([key,title])=>'<label class="field"><span>'+title+'</span><input type="number" name="'+key+'" min="0" max="100000000" step=".01" value="'+ctx.escape(row[key]??'')+'"></label>').join('')+'</div><p class="quote-total"></p>';
    form.querySelector('.form-grid').append(box);
    const sync=()=>{const nums=[...box.querySelectorAll('input')],complete=nums.every(n=>n.value!==''),total=nums.reduce((sum,n)=>sum+Math.round(Number(n.value)*100),0)/100;
      box.querySelector('.quote-total').textContent=complete?'五行全价　USD '+total.toFixed(2):'待补 '+nums.filter(n=>!n.value).length+' 行费用';
      if(complete)form.elements.amount.value=total.toFixed(2);form.elements.amount.readOnly=complete};
    box.addEventListener('input',sync);sync();
  }
  function edit(ctx,kind,row={}){
    const d=dialog((row.id?'编辑':'登记')+types[kind],ctx);
    const options=k=>k==='order_id'?ctx.orders.map(o=>[o.id,o.id+' · '+o.customer]):k==='warehouse'?ctx.resources.filter(r=>r.type==='warehouse').map(w=>[w.name,w.name]):undefined;
    d.querySelector('.dialog-body').innerHTML='<form><div class="form-grid">'+['name',...fields[kind]].map(k=>formField(ctx,k,row[k]??'',options(k),k==='name'||required[kind].includes(k))).join('')+'</div><div class="error-line" role="alert"></div><div class="dialog-foot"><button type="submit" class="primary">保存记录</button></div></form>';
    if(kind==='quote')costPanel(d,ctx,row);
    d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const f=ev.target,b=f.querySelector('button');b.disabled=true;try{await ctx.api('/api/ops/resources',{method:'POST',body:{...Object.fromEntries(new FormData(f)),type:kind,id:row.id,version:row.version}});d.close();ctx.toast('记录已保存');await ctx.refresh()}catch(err){f.querySelector('.error-line').textContent=err.message}finally{b.disabled=false}};
  }
  function summary(r){
    return {warehouse:r.address,vehicle:[r.capacity_units+' 台',r.equipment].filter(Boolean).join(' · '),crew:r.coverage,supplier:[r.qualification,r.ability,r.coverage].filter(Boolean).join(' · '),inbound:[r.batch,r.stage,r.warehouse].join(' · '),quote:[r.path,r.carrier,r.amount!=null?'USD '+r.amount:'待补全价'].join(' · ')}[r.type]
  }
  async function inspect(ctx,r){
    const d=dialog(r.name,ctx),e=ctx.escape,b=d.querySelector('.dialog-body');
    b.innerHTML='<dl>'+fields[r.type].filter(k=>r[k]!==undefined).map(k=>'<dt class="muted">'+e(labels[k])+'</dt><dd style="margin:3px 0 12px">'+e(r[k])+'</dd>').join('')+'</dl><h3>版本与经办</h3><div class="history"></div>';
    if(r.type==='quote')addAwardButton(ctx,d,b,r);
    try{const {history}=await ctx.api('/api/ops/history/'+encodeURIComponent(r.id));b.querySelector('.history').innerHTML=history.map(x=>'<details><summary>v'+e(x.version)+' · '+e(x.actor)+' · '+e(new Date(x.ts).toLocaleString('zh-CN'))+'</summary>'+Object.entries(JSON.parse(x.snapshot)).map(([k,v])=>'<div>'+e(labels[k]||k)+'　'+e(v)+'</div>').join('')+'</details>').join('')}catch(err){b.querySelector('.history').textContent=err.message}
  }
  function addAwardButton(ctx,d,host,r){
    const o=ctx.orders.find(x=>x.id===r.order_id),can=['admin','dispatch'].includes(ctx.user.role)&&o&&['ready','new'].includes(o.status)&&!o.pickup&&o.route===r.path&&r.pricing_status==='itemized';
    const info=document.createElement('section');info.className='quote-lines';info.innerHTML='<b>F03 · 选定委托</b><p>'+Object.entries(costLabels).map(([k,t])=>ctx.escape(t)+' '+(r[k]??'待核')).join('　/　')+'</p>';
    if(can){info.insertAdjacentHTML('beforeend','<form><label class="field"><span>批准人 / 委托批准凭据号 *</span><input name="approval" required maxlength="300"></label><p class="error-line"></p><button class="primary">选用此报价并关联订单</button></form>');
      info.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const f=ev.target,b=f.querySelector('button');b.disabled=true;try{await ctx.api('/api/ops/award-quote',{method:'POST',body:{id:r.id,version:o.version,quote_version:r.version,approval_ref:f.elements.approval.value}});d.close();await ctx.refresh();ctx.openOrder(o.id)}catch(x){f.querySelector('.error-line').textContent=x.message}finally{b.disabled=false}}}
    else info.insertAdjacentHTML('beforeend','<small class="muted">中选须有完整五行费用、匹配路径、有效报价、批准凭据及可办理的订单状态。</small>');
    host.prepend(info)
  }
  function migrate(ctx){
    const d=dialog('逐票迁入 v8 订单',ctx),b=d.querySelector('.dialog-body');
    b.innerHTML='<p>选择 v8 导出的 JSON 备份。核实实际地址、持货仓及合同终点后，迁入为待核验订单。旧站的演示状态不会作为放货依据。</p><label class="field"><span>v8 备份文件</span><input type="file" accept=".json,application/json"></label><div class="old"></div><div class="error-line"></div>';
    const err=b.querySelector('.error-line');b.querySelector('[type=file]').onchange=async ev=>{err.textContent='';const box=b.querySelector('.old');box.replaceChildren();
      try{const f=ev.target.files[0];if(!f)return;if(f.size>16*1024*1024)throw Error('请选择小于 16 MiB 的备份');
        const json=JSON.parse(await f.text()),s=json.state||json;if(![6,7].includes(s.schema)||!Array.isArray(s.orders)||!s.orders.length)throw Error('需要含订单的 v8 schema 6 / 7 备份');
        const rows=s.orders.filter(o=>o&&typeof o.id==='string');const e=ctx.escape;
        box.innerHTML='<label class="field"><span>选择原订单</span><select>'+rows.map((o,i)=>'<option value="'+i+'">'+e(o.id)+' · '+e(o.customer)+'</option>').join('')+'</select></label><div class="review"></div>';
        const select=box.querySelector('select'),render=()=>{const o=rows[Number(select.value)],w=(s.warehouses||[]).find(w=>w.id===o.warehouse);const target=box.querySelector('.review');
          target.innerHTML='<form><p>'+e(o.model)+' × '+e(o.qty)+' · '+e(o.zip)+' · '+e(o.endpoint)+' · '+e(o.path)+'</p><div class="form-grid">'+formField(ctx,'address',o.address||'',null,true)+formField(ctx,'warehouse',w?.name||o.warehouse||'',ctx.resources.filter(r=>r.type==='warehouse').map(r=>[r.name,r.name]),true)+'<label class="field full"><span>核实后的合同交接位置 *</span><input name="endpoint" required maxlength="500"></label><label class="field"><span>本次分支 *</span><select name="branch" required><option value="">请选择</option><option value="pickup">A 仓口自提</option><option value="A">A 普通卡派</option><option value="B">B 专业直送</option><option value="C1">C1 经站统包</option><option value="C2">C2 经站分采</option></select></label><small class="muted full">迁入后请补核真实经纬度。旧库种子坐标不会沿用。</small></div><div class="dialog-foot"><button class="primary">确认迁入这票</button></div></form>';
          target.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const f=ev.target,bn=f.querySelector('button');bn.disabled=true;try{const info=Object.fromEntries(new FormData(f));
            const branch=info.branch;delete info.branch;const order={...info,crm_ref:String(o.crm||o.id),customer:o.customer,model:o.model,quantity:Number(o.qty),city:o.city||'',state:o.state||'',zip:String(o.zip),lat:null,lng:null,route:branch==='pickup'?'A':branch,pickup:branch==='pickup',level:o.endpoint,addon_l4:!!o.L4,addon_l5:!!o.L5,timezone:o.timeZone||'America/Chicago',notes:'V8 '+o.id+' / CRM '+(o.crm||'待补')+'；原窗与放行凭据须重新核对。'};
            const res=await ctx.api('/api/ops/import-v8',{method:'POST',body:{old_id:o.id,order}});d.close();await ctx.refresh();ctx.openOrder(res.order.id);
          }catch(x){err.textContent=x.message}finally{bn.disabled=false}};
        };select.onchange=render;render()
      }catch(x){err.textContent=x.message}
    }
  }
  function compareQuotes(ctx,rows){
    const d=dialog('同范围报价对照',ctx),e=ctx.escape,b=d.querySelector('.dialog-body');
    b.innerHTML='<p>指定现行方案，以同一订单和同一询价版本的书面报价比较全价。负差额表示候选报价较低。</p><label class="field"><span>现行方案 / 比较基准</span><select></select></label><div class="comparison"></div>';
    const select=b.querySelector('select');select.innerHTML=rows.map((r,i)=>'<option value="'+i+'">'+e(r.name)+' · '+e(r.carrier)+'</option>').join('');
    function render(){
      const base=rows[Number(select.value)],targets=rows.filter(r=>r.order_id===base.order_id&&r.comparison_ref===base.comparison_ref);
      const table=b.querySelector('.comparison');
      if(!base.comparison_ref){table.innerHTML='<p class="empty">请先补录同范围询价版本号，确保机型、起运仓、终点、动作和时窗一致。</p>';return}
      const money=n=>n==null?'待核':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
      table.innerHTML='<p>询价版本 '+e(base.comparison_ref)+' · '+e(base.order_id)+'</p><div class="table-wrap"><table class="r-table"><thead><tr><th>承运方 / 路径</th><th>全价</th><th>较基准</th><th>有效至</th><th>范围与凭据</th></tr></thead><tbody>'+targets.map(r=>'<tr><td>'+e(r.carrier)+' / '+e(r.path)+'</td><td>'+money(r.amount)+'</td><td>'+(r.id===base.id?'基准':r.pricing_status==='incomplete'||base.pricing_status==='incomplete'||r.amount==null||base.amount==null?'待核':money(r.amount-base.amount))+'</td><td>'+e(r.valid_until)+'</td><td>'+e(r.scope)+'<br>'+e(r.evidence)+'</td></tr>').join('')+'</tbody></table></div><p class="muted">本表是询价差额。实际节省需以同批已结账单和成功台数另行核实。</p>';
    }select.onchange=render;render()
  }
  function mount(h,ctx,view){
    const e=ctx.escape,role=ctx.user.role,options=(view==='resources'?['warehouse','vehicle','crew','supplier']:['inbound','quote']).filter(k=>!['supplier','quote'].includes(k)||['admin','dispatch','finance'].includes(role));const kind=options.includes(active[view])?active[view]:options[0],rows=ctx.resources.filter(x=>x.type===kind),can=role==='admin'||editors[kind].includes(role);
    h.innerHTML='<div class="resource-tabs">'+options.map(k=>'<button data-type="'+k+'" class="'+(kind===k?'active':'')+'">'+types[k]+'</button>').join('')+'</div><div class="card"><div class="card-head"><div><div class="eyebrow">'+(view==='ledger'?'EVIDENCE REGISTER':'RESOURCE DIRECTORY')+'</div><h2>'+types[kind]+'台账 <small class="pill">'+rows.length+'</small></h2></div><div class="list-actions">'+(role==='admin'&&view==='ledger'&&!ctx.publicDemo?'<button id="legacyimport">迁入 v8 订单</button>':'')+(can?'<button class="primary" id="r-add">＋ 登记'+types[kind]+'</button>':'')+'</div></div>'+(rows.length?'<div class="table-wrap"><table class="r-table"><thead><tr><th>名称</th><th>作业条件 / 范围</th><th>书面凭据</th><th>操作</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr><td>'+e(r.name)+'</td><td>'+e(summary(r))+'</td><td>'+e(r.evidence||'待核')+'</td><td><div class="list-actions"><button data-show="'+i+'">查看</button>'+(can?'<button data-edit="'+i+'">编辑</button>':'')+'</div></td></tr>').join('')+'</tbody></table></div>':'<p class="empty">暂无'+types[kind]+'记录。'+(can?'可登记第一条经核实的资料。':'负责岗位保存后可在此查看。')+'</p>')+'</div>';
    if(kind==='quote'&&rows.length){const compare=document.createElement('button');compare.textContent='同范围比价';compare.onclick=()=>compareQuotes(ctx,rows);h.querySelector('.card-head .list-actions').prepend(compare)}
    h.onclick=ev=>{const n=ev.target.closest('button');if(!n)return;if(n.dataset.type){active[view]=n.dataset.type;mount(h,ctx,view)}else if(n.id==='r-add')edit(ctx,kind);else if(n.id==='legacyimport')migrate(ctx);else if(n.dataset.edit!==undefined)edit(ctx,kind,rows[+n.dataset.edit]);else if(n.dataset.show!==undefined)inspect(ctx,rows[+n.dataset.show])};
  }
  window.Resources={mount,focusTab:(view,k)=>{active[view]=k}};
})();



