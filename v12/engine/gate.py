"""Per-leg mandates and warehouse handover. The caller owns the SQLite write transaction."""
import hashlib,json,re,secrets,uuid
from datetime import date,datetime,timezone
import core
E=core.ApiError
def schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS gate_links (id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS gate_grants (id TEXT PRIMARY KEY,oid TEXT NOT NULL,leg INTEGER NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL)")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS gate_one_active ON gate_grants(oid,leg) WHERE state NOT IN ('revoked','released','refused')")
    db.execute("CREATE TABLE IF NOT EXISTS gate_log (seq INTEGER PRIMARY KEY,oid TEXT NOT NULL,leg INTEGER,action TEXT NOT NULL,actor TEXT NOT NULL,ts TEXT NOT NULL,data TEXT NOT NULL)")
def obj(row):
    if not row:return None
    return {**json.loads(row['data']),**{k:row[k] for k in row.keys() if k!='data'}}
def active(db,oid,leg):
    schema(db)
    return obj(db.execute("SELECT * FROM gate_grants WHERE oid=? AND leg=? AND state NOT IN ('revoked','refused') ORDER BY rowid DESC LIMIT 1",(oid,leg)).fetchone())
def log(db,oid,leg,a,user,d):
    db.execute("INSERT INTO gate_log(oid,leg,action,actor,ts,data) VALUES(?,?,?,?,?,?)",(oid,leg,a,user['username'],core.now(),core.encode(d)))
def role(user,*roles):
    if user['role'] not in (*roles,'admin'):raise E(403,"此岗位不能办理此操作")
def reg(db,kind,rid):
    row=db.execute("SELECT * FROM registry WHERE id=? AND type=?",(rid,kind)).fetchone()
    if not row:raise E(409,"没有已登记的"+kind+"，请先补档")
    return obj(row)
def driver_ok(db,username):
    if not db.execute("SELECT 1 FROM users WHERE username=? AND role='driver' AND active=1",(username,)).fetchone():raise E(409,"司机账号停用或不存在")
def network(db,b,u):
    role(u,'procurement','dispatch');d={k:core.required(b,k,200) for k in ('executor_id','crew_id','vehicle_id','driver','plate','warehouse_id','zip','model','level','product','valid_until','insurance_until','evidence')}
    for k,kind in [('crew_id','crew'),('vehicle_id','vehicle'),('warehouse_id','warehouse')]:reg(db,kind,d[k])
    for k in ('hire_ref','mandate_ref','starts_on'):
        if b.get(k):d[k]=core.required(b,k,200)
    if d.get('starts_on'):
        try: date.fromisoformat(d['starts_on'])
        except ValueError:raise E(400,'开始日期无效')
        if d['starts_on']>d['valid_until']:raise E(400,'关系到期早于开始')
    driver_ok(db,d['driver'])
    if not re.fullmatch(r'\d{5}',d['zip']):raise E(400,'须填五位 ZIP')
    for k in ('valid_until','insurance_until'):
        try:date.fromisoformat(d[k])
        except ValueError:raise E(400,"无效的到期日期")
    rid=b.get('id') or 'NET-'+uuid.uuid4().hex[:12];v=1
    if b.get('id'):
        old=obj(db.execute("SELECT * FROM gate_links WHERE id=?",(rid,)).fetchone());v=(old or {}).get('version',0)+1
        if not old or b.get('version')!=old['version']:raise E(409,'关系版本已变')
    db.execute("INSERT INTO gate_links VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data",(rid,v,core.encode(d)))
    log(db,'network',0,'register',u,dict(id=rid,version=v,**d));return dict(id=rid,version=v,**d)
def source(o,leg):
    if leg==2:return o.get('second_leg') or o.get('second_leg_commission') or {}
    if o.get('procurement_mode')=='brand_fleet':return o.get('platform_instruction') or {}
    return o.get('selected_quote') or {}
def applicable(o,leg):return leg==(2 if o['status']=='at_station' or o.get('station_pending') else 1)
def signature(o,leg):
    q=source(o,leg)
    return hashlib.sha256(core.encode([leg,q,[(k,o.get(k)) for k in ('sn','warehouse','station_name','model','quantity','zip','endpoint','level','addon_l4','addon_l5','site_note','delivery_actions','address','window_start','window_end','timezone','pack_version')]]).encode()).hexdigest()
