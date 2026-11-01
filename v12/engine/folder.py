"""Order-scoped F01-F08 evidence and delivery facts. Run writes in the request transaction."""
import json
import re
from core import ApiError, check_version, encode, get_order, localtime, now, required, save

OFFICE = {"admin", "warehouse", "dispatch", "finance", "service"}
ATTEMPT_ROLES = {"warehouse", "dispatch", "driver", "admin"}
RECEIPT_ROLES = {"admin", "sales", "dispatch", "service"}


def init_db(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS delivery_attempts (
            id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), ordinal INTEGER NOT NULL,
            arrival_local TEXT NOT NULL, timezone TEXT NOT NULL, outcome TEXT NOT NULL, data TEXT NOT NULL,
            actor TEXT NOT NULL, ts TEXT NOT NULL, UNIQUE(order_id, ordinal));
        CREATE TABLE IF NOT EXISTS platform_receipts (
            order_id TEXT PRIMARY KEY REFERENCES orders(id), state TEXT NOT NULL, data TEXT NOT NULL);
    """)


def rows(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args)]


def rights(o, role):
    arrived = o["status"] in {"in_transit", "last_mile"} or (o["status"] == "ready" and o.get("pickup"))
    # The first leg of a transfer is handed to the station, not the contracted end customer.
    first_leg = o["status"] == "in_transit" and o["route"] in {"C1", "C2"}
    can_attempt = role in ATTEMPT_ROLES and arrived and not first_leg
    return {"attempt": bool(can_attempt),
            "receipt": role in RECEIPT_ROLES and o["status"] in {"delivered", "settled"} and not o.get("pickup")}


def get_folder(db, o, user):
    oid, role = o["id"], user["role"]
    quotes = None
    if role in {"admin", "finance", "dispatch"}:
        quotes = [{**json.loads(r["data"]), "id":r["id"],"version":r["version"]} for r in db.execute(
            "SELECT id,version,data FROM registry WHERE type='quote' AND json_extract(data,'$.order_id')=? ORDER BY rowid DESC", (oid,))]
    assets = None if role == "driver" else [{**json.loads(r["data"]), **{k:r[k] for k in ("sn","state","warehouse","model")}}
                for r in db.execute("SELECT sn,state,warehouse,model,data FROM assets WHERE order_id=? ORDER BY sn", (oid,))]
    cases = None if role not in OFFICE else [{**json.loads(r["data"]), "id":r["id"],"sn":r["sn"],"kind":r["kind"],"state":r["state"]}
             for r in db.execute("SELECT id,sn,kind,state,data FROM after_cases WHERE order_id=? ORDER BY rowid DESC", (oid,))]
    attempts = rows(db,"SELECT ordinal,arrival_local,timezone,outcome,data,actor,ts FROM delivery_attempts WHERE order_id=? ORDER BY ordinal", (oid,))
    for r in attempts:
        r.update(json.loads(r.pop("data")))
    platform = db.execute("SELECT state,data FROM platform_receipts WHERE order_id=?", (oid,)).fetchone() if role != "driver" else None
    return {"version":o["version"], "quotes":quotes, "assets":assets, "cases":cases, "attempts":attempts,
            "receipt":{**json.loads(platform["data"]), "state":platform["state"]} if platform else None,
            "rights":rights(o,role)}


def assert_attempt_resolved(db, oid):
    result=db.execute("SELECT outcome FROM delivery_attempts WHERE order_id=? ORDER BY ordinal DESC LIMIT 1",(oid,)).fetchone()
    if result and result["outcome"]!="success":
        raise ApiError(409,"最近一次到场仍有未完成项。请先登记复送后的逐台作业结果")


def service_units(order,body):
    serials={s.strip().upper() for s in re.split(r"[,，;；\r\n]+",order["sn"]) if s.strip()}
    records=body.get("service_units")
    if records is None and len(serials)==1:
        return [{"sn":next(iter(serials)),"result":order["result_ref"]}]
    if not isinstance(records,list) or len(records)!=len(serials):
        raise ApiError(400,"请按本票设备逐台登记复测结果与客户确认依据")
    verified=[]
    for rec in records:
        if not isinstance(rec,dict):
            raise ApiError(400,"逐台技术结果格式无效")
        sn=required(rec,"sn",300).upper()
        if sn not in serials:
            raise ApiError(400,"技术验收设备重复或不属于本票")
        serials.remove(sn)
        verified.append({"sn":sn,"result":required(rec,"result"),"customer_ref":required(rec,"customer_ref")})
    return verified


def add_attempt(db,o,body,user):
    if not rights(o,user["role"])["attempt"]:
        raise ApiError(403,"当前岗位或交付环节不能登记到场尝试")
    arrival=localtime(required(body,"arrival_local"),"arrival_local")
    finished=localtime(required(body,"finished_local"),"finished_local")
    if finished < arrival:
        raise ApiError(400,"本次作业结束不能早于到场时刻")
    previous=db.execute("SELECT ordinal,data,arrival_local FROM delivery_attempts WHERE order_id=? ORDER BY ordinal DESC LIMIT 1",(o["id"],)).fetchone()
    if previous and arrival < json.loads(previous["data"])["finished_local"]:
        raise ApiError(409,"新尝试应在上次作业结束后，请核对当地时间")
    serials={s.strip().upper() for s in re.split(r"[,，;；\r\n]+",o.get("sn","")) if s.strip()}
    units=body.get("units")
    if not isinstance(units,list) or len(units)!=len(serials):
        raise ApiError(400,"请逐台说明本票每台设备的本次作业结果")
    facts=[]
    for unit in units:
        if not isinstance(unit,dict):
            raise ApiError(400,"逐台记录格式错误")
        sn=required(unit,"sn",300).upper()
        outcome=required(unit,"outcome",20)
        if sn not in serials or outcome not in {"success","partial","failed"}:
            raise ApiError(400,"设备重复、不属于本票，或结果无效")
        serials.remove(sn)
        facts.append(dict(sn=sn,outcome=outcome,details=required(unit,"details")))
    results={u["outcome"] for u in facts}
    outcome=next(iter(results)) if len(results)==1 else "partial"
    data={k:required(body,k) for k in ("location","evidence")}
    data.update(units=facts,finished_local=finished)
    if outcome!="success":
        data.update(next_step=required(body,"next_step"),custodian=required(body,"custodian"))
    ordinal=previous["ordinal"]+1 if previous else 1
    db.execute("INSERT INTO delivery_attempts(order_id,ordinal,arrival_local,timezone,outcome,data,actor,ts) VALUES(?,?,?,?,?,?,?,?)",
               (o["id"],ordinal,arrival,o["timezone"],outcome,encode(data),user["username"],now()))
    return save(db,o,user,"attempt",f"第 {ordinal} 次实际到场 · {arrival} · {data['evidence']}")


def count(body,key,maximum):
    value=body.get(key)
    if type(value) is not int or not 0<=value<=maximum:
        raise ApiError(400,"件数须为有效整数，且不超过本票台数")
    return value


def record_receipt(db,o,body,user):
    if not rights(o,user["role"])["receipt"]:
        raise ApiError(403,"请由业务岗在实物签交后登记平台接收")
    existing=db.execute("SELECT state,data FROM platform_receipts WHERE order_id=?",(o["id"],)).fetchone()
    if existing and existing["state"]=="closed":
        raise ApiError(409,"此平台实收已核结")
    saved=json.loads(existing["data"]) if existing else {}
    received=count(body,"received_qty",o["quantity"])
    signed=saved.get("signed_qty",o["quantity"])
    if not existing:
        signed=count(body,"signed_qty",o["quantity"])
        if signed==0:
            raise ApiError(400,"请核对仓签数量，仓签为零需先核实实物交付")
        saved.update(signed_qty=signed,shipment_ref=required(body,"shipment_ref"))
    if received>signed:
        raise ApiError(400,"平台实收不能大于本次仓签台数，请核对货件")
    state=required(body,"state",15)
    if state not in {"open","closed"}:
        raise ApiError(400,"平台差异状态无效")
    saved.update(received_qty=received,evidence=required(body,"evidence"),owner=required(body,"owner"),updated_at=now())
    if state=="open":
        saved.update(next_step=required(body,"next_step"),due=localtime(required(body,"due"),"due"))
    else:
        saved.update(resolution=required(body,"resolution"))
        saved.pop("next_step",None)
        saved.pop("due",None)
    db.execute("INSERT INTO platform_receipts(order_id,state,data) VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,data=excluded.data",
               (o["id"],state,encode(saved)))
    return save(db,o,user,"platform_receipt",encode(saved|{"state":state}))


def handle(db,method,path,body,user):
    match=re.fullmatch(r"/api/ops/folder/([a-zA-Z0-9_-]+)(?:/(attempts|receipts))?",path)
    if not match:
        raise ApiError(404,"作业夹接口不存在")
    oid,sub=match.groups()
    order=get_order(db,oid,user)
    if method=="GET" and not sub:
        return get_folder(db,order,user)
    if method=="POST" and sub:
        check_version(order,body)
        return {"order":(add_attempt if sub=="attempts" else record_receipt)(db,order,body,user)}
    raise ApiError(405,"作业夹操作不支持此方法")
