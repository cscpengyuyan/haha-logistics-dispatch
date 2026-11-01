'use strict';
window.Procurement=(()=>{
  const root='/api/ops/procurement';
  const expenses={origin_cost:'原仓 / 干线',station_cost:'经站收发 / 短存',delivery_cost:'末端 / 加台',special_cost:'专项 / 技术 / 税',other_cost:'协调 / 其他'};
  const states={coverage:'已确认覆盖',declined:'拒接',conditional:'条件或区间价',firm:'书面可执行价',historical:'历史参考'};
  const format=value=>value==null?'待补':'$'+Number(value).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2});
  function mount(host,ctx,params=new URLSearchParams()){
    const e=v=>ctx.escape(String(v??'')),box=document.createElement('section');
    box.className='rfq';host.replaceChildren(box);
    const orderId=params.get('order')||params.get('focus')||ctx.resources?.find(r=>r.id===params.get('quote'))?.order_id;
    const order=ctx.orders.find(x=>x.id===orderId),base=root+'/'+encodeURIComponent(orderId||'');
    const write=['admin','dispatch','procurement'].includes(ctx.user.role);
    let state,queue,filter='',error='';
    function button(label,action,other=''){return '<button type="button" data-act="'+action+'" '+other+'>'+e(label)+'</button>'}
    function field(name,title,type='text',value='',required=false){
      return '<label class="field"><span>'+e(title)+'</span><input type="'+type+'" name="'+name+'" value="'+e(value)+'" '+(required?'required':'')+' '+(type==='number'?'min="0" step="0.01"':'maxlength="2000"')+'></label>'
    }
    function select(name,title,choices,current=''){
      return '<label class="field"><span>'+e(title)+'</span><select name="'+name+'">'+choices.map(([v,t])=>'<option value="'+e(v)+'" '+(v===current?'selected':'')+'>'+e(t)+'</option>').join('')+'</select></label>'
    }
    function modal(title,body,onSubmit){
      const d=document.createElement('dialog');d.className='r-dialog rfq-dialog';
      d.innerHTML='<div class="dialog-head"><h2>'+e(title)+'</h2><button type="button" aria-label="关闭">×</button></div><form class="dialog-body">'+body+'<p class="error-line" role="alert"></p><div class="dialog-foot"><button class="primary" type="submit">保存</button></div></form>';
      d.querySelector('.dialog-head button').onclick=()=>d.close();d.onclose=()=>d.remove();document.body.append(d);d.showModal();
      const form=d.querySelector('form');
      form.onsubmit=async ev=>{ev.preventDefault();const send=form.querySelector('[type=submit]');send.disabled=true;
        try{await onSubmit(Object.fromEntries(new FormData(form)));d.close()}catch(ex){form.querySelector('[role=alert]').textContent=ex.message}finally{send.disabled=false}};
      return d;
    }
    async function post(action,data={}){
      state=await ctx.api(base+'/'+action,{method:'POST',body:{version:state.version,...data}});
      error='';await ctx.refresh();
      if(box.isConnected)draw();
    }
    function reply(q={}){
      const yes=(name,title)=>'<label class="rfq-check"><input type="checkbox" name="'+name+'" '+(q[name]?'checked':'')+'>'+title+'</label>';
      modal(q.id?'修订回价 · 保留上一版':'登记供应方回执',
        '<div class="form-grid">'+field('carrier','回价单位','text',q.carrier,true)+select('path','路径',['A','B','C1','C2'].map(v=>[v,v]),q.path)+
        select('reply_state','回执阶段',Object.entries(states),q.reply_state)+select('quoted_level','书面覆盖终点',[['unknown','待确认'],['L1','L1 交接点'],['L2','L2 指定入口'],['L3','L3 指定机位']],q.quoted_level)+
        field('evidence','书面报价 / 条件 / 拒接凭据','text',q.evidence)+field('valid_until','有效至','date',q.valid_until)+
        select('supplier_id','签约供应商',[['','待核'],...ctx.resources.filter(r=>r.type==='supplier').map(r=>[r.id,r.name]),...(q.supplier_id&&!ctx.resources.some(r=>r.id===q.supplier_id)?[[q.supplier_id,q.carrier]]:[])],q.supplier_id)+
        field('executor_id','实际执行方 ID','text',q.executor_id)+select('product','采购产品',['T1','T2','T3','T4','T5'].map(v=>[v,v]),q.product)+
        field('accepted_ref','本票书面承接回执','text',q.accepted_ref)+field('execution_ref','车门 / 载荷 / 尾板 / 人员工具与场地核验书证','text',q.execution_ref)+
        field('condition_ref','附条件资质本票核实号','text',q.condition_ref)+field('station_ref','经站地址、保管与窗口凭据','text',q.station_ref)+
        field('last_leg_ref','C2 二程书面承接','text',q.last_leg_ref)+field('unload_ref','住宅卸货位置确认','text',q.unload_ref)+
        field('dispatched_ref','实际发出询价的邮件 / 系统回执','text',q.dispatched_ref)+field('follow_up','下次跟进 / 经办人','text',q.follow_up)+
        field('inclusions','明确包含','text',q.inclusions)+field('exclusions','明确排除','text',q.exclusions)+yes('same_window','对方书面确认本版相同窗口')+yes('same_liability','对方覆盖本版相同责任')+'</div>'+
        '<fieldset><legend>每票确定应付 · USD</legend><p>未知留空。请将另收尾板等已确定费用归入一行，避免重复计费。</p><div class="form-grid">'+
        Object.entries(expenses).map(([k,v])=>field(k,v,'number',q[k])).join('')+field('zero_note','零金额行的已含或免收依据','text',q.zero_note)+
        field('trigger','仅条件触发的费用及条件','text',q.trigger)+field('trigger_cap','条件合计上限 USD','number',q.trigger_cap)+
        field('notes','备注 / 区间 / 拒接原因','text',q.notes)+'</div></fieldset>',
        async data=>post('reply',{...data,same_window:data.same_window==='on',same_liability:data.same_liability==='on',id:q.id,quote_version:q.version}));
    }
    function approve(q){
      const alt=state.quotes.filter(x=>x.eligible&&x.id!==q.id&&x.rfq_id===q.rfq_id);
      modal('审批主备运输方案','<p>主方案 '+e(q.path)+' · '+e(q.carrier)+' · '+format(q.amount)+'</p><div class="form-grid">'+
        select('backup_id','备选方案',[['','无备选 · 在理由中说明'],...alt.map(x=>[x.id,x.path+' · '+x.carrier+' · '+format(x.amount)])],alt[0]?.id)+
        field('approval_ref','批准人及书面批准凭据','text','',true)+field('reason','选择理由 / 单一来源说明','text','',true)+field('switch_condition','启用备选的窗口及切换条件')+'</div>',
        data=>post('approve',{...data,quote_id:q.id,quote_version:q.version}));
    }
    function card(q){
      const signed=state.commission?.id===q.id&&state.commission.version===q.version;
      const best=state.recommended===q.id;
      const detail=(label,value)=>'<dt>'+e(label)+'</dt><dd>'+e(value||'待补')+'</dd>';
      return '<article class="rfq-offer '+(best?'rfq-best':'')+'"><small>'+e(q.path)+' / '+e(states[q.reply_state]||'既有报价')+' · v'+q.version+'</small><h3>'+e(q.carrier)+'</h3><strong>'+format(q.amount)+'</strong>'+
        '<p>'+e(signed?'已书面委托':best?'可执行首选':q.eligible?'可作备选':q.reasons.join(' · '))+'</p>'+
        (q.delta!=null&&q.delta!==0?'<p class="rfq-delta">较可执行首选 '+(q.delta<0?'低 ':'高 ')+format(Math.abs(q.delta))+'</p>':'')+
        '<details><summary>范围、费用与凭据</summary><dl>'+detail('终点 / 执行窗',[(q.quoted_level||'待核'),q.same_window?'同窗已确认':'窗口待核'].join(' · '))+
        Object.entries(expenses).map(([k,n])=>detail(n,format(q[k]))).join('')+detail('零金额依据',q.zero_note)+detail('条件增量 / 上限',q.trigger?q.trigger+' / '+format(q.trigger_cap):'无已登记条件增量')+
        detail('包含',q.inclusions)+detail('排除',q.exclusions)+detail('承接号',q.accepted_ref)+detail('有效至',q.valid_until)+detail('书证',q.evidence)+
        detail('站内交接',q.station_ref)+detail('二程承接',q.last_leg_ref)+detail('下次跟进',q.follow_up)+'</dl></details>'+
        (write&&state.scope_current&&q.rfq_id===state.pack.id?button('修订回价','reply','data-id="'+e(q.id)+'"'):'')+
        (write&&q.eligible&&state.scope_current&&q.rfq_id===state.pack?.id?button('选为主案并审批','approve','data-id="'+e(q.id)+'"'):'')+'</article>'
    }
    function draw(){
      if(!box.isConnected)return;
      if(!orderId){
        box.innerHTML='<header><small>美国境内运输采购</small><h2>待询价与委托</h2><p>从未有报价的客户票开始，按同一版终点、动作和窗口跟进各家回执。</p></header>'+
          '<div class="rfq-tools"><a href="#procurement?leg=ocean">办理进口头程询价与比价 →</a></div><div class="rfq-filters">'+button('全部','filter')+Object.entries(queue.counts).map(([k,n])=>button(k+' '+n,'filter','data-key="'+k+'" aria-pressed="'+(k===filter)+'"')).join('')+'</div>'+
          '<div>'+queue.orders.filter(o=>!filter||o.stage===filter).map(o=>'<article class="rfq-line"><div><b>'+e(o.ref)+'</b><p>'+e([o.site,o.model,o.id].filter(Boolean).join(' · '))+'</p></div><span>'+e(o.stage)+'</span>'+button('办理本票','ticket','data-id="'+e(o.id)+'"')+'</article>').join('')+'</div>';
        return
      }
      const s=state,p=s.pack;
      const can=write&&['new','ready'].includes(order?.status);
      box.innerHTML='<header><small>F01 – F04 / 美国境内运输</small><h2>'+e(order?.crm_ref||s.order_id)+' · '+e(s.stage)+'</h2><p>'+e([order?.warehouse,order?.model+' × '+order?.quantity,order?.level||'终点待确认',order?.endpoint].filter(Boolean).join(' → '))+'</p></header>'+
        '<div class="rfq-tools">'+button('返回采购队列','back')+button('本票资料','detail')+button('本单可用库存','inventory')+
        (can?button(p?'生成新版询价包':'生成本票询价包','open'):'')+'</div>'+
        '<section><h3>可用起点与实物</h3><p>'+e(Object.entries(s.stock).map(([wh,v])=>wh+' · 合格可用 '+v.available.length+' · 本票已锁 '+v.reserved.join(' / ')).join('　')||'无该型号合格实物，保留预案')+'</p>'+
        (s.site_problems.length?'<p class="rfq-missing">'+e(s.site_problems.join(' · '))+'</p>':'')+'</section>'+
        '<section><h3>运输计划候选</h3><div class="rfq-grid">'+s.candidates.map(c=>'<article><small>'+e(c.path)+'</small><h4>'+e(c.title)+'</h4><p>'+e([c.origin,c.end].filter(Boolean).join(' → '))+'</p><p>'+e(c.reasons.join(' · ')||'有可执行回价，详见承接条件')+'</p></article>').join('')+'</div><p class="muted">未售区域备货在库存前置 D 审批，成交后再选客户履约。</p></section>'+
        (p?'<section><h3>本票询价包</h3><p>'+e(p.id)+' · 截止 '+e(p.deadline)+' · '+(s.scope_current?'当前范围':'范围已变更，须重开询价')+'</p>'+
          '<details><summary>预览英文询价包</summary><pre>'+e(p.english)+'</pre></details><div class="rfq-tools">'+button('下载英文询价草稿','export')+
          (can&&s.scope_current?button('登记询价已发出','sent')+button('登记供应方回执','reply'):'')+
          (can&&ctx.demo&&s.scope_current&&order?.zip==='75201'&&order?.model==='M01'&&order?.quantity===2&&order?.level==='L3'&&!order?.addon_l4&&!order?.addon_l5&&!s.quotes.some(q=>q.rfq_id===p.id)?button('录入四份达拉斯演练回价','sample'):'')+'</div></section>':'')+
        '<section><h3>同范围全价比较 · USD / 本票</h3><div class="rfq-grid">'+(s.quotes.map(card).join('')||'<p>零份报价。生成本票询价包后即可登记覆盖、拒接、条件价或书面回价。</p>')+'</div></section>'+
        (s.approval.quote_id?'<section><h3>批准与书面委托</h3><p>'+e(s.approval.approval_ref)+' · '+e(s.approval.reason)+'</p><p>'+e(s.approval.switch_condition||'')+'　'+(s.approval.backup_id?'备选价差 '+format(s.approval.backup_delta):'无备选，见批准理由')+'</p>'+
        (s.commission.commission_ref?'<p>已有委托 '+e(s.commission.commission_ref)+'</p>':'')+
        (can&&s.approved&&!(s.commission.id===s.approval.quote_id&&s.commission.version===s.approval.quote_version)?button('登记正式书面委托','commission'):'')+
        (s.commission.id?button('到地图排车','map'):'')+'</section>':'')+'<p role="alert" class="error-line">'+e(error)+'</p>';
    }
    box.onclick=async ev=>{
      const b=ev.target.closest('button[data-act]');if(!b)return;const id=b.dataset.id,action=b.dataset.act;
      try{
        if(action==='filter'){filter=b.dataset.key||'';draw()}
        else if(action==='ticket')ctx.navigate('procurement?order='+encodeURIComponent(id));
        else if(action==='back')ctx.navigate('procurement');
        else if(action==='detail')ctx.openOrder(orderId);
        else if(action==='inventory'||action==='map')ctx.navigate(action+'?focus='+encodeURIComponent(orderId));
        else if(action==='open')modal('生成本票询价包','<p>将冻结当前票的终点、机型、仓址、作业动作及当地时间窗，可导出英文草稿。</p>'+field('deadline','回价截止日期','date',new Date(Date.now()+86400000).toISOString().slice(0,10),true),data=>post('open',data));
        else if(action==='reply')reply(state.quotes.find(q=>q.id===id));
        else if(action==='sent')modal('登记外部询价凭据','<p>记录已发生的发送，不会代发消息。</p>'+field('recipient','收到本版范围的供应方','text','',true)+field('evidence','邮件 / 系统发送回执号','text','',true),data=>post('sent',data));
        else if(action==='approve')approve(state.quotes.find(q=>q.id===id));
        else if(action==='commission')modal('登记正式书面委托',field('commission_ref','双方书面委托 / 签署号','text','',true),data=>post('commission',data));
        else if(action==='sample'){b.disabled=true;await post('sample')}
        else if(action==='export'){
          const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([state.pack.english],{type:'text/plain;charset=utf-8'}));
          link.download=state.pack.id+'.txt';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),500);
        }
      }catch(ex){error=ex.message;draw()}
    };
    if(params.get('leg')==='ocean'){
      const funds={origin_charge:'起运杂费',port_charge:'目的港杂',cfs_charge:'拆箱 / CFS',inland_charge:'送仓内陆',other_charge:'税、保险及其他确定费用'};
      const scopes=['origin','warehouse_id','units','currency','unloading','window'];
      let register;
      async function load(){
        register=await ctx.api(root+'/ocean');
        if(!box.isConnected)return;
        box.innerHTML='<header><small>进口头程 · 到库存仓</small><h2>订舱前询价</h2><a href="#procurement">美国境内订单采购</a> · <a href="#ocean">海运计划与订舱</a></header>'+
          (write&&register.candidates.length?button('从候选船期生成头程询价包','sea-open'):'')+
          (register.requests.length?'':'<p>暂无询价。先选择有来源的候选班期，再登记本批台数、卸货责任及回价截止。</p>')+
          register.requests.map(f=>'<section><small>'+e(f.id)+'</small><h3>'+e(f.voyage)+' · '+f.units+' 台</h3><p>'+e(f.origin+' → '+f.warehouse+' · '+f.unloading)+' · '+e(f.currency)+' · 到仓 '+e(f.window)+'</p><p>回价截止 '+e(f.deadline)+'</p>'+
            (f.quotes.length?'<div class="rfq-grid">'+f.quotes.map(q=>'<article><b>'+e(q.supplier)+' · '+e(q.mode)+'</b><p>'+e(q.basis_qty+' '+q.basis+' × '+(q.rate??'待回'))+'</p><p>到仓合计 '+e(q.total??'缺费用行')+' '+e(f.currency)+' · 每台 '+e(q.per_unit??'不可比')+'</p>'+
              '<p>'+e(q.included)+' / 排除 '+e(q.excluded)+'</p><p>'+e(q.evidence)+' · 有效至 '+e(q.valid_until)+'</p>'+
              (!q.scope_match?'不同起讫 / 窗口 / 责任或台数':q.replaced_by?'历史版本':'')+
              (write&&!f.shipment&&!q.replaced_by&&q.scope_match&&q.total!=null&&q.valid_until>=new Date().toISOString().slice(0,10)?button('登记书面中选','sea-award','data-req="'+e(f.id)+'" data-q="'+e(q.id)+'"'):'')+'</article>').join('')+'</div>':'<p>零份回价</p>')+
            (write&&!f.shipment?button('登记头程回价','sea-reply','data-req="'+e(f.id)+'"'):'')+
            (f.award?'<p>中选书证 '+e(f.award.ref)+' · '+e(f.award.reason)+'　'+(f.shipment?'<a href="#ocean?batch='+encodeURIComponent(f.shipment)+'">查看已订批次</a>':'<a href="#ocean">仓管选相同航次，选择中选号后录入装箱清单</a>')+'</p>':'')+'</section>').join('');
      }
      const send=async(action,body)=>{await ctx.api(root+'/ocean/'+action,{method:'POST',body});await load()};
      box.onclick=ev=>{
        const btn=ev.target.closest('[data-act]');if(!btn)return;const act=btn.dataset.act;
        const f=register.requests.find(x=>x.id===btn.dataset.req);
        if(act==='sea-open')modal('头程询价范围','<div class="form-grid">'+select('candidate_id','候选船期',register.candidates.map(c=>[c.id,c.voyage+' · '+c.origin+' → '+c.warehouse]))+field('units','本批设备数量','number','',true)+select('currency','比价币种',[['USD','USD'],['CNY','CNY']])+field('unloading','交到仓的卸货及责任约定','text','',true)+field('deadline','回价截止','date','',true)+'</div>',v=>send('open',{...v,units:Number(v.units)}));
        if(act==='sea-reply')modal('头程承运回价','<p>'+e(f.origin+' → '+f.warehouse+' · '+f.unloading)+' · '+f.units+' 台 · '+e(f.currency)+' · '+e(f.window)+'</p><div class="form-grid">'+
          field('supplier','回价承运商','text','',true)+select('mode','装运方式',[['FCL','FCL'],['LCL','LCL']])+select('basis','书面计费口径',['container','W/M','CBM','ton','shipment'].map(v=>[v,v]))+field('basis_qty','该批计费量','number','',true)+field('rate','运价 / 计费单位','number')+
          Object.entries(funds).map(([k,l])=>field(k,l+'（整批）','number')).join('')+field('included','已含 / 免收项目（注明 0 依据）','text','',true)+field('excluded','排除及另收条件','text','',true)+field('valid_until','回价有效至','date','',true)+field('evidence','书面依据','text','',true)+
          '<label><input name="same" type="checkbox"> 承运方确认上述起讫、台数、币种、责任及窗口</label></div>',
          v=>send('quote',{...v,id:f.id,version:f.version,...Object.fromEntries(scopes.map(k=>[k,v.same?f[k]:null]))}));
        if(act==='sea-award')modal('确认头程中选',field('procurement_ref','批准订舱 / 供应方确认凭据','text','',true)+field('reason','选择理由或单一来源依据','text','',true),
          v=>send('award',{...v,id:f.id,version:f.version,quote_id:btn.dataset.q}));
      };
      load().catch(ex=>{box.textContent=ex.message});return
    }
    box.textContent='正在读取采购资料…';
    ctx.api(orderId?base:root).then(data=>{if(orderId)state=data;else queue=data;draw()}).catch(ex=>{box.textContent=ex.message});
  }
  return {mount}
})();
