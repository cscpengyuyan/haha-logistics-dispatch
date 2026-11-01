"""Deterministic SIM200 inputs. Import goes through the real sales workbook APIs.

Only unstarted fictional resources are initialized; business completion is never seeded.
"""
import base64
import collections
import csv
import hashlib
import io
import json
from datetime import date, timedelta
import core, operations, sales, lifecycle

SEED = 20261101
START = '2026-11-01'
REGIONS = [
    ('DFW','Dallas','TX','75201',32.778,-96.806,'America/Chicago',120,10),
    ('Houston','Houston','TX','77002',29.7604,-95.3698,'America/Chicago',30,3),
    ('Los Angeles','Los Angeles','CA','90012',34.0522,-118.2437,'America/Los_Angeles',30,3),
    ('Atlanta','Atlanta','GA','30303',33.749,-84.388,'America/New_York',20,2),
]
CANCEL = {1,2,3,4,49,50,51,52}
OCEAN = list(range(15,49))+list(range(83,109))
AFTERCARE = set(range(53,73))
D_STOCK = set(range(5,15))|set(range(53,83))

def actor(role):
    return {'username':role,'role':role}

def generate(start=START):
    orders=[]
    offset=fleet_offset=0
    for region,city,state,zip_code,lat,lng,tz,count,fleet in REGIONS:
        for j in range(count):
            i=offset+j+1
            route='A' if i<=48 or i>188 else 'B' if i<=128 else 'C1' if i<=158 else 'C2'
            pickup=i>188
            day=(date.fromisoformat(start)+timedelta(days=j%14)).isoformat()
            vehicle=fleet_offset+(j//14)%fleet+1
            supplier=(vehicle-1)%12+1
            qty=2 if 79<=i<=118 else 3 if 119<=i<=128 else 1
            level='L1' if i<=60 or pickup else 'L2' if i<=108 else 'L3'
            o=dict(id=f'SIM200-{i:03}',crm_ref=f'SIM200-{i:03}',customer=f'SIM 客户 {i:03}',address=f'SIM {city} 演练路口 {i:03}',
                city=city,state=state,zip=zip_code,warehouse='SIM '+city,model='M01',quantity=qty,route=route,level=level,
                pickup=pickup,addon_l4=109<=i<=153,addon_l5=139<=i<=173,timezone=tz,window_start=day+'T09:00',window_end=day+'T17:00',
                endpoint='SIM 仓口授权交接' if pickup else {'L1':'SIM 月台交接区','L2':'SIM 一层入口门厅','L3':'SIM 室内约定机位'}[level],
                endpoint_ref=f'SIM-CONTRACT-{i:03}',contact='SIM 收货岗',delivery_actions='SIM 逐台卸货交接、按已购终点放置',
                site_note='SIM 现场核验，通道净宽 140cm、净高 240cm，已核人员工具',pack_version='SIM-M01-PALLET-v1',
                lat=lat+round((j%5)*0.002,4),lng=lng+round((j%7)*0.002,4),location_precision='dock',coordinate_ref='SIM 网格点；仓口核验为测试替身，未经真实路口核实',
                procurement_mode='platform' if route=='A' or route in ('C1','C2') else 'company',
                a_channel='amazon' if i in range(5,17) else 'terminal',notes='SIM 全部主体、型号参数、报价与证据为虚构演练。')
            meta=dict(region=region,vehicle_number=vehicle,supplier_number=supplier,existing_positioned=i in D_STOCK,
                expected_terminal='cancelled' if i in CANCEL else 'settled',aftercare=i in AFTERCARE,
                recovery=53<=i<=92,serials=[f'SIM-SN-{i:03}-{n:02}' for n in range(1,qty+1)],
                ocean_batch=OCEAN.index(i)//15+1 if i in OCEAN else None,
                endpoint='pickup' if pickup else level,seed=SEED)
            orders.append(dict(order=o,coverage=meta))
        offset+=count;fleet_offset+=fleet
    return orders

def validate(rows):
    os=[r['order'] for r in rows];ms=[r['coverage'] for r in rows]
    assert len(os)==len({o['id'] for o in os})==200
    assert {o['id'] for o in os}=={f'SIM200-{n:03}' for n in range(1,201)}
    assert collections.Counter('pickup' if o['pickup'] else o['route'] for o in os)==dict(A=48,B=80,C1=30,C2=30,pickup=12)
    assert collections.Counter(m['endpoint'] for m in ms)==dict(L1=60,L2=48,L3=80,pickup=12)
    assert collections.Counter(o['quantity'] for o in os)=={1:150,2:40,3:10}
    assert sum(o['addon_l4'] for o in os)==45 and sum(o['addon_l5'] for o in os)==35
    assert sum(o['addon_l4'] and o['addon_l5'] for o in os)==15
    assert sum(o['quantity'] for o in os)==260
    assert collections.Counter(o['route'] for o,m in zip(os,ms) if m['existing_positioned'])=={'A':10,'B':30}
    assert collections.Counter(m['region'] for m in ms)=={'DFW':120,'Houston':30,'Los Angeles':30,'Atlanta':20}
    assert sum(bool(m['ocean_batch']) for m in ms)==60
    for o,m in zip(os,ms):
        if m['expected_terminal']=='cancelled':
            assert o['quantity']==1 and not(o['addon_l4'] or o['addon_l5'] or m['existing_positioned'])
        if o['pickup'] or m['aftercare']: assert o['quantity']==1
    return dict(orders=200,transport_delivered=180,pickup_delivered=12,cancelled=8,demand_units=260,first_delivery_units=252,aftercare=20)

def sales_csv(rows):
    from sales_workbook import FIELDS
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=list(FIELDS));w.writeheader()
    for item in rows:
        o=item['order'];r={k:o.get(k,'') for k in FIELDS}
        r.update(site_id='SIM-SITE',line_id='1',sales_owner='sales',phone='+1 202 555 0100',fulfillment='授权自提' if o['pickup'] else '送货',
            window_type='硬窗',sms_consent='否',site_access='需专项勘查' if o['addon_l4'] else '标准通道',path_survey_ref='SIM-SURVEY',
            l4_purchased='是' if o['addon_l4'] else '否',l4_evidence='SIM-L4-CONTRACT' if o['addon_l4'] else '',
            l5_purchased='是' if o['addon_l5'] else '否',l5_evidence='SIM-L5-CONTRACT' if o['addon_l5'] else '',
            door_width_cm='140',door_height_cm='240',technical_ref='SIM-TECH',unload_ref='SIM-UNLOAD')
        w.writerow(r)
    return out.getvalue().encode('utf-8-sig')

