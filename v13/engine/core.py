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

ROLES = ("admin", "sales", "warehouse", "dispatch", "driver", "finance", "service", "procurement", "supplier")
ZONES = {"America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
         "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "America/Detroit",
         "America/Indiana/Indianapolis", "America/Boise", "America/Adak", "UTC"}
TEXT_FIELDS = {"customer", "address", "zip", "city", "state", "warehouse", "model", "level",
               "route", "endpoint", "contact", "timezone", "window_start", "window_end", "notes",
               "site_note", "delivery_actions", "exclusions", "crm_ref","pack_version","procurement_mode","location_precision","coordinate_ref"}
TEXT_FIELDS.update({"a_channel","endpoint_ref"})
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
    if data["route"] not in {"", "A", "B", "C1", "C2"} or data["level"] not in {"", "L1", "L2", "L3"}:
        raise ApiError(400, "路径或服务层级不匹配")
    if data.get("pickup") and data["route"] != "A":
        raise ApiError(400, "仓内自提须使用 A 路径")
    if data.get("pickup") and data["level"] != "L1":
        raise ApiError(400, "仓内自提的合同终点为 L1 仓口交接")
    if data["route"] != "A" or data.get("pickup"):
        data.pop("a_channel",None)
    elif data.get("a_channel") not in {None,"","amazon","terminal"}:
        raise ApiError(400,"原卡派送须选择亚马逊或经销商／终端")
    if data["timezone"] and data["timezone"] not in ZONES:
        raise ApiError(400, "请选择有效美国当地时区")
    if data.get("location_precision") not in {None,"","unknown","zip","street","dock"}:
        raise ApiError(400,"定位精度请选择未核、ZIP 代表点、街址或已核装卸口")
    if data.get("location_precision")=="dock" and ((data.get("lat"),data.get("lng"))==(0,0) or data.get("lat") is None or data.get("lng") is None or not data.get("coordinate_ref")):
        raise ApiError(400,"已核装卸口须有有效坐标和现场定位依据")
    if data.get("procurement_mode","company") not in {"company","platform","ltl","brand_fleet"}:
        raise ApiError(400,"无效采购分支")
    windows(data)


def event(db, oid, user, action, note):
    db.execute("INSERT INTO events(order_id,ts,actor,action,note) VALUES(?,?,?,?,?)",
               (oid, now(), user["username"], action, note))


def actions(order, role):
    status = order["status"]
    admin = role == "admin"
    available = ["note", "upload"] if status != "settled" else []
    if status in ("new","ready") and (admin or role in {"sales","warehouse"}) and not order.get("completed_sns") and order.get("order_kind")!="repair_redelivery": available.append("cancel")
    if status == "new":
        if admin or role in {"sales", "dispatch"}:
            available.append("edit")
        if (admin or role == "warehouse") and order.get("level") in {"L1","L2","L3"}:
            available.append("ready")
    if status == "ready":
        if (admin or role == "warehouse") and not order.get("completed_sns") and order.get("order_kind")!="repair_redelivery":
            available.append("unrelease")
        if order.get("pickup"):
            if admin or role == "warehouse":
                available.extend(["pickup_gate","pickup"])
        elif admin or role == "dispatch":
            available.append("dispatch")
    if status == "dispatched" and (admin or role in {"driver", "dispatch"}):
        available.append("depart")
    transfer = order.get("route") in {"C1", "C2"}
    if status == "in_transit" and transfer and (admin or role == "warehouse"):
        available.append("station_receive")
    if status == "at_station" and (admin or role == "dispatch"):
        available.append("station_release")
    if (status == "in_transit" and not transfer or status == "last_mile") and (admin or role == "driver" or (role=="dispatch" and order.get("procurement_mode") in {"platform","ltl"} and status=="in_transit")):
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
    if order.get("sales_review_pending"):
        return [a for a in available if a in {"note","upload","unrelease","exception"}]
    return available


def encode(data):
    return json.dumps(data, ensure_ascii=False, allow_nan=False)


