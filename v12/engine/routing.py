"""Route feasibility and release. All checks use the caller's SQLite write transaction."""
import hashlib
import time
import json
import math
from datetime import datetime, timedelta, timezone
from core import ApiError, encode, now, ZONES, string
from routing_zones import zone


def local_utc(value, name):
    """Require a unique wall clock time; offsets, when present, must agree with the site zone."""
    try:
        if name not in ZONES:
            return None
        wall = datetime.fromisoformat(value)
        tz = zone(name)
        if wall.tzinfo:
            utc = wall.astimezone(timezone.utc)
            return utc if utc.astimezone(tz).replace(tzinfo=None) == wall.replace(tzinfo=None) else None
        candidates = {wall.replace(tzinfo=tz, fold=fold).astimezone(timezone.utc) for fold in (0, 1)}
        matching = [t for t in candidates if t.astimezone(tz).replace(tzinfo=None) == wall]
        return matching[0] if len(matching) == 1 else None
    except (ValueError, TypeError, OverflowError, KeyError):
        return None


def bounded(value, minimum, maximum):
    try:
        n = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return n if not isinstance(value, bool) and math.isfinite(n) and minimum <= n <= maximum else None


def point(o):
    lat, lng = bounded(o.get("lat"), -85, 85), bounded(o.get("lng"), -180, 180)
    return lat is not None and lng is not None and (lat != 0 or lng != 0)


def resource(db, kind, rid):
    row = db.execute("SELECT * FROM registry WHERE type=? AND id=?", (kind, rid)).fetchone()
    return {**json.loads(row["data"]), "id":row["id"], "version":row["version"]} if row else {}


def origin_resource(db, name):
    row = db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?", (name,)).fetchone()
    return resource(db, "warehouse", row[0]) if row else {}


def facts(body, ids):
    checks, stops = body.get("checks", {}), body.get("stops", {})
    if not isinstance(checks, dict) or not isinstance(stops, dict):
        raise ApiError(400, "排线核验字段格式无效")
    def obj(source, keys):
        if not isinstance(source, dict):
            raise ApiError(400, "逐站核验字段格式无效")
        return {key: string(str(source[key]), key, 300) for key in keys if key in source and source[key] is not None}
    return (obj(checks, ("shift_start","shift_end","warehouse_start","warehouse_end","return_min","handling_ref","scope_ref","driver")),
            {oid:obj(stops.get(oid,{}), ("travel","admission","service","unload","height","length_cm","width_cm","kg","road_ref","dock_ref","package_ref","required_people","required_tools","requires_lift","merge_after","merge_ref","from_id","station_id","site_end","finish_by","window_start","window_end","timezone")) for oid in ids})