def validate(db,o,g):
    leg=g['leg'];l=obj(db.execute("SELECT * FROM gate_links WHERE id=?",(g['link_id'],)).fetchone())
    if not l or l['version']!=g['link_version'] or signature(o,leg)!=g['scope_key']:raise E(409,"委托、范围或人车关系已变；请重新授权并重签")
    wh=reg(db,'warehouse',l['warehouse_id'])
    if wh['name']!=(o.get('station_name') if leg==2 else o['warehouse']):raise E(409,"车组不覆盖本次实际起仓")
    dest=o['zip']
    if leg==1 and o['route'] in ('C1','C2'):
        station=(o.get('station_mandate') or o.get('second_leg') or {}).get('station_id')
        dest=reg(db,'warehouse',station).get('zip') if station else None
        if not dest:raise E(409,'首程接收站或站点 ZIP 尚未核准')
    if l['zip']!=dest:raise E(409,f"车组 ZIP {l['zip']} 不覆盖本段 {dest}；分包授权不能扩大覆盖")
    # A crew with a structured list of five-digit ZIPs must also cover the site.
    crew=reg(db,'crew',l['crew_id']);zips=re.findall(r'(?<!\d)\d{5}(?!\d)',crew.get('coverage',''))
    if zips and dest not in zips:raise E(409,"班组核定区域不含本票 ZIP")
    q=source(o,leg)
    if (l['model'],l['level'],l['product'])!=(o['model'],o['level'],q.get('product','T2')):raise E(409,"机型、现场服务档或产品超出授权范围")
    if l.get('starts_on','')>o['window_start'][:10]:raise E(409,'该班组关系尚未生效')
    if min(l['valid_until'],l['insurance_until'])<max(core.now()[:10],o['window_end'][:10]):raise E(409,"资质/保险到期，请补证重签")
    driver_ok(db,l['driver'])
    if g.get('subcontract') and not (g.get('contract_ref') and g.get('delegation_ref')):raise E(409,"缺少本票分包授权或客户合同许可，禁止验放")
def update(db,g,state,**changes):
    row={**g,**changes}
    for k in ('id','oid','leg','state','version'):row.pop(k,None)
    cur=db.execute("UPDATE gate_grants SET state=?,version=version+1,data=? WHERE id=? AND version=?",(state,core.encode(row),g['id'],g['version']))
    if cur.rowcount!=1:raise E(409,"运段授权已更新")
def invite(db,o,b,u):
    role(u,'procurement','dispatch');leg=b.get('leg')
    if leg not in (1,2) or not applicable(o,leg) or o['status'] not in ('ready','at_station'):raise E(409,"此段尚未备妥或已执行")
    q=source(o,leg);sid=q.get('supplier_id')
    if not sid:raise E(409,"没有本段有效中选／内部委托")
    l=obj(db.execute("SELECT * FROM gate_links WHERE id=?",(core.required(b,'link_id'),)).fetchone())
    if not l:raise E(409,"请选择已登记的人车关系")
    sub=sid!=l['executor_id']
    d={k:l[k] for k in ('executor_id','crew_id','vehicle_id','driver','plate')}
    d.update(supplier_id=sid,payee_id=q.get('payee_id') or sid,order_id=o['id'],link_id=l['id'],link_version=l['version'],scope_key=signature(o,leg),subcontract=sub,contract_ref=core.required(b,'contract_ref') if sub else '',delegation_ref=core.required(b,'delegation_ref') if sub else '',invitation_ref=core.required(b,'evidence'),sns=serials(o),quote_id=q.get('id') or q.get('quote_ref'),quote_version=q.get('version',1))
    if q.get('executor_id') and q['executor_id'] not in (sid,l['executor_id']):raise E(409,"回报价的执行方与提名人车不符，请修订委托")
    old=active(db,o['id'],leg)
    if old and old['state'] not in ('released',):raise E(409,"原授权尚在，请先撤销未执行版")
    gid='LEG-'+uuid.uuid4().hex[:12];validate(db,o,{**d,'leg':leg})
    db.execute("INSERT INTO gate_grants VALUES(?,?,?,'invited',1,?)",(gid,o['id'],leg,core.encode(d)))
    log(db,o['id'],leg,'invite',u,dict(grant=gid,**d));return active(db,o['id'],leg)