def only_demo(db):
    mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
    if not mode or mode[0]!='demo':raise core.ApiError(403,'SIM200 仅可用于独立演练库')

def provision(db):
    only_demo(db)
    def resource(kind,name,role,**data):
        old=db.execute("SELECT * FROM registry WHERE type=? AND json_extract(data,'$.name')=?",(kind,name)).fetchone()
        return operations.record(old) if old else operations.save_resource(db,dict(type=kind,name=name,**data),actor(role))['resource']
    for role in core.ROLES:
        db.execute("INSERT OR IGNORE INTO users(username,name,role,passhash) VALUES(?,?,?,'!')",(role,'SIM '+role,role))
    places={}
    for region,city,state,zip_code,lat,lng,tz,count,fleet in REGIONS:
        places[city]=resource('warehouse','SIM '+city,'warehouse',address='SIM 网格点仓址（虚构，未核真实路口）',zip=zip_code,lat=lat,lng=lng,timezone=tz,evidence='SIM-WAREHOUSE-TEST-DOUBLE')
        places[city+' station']=resource('warehouse','SIM '+city+' 接站','warehouse',address='SIM 合作站（虚构）',zip=zip_code,lat=lat+0.003,lng=lng+0.003,timezone=tz,evidence='SIM-STATION')
    suppliers=[]
    for n in range(1,13):
        suppliers.append(resource('supplier',f'SIM 供应商 {n:02}','procurement',address='SIM 虚构营业点',coverage='75201,77002,90012,30303',model='M01',ability='T2,T3,T5',qualification='S3',evidence=f'SIM-SUPPLIER-{n:02}'))
    fleets=[]
    for n in range(1,19):
        sid=suppliers[(n-1)%12]['id']
        db.execute("INSERT OR IGNORE INTO users(username,name,role,passhash) VALUES(?,?,'driver','!')",(f'sim_driver_{n:02}',f'SIM 司机 {n:02}'))
        v=resource('vehicle',f'SIM 车辆 {n:02}','dispatch',capacity_units=3 if n%2 else 6,door_cm=240,door_width_cm=230,payload_kg=2000,
            floor_length_cm=650,floor_width_cm=240,truck_length_m=8,truck_width_m=2.5,truck_height_m=3.5,gross_t=10,axle_load_t=6,
            equipment='SIM 尾板固定件',lift_capacity_kg=850,tie_slots=6,executor_id=sid,evidence='SIM-VEHICLE')
        c=resource('crew',f'SIM 班组 {n:02}','dispatch',coverage='75201,77002,90012,30303',qualified_until='2036-12-31',headcount=3,
            tools='pallet_jack,straps,dolly,stair_climber',equipment='SIM 双人托盘车',executor_id=sid,evidence='SIM-CREW')
        fleets.append(dict(vehicle=v,crew=c,driver=f'sim_driver_{n:02}',supplier=suppliers[(n-1)%12]))
    for n in range(1,5):
        db.execute("INSERT OR IGNORE INTO users(username,name,role,passhash) VALUES(?,?,'service','!')",(f'sim_tech_{n}',f'SIM 独立技师 {n}'))
    return dict(places=places,suppliers=suppliers,fleets=fleets)

