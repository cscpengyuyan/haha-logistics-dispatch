'use strict';
window.TicketTraining={
  async mount(container,ctx,params){
    const host=document.createElement('div');container.replaceChildren(host);
    const data=await ctx.api('/api/orders').catch(err=>{host.textContent=err.message});
    if(!data||!host.isConnected)return;
    ctx={...ctx,orders:data.orders};
    const e=ctx.escape, oid=params.get('focus');
    const o=ctx.orders.find(x=>x.id===oid&&x.crm_ref==='DEMO-DAL-02')||ctx.orders.find(x=>x.crm_ref==='DEMO-DAL-02');
    host.innerHTML='<section class="card"><small>DALLAS · TRAINING</small><h2>跟做一票达拉斯两台</h2><p>商业楼一层机位，两台 M01。销售、物流、仓管、采购分别留下凭据后，由车组逐台签收，财务对照 $510 演练发票。</p><div data-actions></div></section>';
    const box=host.querySelector('[data-actions]');
    const go=(label,page)=>{const a=document.createElement('a');a.className='btn';a.href='#'+page;a.textContent=label;box.append(a)};
    if(!o||o.status==='intake'){go('销售交单 · 下载达拉斯工作簿 → 上传预检 → 确认导入并接手','sales');return}
    const id=encodeURIComponent(o.id);
    box.innerHTML='<p>'+e(o.crm_ref)+' · '+e(o.id)+'　<strong>'+e(ctx.statusNames[o.status]||o.status)+'</strong></p>';
    const btn=(label,action,role,body=()=>({}))=>{
      const b=document.createElement('button');b.className='primary';b.textContent=label;
      if(!['admin',role].includes(ctx.user.role)){b.disabled=true;b.title='请使用'+role+'岗位'}
      b.onclick=async()=>{b.disabled=true;try{await ctx.api('/api/practice/ticket/'+id+'/'+action,{method:'POST',body:{version:o.version,...body()}});await ctx.refresh()}catch(err){ctx.toast(err.message);b.disabled=false}};
      box.append(b);
    };
    if(o.status==='new')btn('仓管核对并锁定 SIM-RFQ-M01-01、02','lock','warehouse');
    if(o.status==='ready'&&!o.selected_quote)go('采购 · 生成本票询价包、比较并书面委托','procurement?focus='+id);
    if(o.status==='ready'&&o.selected_quote){
      go('地图 · 计算并保存本票道路试排','road?focus='+id);
      if(o.training_road||!ctx.publicDemo)btn('按演练人车与逐段承接凭据签发','issue','dispatch');
    }
    if(['ready','dispatched','in_transit'].includes(o.status)&&['admin','dispatch','service'].includes(ctx.user.role))go('前一当地日提醒 · 预约与短信','communications?focus='+id);
    if(o.status==='dispatched')btn('仓管逐台核验并移交车组','release','warehouse');
    if(o.status==='in_transit'){
      for(const sn of ['SIM-RFQ-M01-01','SIM-RFQ-M01-02']){
        const label=document.createElement('label');label.innerHTML='<input type="checkbox" value="'+sn+'"> '+sn+' 已交至约定机位 ';box.append(label);
      }
      btn('提交两台演练签收凭证','sign','driver',()=>({serials:[...box.querySelectorAll('input:checked')].map(x=>x.value)}));
    }
    if(o.status==='delivered')btn('财务对照回单、委托与 $510 发票核账','settle','finance');
    if(o.status==='settled')box.insertAdjacentHTML('beforeend','<p>已核账　演练发票 SIM-INV-510 · 两台设备完成交付。</p>');
    go('查看本票凭证和时间线','orders?order='+id);
  }
};
