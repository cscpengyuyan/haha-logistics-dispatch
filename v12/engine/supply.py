"""Shipment milestones, verified supplier cells and physical stock. Caller owns transaction."""
import base64
import binascii
import hashlib
import json
import math
import re
import sqlite3
import uuid
from datetime import date, datetime, timezone

import core
import lifecycle
from core import ApiError, encode, required

SHIP_READ = {"admin", "warehouse", "dispatch", "sales", "finance", "inbound", "procurement"}
SHIP_WRITE = {"admin", "warehouse", "inbound"}
CAP_READ = {"admin", "dispatch", "finance", "procurement"}
CAP_WRITE = {"admin", "dispatch", "procurement"}
RELEASE = {"customs", "carrier_release", "terminal_ready"}
STEPS = RELEASE | {"cutoff", "loaded", "transship", "arrived", "eta", "hold", "clear_hold",
                   "lfd", "empty_due", "bond_authority", "bond_move", "pickup", "warehouse_arrival", "empty_return",
                   "shipping_docs", "handoff_site", "cfs_ready", "rolled"}
CELL = ("supplier_id", "executor_id", "product", "warehouse_id", "zip", "model", "action")
ACTIONS = {"receive", "collect", "direct", "L1", "L2", "L3", "L4", "L5"}


def init_db(db):
    db.executescript("""
      CREATE TABLE IF NOT EXISTS shipments(id TEXT PRIMARY KEY, asn TEXT NOT NULL UNIQUE,
          version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manifest(sn TEXT PRIMARY KEY, shipment_id TEXT REFERENCES shipments(id),
          model TEXT NOT NULL, order_id TEXT REFERENCES orders(id), receipt TEXT);
      CREATE INDEX IF NOT EXISTS manifest_shipment ON manifest(shipment_id);
      CREATE TABLE IF NOT EXISTS sailing_options(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_photos(sn TEXT PRIMARY KEY REFERENCES manifest(sn),
          mime TEXT NOT NULL, content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS tariff_inquiries(id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL REFERENCES registry(id),
          order_id TEXT NOT NULL REFERENCES orders(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tariffs(cell TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability(cell TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positioning(id TEXT PRIMARY KEY, sn TEXT NOT NULL, version INTEGER NOT NULL,
          state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_position ON positioning(sn) WHERE state IN ('pending','approved','moving');
      CREATE TABLE IF NOT EXISTS supply_log(id INTEGER PRIMARY KEY, item TEXT NOT NULL, version INTEGER NOT NULL,
          actor TEXT NOT NULL, ts TEXT NOT NULL, snapshot TEXT NOT NULL);
    """)


def allow(user, roles):
    if user["role"] not in roles:
        raise ApiError(403, "此岗位没有该项作业权限")


def choice(body, key, choices):
    value = required(body, key)
    if value not in choices:
        raise ApiError(400, "不适用的选项 " + key)
    return value


def instant(value):
    try:
        d = datetime.fromisoformat(value)
        if d.utcoffset() is None:
            raise ValueError()
        return d.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (ValueError, TypeError, OverflowError):
        raise ApiError(400, "请提供包含 UTC 偏移的完整日期与时间")


def entity(db, kind, rid):
    row = db.execute("SELECT data FROM registry WHERE type=? AND id=?", (kind, rid)).fetchone()
    if not row:
        raise ApiError(409, "请先核对已登记的仓点或服务主体 ID")
    return json.loads(row[0])


def audit(db, item, version, user, data):
    db.execute("INSERT INTO supply_log(item,version,actor,ts,snapshot) VALUES(?,?,?,?,?)",
               (item, version, user["username"], core.now(), encode(data)))


def shipment(db, sid):
    row = db.execute("SELECT * FROM shipments WHERE id=?", (sid,)).fetchone()
    if not row:
        raise ApiError(404, "未找到海运批次")
    result = json.loads(row["data"])
    result.update(id=sid, version=row["version"])
    result["units"] = [dict(r) for r in db.execute("""
      SELECT m.sn,m.model,m.order_id,m.receipt,a.warehouse,a.state,a.order_id AS locked_order
      FROM manifest m LEFT JOIN assets a ON a.sn=m.sn WHERE m.shipment_id=? ORDER BY m.sn""", (sid,))]
    for u in result["units"]:
        u["receipt"] = json.loads(u["receipt"]) if u["receipt"] else None
        u["packing"] = result.get("packing", {}).get(u["sn"])
    return result


def same_version(row, body):
    if type(body.get("version")) != int or row["version"] != body["version"]:
        raise ApiError(409, "版本已变化。请刷新查看新的回执和实物状态，再确认本次作业")


def update(db, s, user, log):
    changed = db.execute("UPDATE shipments SET version=version+1,data=? WHERE id=? AND version=?",
                         (encode({k:v for k,v in s.items() if k not in ("units", "id", "version")}),
                          s["id"], s["version"]))
    if changed.rowcount != 1:
        raise ApiError(409, "该批次已被其他岗位更新")
    audit(db, s["id"], s["version"] + 1, user, log)
    return shipment(db, s["id"])


SAILING_DATES = ("doc_cutoff", "gate_cutoff", "planned_etd", "planned_eta", "pickup_eta", "planned_warehouse")
SAILING_FIELDS = ("voyage", "origin", "port", "warehouse_id", "origin_zone", "port_zone",
                  "transshipment", "source", "confirmation")
PORT_ZONES = core.ZONES | {"Asia/Shanghai","Asia/Hong_Kong","Asia/Taipei","Asia/Singapore","Asia/Tokyo","Asia/Seoul"}


