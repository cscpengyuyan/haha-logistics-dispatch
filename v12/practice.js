'use strict';
// Entry point from the ordinary task page. The practice adapters enforce the same operator role on the server.
window.Practice={
 async mount(host,ctx){
   if(!ctx.demo)return;
   const section=document.createElement('section');section.className='pilot-card';host.prepend(section);
   const esc=ctx.escape;
   const roles={sales:'销售',warehouse:'仓管 / 头程',procurement:'采购',dispatch:'调度',finance:'财务',driver:'执行车组',service:'技师'};
   async function draw(){
     try {
       const s=await ctx.api('/api/practice/dfw');if(!section.isConnected)return;
       const step=s.steps[s.cursor],done=!step;section.innerHTML='<div class="pilot-heading"><span>达拉斯　/　岗位接力</span><small>虚构样单 · DFW-Q01</small></div><div class="pilot-body"><div><div class="kicker">DALLAS FIELD RUN　 /　'+s.cursor+' OF '+s.steps.length+'</div><h2>'+esc(step?step.title:'美国段已核账')+'</h2><p>'+esc(step?step.detail:'物流与技术记录可回原单复核；头程和税仍待结。')+'</p>'+(s.id?'<button type="button" data-source>查看同一张原单 ↗</button>':'')+'</div><div class="pilot-action"></div></div><details><summary>查看岗位泳道与办理凭据</summary><ol class="pilot-lane">'+s.steps.map((x,i)=>'<li><b>'+esc(roles[x.role])+'</b> '+esc(x.title)+' · '+(i<s.cursor?'已办':i===s.cursor?'待办':'未到')+'</li>').join('')+'</ol><ul>'+s.log.map(x=>'<li>'+esc(x.actor+' · '+x.reference+' · '+x.at)+'</li>').join('')+'</ul></details>';
       section.querySelector('[data-source]')?.addEventListener('click',()=>ctx.openOrder(s.id));
       if(s.id&&(s.cursor===7||s.cursor===8)&&['admin','procurement','warehouse','dispatch'].includes(ctx.user.role)){
         const link=document.createElement('button');link.type='button';
         link.textContent=s.cursor===7?'办理分包提名与书面承接 →':'核实本段实到人车与 SN →';
         link.onclick=()=>ctx.navigate('gate?focus='+encodeURIComponent(s.id));
         section.querySelector('[data-source]').after(link);
       }
       const panel=section.querySelector('.pilot-action');
       if(done){panel.innerHTML=s.actual==null?'<b>交付流程已完成</b>':'<b>美国段 $'+esc(s.actual)+'</b><p>预算 $'+esc(s.approved)+' · 超预算 $'+esc(s.actual-s.approved)+'</p><small>K + T + '+esc(s.actual)+' 待结；原线等待费未核，不报净省。</small>';return}
       if(!s.can_act){panel.innerHTML='<strong>等待'+esc(roles[step.role])+'办理</strong><p>独立浏览器可用对应岗位登录；本机演练也可切换。</p><button data-switch>切换至'+esc(roles[step.role])+'</button>';panel.querySelector('button').onclick=async e=>{e.target.disabled=true;try{await ctx.api('/api/demo-login',{method:'POST',body:{username:step.role}});location.reload()}catch(err){ctx.toast(err.message);e.target.disabled=false}};return}
       panel.innerHTML='<form><label>演练凭据编号<input name="ref" required maxlength="180" value="SIM-Q01-'+String(s.cursor+1).padStart(2,'0')+'"></label>'+(s.cursor===9||s.cursor===10?s.serials.map(k=>'<label class="pilot-check"><input type="checkbox" name="sn" value="'+esc(k)+'" required>'+esc(k)+' · '+(s.cursor===9?'已到一层机位':'已通过复测')+'</label>').join(''):'')+'<button class="primary">确认并写入原单 →</button><div class="error-line" role="alert"></div></form>';
       panel.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;try{await ctx.api('/api/practice/dfw',{method:'POST',body:{cursor:s.cursor,version:s.version,reference:f.ref.value,serials:new FormData(f).getAll('sn')}});await ctx.refresh()}catch(err){f.querySelector('.error-line').textContent=err.message;btn.disabled=false}};
     }catch(e){section.textContent='演练样单暂不可读取：'+e.message}
   }await draw();
 }
};
