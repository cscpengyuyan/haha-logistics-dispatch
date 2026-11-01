"""Operator-managed truck matrix, constrained stop sequencing and route geometry."""
import json
import math
import os
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import routing
from core import ApiError, encode, get_order, now

POOL = threading.BoundedSemaphore(4)
MAX_BYTES = 3 * 1024 * 1024
TRUCK = {"length":"truck_length_m", "width":"truck_width_m", "height":"truck_height_m",
         "weight":"gross_t", "axle_load":"axle_load_t"}


def configured():
    return all(os.environ.get(key) for key in ("HH_VALHALLA_URL", "HH_VROOM_URL"))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def check_live():
    if not configured():
        raise ApiError(503,"货车路网尚未配置，不可据此确认派车")
    base = os.environ["HH_VALHALLA_URL"].rstrip("/")
    try:
        with build_opener(NoRedirect()).open(base+"/status",timeout=2) as res:
            status = json.loads(res.read(65536))
        if not isinstance(status,dict) or not status.get("version"):
            raise ValueError()
    except (OSError,URLError,ValueError):
        raise ApiError(503,"货车路网当前不可用，草案已保留，请恢复后重试") from None


def post(env, path, payload):
    base = os.environ.get(env, "").rstrip("/")
    location = urlsplit(base)
    if location.scheme not in ("http", "https") or not location.hostname or location.query or location.fragment:
        raise ApiError(503, "运营方尚未配置货车路网与排程服务")
    request = Request(base + path, data=encode(payload).encode(), headers={"Content-Type":"application/json"})
    label = "货车路网" if env == "HH_VALHALLA_URL" else "VROOM 排程"
    try:
        with build_opener(NoRedirect()).open(request, timeout=12) as res:
            raw = res.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ApiError(422, label + "响应过大，请拆分批次")
        return json.loads(raw)
    except HTTPError as exc:
        raise ApiError(503 if exc.code >= 500 or exc.code == 429 else 422,
                       f"{label}返回 HTTP {exc.code}，请核实覆盖范围、服务配额后重试") from None
    except (URLError, OSError, ValueError):
        raise ApiError(503, label + "不可达、超时或返回内容无效，请重试") from None


def positive(value, label, maximum, minimum=0.01):
    n = routing.bounded(value, minimum, maximum)
    if n is None:
        raise ApiError(422, "请核对" + label)
    return n


def epoch(value, zone, label):
    stamp = routing.local_utc(value, zone)
    if stamp is None:
        raise ApiError(422, "请核对" + label + "和当地时区")
    return int(stamp.timestamp())


def stop_point(item):
    if not routing.point(item) or not item.get("address"):
        raise ApiError(422, "请补实际仓址或停靠入口与经纬度")
    return {"lat":float(item["lat"]), "lon":float(item["lng"]), "search_cutoff":200}


