'use strict';
(() => {
  function open(ctx,views){
    if(document.querySelector('dialog[open]'))return;
    const d=document.createElement('dialog');d.className='command-dialog';document.body.append(d);
    d.innerHTML='<form method="dialog" class="command-head"><span aria-hidden="true">⌕</span><label class="sr-only" for="quick-search">查订单或工作区</label><input id="quick-search" type="search" autocomplete="off" placeholder="输入单号、CRM、SN、客户、ZIP 或工作区"><button aria-label="关闭搜索">Esc</button></form><div class="command-body"></div><div class="command-foot">↑ ↓ 选择　↵ 打开</div>';
    const input=d.querySelector('input'),host=d.querySelector('.command-body'),e=ctx.escape;
    let choices=[],active=0;
    const go=i=>{const item=choices[i];if(!item)return;d.close();if(item.order)ctx.openOrder(item.order);else ctx.navigate(item.view)};
    function render(){
      const q=input.value.trim().toLowerCase();choices=[];active=0;
      const pages=views.filter(p=>(p.label+' '+p.key).toLowerCase().includes(q)).slice(0,q?8:4);
      const orders=ctx.orders.filter(o=>[o.id,o.customer,o.crm_ref,o.sn,o.city,o.state,o.warehouse,o.zip].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,q?20:4);
      function button(item,t,sub,kind){const i=choices.push(item)-1;return '<button type="button" data-i="'+i+'" class="command-result"><span class="cmd-symbol">'+kind+'</span><span><b>'+e(t)+'</b><small>'+e(sub)+'</small></span><em>↗</em></button>'}
      host.innerHTML=(orders.length?'<div class="cmd-group">订单 · 当前岗位可见</div>'+orders.map(o=>button({order:o.id},o.customer+'　'+o.id,[o.warehouse,o.model,o.zip,ctx.statusNames[o.status]||o.status].filter(Boolean).join(' · '),'单')).join(''):'')+(pages.length?'<div class="cmd-group">工作区</div>'+pages.map(p=>button({view:p.key},p.label,p.desc,'区')).join(''):'')||'<p class="empty">未找到匹配项。可尝试 CRM 号、设备 SN 或邮编。</p>';
      mark()
    }
    function mark(){host.querySelectorAll('button').forEach((b,i)=>b.classList.toggle('highlight',i===active))}
    host.onclick=ev=>{const b=ev.target.closest('button[data-i]');if(b)go(+b.dataset.i)};
    input.oninput=render;
    d.addEventListener('keydown',ev=>{if(!choices.length)return;if(ev.key==='Enter'&&ev.target===input){ev.preventDefault();go(active)}else if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();active=(active+(ev.key==='ArrowDown'?1:-1)+choices.length)%choices.length;mark();host.querySelector('.highlight')?.scrollIntoView({block:'nearest'})}});
    d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();render();input.focus()
  }
  window.OrderFinder={open};
})();

