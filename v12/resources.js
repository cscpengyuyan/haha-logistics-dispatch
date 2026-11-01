'use strict';
(() => {
  const types={warehouse:'仓点',vehicle:'车辆',crew:'车组',supplier:'供应商',inbound:'海运交接',quote:'承运报价'};
  const fields={warehouse:['address','zip','lat','lng','timezone','evidence','notes'],vehicle:['floor_length_cm','floor_width_cm','door_width_cm','truck_length_m','truck_width_m','truck_height_m','gross_t','axle_load_t','capacity_units','door_cm','payload_kg','lift_capacity_kg','tie_slots','equipment','executor_id','evidence','notes'],crew:['capacity_units','coverage','equipment','headcount','tools','qualified_until','executor_id','evidence','notes'],supplier:['address','coverage','model','ability','qualification','evidence','notes'],inbound:['batch','warehouse','stage','serials','custodian','evidence','notes'],quote:['order_id','supplier_id','executor_id','product','accepted_ref','current_ref','condition_ref','carrier','path','scope','comparison_ref','amount','valid_until','evidence','notes']};
  const required={warehouse:['address','timezone'],vehicle:['capacity_units'],crew:['coverage'],supplier:['address','ability','qualification'],inbound:['batch','warehouse','stage','custodian','evidence'],quote:['order_id','carrier','path','scope','valid_until','evidence']};
  const labels={floor_length_cm:'货厢可用长 cm',floor_width_cm:'货厢可用宽 cm',door_width_cm:'车门净宽 cm',truck_length_m:'整车长 m',truck_width_m:'整车宽 m',truck_height_m:'整车高 m',gross_t:'运行总重 t',axle_load_t:'最大轴荷 t',zip:"实际仓址五位 ZIP",lift_capacity_kg:'尾板核载 kg（无尾板填 0）',tie_slots:'固定托位',headcount:'可出勤人数',tools:'能力工具代码，逗号分隔',supplier_id:"签约供应商",executor_id:"实际执行方 ID",product:"采购产品",accepted_ref:"本票书面接受号",current_ref:"现行原委托凭据（备选留空）",condition_ref:"附条件逐票核实号",qualified_until:'车组资格有效至（YYYY-MM-DD）',executor_id:'实际执行主体 ID',comparison_ref:'同范围询价版本号（用于横向比价）',name:'记录名称',address:'实际库址 / 执行地址',lat:'纬度',lng:'经度',timezone:'库址时区',evidence:'书面回执 / 原始凭据号',notes:'限制、条件与下次跟进',capacity_units:'核定可载台数',door_cm:'车门净高（cm）',payload_kg:'核定载重（kg）',equipment:'人员、工具及尾板条件',coverage:'服务区域 / ZIP',model:'适用机型',ability:'采购能力（T1–T5）',qualification:'准入状态',batch:'海运批次 / 分单号',warehouse:'指定收货仓',stage:'当前节点',serials:'设备序列号 / 清单引用',custodian:'当前保管人',order_id:'关联订单',carrier:'实际承运 / 报价方',path:'报价路径',scope:'终点、动作、窗口及全价包含项',amount:'全价（USD）',valid_until:'报价有效期'};
  const editors={warehouse:['warehouse','dispatch'],vehicle:['dispatch'],crew:['dispatch'],supplier:['dispatch','procurement'],inbound:['warehouse'],quote:['dispatch','procurement']};
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
    const options=k=>k==='supplier_id'?ctx.resources.filter(r=>r.type==='supplier').map(r=>[r.id,r.name+' / '+r.id]):k==='product'?['T1','T2','T4'].map(v=>[v,v]):k==='order_id'?ctx.orders.map(o=>[o.id,o.id+' · '+o.customer]):k==='warehouse'?ctx.resources.filter(r=>r.type==='warehouse').map(w=>[w.name,w.name]):undefined;
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
    if(r.type==='supplier'){const panel=document.createElement('section');b.prepend(panel);window.Supply.supplierPanel(panel,ctx,r)}
    if(r.type==='quote')addAwardButton(ctx,d,b,r);
    try{const {history}=await ctx.api('/api/ops/history/'+encodeURIComponent(r.id));b.querySelector('.history').innerHTML=history.map(x=>'<details><summary>v'+e(x.version)+' · '+e(x.actor)+' · '+e(new Date(x.ts).toLocaleString('zh-CN'))+'</summary>'+Object.entries(JSON.parse(x.snapshot)).map(([k,v])=>'<div>'+e(labels[k]||k)+'　'+e(v)+'</div>').join('')+'</details>').join('')}catch(err){b.querySelector('.history').textContent=err.message}
  }
  function addAwardButton(ctx,d,host,r){
    const o=ctx.orders.find(x=>x.id===r.order_id),can=['admin','dispatch','procurement'].includes(ctx.user.role)&&o&&['ready','new'].includes(o.status)&&!o.pickup&&o.route===r.path&&r.pricing_status==='itemized';
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
    const ids=[...new Set(rows.map(r=>r.order_id))];
    b.innerHTML='<label class="field"><span>选择订单</span><select>'+ids.map(id=>'<option value="'+e(id)+'">'+(ctx.orders.find(o=>o.id===id)?.crm_ref?e(ctx.orders.find(o=>o.id===id).crm_ref)+' · ':'')+e(id)+'</option>').join('')+'</select></label><section class="comparison" aria-live="polite"></section>';
    const choice=b.querySelector('select'),table=b.querySelector('section');
    const money=x=>x==null?'待核':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(x);
    let request=0;
    async function render(){
      const rev=++request;table.textContent='读取询价、范围与基线…';
      try{
        const report=await ctx.api('/api/ops/compare/'+encodeURIComponent(choice.value));
        if(rev!==request)return;
        const current=report.quotes.find(q=>q.id===report.current);
        table.innerHTML='<h3>'+e(current?'已锁现行 · '+current.name+' / '+money(current.amount):'现行基线待确认')+'</h3>'+
          '<div class="table-wrap"><table class="r-table"><thead><tr><th>执行方 / 路径</th><th>五行全价</th><th>较现行询价差</th><th>依据或待补</th></tr></thead><tbody>'+
          report.quotes.map(q=>'<tr><td>'+e(q.carrier)+' / '+e(q.path)+'</td><td>'+money(q.amount)+'</td><td>'+money(q.difference)+'</td><td>'+e(q.excluded||q.evidence)+' · '+e(q.scope)+'</td></tr>').join('')+
          '</tbody></table></div><p>财务在首派前锁定有原委托凭证的可执行报价。询价差额不计实付节省。</p>';
      }catch(err){if(rev===request)table.textContent=err.message}
    }
    choice.onchange=render;render();
  }
  function mount(h,ctx,view){
    const e=ctx.escape,role=ctx.user.role,options=(view==='resources'?['warehouse','vehicle','crew','supplier']:view==='ocean'?['inbound']:['inbound','quote']).filter(k=>!['supplier','quote'].includes(k)||['admin','dispatch','finance','procurement'].includes(role));const kind=options.includes(active[view])?active[view]:options[0],rows=ctx.resources.filter(x=>x.type===kind),can=role==='admin'||editors[kind].includes(role);
    h.innerHTML='<div class="resource-tabs">'+options.map(k=>'<button data-type="'+k+'" class="'+(kind===k?'active':'')+'">'+types[k]+'</button>').join('')+'</div><div class="card"><div class="card-head"><div><div class="eyebrow">'+(view!=='resources'?'EVIDENCE REGISTER':'RESOURCE DIRECTORY')+'</div><h2>'+types[kind]+'台账 <small class="pill">'+rows.length+'</small></h2></div><div class="list-actions">'+(role==='admin'&&view!=='resources'&&!ctx.publicDemo?'<button id="legacyimport">迁入 v8 订单</button>':'')+(can?'<button class="primary" id="r-add">＋ 登记'+types[kind]+'</button>':'')+'</div></div>'+(rows.length?'<div class="table-wrap"><table class="r-table"><thead><tr><th>名称</th><th>作业条件 / 范围</th><th>书面凭据</th><th>操作</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr><td>'+e(r.name)+'</td><td>'+e(summary(r))+'</td><td>'+e(r.evidence||'待核')+'</td><td><div class="list-actions"><button data-show="'+i+'">查看</button>'+(can?'<button data-edit="'+i+'">编辑</button>':'')+'</div></td></tr>').join('')+'</tbody></table></div>':'<p class="empty">暂无'+types[kind]+'记录。'+(can?'可登记第一条经核实的资料。':'负责岗位保存后可在此查看。')+'</p>')+'</div>';
    if(kind==='inbound'&&view!=='ocean'){const panel=document.createElement('section');panel.className='supply-card';h.querySelector('.card').before(panel);window.Supply.sea(panel,ctx)}
    if(kind==='quote'&&rows.length){const compare=document.createElement('button');compare.textContent='同范围比价';compare.onclick=()=>compareQuotes(ctx,rows);h.querySelector('.card-head .list-actions').prepend(compare)}
    h.onclick=ev=>{const n=ev.target.closest('button');if(!n)return;if(n.dataset.type){active[view]=n.dataset.type;mount(h,ctx,view)}else if(n.id==='r-add')edit(ctx,kind);else if(n.id==='legacyimport')migrate(ctx);else if(n.dataset.edit!==undefined)edit(ctx,kind,rows[+n.dataset.edit]);else if(n.dataset.show!==undefined)inspect(ctx,rows[+n.dataset.show])};
  }
  window.Resources={mount,focusTab:(view,k)=>{active[view]=k}};
})();



