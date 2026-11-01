"""Shared network register, procurement evidence and versioned dispatch plans."""
import json
import math
import re
import uuid
from decimal import Decimal
import lifecycle
import review
import folder
from datetime import date, datetime
from core import ApiError, ZONES, create_order, encode, get_order, now, required, string
from core import check_version, save as save_order

COSTS = ("origin_cost","station_cost","delivery_cost","special_cost","other_cost")

EDITORS = {
    "warehouse": {"warehouse", "dispatch"}, "crew": {"dispatch"}, "vehicle": {"dispatch"},
    "supplier": {"dispatch"}, "inbound": {"warehouse"}, "quote": {"dispatch", "finance"}
}
FIELDS = {
    "warehouse": ("address","lat","lng","timezone","evidence","notes"),
    "vehicle": ("capacity_units","door_cm","payload_kg","equipment","evidence","notes"),
    "crew": ("capacity_units","coverage","equipment","evidence","notes"),
    "supplier": ("address","coverage","model","ability","qualification","evidence","notes"),
    "inbound": ("stage","warehouse","batch","serials","custodian","evidence","notes"),
    "quote": ("order_id","carrier","path","scope","comparison_ref","amount","valid_until","evidence","notes")+COSTS,
}
REQUIRED = {
    "warehouse": ("address","timezone"), "vehicle": ("capacity_units",), "crew": ("coverage",),
    "supplier": ("address","ability","qualification"), "inbound": ("batch","warehouse","stage","custodian","evidence"),
    "quote": ("order_id","carrier","path","scope","valid_until","evidence"),
}
def init_db(db):
    lifecycle.init_db(db)
    review.init_db(db)
    folder.init_db(db)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS registry(id TEXT PRIMARY KEY,type TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS registry_log(id INTEGER PRIMARY KEY,item TEXT NOT NULL,version INTEGER NOT NULL,actor TEXT NOT NULL,ts TEXT NOT NULL,snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v8_links(old_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id));
    CREATE UNIQUE INDEX IF NOT EXISTS unique_warehouse_name ON registry(json_extract(data,'$.name')) WHERE type='warehouse';
    """)

def visible_type(kind,user):
    if user["role"]=="driver":
        return kind=="warehouse"
    if kind in ("quote","supplier"):
        return user["role"] in ("admin","dispatch","finance")
    if kind in ("inbound","route"):
        return user["role"] in ("admin","warehouse","dispatch","finance","sales")
    return True

def record(row):
    return {**json.loads(row["data"]), "id":row["id"], "type":row["type"], "version":row["version"]}

def list_records(db, routes, user):
    pred="=" if routes else "<>"
    found=[record(r) for r in db.execute(f"SELECT * FROM registry WHERE type {pred} 'route' ORDER BY rowid DESC") if visible_type(r["type"],user)]
    if user["role"]=="driver":
        return [{k:v for k,v in x.items() if k in {"id","name","type","lat","lng"}} for x in found]
    return found

def save(db,kind,data,body,user):
    rid=body.get("id")
    if rid:
        row=db.execute("SELECT * FROM registry WHERE id=? AND type=?",(string(rid,"id",100),kind)).fetchone()
        if not row: raise ApiError(404,"记录不存在")
        if type(body.get("version")) is not int or row["version"]!=body["version"]:
            raise ApiError(409,"同事已修改此记录，请刷新后重新核对")
        v=row["version"]+1
        db.execute("UPDATE registry SET data=?,version=? WHERE id=?",(encode(data),v,rid))
    else:
        rid=kind[:3].upper()+"-"+uuid.uuid4().hex[:12].upper()
        v=1
        db.execute("INSERT INTO registry VALUES(?,?,?,?)",(rid,kind,v,encode(data)))
    db.execute("INSERT INTO registry_log(item,version,actor,ts,snapshot) VALUES(?,?,?,?,?)",(rid,v,user["username"],now(),encode(data)))
    return {**data,"id":rid,"type":kind,"version":v}

def number(value,label,minimum,maximum):
    try: n=float(value)
    except (TypeError, ValueError, OverflowError): n=math.nan
    if isinstance(value,bool) or not math.isfinite(n) or not minimum<=n<=maximum:
        raise ApiError(400,label+" 超出允许范围")
    return n

def iso_date(value):
    try: return date.fromisoformat(value).isoformat()
    except (TypeError,ValueError): raise ApiError(400,"请填写有效日期")

def save_resource(db,body,user):
    kind=required(body,"type",24)
    if kind not in FIELDS:raise ApiError(400,"资源类型无效")
    if user["role"] not in EDITORS[kind]|{"admin"}:raise ApiError(403,"本岗位不能修改此类记录")
    data={"name":required(body,"name",140)}
    for k in FIELDS[kind]:
        v=body.get(k)
        if v in ("",None):
            if k in REQUIRED[kind]:raise ApiError(400,"缺少字段 "+k)
            continue
        limits={"lat":(-90,90),"lng":(-180,180),"capacity_units":(1,999),"door_cm":(1,1000),"payload_kg":(1,100000),"amount":(0,100000000)}
        if k in COSTS: data[k]=number(v,k,0,100000000)
        else: data[k]=number(v,k,*limits[k]) if k in limits else string(v,k)
    if "capacity_units" in data and not data["capacity_units"].is_integer():raise ApiError(400,"载台数必须是整数")
    if ("lat" in data)!=("lng" in data):raise ApiError(400,"经纬度须成对提供")
    if kind=="warehouse":
        if data["timezone"] not in ZONES:raise ApiError(400,"仓库时区无效")
        old=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(data['name'],)).fetchone()
        if old and old[0]!=body.get("id"):raise ApiError(409,"仓库名称已存在")
        if body.get("id"):
            old=db.execute("SELECT json_extract(data,'$.name') FROM registry WHERE type='warehouse' AND id=?",(body['id'],)).fetchone()
            if old and old[0]!=data["name"]:raise ApiError(400,"已登记的仓名作为订单关联键，请保留原名")
    if kind=="quote":
        get_order(db,data["order_id"],user)
        if data["path"] not in {"A","B","C1","C2"}:raise ApiError(400,"报价路径无效")
        iso_date(data["valid_until"])
        if all(k in data for k in COSTS):
            parts=[Decimal(str(data[k])) for k in COSTS]
            if any(p!=p.quantize(Decimal(".01")) for p in parts) or ("amount" in data and sum(parts)!=Decimal(str(data["amount"]))):
                raise ApiError(400,"五个费用行合计须与全价一致，USD 最多两位小数")
            data["amount"]=float(sum(parts))
            data["pricing_status"]="itemized"
        elif any(k in data for k in COSTS) or "amount" not in data:
            data["pricing_status"]="incomplete"
        else:data["pricing_status"]="total_only"
    if kind=="inbound" and data["stage"] not in {"S01","S02","S03","S04"}:raise ApiError(400,"海运节点无效")
    if kind=="supplier" and data["qualification"] not in {"S0","S1","S2","S3","SX"}:raise ApiError(400,"供应商准入状态无效")
    return {"resource":save(db,kind,data,body,user)}

def save_route(db,body,user):
    if user["role"] not in {"admin","dispatch"}:raise ApiError(403,"仅调度可保存排线")
    ids=body.get("order_ids")
    if not isinstance(ids,list) or not 1<=len(ids)<=60 or not all(type(x) is str for x in ids) or len(set(ids))!=len(ids):
        raise ApiError(400,"路线须包含 1–60 个不重复订单")
    name=required(body,"name",140)
    warehouse=required(body,"warehouse",140)
    orders=[get_order(db,i,user) for i in ids]
    if body.get("order_versions")!={o["id"]:o["version"] for o in orders}:
        raise ApiError(409,"排线期间订单版本已变更，请刷新并重新核对收货窗口")
    def at_origin(o):
        if o.get("lat") is None or o.get("lng") is None or o.get("pickup"):
            return False
        if o["route"] in ("C1","C2"):
            return o["status"]=="at_station" and o.get("station_name")==warehouse
        return o["status"]=="ready" and o["warehouse"]==warehouse
    if not all(at_origin(o) for o in orders):
        raise ApiError(409,"请核对定位、实际起点及作业段。经站单只可从已签收站点排第二程")
    origin=db.execute("SELECT data FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(warehouse,)).fetchone()
    if not origin or any(json.loads(origin[0]).get(k) is None for k in ("lat","lng")):
        raise ApiError(400,"出发仓点须先登记经纬度")
    start=string(body.get("start_time","08:00"),"发车时刻",5)
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d",start):raise ApiError(400,"发车时刻无效")
    zone=body.get("timezone","America/Chicago")
    if zone not in ZONES:raise ApiError(400,"请核对出发时区")
    minutes=number(body.get("service_minutes",45),"逐站作业分钟",1,720)
    if not minutes.is_integer():raise ApiError(400,"逐站作业分钟须为整数")
    rid=string(body.get("resource_id") or "","运力编号",100)
    if rid:
        row=db.execute("SELECT * FROM registry WHERE id=? AND type IN ('vehicle','crew')",(rid,)).fetchone()
        if not row:raise ApiError(400,"运力记录不存在")
        cap=record(row).get("capacity_units")
        if cap and sum(o["quantity"] for o in orders)>cap:raise ApiError(400,"所选订单台数超过车组核定载台数")
    basis=body.get("road_basis","estimate")
    if basis not in ("estimate","demo_cache","private_osrm"):raise ApiError(400,"里程来源无效")
    data={"name":name,"warehouse":warehouse,"date":iso_date(body.get("date")),"order_ids":ids,"road_basis":basis,
          "order_versions":{o["id"]:o["version"] for o in orders},"resource_id":rid,"start_time":start,
          "timezone":zone,"service_minutes":minutes,"notes":string(body.get("notes") or "","备注")}
    return {"route":save(db,"route",data,body,user)}

def import_v8(db,body,user):
    if user["role"]!="admin":raise ApiError(403,"迁入旧单需管理员")
    old_id=required(body,"old_id",100)
    prior=db.execute("SELECT order_id FROM v8_links WHERE old_id=?",(old_id,)).fetchone()
    if prior:raise ApiError(409,"旧单已迁入 "+prior[0])
    fields=body.get("order")
    if not isinstance(fields,dict):raise ApiError(400,"旧订单格式无效")
    order=create_order(db,fields,user)
    db.execute("INSERT INTO v8_links VALUES(?,?)",(old_id,order["id"]))
    return {"order":order}

def award_quote(db,body,user):
    if user["role"] not in {"admin","dispatch"}:raise ApiError(403,"仅主管或调度可确认中选委托")
    row=db.execute("SELECT * FROM registry WHERE id=? AND type='quote'",(required(body,"id",100),)).fetchone()
    if not row:raise ApiError(404,"报价不存在")
    q=record(row)
    if q["version"]!=body.get("quote_version"):raise ApiError(409,"报价已更新，请重新核对")
    o=get_order(db,q["order_id"],user)
    check_version(o,body)
    if o["status"] not in ("new","ready") or o.get("pickup"):raise ApiError(409,"此票当前不可选择运输委托")
    if q["path"]!=o["route"]:raise ApiError(400,"中选路径须与订单一致，请先核对分单")
    if q["valid_until"]<now()[:10]:raise ApiError(400,"报价已过期，请重新询价")
    if not q.get("comparison_ref") or not all(k in q for k in COSTS):raise ApiError(400,"中选前请补齐询价版本和五行全程费用")
    approval=required(body,"approval_ref",300)
    o["selected_quote"]={k:q[k] for k in ("id","version","carrier","amount","path","evidence","scope","valid_until","comparison_ref")+COSTS}
    o["selected_quote"].update(ref=q["evidence"],approval_ref=approval)
    return {"order":save_order(db,o,user,"award_quote","中选 "+q["name"]+" · "+str(q["amount"])+" USD · "+approval)}

def handle(db,method,path,body,user):
    if path.startswith("/api/ops/folder/"):
        return folder.handle(db,method,path,body,user)
    if path.startswith("/api/review/"):
        return review.handle(db,method,path,body,user)
    if path.startswith("/api/lifecycle/"):
        return lifecycle.handle(db,method,path,body,user)
    if method=="GET" and path in ("/api/ops/resources","/api/ops/routes"):
        routes=path.endswith("/routes")
        return {"routes" if routes else "resources":list_records(db,routes,user)}
    if method=="POST":
        if path=="/api/ops/award-quote":return award_quote(db,body,user)
        if path=="/api/ops/resources":return save_resource(db,body,user)
        if path=="/api/ops/routes":return save_route(db,body,user)
        if path=="/api/ops/import-v8":return import_v8(db,body,user)
    if method=="GET" and path.startswith("/api/ops/history/"):
        rid=path.rsplit("/",1)[1]
        row=db.execute("SELECT type FROM registry WHERE id=?",(rid,)).fetchone()
        if not row or not visible_type(row[0],user) or user["role"]=="driver":raise ApiError(404,"记录不存在")
        return {"history":[dict(r) for r in db.execute("SELECT version,actor,ts,snapshot FROM registry_log WHERE item=? ORDER BY version DESC",(rid,))]}
    return None

def seed_demo(db):
    user={"role":"admin","username":"admin"}
    for name,addr,lat,lng,zone in [
        ("Dallas","Dallas, TX · 城市级演练仓点",32.83,-96.91,"America/Chicago"),
        ("New Jersey","Newark, NJ · 城市级演练仓点",40.735,-74.172,"America/New_York"),
        ("Fife","Fife, WA · 城市级演练仓点",47.237,-122.36,"America/Los_Angeles")]:
        save_resource(db,dict(type="warehouse",name=name,address=addr,lat=lat,lng=lng,timezone=zone,notes="演练坐标，不代表实际库址。"),user)
    save_resource(db,dict(type="vehicle",name="DFW · 演练尾板车 01",capacity_units=6,door_cm=235,payload_kg=1600,equipment="演练双人车组、尾板及固定件",evidence="DEMO-VEH-01"),user)
    save_resource(db,dict(type="supplier",name="Metro · 演练服务商",address="Dallas 演练点",coverage="75201、76010",model="M01、M02",ability="T2 专业末端",qualification="S2",evidence="DEMO-SUP-01",notes="虚构的限定试单示例"),user)
    save_resource(db,dict(type="inbound",name="DFW 演练收货批",batch="DEMO-ASN-01",warehouse="Dallas",stage="S04",custodian="演练仓管",evidence="DEMO-GRN-01",serials="DEMO-1-1、DEMO-1-2"),user)
    ticket=db.execute("SELECT id,data FROM orders WHERE json_extract(data,'$.city')='Dallas' AND status='ready' LIMIT 1").fetchone()
    if ticket:
        expiry=json.loads(ticket["data"])["window_end"][:10]
        for kind,path,amount,ref in [("现行车组","B",565,"Q-A"),("备选经站统包","C1",610,"Q-B")]:
            save_resource(db,dict(type="quote",name=kind+" · 虚构报价",carrier=kind,path=path,order_id=ticket["id"],scope="同仓两台 M01，原窗口到指定一层机位，包含提货、搬运、签交",comparison_ref="DEMO-RFQ-01",amount=amount,origin_cost=110,station_cost=0 if path=="B" else 45,delivery_cost=420,special_cost=35,other_cost=0,valid_until=expiry,evidence="DEMO-"+ref,notes="演练数字，不作为对客报价"),user)

def upgrade_demo_quotes(db):
    """Populate cost lines only on the original, unedited synthetic samples."""
    for row in db.execute("SELECT * FROM registry WHERE type='quote' AND version=1").fetchall():
        q=record(row)
        fixture={"DEMO-Q-A":("B",565,0),"DEMO-Q-B":("C1",610,45)}.get(q.get("evidence"))
        if not fixture or q.get("comparison_ref")!="DEMO-RFQ-01" or not q["name"].endswith(" · 虚构报价"):
            continue
        if any(k in q for k in COSTS) or (q["path"],q.get("amount"))!=fixture[:2]:continue
        q.update(origin_cost=110,station_cost=fixture[2],delivery_cost=420,special_cost=35,other_cost=0)
        save_resource(db,q,{"role":"admin","username":"演练样例升级"})