def register_sailings(db, body, user):
    allow(user, SHIP_WRITE)
    rows = body.get("candidates")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ApiError(400, "每次可录入 1 至 100 个候选班期")
    ids = []
    for row in rows:
        if not isinstance(row, dict):
            raise ApiError(400, "候选航次须是一条包含日期与来源的记录")
        c = {k: required(row, k, 200) for k in SAILING_FIELDS}
        c["confirmation"] = choice(row, "confirmation", {"pending","confirmed","demo"})
        if c["origin_zone"] not in PORT_ZONES or c["port_zone"] not in PORT_ZONES:
            raise ApiError(400, "请选择起运港和卸货港的作业时区")
        wh = entity(db, "warehouse", c["warehouse_id"])
        c.update(warehouse=wh["name"], warehouse_zone=wh["timezone"])
        c.update({k:instant(row.get(k)) for k in SAILING_DATES})
        if not max(c["doc_cutoff"], c["gate_cutoff"]) <= c["planned_etd"] <= c["planned_eta"] <= c["pickup_eta"] <= c["planned_warehouse"]:
            raise ApiError(400,"请核对截单、截港、开船、到港、提货及送仓时间顺序")
        # Each distinct sourced schedule is immutable, including when imported a second time.
        rid = "VOY-" + hashlib.sha256(encode(c).encode()).hexdigest()[:24]
        c["updated_at"] = core.now()
        inserted = db.execute("INSERT OR IGNORE INTO sailing_options VALUES(?,?)", (rid, encode(c)))
        if inserted.rowcount:
            audit(db, rid, 1, user, c)
        ids.append(rid)
    return {"ids": ids}


def packing_specs(unit):
    specs = unit.get("packing")
    if specs is None:
        return None
    if not isinstance(specs, dict):
        raise ApiError(400, "包装规格格式无效")
    result = {}
    for k in ("length_cm", "width_cm", "height_cm", "weight_kg"):
        val = specs.get(k)
        if type(val) not in (int, float) or not math.isfinite(val) or not 0 < val <= 100000:
            raise ApiError(400, "打托长宽高与毛重须为正数")
        result[k] = val
    for k in ("upright", "nonstackable"):
        if type(specs.get(k)) is not bool:
            raise ApiError(400, "须明确直立和不可叠放要求")
        result[k] = specs[k]
    return result


def book(db, body, user):
    allow(user, SHIP_WRITE)
    candidate = None
    if body.get("candidate_id"):
        rid = required(body, "candidate_id", 60)
        row = db.execute("SELECT data FROM sailing_options WHERE id=?", (rid,)).fetchone()
        if not row:
            raise ApiError(404, "未找到所选班期，重新选择后订舱")
        candidate = dict(json.loads(row[0]), id=rid)
        body = dict(body, **{k:candidate[k] for k in ("voyage","origin","port","origin_zone","port_zone",
            "warehouse_id","warehouse_zone","planned_etd","planned_eta","planned_warehouse")})
    data = {k: required(body, k, 200) for k in ("voyage", "batch", "container", "asn", "origin",
            "port", "warehouse_id", "owner", "evidence", "warehouse_zone")}
    ware = entity(db, "warehouse", data["warehouse_id"])
    if ware["timezone"] != data["warehouse_zone"]:
        raise ApiError(409, "请选择指定仓的实际时区")
    for key in ("origin_zone","port_zone"):
        if body.get(key):
            value=required(body,key,64)
            if value not in core.ZONES|{"Asia/Shanghai","Asia/Hong_Kong","Asia/Taipei","Asia/Singapore","Asia/Tokyo","Asia/Seoul"}:
                raise ApiError(400,"请选取支持的 IANA 作业地时区")
            data[key]=value
    data.update(warehouse=ware["name"], mode=choice(body, "mode", {"FCL", "LCL"}),
                inland=choice(body, "inland", {"rail", "road"}), events=[], hold=False)
    if candidate:
        data["candidate"] = candidate
    for k in ("seal","bill_of_lading","pickup_site","inland_owner"):
        if body.get(k):
            data[k] = required(body,k,200)
    for k in ("planned_etd", "planned_eta", "planned_warehouse"):
        data[k] = instant(body.get(k))
        data[k+"_source"] = body[k]
    if not data["planned_etd"] <= data["planned_eta"] <= data["planned_warehouse"]:
        raise ApiError(400, "原计划时间先后关系不符")
    data["eta"], data["warehouse_eta"] = data["planned_eta"], data["planned_warehouse"]
    units = body.get("units")
    if not isinstance(units, list) or not 1 <= len(units) <= 1000:
        raise ApiError(400, "请提供 1 至 1000 台的装箱清单")
    rows = []
    for unit in units:
        if not isinstance(unit, dict):
            raise ApiError(400, "请按每台填写 SN 和型号")
        sn = required(unit, "sn", 120).upper()
        if not re.fullmatch(r"[^;,，；、\s]+", sn):
            raise ApiError(400, "SN 不得含空格或分隔符")
        model = required(unit, "model", 120)
        oid = unit.get("order_id") or None
        if oid:
            order = core.get_order(db, oid, user)
            if (order["model"], order["warehouse"]) != (model, ware["name"]):
                raise ApiError(409, "依赖订单的机型或收货仓不匹配")
        rows.append((sn, model, oid))
        packed = packing_specs(unit)
        if packed:
            data.setdefault("packing", {})[sn] = packed
    existing = db.execute("SELECT id FROM shipments WHERE asn=?", (data["asn"],)).fetchone()
    if existing:
        prior = shipment(db, existing[0])
        stable = set(data) - {"events", "hold", "eta", "warehouse_eta"}
        if all(prior.get(k,data[k] if k.endswith("_source") else None) == data[k] for k in stable) and set(rows) == {
              (u["sn"], u["model"], u["order_id"]) for u in prior["units"]} and len(rows)==len(set(rows)):
            return {"shipment": prior, "replayed": True}
        raise ApiError(409, "该 ASN 已登记且内容不一致，请核对原装箱清单")
    sid = "SEA-" + uuid.uuid4().hex[:10].upper()
    try:
        db.execute("INSERT INTO shipments VALUES(?,?,1,?)", (sid, data["asn"], encode(data)))
        for sn, model, oid in rows:
            if db.execute("SELECT 1 FROM assets WHERE sn=?", (sn,)).fetchone():
                raise ApiError(409, "SN 已在实物台账中，请核对批次和重码")
            db.execute("INSERT INTO manifest VALUES(?,?,?,?,NULL)", (sn, sid, model, oid))
    except sqlite3.IntegrityError:
        raise ApiError(409, "ASN 或预报 SN 重复，请核对原始记录")
    audit(db, sid, 1, user, data)
    return {"shipment": shipment(db, sid)}