def import_orders(db,user,body=None):
    only_demo(db)
    if user['role']!='sales':raise core.ApiError(403,'请切换销售岗位导入 SIM200')
    rows=generate();expected=validate(rows)
    # Resource seeding is a separate fixture step, not a privilege override for order actions.
    provision(db)
    source=sales_csv(rows);payload=dict(filename='SIM200_sales.csv',base64=base64.b64encode(source).decode())
    report,_,_=sales.preview(db,payload,user)
    if report['errors']:raise core.ApiError(422,'; '.join(report['errors']))
    result=sales.confirm(db,dict(payload,token=report['token']),user)
    ids=list(result['tickets'].values())
    if set(ids)!={r['order']['id'] for r in rows}:raise core.ApiError(409,'SIM200 主订单 ID 不符')
    return dict(result,expected=expected,input_sha256=hashlib.sha256(source).hexdigest(),rows=report['rows'])

def summary(db,user):
    only_demo(db)
    if user['role'] not in {'sales','dispatch','finance','warehouse','admin','procurement','service'}:raise core.ApiError(403,'本岗位不可查看全批演练')
    rows=[dict(x) for x in db.execute("SELECT id,status,version FROM orders WHERE id GLOB 'SIM200-*' ORDER BY id")]
    states=dict(collections.Counter(r['status'] for r in rows))
    return dict(seed=SEED,orders=len(rows),states=states,rows=rows,expected=validate(generate()),
        scope='200 票合成业务演练；道路真实引擎覆盖与业务 API 验收分开记录',complete=len(rows)==200 and states=={'settled':192,'cancelled':8})

def prepare_orders(db,user):
    """Public dispatch handoff, preserving sales intake lineage and terminal records."""
    only_demo(db)
    if user['role']!='dispatch':raise core.ApiError(403,'请切换调度岗位接手 SIM200')
    results=[]
    for row in generate():
        oid=row['order']['id']
        exists=db.execute('SELECT status FROM orders WHERE id=?',(oid,)).fetchone()
        if not exists:continue
        if exists['status']!='intake':
            results.append(dict(id=oid,state='unchanged'));continue
        o=row['order']
        sales.handoff(db,dict(id=oid,version=core.get_order(db,oid,user)['version'],level=o['level']),user)
        fields={k:o[k] for k in ('route','lat','lng','location_precision','coordinate_ref','procurement_mode','pack_version','a_channel')}
        core.edit_order(db,oid,dict(fields,version=core.get_order(db,oid,user)['version']),user)
        results.append(dict(id=oid,state='prepared'))
    return dict(rows=results,prepared=sum(r['state']=='prepared' for r in results),note='已接手销售需求；库存、报价与签发仍须通过对应业务动作。')

def handle(db,method,path,body,user):
    if path=='/api/simulation/import' and method=='POST':return import_orders(db,user,body)
    if path=='/api/simulation/summary' and method=='GET':return summary(db,user)
    if path=='/api/simulation/prepare' and method=='POST':return prepare_orders(db,user)
    return None
