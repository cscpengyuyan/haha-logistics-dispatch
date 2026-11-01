/* Server-calculated finance and recovery worksheets. Examples are local training inputs. */
(() => {
  'use strict';
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={allocation:'共同费用分摊',incentive:'激励预算',storage:'仓储月费',pilot:'首派月验收',recovery:'返修路径比价'};
  const labels={common:'共同车费',id:'站点 / 订单 / SN',weight:'核准占位',specific:'本站专属费用',base:'可执行原线',
    candidate:'候选全价',route_award:'车组路线奖',labour:'新增核发人工',benefit:'客户权益',cap_pct:'批准上限（%）',
    orders:'B2B 出库单数',pallets:'托数',inbound:'入库处理 / 单',unload:'卸托 / 托',rent:'整月仓租 / 托',
    outbound:'出库处理 / 单',load:'装托 / 托',bol:'BOL / 出库单',minimum:'月最低消费',setup:'本月建档费',
    pack:'去回包装',parts:'零件',retest:'原机位复测',diagnosis:'已付诊断',deadline:'最迟恢复天数',
    pickup:'去程 / 顺带仅增量',redelivery:'复送',handling:'工位收发',repair:'维修人工',storage:'短存',wait:'等候',days:'恢复天数'};
  const templates={
    allocation:{common:300,stops:[{id:'演练甲站',weight:2,specific:0},{id:'演练乙站',weight:1,specific:60}]},
    incentive:{base:3120,candidate:2820,benefit:21,labour:12,route_award:18,cap_pct:20},
    storage:{orders:1,pallets:10,inbound:25,unload:10,rent:22,outbound:25,load:10,bol:25,minimum:500,setup:0},
    recovery:{pack:60,parts:150,retest:30,diagnosis:90,deadline:4,plans:[
      {pickup:180,redelivery:140,handling:40,repair:90,storage:0,wait:10,days:2},
      {pickup:80,redelivery:140,handling:40,repair:90,storage:20,wait:15,days:3},
      {pickup:65,redelivery:65,handling:30,repair:155,storage:10,wait:0,days:4}]}};
  const branch=['专车回中心','顺带回中心','附近修'];
  const usd=v=>v==null?'待核':'$'+Number(v).toFixed(2);
  const fmtDate=()=>new Date().toISOString().slice(0,7);
  function field(k,v,name=k,example=true){
    const number=typeof v==='number';
    return '<label class="field"><span>'+e(labels[k]||k)+'</span><input name="'+e(name)+'" type="'+(number?'number':'text')+'" '+(number?'step="any" min="0" ':'')+'value="'+e(example?v:'')+'" required></label>';
  }
  function fields(op,demo){
    if(op==='pilot')return '<label class="field"><span>按首次派单月份，保留全部失败、未结和改派</span><input name="month" type="month" required value="'+fmtDate()+'"></label>';
    const schema=templates[op],items=Object.entries(schema);
    let html='<div class="form-grid">'+items.filter(([,v])=>!Array.isArray(v)).map(([k,v])=>field(k,v,k,demo)).join('')+'</div>';
    if(op==='storage')html+='<label><input type="checkbox" name="first_exempt"> 首月合同已确认豁免最低消费</label>';
    for(const [k,arr] of items.filter(([,v])=>Array.isArray(v))){
      html+=arr.map((item,i)=>'<fieldset class="quote-lines"><legend>'+e(k==='plans'?branch[i]:'站点 '+(i+1))+'</legend><div class="form-grid">'+
        Object.entries(item).map(([n,v])=>field(n,v,k+i+'_'+n,demo)).join('')+'</div></fieldset>').join('');
    }
    return html;
  }
  function parse(op,form){
    const f=new FormData(form);if(op==='pilot')return {month:f.get('month')};
    const b={};
    for(const [k,v] of Object.entries(templates[op])){
      if(Array.isArray(v)){b[k]=v.map((row,i)=>Object.fromEntries(Object.keys(row).map(n=>[n,f.get(k+i+'_'+n)])))}
      else b[k]=f.get(k);
    }
    if(op==='storage')b.first_exempt=f.has('first_exempt');
    return b;
  }
  function result(op,r){
    if(op==='allocation')return r.rows.map(x=>e(x.id)+'　共同 '+usd(x.common)+' ＋ 专属 '+usd(x.specific)+' ＝ <b>'+usd(x.total)+'</b>').join('<br>')+'<br>原共同费分摊合计 '+usd(r.allocated_common)+'，含站点专费 '+usd(r.total);
    if(op==='incentive')return '激励前 '+usd(r.gross)+'，共用上限 '+usd(r.cap)+'，拟用 '+usd(r.used)+'。<b>预计保留 '+usd(r.remaining)+'</b> · '+(r.within?'额度内，待批准':'超出额度，请调整或另批');
    if(op==='storage')return '本月按单、按托合计 '+usd(r.subtotal)+' ＋ 最低消费补差 '+usd(r.topup)+' ＋ 建档 '+usd(r.setup)+' ＝ <b>'+usd(r.total)+'</b>';
    if(op==='recovery')return '<p>共同未来费用 '+usd(r.common)+'。顺带栏仅包括新增绕行。</p>'+r.plans.map((p,i)=>e(branch[i])+ '　未来 <b>'+usd(p.future)+'</b>，含已付诊断 '+usd(p.with_diagnosis)+'，'+p.days+' 天 · '+(p.within?'窗口内':'超出恢复期')).join('<br>');
    return '<b>'+ (r.may_expand?'双签已齐，请按核准的供应商和服务范围办理扩量':r.approved?'整批已双签，备选连续样本待核':'扩量待验证')+'</b><p>首派队列 '+r.total+' 票，其中真实 '+r.real+'、演练 '+r.samples+'。同范围已结差额 '+usd(r.net)+'</p><p>'+r.reasons.map(x=>'<span>'+e(x)+'</span>').join('；')+'</p>'+r.order_ids.map(id=>'<button type="button" data-order="'+e(id)+'">'+e(id)+'</button>').join(' ');
  }
  function pilotControls(ctx,r,box,refresh){
    const section=document.createElement('div');box.append(section);
    const info=document.createElement('p');info.textContent='已签：'+(r.signatures.map(s=>s.actor+' / '+s.evidence).join('，')||'待签')+'。符合连续样本的范围：'+(r.eligible_scopes.join('，')||'待核');section.append(info);
    if(!r.tickets.length)return;
    const labels={release_ref:'验放核验凭据',scope_ref:'服务范围核验凭据',pod_ref:'应回凭证核对依据',damage_ref:'货损 / 归责核验凭据',
      damaged:'损伤台数',valid_release:'本单各段有效放行',scope_kept:'保留已购服务',pod_complete:'应回凭据全齐',
      unsafe:'发生未经授权危险作业',abandoned:'存在未决且无人保管',first_enable:'首次就位及适用启用成功',unclear_damage:'存在归责未明的损伤',
      backup:'本票由备选执行',standard_floor:'一层标准室内单',on_time:'原窗准时',physical:'首次物理交付',enabled:'适用首次就位与启用',damaged_metric:'货损台数'};
    const frm=(title,html,act)=>{
      const dlg=document.createElement('dialog');dlg.className='r-dialog supply-dialog';dlg.innerHTML='<div class="dialog-head"><h2>'+e(title)+'</h2><button>×</button></div><form class="dialog-body">'+html+'<p class="error-line" role="alert"></p><button class="primary">保存核验</button></form>';
      document.body.append(dlg);dlg.showModal();dlg.querySelector('.dialog-head button').onclick=()=>dlg.close();dlg.addEventListener('close',()=>dlg.remove(),{once:true});
      dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const b=ev.target.querySelector('.primary');b.disabled=true;try{
        const next=await ctx.api('/api/settlement/pilot',{method:'POST',body:{month:r.month,...act(new FormData(ev.target))}});dlg.close();refresh(next);
      }catch(x){ev.target.querySelector('.error-line').textContent=x.message}finally{b.disabled=false}};
    };
    const btn=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;section.append(b)};
    const choice=(k,values)=>'<label class="field">'+e(labels[k]||k)+'<select name="'+e(k)+'" required><option value="">请选择</option>'+values.map(([v,t])=>'<option value="'+e(v)+'">'+e(t)+'</option>').join('')+'</select></label>';
    const input=(k,label,t='text')=>'<label class="field">'+e(label)+'<input required name="'+e(k)+'" type="'+t+'" '+(t==='number'?'min="0" step="1"':'maxlength="300"')+'></label>';
    if(['dispatch','admin'].includes(ctx.user.role))btn('逐票核放行、范围及安全',()=>{
      const flags=['valid_release','scope_kept','pod_complete','unsafe','abandoned','first_enable','unclear_damage','backup','standard_floor'];
      frm('首派月 · 原单核验','<div class="form-grid">'+choice('order_id',r.tickets.map(t=>[t.id,t.id+' · '+t.group+(t.sample?' · 演练':'')]))+
        ['release_ref','scope_ref','pod_ref','damage_ref'].map(k=>input(k,labels[k])).join('')+input('damaged',labels.damaged,'number')+
        flags.map(k=>choice(k,[['yes','是'],['no','否']])).join('')+'</div>',fd=>{
          const id=fd.get('order_id'),o=ctx.orders.find(x=>x.id===id);return {...Object.fromEntries(fd),...Object.fromEntries(flags.map(k=>[k,fd.get(k)==='yes'])),
            action:'attest',version:r.versions[id]||0,order_version:o?.version,order_id:id};
        });
    });
    if(['finance','admin'].includes(ctx.user.role))btn('登记同类服务历史分母',()=>{
      const metrics=['on_time','physical','enabled','damaged'];
      frm('同类原线 · 留存观察分子与分母','<div class="form-grid">'+choice('group',[...new Set(r.tickets.map(t=>t.group))].map(g=>[g,g]))+input('evidence','历史样本凭据')+
        metrics.map(k=>input(k+'N',labels[k==='damaged'?'damaged_metric':k]+' · 分子','number')+input(k+'D','对应分母（不适用填 0）','number')).join('')+'</div>',fd=>({action:'benchmark',group:fd.get('group'),version:r.versions['base:'+fd.get('group')]||0,evidence:fd.get('evidence'),
          ...Object.fromEntries(metrics.map(k=>[k,[fd.get(k+'N'),fd.get(k+'D')]]))}));
    });
    if(r.quality_ready&&['finance','admin'].includes(ctx.user.role))btn('签署本月批次复核',()=>{
      frm('批次签核 · '+r.month,input('evidence','业务或财务批准依据'),fd=>({action:'sign',snapshot:r.snapshot,version:r.versions['sign:'+ctx.user.role]||0,evidence:fd.get('evidence')}));
    });
  }
  function open(ctx,op){
    const d=document.createElement('dialog');d.className='r-dialog supply-dialog';const demo=ctx.demo||ctx.publicDemo;
    d.innerHTML='<header class="dialog-head"><h2>'+e(names[op])+'</h2><button aria-label="关闭">×</button></header><form class="dialog-body"><p>'+ (op==='pilot'?'按当前数据库与真实首派记录核对整月队列。':demo?'演练输入可修改。金额单位 USD。':'按本票已取得的报价与依据填入金额，单位 USD。')+'</p>'+fields(op,demo)+
      (op==='pilot'?'':'<details><summary>随单保存测算记录</summary><label class="field">原单<select name="ticket"><option value="">只做本次测算</option>'+ctx.orders.map(o=>'<option value="'+e(o.id)+'">'+e(o.id+' · '+(o.crm_ref||o.model))+'</option>').join('')+'</select></label><label class="field">计算依据 / 原始单据号<input name="evidence"></label>'+(op==='recovery'?'<label class="field">分诊或 RMA 工单号<input name="case_id"></label>':'')+'</details>')+
      '<div class="error-line" role="alert"></div><footer class="dialog-foot"><button class="primary" type="submit">'+(op==='pilot'?'核验队列':'计算结果')+'</button></footer><div class="sc-grant" role="status" hidden></div></form>';
    document.body.append(d);d.showModal();d.querySelector('header button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});
    d.querySelector('form').onsubmit=async ev=>{
      ev.preventDefault();const form=ev.target,b=parse(op,form),btn=form.querySelector('[type=submit]'),err=form.querySelector('.error-line'),box=form.querySelector('[role=status]');
      if(btn.disabled)return;btn.disabled=true;err.textContent='';box.hidden=true;
      try{
        if(form.elements.ticket?.value){const o=ctx.orders.find(o=>o.id===form.elements.ticket.value);
          Object.assign(b,{save:true,order_id:o.id,version:o.version,evidence:form.elements.evidence.value,case_id:form.elements.case_id?.value});}
        const r=await ctx.api('/api/settlement/'+op,{method:'POST',body:b});
        const show=value=>{
          box.hidden=false;box.innerHTML=result(op,value)+(value.worksheet_id?'<p>已存工作表 '+e(value.worksheet_id)+'</p>':'');
          box.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>{d.close();ctx.openOrder(b.dataset.order)});
          if(op==='pilot')pilotControls(ctx,value,box,show);box.scrollIntoView({block:'nearest'})
        };show(r);
      }catch(x){err.textContent=x.message}finally{btn.disabled=false}
    };
  }
  function mount(host,ctx,view){
    const s=document.createElement('section');s.className='supply-card';s.innerHTML='<div class="sc-head"><div><small>'+ (view==='review'?'FINANCE　/　PILOT':'AFTERCARE　/　RMA')+'</small><h3>'+ (view==='review'?'费用工作表与试点验收':'恢复路径费用工作表')+'</h3></div></div><div class="sc-controls"></div>';
    for(const op of view==='review'?['allocation','incentive','storage','pilot']:['recovery']){
      const b=document.createElement('button');b.textContent=names[op];b.onclick=()=>open(ctx,op);s.querySelector('.sc-controls').append(b)
    }
    if(ctx.orders.length){
      const history=document.createElement('button');history.textContent='查随单工作表';history.onclick=()=>{
        const d=document.createElement('dialog');d.className='r-dialog supply-dialog';
        d.innerHTML='<header class="dialog-head"><h2>已存成本工作表</h2><button aria-label="关闭">×</button></header><div class="dialog-body"><label class="field">选择订单<select>'+ctx.orders.map(o=>'<option value="'+e(o.id)+'">'+e(o.id+' · '+(o.crm_ref||o.model))+'</option>').join('')+'</select></label><div data-results></div></div>';
        document.body.append(d);d.showModal();d.querySelector('button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});
        const sel=d.querySelector('select'),box=d.querySelector('[data-results]');let read=0;const load=async()=>{const id=++read;
          try{const x=await ctx.api('/api/settlement/history',{method:'POST',body:{order_id:sel.value}});
            if(id===read)box.innerHTML=x.worksheets.map(w=>'<article class="sc-grant"><b>'+e(names[w.kind])+' · '+e(w.id)+'</b><p>'+e(w.actor)+' · '+e(w.ts)+' · '+e(w.inputs.evidence)+'</p>'+result(w.kind,w.result)+'</article>').join('')||'<p>暂无此单的费用工作表。</p>';
          }catch(err){if(id===read)box.textContent=err.message}};
        sel.onchange=load;load()
      };s.querySelector('.sc-controls').append(history);
    }
    host.append(s);
  }
  window.Settlement={mount};
})();