def affected(db, s):
    ids = {u["order_id"] for u in s["units"] if u["order_id"] and not u["receipt"]}
    return [oid for oid in sorted(ids) if db.execute(
        "SELECT 1 FROM orders WHERE id=? AND status='new' AND NOT EXISTS "
        "(SELECT 1 FROM sn_locks WHERE order_id=?)", (oid, oid)).fetchone()]


def delay_impact(db, s, eta):
    if any(e["kind"]=="arrived" for e in s["events"]):
        raise ApiError(409, "已实际到港，请登记实际进程")
    if eta < s["planned_etd"]:
        raise ApiError(400,"最新到港预测不能早于出运")
    delta = datetime.fromisoformat(eta) - datetime.fromisoformat(s["planned_eta"])
    warehouse_eta = (datetime.fromisoformat(s["planned_warehouse"]) + delta).isoformat(timespec="seconds")
    orders = []
    for oid in affected(db, s):
        o = json.loads(db.execute("SELECT data FROM orders WHERE id=?",(oid,)).fetchone()[0])
        orders.append(dict(id=oid, start=o.get("window_start"), end=o.get("window_end"), zone=o.get("timezone")))
    return dict(eta=eta, warehouse_eta=warehouse_eta, orders=orders, pending=sum(not u["receipt"] for u in s["units"]))


def preview_eta(db, body, user):
    allow(user, SHIP_WRITE)
    s = shipment(db,required(body,"id"))
    same_version(s,body)
    return delay_impact(db,s,instant(body.get("at")))


def close_review(db, body, user):
    s = shipment(db,required(body,"id"))
    task = next((r for r in s.get("reviews",[]) if r["id"] == body.get("task_id")),None)
    if task is None:
        raise ApiError(404,"未找到改约复核待办")
    allow(user, {"admin",task["role"]})
    evidence = required(body,"evidence",300)
    if task.get("closed_at") and task["evidence"] == evidence:
        return {"replayed": True}
    same_version(s,body)
    if task.get("closed_at"):
        raise ApiError(409,"该待办已办结，请查看既有回执")
    task.update(closed_at=core.now(), actor=user["username"], evidence=evidence)
    return {"shipment": update(db,s,user,task)}


def milestone(db, body, user):
    allow(user, SHIP_WRITE)
    s = shipment(db, required(body, "id"))
    kind = choice(body, "kind", STEPS)
    evt = {k: required(body, k, 300) for k in ("evidence", "custodian")}
    evt.update(kind=kind, at=instant(body.get("at")))
    fields=("bill_of_lading","pickup_site","inland_owner") if kind=="handoff_site" else ("seal",) if kind=="shipping_docs" and s["mode"]=="FCL" else ()
    for key in fields:
        value=required({key:body.get(key) or s.get(key)},key,200)
        evt[key]=value
        s[key]=value
    zone=body.get("zone") or (s.get("origin_zone") if kind in ("cutoff","loaded") else s["warehouse_zone"] if kind in ("warehouse_arrival","empty_return") else s.get("port_zone"))
    if zone:
        if zone not in core.ZONES|{"Asia/Shanghai","Asia/Hong_Kong","Asia/Taipei","Asia/Singapore","Asia/Tokyo","Asia/Seoul"}:
            raise ApiError(400,"作业地时区无效")
        evt["zone"]=zone
    evt["source_time"]=body["at"]
    if any(all(old.get(k) == v for k, v in evt.items()) for old in s["events"]):
        return {"shipment": s, "replayed": True}
    same_version(s, body)
    done = {i["kind"] for i in s["events"]}
    prerequisites = {"arrived":{"loaded"}, "pickup":{"arrived"} | RELEASE,
        "warehouse_arrival":{"pickup"}, "empty_return":{"warehouse_arrival"},
        "bond_move":{"arrived","bond_authority"}, "clear_hold":{"hold"}}
    prerequisites["loaded"] = {"shipping_docs"}
    prerequisites["pickup"].add("handoff_site")
    if s["mode"] == "LCL":
        prerequisites["pickup"].add("cfs_ready")
    missing = prerequisites.get(kind,set()) - done
    if missing:
        raise ApiError(409, "缺少前序回执：" + "、".join(sorted(missing)))
    if kind in ("pickup", "bond_move") and s["hold"]:
        raise ApiError(409, "扣留中，请先补解除凭证")
    if kind in ("loaded","arrived","pickup","warehouse_arrival","empty_return") and kind in done:
        raise ApiError(409, "实际交接已登记。更正须核对原回执")
    if kind in ("loaded","arrived","pickup","warehouse_arrival","empty_return"):
        previous = [x["at"] for x in s["events"] if x["kind"] in prerequisites[kind]]
        if previous and evt["at"] < max(previous):
            raise ApiError(409, "实际作业时间不能早于前序交接")
    if kind in ("empty_return","empty_due") and s["mode"] != "FCL":
        raise ApiError(400, "拼箱按分单交接，无整柜还空")
    if kind=="cfs_ready" and s["mode"] != "LCL":
        raise ApiError(400, "仅拼箱登记 CFS 拆箱齐货")
    if kind == "eta":
        impact = delay_impact(db,s,evt["at"])
        if impact["warehouse_eta"] != s["warehouse_eta"]:
            roles = ["warehouse"] + (["dispatch"] if impact["orders"] else [])
            for role in roles:
                s.setdefault("reviews",[]).append(dict(id=uuid.uuid4().hex[:16],role=role,
                    at=core.now(), due=impact["warehouse_eta"],orders=impact["orders"],
                    reason="核对仓库收货时段" if role=="warehouse" else "核对受影响客户预约"))
        s["eta"] = evt["at"]
        s["warehouse_eta"] = impact["warehouse_eta"]
        evt["order_ids"] = [o["id"] for o in impact["orders"]]
        for oid in evt["order_ids"]:
            core.event(db, oid, user, "supply_review", f"{s['asn']} ETA 更新，{s['owner']} 复核预约。原约保留")
    if kind in ("hold","clear_hold"):
        s["hold"] = kind == "hold"
    evt.update(recorded_at=core.now(), actor=user["username"])
    s["events"].append(evt)
    return {"shipment": update(db,s,user,evt)}