def serials(o):return sorted(x.strip().upper() for x in re.split(r'[,，;；\n]+',o.get('sn','')) if x.strip())
def issue(db,o,b,u,leg):
    g=active(db,o['id'],leg)
    if not g or g['state']!='accepted':raise E(409,"仓口暂停：本段没有已接受的有效人车授权；请采购补录分包依据并由调度重签")
    validate(db,o,g)
    r=o.get('release_route') or {}
    if not (g['driver']==o.get('driver') and g['executor_id']==r.get('executor_id') and g['crew_id']==r.get('crew_id') and g['vehicle_id']==r.get('resource_id')):raise E(409,"F04 人车与本段书面接受不一致，禁止签发")
    code='P-'+secrets.token_hex(5).upper();v=o['version']+1
    update(db,g,'issued',issue_version=v,pickup_code=code);o.update(gate_leg=leg,pickup_code=code,gate_grant_id=g['id'])
    log(db,o['id'],leg,'issue',u,dict(grant=g['id'],issue_version=v,crew_id=g['crew_id'],driver=g['driver']))
def require_released(db,o):
    g=active(db,o['id'],o.get('gate_leg',1))
    if not g or g['state']!='released' or g.get('issue_version')!=o.get('issue_version'):raise E(409,"仓管尚未按本票当前签发版逐台验放，实物仍由仓库保管")
def verify(db,o,b,u):
    role(u,'warehouse');leg=2 if o.get('station_pending') or o['status']=='at_station' else 1
    g=active(db,o['id'],leg)
    if not g or g['state']!='issued':raise E(409,"暂停放行：没有本段已签发的人车授权。SN 留在当前库位，补录授权、承接并重签后再验")
    papers=g.get('mode') in ('platform','ltl')
    if papers:core.assert_commission(db,o)
    else:
        validate(db,o,g)
        import routing
        routing.validate_departure(db,o)
        mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
        if mode and mode[0]=='production':
            rr=o.get('release_route') or {}
            start,end=(datetime.fromisoformat(rr[k]) for k in ('start_utc','end_utc'))
            if not start<=datetime.now(timezone.utc)<=end:raise E(409,'当前时刻不在核定提货班次内，请调度核实并重签')
    if (o['status'] not in ('dispatched','at_station') or b.get('release_version')!=g['issue_version'] or o.get('issue_version')!=g['issue_version'] or not secrets.compare_digest(str(b.get('pickup_code','')),g['pickup_code'])):raise E(409,"提货号或签发版本已失效，请调取最新 F04")
    if papers:
        item=o['platform_instruction']
        if b.get('bol_ref')!=(item.get('bol_ref') or item.get('bol_pro')) or not b.get('bol_ref') or b.get('identity_ref')!=item.get('identity_ref') or not b.get('identity_ref'):raise E(409,"承运凭据或实到身份未核，暂停放行")
    for k in (() if papers else ('driver','plate','crew_id','vehicle_id')):
        if b.get(k)!=g[k]:raise E(409,"实到人车不符："+k+"；暂停放行，原仓保管")
    if sorted(b.get('sns') or [])!=g['sns']:raise E(409,"实到 SN 未逐台核齐，禁止出库")
    ref=core.required(b,'evidence');update(db,g,'released',release_ref=ref,handed_by=u['username'],handed_at=core.now())
    log(db,o['id'],leg,'handover',u,dict(grant=g['id'],driver=g.get('driver') or b.get('identity_ref'),plate=g.get('plate'),sns=g['sns'],evidence=ref))
    import lifecycle
    if leg==1:
        core.assert_commission(db,o)
    else:
        import folder
        folder.assert_second_leg(db,o,{'carrier':o['carrier']})
    o['custodian']=g.get('driver') or o['carrier'];o['status']='in_transit' if leg==1 else 'last_mile';o.pop('station_pending',None)
    lifecycle.move(db,o,'transit',u,ref)
    return core.save(db,o,u,'warehouse_release',ref)
