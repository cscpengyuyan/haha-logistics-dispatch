/* Time-zone conversions use the browser's IANA database. No fixed UTC offsets. */
(function(){
 'use strict';
 const H=window.HH=window.HH||{};
 const zones=['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','America/Indiana/Indianapolis','America/Anchorage','Pacific/Honolulu'];
 const zoneLabels={'America/New_York':'Eastern · New York','America/Chicago':'Central · Chicago','America/Denver':'Mountain · Denver','America/Los_Angeles':'Pacific · Los Angeles','America/Phoenix':'Arizona · Phoenix','America/Indiana/Indianapolis':'Eastern · Indiana (South Bend)','America/Anchorage':'Alaska · Anchorage','Pacific/Honolulu':'Hawaii · Honolulu'};
 const cache=new Map();
 function formatter(zone){if(typeof zone!=='string'||!zone.trim())throw new Error('An explicit IANA time zone is required; the browser location is not a business time zone.');if(!cache.has(zone))cache.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));return cache.get(zone);}
 function parts(ms,zone){const out={};for(const p of formatter(zone).formatToParts(new Date(ms)))if(p.type!=='literal')out[p.type]=Number(p.value);return out;}
 function asUTC(p){return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second||0);}
 function parseWall(date,hhmm){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!/^\d{2}:\d{2}$/.test(String(hhmm)))throw new Error('Use YYYY-MM-DD and HH:mm.');
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=hhmm.split(':').map(Number);
  if(year<1900||year>2200||month<1||month>12||day<1||day>31||hour>23||minute>59)throw new Error('Invalid local date or time.');
  const ms=Date.UTC(year,month-1,day,hour,minute);const d=new Date(ms);
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)throw new Error('Invalid calendar date.');
  return {year,month,day,hour,minute,second:0,ms};
 }
 function wallToUTC(date,hhmm,zone,disambiguation='reject'){
  if(!['reject','earlier','later'].includes(disambiguation))throw new Error('Disambiguation must be reject, earlier or later.');
  const target=parseWall(date,hhmm);formatter(zone);
  // Capture the offsets on both sides of a transition; validate each candidate
  // against Intl instead of assuming a 1-hour DST change or a US-only offset.
  const offsets=new Set();for(let h=-48;h<=48;h+=6){const probe=target.ms+h*3600000;offsets.add(asUTC(parts(probe,zone))-probe);}
  const candidates=[...offsets].map(o=>target.ms-o).filter(ms=>{const p=parts(ms,zone);return p.year===target.year&&p.month===target.month&&p.day===target.day&&p.hour===target.hour&&p.minute===target.minute&&p.second===0;}).sort((a,b)=>a-b);
  if(!candidates.length)throw new Error('This local time does not exist because of a daylight-saving clock change. Choose another time.');
  if(candidates.length>1&&disambiguation==='reject')throw new Error('This local time occurs twice because of a daylight-saving clock change. Select earlier or later.');
  return new Date(disambiguation==='later'?candidates[candidates.length-1]:candidates[0]).toISOString();
 }
 function instant(iso){if(typeof iso!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso))throw new Error('An explicit UTC or offset timestamp is required.');const ms=Date.parse(iso);if(!Number.isFinite(ms))throw new Error('Invalid timestamp.');return ms;}
 function format(iso,zone,locale='zh-CN'){formatter(zone);return new Intl.DateTimeFormat(locale,{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short',hourCycle:'h23'}).format(new Date(instant(iso)));}
 function minutesToTime(value){if(!Number.isInteger(value)||value<0||value>=1440)throw new Error('Window minutes must be between 0 and 1439.');return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');}
 function nextDate(date){const p=parseWall(date,'12:00');return new Date(p.ms+86400000).toISOString().slice(0,10);}
 function windowFor(order){
  const startTime=typeof order.windowStart==='number'?minutesToTime(order.windowStart):order.windowStart;
  const endTime=typeof order.windowEnd==='number'?minutesToTime(order.windowEnd):order.windowEnd;
  parseWall(order.date,startTime);parseWall(order.date,endTime);
  if(startTime===endTime&&!order.windowEndDate)throw new Error('The receiving window must have a positive duration.');
  const endDate=order.windowEndDate||(endTime<startTime?nextDate(order.date):order.date);
  const policy=order.timeDisambiguation||'reject';
  const start=wallToUTC(order.date,startTime,order.timeZone,order.startDisambiguation||policy);
  const end=wallToUTC(endDate,endTime,order.timeZone,order.endDisambiguation||policy);
  if(Date.parse(end)<=Date.parse(start))throw new Error('The window end must be after its start.');
  return {start,end,local:format(start,order.timeZone)+' — '+format(end,order.timeZone),beijing:format(start,'Asia/Shanghai')+' — '+format(end,'Asia/Shanghai'),timeZone:order.timeZone,durationMinutes:(Date.parse(end)-Date.parse(start))/60000};
 }
 function isQuiet(iso,zone,startHour=20,endHour=8){
  if(!Number.isFinite(startHour)||!Number.isFinite(endHour)||startHour<0||startHour>23||endHour<0||endHour>23)throw new Error('Quiet hours must be between 0 and 23.');
  const p=parts(instant(iso),zone),h=p.hour+p.minute/60;
  if(startHour===endHour)return false;
  return startHour<endHour?h>=startHour&&h<endHour:h>=startHour||h<endHour;
 }
 function dateAt(iso,zone){const p=parts(instant(iso),zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
 function context(iso,zone){return {local:format(iso,zone),zone,beijing:format(iso,'Asia/Shanghai'),utc:new Date(instant(iso)).toISOString(),view:format(iso,H.state?.settings?.viewZone==='local'||!H.state?.settings?.viewZone?zone:H.state.settings.viewZone)};}
 function contextHTML(iso,zone,label='业务当地'){try{const x=context(iso,zone),e=H.e||String;return `<div class="time-context"><div class="time-context-pair"><b>${e(label)}</b><span>${e(x.local)} · ${e(zone)}</span></div><small>北京 ${e(x.beijing)}</small><span class="time-utc">UTC ${e(x.utc)}</span></div>`;}catch(error){return `<span class="pill amber">时间待核：${(H.e||String)(error.message)}</span>`;}}
 function foldField(name='fold',value='reject',english=false){return `<label class="field">${english?'Repeated DST hour':'夏令时重复小时'}<select name="${name}"><option value="reject" ${value==='reject'?'selected':''}>${english?'Review ambiguity (default)':'遇歧义先复核（默认）'}</option><option value="earlier" ${value==='earlier'?'selected':''}>${english?'Earlier occurrence':'较早一轮'}</option><option value="later" ${value==='later'?'selected':''}>${english?'Later occurrence':'较晚一轮'}</option></select></label>`;}
 function bindPreview(root,{date='date',time='time',zone,zoneField,fold='fold',target='#time-preview'}={}){if(!root)return;const draw=()=>{const out=root.querySelector(target);if(!out)return;try{const z=zoneField?root.querySelector(`[name="${zoneField}"]`)?.value:zone;const iso=wallToUTC(root.querySelector(`[name="${date}"]`).value,root.querySelector(`[name="${time}"]`).value,z,root.querySelector(`[name="${fold}"]`)?.value||'reject');out.className='time-preview';out.innerHTML=contextHTML(iso,z);}catch(error){out.className='time-preview invalid';out.textContent=error.message;}};root.querySelectorAll('input,select').forEach(el=>el.addEventListener('change',draw));draw();}
 H.tz={zones,zoneLabels,wallToUTC,format,window:windowFor,isQuiet,parts:(iso,zone)=>parts(instant(iso),zone),dateAt,context,contextHTML,foldField,bindPreview};
})();