def schedule(db, body, user):
    allow(user, SHIP_WRITE)
    s = shipment(db,required(body,"id"))
    same_version(s,body)
    kind=choice(body,"kind",STEPS-{"hold","clear_hold","eta"})
    if kind in {e["kind"] for e in s["events"]}:
        raise ApiError(409,"该节点已有实际回执，不能以预计覆盖历史")
    value=instant(body.get("at"))
    next_plan=dict(at=value,source_time=body["at"],evidence=required(body,"evidence",300),owner=required(body,"owner",100),
                   recorded_at=core.now(),actor=user["username"])
    versions=s.setdefault("schedules",{}).setdefault(kind,[])
    versions.append(next_plan)
    return {"shipment":update(db,s,user,dict(next_plan,kind=kind,revision=len(versions)))}


def receive(db, body, user):
    allow(user, {"admin", "warehouse"})
    s = shipment(db,required(body,"id"))
    sn = required(body,"sn",120).upper()
    u = next((r for r in s["units"] if r["sn"]==sn),None)
    if not u:
        raise ApiError(409,"SN 与该 ASN 不符。请保留差异记录，核实后再入库")
    facts = {k:required(body,k,300) for k in ("bin","condition","evidence","custodian")}
    facts["state"] = choice(body,"state",{"pending_qc","available","hold"})
    photo = body.get("photo")
    if photo:
        if not isinstance(photo,str) or len(photo)>4*((2*1024*1024+2)//3):
            raise ApiError(400,"单张收货照片上限 2 MiB")
        try:
            raw=base64.b64decode(photo,validate=True)
        except (ValueError,binascii.Error):
            raise ApiError(400,"收货照片编码无效")
        mime=next((t for t,magic in (("image/jpeg",b"\xff\xd8\xff"),("image/png",b"\x89PNG\r\n\x1a\n")) if raw.startswith(magic)),None)
        if not mime or len(raw)>2*1024*1024:
            raise ApiError(400,"请提供 2 MiB 以内的 JPEG 或 PNG 收货照片")
        facts["photo_sha256"]=hashlib.sha256(raw).hexdigest()
    if body.get("free_until"):
        facts["free_until"] = required(body,"free_until",10)
    if u["receipt"]:
        if all(u["receipt"].get(k)==v for k,v in facts.items()) and all(
                u["receipt"].get(k)==facts.get(k) for k in ("free_until","photo_sha256")):
            asset = lifecycle.row_obj(db.execute("SELECT * FROM assets WHERE sn=?", (sn,)).fetchone())
            return {"shipment":s, "asset":asset, "replayed":True}
        raise ApiError(409,"该台已有不同的实收记录，请核对库存台账")
    same_version(s,body)
    if not any(e["kind"]=="warehouse_arrival" for e in s["events"]):
        raise ApiError(409,"请先登记指定仓实际到仓交接")
    if facts["state"] != "hold" and any(d["sn"] == sn and d["kind"]=="damage" for d in s.get("differences",[])):
        raise ApiError(409,"该台已有货损记录，须先隔离实收，再由仓管复检")
    asset = lifecycle.receipt(db, dict(facts,sn=sn,warehouse=s["warehouse"],model=u["model"],batch=s["asn"],packing=u.get("packing")),user,from_manifest=True)
    facts["received_at"] = core.now()
    if photo:
        db.execute("INSERT INTO receipt_photos VALUES(?,?,?)",(sn,mime,raw))
    db.execute("UPDATE manifest SET receipt=? WHERE sn=?", (encode(facts),sn))
    return {"shipment":update(db,s,user,dict(facts,sn=sn)), "asset":asset}


def qualify(db, body, user):
    allow(user,CAP_WRITE)
    data = {k:required(body,k,180) for k in CELL}
    supplier = entity(db,"supplier",data["supplier_id"])
    entity(db,"warehouse",data["warehouse_id"])
    if (not re.fullmatch(r"[0-9]{5}",data["zip"]) or not re.fullmatch(r"M0[1-7]",data["model"])
        or data["action"] not in ACTIONS or data["product"] not in {"T1","T2","T3","T4","T5"}):
        raise ApiError(400,"请核对五位 ZIP、机型、采购产品与服务动作")
    data["decision"] = choice(body,"decision",set("UYCN"))
    if data["decision"] in ("Y","C"):
        data["evidence"] = required(body,"evidence",300)
        for k in ("valid_until","insurance_until"):
            try:
                data[k] = date.fromisoformat(required(body,k)).isoformat()
            except ValueError:
                raise ApiError(400,"请输入有效日期")
        if supplier["qualification"]=="S2":
            data["trial_limit"] = float(core.money(body.get("trial_limit")))
    if data["decision"]=="C":
        data["condition"] = required(body,"condition",300)
    cell = encode([data[k] for k in CELL])
    row = db.execute("SELECT version FROM capability WHERE cell=?",(cell,)).fetchone()
    if row:
        same_version(row,body)
    v = row["version"]+1 if row else 1
    db.execute("INSERT INTO capability VALUES(?,?,?) ON CONFLICT(cell) DO UPDATE "
               "SET version=excluded.version,data=excluded.data",(cell,v,encode(data)))
    audit(db,cell,v,user,data)
    return {"card":dict(data,version=v)}


def tariff(db, b, user):
    allow(user, CAP_READ)
    keys=("supplier_id","warehouse_id","zip","product","model")
    k={name:required(b,name,180) for name in keys if name!="zip"}
    k["zip"]=core.string(b.get("zip",""),"zip",20)
    if k["zip"] and not re.fullmatch(r"[0-9]{5}",k["zip"]):
        raise ApiError(400,"请输入实际五位 ZIP，勿删除前导零。缺少 ZIP 可留空后登记逐票询价")
    entity(db,"supplier",k["supplier_id"])
    origin=entity(db,"warehouse",k["warehouse_id"])
    if b.get("action")=="inquire":
        allow(user,CAP_WRITE)
        oid=required(b,"order_id")
        o=core.get_order(db,oid,user)
        if o.get("pickup") or o["status"] not in ("new","ready","at_station"):
            raise ApiError(409,"仅对尚待采购的适用订单登记询价")
        actual=o.get("station_name") if o["status"]=="at_station" else o["warehouse"]
        if actual!=origin["name"] or k["model"]!=o["model"] or (k["zip"] and k["zip"]!=o["zip"][:5]):
            raise ApiError(409,"本次询价须使用该单、该段实际起仓、型号与配送 ZIP，缺 ZIP 时可留空登记补件")
        request=dict(k,scope_ref=required(b,"scope_ref",300),owner=required(b,"owner",100),
                     evidence=required(b,"evidence",300),actor=user["username"],at=core.now(),order_version=o["version"])
        rid="RFQ-"+uuid.uuid4().hex[:10].upper()
        db.execute("INSERT INTO tariff_inquiries VALUES(?,?,?,?)",(rid,k["supplier_id"],oid,encode(request)))
        core.event(db,oid,user,"tariff_rfq","逐票询价 "+rid+" · "+request["scope_ref"]+" · 经办 "+request["owner"])
        return {"inquiry":dict(request,id=rid,order_id=oid)}
    if not k["zip"]:
        if b.get("action")=="check":return {"status":"rfq","reason":"本次缺五位 ZIP，需逐票询价","amount":None}
        raise ApiError(400,"有效价卡必须登记五位 ZIP")
    cell=encode([k[n] for n in keys])
    row=db.execute("SELECT * FROM tariffs WHERE cell=?",(cell,)).fetchone()
    if b.get("action")=="save":
        allow(user,CAP_WRITE)
        if row:same_version(row,b)
        data=dict(k,zone=required(b,"zone",80),ref=required(b,"evidence",300),rate_version=required(b,"rate_version",150))
        if data["zone"].casefold() in ("none","n/a","无"):raise ApiError(400,"未覆盖应走逐票询价，不能存成有效价区")
        if b.get("valid_until"):
            try:data["valid_until"]=date.fromisoformat(b["valid_until"]).isoformat()
            except (TypeError,ValueError):raise ApiError(400,"请输入有效截止日期")
        data["amount"]=None if b.get("amount") in (None,"") else float(core.money(b["amount"]))
        next_version=row["version"]+1 if row else 1
        db.execute("INSERT INTO tariffs VALUES(?,?,?) ON CONFLICT(cell) DO UPDATE SET version=excluded.version,data=excluded.data",
                   (cell,next_version,encode(data)))
        audit(db,cell,next_version,user,data)
        return {"tariff":dict(data,version=next_version)}
    if b.get("action")!="check":raise ApiError(400,"未知查价操作")
    if not row:return {"status":"rfq","reason":"起运仓、ZIP、产品及机型无匹配，需逐票询价","amount":None}
    rate=json.loads(row["data"]);valid=rate.get("valid_until","")
    try:service_date=max(core.now()[:10],date.fromisoformat(b.get("on") or core.now()[:10]).isoformat())
    except (TypeError,ValueError):raise ApiError(400,"请填写预计执行日期")
    ok=valid>=service_date and rate["amount"] is not None
    return {"status":"matched" if ok else "rfq","zone":rate["zone"],"amount":rate["amount"] if ok else None,
            "rate_version":rate["rate_version"],"version":row["version"],"valid_until":valid,"evidence":rate["ref"],
            "reason":"仅合同产品参考，须本票接受" if ok else "金额、到期日或执行日待逐票确认"}


def assert_eligible(db, quote, order):
    supplier = entity(db,"supplier",required(quote,"supplier_id"))
    if supplier["qualification"] not in ("S2","S3"):
        raise ApiError(409,"供应商尚未准入或已暂停，请补审")
    row = db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",
                     (order["warehouse"],)).fetchone()
    if not row:
        raise ApiError(409,"实际持货仓 ID 待核")
    date_needed = max(core.now()[:10], (order.get("window_end") or "")[:10])
    snapshots = []
    for action in [order["level"]] + (["L4"] if order.get("addon_l4") else []):
        key = [quote["supplier_id"],required(quote,"executor_id"),required(quote,"product"),
               row[0],order["zip"][:5],order["model"],action]
        match = db.execute("SELECT version,data FROM capability WHERE cell=?", (encode(key),)).fetchone()
        card = json.loads(match["data"]) if match else {}
        if card.get("decision") not in ("Y","C"):
            raise ApiError(409,"实际执行方在该仓、ZIP、机型和动作上的能力未书面核准："+action)
        if min(card["insurance_until"],card["valid_until"]) < date_needed:
            raise ApiError(409,"执行窗口内资质或保险已到期")
        if card["decision"] == "C" and not quote.get("condition_ref"):
            raise ApiError(409,"附条件能力需本票逐项核实凭证："+card["condition"])
        if supplier["qualification"]=="S2" and (
            card.get("trial_limit") is None or quote.get("amount") is None or quote["amount"]>card["trial_limit"]):
            raise ApiError(409,"此票超过限定试单授权额度")
        snapshots.append({"cell":key,"version":match["version"]})
    return snapshots


