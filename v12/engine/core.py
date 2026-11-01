"""Order lifecycle and shared SQLite data. Mutating operations run inside one caller transaction."""
import base64
import binascii
import json
import math
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

ROLES = ("admin", "sales", "warehouse", "dispatch", "driver", "finance", "service")
ZONES = {"America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
         "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "America/Detroit",
         "America/Indiana/Indianapolis", "America/Boise", "America/Adak", "UTC"}
TEXT_FIELDS = {"customer", "address", "zip", "city", "state", "warehouse", "model", "level",
               "route", "endpoint", "contact", "timezone", "window_start", "window_end", "notes",
               "site_note", "delivery_actions", "exclusions", "crm_ref"}
FLAGS = {"addon_l4", "addon_l5", "pickup"}
FIELDS = TEXT_FIELDS | FLAGS | {"quantity", "lat", "lng"}
REQUIRED = {"customer", "address", "zip", "model", "endpoint", "warehouse"}
ACTIVE = {"new", "ready", "dispatched", "in_transit", "at_station", "last_mile", "delivered"}
FILE_CATEGORIES = {"pod", "release", "quote", "site", "service", "invoice", "other"}
MAX_FILE_BYTES = 5 * 1024 * 1024
CHECKS = ("leg", "stock", "package", "vehicle", "endpoint", "site",
          "authority", "window", "papers", "price", "fallback", "release")


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def core_schema(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
            role TEXT NOT NULL,passhash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS sessions(
            token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS orders(
            id TEXT PRIMARY KEY,version INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
            id INTEGER PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),ts TEXT NOT NULL,
            actor TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_order ON events(order_id,id);
        CREATE TABLE IF NOT EXISTS files(
            id INTEGER PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),name TEXT NOT NULL,
            category TEXT NOT NULL,mime TEXT NOT NULL,ts TEXT NOT NULL,actor TEXT NOT NULL,content BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS files_order ON files(order_id,id);
        CREATE TABLE IF NOT EXISTS sn_locks(sn TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id));
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    """)


def string(value, field, limit=2000):
    if not isinstance(value, str) or '\x00' in value or len(value.strip()) > limit:
        raise ApiError(400, f"字段 {field} 格式或长度错误")
    return value.strip()


def required(body, key, limit=2000):
    value = string(body.get(key, ""), key, limit)
    if not value:
        raise ApiError(400, f"缺少必填项 {key}")
    return value


def localtime(value, field):
    try:
        dt = datetime.strptime(value, "%Y-%m-%dT%H:%M")
        if dt.strftime("%Y-%m-%dT%H:%M") != value:
            raise ValueError()
    except (ValueError, TypeError):
        raise ApiError(400, f"{field} 请填写有效当地日期时间")
    return value


def windows(order, require=False):
    start, end = order.get("window_start"), order.get("window_end")
    if not start and not end and not require:
        return
    if not start or not end or localtime(start, "window_start") >= localtime(end, "window_end"):
        raise ApiError(400, "预约窗口应有明确的开始、结束时间，且结束时间在开始时间之后")


def normalize_input(data, body):
    extra = set(body) - FIELDS - {"version"}
    if extra:
        raise ApiError(400, "不支持的订单字段 " + ", ".join(sorted(extra)))
    for key in FIELDS & set(body):
        value = body[key]
        if key in TEXT_FIELDS:
            data[key] = string(value, key)
        elif key in FLAGS:
            if not isinstance(value, bool):
                raise ApiError(400, f"{key} 应为布尔值")
            data[key] = value
        elif key == "quantity":
            if isinstance(value, bool) or not re.fullmatch(r"[1-9][0-9]{0,2}", str(value)):
                raise ApiError(400, "台数必须为 1 至 999 的整数")
            data[key] = int(value)
        else:
            if value is None or value == "":
                data[key] = None
                continue
            try:
                number = float(value)
            except (ValueError, TypeError, OverflowError):
                number = math.nan
            limit = 90 if key == "lat" else 180
            if isinstance(value, bool) or not math.isfinite(number) or abs(number) > limit:
                raise ApiError(400, "经纬度超出范围")
            data[key] = number
    for key in REQUIRED:
        required(data, key)
    if "quantity" not in data:
        raise ApiError(400, "缺少设备数量")
    if (data.get("lat") is None) != (data.get("lng") is None):
        raise ApiError(400, "经纬度须成对提供")
    if not re.fullmatch(r"\d{5}(?:-\d{4})?", data["zip"], re.ASCII):
        raise ApiError(400, "美国邮编请填五位或 ZIP+4")
    if data["route"] not in {"A", "B", "C1", "C2"} or data["level"] not in {"L1", "L2", "L3"}:
        raise ApiError(400, "路径或服务层级不匹配")
    if data.get("pickup") and data["route"] != "A":
        raise ApiError(400, "仓内自提须使用 A 路径")
    if data.get("pickup") and data["level"] != "L1":
        raise ApiError(400, "仓内自提的合同终点为 L1 仓口交接")
    if data["route"] == "A" and (data["level"] == "L3" or data["addon_l4"]):
        raise ApiError(400, "机位或复杂搬运请按 B 或 C 路径确认专业承接方")
    if data["timezone"] not in ZONES:
        raise ApiError(400, "请选择有效美国当地时区")
    windows(data)


def event(db, oid, user, action, note):
    db.execute("INSERT INTO events(order_id,ts,actor,action,note) VALUES(?,?,?,?,?)",
               (oid, now(), user["username"], action, note))


def actions(order, role):
    status = order["status"]
    admin = role == "admin"
    available = ["note", "upload"] if status != "settled" else []
    if status == "new":
        if admin or role in {"sales", "dispatch"}:
            available.append("edit")
        if admin or role == "warehouse":
            available.append("ready")
    if status == "ready":
        if admin or role == "warehouse":
            available.append("unrelease")
        if order.get("pickup"):
            if admin or role == "warehouse":
                available.append("pickup")
        elif admin or role == "dispatch":
            available.append("dispatch")
    if status == "dispatched" and (admin or role in {"driver", "dispatch"}):
        available.append("depart")
    transfer = order.get("route") in {"C1", "C2"}
    if status == "in_transit" and transfer and (admin or role == "warehouse"):
        available.append("station_receive")
    if status == "at_station" and (admin or role in {"warehouse", "dispatch"}):
        available.append("station_release")
    if (status == "in_transit" and not transfer or status == "last_mile") and (admin or role == "driver"):
        available.append("deliver")
    if status in ACTIVE and role != "finance":
        available.append("exception")
    if status == "exception" and (admin or role in {"dispatch", "service"}):
        available.append("resolve")
    if status in {"ready","dispatched","in_transit","at_station","last_mile","exception"} and (admin or role == "dispatch"):
        available.append("revise_window")
    if status == "delivered":
        if order.get("addon_l5") and not order.get("result_ref") and (admin or role == "service"):
            available.append("service_complete")
        if (not order.get("addon_l5") or order.get("result_ref")) and (admin or role == "finance"):
            available.append("settle")
    return available


def encode(data):
    return json.dumps(data, ensure_ascii=False, allow_nan=False)


def create_order(db, body, user):
    if user["role"] not in {"admin", "dispatch", "sales"}:
        raise ApiError(403, "此岗位不能建单")
    timestamp = now()
    data = {"route": "B", "level": "L1", "timezone": "America/Chicago", "addon_l4": False,
            "addon_l5": False, "pickup": False, "lat": None, "lng": None,
            "owner": user["username"], "created_at": timestamp, "updated_at": timestamp}
    normalize_input(data, body)
    data["original_window_start"] = data.get("window_start", "")
    data["original_window_end"] = data.get("window_end", "")
    data["original_timezone"] = data["timezone"]
    oid = "HH-" + datetime.now(timezone.utc).strftime("%y%m%d") + "-" + secrets.token_hex(4).upper()
    db.execute("INSERT INTO orders VALUES(?,1,'new',?)", (oid, encode(data)))
    event(db, oid, user, "create", "创建订单 · " + data["endpoint"])
    return present({**data, "id": oid, "status": "new", "version": 1}, user)


def unpack(row):
    return {**json.loads(row["data"]), "id": row["id"], "status": row["status"], "version": row["version"]}


def get_order(db, oid, user):
    row = db.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
    if row is None:
        raise ApiError(404, "订单不存在")
    order = unpack(row)
    if user["role"] == "driver" and order.get("driver") != user["username"]:
        raise ApiError(404, "订单不存在")
    return order


def present(order, user):
    result = dict(order, allowed_actions=actions(order, user["role"]))
    if user["role"] == "driver":
        for key in ("approved_cost", "actual_cost", "invoice_ref", "notes", "change_cost",
                    "variance_cost", "variance_ref", "change_ref", "checks", "selected_quote"):
            result.pop(key, None)
    return result


def list_orders(db, user):
    if user["role"] == "driver":
        rows = db.execute("SELECT * FROM orders WHERE json_extract(data,'$.driver')=? ORDER BY rowid DESC", (user["username"],))
    else:
        rows = db.execute("SELECT * FROM orders ORDER BY rowid DESC")
    return [present(unpack(row), user) for row in rows]


def check_version(order, body):
    if type(body.get("version")) is not int or order["version"] != body["version"]:
        raise ApiError(409, "订单已更新或未提供版本，请刷新后重新核对")


def save(db, order, user, action, note):
    data = {k: v for k, v in order.items() if k not in {"id", "version", "status", "allowed_actions"}}
    data["updated_at"] = now()
    version = order["version"]
    changed = db.execute("UPDATE orders SET version=version+1,status=?,data=? WHERE id=? AND version=?",
                         (order["status"], encode(data), order["id"], version))
    if changed.rowcount != 1:
        raise ApiError(409, "订单已被其他同事更新")
    event(db, order["id"], user, action, note)
    return present(dict(data, id=order["id"], version=version+1, status=order["status"]), user)


def permission(order, user, action):
    if action not in actions(order, user["role"]):
        raise ApiError(403, "当前岗位或订单状态不允许此操作")


def edit_order(db, oid, body, user):
    order = get_order(db, oid, user)
    permission(order, user, "edit")
    check_version(order, body)
    old = dict(order)
    normalize_input(order, body)
    for field in ("window_start", "window_end"):
        if not order.get("original_" + field) and order.get(field):
            order["original_" + field] = order[field]
            order["original_timezone"] = order["timezone"]
    diff = {k: [old.get(k), order[k]] for k in body if k != "version" and old.get(k) != order.get(k)}
    if set(diff)-{"notes","crm_ref","contact"} and order.pop("selected_quote",None):
        diff["中选委托"]=["已选","变更范围后须复核"]
    return save(db, order, user, "edit", encode(diff))


def require_pod(db, oid):
    if not db.execute("SELECT 1 FROM files WHERE order_id=? AND category='pod'", (oid,)).fetchone():
        raise ApiError(400, "请先上传此订单的签收回单或交付照片（POD）")


def copy_fields(order, body, *keys):
    for key in keys:
        order[key] = required(body, key)


def assign_driver(db, order, body):
    copy_fields(order, body, "driver", "carrier", "dispatch_ref")
    if not db.execute("SELECT 1 FROM users WHERE username=? AND role='driver' AND active=1", (order["driver"],)).fetchone():
        raise ApiError(400, "请选择已启用的司机账号")


def money(value, signed=False):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or not (-999999999 if signed else 0) <= amount <= 999999999 or amount != amount.quantize(Decimal(".01")):
            raise ValueError()
        return amount
    except (InvalidOperation, ValueError, OverflowError):
        raise ApiError(400, "费用需为有效美元金额，最多两位小数")


def preflight(body):
    supplied = body.get("checks")
    if not isinstance(supplied, dict):
        raise ApiError(400, "请逐项填写发车前 12 项核验凭据")
    checks = {}
    for key in CHECKS:
        ref = required(supplied, key, 512)
        if len(ref) < 3 or ref.lower() in {"是","确认","已核对","已安排","已完成","已确认","不适用","yes","true","n/a","none"}:
            raise ApiError(400, f"核对项 {key} 请写入凭据号、实测值或不适用原因")
        checks[key] = ref
    return checks


def sign_route(db, order, body, origin):
    """Snapshot only this ticket's stop from the verified draft under the release transaction."""
    rid = body.get("route_id")
    version = body.get("route_version")
    if rid in (None, "") and version in (None, ""):
        order.pop("release_route", None)
        return
    rid = required(body, "route_id", 100)
    row = db.execute("SELECT version,data FROM registry WHERE type='route' AND id=?", (rid,)).fetchone()
    if not row or type(version) is not int or version != row["version"]:
        raise ApiError(409, "地图批次不存在或版本已变，请重读批次再签发")
    route = json.loads(row["data"])
    ids = route["order_ids"]
    if order["id"] not in ids or route["order_versions"].get(order["id"]) != order["version"]:
        raise ApiError(409, "地图批次未包含当前版本的本票，请重新排线")
    if origin != route["warehouse"]:
        raise ApiError(409, "地图批次出发点与实际出发仓／站不一致")
    windows(order, require=True)
    if not order["window_start"][:10] <= route["date"] <= order["window_end"][:10]:
        raise ApiError(409, "本地多站批次的作业日期不在本单约定窗口内，请核对日期")
    order["release_route"] = {
        "id": rid, "route_version": version, "name": route["name"], "date": route["date"],
        "stop": ids.index(order["id"]) + 1, "stops": len(ids), "warehouse": origin,
        "resource_id": route.get("resource_id", ""), "start_time": route["start_time"],
        "timezone": route["timezone"], "issued_at": now()
    }


def apply_action(db, oid, body, user):
    import lifecycle
    order = get_order(db, oid, user)
    check_version(order, body)
    action = required(body, "action", 40)
    if action in {"edit", "upload"}:
        raise ApiError(400, "请使用对应的编辑或上传接口")
    permission(order, user, action)
    before = dict(order)
    if action == "ready":
        if order["addon_l4"] and not order.get("site_note"):
            raise ApiError(400, "特殊通道须在放货前补充现场核验信息")
        copy_fields(order, body, "sn", "release_ref")
        serials = [s.strip().upper() for s in re.split(r"[,，;；\r\n]+", order["sn"]) if s.strip()]
        if len(set(serials)) != order["quantity"] or len(serials) != order["quantity"]:
            raise ApiError(400, "请逐台录入不同 SN，并与订单台数核齐")
        lifecycle.reserve(db, order, serials, user)
        try:
            db.executemany("INSERT INTO sn_locks VALUES(?,?)", [(s, oid) for s in serials])
        except sqlite3.IntegrityError:
            raise ApiError(409, "存在已由其他订单锁定的 SN，请核对库存")
        order["status"] = "ready"
    elif action == "unrelease":
        copy_fields(order, body, "reason")
        lifecycle.move(db, order, "available", user, order["reason"])
        db.execute("DELETE FROM sn_locks WHERE order_id=?", (oid,))
        order["status"] = "new"
        order.pop("sn",None)
        order.pop("release_ref",None)
    elif action == "dispatch":
        assign_driver(db, order, body)
        order["checks"] = preflight(body)
        order["approved_cost"] = float(money(body.get("approved_cost")))
        quote=order.get("selected_quote")
        if quote and (order["approved_cost"]!=quote["amount"] or order["carrier"]!=quote["carrier"] or quote["path"]!=order["route"]):
            raise ApiError(400,"承运方、路径和预算应与已选委托一致。变更时请先复核并选择新版报价")
        if order["route"] in {"C1", "C2"}:
            copy_fields(order, body, "handoff_ref")
        for field in ("window_start", "window_end"):
            if field in body:
                order[field] = required(body, field)
        windows(order, require=True)
        if order["route"] in {"C1","C2"} and body.get("route_id"):
            raise ApiError(400, "经站订单须在站方签收后关联第二程地图批次")
        sign_route(db, order, body, order["warehouse"])
        if order["addon_l4"] and not order.get("site_note"):
            raise ApiError(400, "特殊通道须填写现场核验信息")
        for field in ("window_start", "window_end"):
            if not order.get("original_" + field):
                order["original_" + field] = order[field]
                order["original_timezone"] = order["timezone"]
        order["status"] = "dispatched"
    elif action == "depart":
        lifecycle.move(db, order, "transit", user, order["dispatch_ref"])
        order["status"] = "in_transit"
    elif action == "station_receive":
        copy_fields(order, body, "station_name", "custodian", "receipt_ref")
        lifecycle.move(db, order, "station", user, order["receipt_ref"])
        order["status"] = "at_station"
    elif action == "station_release":
        assign_driver(db, order, body)
        sign_route(db, order, body, order["station_name"])
        order["custodian"] = order["driver"]
        lifecycle.move(db, order, "transit", user, order["dispatch_ref"])
        order["status"] = "last_mile"
    elif action in {"deliver", "pickup"}:
        import folder
        folder.assert_attempt_resolved(db,oid)
        copy_fields(order, body, "signer", "delivered_at", "delivery_note")
        localtime(order["delivered_at"], "delivered_at")
        require_pod(db, oid)
        if action == "pickup":
            copy_fields(order, body, "dispatch_ref")
            order["approved_cost"] = float(money(body.get("approved_cost",0)))
        lifecycle.move(db, order, "delivered", user, order["delivery_note"])
        order["status"] = "delivered"
    elif action == "exception":
        copy_fields(order, body, "reason", "custodian", "next_step")
        order["previous_status"] = order["status"]
        order["status"] = "exception"
    elif action == "resolve":
        copy_fields(order, body, "resolution")
        order["status"] = order.pop("previous_status")
        if order["status"] == "dispatched":
            order["status"] = "ready"
            for key in ("driver","checks","carrier","dispatch_ref","handoff_ref","approved_cost","release_route"):
                order.pop(key,None)
    elif action == "revise_window":
        copy_fields(order, body, "window_start", "window_end", "reason")
        windows(order, require=True)
        if order["status"] in {"new","ready","dispatched"}:
            order.pop("selected_quote",None)
        if not order.get("original_window_start"):
            order["original_window_start"] = before.get("window_start") or order["window_start"]
            order["original_window_end"] = before.get("window_end") or order["window_end"]
            order["original_timezone"] = order["timezone"]
        if order["status"] == "dispatched":
            order["status"] = "ready"
            for key in ("driver","checks","carrier","dispatch_ref","handoff_ref","approved_cost","release_route"):
                order.pop(key,None)
    elif action == "service_complete":
        import folder
        copy_fields(order, body, "result_ref")
        order["service_units"] = folder.service_units(order, body)
    elif action == "settle":
        copy_fields(order, body, "invoice_ref")
        require_pod(db, oid)
        amount = money(body.get("actual_cost"))
        change = money(body.get("change_cost",0), signed=True)
        approved = money(order.get("approved_cost"))
        if change:
            copy_fields(order, body, "change_ref")
        if approved + change < 0:
            raise ApiError(400, "变更后批准全价不得为负")
        if amount != approved + change:
            copy_fields(order, body, "variance_ref")
        order["change_cost"] = float(change)
        order["variance_cost"] = float(amount-approved-change)
        order["actual_cost"] = float(amount)
        order["status"] = "settled"
    note = required(body, "note") if action == "note" else encode(
        {k: v for k, v in order.items() if before.get(k) != v})
    return save(db, order, user, action, note)


def add_file(db, oid, body, user):
    order = get_order(db, oid, user)
    permission(order, user, "upload")
    check_version(order, body)
    category = required(body, "category", 20)
    if category not in FILE_CATEGORIES or (user["role"] == "driver" and category not in {"other", "pod", "site"}):
        raise ApiError(400, "附件类别不可用")
    name = required(body, "name", 180)
    if re.search(r'[\\/\x00-\x1f\x7f]', name):
        raise ApiError(400, "文件名无效")
    value = body.get("base64")
    try:
        if not isinstance(value, str) or len(value) > 4*((MAX_FILE_BYTES+2)//3):
            raise ValueError()
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ApiError(400, "附件过大或编码无效")
    if not raw or len(raw) > MAX_FILE_BYTES:
        raise ApiError(400, "附件上限为 5 MiB")
    mime = next((typ for magic, typ in [(b"%PDF-", "application/pdf"), (b"\xff\xd8\xff", "image/jpeg"),
                   (b"\x89PNG\r\n\x1a\n", "image/png")] if raw.startswith(magic)), None)
    if not mime:
        raise ApiError(400, "附件只支持 PDF、JPEG、PNG")
    ts = now()
    fid = db.execute("INSERT INTO files(order_id,name,category,mime,ts,actor,content) VALUES(?,?,?,?,?,?,?)",
                     (oid,name,category,mime,ts,user["username"],raw)).lastrowid
    return {"order": save(db, order, user, "upload", f"{category} · {name}"),
            "file": {"id": fid, "name": name, "category": category, "ts": ts}}


def order_detail(db, oid, user):
    order = get_order(db, oid, user)
    events = [dict(x) for x in db.execute("SELECT id,ts,actor,action,note FROM events WHERE order_id=? ORDER BY id DESC", (oid,))]
    files = [dict(x) for x in db.execute("SELECT id,name,category,ts,actor FROM files WHERE order_id=? ORDER BY id DESC", (oid,))]
    if user["role"] == "driver":
        files = [f for f in files if f["category"] in {"pod", "site", "release"}]
        events = [e for e in events if e["action"] in {"depart","station_release","station_receive","deliver","exception","resolve"}]
    return {"order": present(order, user), "events": events, "files": files}
