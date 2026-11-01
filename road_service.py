"""Operator-managed truck matrix, constrained stop sequencing and route geometry."""
import json
import hashlib
import copy
import math
import os
import threading
import time
import uuid
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import routing
from core import ApiError, encode, get_order, now

POOL = threading.BoundedSemaphore(4)
MATRIX_CACHE = {}
CACHE_GUARD = threading.Lock()
MAX_BYTES = 3 * 1024 * 1024
TRUCK = {"length":"truck_length_m", "width":"truck_width_m", "height":"truck_height_m",
         "weight":"gross_t", "axle_load":"axle_load_t"}


@lru_cache(maxsize=1)
def hawaiian_islands():
    # Shared offline state outlines, used only to distinguish physically separate islands.
    raw = (Path(__file__).parent / os.environ.get('HH_APP_VERSION', 'v13') / "vendor/us-states.js").read_text(encoding="utf8")
    states = json.loads(raw.split("=", 1)[1].strip().rstrip(";"))
    geometry = next(f["geometry"] for f in states["features"] if f["properties"]["abbr"] == "HI")
    return [polygon[0] for polygon in geometry["coordinates"]]


def island_at(point):
    x, y = point["lon"], point["lat"]
    for index, ring in enumerate(hawaiian_islands()):
        inside = False
        a, b = ring[-1]
        for c, d in ring:
            if (b > y) != (d > y) and x < a + (c - a) * (y - b) / (d - b):
                inside = not inside
            a, b = c, d
        if inside:
            return index
    return None


def continuous_us_road(points):
    hawaii = [p for p in points if 18.7 < p["lat"] < 22.5 and -160.7 < p["lon"] < -154.6]
    if hawaii:
        islands = {island_at(p) for p in hawaii}
        if len(hawaii) != len(points) or len(islands - {None}) > 1:
            raise ApiError(422, "无连续公路，跨岛或跨海运输须拆段安排海运及两端交接")
        if None in islands:
            raise ApiError(422, "近岸入口所属岛待核，确认具体公路入口后重算")
    alaska = any(p["lat"] > 51 and (p["lon"] < -129.7 or p["lon"] > 170) for p in points)
    if alaska and any(24 < p["lat"] < 49.6 and -125 < p["lon"] < -66 for p in points):
        raise ApiError(422, "阿拉斯加与本土48州间须跨加拿大或海运，须单独核准跨境及多式联运")


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
    recovering = set()
    if body.get('recovery_id'):
        import recovery
        recovering = recovery.validate_road_input(db, body, user)
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
    policy = body.get('return_policy', 'open')
    if policy not in {'open', 'origin'}:
        raise ApiError(422, '回程策略须为 open 或 origin；指定车场须另建经核实运段')
    if policy == 'origin':
        vroom_vehicle['end_index'] = 0
        vroom_vehicle['time_window'][1] = shift[1]
    points, jobs = [stop_point(depot)], []
    resources = {item["id"]:item["version"] for item in (depot,vehicle,crew)}
    for i,o in enumerate(orders,1):
        f = facts[o["id"]]
        via = o["route"] in ("C1","C2")
        to_station = via and o["status"] == "ready"
        origin = o.get("station_name") if via and not to_station else o.get("warehouse")
        if o.get("pickup") or (o.get("procurement_mode") in ("ltl","platform") and o["status"] != "at_station"):
            raise ApiError(422, f"{o['id']} 只记录约定交接点，无自有车组站序")
        if o['id'] not in recovering and (origin != depot["name"] or o["status"] not in ("ready","at_station")):
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


def cached_matrix(options, points, resources, departure):
    """Direction, entrance versions, truck and data revision are all part of the key.

    Current adapter deliberately requests static matrices. Departure is a cache scope,
    not a claim that this deployment has live or historic traffic observations.
    """
    context = dict(options=options, points=points, resources=resources,
                   departure=departure, mode='static',
                   graph=os.environ.get('HH_ROAD_DATA_DATE', ''),
                   endpoint=os.environ.get('HH_VALHALLA_URL', ''))
    key = hashlib.sha256(encode(context).encode()).hexdigest()
    with CACHE_GUARD:
        cached = MATRIX_CACHE.get(key)
        if cached and time.monotonic() - cached[0] < 900:
            return copy.deepcopy(cached[1]), True
    raw = post('HH_VALHALLA_URL', '/sources_to_targets',
               {**options, 'sources': points, 'targets': points})
    matrix(raw, len(points))  # Never cache an unreachable/null or malformed matrix.
    with CACHE_GUARD:
        if len(MATRIX_CACHE) >= 128:
            MATRIX_CACHE.pop(next(iter(MATRIX_CACHE)))
        MATRIX_CACHE[key] = (time.monotonic(), copy.deepcopy(raw))
    return raw, False


def validate_sequence(order, jobs, durations, vehicle):
    """Fixed stop order has the same hard windows and return shift as solving mode."""
    by_id = {job['id']: job for job in jobs}
    clock = vehicle['time_window'][0]
    previous = 0
    timeline = []
    for index in order:
        job = by_id[index]
        arrival = clock + durations[previous][index]
        windows = [w for w in job['time_windows'] if max(arrival, w[0]) <= w[1]]
        if not windows:
            raise ApiError(422, f'站序 {index} 时间窗冲突，不能按该站序签发')
        begin = max(arrival, min(w[0] for w in windows))
        clock = begin + job['service']
        timeline.append(dict(job_id=index, arrival_utc=arrival, start_utc=begin, departure_utc=clock))
        previous = index
    if 'end_index' in vehicle:
        clock += durations[previous][vehicle['end_index']]
    if clock > vehicle['time_window'][1]:
        raise ApiError(422, '包含末站作业及回程后超出车辆班次')
    return timeline, clock