def replenish(eligible, inbound, confirmed, demand, safety):
    position = eligible + inbound - confirmed
    target = demand + safety
    return {"eligible":eligible,"inbound":inbound,"confirmed":confirmed,"demand":demand,"safety":safety,
            "position":position,"target":target,"suggested":max(0,target-position)}


def stock_plan(db, body, user):
    allow(user,SHIP_READ)
    wh = entity(db,"warehouse",required(body,"warehouse_id"))
    model = required(body,"model")
    try:
        horizon = instant(body["horizon"])
        demand, safety = (int(str(body[k])) for k in ("demand","safety"))
        if min(demand,safety) < 0: raise ValueError()
    except (ValueError,KeyError):
        raise ApiError(400,"请核对截止时间、预测新增需求与安全库存")
    available = [r[0] for r in db.execute("SELECT sn FROM assets WHERE warehouse=? AND model=? "
                   "AND state IN ('available','reserved')",(wh["name"],model))]
    incoming = [r[0] for r in db.execute("""SELECT m.sn FROM manifest m JOIN shipments s ON s.id=m.shipment_id
       WHERE m.model=? AND m.receipt IS NULL AND json_extract(s.data,'$.warehouse_id')=?
       AND json_extract(s.data,'$.warehouse_eta')<=? AND json_extract(s.data,'$.hold')=0
       AND NOT EXISTS(SELECT 1 FROM json_each(s.data,'$.differences') WHERE json_extract(value,'$.kind')='short' AND json_extract(value,'$.sn')=m.sn)
       AND EXISTS(SELECT 1 FROM json_each(s.data,'$.events') WHERE json_extract(value,'$.kind')='loaded')""",
       (model,body["warehouse_id"],horizon))]
    orders = []
    for row in db.execute("""SELECT id,data FROM orders WHERE status IN ('new','ready','dispatched')
       OR (status='exception' AND json_extract(data,'$.previous_status') IN ('new','ready','dispatched'))"""):

        o = json.loads(row["data"])
        if (o["model"],o["warehouse"]) == (model,wh["name"]):
            orders.append({"id":row["id"],"quantity":o["quantity"]})
    return dict(replenish(len(available),len(incoming),sum(o["quantity"] for o in orders),demand,safety),
                eligible_sns=available,inbound_sns=incoming,orders=orders,horizon=horizon)