def create_order(db, body, user):
    if user["role"] not in {"admin", "dispatch", "sales"}:
        raise ApiError(403, "此岗位不能建单")
    # Stable IDs are reserved for the explicitly isolated synthetic acceptance pack.
    body = dict(body)
    simulation_id = body.pop("simulation_id", None)
    if simulation_id is not None:
        mode = db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
        if not mode or mode[0] != "demo" or not re.fullmatch(r"SIM200-(?:00[1-9]|0[1-9][0-9]|1[0-9]{2}|200)", str(simulation_id)):
            raise ApiError(403, "固定演练 ID 仅允许在独立演练库中使用")
        previous = db.execute("SELECT * FROM orders WHERE id=?", (simulation_id,)).fetchone()
        if previous:
            order = unpack(previous)
            if order.get("simulation_input") != body:
                raise ApiError(409, "相同演练 ID 的输入已变化，不能覆盖原订单")
            return present(order, user)
    timestamp = now()
    data = {"route": "", "level": "", "timezone": "", "addon_l4": False,
            "addon_l5": False, "pickup": False, "lat": None, "lng": None,
            "owner": user["username"], "created_at": timestamp, "updated_at": timestamp}
    normalize_input(data, body)
    wh=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(data["warehouse"],)).fetchone()
    if wh:data["warehouse_id"]=wh[0]
    mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
    data["training"]=bool(mode and mode[0]=="demo")
    data["original_window_start"] = data.get("window_start", "")
    data["original_window_end"] = data.get("window_end", "")
    data["original_timezone"] = data["timezone"]
    oid = "HH-" + datetime.now(timezone.utc).strftime("%y%m%d") + "-" + secrets.token_hex(4).upper()
    if simulation_id:
        oid = simulation_id
        data["simulation_input"] = body
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
    if user["role"]=="sales" and order.get("sales_revision") and order.get("owner")!=user["username"]:
        raise ApiError(404,"订单不存在")
    return order


def present(order, user):
    result = dict(order, allowed_actions=actions(order, user["role"]))
    result["legacy_scope_review"] = (order.get("route"),order.get("level"),order.get("timezone"))==("B","L1","America/Chicago") and not any(
        order.get(k) for k in ("scope_confirmed_at","endpoint_ref","selected_quote","release_ref","dispatch_ref","receipt_ref"))
    if user["role"] not in {"admin","sales","dispatch","service"}:
        for key in ("sms_consent","sms_consent_ref","customer_wants","sales_impact"):
            result.pop(key,None)
        if order.get("sales_revision"):
            result.pop("notes",None)
        if user["role"]!="driver":
            for key in ("contact","phone"):
                result.pop(key,None)
    if user["role"] == "driver":
        result.pop("chain_contract",None)
        for key in ("approved_cost", "actual_cost", "invoice_ref", "notes", "change_cost",
                    "variance_cost", "variance_ref", "change_ref", "checks", "selected_quote","technical_order","second_leg","second_leg_history","platform_instruction","usa_lines","paid_ref","same_conditions_ref","cost_expression","c2_replacement","approved_variance","station_mandate","first_leg_receipt","station_receipts","internal_instruction","technical_history"):
            result.pop(key, None)
    return result


def list_orders(db, user):
    if user["role"] == "driver":
        rows = db.execute("SELECT * FROM orders WHERE json_extract(data,'$.driver')=? ORDER BY rowid DESC", (user["username"],))
    elif user["role"]=="sales":
        rows=db.execute("""SELECT * FROM orders WHERE json_extract(data,'$.sales_revision') IS NULL
                           OR json_extract(data,'$.owner')=? ORDER BY rowid DESC""",(user["username"],))
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
    if order.get("positioned_sns") and (old["warehouse"]!=order["warehouse"] or old["model"]!=order["model"] or
            order["quantity"]<len(order["positioned_sns"])):
        raise ApiError(409,"该单已关联前置实物，变更持货仓、型号或减少已售台数须先取消并重新核定")
    if old.get("warehouse") != order["warehouse"]:
        wh=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(order["warehouse"],)).fetchone()
        order["warehouse_id"]=wh[0] if wh else None
    for field in ("window_start", "window_end"):
        if not order.get("original_" + field) and order.get(field):
            order["original_" + field] = order[field]
            order["original_timezone"] = order["timezone"]
    diff = {k: [old.get(k), order.get(k)] for k in body if k != "version" and old.get(k) != order.get(k)}
    if set(diff)-{"notes","crm_ref","contact"} and order.pop("selected_quote",None):
        diff["中选委托"]=["已选","变更范围后须复核"]
    return save(db, order, user, "edit", encode(diff))


def require_pod(db, oid):
    if not db.execute("SELECT 1 FROM files WHERE order_id=? AND category='pod'", (oid,)).fetchone():
        raise ApiError(400, "请先上传此订单的签收回单或交付照片（POD）")


