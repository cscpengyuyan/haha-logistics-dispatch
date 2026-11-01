"""Versioned dispatch plans. Candidate selection does not authorize shipment.

Reuses order, quote, inventory, route, booking and F04 services. SQLite transactions
belong to the caller. Browser mode uses the same result and validation contract.
"""
import copy
import hashlib
import itertools
import json
import math
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from core import ApiError, encode, get_order, now, required
import routing
import review
import planning_solver

READ = {'admin', 'dispatch', 'finance', 'procurement'}
SCOPES = {'delivery_complete', 'authorized_stage'}
OBJECTIVES = {'lowest_cost', 'earliest_finish', 'fewest_transfers'}
ROUTE_INPUT_FIELDS = {'id','version','name','warehouse','date','start_time','timezone','order_ids','order_versions',
    'resource_id','crew_id','executor_id','service_minutes','notes','road_basis','road_id','road','checks','stops',
    'return_policy','collections','cost_scenario','rate_card_id'}
# Existing saved route responses may be submitted again; these display fields
# are accepted but are never trusted as planning facts.
ROUTE_DISPLAY_FIELDS = {'type','phase','check_result','warehouse_id','first_leg','first_leg_ids'}


def init_db(db):
    # execute (not executescript) preserves an enclosing transaction.
    for sql in (
        'CREATE TABLE IF NOT EXISTS dispatch_plans(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS dispatch_idempotency(actor TEXT NOT NULL,action TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,action,key))',
        'CREATE TABLE IF NOT EXISTS dispatch_profiles(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id))',
        'CREATE TABLE IF NOT EXISTS dispatch_jobs(id TEXT PRIMARY KEY,plan_id TEXT,state TEXT NOT NULL,attempt INTEGER NOT NULL,lease TEXT,expires REAL,version INTEGER NOT NULL,data TEXT NOT NULL)'):
        db.execute(sql)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def issue(code, message, oid='', field='', next_step='请责任岗位补齐并重新计算'):
    return dict(code=code, message=message, object_id=oid, field=field, next_step=next_step)


def minor(value):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or amount != amount.quantize(Decimal('.01')):
            raise ValueError()
        return int(amount * 100)
    except (InvalidOperation, TypeError, ValueError):
        return None