HEAD_FEES = ("origin_fees","ocean_fees","inland_fees","insurance","brokerage","tax","advance_fee")


def head_quote(db, body, user):
    allow(user, {"admin","procurement","inbound","warehouse"})
    s = shipment(db,required(body,"id"))
    same_version(s,body)
    quote = {k:required(body,k,300) for k in ("vendor","window_ref","unloading","origin_ref","destination_ref","evidence")}
    quote["mode"] = choice(body,"mode",{"FCL","LCL"})
    quote["currency"] = choice(body,"currency",{"USD","CNY"})
    if (quote["origin_ref"],quote["destination_ref"]) != (s["origin"],s["warehouse_id"]):
        raise ApiError(409,"须按同一起运交货点与同一指定仓核价")
    quote["scope"] = [s["origin"],s["warehouse_id"],quote["window_ref"],quote["unloading"],quote["currency"]]
    fees = {k:None if body.get(k) in ("",None) else float(core.money(body[k])) for k in HEAD_FEES}
    quote.update(fees=fees, total=round(sum(fees.values()),2) if all(x is not None for x in fees.values()) else None,
                 known=round(sum(x for x in fees.values() if x is not None),2),actor=user["username"],recorded_at=core.now())
    quote["id"] = "S01Q-"+uuid.uuid4().hex[:10].upper()
    s.setdefault("head_quotes",[]).append(quote)
    return {"shipment":update(db,s,user,quote), "quote":quote}


