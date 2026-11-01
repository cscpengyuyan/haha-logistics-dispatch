/* Unit-level stock custody and independent recovery case branches. */
(() => {
  'use strict';
  const labels={redelivery_order_id:'复送任务',redelivery_authority:'复送批准依据',delivery_actions:'复送终点的已购动作',return_plan:'复送到位与复验计划',release_ref:'技术放行凭据',technician:'获准技术账号',valid_until:'授权有效期',warehouse_id:'实际库址',purpose:'业务类型',reason_ref:'移修恢复工单号或退回原因凭据',seller_approval:'卖方批准凭据',receiver_id:'接收点库址 ID',receiver_acceptance:'站点接收权限与承接回执',protection_ref:'回程防护与实物当前位置',redelivery_ref:'复送安排、责任人及恢复时限',sn:'设备 SN',warehouse:'持货仓',bin:'库位',batch:'ASN / 收货批次',state:'状态',model:'设备型号',condition:'实测货况',
    evidence:'凭证号 / 回执',created_at:'登记时间',updated_at:'更新时间',custody_ref:'本次交接依据',station_name:'中转站',custodian:'当前保管人',
    order_id:'关联订单',version:'版本',id:'工单号',kind:'工单类型',issue:'故障 / 损伤事实',owner:'跟进人',next_step:'下一步',
    due:'下次跟进期限（订单当地时间）',timezone:'当地时区',strategy:'修复路径及实施方',approval_ref:'审批号与授权范围',
    test_result:'原故障复测结果',customer_ref:'客户验收凭据',recovered_at:'实际恢复时间（当地）',claimant:'有权索赔主体',carrier:'适格承运方',
    claim_amount:'索赔额（USD）',delivery_ref:'正式索赔送达回执',approved_amount:'获准赔付（USD）',decision_ref:'裁定 / 和解凭据',
    received_amount:'实收赔款（USD）',payment_ref:'到账或无赔付依据',gap_note:'未赔差额及处置说明',return_to:'获准退回的地址 / 收件人',
    part_ref:'旧件料号及件号 / 整机 SN',tracking:'取件或寄运跟踪号',receipt_ref:'收货回执',inspection:'查验结论',
    credit_amount:'供应商贷项（USD）',credit_ref:'贷项号或无贷项依据',disposition:'旧件实物处置与授权依据',item_type:'退运对象',aftercare_id:'关联返修工单'};
  const names={pending_qc:'已实收待质检',redelivery_ready:'技术已放行 · 待复送',available:'可锁机',hold:'隔离',reserved:'已锁机',transit:'交运中',station:'站方保管',transfer:'调拨在途',delivered:'已签交',
    restore:'客户恢复',claim:'承运索赔',rma:'退件 / RMA',open:'待处理',authorized:'已授权',shipped:'退运中',received:'已查收',
    filed:'索赔已送达',decided:'已裁定',closed:'已结案',part:'零部件',machine:'整机',returning:'整机回运中',returned_hold:'返修仓隔离'};
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tag=s=>'<span class="lc-tag lc-'+esc(s)+'">'+esc(names[s]||s)+'</span>';
  const val=(k,v)=>['state','kind','item_type'].includes(k)?esc(names[v]||v):esc(v);
  const options=arr=>arr.map(([v,n])=>'<option value="'+esc(v)+'">'+esc(n)+'</option>').join('');
  function input(k, value='', opts={}){
    const title=opts.label||labels[k]||k;
    let tag;
    if(opts.options)tag='<select name="'+k+'" required>'+options(opts.options)+'</select>';
    else if(opts.multi)tag='<textarea name="'+k+'" required rows="2" maxlength="1800">'+esc(value)+'</textarea>';
    else {
      const type=opts.type||(k.endsWith('_amount')?'number':k==='due'||k==='recovered_at'?'datetime-local':'text');
      tag='<input name="'+k+'" type="'+type+'" required value="'+esc(value)+'" '+(type==='number'?'min="0" step="0.01"':'maxlength="300"')+(opts.list?' list="'+opts.list+'"':'')+'>';
    }
    return '<label class="lc-field"><span>'+esc(title)+'</span>'+tag+'</label>';
  }
  const facts=o=>Object.entries(o).filter(([k,v])=>labels[k]&&v!==null&&v!=='').map(([k,v])=>'<div><dt>'+esc(labels[k])+'</dt><dd>'+val(k,v)+'</dd></div>').join('');
  function mount(host,ctx,view){
    const asset=view==='inventory',kind=asset?'assets':'cases',api='/api/lifecycle/'+kind;
    const role=ctx.user.role,canWrite=asset?['admin','warehouse'].includes(role):['admin','dispatch','warehouse','service','finance'].includes(role);
    let records=[],alive=true,dialog=null,search=asset?(new URLSearchParams(location.hash.split('?')[1]||'').get('sn')||''):'',filter='',generation=0;
    const showError=e=>ctx.toast?.(e.message||'操作失败');
    function close(){
      if(dialog){dialog.close();dialog.remove();dialog=null;}
    }
    function modal(title,sub,inner,button=null){
      close();
      dialog=document.createElement('dialog'); dialog.className='lc-dialog';
      dialog.innerHTML='<header><div><small>'+esc(sub)+'</small><h2>'+esc(title)+'</h2></div><button type="button" class="lc-close" aria-label="关闭">×</button></header><form><div class="lc-body">'+inner+'</div><div class="lc-error" role="alert"></div><footer><button type="button" class="lc-close">关闭</button>'+(button?'<button class="primary" type="submit">'+esc(button)+'</button>':'')+'</footer></form>';
      document.body.append(dialog); dialog.showModal();dialog.querySelectorAll('.lc-close').forEach(b=>b.onclick=close);
      dialog.addEventListener('close',()=>{if(dialog&&!dialog.open){dialog.remove();dialog=null;}},{once:true});
      dialog.addEventListener('click',e=>{if(e.target===dialog)close()});
      return dialog.querySelector('form');
    }
    function save(form,toBody){
      form.onsubmit=async e=>{
        e.preventDefault(); const submit=form.querySelector('button[type=submit]');
        if(submit.disabled)return;
        submit.disabled=true;
        try{
          const fields=Object.fromEntries(new FormData(form));
          await ctx.api(api,{method:'POST',body:toBody(fields)});
          close(); await load(); ctx.toast?.('已保存，交接记录已更新');
        }catch(err){form.querySelector('.lc-error').textContent=err.message;submit.disabled=false;}
      };
    }
    function benchForm(){
      const wh=ctx.resources.filter(r=>r.type==='warehouse').map(r=>[r.id,r.name]);
      const f=modal('授权实际维修工位','RMA','<div class="lc-grid">'+input('warehouse_id','',{options:wh})+input('model')+input('technician')+input('valid_until','',{type:'date'})+input('evidence')+'</div>','签发工位授权');
      f.onsubmit=async ev=>{ev.preventDefault();try{const b=Object.fromEntries(new FormData(f)),list=(await ctx.api('/api/lifecycle/repair-benches')).records;
        b.version=list.find(x=>x.warehouse_id===b.warehouse_id&&x.model===b.model)?.version||0;
        await ctx.api('/api/lifecycle/repair-benches',{method:'POST',body:b});close();await load()
      }catch(err){f.querySelector('.lc-error').textContent=err.message}}
    }
    function releaseMachine(o){
      const f=modal('返修复测与技术放行',o.sn,'<div class="lc-info">核对工位机型授权。技术放行后设备按原单待复送。</div><div class="lc-grid">'+['test_result','release_ref','protection_ref','return_plan'].map(k=>input(k)).join('')+'</div>','签技术放行');
      f.onsubmit=async ev=>{ev.preventDefault();try{await ctx.api('/api/lifecycle/technical-release',{method:'POST',body:{...Object.fromEntries(new FormData(f)),id:o.id,version:o.version}});close();await load()}catch(err){f.querySelector('.lc-error').textContent=err.message}}
    }
    function redeliveryForm(o){
      const body=['approval_ref','window_start','window_end','delivery_actions'].map(k=>input(k,'',k.startsWith('window')?
        {type:'datetime-local',label:k==='window_start'?'复送预约开始（原机位当地）':'复送预约截止（原机位当地）'}:{})).join('')+
        input('procurement_mode','',{label:'复送采购方式',options:[['company','公司采购'],['platform','账户指定承运'],['ltl','普通 LTL'],['brand_fleet','内部用车']]});
      const f=modal('批准本台复送',o.sn,'<p>设备将锁给一份新任务。仍需确认本段执行人、F04 放行及原机位逐台签交。</p><div class="lc-grid">'+body+'</div>','生成复送任务');
      f.onsubmit=async ev=>{ev.preventDefault();try{const r=await ctx.api('/api/lifecycle/redelivery',{method:'POST',body:{...Object.fromEntries(new FormData(f)),id:o.id,version:o.version}});close();await ctx.refresh();ctx.openOrder(r.order.id)}catch(err){f.querySelector('.lc-error').textContent=err.message}}
    }
    function receive(o){
      const existing=!!o, wh=(ctx.resources||[]).filter(r=>r.type==='warehouse').map(r=>[r.name,r.name]);
      const body=(existing?'<div class="lc-info">'+esc(o.sn)+' · '+esc(o.warehouse)+' · '+esc(o.model)+'</div>':
        input('sn')+input('model')+input('warehouse','',{list:'lc-warehouses'})+'<datalist id="lc-warehouses">'+options(wh)+'</datalist>'+input('batch'))+
        input('bin',o?.bin)+input('condition',o?.condition)+input('state','',{options:[...(existing?[]:[['pending_qc','仅实收 · 待质检']]),['available','验合格 · 可锁机'],['hold','隔离 · 暂停放货']]})+input('evidence');
      const form=modal(existing?'复核实物':'登记逐台实收','WAREHOUSE RECEIPT','<div class="lc-grid">'+body+'</div>',existing?'保存复核':'确认入库');
      if(existing)form.elements.state.value=o.state;
      save(form,f=>existing?{...f,version:o.version,sn:o.sn,action:'inspect'}:{...f,action:'receive'});
    }
    function openCase(){
      const orders=(ctx.orders||[]).filter(o=>o.sn);
      if(!orders.length){ctx.toast?.('尚无已分配 SN 的订单');return;}
      const kinds=role==='finance'?['claim','rma']:role==='warehouse'?['rma']:role==='dispatch'?['restore','claim']:['restore','claim','rma'];
      const html=input('kind','',{options:kinds.map(k=>[k,names[k]])})+input('item_type','',{options:[['part','零部件'],['machine','整机移修']]})+input('purpose','',{options:[['repair','维修移运'],['commercial','商业退货']]})+input('reason_ref')+input('seller_approval')+input('order_id','',{options:orders.map(o=>[o.id,o.id+' · '+o.customer])})+
        input('sn','',{options:[]})+input('owner',ctx.user.name)+input('custodian')+input('due')+input('issue','',{multi:true})+input('next_step','',{multi:true})+input('evidence');
      const form=modal('按 SN 开立工单','AFTER-DELIVERY','<div class="lc-info">客户恢复、向承运人索赔、旧件回收分别开单和结案。请核实本票适用的授权和截止时间。</div><div class="lc-grid">'+html+'</div>','建立分支工单');
      function updateSn(){
        const order=orders.find(o=>o.id===form.elements.order_id.value);
        form.elements.sn.innerHTML=options(String(order.sn).split(/[,，;；\r\n]+/).map(s=>s.trim()).filter(Boolean).map(s=>[s,s]));
      }
      form.elements.order_id.onchange=updateSn;updateSn();
      const updateKind=()=>{for(const k of ['item_type','purpose','reason_ref','seller_approval']){
        const el=form.elements[k],show=form.elements.kind.value==='rma'&&(k!=='seller_approval'||form.elements.purpose.value==='commercial');
        el.disabled=!show;el.closest('label').style.display=show?'grid':'none'
      }};form.elements.purpose.onchange=updateKind;
      form.elements.kind.onchange=updateKind;updateKind();
      save(form,f=>({...f,action:'open'}));
    }
    function advance(o){
      const rule=o.next;
      const html='<div class="lc-info">'+esc(o.sn)+' · '+esc(names[o.kind])+' · '+esc(o.order_id)+'</div><div class="lc-grid">'+
        rule.fields.map(k=>k==='strategy'?input(k,'',{options:[['remote','远程恢复'],['parts','寄送备件'],['onsite','本地上门'],['loaner','替换备机'],['machine','整机移修']]}):k==='receiver_id'?input(k,'',{options:ctx.resources.filter(r=>r.type==='warehouse').map(w=>[w.id,w.name+' / '+w.id])}):input(k,'',{multi:['gap_note','inspection','test_result','disposition'].includes(k)})).join('')+'</div>';
      const form=modal(rule.label,o.id,html,'保存交接结果');
      save(form,f=>({...f,id:o.id,version:o.version,to:rule.to,action:'advance'}));
    }
    async function history(o){
      const id=asset?o.sn:o.id;
      const form=modal('交接记录',id,'<dl class="lc-facts">'+facts(o)+'</dl><div class="lc-history">正在读取版本记录…</div>');
      if(!asset&&o.state==='received'&&o.purpose==='repair'&&o.item_type==='machine'&&!o.technical_release&&['service','admin'].includes(role)){
        const b=document.createElement('button');b.type='button';b.textContent='返修复测与技术放行';b.onclick=()=>releaseMachine(o);form.querySelector('.lc-body').prepend(b)
      }
      if(!asset&&o.technical_release&&!o.redelivery_order_id&&o.state==='received'&&['dispatch','admin'].includes(role)){
        const b=document.createElement('button');b.type='button';b.textContent='批准本台复送';b.onclick=()=>redeliveryForm(o);form.querySelector('.lc-body').prepend(b)
      }
      if(!asset&&o.redelivery_order_id){
        const b=document.createElement('button');b.type='button';b.textContent='打开本台复送任务与 POD';b.onclick=()=>{close();ctx.openOrder(o.redelivery_order_id)};form.querySelector('.lc-body').prepend(b)
      }
      if(asset){
        const trace=document.createElement('div');form.querySelector('.lc-body').prepend(trace);
        if(o.batch){const link=document.createElement('button');link.type='button';link.textContent='追溯海运 ASN';link.onclick=()=>{close();window.Supply.openASN(ctx,o.batch)};trace.append(link)}
        if(canWrite&&o.state==='available'){const b=document.createElement('button');b.type='button';b.textContent='申请未售前置 D';b.onclick=()=>{close();window.Supply.positionRequest(ctx,o,load)};trace.append(b)}
        if(canWrite&&['transfer','available'].includes(o.state)){const b=document.createElement('button');b.type='button';b.textContent=o.state==='transfer'?'接收调拨':'申请调拨';b.onclick=()=>{close();window.Supply.transfer(ctx,o,load)};trace.append(b)}
      }
      try{
        const result=await ctx.api(api+'/history/'+encodeURIComponent(id));
        form.querySelector('.lc-history').innerHTML='<h3>版本记录</h3>'+result.history.map(h=>{
          let f={};try{f=JSON.parse(h.snapshot)}catch{}
          return '<details><summary>v'+esc(h.version)+' · '+esc(h.actor)+' · '+esc(h.ts)+'</summary><dl class="lc-facts">'+facts(f)+'</dl></details>';
        }).join('');
      }catch(e){form.querySelector('.lc-history').textContent=e.message;}
    }
    function draw(){
      if(!alive)return;
      const cats=asset?['available','pending_qc','hold','reserved','transit','station','delivered','transfer','returning','returned_hold']:['restore','claim','rma'];
      host.innerHTML='<section class="lc-panel"><div class="lc-heading"><div><small>'+ (asset?'UNIT INVENTORY':'SERVICE & RECOVERY') +'</small><h2>'+(asset?'逐台库存与交接':'售后、索赔与退件')+'</h2><p>'+(asset?'按 SN 查收货批次、实测货况和去向。隔离设备不能放货。':'以订单和设备分别追踪客户恢复、赔付与实物去向。')+'</p></div>'+(canWrite?'<button class="primary" data-add>＋ '+(asset?'逐台实收':'新建工单')+'</button>':'')+'</div><div class="lc-controls"><input aria-label="搜索台账" type="search" placeholder="'+(asset?'搜索 SN、仓、库位、机型、货况或订单':'搜索工单、SN、订单或经办人')+'" value="'+esc(search)+'"><select aria-label="筛选记录">'+options([['','全部'+(asset?'状态':'分支')],...cats.map(s=>[s,names[s]])])+'</select><span class="lc-count"></span></div><div class="lc-rows"></div></section>';
      if(!asset&&['admin','finance','dispatch','service'].includes(role))window.Settlement.mount(host,ctx,'recovery');
      if(asset){const plan=document.createElement('button');plan.textContent='补货测算';plan.onclick=()=>window.Supply.stockPlan(ctx);host.querySelector('.lc-heading').append(plan);if(['admin','warehouse','dispatch','finance'].includes(role)){const pos=document.createElement('button');pos.textContent='未售前置审批';pos.onclick=()=>window.Supply.positions(ctx).catch(showError);host.querySelector('.lc-heading').append(pos)}}
      if(!asset&&role==='admin'){const b=document.createElement('button');b.textContent='授权维修工位';b.onclick=benchForm;host.querySelector('.lc-heading').append(b)}
      host.querySelector('[data-add]')?.addEventListener('click',()=>asset?receive():openCase());
      const query=host.querySelector('input'),sel=host.querySelector('select');sel.value=filter;
      query.oninput=()=>{search=query.value;rows()};sel.onchange=()=>{filter=sel.value;rows()};rows();
    }
    function rows(){
      const list=records.filter(o=>(!filter||o[asset?'state':'kind']===filter)&&
        (!search||[o.sn,o.id,o.model,o.warehouse,o.bin,o.condition,o.order_id,o.owner,o.batch].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))));
      host.querySelector('.lc-count').textContent=list.length+' 条记录';
      const box=host.querySelector('.lc-rows');
      if(!list.length){box.innerHTML='<div class="lc-empty"><b>暂无匹配记录</b><p>'+(asset?'仓库可通过「逐台实收」登记设备。':'发生故障、货损或获准退件时，可从已锁机订单开立相关工单。')+'</p></div>';return;}
      const cols=asset?['设备 / SN','仓库 / 库位','保管状态','订单 / 批次','办理']:['工单 / 设备','关联订单','分支 / 进度','跟进人 / 当地期限','办理'];
      box.innerHTML='<table><thead><tr>'+cols.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr></thead><tbody>'+list.map((o,i)=>{
        const top=asset?o.sn:o.id,sub=asset?o.model:o.sn,editable=asset?canWrite&&['available','pending_qc','hold'].includes(o.state):!!o.next;
        return '<tr><td><strong>'+esc(top)+'</strong><small>'+esc(sub)+'</small></td><td>'+esc(asset?o.warehouse:o.order_id)+(asset?'<small>'+esc(o.bin)+'</small>'+(o.received_at&&['available','pending_qc','reserved','hold'].includes(o.state)?'<small>仓龄 '+Math.max(0,Math.floor((Date.now()-Date.parse(o.received_at))/86400000))+' 天 · 免仓至 '+esc(o.free_until||'待核')+'</small>':''):'')+'</td><td>'+tag(o.state)+(!asset?'<small>'+esc(names[o.kind])+'</small>':'')+'</td><td>'+esc(asset?o.order_id||'尚未分单':o.owner)+'<small>'+esc(asset?o.batch:o.due+' · '+o.timezone)+'</small></td><td><div class="lc-actions"><button data-show="'+i+'">记录</button>'+(editable?'<button data-work="'+i+'">'+esc(asset?'复核':o.next.label)+'</button>':'')+'</div></td></tr>';
      }).join('')+'</tbody></table>';
      box.onclick=e=>{
        const b=e.target.closest('button');if(!b)return;
        if(b.dataset.show!==undefined)history(list[Number(b.dataset.show)]);
        if(b.dataset.work!==undefined){const o=list[Number(b.dataset.work)];asset?receive(o):advance(o);}
      };
    }
    async function load(){
      const id=++generation;
      try{const data=await ctx.api(api);if(!alive||id!==generation)return;records=data.records;draw();}
      catch(e){if(!alive||id!==generation)return;host.innerHTML='<div class="lc-empty" role="alert">'+esc(e.message)+' <button>重试</button></div>';host.querySelector('button').onclick=load;}
    }
    host.innerHTML='<div class="lc-empty">正在读取共享台账…</div>';load();
    return {destroy(){alive=false;close()},refresh:load};
  }
  window.Lifecycle={mount};
})();
