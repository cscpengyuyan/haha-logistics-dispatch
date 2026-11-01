'use strict';
window.Communications = {
  async mount(host, ctx, params) {
    const e = ctx.escape;
    const oid = params.get('focus') || params.get('order') || ctx.orders[0]?.id;
    host.innerHTML = '<section class="card"><small>DELIVERY APPOINTMENTS</small><h2>预约与短信预发</h2><label>选择订单 <select data-ticket>' +
      ctx.orders.map(o=>'<option value="'+e(o.id)+'" '+(oid===o.id?'selected':'')+'>'+e(o.crm_ref||o.id)+' · '+e(o.customer)+' · '+e(o.id)+'</option>').join('')+'</select></label><div data-details></div></section>';
    host.querySelector('[data-ticket]').onchange=ev=>ctx.navigate('communications?focus='+encodeURIComponent(ev.target.value));
    const detail=host.querySelector('[data-details]');
    if(!oid){detail.textContent='请先接收一票销售交单。';return}
    const order=ctx.orders.find(o=>o.id===oid)||{};
    const url=action=>'/api/communications/'+action+'/'+encodeURIComponent(oid);
    let state,live=false;
    try{state=await ctx.api(url('ticket'))}catch(err){detail.textContent=err.message;return}
    if(!ctx.demo){try{live=(await ctx.api('/api/communications/service')).live}catch{}}
    function render(){
      const a=state.appointment;
      const field=(label,key,value='',type='text')=>'<label class="field">'+label+'<input type="'+type+'" name="'+key+'" value="'+e(value||'')+'"></label>';
      detail.innerHTML='<p>承运方确认窗口、短信回执和客户答复分别记录。'+(ctx.demo?'当前为演练，模拟费用 $0。':live?'正式付费投递可用。费用按 Twilio 账户费率、分段及运营商费用结算，报价请查账户合同。':'当前为预发登记，尚未启用正式短信。')+'</p>'+
        '<p><b>预约 v'+a.version+' · '+e(a.status||'待建立')+'</b>　客户 '+e(a.customer||'待回复')+'　'+e(a.follow_up||'')+(state.stale?'　原票已变更，请重新核对':'')+'</p>'+
        '<form><div class="wf-grid">'+field('当地开始','start',a.start||order.window_start,'datetime-local')+
        field('当地结束','end',a.end||order.window_end,'datetime-local')+field('收件地 IANA 时区','zone',a.zone??order.timezone)+
        field('收件号码 E.164','phone',a.phone)+field('承运方确认窗口凭证','carrier_ref',a.carrier_ref)+
        field('短信许可凭证','consent_ref',a.consent_ref)+field('通知责任人','owner',a.owner)+
        field('提醒时刻（当地 08–19 整点）','hour',a.hour||10,'number')+field('实际在途 ETA 依据','eta_ref',a.eta_ref)+'</div>'+
        '<label><input type="checkbox" name="consent" '+(a.consent?'checked':'')+'> 已取得配送短信许可</label> '+
        '<button class="primary" type="submit">保存预约版本</button> '+(ctx.demo?'<button type="button" data-example>填入虚构预约资料</button>':'')+'</form>'+
        (a.version?'<p><select aria-label="短信模板" data-template><option>T2</option><option>T1</option><option>T3</option><option>T4</option></select> <button data-action="queue">预览并排入预发</button> <button data-action="confirm">记录客户确认</button> <button data-action="reschedule">记录要求改约</button> <button data-action="cancel">撤销预约</button> <button data-action="stop">登记 STOP</button></p>':'')+
        '<h3>本票通知记录</h3>'+state.jobs.map(j=>'<article class="card"><b>'+e(j.template)+' · v'+j.version+' · '+e(({queued:'已排预发',authorized:'已授权待发送',submitting:'提交中',submitted:'服务商已受理',delivered:'送达',manual:'人工跟进',simulated:'模拟送达',cancelled:'已撤销'})[j.state]||j.state)+'</b><p>'+e(j.phone)+' · '+e(j.due?new Date(j.due).toLocaleString("zh-CN",{timeZone:j.zone||a.zone||"UTC",hour12:false})+' '+(j.zone||a.zone||'UTC'):'计划时刻待核')+'</p><p lang="en">'+e(j.text)+'</p><p>'+e([j.reason,j.sid,j.provider_state,j.error_code,j.price?j.price+' '+j.currency:''].filter(Boolean).join(' · '))+'</p>'+
        (j.state==='queued'&&ctx.demo?'<button data-action="simulate" data-t="'+e(j.template)+'">模拟到时送达</button> ':'')+
        (j.state==='queued'&&live&&a.owner===ctx.user.username?'<button data-action="authorize" data-job="'+e(j.id)+'" data-t="'+e(j.template)+'">明确授权此条付费短信到时发送</button> ':'')+
        (['queued','authorized'].includes(j.state)?'<button data-action="cancel-job" data-t="'+e(j.template)+'">撤销预发</button>':'')+'</article>').join('');
      const f=detail.querySelector('form');
      if(detail.querySelector('[data-example]'))detail.querySelector('[data-example]').onclick=()=>{
        const day=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
        const values={start:order.window_start||day+'T09:00',end:order.window_end||day+'T16:00',zone:order.timezone||'America/Chicago',hour:10,phone:'+12145550142',owner:'SIM Dispatch',carrier_ref:'SIM window confirmation',consent_ref:'SIM training consent'};
        for(const [k,v] of Object.entries(values))f.elements[k].value=v;
        f.elements.consent.checked=true;
      };
      const send=async(action,body)=>{try{state=await ctx.api(url(action),{method:'POST',body:{...body,version:a.version}});render()}catch(err){ctx.toast(err.message)}};
      f.onsubmit=ev=>{ev.preventDefault();const v=Object.fromEntries(new FormData(f));send('save',{...v,hour:Number(v.hour),consent:f.elements.consent.checked})};
      detail.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>send(b.dataset.action,{template:b.dataset.t||detail.querySelector('[data-template]').value,job:b.dataset.job,authorize_charges:b.dataset.action==='authorize'}));
    }
    render();
  }
};