def discrepancy(db, body, user):
    allow(user, {"admin","warehouse"})
    s = shipment(db,required(body,"id"))
    same_version(s,body)
    if "warehouse_arrival" not in {e["kind"] for e in s["events"]}:
        raise ApiError(409,"请先登记实际到仓")
    kind = choice(body,"kind",{"short","unexpected","damage"})
    sn = required(body,"sn",120).upper()
    u = next((u for u in s["units"] if u["sn"] == sn),None)
    if (kind == "unexpected") == bool(u):
        raise ApiError(400,"错码须填实际发现的其他 SN；短少或货损须关联本批预报 SN")
    if kind=="short" and u["receipt"]:
        raise ApiError(409,"该台已实收，不能按短少登记")
    d = dict(kind=kind,sn=sn,owner=required(body,"owner",120),custodian=required(body,"custodian",120),
             evidence=required(body,"evidence",200),recorded_at=core.now())
    if kind=="damage" and u["receipt"] and u["state"]!="hold":
        if u["state"] not in {"pending_qc","available"}:
            raise ApiError(409,"该台已锁定或交运，请从关联票开 F06 异常并通知当前保管人")
        asset = db.execute("SELECT * FROM assets WHERE sn=?", (sn,)).fetchone()
        values = json.loads(asset["data"])
        values.update(condition="货损 · 待复检",evidence=d["evidence"],custodian=d["custodian"])
        lifecycle.update_asset(db,asset,"hold",user,values,None)
    s.setdefault("differences",[]).append(d)
    return {"shipment":update(db,s,user,d)}


def position(db, body, user):
    """D is a separate approval for unsold stock, never inferred from a station handoff."""
    action = choice(body,"action",{"request","approve","decline","sell"})
    if action=="sell":
        allow(user,{"admin","warehouse"})
        row=db.execute("SELECT * FROM positioning WHERE id=?", (required(body,"id"),)).fetchone()
        if not row or row["state"] not in {"pending","approved","declined","received"}:
            raise ApiError(409,"仅留在原仓或已到目的仓的前置任务可转销售")
        same_version(row,body)
        sn=row["sn"]
        latest=db.execute("SELECT id FROM positioning WHERE sn=? ORDER BY rowid DESC LIMIT 1",(sn,)).fetchone()
        if latest[0]!=row["id"]:
            raise ApiError(409,"该台已有较新的前置任务，请从最新任务办理")
        asset=db.execute("SELECT * FROM assets WHERE sn=?",(sn,)).fetchone()
        order=core.get_order(db,required(body,"order_id"),user)
        core.check_version(order,{"version":body.get("order_version")})
        if (not asset or asset["state"]!="available" or order["status"]!="new" or
            (order["warehouse"],order["model"])!=(asset["warehouse"],asset["model"])):
            raise ApiError(409,"须选实际持货仓、型号相符且待锁机的客户单")
        planned=order.setdefault("positioned_sns",[])
        if len(planned)>=order["quantity"]:
            raise ApiError(409,"客户单需求台数已满")
        d=json.loads(row["data"])
        d.update(sale_order=order["id"],sale_route=order["route"],sale_ref=required(body,"sale_ref",300),
                 sold_from=asset["warehouse"],previous_state=row["state"])
        db.execute("UPDATE positioning SET state='sold',version=version+1,data=? WHERE id=?",(encode(d),row["id"]))
        planned.append(sn)
        order=core.save(db,order,user,"position_sale",encode(dict(sn=sn,task=row["id"],sale_ref=d["sale_ref"])))
        audit(db,row["id"],row["version"]+1,user,dict(d,state="sold"))
        return {"state":"sold","order":order}
    if action=="request":
        allow(user,{"admin","warehouse"})
        sn = required(body,"sn").upper()
        asset=db.execute("SELECT * FROM assets WHERE sn=?", (sn,)).fetchone()
        if not asset or asset["state"]!="available" or asset["order_id"]:
            raise ApiError(409,"D 只能申请未售、未锁定的合格实物")
        if sold_order(db,sn):
            raise ApiError(409,"该台已有未取消的销售需求，不能再次按未售备货")
        same_version(asset,body)
        target=entity(db,"warehouse",required(body,"target_id"))
        if asset["warehouse"]==target["name"]:
            raise ApiError(409,"前置仓须与原仓不同")
        d = dict(source=asset["warehouse"],target_id=body["target_id"],warehouse=target["name"],
                 asset_version=asset["version"],requested_by=user["username"],
                 storage_right_ref=required(body,"storage_right_ref"),evidence=required(body,"evidence"))
        rid="D-"+uuid.uuid4().hex[:10].upper()
        try: db.execute("INSERT INTO positioning VALUES(?,?,1,'pending',?)",(rid,sn,encode(d)))
        except sqlite3.IntegrityError: raise ApiError(409,"该 SN 已有待办的前置申请")
        audit(db,rid,1,user,d)
        return {"id":rid,"state":"pending"}
    allow(user,{"admin"})
    row=db.execute("SELECT * FROM positioning WHERE id=?",(required(body,"id"),)).fetchone()
    if not row or row["state"]!="pending":
        raise ApiError(409,"申请不是待批状态")
    same_version(row,body)
    d=json.loads(row["data"])
    if d["requested_by"]==user["username"]:
        raise ApiError(403,"须由另一名授权人审批")
    d.update(approval_ref=required(body,"approval_ref"),reviewed_by=user["username"])
    state="approved" if action=="approve" else "declined"
    db.execute("UPDATE positioning SET state=?,version=version+1,data=? WHERE id=?",(state,encode(d),row["id"]))
    audit(db,row["id"],row["version"]+1,user,dict(d,state=state))
    return {"id":row["id"],"state":state}