def compute(db, body, user):
    ids, points, jobs, vehicle, truck, resources = inputs(db, body, user)
    continuous_us_road(points)
    if not configured():
        raise ApiError(503, "货车路网未配置，请联系运营方")
    # Release the read snapshot before external IO. Saving verifies all versions again.
    db.commit()
    if not POOL.acquire(blocking=False):
        raise ApiError(429, "规划服务正忙，草案可保留后重试")
    try:
        options = {"costing":"truck","costing_options":{"truck":truck},"units":"kilometers"}
        raw, cache_hit = cached_matrix(options, points, resources, vehicle['time_window'][0])
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
        timeline, finish = validate_sequence(order, jobs, durations, vehicle)
        returning = body.get('return_policy') == 'origin'
        itinerary = [points[i] for i in [0,*order,*([0] if returning else [])]]
        data = post("HH_VALHALLA_URL","/route",{**options,"locations":itinerary,
                                              "format":"osrm","shape_format":"geojson","directions_type":"none"})
        if data.get("code") != "Ok" or not data.get("routes"):
            raise ApiError(502,"货车路网返回的逐段路线不完整")
        route = data["routes"][0]
        if len(route["legs"]) != len(order) + int(returning):
            raise ApiError(502,"货车路网返回的逐段路线不完整")
        shape = route["geometry"]
        pairs = shape["coordinates"] if shape.get("type") == "LineString" else []
        if not 2 <= len(pairs) <= 40000 or any(len(p)<2 or not routing.point(dict(lng=p[0],lat=p[1])) for p in pairs):
            raise ApiError(502,"道路几何无效或过长，请核查服务或拆分路线")
        geometry = [[lat,lon] for lon,lat,*_ in pairs]
        legs = [{"distance":positive(leg["distance"],"逐段道路里程",50000000,0),
                 "duration":positive(leg["duration"],"逐段行驶时长",7*86400,0)} for leg in route["legs"]]
        # Recheck final route durations: geometry may use different departure conditions.
        final_matrix = copy.deepcopy(durations)
        for a, b, leg in zip([0,*order], [*order,*([0] if returning else [])], legs):
            final_matrix[a][b] = math.ceil(leg['duration'])
        timeline, finish = validate_sequence(order, jobs, final_matrix, vehicle)
    except (TypeError,AttributeError,KeyError,IndexError,ValueError,OverflowError):
        raise ApiError(502,"道路或排程服务格式不兼容，请核查部署版本") from None
    finally:
        POOL.release()
    ordered = [ids[i-1] for i in order]
    result = {"id":uuid.uuid4().hex, "source":"Valhalla truck / VROOM", "timestamp":now(),
              "order_ids":ordered, "unassigned":unassigned, "legs":legs, "geometry":geometry,
              "truck":truck, "resources":resources,
              "graph_date":data.get('coverage_region',{}).get('data_date',os.environ.get("HH_ROAD_DATA_DATE","")),
              "coverage_region":data.get('coverage_region'),
              "coverage":data.get('coverage_region',{}).get('id',os.environ.get("HH_ROAD_COVERAGE",""))}
    result.update(return_policy=body.get('return_policy','open'), return_leg=legs[-1] if returning else None,
                  timeline=timeline, finish_utc=finish, traffic_basis='static', matrix_cache_hit=cache_hit,
                  total_distance_m=sum(x['distance'] for x in legs),
                  total_driving_seconds=sum(x['duration'] for x in legs))
    # Only a server-generated plan can supply road evidence to a saved dispatch.
    signature = routing.road_signature(body,ordered,resources)
    db.execute("BEGIN IMMEDIATE")
    db.execute("DELETE FROM road_plans WHERE created<?",(int(time.time())-86400,))
    db.execute("INSERT INTO road_plans VALUES(?,?,?,?)",(result["id"],int(time.time()),signature,encode(result)))
    return {"road":result}


def candidates(db, body, user):
    """Generate bounded, genuine VROOM candidates for multiple vehicle/date inputs.

    These are alternatives. The plan master must select globally compatible routes.
    Every input is validated against actual orders, inventory and physical resources.
    """
    if user['role'] not in {'admin','dispatch'}:
        raise ApiError(403, '仅调度可生成道路候选')
    requests = body.get('route_requests')
    if not isinstance(requests, list) or not 1 <= len(requests) <= 48:
        raise ApiError(422, '每次应提交 1 至 48 组车次候选')
    results, errors = [], []
    start = time.monotonic()
    budget = positive(body.get('budget_seconds', 120), '计算预算', 600, 1)
    for index, request in enumerate(requests):
        if time.monotonic() - start >= budget:
            errors.append({'index':index, 'code':'BUDGET_EXHAUSTED', 'message':'剩余候选尚未计算'})
            break
        try:
            results.append({'index':index, **compute(db, request, user)})
            db.commit()
        except ApiError as exc:
            db.rollback()
            errors.append({'index':index, 'code':'ROAD_UNAVAILABLE' if exc.status==503 else 'ROUTE_INVALID',
                           'status':exc.status, 'message':str(exc)})
    return {'candidates':results, 'errors':errors, 'elapsed_seconds':time.monotonic()-start,
            'scope':'vehicle_date_candidates', 'global_selection_required':True,
            'solve_status':'budget_exhausted' if len(results)+len(errors)<len(requests) else 'completed'}