def inputs(db, body, user):
    if user["role"] not in {"admin", "dispatch"}:
        raise ApiError(403, "仅调度可规划货车路线")
    ids = body.get("order_ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 24 or not all(isinstance(i,str) for i in ids) or len(set(ids)) != len(ids):
        raise ApiError(400, "请勾选 1 至 24 个不同订单")
    orders = [get_order(db, oid, user) for oid in ids]
    if body.get("order_versions") != {o["id"]:o["version"] for o in orders}:
        raise ApiError(409, "订单已变化，请刷新后重算")
    depot = routing.origin_resource(db, body.get("warehouse"))
    vehicle = routing.resource(db,"vehicle",body.get("resource_id"))
    crew = routing.resource(db,"crew",body.get("crew_id"))
    if not depot.get("evidence") or not vehicle or not crew:
        raise ApiError(422, "须选有装卸口凭据的出发仓、车辆和班组")
    truck = {k:positive(vehicle.get(v), f"车辆 {v}", 200) for k,v in TRUCK.items()}
    checks, facts = routing.facts(body, ids)
    zone = depot.get("timezone")
    if body.get("timezone") != zone:
        raise ApiError(422, "发车时区与出发仓不符")
    start = epoch(str(body.get("date")) + "T" + str(body.get("start_time")), zone, "发车时刻")
    shift = [epoch(checks.get(k),zone,"班次") for k in ("shift_start","shift_end")]
    if not shift[0] <= start < shift[1]:
        raise ApiError(422, "发车时刻不在班组当班时间内")
    end = shift[1] - math.ceil(60 * positive(checks.get("return_min"),"回程分钟，开放线路填 0",1440,0))
    if end <= start:
        raise ApiError(422,"回程占用超出班组当班时间")
    tools = routing.names(crew.get("tools"))
    skill_ids = {name:i+1 for i,name in enumerate(sorted(tools))}
    slots = int(min(positive(vehicle.get(k),"车辆台数与固定托位",999) for k in ("capacity_units","tie_slots")))
    capacity = [slots, math.floor(positive(vehicle.get("payload_kg"),"车辆净载重",100000))]
    usable_width = positive(vehicle.get("floor_width_cm"),"车厢净宽 cm",3000)
    door_width = positive(vehicle.get("door_width_cm"),"车门净宽 cm",3000)
    capacity.append(math.floor(positive(vehicle.get("floor_length_cm"),"车厢净长 cm",3000)))
    vroom_vehicle = {"id":1,"profile":"truck","start_index":0,"capacity":capacity,
                     "skills":list(skill_ids.values()),"time_window":[start,end]}
    points, jobs = [stop_point(depot)], []
    resources = {item["id"]:item["version"] for item in (depot,vehicle,crew)}
    for i,o in enumerate(orders,1):
        f = facts[o["id"]]
        via = o["route"] in ("C1","C2")
        to_station = via and o["status"] == "ready"
        origin = o.get("station_name") if via and not to_station else o.get("warehouse")
        if o.get("pickup") or (o.get("procurement_mode") in ("ltl","platform") and o["status"] != "at_station"):
            raise ApiError(422, f"{o['id']} 只记录约定交接点，无自有车组站序")
        if origin != depot["name"] or o["status"] not in ("ready","at_station"):
            raise ApiError(409, f"{o['id']} 的实际出发点或可调度状态已变")
        if to_station:
            station = (o.get("station_mandate") or {}).get("station_id") or (o.get("second_leg") or {}).get("station_id")
            target = routing.resource(db,"warehouse",station)
            if not target.get("evidence") or station != f.get("station_id"):
                raise ApiError(422, f"{o['id']} 待核专业站装卸口")
            resources[target["id"]] = target["version"]
        else:
            target = o
            if o.get("location_precision") != "dock" or not o.get("coordinate_ref"):
                raise ApiError(422, f"{o['id']} 待核实际入口，ZIP／街址不可排车")
        points.append(stop_point(target))
        window = f if to_station else o
        tz = target.get("timezone")
        service = math.ceil(60 * positive(f.get("service") or body.get("service_minutes"), "逐站作业分钟",1440))
        admit = math.ceil(60 * positive(f.get("admission",0),"停车及门禁分钟",1440,0))
        earliest = epoch(window.get("window_start"),tz,"收货窗起")
        latest = epoch(window.get("window_end"),tz,"收货窗止")
        if f.get("site_end"):
            latest = min(latest,epoch(f["site_end"],tz,"物业最晚开工"))
        if f.get("finish_by"):
            latest = min(latest,epoch(f["finish_by"],tz,"最晚完工")-service)
        if earliest > latest:
            raise ApiError(422, f"{o['id']} 预约窗不足以完成已购作业")
        kg = positive(f.get("kg"),"逐台包装重量",100000)
        height = positive(f.get("height"),"包装高度 cm",1000)
        qty = db.execute("SELECT COUNT(*) FROM assets WHERE order_id=? AND state<>'delivered'",(o["id"],)).fetchone()[0]
        if not qty:
            raise ApiError(422, f"{o['id']} 没有待交运 SN")
        required = routing.names(f.get("required_tools"))
        # An unavailable skill keeps the job in VROOM's unassigned pool.
        skills = {skill_ids.get(k,0) for k in required}
        # Reserve complete floor rows for each ticket; never mix custody or stack machines.
        length = positive(f.get("length_cm"),"打托后长度 cm",3000)
        width = positive(f.get("width_cm"),"打托后宽度 cm",3000)
        rows = math.floor(usable_width/width)
        if rows < 1 or width > door_width:
            skills.add(0)
        deck = math.ceil(length*math.ceil(qty/max(rows,1)))
        if (int(positive(f.get("required_people"), "所需人数",99)) > int(crew.get("headcount",0)) or
                height > float(vehicle.get("door_cm") or 0) or
                f.get("requires_lift") == "yes" and kg > float(vehicle.get("lift_capacity_kg") or 0) or
                str(target.get("zip","")) not in routing.names(crew.get("coverage"))):
            skills.add(0)
        jobs.append({"id":i,"location_index":i,"delivery":[qty,math.ceil(kg*qty),deck],"skills":sorted(skills),
                     "time_windows":[[earliest-admit,latest-admit]],"service":service+admit})
    return ids, points, jobs, vroom_vehicle, truck, resources


def matrix(data, count):
    rows = data["sources_to_targets"]
    if len(rows) != count or any(len(row) != count for row in rows):
        raise ApiError(502, "货车路网返回矩阵尺寸不符")
    return [[math.ceil(positive(cell.get("time"),"货车道路连通性",7*86400,0)) for cell in row] for row in rows]


def compute(db, body, user):
    ids, points, jobs, vehicle, truck, resources = inputs(db, body, user)
    if not configured():
        raise ApiError(503, "货车路网未配置，请联系运营方")
    # Release the read snapshot before external IO. Saving verifies all versions again.
    db.commit()
    if not POOL.acquire(blocking=False):
        raise ApiError(429, "规划服务正忙，草案可保留后重试")
    try:
        options = {"costing":"truck","costing_options":{"truck":truck},"units":"kilometers"}
        raw = post("HH_VALHALLA_URL","/sources_to_targets",{**options,"sources":points,"targets":points})
        durations = matrix(raw,len(points))
        solution = post("HH_VROOM_URL","/",{"jobs":jobs,"vehicles":[vehicle],
                        "matrices":{"truck":{"durations":durations}}})
        if solution.get("code") != 0:
            raise ApiError(422,"排程器未得到可行解，请检查车型和约窗")
        route_rows = solution.get("routes",[])
        order = [s["id"] for r in route_rows for s in r["steps"] if s["type"] == "job"]
        left = [s["id"] for s in solution.get("unassigned",[])]
        if len(route_rows)>1 or sorted(order+left) != list(range(1,len(points))):
            raise ApiError(502,"排程器返回不完整站序")
        unassigned = [ids[i-1] for i in left]
        if not order:
            raise ApiError(422,"无法分配：" + "、".join(unassigned) + "。核对车容、工具、覆盖 ZIP、班次及预约窗")
        if not body.get("optimize",True):
            if left:
                raise ApiError(422,"所选订单存在车容、技能或时间窗冲突，请先拆出未分配订单")
            order = list(range(1,len(points)))
        itinerary = [points[i] for i in [0,*order]]
        data = post("HH_VALHALLA_URL","/route",{**options,"locations":itinerary,
                                              "format":"osrm","shape_format":"geojson","directions_type":"none"})
        if data.get("code") != "Ok" or not data.get("routes"):
            raise ApiError(502,"货车路网返回的逐段路线不完整")
        route = data["routes"][0]
        if len(route["legs"]) != len(order):
            raise ApiError(502,"货车路网返回的逐段路线不完整")
        shape = route["geometry"]
        pairs = shape["coordinates"] if shape.get("type") == "LineString" else []
        if not 2 <= len(pairs) <= 40000 or any(len(p)<2 or not routing.point(dict(lng=p[0],lat=p[1])) for p in pairs):
            raise ApiError(502,"道路几何无效或过长，请核查服务或拆分路线")
        geometry = [[lat,lon] for lon,lat,*_ in pairs]
        legs = [{"distance":positive(leg["distance"],"逐段道路里程",50000000,0),
                 "duration":positive(leg["duration"],"逐段行驶时长",7*86400,0)} for leg in route["legs"]]
    except (TypeError,AttributeError,KeyError,IndexError,ValueError,OverflowError):
        raise ApiError(502,"道路或排程服务格式不兼容，请核查部署版本") from None
    finally:
        POOL.release()
    ordered = [ids[i-1] for i in order]
    result = {"id":uuid.uuid4().hex, "source":"Valhalla truck / VROOM", "timestamp":now(),
              "order_ids":ordered, "unassigned":unassigned, "legs":legs, "geometry":geometry,
              "truck":truck, "resources":resources}
    # Only a server-generated plan can supply road evidence to a saved dispatch.
    signature = routing.road_signature(body,ordered,resources)
    db.execute("BEGIN IMMEDIATE")
    db.execute("DELETE FROM road_plans WHERE created<?",(int(time.time())-86400,))
    db.execute("INSERT INTO road_plans VALUES(?,?,?,?)",(result["id"],int(time.time()),signature,encode(result)))
    return {"road":result}