def sold_order(db,sn):
    row=db.execute("""SELECT o.id FROM positioning p JOIN orders o ON o.id=json_extract(p.data,'$.sale_order')
                      WHERE p.sn=? AND p.state='sold' AND o.status!='cancelled' LIMIT 1""",(sn,)).fetchone()
    return row[0] if row else None


def transfer(db, body, user):
    allow(user, {"admin","warehouse"})
    sn = required(body,"sn").upper()
    row = db.execute("SELECT * FROM assets WHERE sn=?",(sn,)).fetchone()
    if not row:
        raise ApiError(404,"实物 SN 不存在")
    same_version(row,body)
    data = json.loads(row["data"])
    evidence = required(body,"evidence",300)
    custody = required(body,"custodian",300)
    action = choice(body,"action",{"send","accept"})
    if action=="send":
        if row["state"]!="available" or row["order_id"]:
            raise ApiError(409,"仅未占用的合格现货能申请调拨")
        if sold_order(db,sn):
            raise ApiError(409,"该台已转入销售单，请从该单办理锁机与交运")
        target = entity(db,"warehouse",required(body,"target_id"))
        if target["name"] == row["warehouse"]:
            raise ApiError(409,"调出和调入仓不能相同")
        pos_row=db.execute("SELECT * FROM positioning WHERE sn=? AND state IN ('pending','approved')",(sn,)).fetchone()
        if pos_row:
            pos=json.loads(pos_row["data"])
            if (pos_row["state"]!="approved" or pos["target_id"]!=body["target_id"] or
                    pos["asset_version"]!=row["version"] or body.get("approval_ref")!=pos["approval_ref"]):
                raise ApiError(409,"未售前置的仓点、实物版本与已批授权不符")
            data["position_id"]=pos_row["id"]
            db.execute("UPDATE positioning SET state='moving',version=version+1 WHERE id=?",(pos_row["id"],))
        data.update(target_id=body["target_id"],target_warehouse=target["name"],
                    transfer_approval=required(body,"approval_ref",300))
        state = "transfer"
    else:
        if row["state"]!="transfer":
            raise ApiError(409,"该台没有待接收的调拨")
        state = choice(body,"state",{"available","hold"})
        data.update(bin=required(body,"bin",200),condition=required(body,"condition",300))
        db.execute("UPDATE assets SET warehouse=? WHERE sn=?",(data.pop("target_warehouse"),sn))
        data.pop("target_id")
        if data.get("position_id"):
            db.execute("UPDATE positioning SET state='received',version=version+1 WHERE id=?",(data.pop("position_id"),))
        row = db.execute("SELECT * FROM assets WHERE sn=?", (sn,)).fetchone()
    data.update(custodian=custody,evidence=evidence)
    return {"asset":lifecycle.update_asset(db,row,state,user,data,None)}


def handle(db,method,path,body,user):
    action = path.rsplit("/",1)[-1]
    if method=="POST":
        if action=="receipt-photo":
            allow(user, {"admin","warehouse","inbound","dispatch"})
            record=db.execute("SELECT p.mime,p.content FROM receipt_photos p JOIN manifest m ON m.sn=p.sn WHERE m.shipment_id=? AND m.sn=?",
                              (required(body,"id"),required(body,"sn"))).fetchone()
            if not record:
                raise ApiError(404,"未找到本批次该台设备的照片")
            return {"mime":record["mime"],"base64":base64.b64encode(record["content"]).decode("ascii")}
        handlers = {"book":book,"milestone":milestone,"schedule":schedule,"receive":receive,"qualify":qualify,"tariff":tariff,"stock-plan":stock_plan,"transfer":transfer,"position":position,
                    "head-quote":head_quote,"difference":discrepancy,"candidates":register_sailings,
                    "preview-eta":preview_eta,"close-review":close_review}
        if action in handlers:
            return handlers[action](db,body,user)
    if method=="GET" and action=="candidates":
        allow(user, SHIP_READ)
        return {"candidates":[dict(json.loads(r["data"]),id=r["id"])
                              for r in db.execute("SELECT * FROM sailing_options ORDER BY rowid DESC")]}
    if method=="GET" and action=="shipments":
        allow(user,SHIP_READ)
        shipments=[shipment(db,r[0]) for r in db.execute("SELECT id FROM shipments ORDER BY rowid DESC")]
        if user["role"] == "sales":
            for item in shipments:
                item.pop("head_quotes",None)
        return {"shipments":shipments}
    if method=="GET" and action=="positions":
        allow(user, {"admin","warehouse","dispatch","finance"})
        return {"positions":[dict(json.loads(r["data"]),id=r["id"],state=r["state"],sn=r["sn"],version=r["version"])
                 for r in db.execute("SELECT * FROM positioning ORDER BY rowid DESC")]}
    if method=="GET" and action=="inquiries":
        allow(user,CAP_READ)
        return {"inquiries":[dict(json.loads(r["data"]),id=r["id"],order_id=r["order_id"])
                             for r in db.execute("SELECT * FROM tariff_inquiries ORDER BY rowid DESC")]}
    if method=="GET" and action=="cards":
        allow(user,CAP_READ)
        return {"cards":[dict(json.loads(r["data"]),version=r["version"]) for r in db.execute("SELECT * FROM capability")]}
    raise ApiError(404,"未找到此作业入口")