def ids_from(body):
    ids = body.get('order_ids')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or any(not isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
        raise ApiError(400, '计划须包含 1–500 个唯一订单 ID')
    return ids


def snapshot(db, ids, user):
    orders = [get_order(db, oid, user) for oid in ids]
    tables = ['registry', 'assets', 'capability', 'tariffs', 'positioning', 'gate_links', 'route_bookings', 'dispatch_profiles', 'after_cases', 'collection_bookings', 'recovery_vehicle_holds']
    known = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # Include resources, stock, quotes and bookings. Conservative invalidation is
    # preferable to adopting a plan after a concurrent reservation or price edit.
    data = {'orders': orders}
    # Staff availability is a hard dependency; credentials are never included.
    data['users']=[dict(r) for r in db.execute('SELECT username,role,active FROM users ORDER BY username')]
    for table in tables:
        data[table] = []
        if table in known:
            data[table] = [dict(r) for r in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
    return orders, digest(data)


def profiles(db, kind):
    return {r['id']: {**json.loads(r['data']), 'profile_version': r['version']} for r in db.execute('SELECT * FROM dispatch_profiles WHERE kind=?', (kind,))}


def current_quote(db, order):
    selected = order.get('selected_quote') or {}
    row = db.execute("SELECT * FROM registry WHERE type='quote' AND id=?", (selected.get('id'),)).fetchone()
    if not row or row['version'] != selected.get('version'):
        raise ApiError(409, '中选报价缺失或版本已变化')
    return {**json.loads(row['data']), 'id':row['id'], 'version':row['version']}


def authorized_stage(db, order):
    p = profiles(db, 'stage').get(order['id']) or {}
    if order.get('route') != 'C2' or order['status'] != 'ready':
        raise ApiError(422, '本阶段价格仅适用 C2 已授权到站首程')
    if p.get('order_version') != order['version'] or p.get('scope_snapshot') != review.scope_snapshot(order):
        raise ApiError(409, '阶段委托价格或范围已变化')
    fields = ('receiving_acceptance_ref','storage_responsibility','downstream_owner','downstream_deadline','evidence','valid_until')
    if any(not p.get(k) for k in fields) or p.get('valid_until','') < max(now()[:10],order.get('window_end','')[:10]):
        raise ApiError(422, '阶段委托须明确接站、保管、后程责任人与期限及有效期')
    if p.get('currency') != 'USD' or type(p.get('amount_minor')) is not int or p['amount_minor'] < 0 or type(p.get('storage_daily_minor')) is not int or p['storage_daily_minor'] < 0:
        raise ApiError(422, '阶段全价和短存计价未确认，不能按零处理')
    if type(p.get('storage_capacity_units')) is not int or p['storage_capacity_units'] < order['quantity']:
        raise ApiError(422, '接站可用仓位不足')
    zone=(order.get('station_mandate') or {}).get('timezone') or order['timezone']
    if not routing.local_utc(p['downstream_deadline'], zone):
        raise ApiError(422, '后程采购处理期限须为有效当地时刻')
    return p


def precheck(db, body, user):
    ids = ids_from(body)
    scope = body.get('planning_scope', 'delivery_complete')
    if scope not in SCOPES:
        raise ApiError(400, 'planning_scope 无效')
    orders, fingerprint = snapshot(db, ids, user)
    rows, all_issues = [], []
    for o in orders:
        import migrations
        errors = migrations.pending_issues(o)
        def add(code, message, field, next_step):
            errors.append(issue(code, message, o['id'], field, next_step))
        if o.get('status') not in {'new', 'ready', 'at_station'}:
            add('STATE_FROZEN', '已执行或终态订单不能重新分配整个履约链', 'status', '从当前实际位置建立剩余运段计划')
        if not routing.point(o):
            add('LOCATION_REQUIRED', '交付坐标缺失', 'lat', '销售核实实际交付入口')
        for field in ('window_start', 'window_end'):
            if routing.local_utc(o.get(field), o.get('timezone')) is None:
                add('WINDOW_CONFLICT', '当地时刻缺失、夏令时歧义或不存在', field, '销售确认 IANA 时区及明确 UTC 偏移')
        origin_name = o.get('station_name') if o['status'] == 'at_station' else o.get('warehouse')
        if not routing.point(routing.origin_resource(db, origin_name)):
            add('ORIGIN_REQUIRED', '实际持货仓入口未核实', 'warehouse', '仓管补录持货仓坐标和凭据')
        stock = [dict(r) for r in db.execute('SELECT * FROM assets WHERE order_id=?', (o['id'],))]
        expected = 'station' if o['status'] == 'at_station' else 'reserved'
        if len(stock) != o['quantity'] or any(s['state'] != expected or (expected != 'station' and s['warehouse'] != origin_name) for s in stock):
            add('INVENTORY_UNAVAILABLE', '实际锁定 SN、货况或持货仓未满足当前运段', 'sn', '库存岗实收验货并按正常库存流程分配 SN')
        if o.get('route') in {'C1', 'C2'} and o['status'] != 'at_station':
            import folder
            try:
                folder.assert_station_authority(db, o)
            except ApiError as e:
                add('STATION_AUTHORITY_REQUIRED', str(e), 'station_mandate', '采购落实接站书面承接和保管责任')
            if not o.get('second_leg') and (scope == 'delivery_complete' or o['route'] == 'C1'):
                add('ONWARD_REQUIRED', '完整履约或 C1 首程需要有效后程安排', 'second_leg', '采购落实二程委托；合法 C2 可单独选择已授权阶段')
        if not o.get('pickup'):
            try:
                if scope == 'authorized_stage' and o.get('route') == 'C2' and o['status'] == 'ready':
                    authorized_stage(db, o)
                else:
                    quote = current_quote(db, o)
                    review.validate_quote(o, quote)
                    import supply
                    supply.assert_eligible(db, quote, o)
                    if minor(quote.get('amount')) is None:
                        raise ApiError(422, '费用金额缺失或不是有效两位小数')
            except ApiError as e:
                add('COST_INCOMPLETE', str(e), 'selected_quote', '采购补齐同范围、有效期内的逐项全价')
        rows.append({'id': o['id'], 'issues': errors, 'ready': not errors})
        all_issues.extend(errors)
    return dict(order_ids=ids, planning_scope=scope, input_hash=fingerprint, orders=rows, issues=all_issues,
                ready_count=sum(not x['issues'] for x in rows), validation_status='passed' if not all_issues else 'conditions_pending')


def route_cost(db, route, orders):
    items, errors = [], []
    for o in orders:
        try:
            if o.get('route') == 'C2' and route.get('planning_scope') == 'authorized_stage' and o['status'] == 'ready':
                p = authorized_stage(db, o)
                items.append(dict(order_id=o['id'],amount_minor=p['amount_minor'],currency=p['currency'],payee=(o.get('selected_quote') or {}).get('supplier_id'),
                                  source='stage:'+o['id'],source_version=p['profile_version'],event='authorized_first_leg',storage_daily_minor=p['storage_daily_minor']))
                continue
            q = current_quote(db, o)
            review.validate_quote(o, q)
            amount = minor(q.get('amount'))
            if amount is None:
                raise ApiError(422, '全价未确认')
            items.append(dict(order_id=o['id'], amount_minor=amount, currency=q.get('currency', 'USD'),
                              payee=q.get('supplier_id') or q.get('carrier'), source=q.get('id'), source_version=q.get('version'), event='delivery'))
        except ApiError as e:
            errors.append(issue('COST_INCOMPLETE', str(e), o['id'], 'selected_quote'))
    currencies = {i['currency'] for i in items}
    if len(currencies) > 1:
        errors.append(issue('CURRENCY_CONFLICT', '未确认汇率，不跨币种排名', route.get('id', ''), 'currency'))
    return items, errors


def rate_cost(db, route, orders, items, errors):
    """Use a procurement-confirmed exact rate card, including shared day activation.

The card explicitly replaces the full quote scope for named order versions; it
cannot silently subtract selected quote components or treat a missing extra as 0.
"""
    resource_profile = profiles(db, 'resource').get(route.get('resource_id'), {})
    rid = resource_profile.get('rate_card_id')
    activations, pools = {}, []
    if resource_profile.get('pool_key'):
        capacity = resource_profile.get('pool_capacity')
        if type(capacity) is not int or capacity < 1:
            errors.append(issue('CAPACITY_REQUIRED', '共享池额度必须是已确认正整数', route.get('id', ''), 'pool_capacity'))
        else:
            pools = [dict(key=resource_profile['pool_key']+':'+route['date'], capacity=capacity, quantity=sum(o['quantity'] for o in orders))]
    if not rid:
        return items, errors, activations, pools
    card = profiles(db, 'rate_card').get(rid)
    if not card:
        return items, errors+[issue('COST_INCOMPLETE','价卡不存在',rid,'rate_card_id')], {}, pools
    if (not card.get('replaces_full_price') or card.get('supplier_id') != route.get('executor_id') or
        not card.get('valid_from','') <= route['date'] <= card.get('valid_until','') or
        any(card.get('order_versions',{}).get(o['id']) != o['version'] for o in orders)):
        return items, errors+[issue('STALE_PRICE','价卡范围、供应商、订单版本或有效期不符',rid,'rate_card')], {}, pools
    quantity=sum(o['quantity'] for o in orders)
    amount=max(card['minimum_minor'],card['base_minor']+card['per_order_minor']*len(orders)+card['per_unit_minor']*quantity+card['per_stop_minor']*route['check_result']['stop_count'])
    if card['day_minor']:
        activations[route['executor_id']+':'+route['date']+':'+rid] = card['day_minor']
    # Stable integer residual distribution; sums equal the exact route charge.
    quotient,remainder=divmod(amount,len(orders))
    items=[dict(order_id=o['id'],amount_minor=quotient+(i<remainder),currency=card['currency'],payee=card['supplier_id'],source=rid,
                source_version=card['profile_version'],event='contract_route_allocation') for i,o in enumerate(sorted(orders,key=lambda x:x['id']))]
    return items, errors, activations, pools


def strict_load(db, route, orders):
    if route.get('collections'):
        import load_profile
        result=load_profile.check_mixed(db,route,orders)
        return result['issues'],result['profile']
    vehicle = routing.resource(db, 'vehicle', route.get('resource_id'))
    errors, rows, floor_by_order = [], [], {}
    floor = 0
    weight = units = 0
    for o in orders:
        s = route.get('stops', {}).get(o['id'], {})
        length, width = (routing.bounded(s.get(k), .01, 3000) for k in ('length_cm', 'width_cm'))
        interior = routing.bounded(vehicle.get('floor_width_cm'), .01, 3000)
        doorway = routing.bounded(vehicle.get('door_width_cm'), .01, 3000)
        if None in (length, width, interior, doorway):
            errors.append(issue('LOAD_DIMENSIONS_REQUIRED', '须核实包装长宽、车厢地板和车门净宽', o['id'], 'length_cm'))
        elif width > doorway or width > interior:
            errors.append(issue('LOAD_CONFLICT', '包装净宽超过车门或车厢', o['id'], 'width_cm'))
        else:
            occupied=math.ceil(o['quantity'] / math.floor(interior / width)) * length
            floor += occupied
            floor_by_order[o['id']]=occupied
        if s.get('pickup_sns') or s.get('pickup_quantity'):
            errors.append(issue('PICKUP_CHAIN_REQUIRED','回收须从已批准售后任务及实际 SN 创建独立回收运段，不能用自由站点字段增加载货',o['id'],'pickup_sns'))
        units += o['quantity']
        kg = routing.bounded(s.get('kg'), .01, 100000)
        weight += (kg or 0) * o['quantity']
        # Helper/trolley weight is not assumed to be zero when a lift is required.
        if s.get('requires_lift') == 'yes':
            extra = routing.bounded(s.get('lift_extra_kg'), 0, 100000)
            if extra is None:
                errors.append(issue('LIFT_LOAD_REQUIRED', '补录同升降器具及人员载荷；不参与升降时明确填 0', o['id'], 'lift_extra_kg'))
            elif kg is None or kg + extra > float(vehicle.get('lift_capacity_kg') or 0):
                errors.append(issue('LIFT_CAPACITY_CONFLICT', '尾板实际升降载荷超过额定值', o['id'], 'lift_extra_kg'))
    if floor > float(vehicle.get('floor_length_cm') or 0):
        errors.append(issue('LOAD_CONFLICT', '保守整行占地超过车厢净长', route.get('id', ''), 'floor_length_cm'))
    for o in orders:
        rows.append(dict(before=o['id'], units=units, kg=weight, floor_length_cm=floor))
        s = route.get('stops', {}).get(o['id'], {})
        units -= o['quantity']
        weight -= (routing.bounded(s.get('kg'), .01, 100000) or 0) * o['quantity']
        floor -= floor_by_order.get(o['id'],0)
        rows.append(dict(after=o['id'],units=units,kg=max(0,weight),floor_length_cm=max(0,floor)))
    return errors, rows


def evaluated(db, route, order_map, scope, future=False):
    r = copy.deepcopy({k:v for k,v in route.items() if k in ROUTE_INPUT_FIELDS})
    ids = r.get('order_ids', [])
    orders = [order_map[i] for i in ids]
    r.setdefault('id', 'C-' + digest(r)[:12])
    r.setdefault('version', 0)
    r.setdefault('road_basis', 'estimate')
    r.setdefault('checks', {})
    r.setdefault('stops', {})
    r.setdefault('resource_id', '')
    r.setdefault('crew_id', '')
    r.setdefault('timezone', 'America/Chicago')
    r.setdefault('start_time', '08:00')
    r.setdefault('date', str(orders[0].get('window_start', now()))[:10])
    r.setdefault('warehouse', orders[0].get('warehouse', ''))
    r['warehouse_id'] = routing.origin_resource(db, r['warehouse']).get('id')
    r['planning_scope'] = scope
    r['first_leg_ids'] = [o['id'] for o in orders if o['route'] in {'C1', 'C2'} and o['status'] == 'ready']
    errors = []
    if r.get('order_versions') != {o['id']: o['version'] for o in orders}:
        errors.append(issue('STALE_INPUT', '草案订单版本已变化', r['id'], 'order_versions', '刷新并重新生成路线'))
    if r.get('road_basis') == 'valhalla_truck':
        try:
            routing.attach_road(db, r, r.get('road_id') or r.get('road', {}).get('id'))
        except ApiError as e:
            errors.append(issue('ROAD_UNAVAILABLE', str(e), r['id'], 'road_id'))
    check = routing.check_route(db, r, orders, ids if future else ())
    errors.extend(issue('ROUTE_CONFLICT', msg, r['id'], 'route') for msg in check['issues'])
    load_errors, load = strict_load(db, r, orders)
    errors.extend(load_errors)
    cost_items, cost_errors = route_cost(db, r, orders)
    r['check_result'] = check
    cost_items, cost_errors, activations, pools = rate_cost(db, r, orders, cost_items, cost_errors)
    errors.extend(cost_errors)
    if scope == 'delivery_complete' and r['first_leg_ids']:
        errors.append(issue('CHAIN_INCOMPLETE', '此候选只覆盖到站首程，尚未连接可执行二程', r['id'], 'second_leg', '生成已授权阶段计划或补齐连续二程候选'))
    r.update(check_result=check, issues=errors, load_profile=load, cost_items=cost_items,
             total_minor=sum(i['amount_minor'] for i in cost_items) if not cost_errors else None,
             currency=cost_items[0]['currency'] if cost_items else 'USD', validation_status='passed' if not errors else 'conditions_pending')
    r['activations'], r['pools'] = activations, pools
    r['sns'] = [x[0] for oid in ids for x in db.execute('SELECT sn FROM assets WHERE order_id=?', (oid,))]
    if r.get('collections'):
        import load_profile
        mixed=load_profile.check_mixed(db,r,orders)
        r['mixed_load']=mixed
        r['sns'].extend(c['sn'] for c in mixed['collections'])
        for c in mixed['collections']:
            r['cost_items'].append(dict(order_id=c['source_order_id'],rma_id=c['rma_id'],amount_minor=c['amount_minor'],currency='USD',source=c['cost_approval_ref'],event='authorized_recovery'))
            if r['total_minor'] is not None:r['total_minor']+=c['amount_minor']
    r['occupancy'] = []
    if check.get('start_utc') and check.get('end_utc'):
        start, end = (int(datetime.fromisoformat(check[k]).timestamp()) for k in ('start_utc', 'end_utc'))
        r['finish'] = end
        for kind, rid in [('vehicle', r['resource_id']), ('crew', r['crew_id']), ('driver', r['checks'].get('driver'))]:
            if rid:
                # A verified return to origin can connect the next route. An open
                # route ends at its last stop and requires explicit repositioning.
                ending = r['warehouse'] if float(r['checks'].get('return_min') or 0) > 0 else ids[-1]
                r['occupancy'].append(dict(kind=kind, id=rid, start=start, end=end, start_location=r['warehouse'], end_location=ending))
    return r


def complete_chains(db, routes, order_map, body):
    """Build C1/C2 path candidates from validated first and future second legs.

Future stock is a dependency, never inserted into inventory. Adoption stores only
the currently authorized first leg; the second leg requires an actual station
receipt and the existing revalidation/release API.
"""
    facts=profiles(db,'order'); result=[]
    for first in routes:
        if len(first['order_ids']) != 1 or not first.get('first_leg_ids'):
            continue
        oid=first['order_ids'][0];o=order_map[oid];leg=o.get('second_leg') or {}
        if not leg or leg.get('state')!='accepted':continue
        profile=facts.get(oid,{})
        handling=profile.get('station_processing_minutes')
        if (type(handling) is not int or handling < 0 or not profile.get('station_capacity_ref') or
            type(profile.get('station_capacity_units')) is not int or profile['station_capacity_units'] < o['quantity']):
            continue
        first_errors=[e for e in first['issues'] if e['code']!='CHAIN_INCOMPLETE']
        if first_errors or not first['check_result']['timeline']:continue
        virtual=copy.deepcopy(o);virtual.update(status='at_station',station_name=leg['station_name'])
        raw,_=generated(db,[virtual],body)
        for second_raw in raw:
            second=evaluated(db,second_raw,{oid:virtual},'delivery_complete',future=True)
            if second['issues']:continue
            arrived=datetime.fromisoformat(first['check_result']['timeline'][-1]['departure'])+timedelta(minutes=handling)
            if datetime.fromisoformat(second['check_result']['start_utc']) < arrived:continue
            # Each physical resource remains occupied independently across legs.
            a={**first,'order_ids':[],'sns':[]};b={**second,'order_ids':[],'sns':[]}
            if planning_solver.conflict(a,b):continue
            combined=copy.deepcopy(first)
            combined.update(id='CHAIN-'+digest([first['id'],second['id']])[:12],segments=[first,second],future_segments=[second],
                occupancy=first['occupancy']+second['occupancy'],finish=second['finish'],transfers=1,issues=[],validation_status='passed',
                dependencies=[dict(order_id=oid,event='actual_station_receipt',processing_minutes=handling,station_id=leg['station_id'],capacity_evidence=profile['station_capacity_ref'])])
            combined['pools']=first.get('pools',[])+second.get('pools',[])+[dict(key='station:'+leg['station_id']+':'+first['date'],quantity=o['quantity'],capacity=profile['station_capacity_units'])]
            if o['route']=='C2':
                # Segment prices and storage cannot be guessed from a whole-order quote.
                chain=profile.get('chain_cost') or {}
                if (chain.get('order_version')!=o['version'] or not chain.get('evidence') or chain.get('currency')!='USD' or
                    any(type(chain.get(k)) is not int or chain[k]<0 for k in ('first_minor','receiving_minor','storage_minor','second_minor','technical_minor'))):
                    continue
                combined['cost_items']=[dict(order_id=oid,amount_minor=chain[k],currency='USD',source=chain['evidence'],event=k) for k in ('first_minor','receiving_minor','storage_minor','second_minor','technical_minor')]
                combined['total_minor']=sum(x['amount_minor'] for x in combined['cost_items'])
            result.append(combined)
    return result


def technical_candidates(db, routes, order_map):
    """Append independently occupied, authorized L5 work after physical delivery."""
    profiles_by_order=profiles(db,'technical');out=[]
    for route in routes:
        affected=[order_map[oid] for oid in route['order_ids'] if order_map[oid].get('addon_l5')]
        if not affected or route.get('planning_scope')=='authorized_stage':
            out.append(route);continue
        variations=[route]
        for o in affected:
            profile=profiles_by_order.get(o['id'],{})
            valid=(profile.get('order_version')==o['version'] and profile.get('scope_snapshot')==review.scope_snapshot(o) and profile.get('authorization_ref'))
            next_variations=[]
            for r in variations:
                final=r.get('segments',[r])[-1]
                event=next((t for t in final['check_result']['timeline'] if t['id']==o['id']),None)
                if not valid or not event:continue
                delivered=int(datetime.fromisoformat(event['departure']).timestamp())
                for offer in profile.get('offers',[])[:8]:
                    account=db.execute("SELECT 1 FROM users WHERE username=? AND role='service' AND active=1",(offer.get('technician'),)).fetchone()
                    a=routing.local_utc(offer.get('window_start'),offer.get('timezone'))
                    b=routing.local_utc(offer.get('window_end'),offer.get('timezone'))
                    minutes=offer.get('service_minutes');extra=offer.get('amount_minor')
                    if (not account or not a or not b or type(minutes) is not int or minutes<=0 or
                        not offer.get('qualification_ref') or not offer.get('tools_ref') or
                        type(extra) is not int or extra<0 or offer.get('price_included') not in (True,False)):
                        continue
                    for delay in (0,1800,3600):
                        start=max(delivered,int(a.timestamp()))+delay;end=start+minutes*60
                        if end>int(b.timestamp()):continue
                        occ=dict(kind='technician',id=offer['technician'],start=start,end=end,start_location=o['id'],end_location=o['id'],
                                 reposition_seconds=offer.get('reposition_seconds'))
                        # One candidate may contain several L5 tasks. Reuse the
                        # same overlap and reposition rule as inter-route choice.
                        if planning_solver.conflict({'order_ids':[],'occupancy':r['occupancy']},
                                                    {'order_ids':[],'occupancy':[occ]}):
                            continue
                        next_r=copy.deepcopy(r)
                        next_r.setdefault('technical_tasks',[]).append(dict(order_id=o['id'],technician=offer['technician'],start_utc=datetime.fromtimestamp(start,timezone.utc).isoformat(),end_utc=datetime.fromtimestamp(end,timezone.utc).isoformat(),authorization_ref=profile['authorization_ref']))
                        next_r['occupancy'].append(occ);next_r['finish']=max(next_r.get('finish',0),end)
                        if not offer['price_included']:
                            next_r['cost_items'].append(dict(order_id=o['id'],amount_minor=extra,currency='USD',payee=offer['technician'],source=profile['authorization_ref'],event='technical'))
                            if next_r['total_minor'] is not None:next_r['total_minor']+=extra
                        next_r['id']='TECH-'+digest([r['id'],o['id'],occ])[:12]
                        next_variations.append(next_r)
            if not next_variations:
                for r in variations:
                    r=copy.deepcopy(r);r['issues'].append(issue('TECHNICAL_CAPACITY_REQUIRED','L5缺少有效技师委托、工具、价格或交付后时段',o['id'],'technical', '采购登记技术委托，调度确认独立技师可用时段'))
                    r['validation_status']='conditions_pending';out.append(r)
                variations=[];break
            variations=next_variations[:16]
        out.extend(variations)
    return out


def commitment_candidates(db, orders, scope):
    """Supplier-controlled network/pickup promises have no fictitious vehicle."""
    facts=profiles(db,'commitment');out=[]
    for o in orders:
        if not o.get('pickup') and o.get('procurement_mode') not in {'platform','ltl'}:continue
        p=facts.get(o['id'],{});errors=[]
        if p.get('order_version')!=o['version'] or p.get('scope_snapshot')!=review.scope_snapshot(o) or not p.get('acceptance_ref'):
            continue
        start=routing.local_utc(p.get('start'),p.get('timezone'));end=routing.local_utc(p.get('end'),p.get('timezone'))
        if not start or not end or start>=end:continue
        if o.get('pickup'):
            if not p.get('authorized_collector') or not p.get('identity_ref') or type(p.get('handling_minor')) is not int or p['handling_minor']<0:continue
            costs=[dict(order_id=o['id'],amount_minor=p['handling_minor'],currency='USD',source=p['evidence'],event='pickup_handling')]
        else:
            instruction=o.get('platform_instruction') or {}
            if instruction.get('scope_snapshot')!=review.scope_snapshot(o) or instruction.get('valid_until','')<max(now()[:10],p['end'][:10]):continue
            costs,cost_errors=route_cost(db,{'planning_scope':scope},[o]);errors.extend(cost_errors)
        if type(p.get('capacity_units')) is not int or p['capacity_units']<o['quantity'] or not p.get('pool_key'):continue
        first=o['route'] in {'C1','C2'} and not o.get('pickup')
        if first and scope=='delivery_complete':errors.append(issue('CHAIN_INCOMPLETE','供应商只承诺到站首程，需衔接后程',o['id'],'second_leg'))
        if not first:
            cutoff=routing.local_utc(o.get('window_end'),o.get('timezone'))
            if not cutoff or end>cutoff:errors.append(issue('WINDOW_CONFLICT','供应商承诺超出客户窗口',o['id'],'end'))
        out.append(dict(id='PROMISE-'+digest([o['id'],p])[:12],name=('仓口自提 / ' if o.get('pickup') else '供应商承诺 / ')+o['id'],kind='pickup' if o.get('pickup') else 'supplier_commitment',
            order_ids=[o['id']],order_versions={o['id']:o['version']},planning_scope=scope,warehouse=o['warehouse'],date=p['start'][:10],
            timezone=p['timezone'],road_basis='supplier_commitment',resource_id='',crew_id='',first_leg_ids=[o['id']] if first else [],
            check_result=dict(timeline=[dict(id=o['id'],arrival=start.isoformat(),start=start.isoformat(),departure=end.isoformat(),timezone=p['timezone'])],issues=[],start_utc=start.isoformat(),end_utc=end.isoformat(),resource_versions={}),
            total_minor=sum(c['amount_minor'] for c in costs) if not errors or all(e['code']=='CHAIN_INCOMPLETE' for e in errors) else None,
            currency='USD',cost_items=costs,sns=[r[0] for r in db.execute('SELECT sn FROM assets WHERE order_id=?',(o['id'],))],occupancy=[],activations={},
            pools=[dict(key=p['pool_key']+':'+p['start'][:10],quantity=o['quantity'],capacity=p['capacity_units'])],finish=int(end.timestamp()),
            commitment=p,issues=errors,validation_status='passed' if not errors else 'conditions_pending'))
    return out


def generated(db, orders, body):
    """Enumerate real per-vehicle capacity and date groups, without invented evidence.

Facts may be entered via /profiles/order and /profiles/resource. Missing travel or
service facts remain absent. Drafts still explain what must be confirmed.
"""
    import operations
    facts = profiles(db, 'order')
    calendars = profiles(db, 'resource')
    resources = operations.list_records(db, False, {'role': 'dispatch'})
    vehicles = [r for r in resources if r['type'] == 'vehicle']
    crews = [r for r in resources if r['type'] == 'crew']
    groups = defaultdict(list)
    for o in orders:
        if o.get('pickup') or (o.get('procurement_mode') in {'platform', 'ltl'} and o['status']!='at_station'):
            continue
        if not o.get('selected_quote') and o['status']!='at_station':
            continue
        origin = o.get('station_name') if o['status'] == 'at_station' else o.get('warehouse')
        executor=(o.get('second_leg') if o['status']=='at_station' else o.get('selected_quote')) or {}
        groups[(origin, str(o.get('window_start') or '')[:10], executor.get('executor_id', ''))].append(o)
    candidates, signatures = [], set()
    for (origin, day, executor), items in groups.items():
        depot = routing.origin_resource(db, origin)
        if not depot or not day:
            continue
        for vehicle in vehicles:
            if executor and vehicle.get('executor_id') != executor:
                continue
            max_units = int(min(vehicle.get('capacity_units') or 0, vehicle.get('tie_slots') or 0))
            if not max_units:
                continue
            for crew in crews:
                if crew.get('executor_id') != vehicle.get('executor_id'):
                    continue
                # Exact coverage, not a radius or the largest vehicle in the fleet.
                eligible = [o for o in items if o['quantity'] <= max_units and o.get('zip', '') in routing.names(crew.get('coverage'))]
                for ordering in (sorted(eligible, key=lambda o: o.get('window_end', '')), list(reversed(eligible))):
                    batches, batch, units = [], [], 0
                    for o in ordering:
                        if units + o['quantity'] > max_units or len(batch) >= 6:
                            batches.append(batch); batch, units = [], 0
                        batch.append(o); units += o['quantity']
                    if batch:
                        batches.append(batch)
                    # Single-order alternatives preserve scarce resource choices.
                    batches.extend([[o] for o in eligible])
                    for batch in batches:
                        profile = calendars.get(vehicle['id'], {})
                        shifts = profile.get('shifts', {}).get(day, [])
                        for shift in shifts or [{}]:
                            starts = shift.get('start_times') or [shift.get('start_time', '08:00')]
                            for departure in starts[:4]:
                                r = dict(name=f'{origin} · {day} · {vehicle["name"]}', warehouse=origin, date=day,
                                         timezone=depot.get('timezone', 'America/Chicago'), start_time=departure,
                                         order_ids=[o['id'] for o in batch], order_versions={o['id']:o['version'] for o in batch},
                                         resource_id=vehicle['id'], crew_id=crew['id'], executor_id=executor or vehicle.get('executor_id', ''),
                                         service_minutes=45, road_basis=shift.get('road_basis', 'estimate'),
                                         checks=copy.deepcopy(shift.get('checks', {})), stops={})
                                previous = depot['id']
                                for o in batch:
                                    f = facts.get(o['id'], {})
                                    if f.get('order_version') != o['version']:
                                        f = {}
                                    future=o['status']=='at_station'
                                    stop = copy.deepcopy(f.get('last_stop' if future else 'stop', {}))
                                    leg = f.get('last_legs' if future else 'legs', {}).get(previous, {})
                                    if leg.get('vehicle_id') == vehicle['id'] and leg.get('vehicle_version') == vehicle['version'] and leg.get('date') == day:
                                        stop.update({k:leg[k] for k in ('travel', 'road_ref') if k in leg})
                                    else:
                                        stop.pop('travel', None); stop.pop('road_ref', None)
                                    stop['from_id'] = previous
                                    r['stops'][o['id']] = stop
                                    previous = o['id']
                                signature=digest(r)
                                if signature not in signatures:
                                    candidates.append(r);signatures.add(signature)
    if len(candidates)>500:
        # Preserve first coverage opportunities before extra alternatives; missing
        # evidence cannot crowd complete inputs out of the bounded candidate set.
        candidates.sort(key=lambda r:sum(bool(s.get('road_ref')) for s in r['stops'].values())+bool(r['checks'].get('driver')),reverse=True)
        chosen,covered=[],set();pending=candidates[:]
        while pending and len(chosen)<500:
            index=max(range(len(pending)),key=lambda i:len(set(pending[i]['order_ids'])-covered))
            r=pending.pop(index);chosen.append(r);covered.update(r['order_ids'])
        return chosen,True
    return candidates,False


def plan_save(db, plan):
    db.execute('INSERT OR REPLACE INTO dispatch_plans VALUES(?,?,?,?)', (plan['id'], plan['version'], plan['state'], encode(plan)))
    return plan


def plan_get(db, pid):
    row = db.execute('SELECT data FROM dispatch_plans WHERE id=?', (pid,)).fetchone()
    if not row:
        raise ApiError(404, '计划不存在')
    return json.loads(row[0])


def lock_issues(route, locks):
    """Apply hard locks to every controlled leg and every supplier promise."""
    errors=[]
    segments=[route]+[segment for segment in route.get('segments',[])
                      if any(segment.get(k)!=route.get(k) for k in ('order_ids','resource_id','crew_id','date'))]
    for key,field in (('vehicle_id','resource_id'),('crew_id','crew_id'),('date','date')):
        if not locks.get(key):continue
        values=[segment.get(field) or None for segment in segments]
        if any(value!=locks[key] for value in values):
            e=issue('LOCK_CONFLICT','候选不满足人工锁定 '+key,route['id'],'locks.'+key,
                    '保留当前锁定；可由调度确认调整该锁值，或补充满足锁定的合法候选后重算。')
            e.update(lock=key,requested_value=locks[key],candidate_values=values,
                     suggested_values=list(dict.fromkeys(value for value in values if value is not None)),
                     otherwise_feasible=not route['issues'],automatic_relaxation=False)
            errors.append(e)
    if locks.get('station_order'):
        for segment in segments:
            ids=segment['order_ids'];expected=[oid for oid in locks['station_order'] if oid in ids]
            actual=[oid for oid in ids if oid in expected]
            if actual!=expected:
                e=issue('LOCK_CONFLICT','候选停靠顺序不满足人工锁定',route['id'],'locks.station_order',
                        '保留锁定站序；可确认调整站序或补充按原锁定顺序计算的合法路线后重算。')
                e.update(lock='station_order',requested_value=locks['station_order'],candidate_values=[actual],
                         suggested_values=[actual],otherwise_feasible=not route['issues'],automatic_relaxation=False)
                errors.append(e)
    return errors


def optimize(db, body, user, publish=True):
    started = time.monotonic()
    checked = precheck(db, body, user)
    ids, scope = checked['order_ids'], checked['planning_scope']
    required_collections=body.get('required_collections') or {}
    if (not isinstance(required_collections,dict) or set(required_collections)-set(ids) or
        any(not isinstance(values,list) or not values or any(not isinstance(rid,str) or not rid for rid in values) for values in required_collections.values())):
        raise ApiError(422,'回收范围须为配送订单 ID 对应的非空授权 RMA ID 列表')
    requested_rmas=[rid for values in required_collections.values() for rid in values]
    if len(set(requested_rmas))!=len(requested_rmas):
        raise ApiError(422,'同一 RMA 不能重复指定到多个回收任务')
    objective = body.get('objective', 'lowest_cost')
    if objective not in OBJECTIVES:
        raise ApiError(400, '优化目标无效')
    budget = routing.bounded(body.get('budget_seconds', 10), .001, 120)
    if budget is None:
        raise ApiError(400, '计算预算须为 0.001–120 秒')
    locks = body.get('locks') or {}
    if not isinstance(locks, dict) or set(locks) - {'station_order', 'vehicle_id', 'crew_id', 'date'}:
        raise ApiError(422, 'LOCK_UNSUPPORTED：支持 station_order、vehicle_id、crew_id、date，请保留未支持锁定人工核验')
    if locks.get('station_order') and (not isinstance(locks['station_order'], list) or len(set(locks['station_order'])) != len(locks['station_order']) or not set(locks['station_order']) <= set(ids)):
        raise ApiError(422, 'LOCK_CONFLICT：锁定站序必须是不重复的本批订单 ID')
    orders = [get_order(db, oid, user) for oid in ids]
    order_map = {o['id']:o for o in orders}
    import operations
    saved = operations.list_records(db, True, user)
    supplied = body.get('route_candidates', [])
    if not isinstance(supplied, list) or len(supplied) > 500:
        raise ApiError(400, '候选路线最多 500 条')
    for r in supplied:
        if not isinstance(r,dict):raise ApiError(422,'候选路线必须为 JSON 对象')
        derived=set(r)-ROUTE_INPUT_FIELDS-ROUTE_DISPLAY_FIELDS
        if derived:
            raise ApiError(422,'ROUTE_DERIVED_FIELDS：候选仅接受路线事实，以下字段由服务端生成：'+','.join(sorted(derived)))
    raw, trimmed = generated(db, orders, body)
    raw = saved + supplied + raw
    road_errors = []
    if body.get('calculate_roads'):
        try:
            import road_service
        except ImportError:
            road_errors.append(issue('ROAD_UNAVAILABLE', '公开浏览器未连接运营方道路服务', field='calculate_roads'))
        else:
            requests, road_seen = [], set()
            for r in raw:
                signature = digest({k:r.get(k) for k in ('order_ids','order_versions','warehouse','date','start_time','timezone','resource_id','crew_id','executor_id','checks','stops','collections')})
                if signature in road_seen:
                    continue
                road_seen.add(signature)
                try:
                    road_service.inputs(db, r, user)
                except (ApiError, KeyError, TypeError):
                    continue
                requests.append({**r, 'return_policy':'origin', 'optimize':not bool(locks.get('station_order'))})
            # Give each order a first chance before spending the budget on more
            # departure/crew alternatives for the first group.
            ordered, covered = [], set()
            pending = requests[:]
            while pending and len(ordered) < 48:
                best = max(range(len(pending)), key=lambda i:len(set(pending[i]['order_ids'])-covered))
                request = pending.pop(best);ordered.append(request);covered.update(request['order_ids'])
            requests = ordered
            if requests:
                roads = road_service.candidates(db, {'route_requests':requests, 'budget_seconds':max(1, budget*.7)}, user)
                for response in roads['candidates']:
                    r = copy.deepcopy(requests[response['index']]); road = response['road']
                    r.update(order_ids=road['order_ids'], road_id=road['id'], road_basis='valhalla_truck')
                    r['order_versions'] = {oid:order_map[oid]['version'] for oid in road['order_ids']}
                    raw.append(r)
                road_errors.extend(issue(e['code'], e['message'], field='roads') for e in roads['errors'])
    routes, seen = [], set()
    for r in raw:
        rids = r.get('order_ids')
        if not isinstance(rids, list) or not rids or len(set(rids)) != len(rids) or not set(rids) <= set(ids):
            continue
        signature = digest({k:v for k,v in r.items() if k not in {'id', 'version', 'phase', 'check_result'}})
        if signature in seen:
            continue
        seen.add(signature)
        routes.append(evaluated(db, r, order_map, scope))
    routes.extend(commitment_candidates(db,orders,scope))
    if scope == 'delivery_complete':
        routes.extend(complete_chains(db,routes,order_map,body))
        routes=technical_candidates(db,routes,order_map)
    routes=list({r['id']:r for r in routes}.values())
    lock_conflicts=[]
    for route in routes:
        for oid in route['order_ids']:
            found={item['rma_id'] for segment in route.get('segments',[route]) for item in segment.get('collections',{}).get(oid,[])}
            if set(required_collections.get(oid,[]))-found:
                route['issues'].append(issue('COLLECTION_SCOPE_INCOMPLETE','候选未覆盖本停靠点已指定的回收任务，不能以较便宜的仅配送替代',oid,'required_collections','补充包含指定 RMA 的完整送收候选及作业时间'))
                route['validation_status']='conditions_pending'
        violations=lock_issues(route,locks)
        route['issues'].extend(violations);lock_conflicts.extend(violations)
        if violations:route['validation_status']='conditions_pending'
    bad_orders = {r['id'] for r in checked['orders'] if r['issues']}
    feasible = [r for r in routes if not r['issues'] and not set(r['order_ids']) & bad_orders]
    currencies = {r['currency'] for r in feasible}
    if len(currencies) > 1:
        feasible = []
        checked['issues'].append(issue('CURRENCY_CONFLICT', '多币种缺少已确认汇率，暂不进行最低价排名', field='currency'))
    candidates = []
    for goal in dict.fromkeys([objective, 'lowest_cost', 'earliest_finish', 'fewest_transfers']):
        result = planning_solver.choose(ids, feasible, max(.001, (budget-(time.monotonic()-started))/3), goal)
        selected = [feasible[i] for i in result['indices']]
        covered = {oid for r in selected for oid in r['order_ids']}
        unassigned = []
        for oid in ids:
            if oid not in covered:
                reasons = next(x['issues'] for x in checked['orders'] if x['id'] == oid)
                if not reasons and result['exhausted'] and any(oid in r['order_ids'] for r in feasible):
                    reasons=[issue('SEARCH_BUDGET_EXHAUSTED','搜索预算已耗尽，本票尚未纳入当前可行方案；未证明无解',oid,'budget_seconds','保留已有可行结果，可增加预算或补充候选后重试；不会自动解除硬锁。')]
                elif not reasons and any(oid in r['order_ids'] for r in feasible):
                    reasons=[issue('CAPACITY_CONFLICT','单票存在可行候选，但与已选方案的车辆、班组、技师、共享额度或跨起点调位相冲突',oid,'occupancy','补充对应资源或核实调位时间后重新计算，不解除已确认硬条件')]
                elif not reasons:
                    reasons = sorted([i for r in routes if oid in r['order_ids'] for i in r['issues']],key=lambda i:i['code']!='LOCK_CONFLICT')[:12]
                if not reasons:
                    reasons = [issue('CAPACITY_CONFLICT', '当前候选中无可同时满足约束的资源', oid, 'resource', '补充车辆、班组、确认时段或更多合法候选')]
                unassigned.append({'order_id':oid, 'reasons':reasons})
        coverage = dict(total=len(ids), assigned=len(covered), order_complete=len(covered) if scope == 'delivery_complete' else 0,
                        stage_assigned=len(covered), order_coverage=len(covered)/len(ids) if scope == 'delivery_complete' else 0,
                        stage_coverage=len(covered)/len(ids))
        coverage.update(collection_total=len(requested_rmas),collection_assigned=sum(len(required_collections.get(oid,[])) for oid in covered))
        shared={key:amount for r in selected for key,amount in r.get('activations',{}).items()}
        shared_items=[dict(event='shared_day_activation',source=key,amount_minor=amount,currency=next(iter(currencies),'USD')) for key,amount in shared.items()]
        candidate = dict(id='ALT-' + str(len(candidates)+1), objective=goal, routes=selected,
                         total_minor=planning_solver.cost(selected) if selected else None, currency=next(iter(currencies), 'USD'),
                         cost_items=[i for r in selected for i in r['cost_items']]+shared_items, unassigned=unassigned, coverage=coverage,
                         validation_status='passed' if not unassigned else 'conditions_pending', solver=result,
                         solve_status='budget_exhausted_with_solution' if result['exhausted'] and selected else 'timeout_no_solution' if result['exhausted'] else 'completed' if selected else 'no_feasible_candidates',
                         optimality_scope='generated_candidates' if result['proven'] and selected else 'verified_feasible' if selected else 'undetermined')
        if not any([r['id'] for r in c['routes']] == [r['id'] for r in selected] for c in candidates):
            candidates.append(candidate)
    primary_exhausted=candidates[0]['solver']['exhausted']
    # Later objective passes may time out or recover a better feasible incumbent.
    # Never replace a verified solution with an empty result from another pass.
    candidates.sort(key=lambda c:planning_solver.score(c['routes'],objective))
    best = candidates[0]
    solve_status=('budget_exhausted_with_solution' if best['routes'] else 'timeout_no_solution') if primary_exhausted else best['solve_status']
    optimality=best['optimality_scope'] if not primary_exhausted and best['objective']==objective else ('verified_feasible' if best['routes'] else 'undetermined')
    pid = 'PLAN-' + uuid.uuid4().hex[:16]
    assumptions = ['候选为有限枚举；最优性只适用于本次已生成且已校验候选。', '未知道路、未确认价格及缺少包装/班次证据不会按零值参与可行方案。']
    if any('SIM-' in str(r.get('stops',{})) or 'SIM-' in str(r.get('commitment',{})) for r in routes):
        assumptions.append('SIM 承运商逐段时间、班次和服务依据为受控合成演练；真实道路仅限明确标注 Valhalla truck 的结果。')
    if trimmed:
        assumptions.append('候选生成达到 500 条上限；已记录裁剪，未证明全局最优。')
    plan = dict(id=pid, plan_id=pid, version=1, state='candidates_ready', created_at=now(), order_ids=ids,
                planning_scope=scope, objective=objective, input_hash=checked['input_hash'],required_collections=required_collections,
                candidates=candidates, draft_routes=routes, routes=best['routes'], unassigned=best['unassigned'],
                coverage=best['coverage'], cost_items=best['cost_items'], total_minor=best['total_minor'], currency=best['currency'],
                solve_status=solve_status, validation_status=best['validation_status'], optimality_scope=optimality,
                assumptions=assumptions, locks=locks, lock_conflicts=lock_conflicts,road_errors=road_errors, precheck=checked, metrics=dict(candidate_count=len(routes), feasible_count=len(feasible), seconds=time.monotonic()-started),
                pending_legs=[{'order_id':o['id'], 'leg':'second_leg'} for o in orders if scope == 'authorized_stage' and o.get('route') == 'C2' and not o.get('second_leg')])
    return {'plan':plan_save(db, plan) if publish else plan}


def save_result(db, plan, user):
    if snapshot(db, plan['order_ids'], user)[1] != plan['input_hash']:
        raise ApiError(409, 'STALE_INPUT：计算期间业务输入已变化')
    return plan_save(db, plan)


def validate_adoption(db,plan,candidate,user):
    """Check persisted structure before any draft is saved, including old plans."""
    expected=set(plan['order_ids']);covered=[]
    def reject(message):raise ApiError(409,'PLAN_STRUCTURE_CONFLICT：'+message)
    routes=candidate.get('routes')
    if not isinstance(routes,list) or not routes:reject('方案没有可落地的路线或正式承诺')
    for route in routes:
        ids=route.get('order_ids')
        if not isinstance(ids,list) or not ids or len(ids)!=len(set(ids)) or not set(ids)<=expected:reject('候选订单范围不合法')
        covered.extend(ids)
        orders=[get_order(db,oid,user) for oid in ids]
        if route.get('order_versions')!={o['id']:o['version'] for o in orders}:reject('路线关联版本不一致')
        chain=route.get('segments')
        if chain is not None:
            if (not isinstance(chain,list) or len(chain)!=2 or len(ids)!=1 or
                orders[0].get('route') not in {'C1','C2'} or orders[0]['status']!='ready' or
                plan.get('planning_scope')!='delivery_complete' or not orders[0].get('second_leg')):
                reject('仅完整经站履约允许服务端组合首程和未来二程')
            if route.get('future_segments')!=chain[1:]:reject('未来运段与完整履约链不一致')
            for segment in chain:
                if not isinstance(segment,dict) or segment.get('order_ids')!=ids or segment.get('order_versions')!=route['order_versions']:
                    reject('组合运段遗漏或额外包含订单')
                if 'segments' in segment or segment.get('future_segments'):reject('不允许嵌套组合运段')
            facts=ROUTE_INPUT_FIELDS-{'id','version','notes','cost_scenario','rate_card_id'}
            if any(route.get(k)!=chain[0].get(k) for k in facts):reject('顶层已核路线与实际落地首段不一致')
        else:
            if route.get('future_segments'):reject('非组合路线不能附加未来运段')
            chain=[route]
            if plan.get('planning_scope')=='delivery_complete' and any(o.get('route') in {'C1','C2'} and o['status']=='ready' and not o.get('pickup') for o in orders):
                reject('完整履约不能遗漏未来二程')
        for segment in chain:
            kind=segment.get('kind')
            if kind:
                if kind not in {'supplier_commitment','pickup'}:reject('内部路线类型无效')
                promises=commitment_candidates(db,orders,plan.get('planning_scope','delivery_complete'))
                if not any(p['kind']==kind and p['order_ids']==segment['order_ids'] and p['commitment']==segment.get('commitment') for p in promises):
                    reject('承诺类型或授权来源与实际业务不一致')
        if lock_issues(route,plan.get('locks') or {}):reject('持久候选不满足原人工锁定，请重新计算')
    if len(covered)!=len(set(covered)) or set(covered)!=expected:reject('实际落地范围必须完整覆盖计划且不得重复')


def adopt(db, pid, body, user):
    key = required(body, 'idempotency_key', 200)
    request_hash = digest(body)
    action = 'adopt:' + pid
    prior = db.execute('SELECT digest,result FROM dispatch_idempotency WHERE actor=? AND action=? AND key=?', (user['username'], action, key)).fetchone()
    if prior:
        if prior['digest'] != request_hash:
            raise ApiError(409, 'IDEMPOTENCY_CONFLICT：同一幂等键对应不同请求')
        return json.loads(prior['result'])
    plan = plan_get(db, pid)
    if type(body.get('version')) is not int or plan['version'] != body['version']:
        raise ApiError(409, 'STALE_INPUT：计划版本已变')
    if snapshot(db, plan['order_ids'], user)[1] != plan['input_hash']:
        raise ApiError(409, 'STALE_INPUT：订单、库存、价格、资源或占用已变化，请重新计算')
    candidate = next((c for c in plan['candidates'] if c['id'] == body.get('candidate_id')), None)
    if not candidate:
        raise ApiError(404, '候选方案不存在')
    if candidate['unassigned'] or candidate['validation_status'] != 'passed':
        raise ApiError(422, '方案尚未完整覆盖当前范围或有待补条件，不能采用为可执行草案')
    validate_adoption(db,plan,candidate,user)
    import operations
    # Savepoint guarantees no partial batch even when a caller catches ApiError.
    db.execute('SAVEPOINT adopt_plan')
    try:
        saved = []
        commitments=[]
        for route in candidate['routes']:
            current_route=route.get('segments',[route])[0]
            if current_route.get('kind') in {'supplier_commitment','pickup'}:
                commitments.append(current_route)
                continue
            body_route = {k:v for k,v in current_route.items() if k not in {'id', 'version'}}
            result = operations.save_route(db, body_route, user, bool(route.get('first_leg_ids')))['route']
            if result['check_result']['issues']:
                raise ApiError(409, '复核失败：' + '；'.join(result['check_result']['issues']))
            saved.append(result)
        plan.update(state='adopted_pending_release', version=plan['version']+1, adopted_candidate=candidate['id'], adopted_routes=[r['id'] for r in saved],
                    future_segments=[segment for route in candidate['routes'] for segment in route.get('future_segments',[])],adopted_commitments=commitments)
        plan_save(db, plan)
        result = {'plan':plan, 'routes':saved}
        db.execute('INSERT INTO dispatch_idempotency VALUES(?,?,?,?,?)', (user['username'], action, key, request_hash, encode(result)))
        db.execute('RELEASE SAVEPOINT adopt_plan')
        return result
    except Exception:
        db.execute('ROLLBACK TO SAVEPOINT adopt_plan')
        db.execute('RELEASE SAVEPOINT adopt_plan')
        raise


def save_profile(db, kind, body, user):
    if kind not in {'order', 'resource', 'rate_card', 'stage', 'technical', 'commitment'}:
        raise ApiError(400, '资料类型无效')
    rid = required(body, 'id', 100)
    if kind in {'order','stage','technical','commitment'}:
        o = get_order(db, rid, user)
        if body.get('order_version') != o['version']:
            raise ApiError(409, '订单版本已变')
    elif kind == 'resource' and not db.execute('SELECT 1 FROM registry WHERE id=?', (rid,)).fetchone():
        raise ApiError(404, '资源不存在')
    data = body.get('data')
    if not isinstance(data, dict) or len(encode(data)) > 100000:
        raise ApiError(400, '排线事实须为大小受限的 JSON 对象')
    data = copy.deepcopy(data)
    if kind in {'stage','technical','commitment'}:
        if user['role'] not in {'admin','procurement'}:
            raise ApiError(403,'阶段价格和保管条件须由采购确认')
        data['scope_snapshot'] = review.scope_snapshot(o)
    if kind == 'rate_card':
        if user['role'] not in {'admin','procurement'}:
            raise ApiError(403,'价卡须由采购确认')
        for field in ('base_minor','minimum_minor','per_order_minor','per_unit_minor','per_stop_minor','day_minor'):
            if type(data.get(field)) is not int or not 0 <= data[field] <= 100000000:
                raise ApiError(422,'价卡金额必须逐项明确填整数最小货币单位；缺项不视为 0：'+field)
        if data.get('currency') != 'USD' or data.get('replaces_full_price') is not True or not isinstance(data.get('order_versions'),dict):
            raise ApiError(422,'价卡须明确 USD、完整替代范围和订单版本')
        required(data,'supplier_id');required(data,'valid_from');required(data,'valid_until')
    data.update(evidence=required(body, 'evidence', 500), updated_at=now(), updated_by=user['username'])
    if kind in {'order','stage','technical','commitment'}:
        data['order_version'] = body['order_version']
    prior = db.execute('SELECT version FROM dispatch_profiles WHERE kind=? AND id=?', (kind, rid)).fetchone()
    if prior and body.get('version') != prior[0]:
        raise ApiError(409, '排线事实已变化')
    version = prior[0]+1 if prior else 1
    db.execute('INSERT OR REPLACE INTO dispatch_profiles VALUES(?,?,?,?)', (kind, rid, version, encode(data)))
    return {'profile':dict(data, id=rid, kind=kind, version=version)}


def handle(db, method, path, body, user):
    if user['role'] not in READ:
        raise ApiError(403, '此岗位不可查看或修改统一计划')
    init_db(db)
    base = '/api/ops/plans'
    if method == 'GET':
        if path == base:
            return {'plans':[json.loads(r[0]) for r in db.execute('SELECT data FROM dispatch_plans ORDER BY rowid DESC LIMIT 50')]}
        if path.startswith(base + '/'):
            return {'plan':plan_get(db, path[len(base)+1:])}
    if method == 'POST' and path in {base + '/profiles/rate_card',base + '/profiles/stage',base + '/profiles/technical',base + '/profiles/commitment'}:
        return save_profile(db, path.rsplit('/',1)[-1], body, user)
    if method != 'POST' or user['role'] not in {'admin', 'dispatch'}:
        raise ApiError(403, '仅调度可修改统一计划')
    if path == base + '/precheck':
        return precheck(db, body, user)
    if path == base + '/optimize':
        return optimize(db, body, user)
    if path.endswith('/adopt'):
        return adopt(db, path.split('/')[-2], body, user)
    if '/profiles/' in path:
        return save_profile(db, path.rsplit('/', 1)[-1], body, user)
    raise ApiError(404, '统一计划接口不存在')
