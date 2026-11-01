"""Authorized same-site delivery/collection load profiles, with per-action peaks.

Collections reference an existing authorized machine RMA and its actual SN.
They may share an existing delivery stop only when the physical customer site is
identical. Additional pickup-only locations require their own routed stop and are
not silently inserted. Planning never moves an asset or completes an RMA.
"""
import copy
import json
import math
import sqlite3
from datetime import datetime, timezone
from core import ApiError, encode, get_order, now, required
import routing


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS collection_bookings(
        rma_id TEXT NOT NULL,route_id TEXT NOT NULL,revision INTEGER NOT NULL,
        stop_id TEXT NOT NULL,sn TEXT NOT NULL,case_version INTEGER NOT NULL,
        asset_version INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(rma_id,route_id,revision))''')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS collection_active_rma ON collection_bookings(rma_id) WHERE active=1')


def error(code,message,oid='',field='collections'):
    return dict(code=code,message=message,object_id=oid,field=field,next_step='核对授权 RMA、实物、包装、同址资料和逐站动作顺序后重算')


def parse(value, ids):
    if value in (None, {}):return {}
    if not isinstance(value,dict) or set(value)-set(ids):
        raise ApiError(422,'回收只能关联当前路线的已有配送站点')
    out={};seen=set()
    for oid,rows in value.items():
        if not isinstance(rows,list) or len(rows)>20:raise ApiError(422,'单站回收清单格式无效')
        out[oid]=[]
        for item in rows:
            if not isinstance(item,dict) or set(item)-{'rma_id','version','asset_version','before_delivery'}:
                raise ApiError(422,'回收仅接受已授权 RMA 引用，禁止自由 SN 或货量')
            rid=required(item,'rma_id',100)
            if rid in seen:raise ApiError(422,'同一 RMA 不能在一条路线重复回收')
            if type(item.get('version')) is not int or type(item.get('asset_version')) is not int or type(item.get('before_delivery')) is not bool:
                raise ApiError(422,'回收须明确 RMA/实物版本及先收或后收顺序')
            out[oid].append(dict(item));seen.add(rid)
    return out


def authorized(db, rid):
    row=db.execute("SELECT * FROM after_cases WHERE id=? AND kind='rma'",(rid,)).fetchone()
    if not row:raise ApiError(404,'回收 RMA 不存在')
    data=json.loads(row['data'])
    if row['state']!='authorized' or data.get('item_type')!='machine' or not all(data.get(k) for k in ('approval_ref','receiver_id','receiver_acceptance','protection_ref')):
        raise ApiError(409,'回收须为已批准、接收方已承接的整机 RMA')
    asset=db.execute('SELECT * FROM assets WHERE sn=? AND order_id=?',(row['sn'],row['order_id'])).fetchone()
    if not asset or asset['state']!='delivered':raise ApiError(409,'回收 SN 不在原客户保管状态，不能重复收取')
    return row,data,asset


def confirm(db,body,user):
    """Service staff confirm the pickup facts of an already authorized machine RMA."""
    if user['role'] not in {'admin','service'}:raise ApiError(403,'回收包装与交接事实须由售后确认')
    rid=required(body,'id',100);row,data,asset=authorized(db,rid)
    if body.get('version')!=row['version'] or body.get('asset_version')!=asset['version']:
        raise ApiError(409,'回收工单或实物版本已变化')
    import supply,lifecycle
    packing=supply.packing_specs({'packing':body.get('packing')})
    if not packing:raise ApiError(422,'回收必须实测当前保护包装，不能沿用未知尺寸')
    fields={k:required(body,k) for k in ('pickup_ref','package_ref','window_start','window_end','timezone','cost_approval_ref')}
    a,b=(routing.local_utc(fields[k],fields['timezone']) for k in ('window_start','window_end'))
    if not a or not b or a>=b:raise ApiError(422,'回收时间窗无效或有夏令时歧义')
    minutes=body.get('service_minutes');charge=body.get('amount_minor')
    if type(minutes) is not int or not 1<=minutes<=720 or type(charge) is not int or not 0<=charge<=100000000:
        raise ApiError(422,'回收作业时长和整数美分费用必须明确确认')
    lift=routing.bounded(body.get('lift_extra_kg'),0,100000)
    if lift is None:raise ApiError(422,'回收须确认同升降器具/人员重量，不参加时明确填 0')
    old=get_order(db,row['order_id'],{'role':'dispatch','username':user['username']})
    if not routing.point(old) or old.get('location_precision')!='dock' or not old.get('coordinate_ref'):
        raise ApiError(422,'原客户实际取机入口未核，不能以邮编点安排回收')
    fields.update(packing=packing,service_minutes=minutes,amount_minor=charge,currency='USD',lift_extra_kg=lift,
        asset_version=asset['version'],source_order_version=old['version'],confirmed_by=user['username'],confirmed_at=now())
    data['collection']=fields
    db.execute('UPDATE after_cases SET version=version+1,data=? WHERE id=? AND version=?',(encode(data),rid,row['version']))
    updated=db.execute('SELECT * FROM after_cases WHERE id=?',(rid,)).fetchone()
    lifecycle.log(db,'cases',rid,updated['version'],user,lifecycle.row_obj(updated))
    return {'rma_id':rid,'version':updated['version'],'asset_version':asset['version'],'sn':row['sn'],'collection':fields}


def collection(db,item,stop,route):
    if stop['id'] in route.get('first_leg_ids',[]) or route.get('first_leg') and stop.get('route') in {'C1','C2'}:
        raise ApiError(422,'首程实际目的地为接站仓，不能假定已经到客户取机')
    row,data,asset=authorized(db,item['rma_id']);facts=data.get('collection') or {}
    if item['version']!=row['version'] or item['asset_version']!=asset['version'] or facts.get('asset_version')!=asset['version']:
        raise ApiError(409,'回收授权或实物版本已变化')
    old=get_order(db,row['order_id'],{'role':'dispatch','username':'planning'})
    if facts.get('source_order_version')!=old['version']:raise ApiError(409,'原取机地点或售后信息已变化')
    if not routing.point(stop) or stop.get('location_precision')!='dock' or not stop.get('coordinate_ref'):
        raise ApiError(422,'合停配送点未核实际入口')
    keys=('customer','address','zip','lat','lng')
    if any(old.get(k)!=stop.get(k) or old.get(k) is None for k in keys):
        raise ApiError(422,'回收点与配送点不是同一已核客户入口，必须建立独立停靠任务')
    receiver=routing.resource(db,'warehouse',data['receiver_id'])
    end=route.get('end_location') or route.get('warehouse')
    if not receiver or receiver['name']!=end or not route.get('checks',{}).get('return_min') or float(route['checks']['return_min'])<=0:
        raise ApiError(422,'回收必须包含返回 RMA 指定接收仓的真实回程')
    if not facts.get('packing') or not facts.get('pickup_ref'):raise ApiError(422,'回收包装和交接事实未确认')
    return dict(facts,rma_id=row['id'],case_version=row['version'],asset_version=asset['version'],sn=row['sn'],
        source_order_id=row['order_id'],receiver_id=data['receiver_id'])


def cargo(packing,quantity,vehicle,key,issues):
    length=routing.bounded(packing.get('length_cm'),.01,3000);width=routing.bounded(packing.get('width_cm'),.01,3000)
    height=routing.bounded(packing.get('height_cm'),.01,3000);kg=routing.bounded(packing.get('weight_kg'),.01,100000)
    interior=routing.bounded(vehicle.get('floor_width_cm'),.01,3000);door=routing.bounded(vehicle.get('door_width_cm'),.01,3000)
    if None in (length,width,height,kg,interior,door):
        issues.append(error('LOAD_DIMENSIONS_REQUIRED','混合线路须明确全部包装重量尺寸及车厢净尺寸',key));return None
    if width>min(interior,door) or height>float(vehicle.get('door_cm') or 0):
        issues.append(error('LOAD_CONFLICT','包装超过车门或车厢净尺寸',key));return None
    # Do not stack or rotate without a separately approved packing arrangement.
    floor=math.ceil(quantity/math.floor(interior/width))*length
    return dict(units=quantity,kg=kg*quantity,floor_length_cm=floor,tie_slots=quantity)


def check_mixed(db,route,orders):
    """Return every before/after load; peaks include initial load and all pickups."""
    refs=parse(route.get('collections'),[o['id'] for o in orders])
    if not refs:return {'issues':[],'profile':[],'peak':{},'collections':[]}
    schema(db);issues=[];confirmed=[];rows=[];delivery={}
    vehicle=routing.resource(db,'vehicle',route.get('resource_id'))
    load=dict(units=0,kg=0,floor_length_cm=0,tie_slots=0);peak=dict(load)
    limits={k:float(vehicle.get(field) or 0) for k,field in [('units','capacity_units'),('kg','payload_kg'),('floor_length_cm','floor_length_cm'),('tie_slots','tie_slots')]}
    timeline={t['id']:t for t in route.get('check_result',{}).get('timeline',[])}
    def emit(action,oid,sn=None):
        rows.append(dict(action=action,stop_id=oid,sn=sn,**load))
        for key in load:
            peak[key]=max(peak[key],load[key])
            if load[key]>limits[key]:issues.append(error('LOAD_PEAK_CONFLICT',f'{oid} {action} 后 {key}={load[key]} 超过 {limits[key]}',oid,key))
            if load[key]<0:issues.append(error('LOAD_FLOW_INVALID','装卸后载荷不能为负',oid,key))
    def change(item,sign):
        for key in load:load[key]+=sign*item[key]
    for o in orders:
        s=route.get('stops',{}).get(o['id'],{})
        p=dict(length_cm=s.get('length_cm'),width_cm=s.get('width_cm'),height_cm=s.get('height'),weight_kg=s.get('kg'))
        delivered=set(o.get('completed_sns') or [])
        assigned=[r[0] for r in db.execute('SELECT sn FROM assets WHERE order_id=?',(o['id'],)) if r[0] not in delivered]
        quantity=len(assigned) if assigned else o['quantity']
        delivery[o['id']]=cargo(p,quantity,vehicle,o['id'],issues)
        if delivery[o['id']]:change(delivery[o['id']],1)
        if s.get('pickup_sns') or s.get('pickup_quantity'):
            issues.append(error('PICKUP_CHAIN_REQUIRED','回收只能引用实际授权 RMA，不能增加自由 SN 或货量',o['id']))
        if s.get('requires_lift')=='yes':
            extra=routing.bounded(s.get('lift_extra_kg'),0,100000)
            weight=routing.bounded(s.get('kg'),.01,100000)
            if extra is None:
                issues.append(error('LIFT_LOAD_REQUIRED','配送须确认同升降器具及人员重量',o['id']))
            elif weight is None or weight+extra>float(vehicle.get('lift_capacity_kg') or 0):
                issues.append(error('LIFT_CAPACITY_CONFLICT','配送设备及同升降载荷超过尾板承载',o['id']))
    emit('initial','origin')
    for o in orders:
        oid=o['id'];s=route.get('stops',{}).get(oid,{})
        collected=[];extra_minutes=0
        for item in refs.get(oid,[]):
            try:
                c=collection(db,item,o,route);c['stop_id']=oid;c['before_delivery']=item['before_delivery']
                # Valid active bookings belong to this exact route revision only.
                booked=db.execute('SELECT route_id,revision FROM collection_bookings WHERE rma_id=? AND active=1',(c['rma_id'],)).fetchone()
                if booked and (booked['route_id'],booked['revision'])!=(route.get('id'),route.get('version')):
                    raise ApiError(409,'回收 SN 已由另一有效车次预订')
                unit=cargo(c['packing'],1,vehicle,c['rma_id'],issues)
                if c['packing']['weight_kg']+c['lift_extra_kg']>float(vehicle.get('lift_capacity_kg') or 0):
                    issues.append(error('LIFT_CAPACITY_CONFLICT','回收设备及同升降载荷超过尾板承载',c['rma_id']))
                extra_minutes+=c['service_minutes'];confirmed.append(c)
                if unit:collected.append((c,unit))
            except ApiError as exc:issues.append(error('COLLECTION_AUTHORITY_CONFLICT',str(exc),item['rma_id']))
        if collected:
            base=routing.bounded(s.get('delivery_service_minutes'),1,720);total=routing.bounded(s.get('service'),1,1440)
            if base is None or total is None or total<base+extra_minutes:
                issues.append(error('COLLECTION_TIME_REQUIRED','现场总作业时间必须含配送作业和全部回收装载时间',oid,'service'))
            t=timeline.get(oid)
            if t:
                for c,_ in collected:
                    a=routing.local_utc(c['window_start'],c['timezone']);b=routing.local_utc(c['window_end'],c['timezone'])
                    try:
                        begin=datetime.fromisoformat(t['start']);end=datetime.fromisoformat(t['departure'])
                        if begin.tzinfo is None or end.tzinfo is None:begin=end=None
                    except (TypeError,ValueError):begin=end=None
                    if not all((a,b,begin,end)) or begin<a or end>b:
                        issues.append(error('COLLECTION_WINDOW_CONFLICT','合停全过程未落在已确认取机窗口内',c['rma_id']))
        emit('before_stop',oid)
        for c,unit in collected:
            if c['before_delivery']:change(unit,1);emit('collect_before_delivery',oid,c['sn'])
        if delivery[oid]:change(delivery[oid],-1)
        emit('deliver',oid)
        for c,unit in collected:
            if not c['before_delivery']:change(unit,1);emit('collect_after_delivery',oid,c['sn'])
    emit('return_loaded','receiver')
    return {'issues':issues,'profile':rows,'peak':peak,'collections':confirmed}


def reserve(db,route):
    schema(db)
    orders=[get_order(db,oid,{'role':'dispatch','username':'planning'}) for oid in route['order_ids']]
    result=check_mixed(db,route,orders)
    if result['issues']:raise ApiError(409,'混合回收复核失败：'+'；'.join(x['message'] for x in result['issues']))
    for c in result['collections']:
        try:
            db.execute('INSERT OR IGNORE INTO collection_bookings VALUES(?,?,?,?,?,?,?,1)',(c['rma_id'],route['id'],route['version'],c['stop_id'],c['sn'],c['case_version'],c['asset_version']))
            current=db.execute('SELECT route_id,revision FROM collection_bookings WHERE rma_id=? AND active=1',(c['rma_id'],)).fetchone()
            if not current or tuple(current)!=(route['id'],route['version']):raise ApiError(409,'回收已由其他车次占用')
        except sqlite3.IntegrityError:raise ApiError(409,'回收已由其他车次占用') from None
    return result


def compare(db,body,user):
    if user['role'] not in {'admin','dispatch'}:raise ApiError(403,'仅调度可比较送收顺序')
    route=body.get('route')
    if not isinstance(route,dict):raise ApiError(422,'须提供可核验的路线草案')
    ids=route.get('order_ids') or []
    if not ids or len(set(ids))!=len(ids):raise ApiError(422,'配送订单范围无效')
    orders=[get_order(db,oid,user) for oid in ids]
    if route.get('order_versions')!={o['id']:o['version'] for o in orders}:raise ApiError(409,'配送版本已变化')
    references=parse(route.get('collections'),ids)
    # Comparator changes loading order only. Distances and arrival windows must be
    # recomputed before adopting a geographically reordered route.
    results=[]
    for before in (False,True):
        candidate=copy.deepcopy(route)
        candidate['collections']=copy.deepcopy(references)
        for values in candidate['collections'].values():
            for ref in values:ref['before_delivery']=before
        result=check_mixed(db,candidate,orders)
        results.append(dict(order='collect_then_deliver' if before else 'deliver_then_collect',**result,feasible=not result['issues']))
    return {'comparisons':results,'scope':'authorized_same_site_load_sequence','geographic_sequence_unchanged':True}