def handle(db,method,path,b,u):
    schema(db)
    if path=='/api/gate/network':
        if method=='POST':return {'link':network(db,b,u)}
        role(u,'warehouse','procurement','finance','dispatch')
        return dict(links=[obj(x) for x in db.execute("SELECT * FROM gate_links")],grants=[{k:v for k,v in obj(x).items() if k in ('id','version','leg','state','order_id','supplier_id','payee_id','executor_id','crew_id','vehicle_id','driver','plate','issue_version','handed_by','handed_at','subcontract')} for x in db.execute("SELECT * FROM gate_grants ORDER BY rowid DESC")])
    role(u,'procurement','dispatch','warehouse','finance')
    if path=='/api/gate/lookup' and method=='POST':
        row=db.execute("SELECT oid FROM gate_grants WHERE state='issued' AND json_extract(data,'$.pickup_code')=?",(b.get('pickup_code'),)).fetchone()
        if not row:raise E(404,"无有效提货号，暂停放行")
        return {'order_id':row[0]}
    match=re.fullmatch(r'/api/gate/([a-zA-Z0-9_-]+)(?:/(invite|accept|revoke|refuse|verify))?',path)
    if not match:raise E(404,"验放接口不存在")
    oid,act=match.groups();o=core.get_order(db,oid,u);leg=2 if o['status']=='at_station' or o.get('station_pending') else o.get('gate_leg',1)
    if method=='GET' and not act:return dict(grant=active(db,oid,leg),leg=leg,history=[dict(x) for x in db.execute("SELECT leg,action,actor,ts,data FROM gate_log WHERE oid=? ORDER BY seq DESC",(oid,))])
    if method!='POST':raise E(405,"需要 POST")
    core.check_version(o,b)
    if act=='invite':return {'grant':invite(db,o,b,u)}
    if act=='verify':return {'order':verify(db,o,b,u)}
    g=active(db,oid,leg)
    if not g or b.get('grant_version')!=g['version']:raise E(409,"授权不存在或版本已变")
    role(u,'procurement','dispatch');ref=core.required(b,'evidence')
    if act=='accept' and g['state']=='invited':
        validate(db,o,g);update(db,g,'accepted',acceptance_ref=ref,accepted_by=u['username'])
    elif act in ('revoke','refuse') and g['state'] in ('invited','accepted','issued'):
        update(db,g,'revoked' if act=='revoke' else 'refused',reason=ref)
        if g['state']=='issued':
            o['status']='ready' if leg==1 else 'at_station'
            for k in ('driver','pickup_code','gate_grant_id','issue_version','release_route','station_pending'):o.pop(k,None)
            try:
                import routing
                routing.cancel_booking(db,oid)
            except AttributeError:pass
            core.save(db,o,u,'revoke_leg',ref)
    else:raise E(409,"此授权状态不能办理此操作")
    log(db,oid,leg,act,u,dict(grant=g['id'],evidence=ref));return {'grant':active(db,oid,leg)}

def issue_network(db,o,u):
    schema(db);item=o['platform_instruction'];leg=1
    gid='LEG-'+uuid.uuid4().hex[:12];v=o['version']+1
    pickup=core.required(item,'pickup_ref')
    old=active(db,o['id'],leg)
    if old and old['state']!='released':update(db,old,'revoked',reason='重新签发')
    d=dict(mode=o['procurement_mode'],order_id=o['id'],executor_id=item['executor_id'],supplier_id=item['executor_id'],payee_id=item.get('payee_id') or item['executor_id'],sns=serials(o),pickup_code=pickup,issue_version=v,scope_key=signature(o,1))
    db.execute("INSERT INTO gate_grants VALUES(?,?,1,'issued',1,?)",(gid,o['id'],core.encode(d)))
    o.update(gate_leg=1,pickup_code=pickup,gate_grant_id=gid);log(db,o['id'],1,'network_issue',u,dict(grant=gid,issue_version=v))
