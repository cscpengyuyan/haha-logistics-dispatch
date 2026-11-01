"""Executed-prefix recovery. Actual custody stays in transit until an evidenced handover.

No order is returned to ready and no original delivery or gate history is replaced.
The caller owns its write transaction; each command additionally uses a savepoint.
"""
import hashlib,json,re,secrets,uuid
from datetime import datetime,timezone
import core,gate,routing,operations,lifecycle
E=core.ApiError

def schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS recovery_cases(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS recovery_log(seq INTEGER PRIMARY KEY,case_id TEXT,action TEXT,actor TEXT,ts TEXT,data TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS recovery_commands(actor TEXT,key TEXT,signature TEXT,result TEXT,PRIMARY KEY(actor,key))')
    db.execute("CREATE TABLE IF NOT EXISTS recovery_vehicle_holds(vehicle_id TEXT,case_id TEXT,repair_ref TEXT NOT NULL DEFAULT '',PRIMARY KEY(vehicle_id,case_id))")

def vehicle_hold(db,vehicle_id):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='recovery_vehicle_holds'").fetchone():return False
    return bool(db.execute("SELECT 1 FROM recovery_vehicle_holds WHERE vehicle_id=? AND repair_ref=''",(vehicle_id,)).fetchone())

def digest(value):return hashlib.sha256(core.encode(value).encode()).hexdigest()
def get(db,rid):
    row=db.execute('SELECT * FROM recovery_cases WHERE id=?',(rid,)).fetchone()
    if not row:raise E(404,'救援任务不存在')
    return gate.obj(row)
def log(db,c,action,u,data):db.execute('INSERT INTO recovery_log(case_id,action,actor,ts,data) VALUES(?,?,?,?,?)',(c['id'],action,u['username'],core.now(),core.encode(data)))
def save(db,c,state,action,u):
    data={k:v for k,v in c.items() if k not in ('id','version','state')}
    changed=db.execute('UPDATE recovery_cases SET state=?,version=version+1,data=? WHERE id=? AND version=?',(state,core.encode(data),c['id'],c['version']))
    if changed.rowcount!=1:raise E(409,'救援版本已变')
    log(db,c,action,u,dict(state=state,version=c['version']+1,data=data))
    return get(db,c['id'])
def timestamp(value):
    try:
        d=datetime.fromisoformat(value.replace('Z','+00:00'))
        if d.tzinfo is None:raise ValueError()
        return d.astimezone(timezone.utc)
    except (ValueError,TypeError,AttributeError):raise E(400,'故障及交接时刻须含真实时区偏移')
def asset_rows(db,oid):return [dict(x) for x in db.execute('SELECT * FROM assets WHERE order_id=? ORDER BY sn',(oid,))]
def prefix_snapshot(o):
    return {k:o.get(k) for k in ('id','sn','issue_version','release_route','driver','signer','delivered_at','delivery_note','endpoint_receipt')}
def assert_frozen(db,c,u):
    for saved in c['frozen_prefix']:
        o=core.get_order(db,saved['id'],u)
        if o['status'] not in ('delivered','settled') or prefix_snapshot(o)!=saved:raise E(409,'已执行前缀发生变化，禁止重排历史')
        if any(a['state']!='delivered' for a in asset_rows(db,o['id'])):raise E(409,'已执行前缀实物状态已变')
def remaining(db,c,u,versions=None):
    actual_origin=routing.origin_resource(db,c['origin']['name'])
    if actual_origin!={k:v for k,v in c['origin'].items() if k!='type'}:raise E(409,'真实故障交接点的坐标、凭据或版本已变，禁止沿用旧现场')
    assert_frozen(db,c,u);orders=[core.get_order(db,i,u) for i in c['remaining_ids']]
    if versions is not None and versions!={o['id']:o['version'] for o in orders}:raise E(409,'剩余订单版本已变，请重新核验')
    for o in orders:
        if o.get('recovery_id')!=c['id'] or o['status']!='exception' or o.get('previous_status') not in ('in_transit','last_mile'):raise E(409,'剩余任务不再由本次故障保管')
        actual=asset_rows(db,o['id'])
        if actual!=c['onboard_assets'][o['id']]:raise E(409,'现场车载 SN、保管或库存版本已变')
    return orders

def commission(db,o):
    if o.get('gate_leg',1)==2:
        import folder
        folder.assert_second_leg(db,o,dict(carrier=o.get('carrier')))
    else:core.assert_commission(db,o)

def validate_road_input(db,b,u):
    """Authorize actual in-transit inputs for the existing real-road service."""
    gate.role(u,'dispatch');schema(db);c=get(db,b.get('recovery_id'))
    if c['version']!=b.get('recovery_version') or c['state'] not in ('reported','draft','accepted','cancelled'):raise E(409,'救援现场版本已变或已经签发')
    if not isinstance(b.get('order_versions'),dict):raise E(400,'须提供剩余订单版本')
    remaining(db,c,u,b['order_versions'])
    ids=b.get('order_ids',[])
    if len(ids)!=len(set(ids)) or set(ids)!=set(c['remaining_ids']) or b.get('warehouse')!=c['origin']['name']:raise E(409,'道路重算须从本次真实故障点覆盖全部剩余任务')
    if b.get('resource_id')==c['source_route']['resource_id'] or b.get('executor_id')!=c['source_route']['executor_id']:raise E(409,'须使用同合同已核救援车辆')
    return set(ids)

def report(db,b,u):
    gate.role(u,'dispatch')
    route=routing.resource(db,'route',core.required(b,'route_id'))
    if not route or route['version']!=b.get('route_version'):raise E(409,'故障车次版本已变')
    if route.get('collections'):raise E(409,'含回收车载设备的救援尚须专项点交，不能按纯送货救援')
    orders=[core.get_order(db,i,u) for i in route['order_ids']]
    if b.get('order_versions')!={o['id']:o['version'] for o in orders}:raise E(409,'故障上报订单版本已变')
    if any((o.get('release_route') or {}).get('id')!=route['id'] or (o.get('release_route') or {}).get('route_version')!=route['version'] for o in orders):raise E(409,'原车次尚未逐票签发或已有改派')
    done=[];pending=[]
    for o in orders:
        if o['status'] in ('delivered','settled') and not pending:done.append(o)
        elif o['status'] in ('in_transit','last_mile') and not o.get('recovery_id'):pending.append(o)
        else:raise E(409,'只能冻结连续已完成前缀，剩余必须为真实在途任务')
    if not pending:raise E(409,'车次没有剩余任务')
    if any(o['route'] in ('A','C1','C2') and o['status']!='last_mile' for o in pending):raise E(409,'本接口只接终端送货运段，站仓首程救援需另行交接')
    at=timestamp(b.get('reported_at'))
    start=timestamp(orders[0]['release_route']['start_utc'])
    if at<start:raise E(409,'故障时刻早于本车次出发')
    for o in done:
        finish=routing.local_utc(o.get('delivered_at'),o['timezone'])
        if not finish or at<finish or any(a['state']!='delivered' for a in asset_rows(db,o['id'])):raise E(409,'已完成站点凭证或故障时间冲突')
    location=b.get('location')
    if not isinstance(location,dict) or not routing.point(location) or location.get('timezone') not in core.ZONES:raise E(400,'请登记实际故障位置、地址及作业时区')
    location={k:location[k] for k in ('lat','lng','timezone')};location['address']=core.required(b['location'],'address',300)
    evidence=core.required(b,'evidence',500);custody=core.required(b,'custody_ref',500);reason=core.required(b,'reason',500)
    onboard={o['id']:asset_rows(db,o['id']) for o in pending}
    sns=sorted(a['sn'] for rows in onboard.values() for a in rows)
    if not sns or b.get('onboard_sns')!=sns or any(a['state']!='transit' for rows in onboard.values() for a in rows):raise E(409,'须逐台点清真实在途 SN，不得从坐标推测货权')
    for o in pending:
        if sorted(a['sn'] for a in onboard[o['id']])!=gate.serials(o):raise E(409,'部分签收或欠交需先独立核对剩余 SN')
        gate.require_released(db,o)
    rid='REC-'+uuid.uuid4().hex[:12].upper()
    origin=operations.save(db,'recovery_origin',dict(location,name='故障现场 '+rid,evidence=evidence,custody_ref=custody,case_id=rid),{},u)
    routing.bookings(db)
    bookings=[dict(r) for r in db.execute('SELECT * FROM route_bookings WHERE route_id=? AND revision=?',(route['id'],route['version']))]
    c=dict(id=rid,version=1,state='reported',reported_at=at.isoformat(),reason=reason,evidence=evidence,custody_ref=custody,origin=origin,
        source_route=route,source_bookings=bookings,frozen_prefix=[prefix_snapshot(o) for o in done],remaining_ids=[o['id'] for o in pending],onboard_assets=onboard,
        old_releases={o['id']:{k:o.get(k) for k in ('release_route','issue_version','pickup_code','gate_grant_id','driver','custodian')} for o in pending})
    db.execute('INSERT INTO recovery_cases VALUES(?,1,?,?)',(rid,'reported',core.encode({k:v for k,v in c.items() if k not in ('id','version','state')})))
    db.execute('INSERT INTO recovery_vehicle_holds(vehicle_id,case_id) VALUES(?,?)',(route['resource_id'],rid))
    for o in pending:
        o.update(recovery_id=rid,previous_status=o['status'],status='exception',reason=reason,next_step='按故障现场重新签发并逐台交接')
        o.pop('issue_version',None);o.pop('pickup_code',None)
        core.save(db,o,u,'recovery_report',rid+' '+custody)
    # The old run ended at the recorded fault; retain original booked intervals in the immutable report.
    db.execute("UPDATE route_bookings SET end_utc=? WHERE route_id=? AND revision=? AND cancelled=''",(at.isoformat(),route['id'],route['version']))
    log(db,c,'report',u,c)
    return get(db,rid)

def draft(db,c,b,u):
    gate.role(u,'dispatch')
    if c['state'] not in ('reported','draft','accepted','cancelled'):raise E(409,'须先撤销尚未交接的签发版')
    if not isinstance(b.get('order_versions'),dict):raise E(400,'请提供全部剩余订单版本')
    orders=remaining(db,c,u,b['order_versions'])
    ids=b.get('order_ids')
    if not isinstance(ids,list) or len(ids)!=len(set(ids)) or set(ids)!=set(c['remaining_ids']):raise E(409,'重排仅可完整包含未完成任务，不得加入已执行站点')
    body=b.get('route')
    if not isinstance(body,dict) or body.get('collections'):raise E(400,'须提供纯送货救援路线核验字段')
    if body.get('executor_id')!=c['source_route']['executor_id']:raise E(409,'本版仅允许原书面执行方安排救援；更换承运商须另行采购授权')
    if body.get('resource_id')==c['source_route']['resource_id']:raise E(409,'故障车辆不能继续签发，请登记合格救援车辆')
    checks,stops=routing.facts(body,ids)
    data={k:core.required(body,k,140) for k in ('name','date','start_time','timezone','resource_id','crew_id','executor_id')}
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',data['date']) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',data['start_time']):raise E(400,'救援发车日期时刻无效')
    data.update(warehouse=c['origin']['name'],warehouse_id=c['origin']['id'],order_ids=ids,order_versions={o['id']:o['version'] for o in orders},road_basis=body.get('road_basis'),checks=checks,stops=stops,service_minutes=45,return_policy=body.get('return_policy','open'),first_leg=False,first_leg_ids=[],collections={},recovery_id=c['id'])
    at=routing.local_utc(data['date']+'T'+data['start_time'],data['timezone'])
    if not at or at<timestamp(c['reported_at']):raise E(409,'救援路线必须从故障发生后的真实位置继续')
    if data['road_basis']=='valhalla_truck':routing.attach_road(db,data,body.get('road_id'))
    ordered=[next(o for o in orders if o['id']==oid) for oid in ids]
    result=routing.check_route(db,data,ordered,ids)
    import planning
    load_errors,load=planning.strict_load(db,data,ordered)
    result['issues'].extend(x['message'] for x in load_errors);data['load_profile']=load
    if result['issues']:raise E(409,'救援路线不可签发：'+'；'.join(result['issues']))
    data['check_result']=result
    route=operations.save(db,'route',data,{},u)
    c.update(route_id=route['id'],route_version=route['version'],order_versions=data['order_versions']);c.pop('acceptance',None)
    return save(db,c,'draft','draft',u)

def accept(db,c,b,u):
    gate.role(u,'procurement')
    if c['state']!='draft':raise E(409,'请先核验救援草案')
    orders=remaining(db,c,u,c['order_versions']);r=routing.resource(db,'route',c['route_id'])
    if b.get('included_in_original_contract') is not True:raise E(409,'新增费用或换承运方须先办理正式采购；本接口只接受原合同内救援')
    refs={k:core.required(b,k,500) for k in ('acceptance_ref','approval_ref','handover_ref')}
    links=b.get('links',{});validated={}
    for o in orders:
        leg=o.get('gate_leg',1);l=gate.obj(db.execute('SELECT * FROM gate_links WHERE id=?',(links.get(o['id']),)).fetchone())
        if not l or any(l[k]!=r[rk] for k,rk in (('executor_id','executor_id'),('crew_id','crew_id'),('vehicle_id','resource_id'))) or l['driver']!=r['checks']['driver']:raise E(409,'救援书面承接的人车与新路线不符')
        q=gate.source(o,leg)
        if (q.get('executor_id') or q.get('supplier_id'))!=l['executor_id']:raise E(409,'救援执行方不在当前已批准合同中')
        g=dict(leg=leg,link_id=l['id'],link_version=l['version'],scope_key=gate.signature(o,leg))
        gate.validate(db,o,g);commission(db,o)
        validated[o['id']]=dict(g,**{k:l[k] for k in ('executor_id','crew_id','vehicle_id','driver','plate')},sns=gate.serials(o),supplier_id=q.get('supplier_id') or q.get('executor_id'),payee_id=q.get('payee_id') or q.get('supplier_id') or q.get('executor_id'))
    c['acceptance']=dict(refs,links=validated,accepted_by=u['username'],included_in_original_contract=True)
    return save(db,c,'accepted','accept',u)

def issue(db,c,b,u):
    gate.role(u,'dispatch')
    if c['state']!='accepted':raise E(409,'救援草案尚未经采购书面承接')
    orders=remaining(db,c,u,c['order_versions']);r=routing.resource(db,'route',c['route_id'])
    if r.get('version')!=c['route_version']:raise E(409,'救援路线版本已变')
    if r['road_basis']=='valhalla_truck':
        routing.attach_road(db,r,r.get('road',{}).get('id'))
        import road_service
        road_service.check_live()
    ordered=[next(o for o in orders if o['id']==oid) for oid in r['order_ids']]
    result=routing.check_route(db,r,ordered,r['order_ids'])
    import planning
    load_errors,_=planning.strict_load(db,r,ordered)
    result['issues'].extend(x['message'] for x in load_errors)
    if result['issues'] or result['resource_versions']!=r['check_result']['resource_versions']:raise E(409,'救援运力、窗口或占用已变：'+'；'.join(result['issues']))
    evidence=core.required(b,'evidence',500)
    for o in ordered:
        g=c['acceptance']['links'][o['id']];gate.validate(db,o,g);commission(db,o)
        old=gate.active(db,o['id'],g['leg'])
        if not old or old['state']!='released':raise E(409,'原实际交接凭证已变')
        gid='LEG-'+uuid.uuid4().hex[:12];code='P-'+secrets.token_hex(5).upper();v=o['version']+1
        d=dict(g,recovery_id=c['id'],source_grant=old['id'],issue_version=v,pickup_code=code,acceptance_ref=c['acceptance']['acceptance_ref'],handover_ref=c['acceptance']['handover_ref'],origin=c['origin'],order_id=o['id'])
        d.pop('leg',None)
        db.execute("INSERT INTO gate_grants VALUES(?,?,?,'issued',1,?)",(gid,o['id'],g['leg'],core.encode(d)))
        gate.log(db,o['id'],g['leg'],'recovery_issue',u,dict(grant=gid,source_grant=old['id'],recovery_id=c['id'],evidence=evidence))
        o.update(driver=g['driver'],pickup_code=code,issue_version=v,gate_grant_id=gid,gate_leg=g['leg'])
        o['release_route']={k:r[k] for k in ('id','name','date','warehouse','resource_id','crew_id','executor_id','start_time','timezone')}
        o['release_route'].update(route_version=r['version'],leg_id=g['leg'],stop=r['order_ids'].index(o['id'])+1,stops=len(orders),driver=g['driver'],issued_at=core.now(),start_utc=result['start_utc'],end_utc=result['end_utc'],resource_versions=result['resource_versions'],recovery_id=c['id'])
        routing.bookings(db)
        db.execute('INSERT INTO route_bookings(oid,leg,route_id,revision,vehicle,crew,driver,start_utc,end_utc) VALUES(?,?,?,?,?,?,?,?,?)',(o['id'],g['leg'],r['id'],r['version'],r['resource_id'],r['crew_id'],g['driver'],result['start_utc'],result['end_utc']))
        core.save(db,o,u,'recovery_issue',evidence)
    c['issued_orders']={o['id']:core.get_order(db,o['id'],u)['version'] for o in orders}
    return save(db,c,'issued','issue',u)

def handover(db,c,b,u):
    gate.role(u,'warehouse')
    if c['state']!='issued':raise E(409,'救援尚未正式签发')
    orders=remaining(db,c,u,c['issued_orders']);r=routing.resource(db,'route',c['route_id'])
    if r.get('version')!=c['route_version']:raise E(409,'救援路线版本已变')
    at=timestamp(b.get('handed_at'))
    if at<timestamp(c['reported_at']) or at>timestamp(r['check_result']['start_utc']):raise E(409,'实到交接须在故障后、核定续行出发前完成；超时请撤销重排')
    if b.get('location_id')!=c['origin']['id']:raise E(409,'必须在本次已核故障交接点办理')
    refs={k:core.required(b,k,500) for k in ('evidence','old_custodian_ref','receiving_driver_ref','safety_ref')}
    tickets=b.get('tickets',{})
    for o in orders:
        g=gate.active(db,o['id'],o['gate_leg']);t=tickets.get(o['id'],{})
        if not g or g['state']!='issued' or g.get('recovery_id')!=c['id'] or t.get('release_version')!=g['issue_version'] or not secrets.compare_digest(str(t.get('pickup_code','')),g['pickup_code']):raise E(409,'救援提货号或签发版本不符，旧版不得验放')
        gate.validate(db,o,g);commission(db,o);routing.validate_departure(db,o)
        if any(b.get(k)!=g[k] for k in ('driver','plate','crew_id','vehicle_id')) or sorted(t.get('sns',[]))!=g['sns']:raise E(409,'救援实到人车或逐台 SN 不符')
    for o in orders:
        g=gate.active(db,o['id'],o['gate_leg'])
        gate.update(db,g,'released',handed_at=at.isoformat(),handed_by=u['username'],release_ref=refs['evidence'],recovery_handover=refs)
        gate.log(db,o['id'],o['gate_leg'],'recovery_handover',u,dict(refs,grant=g['id'],sns=g['sns'],location_id=c['origin']['id']))
        o.update(status=o.pop('previous_status'),custodian=g['driver'],recovery_completed_id=c['id'])
        o.pop('recovery_id',None)
        lifecycle.move(db,o,'transit',u,refs['evidence'])
        core.save(db,o,u,'recovery_handover',refs['evidence'])
    c['handover']=dict(refs,at=at.isoformat(),location_id=c['origin']['id'])
    return save(db,c,'handed_over','handover',u)

def cancel(db,c,b,u):
    gate.role(u,'dispatch')
    if c['state']=='cancelled':return c
    if c['state'] not in ('draft','accepted','issued'):raise E(409,'已交接或尚无救援草案，不可撤销')
    evidence=core.required(b,'evidence',500)
    orders=remaining(db,c,u)
    for o in orders:
        if c['state']=='issued':
            g=gate.active(db,o['id'],o['gate_leg'])
            if not g or g['state']!='issued' or g.get('recovery_id')!=c['id']:raise E(409,'授权已执行，不能撤销')
            gate.update(db,g,'revoked',reason=evidence);gate.log(db,o['id'],g['leg'],'recovery_cancel',u,dict(grant=g['id'],evidence=evidence))
            routing.cancel_booking(db,o['id'])
            o.pop('issue_version',None);o.pop('pickup_code',None)
            core.save(db,o,u,'recovery_cancel',evidence)
    return save(db,c,'cancelled','cancel',u)

def repair(db,c,b,u):
    if u['role']!='admin':raise E(403,'故障车辆复运须主管核实检修凭据')
    if c['state']!='handed_over':raise E(409,'须先完成在途货物救援交接，不能直接恢复旧车次')
    facts={k:core.required(b,k,500) for k in ('repair_ref','inspection_ref','approval_ref')}
    if c.get('vehicle_repair'):raise E(409,'此故障已经办理车辆复运')
    db.execute('UPDATE recovery_vehicle_holds SET repair_ref=? WHERE vehicle_id=? AND case_id=?',(facts['repair_ref'],c['source_route']['resource_id'],c['id']))
    c['vehicle_repair']=dict(facts,approved_by=u['username'],approved_at=core.now())
    return save(db,c,c['state'],'vehicle_repair',u)

def handle(db,method,path,b,u):
    gate.role(u,'dispatch','procurement','warehouse','finance');schema(db)
    base='/api/ops/recovery'
    if method=='GET':
        if path==base:return {'cases':[gate.obj(r) for r in db.execute('SELECT * FROM recovery_cases ORDER BY rowid DESC')]}
        rid=path.removeprefix(base+'/');c=get(db,rid)
        return dict(case=c,history=[dict(x) for x in db.execute('SELECT * FROM recovery_log WHERE case_id=? ORDER BY seq',(rid,))])
    if method!='POST':raise E(405,'需要 POST')
    key=core.required(b,'idempotency_key',100);sig=digest([path,b]);prior=db.execute('SELECT * FROM recovery_commands WHERE actor=? AND key=?',(u['username'],key)).fetchone()
    if prior:
        if prior['signature']!=sig:raise E(409,'相同幂等键不能提交不同救援请求')
        return json.loads(prior['result'])
    db.execute('SAVEPOINT recovery_command')
    try:
        if path==base+'/report':result=report(db,b,u)
        else:
            m=re.fullmatch(re.escape(base)+r'/([A-Z0-9-]+)/(draft|accept|issue|handover|cancel|repair)',path)
            if not m:raise E(404,'救援接口不存在')
            c=get(db,m[1])
            if c['version']!=b.get('version'):raise E(409,'救援版本已变，请刷新')
            result=globals()[m[2]](db,c,b,u)
        out={'case':result}
        db.execute('INSERT INTO recovery_commands VALUES(?,?,?,?)',(u['username'],key,sig,core.encode(out)))
        db.execute('RELEASE recovery_command');return out
    except Exception:
        db.execute('ROLLBACK TO recovery_command');db.execute('RELEASE recovery_command');raise