def copy_fields(order, body, *keys):
    for key in keys:
        order[key] = required(body, key)


def record_branch_release(order, body):
    if order["route"] == "C1":
        principal=order.get("selected_quote") or {}
        if not principal.get("supplier_id") or principal.get("path")!="C1" or principal.get("amount")!=order["approved_cost"] or principal.get("carrier")!=order.get("carrier"):
            raise ApiError(409,"C1 须选定一份覆盖干线、站内和末端的主承全程报价")
        order["chain_contract"]=dict(principal=principal["supplier_id"],amount=order["approved_cost"],
            quote_id=principal["id"],evidence=required(body,"all_legs_contract",300))
    if order["route"] == "A" and not order.get("pickup"):
        channel=order.get("a_channel") or body.get("a_channel")
        if channel not in {"amazon","terminal"}:
            raise ApiError(409,"请确认本票原卡派送亚马逊仓，或经销商／终端")
        fields=("receiver_site","appointment_ref","shipment_ref","label_ref","receiving_terms") if channel=="amazon" else ("receiver_site","receiver_contact","handoff_terms")
        order["channel_release"]={k:required(body,k,300) for k in fields}
        order["channel_release"].update(channel=channel,endpoint=order["endpoint"])


def assign_driver(db, order, body):
    if order.get("procurement_mode") in {"platform","ltl"} and order["status"]!="at_station":
        copy_fields(order,body,"carrier","dispatch_ref")
        order.pop("driver",None)
        return
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


def sign_route(db, order, body, origin, user=None):
    import routing
    routing.release(db, order, body, origin, user)


