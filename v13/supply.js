/* S01–S04, inventory forecast and documented supplier commitments. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const warehouses = ctx => ctx.resources.filter(r => r.type === 'warehouse');
  const findName = (ctx,id) => ctx.resources.find(r => r.id === id)?.name || id;
  const titles = {reason:"实盘差异与发现位置",procurement_ref:"头程采购确认 / 书面订舱凭据号",
    free_until:'免仓截止日期（仓库当地）',doc_cutoff:'截单时间 · 含 UTC 偏移',gate_cutoff:'截港时间 · 含 UTC 偏移',pickup_eta:'预计可提 · 含 UTC 偏移',
    transshipment:'直航 / 转船港及次数',source:'班期来源及版本',confirmation:'班期确认状态',seal:'FCL 柜封',
    bill_of_lading:'提单 / 分单',pickup_site:'提单指定实际交接场站',inland_owner:'内陆段责任方',
    scope_ref:'本票同范围询价版本 / 终点与动作依据',zone:'核定价区',rate_version:'适用运价表版本',amount:'本产品金额（USD）',on:'执行日',origin_ref:'起运交货点',destination_ref:'指定仓',vendor:'报价主体',window_ref:'装运窗口版本',unloading:'卸柜与交仓责任口径',currency:'币种',storage_right_ref:'未售库存保管书面授权',origin_fees:'境内费用',ocean_fees:'海运及附加',inland_fees:'港至指定仓 / 卸柜',insurance:'货运保险',brokerage:'报关服务',tax:'适用税（未知留空）',advance_fee:'代垫费',zone_at:'节点作业地时区',origin_zone:'起运港时区',port_zone:'卸货港时区',voyage:'航次', batch:'订舱批次', container:'柜号 / 分单号', asn:'ASN', origin:'起运港', port:'卸货港',
    warehouse_id:'指定仓', owner:'回访责任人', evidence:'书面凭据号', mode:'装运方式', inland:'内陆运输',
    planned_etd:'原计划装船 · 含时差', planned_eta:'原计划到港 · 含时差', planned_warehouse:'原计划入仓 · 含时差',
    csv:'装箱清单 CSV（SN,型号,可选订单ID；可再填打托长cm,宽cm,高cm,重kg,直立1/0,不可叠1/0）', kind:'节点', at:'作业发生 / 最新预计时间 · 含时差',
    custodian:'当前保管人', sn:'设备 SN', state:'实际货况', condition:'条件或货况说明', bin:'实物库位',
    executor_id:'实际执行方 ID',product:'采购产品',zip:'五位 ZIP',model:'实物型号',action:'服务动作',decision:'能力结论',
    valid_until:'授权有效至',insurance_until:'保险有效至',trial_limit:'S2 单票限额 / USD',demand:'提前期及复核期内新增需求',
    safety:'安全库存',horizon:'在途预测截止 · 含时差',target_id:'调入仓',approval_ref:'调拨审批依据',
    order_id:'订单及当前运段',link_id:'授权候选人车关系',contract_ref:'客户合同允许本次分包的条款 / 回执',delegation_ref:'签约方具名分包授权依据',crew_id:'已登记班组',vehicle_id:'已登记车辆',driver:'司机账号',plate:'实际车牌',level:'合同服务档'
  };
  const steps = {cutoff:'截单 / 截货',loaded:'实际装船',transship:'中转交接',eta:'更新 ETA',arrived:'实际到港',
    rolled:'甩柜 / 延后装船',shipping_docs:'核对装运条件及凭证',handoff_site:'核实提单场站及内陆段责任',cfs_ready:'LCL · CFS 拆箱齐货',empty_due:'整柜还空截止',
    customs:'监管放行',carrier_release:'船方或分单放货',terminal_ready:'实际场站可提',lfd:'末个免费日',
    hold:'扣留 / 查验',clear_hold:'解除扣留',bond_authority:'保税移动授权',bond_move:'保税内转',
    pickup:'普通提离',warehouse_arrival:'指定仓到场',empty_return:'整柜 / 底盘还空'};
  const opts = obj => Object.entries(obj);
  const models = Array.from({length:7},(_,i)=>'M0'+(i+1));
  const zones=['Asia/Shanghai','Asia/Hong_Kong','Asia/Taipei','Asia/Tokyo','Asia/Seoul','Asia/Singapore','America/Chicago','America/Los_Angeles','America/New_York','America/Denver','UTC'];
  const actions = {receive:'收储',collect:'第三方提',direct:'原仓直提',L1:'L1 月台',L2:'L2 入口',L3:'L3 机位',L4:'L4 专项',L5:'L5 技术'};
  const decisions = {U:'U 未核',Y:'Y 书面可做',C:'C 附条件',N:'N 不可'};
  let focusASN='';
  function field(k, choices, value='', type='text', optional=false) {
    const req=optional?'':' required',label=esc(titles[k]||k);
    let input;
    if(choices) {
      input='<select name="'+k+'"'+req+'><option value="">请选择</option>'+choices.map(item=>{
        const [v,t]=Array.isArray(item)?item:[item,item];return '<option value="'+esc(v)+'"'+(String(v)===String(value)?' selected':'')+'>'+esc(t)+'</option>';
      }).join('')+'</select>';
    } else if(k==='csv')input='<textarea name="csv" rows="4" required placeholder="DEMO-SN-001,M01,"></textarea><input aria-label="导入装箱 CSV" type="file" accept=".csv,text/csv">';
    else input='<input name="'+k+'" type="'+type+'" value="'+esc(value)+'" maxlength="300" '+(type==='number'?'min="0" step="any" ':'')+req+'>';
    return '<label class="field"><span>'+label+'</span>'+input+'</label>';
  }
  function dialog(title,html,button,submit){
    const d=document.createElement('dialog');d.className='r-dialog supply-dialog';
    d.innerHTML='<header class="dialog-head"><h2>'+esc(title)+'</h2><button type="button" aria-label="关闭">×</button></header><form class="dialog-body">'+html+'<div class="error-line" role="alert"></div><footer class="dialog-foot">'+(button?'<button type="submit" class="primary">'+esc(button)+'</button>':'')+'</footer></form>';
    document.body.append(d);d.showModal();
    d.querySelector('header button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});
    d.querySelector('form').onsubmit=async ev=>{
      ev.preventDefault();const b=d.querySelector('[type=submit]');if(!b||b.disabled)return;b.disabled=true;
      try{const close=await submit(Object.fromEntries(new FormData(ev.target)),d);if(close!==false&&d.open)d.close()}catch(err){d.querySelector('.error-line').textContent=err.message}finally{b.disabled=false}
    };
    return d;
  }
  const cols=(...controls)=>'<div class="form-grid">'+controls.join('')+'</div>';
  const whOptions=ctx=>warehouses(ctx).map(w=>[w.id,w.name]);
  const api=(ctx,path,body)=>ctx.api('/api/supply/'+path,{method:'POST',body});
  const iso=()=>new Date().toISOString().slice(0,19)+'Z';
  const fmt=(v,zone='UTC')=>v?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(v)):'—';
  function worksheet(title,rows){
    const html='<table><tbody>'+rows.map(r=>'<tr>'+r.map((v,i)=>i?'<td>'+esc(v)+'</td>':'<th>'+esc(v)+'</th>').join('')+'</tr>').join('')+'</tbody></table>';
    const d=dialog(title,'<div class="sc-scroll">'+html+'</div>');
    const dl=document.createElement('button');dl.type='button';dl.textContent='导出 CSV';
    dl.onclick=()=>{
      const protect=v=>{const x=String(v??'');return '"'+(/^[=+@\-\t\r]/.test(x)?"'":'')+x.replaceAll('"','""')+'"'};
      const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(protect).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download=title.replace(/[^\w\u4e00-\u9fff-]/g,'_')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
    };
    const print=document.createElement('button');print.type='button';print.textContent='打印当前版本';
    print.onclick=()=>{
      const w=window.open('','_blank','width=960,height=760');if(!w){d.querySelector('.error-line').textContent='浏览器未打开打印窗口，可改用 CSV 导出';return}
      w.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+esc(title)+'</title><style>body{font:14px system-ui;padding:24px;color:#183933}th,td{border:1px solid #acc2b9;text-align:left;padding:5px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}tr{break-inside:avoid}</style><h1>'+esc(title)+'</h1>'+html+'</html>');
      w.document.close();w.focus();w.print();
    };
    d.querySelector('footer').append(dl,print);
  }
  function shippingSheet(s){
    worksheet('作业表03 海运交接 '+s.asn+' v'+s.version,[
      ['索引',s.id,'航次',s.voyage,'批次',s.batch],['ASN',s.asn,'柜 / 分单',s.container,'装运方式',s.mode],
      ['路径',s.origin,s.port,s.warehouse,s.inland,s.warehouse_zone],['责任人',s.owner,'订舱依据',s.evidence],
      ['时线','原计划装船',s.planned_etd,'原计划到港',s.planned_eta],['预计','最新到港',s.eta,'最新到仓',s.warehouse_eta],
      ['回执节点','作业瞬间（UTC）','当前保管人','凭据','记录人','影响单号'],
      ...s.events.map(v=>[steps[v.kind],v.at,v.custodian,v.evidence,v.actor,(v.order_ids||[]).join('; ')]),
      ...Object.entries(s.schedules||{}).flatMap(([kind,list])=>list.map((v,i)=>['节点计划 '+steps[kind],'v'+(i+1),v.source_time,v.owner,v.evidence])),
      ['设备 SN','型号','原依赖订单','实物库位','收货凭据','实收状态'],
      ...s.units.map(u=>[u.sn,u.model,u.order_id||'—',u.receipt?.bin||'待收',u.receipt?.evidence||'待收',u.receipt?.state||'预报']),
      ...(s.differences||[]).map(v=>['差异 '+v.kind,v.sn,v.owner,v.custodian,v.evidence,v.recorded_at])
    ]);
  }
  function supplierSheet(ctx,supplier,scope,cards){
    const [executor,wh,zip,product]=scope;
    const scoped=cards.filter(c=>c.executor_id===executor&&c.warehouse_id===wh&&c.zip===zip&&c.product===product);
    worksheet('作业表02 承接能力 '+supplier.name+' v'+supplier.version,[
      ['签约方',supplier.name,supplier.id,'准入',supplier.qualification],['执行方',executor,'库址',findName(ctx,wh)],
      ['产品',product,'实际 ZIP',zip],['机型',...Object.values(actions)],
      ...models.map(m=>[m,...Object.keys(actions).map(a=>scoped.find(c=>c.model===m&&c.action===a)?.decision||'U')]),
      ['机型','动作','判断','原始依据','条件','保险到期','能力到期','格版本'],
      ...scoped.map(c=>[c.model,c.action,c.decision,c.evidence,c.condition,c.insurance_until,c.valid_until,c.version])
    ]);
  }
  function book(ctx,done,c){
    const header=c?'<p class="sc-route"><b>'+esc(c.voyage)+'</b> '+esc(c.origin)+' → '+esc(c.port)+' → '+esc(c.warehouse)+' · '+esc(c.source)+'</p>':'';
    const awards=c?.booking_awards||[],awardField=awards.length?'<label class="field"><span>关联本航次头程中选</span><select name="ocean_rfq_id"><option value="">其他书面订舱凭据</option>'+awards.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.ref+' · '+a.mode+' · '+a.units+' 台')+'</option>').join('')+'</select></label>':'';
    const voyageFields=c?'':cols(field('voyage'),field('origin'),field('origin_zone',zones,'',null,true),field('port'),field('port_zone',zones,'',null,true),field('warehouse_id',whOptions(ctx)),field('planned_etd',null,iso()),field('planned_eta'),field('planned_warehouse'));
    const d=dialog('S01 · 登记航次与装箱清单',header+'<p>取得头程采购批准或书面承接后，在凭据栏填写确认号。仅取得班期请保存为候选。</p>'+voyageFields+cols(field('batch'),field('container'),field('asn'),field('seal',null,'','text',true),
      field('mode',['FCL','LCL']),field('inland',[['road','公路直送'],['rail','铁路 + 短驳']]),field('bill_of_lading',null,'','text',true),field('pickup_site',null,'','text',true),field('inland_owner',null,'','text',true),
      field('owner',null,ctx.user.name),awardField,field('procurement_ref'),field('csv')),
      '登记订舱',async f=>{
        const units=f.csv.trim().split(/\r?\n/).filter(Boolean).map(line=>{
          const parts=line.split(',').map(x=>x.trim());if(![2,3,9].includes(parts.length))throw Error('每行应有 2、3 或 9 列，请核对 CSV 表头与规格');
          const unit={sn:parts[0],model:parts[1],order_id:parts[2]||null};
          if(parts.length===9){
            if(!['0','1'].includes(parts[7])||!['0','1'].includes(parts[8]))throw Error('直立和不可叠放分别填写 1 或 0');
            unit.packing={length_cm:Number(parts[3]),width_cm:Number(parts[4]),height_cm:Number(parts[5]),weight_kg:Number(parts[6]),upright:parts[7]==='1',nonstackable:parts[8]==='1'};
          }
          return unit;
        });delete f.csv;
        const out=await api(ctx,'book',{...f,evidence:f.procurement_ref,units,candidate_id:c?.id,warehouse_zone:warehouses(ctx).find(w=>w.id===f.warehouse_id)?.timezone});await done(out.shipment.id);
      });
    const award=d.querySelector('[name=ocean_rfq_id]');
    if(award)award.onchange=()=>{const a=awards.find(x=>x.id===award.value);if(a){d.querySelector('[name=procurement_ref]').value=a.ref;d.querySelector('[name=mode]').value=a.mode}};
    d.querySelector('[type=file]').onchange=async ev=>{
      const file=ev.target.files[0];if(!file)return;
      if(file.size>200000){d.querySelector('.error-line').textContent='CSV 超过 200 KB';return}
      d.querySelector('textarea').value=(await file.text()).replace(/^\uFEFF/,'').replace(/^sn,model[^\r\n]*\r?\n/i,'');
    };
  }
  const confirmations={pending:'待船方确认',confirmed:'已有确认凭据',demo:'演练班期'};
  function candidateForm(ctx,refresh){
    const dates=['doc_cutoff','gate_cutoff','planned_etd','planned_eta','pickup_eta','planned_warehouse'];
    dialog('订舱前 · 录入候选班期',cols(field('voyage'),field('origin'),field('origin_zone',zones),field('port'),
      field('port_zone',zones),field('warehouse_id',whOptions(ctx)),field('transshipment'),field('source'),
      field('confirmation',opts(confirmations)),...dates.map(k=>field(k))),'保存候选航次',async data=>{
        await api(ctx,'candidates',{candidates:[data]});await refresh();
      });
  }
  async function candidates(ctx,load,can){
    let items;
    try{items=(await ctx.api('/api/supply/candidates')).candidates}catch(err){ctx.toast(err.message);return}
    const pane=dialog('订舱前 · 候选航次比较','<p>按当地日期核对备货与截单、截港间隔，以及预计到仓是否满足客户要求。</p>'+
      '<div class="sc-controls"><label>起运港 <input name="origin"></label><label>卸货港 <input name="port"></label>'+
      field('warehouse_id',whOptions(ctx),'','text',true)+'<label>预计备货日 <input name="ready" type="date"></label>'+
      '<label>要求到仓日 <input name="requiredBy" type="date"></label></div><div data-options></div>');
    const output=pane.querySelector('[data-options]');
    const localDay=(v,zone)=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
    function draw(){
      const f=Object.fromEntries(new FormData(pane.querySelector('form')));
      const rows=items.filter(c=>(!f.warehouse_id||f.warehouse_id===c.warehouse_id)&&['origin','port'].every(k=>c[k].toLowerCase().includes(f[k].trim().toLowerCase())))
        .sort((a,b)=>a.planned_warehouse.localeCompare(b.planned_warehouse));
      output.innerHTML=rows.map(c=>{
        const issues=[];
        if(f.ready&&f.ready>localDay(c.gate_cutoff,c.origin_zone))issues.push('备货晚于截港');
        if(f.ready&&f.ready>localDay(c.doc_cutoff,c.origin_zone))issues.push('截单早于备货，需先核文件');
        if(f.requiredBy&&f.requiredBy<localDay(c.planned_warehouse,c.warehouse_zone))issues.push('预计送仓晚于要求');
        return '<article class="sc-option"><header><b>'+esc(c.voyage)+'</b> · '+esc(confirmations[c.confirmation])+'</header><p>'+
          esc(c.origin+' → '+c.port+' → '+c.warehouse+' · '+c.transshipment)+'</p><div class="sc-times">'+
          [['截单',c.doc_cutoff,c.origin_zone],['截港',c.gate_cutoff,c.origin_zone],['ETD',c.planned_etd,c.origin_zone],['ETA',c.planned_eta,c.port_zone],['预计可提',c.pickup_eta,c.port_zone],['预计送仓',c.planned_warehouse,c.warehouse_zone]]
          .map(([label,time,zone])=>'<span>'+label+' <strong>'+esc(fmt(time,zone))+'</strong> '+esc(zone)+'</span>').join('')+'</div><p>'+
          esc(c.source)+' · 录入 '+esc(fmt(c.updated_at,c.warehouse_zone))+'</p><b>'+esc(issues.join(' / ')||((f.ready||f.requiredBy)?'日期符合当前筛选':'待填写目标日期进行比较'))+'</b>'+
          (can?'<button type="button" data-select="'+esc(c.id)+'">选此航次并订舱</button>':'')+'</article>';
      }).join('')||'<p>没有匹配班期。可调整筛选或录入有来源的候选航次。</p>';
      output.querySelectorAll('[data-select]').forEach(b=>b.onclick=()=>{const c=items.find(x=>x.id===b.dataset.select);pane.close();book(ctx,load,c)});
    }
    const refresh=async()=>{items=(await ctx.api('/api/supply/candidates')).candidates;draw()};
    if(can){
      const add=document.createElement('button');add.type='button';add.textContent='录入候选班期';add.onclick=()=>candidateForm(ctx,refresh);pane.querySelector('footer').append(add);
      const upload=document.createElement('input');upload.type='file';upload.accept='application/json,.json';upload.setAttribute('aria-label','导入候选航次 JSON');
      const label=document.createElement('label');label.textContent='批量导入 JSON ';label.append(upload);pane.querySelector('footer').append(label);
      upload.onchange=async()=>{try{const file=upload.files[0];if(!file)return;if(file.size>300000)throw Error('导入文件须小于 300 KB');
        await api(ctx,'candidates',{candidates:JSON.parse((await file.text()).replace(/^\uFEFF/,''))});await refresh();
        pane.querySelector('.error-line').textContent='班期已录入。';
      }catch(err){pane.querySelector('.error-line').textContent=err.message}finally{upload.value=''}};
    }
    pane.querySelector('.sc-controls').addEventListener('input',draw);draw();
  }
  function milestone(ctx,s,done){
    let previewed='';
    const pane=dialog('S02–S04 · 登记作业回执',cols(field('kind',opts(steps)),field('at',null,iso()),field('zone_at',zones,'',null,true),field('custodian'),field('evidence'))+'<div data-docs></div><section data-impact aria-live="polite"></section>',
      '保存本次节点',async f=>{
        const body={...f,zone:f.zone_at,id:s.id,version:s.version};
        if(f.kind==='eta'&&previewed!==f.at){
          const impact=await api(ctx,'preview-eta',body);
          pane.querySelector('[data-impact]').innerHTML='<h3>本次改约影响</h3><p>预计到仓 '+esc(fmt(s.warehouse_eta,s.warehouse_zone))+' → '+esc(fmt(impact.warehouse_eta,s.warehouse_zone))+
            ' · '+esc(s.warehouse_zone)+' · '+impact.pending+' 台待实收。</p><p>'+impact.orders.map(o=>esc(o.id+' 原约 '+(o.start||'待定')+' — '+(o.end||'待定')+' '+(o.zone||''))).join('<br>')+
            '</p><p>确认后记录本次预测、保留原约，向相关岗位生成复核待办。</p>';
          previewed=f.at;pane.querySelector('[type=submit]').textContent='确认更新预测';return false;
        }
        await api(ctx,'milestone',body);await done(s.id);
      });
    const reset=()=>{previewed='';pane.querySelector('[data-impact]').replaceChildren();pane.querySelector('[type=submit]').textContent=pane.querySelector('[name=kind]').value==='eta'?'预览延误影响':'保存本次节点'};
    pane.querySelector('[name=kind]').onchange=ev=>{
      reset();const fields=ev.target.value==='handoff_site'?['bill_of_lading','pickup_site','inland_owner']:ev.target.value==='shipping_docs'&&s.mode==='FCL'?['seal']:[];
      pane.querySelector('[data-docs]').innerHTML=fields.length?cols(...fields.map(k=>field(k,null,s[k]||''))):'';
    };pane.querySelector('[name=at]').oninput=reset;
  }
  function schedule(ctx,s,done){
    const nodes=Object.entries(steps).filter(([k])=>!['eta','hold','clear_hold'].includes(k)&&!s.events.some(e=>e.kind===k));
    if(!nodes.length){ctx.toast('所有节点已有实际回执');return}
    dialog('登记节点原计划或修订预计',cols(field('kind',nodes),field('at',null,iso()),field('owner',null,ctx.user.name),field('evidence')),
      '保存计划版本',async f=>{await api(ctx,'schedule',{...f,id:s.id,version:s.version});await done(s.id)});
  }
  function plannedNodes(s){
    const entries=Object.entries(s.schedules||{});if(!entries.length)return '';
    return '<details><summary>节点计划、预计、实际及历次修订（'+entries.length+'）</summary><div class="sc-scroll"><table><thead><tr><th>节点</th><th>最初计划</th><th>最新预计</th><th>实际</th><th>凭据 / 责任人</th></tr></thead><tbody>'+entries.map(([kind,list])=>{
      const last=list.at(-1),actual=s.events.find(e=>e.kind===kind),late=Date.parse(actual?.at||last.at)>Date.parse(list[0].at);
      return '<tr><th>'+esc(steps[kind])+'</th><td>'+esc(list[0].source_time)+'</td><td class="'+(late?'late':'')+'">'+esc(last.source_time)+'</td><td>'+esc(actual?.source_time||actual?.at||'待回执')+'</td><td><details><summary>v'+list.length+' · '+esc(last.evidence)+'</summary>'+list.map((p,i)=>'<p>v'+(i+1)+' · '+esc(p.source_time)+' · '+esc(p.owner)+' · '+esc(p.evidence)+'</p>').join('')+'</details></td></tr>'
    }).join('')+'</tbody></table></div></details>';
  }
  function stockCount(ctx,o,done){
    const resolving=!!o.count_open;
    const fields=resolving?cols(field('approval_ref'),field('bin',null,o.bin),field('condition'),field('state',
      [['hold','保持隔离'],['pending_qc','实收待检'],['available','有质检及审批依据，恢复可用']]),field('evidence'))
      :cols(field('reason'),field('evidence'));
    dialog((resolving?'授权更正':'登记盘点差异')+' · '+o.sn,
      '<p>'+esc(resolving?'原差异：'+o.count_issue+' · '+o.count_ref:'登记后本台隔离，由另一位管理岗核准处置。')+'</p>'+fields,
      resolving?'确认处置':'隔离本台并登记',async f=>{
        await api(ctx,'stock-count',{...f,sn:o.sn,version:o.version,action:resolving?'resolve':'report'});await done();
      });
  }
  function receiveBatch(ctx,s,done){
    dialog('ASN · 批量扫码验收','<p>同一 ASN、仓位、验收结论和签收依据可连续扫描。货况不同请分开提交。</p>'+
      '<label class="field">SN，每行一台<textarea name="serials" rows="5" required></textarea></label>'+cols(
        field('state',[['pending_qc','实收待检'],['available','质检合格'],['hold','隔离']]),field('bin'),field('condition'),field('custodian',null,ctx.user.name),field('evidence')),
      '确认本批收货',async f=>{
        const serials=f.serials.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        const out=await api(ctx,'receive-batch',{...f,serials,id:s.id,version:s.version});
        ctx.toast('新增 '+out.accepted+' 台，已有回执 '+out.replayed+' 台');await done(s.id);
      });
  }
  function receive(ctx,s,done){
    const d=dialog('ASN · 实物到仓逐台验收','<label class="field"><span>扫描或手输 SN 后按 Tab</span><input data-scan autocomplete="off"></label>'+cols(field('sn',s.units.filter(u=>!u.receipt).map(u=>[u.sn,u.sn+' · '+u.model])),
      field('state',[['pending_qc','仅确认实收，待质检'],['available','已质检合格，可锁机'],['hold','隔离，暂停放行']]),field('free_until',null,'','date',true),field('bin'),field('condition'),field('custodian',null,ctx.user.name),field('evidence'))+
      '<label class="field">逐台收货照片（JPEG / PNG，2 MiB 以内）<input data-grn-photo type="file" accept="image/jpeg,image/png"></label>',
      '确认收货',async f=>{
        const file=d.querySelector('[data-grn-photo]').files[0];
        if(file){if(file.size>2*1024*1024)throw Error('单张收货照片上限 2 MiB');
          f.photo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('照片读取失败，请重新选择'));reader.readAsDataURL(file)});
        }
        await api(ctx,'receive',{...f,id:s.id,version:s.version});await done(s.id)});
    const scanner=d.querySelector('[data-scan]'),select=d.querySelector('[name=sn]');
    const match=()=>{const sn=scanner.value.trim().toUpperCase();if(!sn)return;select.value=sn;
      d.querySelector('.error-line').textContent=select.value?'':'此 SN 不在本批待收清单，请核对或登记实收差异';};
    scanner.oninput=match;scanner.onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();match();if(select.value)d.querySelector('[name=state]').focus()}};
    scanner.focus();
  }
  const headFees=['origin_fees','ocean_fees','inland_fees','insurance','brokerage','tax','advance_fee'];
  function headQuote(ctx,s,done){
    dialog('S01 · 头程到仓询价','<p>每行注明已含的费用填 0，未知金额留空。报价以指定仓签收为终点。</p>'+cols(
      field('vendor'),field('mode',['FCL','LCL']),field('origin_ref',null,s.origin),field('destination_ref',whOptions(ctx),s.warehouse_id),
      field('window_ref'),field('unloading'),field('currency',['USD','CNY']),...headFees.map(k=>field(k,null,'','number',true)),field('evidence')),
      '保存本份到仓报价',async f=>{await api(ctx,'head-quote',{...f,id:s.id,version:s.version});await done(s.id)});
  }
  function showHeadQuotes(s){
    const groups=new Map();
    for(const q of s.head_quotes||[]){const key=JSON.stringify(q.scope);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(q)}
    const html=[...groups.values()].map(qs=>'<h3>'+esc(qs[0].window_ref)+' · '+esc(qs[0].unloading)+' · '+esc(qs[0].currency)+'</h3><div class="sc-scroll"><table><thead><tr><th>主体 / 产品</th>'+headFees.map(k=>'<th>'+esc(titles[k])+'</th>').join('')+'<th>到仓全价</th></tr></thead><tbody>'+qs.map(q=>'<tr><td>'+esc(q.vendor)+' / '+q.mode+'</td>'+headFees.map(k=>'<td>'+esc(q.fees[k]??'待核')+'</td>').join('')+'<td>'+esc(q.total??('待核，已知 '+q.known))+'</td></tr>').join('')+'</tbody></table></div>').join('');
    dialog('头程报价 · 按相同交货点、窗口、卸货口径及币种分组',html||'<p>尚未登记头程报价。</p>');
  }
  function difference(ctx,s,done){
    dialog('ASN · 登记短少、错码或货损',cols(field('kind',[['short','预报未到'],['unexpected','发现未预报的 SN'],['damage','损伤记录']]),
      field('sn'),field('custodian'),field('owner'),field('evidence')),'登记差异',async f=>{await api(ctx,'difference',{...f,id:s.id,version:s.version});await done(s.id)});
  }
  function chart(s,scale) {
    const utcDay=86400000,gran=scale==='week'?7:1,points=[s.planned_etd,s.planned_warehouse,s.warehouse_eta,...s.events.map(e=>e.at)].map(Date.parse);
    const min=Math.floor(Math.min(...points)/utcDay)*utcDay,max=Math.max(...points),interval=Math.max(gran,Math.ceil((max-min)/utcDay/80/gran)*gran);
    const ticks=Math.max(2,Math.ceil((max-min)/utcDay/interval)+1),span=ticks*interval*utcDay;
    const offset=v=>100*(Date.parse(v)-min)/span;
    const lines=[['原计划','original',s.planned_etd,s.planned_warehouse],['最新预计','estimate',s.planned_etd,s.warehouse_eta]];
    const actual=s.events.filter(e=>!['eta','lfd'].includes(e.kind)).map(e=>e.at).sort();
    if(actual.length)lines.push(['实际回执','actual',actual[0],actual.at(-1)]);
    return '<div class="sc-scroll" tabindex="0" aria-label="可横向滚动的航次时间轴"><div class="sc-timeline" style="--ticks:'+ticks+';min-width:'+Math.max(420,ticks*55)+'px"><div class="sc-axis">'+Array.from({length:ticks},(_,i)=>'<span>'+fmt(new Date(min+i*interval*utcDay),s.warehouse_zone).split(' ')[0]+'</span>').join('')+'</div>'+lines.map(([t,c,a,b])=>'<div class="sc-track"><span class="sc-bar '+c+'" style="left:'+offset(a)+'%;width:'+Math.max(.5,offset(b)-offset(a))+'%" title="'+esc(fmt(a,s.warehouse_zone)+' — '+fmt(b,s.warehouse_zone))+'">'+t+'</span></div>').join('')+'</div></div>';
  }
  function inventory(ctx,sn){ctx.navigate('inventory?sn='+encodeURIComponent(sn))}
  async function sea(host,ctx,onRecords){
    let records=[],selected=new URLSearchParams(location.hash.split('?')[1]||'').get('batch')||'',scale='week',query='',held=false;
    const can=['admin','warehouse','inbound'].includes(ctx.user.role);
    async function load(id){
      try{
        records=(await ctx.api('/api/supply/shipments')).shipments;
        if(!host.isConnected)return;
        onRecords?.(records);
        const trace=focusASN;focusASN='';
        selected=id||records.find(s=>s.asn===trace)?.id||selected||records[0]?.id||'';
        if(trace&&!records.some(s=>s.asn===trace)){query=trace;selected='';ctx.toast('旧批次 '+trace+' 没有对应的航次清单，请在原入仓回执核查')}
        draw();
      }catch(err){host.textContent=err.message}
    }
    function draw(){
      const subset=records.filter(s=>(!held||s.hold)&&[s.voyage,s.asn,s.container,s.batch,s.origin,s.port,s.warehouse,s.owner].join(' ').toLowerCase().includes(query.toLowerCase()));
      const s=subset.find(s=>s.id===selected)||subset[0];
      host.innerHTML='<div class="sc-head"><div><small>OCEAN INBOUND　/　S01–S04</small><h2>船期与到仓甘特</h2><p>海运班期与逐台实物分列，所有时间注明作业地。</p></div><div><button class="primary" data-candidates>比较候选航次</button> '+(can?'<button data-book>登记订舱</button>':'')+'</div>'+'</div><div class="sc-controls"><label>港口、仓或责任人 <input type="search" value="'+esc(query)+'" aria-label="筛选海运"></label><label><input type="checkbox" data-hold '+(held?'checked':'')+'> 只看扣留</label></div>';
      if(!s){host.insertAdjacentHTML('beforeend','<p class="sc-empty">暂无符合条件的航次。订舱时登记装箱清单，收货岗即可按 ASN 核对。</p>')}
      else {
        const gap=Math.round((Date.parse(s.eta)-Date.parse(s.planned_eta))/3600000),events=s.events,complete=s.units.filter(u=>u.receipt).length;
        host.insertAdjacentHTML('beforeend','<div class="sc-controls">'+field('voyage',subset.map(i=>[i.id,i.voyage+' / '+i.batch+' / '+i.container]),s.id)+'<label>时间刻度<select data-scale><option value="day">日</option><option value="week">周</option></select></label></div><div class="sc-route"><b>'+esc(s.origin)+' → '+esc(s.port)+' → '+esc(s.warehouse)+'</b><span>'+esc(s.mode)+' · '+(s.inland==='rail'?'铁路 + 短驳':'公路')+' · '+esc(s.asn)+'</span></div>'+chart(s,scale)+'<div class="sc-status"><b>'+esc(s.warehouse_zone)+'</b><span>原到港 '+esc(fmt(s.planned_eta,s.port_zone||s.warehouse_zone)+' '+(s.port_zone||s.warehouse_zone))+'</span><span>最新到港 '+esc(fmt(s.eta,s.port_zone||s.warehouse_zone)+' '+(s.port_zone||s.warehouse_zone))+'</span><b class="'+(gap>0?'late':'')+'">'+(gap>0?'晚 '+gap+' 小时':gap<0?'提前 '+(-gap)+' 小时':'按原计划')+'</b><span>预计到仓 '+esc(fmt(s.warehouse_eta,s.warehouse_zone))+'</span></div><div class="sc-head"><h3>回执与影响订单</h3>'+(can?'<button data-event>登记节点 / ETA</button>':'')+'</div><div class="sc-scroll"><table><thead><tr><th>节点</th><th>作业地时间</th><th>保管人 / 凭据</th><th>受影响订单</th></tr></thead><tbody>'+events.slice().reverse().map(v=>'<tr><td>'+esc(steps[v.kind])+'</td><td>'+esc(fmt(v.at,v.zone||s.warehouse_zone)+' '+(v.zone||s.warehouse_zone))+'</td><td>'+esc(v.custodian)+' / '+esc(v.evidence)+'</td><td>'+(v.order_ids||[]).map(id=>'<button data-order="'+esc(id)+'">'+esc(id)+'</button>').join(' ')+'</td></tr>').join('')+'<tr><td>订舱</td><td>计划装船 '+esc(fmt(s.planned_etd,s.origin_zone||s.warehouse_zone)+' '+(s.origin_zone||s.warehouse_zone))+'</td><td>'+esc(s.owner)+' / '+esc(s.evidence)+'</td><td>—</td></tr></tbody></table></div><div class="sc-head"><h3>装箱 / ASN　'+complete+'/'+s.units.length+' 台实收</h3>'+(complete<s.units.length&&['admin','warehouse'].includes(ctx.user.role)?'<button data-receive>逐台验收</button> <button data-receive-batch>批量扫码验收</button>':'')+'</div><div class="sc-units">'+s.units.map(u=>'<div><b>'+esc(u.sn)+'</b> · '+esc(u.model)+' · '+esc(u.receipt?(u.state==='hold'?'隔离实收':u.state==='reserved'?'合格，已锁机':u.state==='pending_qc'?'实收待质检':u.state==='available'?'合格实收':'已实收'):'预报待收')+(u.packing?'<small>'+esc([u.packing.length_cm,u.packing.width_cm,u.packing.height_cm].join(' × ')+' cm · '+u.packing.weight_kg+' kg'+(u.packing.upright?' · 直立':'')+(u.packing.nonstackable?' · 不可叠放':''))+'</small>':'')+' '+(u.order_id?'<button data-order="'+esc(u.order_id)+'">关联订单</button>':'')+(u.receipt?.photo_sha256&&['admin','inbound','warehouse','dispatch'].includes(ctx.user.role)?'<button data-photo="'+esc(u.sn)+'">收货照片</button>':'')+(u.receipt?'<button data-stock="'+esc(u.sn)+'">查看仓内 SN</button>':'')+'</div>').join('')+'</div>');
        const bar=document.createElement('div');bar.className='sc-controls';
        const button=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=fn;bar.append(b)};
        const day=fmt(s.warehouse_eta,s.warehouse_zone).split(' ')[0];
        const sameDay=records.filter(r=>r.warehouse_id===s.warehouse_id&&fmt(r.warehouse_eta,r.warehouse_zone).split(' ')[0]===day);
        const loadCount=sameDay.reduce((total,r)=>total+r.units.filter(u=>!u.receipt).length,0);
        const warehouseNote=document.createElement('aside');warehouseNote.className='sc-arrivals';
        warehouseNote.innerHTML='<b>目的仓预计到货</b><p>'+esc(s.warehouse)+' · '+esc(day)+' · '+sameDay.length+' 批，'+loadCount+' 台待收。</p>'+
          '<p>本批实收 '+complete+' / '+s.units.length+' 台 · 当前可用 '+s.units.filter(u=>u.state==='available').length+
          ' · 已锁 '+s.units.filter(u=>u.state==='reserved').length+' · 隔离 '+s.units.filter(u=>u.state==='hold').length+'</p>'+
          '<p>'+esc(s.procurement_ref?'已确认采购订舱 · '+s.procurement_ref:'历史订舱回执 · '+(s.evidence||'待核'))+'</p>'+(s.candidate?'<p>冻结班期 '+esc(s.candidate.source)+' · '+esc(confirmations[s.candidate.confirmation])+'</p>':'')+
          '<p>提单 '+esc(s.bill_of_lading||'待核')+' · '+(s.mode==='FCL'?'柜封 '+esc(s.seal||'待核'):'分单 '+esc(s.container))+
          ' · 实际交接场站 '+esc(s.pickup_site||'待核')+' · 内陆段 '+esc(s.inland_owner||'待核')+'</p>';
        host.querySelector('.sc-status').after(warehouseNote);
        for(const task of s.reviews||[]){
          const item=document.createElement('p');
          item.textContent=({warehouse:'仓管',dispatch:'调度'}[task.role]||task.role)+' · '+task.reason+' · '+(task.closed_at?'已复核 '+task.evidence:'待复核')+' · '+fmt(task.due,s.warehouse_zone);
          if(!task.closed_at&&['admin',task.role].includes(ctx.user.role)){
            const action=document.createElement('button');action.textContent='登记复核回执';
            action.onclick=()=>dialog(task.reason,field('evidence'),'完成复核',async f=>{
              await api(ctx,'close-review',{...f,id:s.id,version:s.version,task_id:task.id});await load(s.id);
            });item.append(action);
          }
          warehouseNote.append(item);
        }
        button('作业表03 · 海运交接',()=>shippingSheet(s));
        if(['admin','procurement','inbound','warehouse'].includes(ctx.user.role))button('登记头程报价',()=>headQuote(ctx,s,load));
        if(['admin','procurement','inbound','warehouse','finance','dispatch'].includes(ctx.user.role))button('FCL / LCL 到仓比价',()=>showHeadQuotes(s));
        if(['admin','warehouse'].includes(ctx.user.role))button('登记实收差异',()=>difference(ctx,s,load));
        if(can)button('登记节点计划 / 修订',()=>schedule(ctx,s,load));
        host.append(bar);host.insertAdjacentHTML('beforeend',plannedNodes(s));for(const v of s.differences||[]){const line=document.createElement('p');line.textContent=({short:'短少',unexpected:'错码',damage:'损伤'}[v.kind]||v.kind)+' · '+v.sn+' · '+v.custodian+' 保管 · '+v.owner+' 跟进 · '+v.evidence;host.append(line)}
        host.querySelectorAll('[data-photo]').forEach(b=>b.onclick=async()=>{try{
          const photo=await api(ctx,'receipt-photo',{id:s.id,sn:b.dataset.photo});
          const viewer=dialog('收货照片 · '+b.dataset.photo,'<img alt="设备收货时拍摄的照片" style="max-width:100%">');
          viewer.querySelector('img').src='data:'+photo.mime+';base64,'+photo.base64;
        }catch(error){ctx.toast(error.message)}});
        host.querySelector('[data-scale]').value=scale;host.querySelector('[data-scale]').onchange=ev=>{scale=ev.target.value;draw()};
        host.querySelector('[name=voyage]').onchange=ev=>{selected=ev.target.value;draw()};
        host.querySelector('[data-event]')?.addEventListener('click',()=>milestone(ctx,s,load));
        host.querySelector('[data-receive-batch]')?.addEventListener('click',()=>receiveBatch(ctx,s,load));
        host.querySelector('[data-receive]')?.addEventListener('click',()=>receive(ctx,s,load));
      }
      host.querySelector('[data-candidates]').onclick=()=>candidates(ctx,load,can);
      host.querySelector('[data-book]')?.addEventListener('click',()=>book(ctx,load));
      const q=host.querySelector('input[type=search]');q.onchange=()=>{query=q.value;draw()};
      host.querySelector('[data-hold]').onchange=ev=>{held=ev.target.checked;draw()};
      host.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>ctx.openOrder(b.dataset.order));
      host.querySelectorAll('[data-stock]').forEach(b=>b.onclick=()=>inventory(ctx,b.dataset.stock));
    }
    await load();
  }
  function cardForm(ctx,supplier,cards,done,initial={}){
    const d=dialog('作业表 02 · 核验单格承接能力',cols(field('executor_id',null,initial.executor_id),field('warehouse_id',whOptions(ctx),initial.warehouse_id),
      field('product',['T1','T2','T3','T4','T5'],initial.product),field('zip',null,initial.zip),field('model',models,initial.model),field('action',opts(actions),initial.action),
      field('decision',opts(decisions),initial.decision),field('valid_until',null,initial.valid_until,'date',true),field('insurance_until',null,initial.insurance_until,'date',true),
      field('evidence',null,initial.evidence,'text',true),field('condition',null,initial.condition,'text',true),field('trial_limit',null,initial.trial_limit,'number',true)),
      '保存资格记录',async f=>{
        const prior=cards.find(c=>['executor_id','warehouse_id','product','zip','model','action'].every(k=>c[k]===f[k]));
        if(prior && (!initial.version || initial.version!==prior.version))throw Error('此能力格已有记录。请先从矩阵打开对应格子编辑');
        await api(ctx,'qualify',{...f,supplier_id:supplier.id,version:prior?.version});await done();
      });
    return d;
  }
  async function networkForm(ctx,supplier,links,done){
    const drivers=(await ctx.api('/api/drivers')).drivers;
    const options=type=>ctx.resources.filter(r=>r.type===type).map(r=>[r.id,r.name]);
    dialog('登记实际执行资源',cols(field('executor_id',null,supplier.id),field('crew_id',options('crew')),field('vehicle_id',options('vehicle')),
      field('driver',drivers.map(d=>[d.username,d.name+' / '+d.username])),field('plate'),field('warehouse_id',whOptions(ctx)),field('zip'),field('model',models),
      field('product',['T1','T2','T3','T4','T5']),field('level',['L1','L2','L3','L4','L5']),field('valid_until',null,'','date'),field('insurance_until',null,'','date'),field('evidence')),
      '保存关系凭据',async f=>{await ctx.api('/api/gate/network',{method:'POST',body:f});await done()});
  }
  function checkRate(ctx,supplier,can,parent){
    const d=dialog('按起仓与五位 ZIP 查合同产品价',cols(field('warehouse_id',whOptions(ctx)),field('zip',null,'','text',true),field('product',['T1','T2','T3','T4','T5']),field('model',models),field('on',null,new Date().toISOString().slice(0,10),'date'))+'<div class="sc-tariff"></div>','查当前版本',async(f,form)=>{
      const r=await api(ctx,'tariff',{...f,supplier_id:supplier.id,action:'check'}),out=dialog('合同价匹配结果','<p>'+esc(r.reason)+'</p><p>价区 '+esc(r.zone||'—')+' · 本产品金额 '+esc(r.amount==null?'待询价':'USD '+r.amount)+' · '+esc(r.rate_version||'无匹配版本')+'</p><p>'+esc(r.evidence||'')+'</p>');
      if(can){
        const b=document.createElement('button');b.textContent='登记 / 更正书面合同价';out.querySelector('.sc-tariff')?.remove();out.querySelector('footer').append(b);b.type='button';
        if(!f.zip)b.disabled=true;
        const ask=document.createElement('button');ask.type='button';ask.textContent='转本票人工询价';out.querySelector('footer').append(ask);
        ask.onclick=()=>dialog('登记逐票询价',cols(field('order_id',ctx.orders.filter(o=>!o.pickup&&['new','ready','at_station'].includes(o.status)).map(o=>[o.id,o.id+' · '+o.model+' · '+o.zip])),
          field('scope_ref'),field('owner',null,ctx.user.name),field('evidence')),'建立询价记录',async data=>{
            const saved=await api(ctx,'tariff',{...f,...data,supplier_id:supplier.id,action:'inquire'});
            out.close();parent?.close();ctx.toast('已登记 '+saved.inquiry.id+'，取得书面报价后按同范围录入');await ctx.openOrder(data.order_id)
          });
        b.onclick=()=>dialog('按当前仓、ZIP、产品和机型录入凭据',cols(field('zone',null,r.zone||''),field('rate_version',null,r.rate_version||''),field('amount',null,r.amount??'','number',true),field('valid_until',null,r.valid_until||'','date',true),field('evidence',null,r.evidence||'')),'保存书面价区',async data=>{
          await api(ctx,'tariff',{...f,...data,supplier_id:supplier.id,version:r.version,action:'save'});out.close();ctx.toast('价区版本已保存')
        })
      }
    });
  }
  function inviteFromSupplier(ctx,supplier,links,done){
    const rows=ctx.orders.map(o=>{
      const leg=o.status==='at_station'?2:1,q=leg===2?(o.second_leg||o.second_leg_commission):o.selected_quote;
      return {o,leg,q};
    }).filter(({o,q})=>['ready','at_station'].includes(o.status)&&q?.supplier_id===supplier.id);
    if(!rows.length){ctx.toast('没有此签约方待指派的已中选订单。请先在原单完成中选');return}
    if(!links.length){ctx.toast('请先登记实际执行方与车组、车辆、司机的关系');return}
    dialog('按中选委托登记本段执行提名',cols(field('order_id',rows.map(({o,leg})=>[o.id,o.id+' · 段 '+leg+' · '+o.zip])),
      field('link_id',links.map(l=>[l.id,l.executor_id+' · '+findName(ctx,l.crew_id)+' · '+l.plate+' · '+l.zip])),
      field('contract_ref',null,'','text',true),field('delegation_ref',null,'','text',true),field('evidence')),
      '登记提名，等待承接',async f=>{
        const {o,leg}=rows.find(r=>r.o.id===f.order_id);
        await ctx.api('/api/gate/'+encodeURIComponent(o.id)+'/invite',{method:'POST',body:{...f,version:o.version,leg}});
        await done();
      });
  }
  const stateNames={invited:'待书面接受',accepted:'已接受',issued:'已签发',released:'仓口已验放',revoked:'已撤销',refused:'拒绝'};
  async function supplierPanel(host,ctx,supplier){
    try{
      const cards=(await ctx.api('/api/supply/cards')).cards.filter(c=>c.supplier_id===supplier.id);
      const can=['admin','dispatch','procurement'].includes(ctx.user.role);
      const keys=[...new Set(cards.map(c=>JSON.stringify([c.executor_id,c.warehouse_id,c.zip,c.product])))];
      host.innerHTML='<div class="sc-head"><div><small>资格矩阵　/　'+esc(supplier.qualification)+'</small><h3>仓址 × 机型 × 动作</h3></div>'+('<div><button data-sheet>作业表02</button> <button data-rate>按 ZIP 查合同价</button> '+(can?'<button data-add-cell>登记能力格</button>':'')+'</div>')+'</div>'+ (keys.length?'<label class="field"><span>执行方 / 仓 / ZIP / 产品</span><select data-scope>'+keys.map((k,i)=>'<option value="'+i+'">'+JSON.parse(k).map((v,j)=>esc(j===1?findName(ctx,v):v)).join(' · ')+'</option>').join('')+'</select></label>':'<p>尚无书面资格记录，全部待核。</p>')+'<div class="sc-scroll" data-matrix></div><div data-network></div>';
      const reload=()=>supplierPanel(host,ctx,supplier),show=()=>{
        const key=keys[Number(host.querySelector('[data-scope]')?.value||0)],scope=key?JSON.parse(key):[];
        host.querySelector('[data-matrix]').innerHTML='<table><thead><tr><th>机型</th>'+Object.values(actions).map(n=>'<th>'+esc(n)+'</th>').join('')+'</tr></thead><tbody>'+models.map(m=>'<tr><th>'+m+'</th>'+Object.keys(actions).map(a=>{
          const c=cards.find(c=>c.executor_id===scope[0]&&c.warehouse_id===scope[1]&&c.zip===scope[2]&&c.product===scope[3]&&c.model===m&&c.action===a);
          return '<td><button data-cell="'+m+','+a+'" title="'+esc(c?.evidence||'未核')+'">'+esc(c?.decision||'U')+'</button></td>';
        }).join('')+'</tr>').join('')+'</tbody></table>';
        host.querySelectorAll('[data-cell]').forEach(b=>b.onclick=()=>{
          const [model,action]=b.dataset.cell.split(','),[executor_id,warehouse_id,zip,product]=scope;
          const c=cards.find(c=>c.executor_id===executor_id&&c.warehouse_id===warehouse_id&&c.zip===zip&&c.product===product&&c.model===model&&c.action===action);
          if(can)cardForm(ctx,supplier,cards,reload,c||{executor_id,warehouse_id,zip,product,model,action,decision:'U'});
          else ctx.toast(c?decisions[c.decision]+' · '+(c.evidence||'待补'):'待核');
        });
      };
      host.querySelector('[data-sheet]').onclick=()=>{const k=keys[Number(host.querySelector('[data-scope]')?.value||0)];supplierSheet(ctx,supplier,k?JSON.parse(k):[],cards)};
      host.querySelector('[data-rate]').onclick=()=>checkRate(ctx,supplier,can,host.closest('dialog'));
      host.querySelector('[data-add-cell]')?.addEventListener('click',()=>cardForm(ctx,supplier,cards,reload));
      if(keys.length)host.querySelector('[data-scope]').onchange=show;show();
      const n=host.querySelector('[data-network]');
      const iq=document.createElement('section');n.after(iq);
      try{const prior=(await ctx.api('/api/supply/inquiries')).inquiries.filter(v=>v.supplier_id===supplier.id);
        if(prior.length){iq.innerHTML='<h3>逐票询价记录</h3>'+prior.map(v=>'<p>'+esc(v.id)+' · '+esc(v.scope_ref)+' · '+esc(v.owner)+' <button data-oid="'+esc(v.order_id)+'">查原单</button></p>').join('');
          iq.querySelectorAll('[data-oid]').forEach(b=>b.onclick=()=>{host.closest('dialog')?.close();ctx.openOrder(b.dataset.oid)})}
      }catch(x){iq.textContent=x.message}

      try{
        const {links,grants}=await ctx.api('/api/gate/network');
        const relevant=grants.filter(g=>g.supplier_id===supplier.id||g.executor_id===supplier.id),executors=new Set([supplier.id,...cards.map(c=>c.executor_id),...relevant.map(g=>g.executor_id)]);
        n.innerHTML='<div class="sc-head"><h3>车组、授权与本票执行段</h3>'+(can?'<div><button data-link>登记执行资源</button><button data-invite>按本票登记分包 / 执行提名</button></div>':'')+'</div>'+links.filter(l=>executors.has(l.executor_id)).map(l=>'<p>'+esc(findName(ctx,l.crew_id))+' · '+esc(l.plate)+' · '+esc(l.driver)+' · ZIP '+esc(l.zip)+' · '+esc(l.evidence)+'</p>').join('')+(relevant.map(g=>'<article class="sc-grant"><b>'+esc(g.leg)+' · '+esc(stateNames[g.state]||g.state)+' · v'+esc(g.version)+'</b><p>签约 '+esc(findName(ctx,g.supplier_id))+' / 执行 '+esc(g.executor_id)+' / 应付 '+esc(findName(ctx,g.payee_id))+'</p><p>'+esc(findName(ctx,g.crew_id))+' · '+esc(g.driver)+' · '+esc(g.plate)+'</p><button data-order="'+esc(g.order_id)+'">打开订单 '+esc(g.order_id)+'</button></article>').join('')||'<p class="muted">尚无本票段授权。</p>');
        n.querySelector('[data-invite]')?.addEventListener('click',()=>inviteFromSupplier(ctx,supplier,links,reload));
        n.querySelector('[data-link]')?.addEventListener('click',()=>networkForm(ctx,supplier,links,reload).catch(e=>ctx.toast(e.message)));
        n.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>{host.closest('dialog')?.close();ctx.openOrder(b.dataset.order)});
      }catch(e){n.textContent='执行关系读取失败：'+e.message}
    }catch(e){host.textContent=e.message}
  }
  function stockPlan(ctx){
    dialog('库存位置与补货建议',cols(field('warehouse_id',whOptions(ctx)),field('model',models),field('horizon',null,iso()),
      field('demand',null,'0','number'),field('safety',null,'0','number')),'计算建议',async f=>{
      const r=await api(ctx,'stock-plan',f);
      dialog('补货计算明细','<p>合格现货含已锁 '+r.eligible+' ＋ 按期确认在途 '+r.inbound+' − 未出库确认订单 '+r.confirmed+' ＝ 库存位置 <b>'+r.position+'</b></p><p>目标 '+r.target+' 台，建议补 '+r.suggested+' 台。仅用于库存计划。</p><p>现货 '+esc(r.eligible_sns.join('、')||'无')+'</p><p>在途 '+esc(r.inbound_sns.join('、')||'无')+'</p><p>未出库订单 '+esc(r.orders.map(o=>o.id+' × '+o.quantity).join('、')||'无')+'</p>');
    });
  }
  function transfer(ctx,o,reload){
    const sending=o.state==='available';
    dialog(sending?'调拨 · 调出交接':'调拨 · 调入验收',cols(...(sending?[field('target_id',whOptions(ctx).filter(([,n])=>n!==o.warehouse)),field('approval_ref')]:[field('state',[['available','验合格'],['hold','隔离']]),field('bin'),field('condition')]),field('custodian'),field('evidence')),
      '确认交接',async f=>{await api(ctx,'transfer',{...f,sn:o.sn,version:o.version,action:sending?'send':'accept'});await reload()});
  }
  function positionRequest(ctx,o,done){
    dialog('D · 申请未售库存前置',cols(field('target_id',whOptions(ctx).filter(([,n])=>n!==o.warehouse)),field('storage_right_ref'),field('evidence')),
      '提交业务批准',async f=>{await api(ctx,'position',{...f,sn:o.sn,version:o.version,action:'request'});await done()});
  }
  async function positions(ctx){
    const {positions}=await ctx.api('/api/supply/positions');
    const states={pending:'待审批',approved:'已批准待调拨',moving:'调拨中',received:'已收仓',declined:'已退回',sold:'已售，转客户单'};
    const d=dialog('D · 未售前置审批','<p>核对库存保管书面授权与 SN。批准后，仓管通过实物记录的调拨交接办理出入仓。</p>'+
      (positions.map((r,i)=>'<article class="sc-grant"><b>'+esc(r.sn)+' · '+esc(states[r.state])+'</b><p>'+esc(r.source)+' → '+esc(r.warehouse)+' · '+esc(r.requested_by)+' · '+esc(r.storage_right_ref)+'</p>'+
      (r.approval_ref?'<p>审批依据 '+esc(r.approval_ref)+'</p>':'')+(r.state==='pending'&&ctx.user.role==='admin'&&r.requested_by!==ctx.user.username?'<button data-pos="'+i+'">办理审批</button>':'')+
      (['pending','declined','approved','received'].includes(r.state)&&['admin','warehouse'].includes(ctx.user.role)?'<button data-sell="'+i+'">已售 · 关联 A/B/C 客户单</button>':'')+
      (r.sale_order?'<button data-sale-order="'+esc(r.sale_order)+'">'+esc(r.sale_route)+' · '+esc(r.sale_order)+'</button>':'')+'</article>').join('')||'<p>暂无申请。</p>'));
    d.querySelectorAll('[data-sale-order]').forEach(b=>b.onclick=()=>{d.close();ctx.openOrder(b.dataset.saleOrder)});
    d.querySelectorAll('[data-sell]').forEach(b=>b.onclick=()=>{
      const r=positions[Number(b.dataset.sell)],wh=r.state==='received'?r.warehouse:r.source;
      const orders=ctx.orders.filter(o=>o.status==='new'&&o.warehouse===wh);
      if(!orders.length){ctx.toast('请先为该台实际持货仓建立 A/B/C 客户订单');return}
      dialog('从未售前置转客户履约',field('order_id',orders.map(o=>[o.id,o.route+' · '+o.model+' · '+o.customer+' · '+o.id]))+
        '<label class="field">销售确认凭据<input required name="sale_ref"></label>','关联本票，交仓管锁机',async f=>{
          const result=await api(ctx,'position',{...f,action:'sell',id:r.id,version:r.version,order_version:orders.find(o=>o.id===f.order_id).version});
          d.close();ctx.openOrder(result.order.id);
      });
    });
    d.querySelectorAll('[data-pos]').forEach(b=>b.onclick=()=>{const r=positions[+b.dataset.pos];
      dialog('业务审批 · '+r.sn,cols(field('action',[['approve','批准'],['decline','退回']]),field('approval_ref')),'登记决定',async f=>{
        await api(ctx,'position',{...f,id:r.id,version:r.version});d.close();await window.Supply.positions(ctx);
      })});
  }
  window.Supply={sea,stockCount,supplierPanel,stockPlan,transfer,positions,positionRequest,
    openASN(ctx,asn){focusASN=asn;ctx.navigate('ocean')}};
})();