def road_signature(body, ids, resources):
    checks, stops = facts(body, ids)
    # Measured times and predecessor IDs are written from the stored calculation.
    for stop in stops.values():
        for key in ("travel","from_id","road_ref"):
            stop.pop(key,None)
    knobs = {k:str(body.get(k) or "") for k in ("warehouse","date","start_time","timezone","crew_id","resource_id","executor_id")}
    knobs["service_minutes"] = float(body.get("service_minutes") or 45)
    versions = [body.get("order_versions",{}).get(oid) for oid in ids]
    payload = json.dumps([ids,versions,knobs,checks,stops,resources],sort_keys=True,ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def attach_road(db, route, road_id):
    if not isinstance(road_id,str):
        raise ApiError(409,"缺少服务端路线编号，请重算")
    row = db.execute("SELECT * FROM road_plans WHERE id=?", (road_id,)).fetchone()
    if not row or row["created"] < time.time()-3600:
        raise ApiError(409,"道路结果已过期，请重算")
    road = json.loads(row["data"])
    versions = {}
    for rid in road["resources"]:
        record = db.execute("SELECT version FROM registry WHERE id=?", (rid,)).fetchone()
        versions[rid] = record[0] if record else None
    if row["signature"] != road_signature(route,route["order_ids"],versions):
        raise ApiError(409,"车型、车组、站点、时刻或票据已变，请重算")
    previous = route["warehouse_id"]
    for oid,leg in zip(route["order_ids"],road["legs"]):
        route["stops"][oid].update(from_id=previous,travel=str(math.ceil(leg["duration"]/60)),road_ref=road_id)
        previous = oid
    route["road"] = road


def contracted_resources(db,order,route,vehicle,crew,day):
    """A leg-specific mandate or rental may temporarily authorize another owner's asset."""
    executor=route.get("executor_id")
    if not executor:return False
    mismatches=[k for k,r in (("hire_ref",vehicle),("mandate_ref",crew)) if r.get("executor_id")!=executor]
    if not mismatches:return True
    import gate
    leg=2 if order["status"]=="at_station" or order.get("station_pending") else 1
    g=gate.active(db,order["id"],leg)
    if not g or g["state"] not in ("accepted","issued","released"):return False
    l=gate.obj(db.execute("SELECT * FROM gate_links WHERE id=?",(g.get("link_id"),)).fetchone())
    if not l or l["version"]!=g.get("link_version") or not (l.get("starts_on","")<=day<=min(l.get("valid_until",""),l.get("insurance_until",""))):return False
    return (l["executor_id"]==executor and l["crew_id"]==crew.get("id") and l["vehicle_id"]==vehicle.get("id")
            and l["driver"]==route["checks"].get("driver") and all(l.get(k) for k in mismatches))


def names(value):
    return {s.strip().casefold() for s in str(value or "").replace("，",",").replace("、",",").split(",") if s.strip()}


def can_share_stop(before,after,facts):
    if not before or not after:
        return False
    keys=("customer","contact","address","state","city","zip","endpoint","window_start","window_end","timezone")
    if not all(str(before.get(k) or "").strip() and before[k]==after.get(k) for k in keys):
        return False
    first,second=facts.get(before["id"],{}),facts.get(after["id"],{})
    return (all(before.get(k)==after.get(k) for k in ("original_window_start","original_window_end","original_timezone"))
            and point(before) and (before["lat"],before["lng"])==(after.get("lat"),after.get("lng"))
            and first.get("dock_ref") and first["dock_ref"]==second.get("dock_ref")
            and first.get("site_end","")==second.get("site_end","")
            and not first.get("station_id") and not second.get("station_id"))


def check_route(db, route, orders, skip_orders=()):
    issues, timeline = [], []
    if route.get("road_basis") not in ("carrier","valhalla_truck"):
        issues.append("当前线路仅可存草案；须重新规划货车道路或登记有承运方逐段书面核实的运单")
    origin = origin_resource(db, route["warehouse"])
    vehicle = resource(db, "vehicle", route["resource_id"])
    crew = resource(db, "crew", route["crew_id"])
    versions = {r["id"]:r["version"] for r in (origin, vehicle, crew) if r}
    if not point(origin):
        issues.append("补录已核出发仓及装卸口坐标")
    if not vehicle or not crew:
        issues.append("指定车辆和执行班组")
    checks = route["checks"]
    for key, label in (("handling_ref","尾板、固定、人员及工具核验依据"),("scope_ref","作业范围及授权依据")):
        if not checks.get(key):
            issues.append("补录"+label)
    driver = checks.get("driver","")
    if not db.execute("SELECT 1 FROM users WHERE username=? AND role='driver' AND active=1",(driver,)).fetchone():
        issues.append("指定有效司机账号")
    day, tz = route["date"], route["timezone"]
    if tz!=origin.get("timezone"):issues.append("发车时区与实际装卸仓不符")
    start = local_utc(day+"T"+route["start_time"], tz)
    if not start:
        issues.append("发车时刻无效或夏令时重复/跳过，请核实时刻")
    def boundary(key):
        return local_utc(checks.get(key), tz)
    shift_start, shift_end = boundary("shift_start"), boundary("shift_end")
    wh_start, wh_end = boundary("warehouse_start"), boundary("warehouse_end")
    if not (start and wh_start and wh_end and wh_start <= start <= wh_end):
        issues.append("发车不在已核仓窗内")
    if not (crew.get("evidence") and crew.get("qualified_until","") >= day and crew.get("equipment") and vehicle.get("evidence") and vehicle.get("equipment")):
        issues.append("车组资质/设备证据缺失或过期，请到运力台账复核")
    cursor = start
    units = load = station_no = 0
    previous = origin.get("id","")
    coverage = names(crew.get("coverage"))
    for index,o in enumerate(orders):
        oid=o["id"]
        msg=lambda reason:issues.append(f"第 {index+1} 站 {reason}")
        if o.get("pickup"):
            msg("自提不得占用配送车次")
        transit_handoff = oid in route.get("first_leg_ids",[]) or route.get("first_leg") and o["route"] in ("C1","C2")
        s=route["stops"].get(oid,{})
        joined=bool(index and s.get("merge_after")==previous and s.get("merge_ref") and can_share_stop(orders[index-1],o,route["stops"]))
        if s.get("merge_after") and not joined:msg("同停确认失效，核对收货方、装卸点、原窗和相邻站序")
        if not joined:station_no+=1
        target=resource(db,"warehouse",s.get("station_id","")) if transit_handoff else o
        if transit_handoff and target:versions[target["id"]]=target["version"]
        if transit_handoff and s.get("timezone")!=target.get("timezone"):msg("接收站窗时区有误")
        target_zip=target.get("zip") or ""
        if transit_handoff and (not s.get("station_id") or s["station_id"]!=(o.get("station_mandate") or o.get("second_leg") or {}).get("station_id")):
            msg("首程实际接收站未与二程委托吻合")
        if not point(target) or target.get("location_precision")=="zip" or not s.get("dock_ref"):
            msg("交付装卸口待核；ZIP 代表点不能签发")
        if str(target_zip) not in coverage:
            msg("班组未确认此目的地覆盖")
        if not s.get("package_ref") or not joined and (not s.get("road_ref") or s.get("from_id")!=previous):
            msg("待承运方核实此段起点、卡车路时及包装版本")
        if not contracted_resources(db,o,route,vehicle,crew,day):
            msg("实际执行方与车辆／班组不符；须有本段有效租车或跨合同委派依据")
        people=bounded(s.get("required_people"),1,99)
        if people is None or people!=int(people) or people>(bounded(crew.get("headcount"),1,99) or 0):
            msg("执行人数未核或班组人数不足")
        needed=names(s.get("required_tools"))
        if not needed or not needed.issubset(names(crew.get("tools"))):
            msg("本段必需工具未落实到执行班组")
        previous=oid
        qty=int(o["quantity"])
        assets=db.execute("SELECT state,warehouse FROM assets WHERE order_id=?",(oid,)).fetchall()
        outstanding=[a for a in assets if a["state"]!="delivered"]
        if outstanding:qty=len(outstanding)
        units+=qty
        if oid not in skip_orders:
            station_leg=o["route"] in ("C1","C2") and not transit_handoff
            if o["status"]!=("at_station" if station_leg else "ready") or route["warehouse"]!=(o.get("station_name") if station_leg else o["warehouse"]):
                msg("实际持货点或可放行状态已变")
            if not outstanding or any(a["state"]!=("station" if station_leg else "reserved") or (not station_leg and a["warehouse"]!=route["warehouse"]) for a in outstanding):
                msg("库存锁或保管状态待核")
        kg,height=bounded(s.get("kg"),0.01,100000),bounded(s.get("height"),0.01,1000)
        if kg is None or height is None:
            msg("填写逐台已包装重量及高度")
        elif height>(bounded(vehicle.get("door_cm"),1,1000) or 0):
            msg("包装高度超过车辆净开口")
        if s.get("requires_lift") not in ("yes","no"):
            msg("请核实是否需要尾板")
        elif s.get("requires_lift")=="yes" and (kg is None or kg>(bounded(vehicle.get("lift_capacity_kg"),0,100000) or 0)):
            msg("尾板额定载重不足")
        load+=(kg or 0)*qty
        road,admit,svc,unload=(bounded(s.get(k),lo,1440) for k,lo in (("travel",0),("admission",0),("service",1),("unload",0)))
        if joined:road=admit=0
        if any(n is None for n in (road,admit,svc,unload)) or unload is not None and svc is not None and unload>svc:
            msg("逐段行车、准入、卸毕及作业分钟缺失或无效")
            cursor=None
        w=s if transit_handoff else o
        a,b=(local_utc(w.get(k),w.get("timezone")) for k in ("window_start","window_end"))
        # A separately evidenced property cutoff can narrow the contract, never extend it.
        if s.get("site_end"):
            cutoff=local_utc(s["site_end"], w.get("timezone"))
            b=min(b,cutoff) if b and cutoff else None
        if not a or not b or a>b:
            msg("原窗／作业地时区有缺项或夏令时歧义")
            cursor=None
        if cursor:
            arrive=cursor+timedelta(minutes=road)
            work=max(a,arrive+timedelta(minutes=admit))
            finish=work+timedelta(minutes=svc)
            late=max(0,math.ceil((work-b).total_seconds()/60))
            if late:msg(f"开工晚 {late} 分钟")
            if s.get("finish_by"):
                latest_finish=local_utc(s["finish_by"],w.get("timezone"))
                if not latest_finish or finish>latest_finish:msg("作业结束超过约定完工时刻或时刻无效")
            timeline.append(dict(id=oid,stop=station_no,shared_stop=joined,sns=o.get("sn",""),service_minutes=svc,arrival=arrive.isoformat(),start=work.isoformat(),unload=(work+timedelta(minutes=unload)).isoformat(),departure=finish.isoformat(),late=late,timezone=w["timezone"]))
            cursor=finish
    back=bounded(checks.get("return_min"),0,1440)
    if back is None:
        issues.append("回程分钟未核；开放线路须明确填 0")
    end=cursor+timedelta(minutes=back or 0) if cursor else None
    if not (shift_start and shift_end and start and end and shift_start<=start<end<=shift_end):
        issues.append("核对车组班次起止、最长工时及回程")
    if units>(bounded(vehicle.get("tie_slots"),0,999) or 0):issues.append("随车核定固定托位不足")
    if units>(bounded(vehicle.get("capacity_units"),1,999) or 0) or load>(bounded(vehicle.get("payload_kg"),1,100000) or 0):
        issues.append("超出车辆台数／载重或运力尚未核定")
    if start and end and vehicle and crew:
        bookings(db)
        clash=db.execute("""SELECT 1 FROM route_bookings WHERE cancelled='' AND start_utc<? AND end_utc>?
            AND (vehicle=? OR crew=? OR driver=?) AND NOT (route_id=? AND revision=?) LIMIT 1""",
            (end.isoformat(),start.isoformat(),vehicle["id"],crew["id"],driver,route.get("id",""),route.get("version",0))).fetchone()
        if clash:issues.append("车辆、司机或班组时段已由另一车次占用")
    return dict(issues=list(dict.fromkeys(issues)),stop_count=station_no,timeline=timeline,resource_versions=versions,start_utc=start.isoformat() if start else None,end_utc=end.isoformat() if end else None)


def bookings(db):
    db.execute("""CREATE TABLE IF NOT EXISTS route_bookings(
        oid TEXT NOT NULL REFERENCES orders(id),leg INTEGER NOT NULL,route_id TEXT NOT NULL,revision INTEGER NOT NULL,
        vehicle TEXT NOT NULL,crew TEXT NOT NULL,driver TEXT NOT NULL,start_utc TEXT NOT NULL,end_utc TEXT NOT NULL,
        cancelled TEXT NOT NULL DEFAULT '',PRIMARY KEY(oid,leg,route_id,revision))""")
    db.execute("CREATE INDEX IF NOT EXISTS route_slot_range ON route_bookings(cancelled,end_utc,start_utc)")


def cancel_booking(db,oid):
    """Release this order's current stop only; keep the first leg and other stops' reservations."""
    bookings(db)
    row=db.execute("SELECT json_extract(data,'$.release_route.id'), json_extract(data,'$.release_route.route_version') FROM orders WHERE id=?",(oid,)).fetchone()
    if row:db.execute("UPDATE route_bookings SET cancelled=? WHERE oid=? AND route_id=? AND revision=? AND cancelled=''",(now(),oid,row[0],row[1]))


def signed_orders(db, rid, version):
    return {r[0] for r in db.execute("SELECT id FROM orders WHERE json_extract(data,'$.release_route.id')=? AND json_extract(data,'$.release_route.route_version')=?", (rid,version))}


def release(db, order, body, origin, user=None):
    import operations
    from core import get_order
    actor=user or {"role":"dispatch","username":"dispatch"}
    # Platform pickup papers are a distinct product. folder.assert_commission performs its version and evidence checks.
    if order.get("procurement_mode") in {"platform","ltl"} and order["status"]!="at_station" and order.get("platform_instruction") and not body.get("route_id") and not body.get("direct_plan"):
        order.pop("release_route",None)
        return
    rid,version=body.get("route_id"),body.get("route_version")
    if not rid and not version:
        direct=body.get("direct_plan")
        if not isinstance(direct,dict):
            raise ApiError(409,"请先在地图核验本票车辆、班组和时窗，再在 F04 选择批次")
        data={**direct,"id":None,"warehouse":origin,"order_ids":[order["id"]],"order_versions":{order["id"]:order["version"]}}
        route=operations.save_route(db,data,actor,first_leg=order["route"] in ("C1","C2") and order["status"]=="ready")["route"]
        rid,version=route["id"],route["version"]
    row=db.execute("SELECT data,version FROM registry WHERE type='route' AND id=?",(rid,)).fetchone()
    if not row or type(version) is not int or row["version"]!=version:
        raise ApiError(409,"地图批次版本已变，请刷新后重排")
    route={**json.loads(row["data"]),"id":rid,"version":version}
    if order["id"] not in route["order_ids"] or route["warehouse"]!=origin or not route.get("check_result"):
        raise ApiError(409,"批次未覆盖本单或为待核旧版，请从实际持货点重新保存草案")
    signed=signed_orders(db,rid,version)
    orders=[order if i==order["id"] else get_order(db,i,actor) for i in route["order_ids"]]
    if any(o["id"] not in signed and o["version"]!=route["order_versions"][o["id"]] for o in orders):
        raise ApiError(409,"批次关联订单已变，请重排欠交设备")
    if route.get("road_basis")=="valhalla_truck":
        attach_road(db,route,(route.get("road") or {}).get("id"))
        import road_service
        road_service.check_live()
    result=check_route(db,route,orders,signed)
    if result["issues"]:raise ApiError(409,"不能签发："+"；".join(result["issues"]))
    if result["resource_versions"]!=route["check_result"]["resource_versions"] or order.get("driver")!=route["checks"].get("driver"):
        raise ApiError(409,"运力版本或司机已变，请重新核验并保存草案")
    leg=2 if order["status"]=="at_station" else 1
    db.execute("""INSERT INTO route_bookings(oid,leg,route_id,revision,vehicle,crew,driver,start_utc,end_utc)
        VALUES(?,?,?,?,?,?,?,?,?)""",(order["id"],leg,rid,version,route["resource_id"],route["crew_id"],order["driver"],result["start_utc"],result["end_utc"]))
    order["release_route"]={k:route[k] for k in ("id","name","date","warehouse","resource_id","crew_id","executor_id","start_time","timezone")}
    order["release_route"].update(leg_id=2 if order["status"]=="at_station" else 1,route_version=version,stop=next(t["stop"] for t in result["timeline"] if t["id"]==order["id"]),stops=result["stop_count"],driver=order["driver"],issued_at=now(),start_utc=result["start_utc"],end_utc=result["end_utc"],resource_versions=result["resource_versions"])


def validate_departure(db, order):
    if order.get("procurement_mode") in {"platform","ltl"} and order["status"]!="at_station" and order.get("platform_instruction") and not order.get("release_route"):
        return
    release=order.get("release_route") or {}
    if not release.get("resource_versions"):
        raise ApiError(409,"历史签发待核，请撤回并按现有实物及车组重新签发")
    for rid,version in release["resource_versions"].items():
        row=db.execute("SELECT version FROM registry WHERE id=?",(rid,)).fetchone()
        if not row or row[0]!=version:
            raise ApiError(409,"签发后运力／仓点已变，请撤回、复核并重新签发")
def example_plan(db, order, user, executor=None, driver="driver", crew_coverage="75201,76010"):
    """Synthetic DFW acceptance fixture. No public HTTP endpoint exposes this helper."""
    import operations
    executor=executor or (order.get("selected_quote") or {}).get("executor_id") or "DFW-SIM-EXEC-B"
    def provision(kind, name, **values):
        row=db.execute("SELECT id FROM registry WHERE type=? AND json_extract(data,'$.name')=?", (kind,name)).fetchone()
        return row[0] if row else operations.save_resource(db, dict(type=kind,name=name,**values),user)["resource"]["id"]
    origin=order.get("station_name") if order.get("status")=="at_station" else order["warehouse"]
    place=origin_resource(db,origin)
    if not place:raise ApiError(409,"先登记演练起仓")
    vehicle=provision("vehicle",executor+" · SIM-TX01",capacity_units=6,door_cm=235,payload_kg=1600,equipment="模拟尾板与固定件",lift_capacity_kg=850,tie_slots=6,evidence="SIM-VEH-01",executor_id=executor)
    crew=provision("crew",executor+" · SIM-"+crew_coverage,coverage=crew_coverage,qualified_until="2036-12-31",headcount=2,tools="pallet_jack,straps,dolly",equipment="模拟双人/托盘车",evidence="SIM-CREW-01",executor_id=executor)
    oid,day=order["id"],order["window_start"][:10]
    return dict(name="DFW · "+(order.get("crm_ref") or oid),warehouse=origin,date=day,start_time="08:00",timezone=place["timezone"],
                resource_id=vehicle,crew_id=crew,executor_id=executor,order_ids=[oid],order_versions={oid:order["version"]},road_basis="carrier",
                checks=dict(driver=driver,scope_ref="SIM-SCOPE",handling_ref="SIM-TOOL",shift_start=day+"T07:00",shift_end=day+"T18:00",warehouse_start=day+"T07:30",warehouse_end=day+"T14:00",return_min=25),
                stops={oid:dict(from_id=place["id"],road_ref="SIM-TRUCK",dock_ref="SIM-DOCK-01",package_ref="SIM-PACK-01",height=193,kg=180,required_people=2,required_tools="dolly,straps",requires_lift="yes",travel=30,admission=10,unload=10,service=40)})

def capability_sites(db,user):
    """Display the registered origin and precise ZIP eligibility, never a service radius."""
    if user["role"] not in {"admin","dispatch","procurement","finance"}:
        raise ApiError(403,"此岗位不可查地图采购能力")
    import gate
    gate.schema(db)
    registry={r["id"]:{**json.loads(r["data"]),"type":r["type"]} for r in db.execute("SELECT * FROM registry WHERE type IN ('warehouse','supplier','crew')")}
    day=now()[:10]
    sites=[];seen=set()
    def row(kind,data,version):
        rid=data.get("supplier_id" if kind=="supplier" else "crew_id","")
        owner=registry.get(rid,{})
        wh=registry.get(data.get("warehouse_id"),{})
        known=point(wh)
        status={"Y":"已核范围","C":"有条件","U":"待核","N":"排除"}.get(data.get("decision"),"登记关系")
        if kind=="supplier" and status=="已核范围" and owner.get("qualification")=="S2":status="限定试单"
        if data.get("starts_on","")>day:status="尚未生效"
        if data.get("valid_until","")<day or data.get("insurance_until","")<day:status="过期／未核" if data.get("decision","Y") in ("Y","C") else status
        if kind=="crew" and data.get("zip") not in names(owner.get("coverage")):status="班组覆盖不符"
        seen.add(rid)
        sites.append(dict(kind=kind,id=rid,name=owner.get("name",rid),warehouse_id=data.get("warehouse_id"),warehouse=wh.get("name","起仓未登记"),located=known,lat=wh.get("lat") if known else None,lng=wh.get("lng") if known else None,
                          zip=data.get("zip",""),product=data.get("product",""),model=data.get("model",""),action=data.get("action") or data.get("level"),status=status,version=version,until=data.get("valid_until",""),evidence=data.get("evidence","")))
    for dbrow in db.execute("SELECT version,data FROM capability"):row("supplier",json.loads(dbrow["data"]),dbrow["version"])
    for dbrow in db.execute("SELECT version,data FROM gate_links"):row("crew",json.loads(dbrow["data"]),dbrow["version"])
    for rid,r in registry.items():
        if r["type"] in ("supplier","crew") and rid not in seen:
            sites.append(dict(kind=r["type"],id=rid,name=r["name"],warehouse="待关联实际作业仓",located=False,status="未登记范围",zip="",product="",model="",action="",until="",evidence=""))
    return {"sites":sites}