def apply_action(db, oid, body, user):
    import lifecycle
    order = get_order(db, oid, user)
    check_version(order, body)
    action = required(body, "action", 40)
    if order.get('recovery_id') and action!='note':
        raise ApiError(409, '本票处于故障冻结，须按救援新版本逐台交接；不能恢复旧签发')
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
        order["sn"]=", ".join(serials)
        lifecycle.reserve(db, order, serials, user)
        try:
            db.executemany("INSERT INTO sn_locks VALUES(?,?)", [(s, oid) for s in serials])
        except sqlite3.IntegrityError:
            raise ApiError(409, "存在已由其他订单锁定的 SN，请核对库存")
        order["status"] = "ready"
    elif action == "cancel":
        import gate
        reason=required(body,"reason");history=list(order.get("cancelled_serials",[]))
        if order["status"]=="ready":
            history=sorted(r[0] for r in db.execute("SELECT sn FROM sn_locks WHERE order_id=?",(oid,)))
            lifecycle.move(db,order,"available",user,reason)
            db.execute("DELETE FROM sn_locks WHERE order_id=?",(oid,))
        g=gate.active(db,oid,1)
        if g and g["state"] not in {"released","revoked","refused"}:
            gate.update(db,g,"revoked",reason=reason)
            gate.log(db,oid,1,"cancel",user,dict(grant=g['id'],reason=reason))
        order.update(status="cancelled",reason=reason,cancelled_serials=history)
        order.pop("sn",None)
    elif action == "unrelease":
        order.pop("pickup_gate",None)
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

        if order["route"] in {"C1", "C2"}:
            copy_fields(order, body, "handoff_ref")
        for field in ("window_start", "window_end"):
            if field in body:
                order[field] = required(body, field)
        windows(order, require=True)
        record_branch_release(order,body)
        assert_commission(db,order)
        import gate
        if order.get("procurement_mode") in {"ltl","platform"}:
            gate.issue_network(db,order,user)
        else:
            sign_route(db, order, body, order["warehouse"], user)
            gate.issue(db,order,body,user,1)
        order["issue_version"]=order["version"]+1
        if order["addon_l4"] and not order.get("site_note"):
            raise ApiError(400, "特殊通道须填写现场核验信息")
        for field in ("window_start", "window_end"):
            if not order.get("original_" + field):
                order["original_" + field] = order[field]
                order["original_timezone"] = order["timezone"]
        import review
        report=review.comparison(db,oid,user)
        order["financial_baseline_version"]=report["baseline_version"] if report["current"] else None
        order["status"] = "dispatched"
    elif action == "depart":
        import gate
        gate.require_released(db,order)
        check_issue(order,body)
        assert_commission(db,order)
        lifecycle.move(db, order, "transit", user, order["dispatch_ref"])
        order["status"] = "in_transit"
    elif action == "station_receive":
        import folder
        folder.station_receipts(db,order,body)
        copy_fields(order, body, "station_name", "custodian", "receipt_ref")
        lifecycle.move(db, order, "station", user, order["receipt_ref"])
        order["status"] = "at_station"
    elif action == "pickup_gate":
        record_pickup_gate(order,body)
    elif action == "station_release":
        import folder,gate
        folder.assert_second_leg(db,order,body)
        assign_driver(db, order, body)
        sign_route(db,order,body,order["station_name"],user)
        gate.issue(db,order,body,user,2)
        order["issue_version"]=order["version"]+1
        order["station_pending"]=True
        # Signing does not move stock out of the station. The dock must verify actuals.
    elif action in {"deliver", "pickup"}:
        import folder
        folder.assert_attempt_resolved(db,order)
        if action=="deliver":check_issue(order,body)
        copy_fields(order, body, "signer", "delivered_at", "delivery_note")
        localtime(order["delivered_at"], "delivered_at")
        require_pod(db, oid)
        if action=="deliver" and order["route"] in {"A","C1"}:
            channel=(order.get("channel_release") or {}).get("channel") or order.get("a_channel")
            if order["route"]=="A" and not channel:
                channel=required(body,"a_channel",20)
                if channel not in {"amazon","terminal"}:
                    raise ApiError(400,"请选择历史票的实际平台仓或终端收货分支")
            order["endpoint_receipt"]=dict(channel=channel or "C1",receiver=order["signer"],endpoint=order["endpoint"],
                evidence=required(body,"endpoint_receipt_ref",300),at=order["delivered_at"])
        if action == "pickup":
            gate=order.get("pickup_gate",{})
            if body.get("dispatch_ref")!=gate.get("authority_ref") or order["signer"]!=gate.get("collector"):
                raise ApiError(409,"请核对本次授权提货人和提货号")
            copy_fields(order, body, "dispatch_ref")
            order["approved_cost"] = float(money(body.get("approved_cost",0)))
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
        if not order.get("technical_order"):
            raise ApiError(409,"缺少独立技术委托，先核 T5 执行与授权范围")
        import supply
        if supply.assert_eligible(db,order["technical_order"],dict(order,level="L5",addon_l4=False))!=order["technical_order"].get("capability_snapshot"):
            raise ApiError(409,"技术资格已过版，请重签技术委托")
        order["service_units"] = folder.service_units(order, body)
        complete = sum(r["state"]=="passed" for r in order["service_units"])==order["quantity"]
        order["technical_order"]["state"]="completed" if complete else "open"
        if complete:copy_fields(order,body,"result_ref")
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
        lines=body.get("usa_lines")
        if lines is not None:
            if not isinstance(lines,dict) or set(lines)!={"origin","delivery_wait","technical"}:
                raise ApiError(400,"结算行须列原仓、配送含等待、技术")
            checked={k:money(v) for k,v in lines.items()}
            if sum(checked.values())!=amount:
                raise ApiError(409,"费用行之和与美国段账单不符")
            order["usa_lines"]={k:float(v) for k,v in checked.items()}
            order["cost_expression"]=f"K＋T＋{amount.normalize():f} 待结"
        for key in ("same_conditions_ref","paid_ref"):
            if body.get(key):order[key]=required(body,key)
        order["approved_variance"]=float(amount-approved)
        order["actual_cost"] = float(amount)
        order["status"] = "settled"
    note = required(body, "note") if action == "note" else encode(
        {k: v for k, v in order.items() if before.get(k) != v})
    if before.get("release_route") and not order.get("release_route"):
        import routing
        routing.cancel_booking(db,oid)
    return save(db, order, user, action, note)


def add_file(db, oid, body, user):
    order = get_order(db, oid, user)
    permission(order, user, "upload")
    check_version(order, body)
    category = required(body, "category", 20)
    if category not in FILE_CATEGORIES or (user["role"] == "driver" and category not in {"other", "pod", "site"}):
        raise ApiError(400, "附件类别不可用")
    if user["role"]=="driver" and category=="pod":
        import gate
        check_issue(order,body)
        gate.require_released(db,order)
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
    prior=db.execute("SELECT id,name,category,ts FROM files WHERE order_id=? AND category=? AND content=?",(oid,category,raw)).fetchone()
    if prior:return {"order":present(order,user),"file":dict(prior)}
    fid = db.execute("INSERT INTO files(order_id,name,category,mime,ts,actor,content) VALUES(?,?,?,?,?,?,?)",
                     (oid,name,category,mime,ts,user["username"],raw)).lastrowid
    return {"order": save(db, order, user, "upload", f"{category} · {name}"),
            "file": {"id": fid, "name": name, "category": category, "ts": ts}}


