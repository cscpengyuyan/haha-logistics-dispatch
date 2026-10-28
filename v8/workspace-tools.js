/* V8 workspace recovery and explicit, versioned collaboration. */
(function(H){
  'use strict';
  const e=H.e;
  const C={base:'',token:null,user:null,version:null,remote:null,hasBase:false,dirty:false,conflict:false,health:null,busy:false};
  H.collaboration=C;
  try{C.base=localStorage.getItem('haha-v8-api-url')||'';}catch{}
  const previousSettings=H.pages.settings,previousMount=H.mounts.settings;
  const roles={admin:'管理员',dispatcher:'调度员',readonly:'只读'};
  const localDate=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未保存';
  const canWrite=()=>C.user&&['admin','dispatcher'].includes(C.user.role);
  function baseURL(raw){
    const u=new URL(String(raw).trim());
    if(u.username||u.password||u.hash||u.search)throw new Error('服务地址不能包含账号、密码、查询参数或片段');
    const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
    if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local))throw new Error('协作服务须使用 HTTPS；本机开发可使用 localhost');
    return u.href.replace(/\/$/,'');
  }
  async function request(path,{method='GET',body,auth=true,base=C.base}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const headers={Accept:'application/json'};
      if(body!==undefined)headers['Content-Type']='application/json';
      if(auth){if(!C.token)throw new Error('请先登录协作服务');headers.Authorization='Bearer '+C.token;}
      const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',signal:controller.signal,cache:'no-store',redirect:'error'});
      if(res.status===204)return null;
      let data;try{data=await res.json();}catch{throw new Error('服务未返回有效 JSON，请核对地址与部署状态');}
      if(!res.ok){
        const err=new Error(data.error?.message||'服务请求失败（'+res.status+'）');err.status=res.status;err.code=data.error?.code;
        if(res.status===401&&auth){C.token=null;C.user=null;C.hasBase=false;}
        if(res.status===409){C.conflict=true;C.dirty=true;}
        throw err;
      }
      return data;
    }catch(err){if(err.name==='AbortError')throw new Error('连接超时，请检查服务地址与网络');throw err;}
    finally{clearTimeout(timer);updateIndicator();}
  }
  function visibleState(){
    const copy=H.clone(H.state);
    // Local map credentials and view preferences never travel to the shared service.
    if(copy.settings){delete copy.settings.tiles;delete copy.settings.viewZone;}
    return copy;
  }
  function applyState(data,reason){
    H.validateState(data);
    H.checkpoint(reason);
    const local={tiles:H.state.settings.tiles,viewZone:H.state.settings.viewZone};
    const copy=H.clone(data);copy.schema=7;
    if(local.tiles)copy.settings.tiles=local.tiles;
    if(local.viewZone)copy.settings.viewZone=local.viewZone;
    H.state=H.services?H.services.init(copy):copy;
    H.dispatch?.resetForDataChange?.();
    H.selectedOrder=H.state.orders.some(x=>x.id===H.selectedOrder)?H.selectedOrder:H.state.orders[0]?.id;
    H.save(reason);
  }
  function backup(){H.download('HAHA-V8-backup-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(H.state,null,2));}
  function updateIndicator(){
    const badge=H.$('[data-save-status]');if(!badge)return;
    badge.classList.toggle('save-error',!!H.storageInfo.error||C.conflict);
    badge.textContent=H.storageInfo.error?'未保存 · 请导出备份':C.conflict?'协作冲突 · 本机已保留':C.token?(C.dirty?'协作 · 有待同步更改':'协作 · 版本 '+(C.version??'—')):'演示 · 本机已保存';
    badge.title='本机保存：'+localDate(H.storageInfo.savedAt)+(C.user?'；账号：'+C.user.username+'，'+roles[C.user.role]:'；在「接口与时区」管理备份和协作');
  }
  function collaborationHTML(){
    const connected=!!C.token;
    return `<section class="card collaboration-card"><div class="card-head"><div><h2>数据与协作</h2><p>本机即时保存，服务器按版本同步。</p></div><span class="pill ${connected?'green':'blue'}">${connected?'服务已连接':'本机工作区'}</span></div><div class="card-body"><div class="collab-summary"><div><small>最近本机保存</small><b>${e(localDate(H.storageInfo.savedAt))}</b></div><div><small>当前工作区</small><b>${H.state.orders.length} 单 · ${H.state.inventory.length} 条库存</b></div><div><small>数据模式</small><b>${connected?'手动同步 · 冲突保护':'浏览器独立保存'}</b></div></div>
      ${H.storageInfo.migratedFrom?'<div class="notice green">已读取 V7 工作区，V8 使用独立存储。原始数据仍可在旧版查看。</div>':''}
      ${connected?`<div class="notice ${C.conflict?'amber':'green'}">${C.conflict?'服务器已出现较新版本。本机更改已保留；请先导出本机备份，再拉取服务器版本核对。':C.remote?.state&&!C.hasBase?'登录成功。请先拉取服务器工作区，再编辑和同步。':!C.remote?.state?'服务器工作区为空，可用本机数据初始化。':C.dirty?'本机有更改，确认后可同步到服务器。':'当前基于服务器版本 '+C.version+'。同步为手动操作。'}</div><div class="collab-account"><div><b>${e(C.user.username)}</b> <span class="pill">${e(roles[C.user.role]||C.user.role)}</span><small>${e(C.base)}</small></div><button class="btn" id="collab-logout">退出服务</button></div><div class="actions"><button class="btn" id="collab-pull">拉取服务器版本</button><button class="btn primary" id="collab-push" ${!canWrite()||!C.hasBase||C.conflict?'disabled':''}>${C.remote?.state?'同步本机更改':'初始化共享工作区'}</button><button class="btn" id="collab-audit">查看服务端记录</button><button class="btn" id="collab-backup">导出本机备份</button></div><p class="muted section-gap">此连接用于管理员和调度员共享工作区。客户与司机入口仍为演示视角；短信、道路导航和订单级授权尚未接入。</p>`:
      `<form id="collab-login"><div class="collab-form"><label class="field">协作服务地址<input name="base" type="url" required value="${e(C.base)}" placeholder="https://your-service.example.com" autocomplete="url"></label><label class="field">账号<input name="username" required autocomplete="username" placeholder="管理员或调度员账号"></label><label class="field">密码<input name="password" type="password" required autocomplete="current-password" placeholder="服务端配置的账号密码"></label></div><div class="actions"><button class="btn" type="button" id="collab-test">测试连接</button><button class="btn primary" type="submit">登录协作服务</button><a class="btn" href="https://github.com/cscpengyuyan/haha-logistics-dispatch/tree/main/server" target="_blank" rel="noopener">部署说明 ↗</a></div></form><p class="muted section-gap">部署随版本提供的服务后再连接。登录不会自动上传或覆盖数据；密码和登录令牌仅留在当前页面内存中。</p>`}
      <div id="collab-feedback" role="status" aria-live="polite"></div></div></section>`;
  }
  H.pages.settings=()=>collaborationHTML()+previousSettings();
  function feedback(text,tone=''){const el=H.$('#collab-feedback');if(el){el.className='notice section-gap '+tone;el.textContent=text;}}
  async function run(button,fn){
    if(C.busy)return;C.busy=true;if(button)button.disabled=true;
    try{await fn();}catch(err){feedback(err.message,'amber');H.toast(err.message);}
    finally{C.busy=false;if(button?.isConnected)button.disabled=false;updateIndicator();}
  }
  async function getRemote(){
    const remote=await request('/api/v1/workspace');
    if(!Number.isInteger(remote.version)||remote.version<0)throw new Error('服务器版本号无效');
    if(remote.state)H.validateState(remote.state);
    return remote;
  }
  function pull(){
    return run(H.$('#collab-pull'),async()=>{
      const remote=await getRemote();
      if(!remote.state){C.remote=remote;C.version=remote.version;C.hasBase=true;C.conflict=false;H.render();H.toast('共享工作区为空，可以初始化');return;}
      H.modal('拉取服务器工作区',`<div class="notice">服务器版本 ${remote.version} · ${remote.state.orders.length} 单。拉取后替换本机状态，并自动保留一个可恢复副本。</div><p>当前本机 ${H.state.orders.length} 单。${C.dirty?'本机有未同步更改，请先导出备份。':''}</p><label class="check-row"><input type="checkbox" required>我已核对，使用服务器版本</label>`,()=>{
        applyState(remote.state,'拉取服务器工作区');C.remote=remote;C.version=remote.version;C.hasBase=true;C.dirty=false;C.conflict=false;H.toast('已载入服务器版本 '+remote.version);
      },'保留恢复点并拉取');
    });
  }
  function push(){
    if(!canWrite()||!C.hasBase||C.conflict)return;
    H.modal(C.remote?.state?'同步本机更改':'初始化共享工作区',`<p>将 ${H.state.orders.length} 单和 ${H.state.inventory.length} 条库存同步至：</p><p class="mono collab-url">${e(C.base)}</p><div class="notice">基于服务器版本 ${C.version}。如果其他成员已先保存，本次会停止并提示冲突。地图密钥和本机时间视角不会上传。</div><label class="check-row"><input type="checkbox" required>确认同步当前工作区</label>`,async()=>{
      const version=C.version,revision=H.state.workspaceMeta?.revision;
      const state=visibleState();H.validateState(state);
      const data=await request('/api/v1/workspace',{method:'PUT',body:{version,state}});
      if(!Number.isInteger(data.version)||data.version<=version)throw new Error('服务未返回有效的新版本');
      C.version=data.version;C.remote={...data,state};C.hasBase=true;C.conflict=false;C.dirty=H.state.workspaceMeta?.revision!==revision;
      H.toast('同步成功 · 服务器版本 '+data.version);
    },'确认同步');
  }
  function mountCollaboration(){
    const form=H.$('#collab-login');
    if(form){
      H.$('#collab-test').onclick=()=>run(H.$('#collab-test'),async()=>{
        const base=baseURL(new FormData(form).get('base'));
        const health=await request('/api/v1/health',{base,auth:false});
        if(!health.ok||!health.capabilities?.workspaceSync)throw new Error('服务未提供兼容的工作区接口');
        C.health=health;feedback('连接正常：支持共享工作区与审计。尚未登录或传输业务数据。','green');
      });
      form.onsubmit=ev=>{ev.preventDefault();run(form.querySelector('[type=submit]'),async()=>{
        const fd=new FormData(form),base=baseURL(fd.get('base'));
        const session=await request('/api/v1/session',{method:'POST',auth:false,base,body:{username:String(fd.get('username')).trim(),password:String(fd.get('password'))}});
        if(!session.token||!session.user)throw new Error('服务未返回有效会话');
        C.base=base;C.token=session.token;C.user=session.user;C.hasBase=false;C.conflict=false;
        form.querySelector('[name=password]').value='';
        try{localStorage.setItem('haha-v8-api-url',base);}catch{}
        C.remote=await getRemote();C.version=C.remote.version;C.hasBase=!C.remote.state;C.dirty=false;H.render();
      });};
    }else{
      H.$('#collab-logout').onclick=()=>run(H.$('#collab-logout'),async()=>{
        try{await request('/api/v1/session',{method:'DELETE'});}finally{C.token=null;C.user=null;C.hasBase=false;C.remote=null;C.version=null;C.conflict=false;H.render();}
      });
      H.$('#collab-pull').onclick=pull;H.$('#collab-push').onclick=push;H.$('#collab-backup').onclick=backup;
      H.$('#collab-audit').onclick=()=>run(H.$('#collab-audit'),async()=>{
        const data=await request('/api/v1/audit?limit=30');const rows=Array.isArray(data)?data:data.items||data.entries||data.records||data.audit||data.events||[];
        if(!Array.isArray(rows))throw new Error('审计记录格式无效');
        H.modal('最近服务端记录',`<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>操作人</th><th>操作</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${e(localDate(x.at||x.createdAt||x.time))}</td><td>${e(x.actor||x.username||'—')}</td><td>${e(x.action||x.event||'—')}<small>${e(typeof (x.details??x.detail)==='string'?(x.details??x.detail):JSON.stringify(x.details??x.detail??{}))}</small></td></tr>`).join('')||'<tr><td colspan="3">暂无记录</td></tr>'}</tbody></table></div>`);
      });
    }
  }
  function mountBackup(){
    H.$('#backup-export').onclick=backup;
    H.$('#backup-file').onchange=async ev=>{
      const file=ev.target.files[0];ev.target.value='';if(!file)return;
      try{
        if(file.size>5*1024*1024)throw new Error('备份大于 5 MB');
        const data=H.validateState(JSON.parse(await file.text()));
        H.modal('导入工作区备份',`<p>${e(file.name)}</p><div class="notice">当前 ${H.state.orders.length} 单 → 导入 ${data.orders.length} 单；${data.inventory.length} 条库存。导入前自动保留当前恢复点。</div><label class="check-row"><input type="checkbox" required>确认导入到本机工作区</label>`,()=>{applyState(data,'导入工作区备份');H.toast('导入完成，可通过恢复点撤回');},'保留恢复点并导入');
      }catch(err){H.toast('无法导入：'+err.message);}
    };
    H.$('#demo-reset').onclick=()=>H.modal('恢复示例工作区',`<p>将载入随版本提供的示例业务数据。重置前会保留当前恢复点。</p><label class="check-row"><input type="checkbox" required>确认恢复示例</label>`,()=>{applyState(H.clone(HH_SEED),'恢复示例工作区');H.toast('已恢复示例，原工作区可从恢复点找回');},'保留恢复点并重置');
    const recover=document.createElement('button');recover.className='btn';recover.type='button';recover.id='backup-recover';recover.textContent='恢复上次工作区';
    H.$('#backup-export').parentElement.append(recover);
    recover.onclick=()=>{
      try{
        const snapshot=JSON.parse(localStorage.getItem(H.recoveryKey)||'null');if(!snapshot?.state){H.toast('尚无恢复点；导入、拉取或重置前会自动创建');return;}
        H.validateState(snapshot.state);
        H.modal('恢复上次工作区',`<p>恢复点：${e(localDate(snapshot.createdAt))}</p><p>来源：${e(snapshot.reason)} · ${snapshot.state.orders.length} 单</p><label class="check-row"><input type="checkbox" required>确认恢复此工作区</label>`,()=>{applyState(snapshot.state,'恢复上次工作区');H.toast('恢复完成，已保留替换前的工作区');},'恢复');
      }catch(err){H.toast('恢复点不可用：'+err.message);}
    };
  }
  H.mounts.settings=()=>{previousMount();mountCollaboration();mountBackup();};
  H.afterRender=function(){
    updateIndicator();
    if(H.storageInfo.loadError&&!H.storageInfo.warned){H.storageInfo.warned=true;setTimeout(()=>H.toast('原工作区读取失败，当前显示示例。请到设置恢复备份：'+H.storageInfo.loadError),200);}
  };
  window.addEventListener('haha:state-saved',()=>{if(C.token)C.dirty=true;updateIndicator();});
  if(!H.storageInfo.savedAt&&!H.storageInfo.error)H.persist();
  for(const page of ['driver','portal','comms']){
    const view=H.pages[page],mount=H.mounts[page];
    H.pages[page]=()=>H.state.orders.length?view():H.heading('暂无配送任务','录入或导入订单后，即可继续预约、客户资料收集和司机操作。')+'<section class="card"><div class="card-body"><button class="btn primary" data-nav="orders">前往订单与交付</button></div></section>';
    H.mounts[page]=()=>{if(H.state.orders.length)mount?.();};
  }
  H.workspaceTools={baseURL,visibleState,applyState};
})(window.HH);