def order_detail(db, oid, user):
    order = get_order(db, oid, user)
    events = [dict(x) for x in db.execute("SELECT id,ts,actor,action,note FROM events WHERE order_id=? ORDER BY id DESC", (oid,))]
    if user["role"] not in {"admin","sales","dispatch","service"}:
        for item in events:
            if item["action"] in {"edit","logistics_handoff","sales_revision"} or item["action"].startswith("contact_"):
                item["note"]="记录已更新"
    files = [dict(x) for x in db.execute("SELECT id,name,category,ts,actor FROM files WHERE order_id=? ORDER BY id DESC", (oid,))]
    if user["role"] == "driver":
        files = [f for f in files if f["category"] in {"pod", "site", "release"}]
        events = [e for e in events if e["action"] in {"depart","station_release","station_receive","deliver","exception","resolve"}]
    return {"order": present(order, user), "events": events, "files": files}


def check_issue(order, body):
    if type(body.get("release_version")) is not int or body["release_version"] != order.get("issue_version"):
        raise ApiError(409, "签发版已变或缺失，刷新本票并核对新授权后再扫码作业")


def assert_commission(db, order):
    import review
    if order["route"]=="C1" and not order.get("second_leg"):
        raise ApiError(409,"缺少本票二程书面委托，请先落实接收站及后续执行方")
    if order["route"] in {"C1","C2"}:
        import folder
        if not order.get("station_mandate"):
            raise ApiError(409,"首段待补接站库址、具名接收方和书面收储承接")
        folder.assert_station_authority(db,order)
    mode=order.get("procurement_mode","company")
    if mode in {"platform","ltl","brand_fleet"}:
        item=order.get("platform_instruction",{})
        if (not item.get("instruction_ref") or item.get("scope_snapshot")!=review.scope_snapshot(order)
                or item.get("valid_until","")<max(now()[:10],order["window_end"][:10])
                or item.get("carrier")!=order.get("carrier")):
            raise ApiError(409,"缺少本票有效承运指令或实际执行方不符，请复核")
        if mode=="brand_fleet" and item["allocation"]!=order["approved_cost"]:
            raise ApiError(409,"批准分摊与本次内部用车金额不一致")
        order["executor_id"]=item["executor_id"]
        if mode!="ltl" and order["route"]!="C1":
            return
        if item["executor_id"]!=order.get("selected_quote",{}).get("executor_id"):
            raise ApiError(409,"普通 LTL 的承运凭据须与本票中选方一致")
    quote=order.get("selected_quote")
    if not quote:
        raise ApiError(409,"缺少本票中选运输委托，请先核实报价、执行方接受和审批凭据")
    q=review.required_quote(db,order["id"],quote["id"])
    if quote["version"]!=q["version"] or not quote.get("approval_ref"):
        raise ApiError(409,"中选委托已过版，请重新核实回价并签发")
    review.validate_quote(order,q)
    import supply
    if supply.assert_eligible(db,q,order)!=quote.get("capability_snapshot"):
        raise ApiError(409,"中选时的执行资格已过版或缺档，请重新确认委托")
    if order["approved_cost"]!=q["amount"] or order["carrier"]!=q["carrier"] or q["path"]!=order["route"]:
        raise ApiError(409,"承运方、路径和预算应与本票中选委托一致")
    order["executor_id"]=q["executor_id"]


def record_pickup_gate(order,body):
    gate={k:required(body,k) for k in ("collector","authority_ref","vehicle_ref","secure_ref")}
    for key in ("package_height_cm","door_cm","gross_kg","payload_kg"):
        try:value=float(body.get(key))
        except (TypeError,ValueError,OverflowError):value=0
        if not math.isfinite(value) or value<=0:
            raise ApiError(400,"请记录本次实测包装高度、车门净开口、货重及车辆载重")
        gate[key]=value
    if gate["package_height_cm"]>gate["door_cm"] or gate["gross_kg"]>gate["payload_kg"]:
        order.update(status="exception",previous_status="ready",custodian=order["warehouse"],
                     reason="F06 仓门禁装：开口或载荷不足",next_step="更换车辆，重新核提货人与签发依据")
        order.pop("pickup_gate",None)
        order["rejected_pickup"]=gate
    else:
        order["pickup_gate"]=gate
