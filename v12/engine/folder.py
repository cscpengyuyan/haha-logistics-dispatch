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
    if role in {"admin", "finance", "dispatch", "procurement"}:
        quotes = [{**json.loads(r["data"]), "id":r["id"],"version":r["version"]} for r in db.execute(
            "SELECT id,version,data FROM registry WHERE type='quote' AND json_extract(data,'$.order_id')=? ORDER BY rowid DESC", (oid,))]
    assets = None if role == "driver" else [{**json.loads(r["data"]), **{k:r[k] for k in ("sn","state","warehouse","model")}}
                for r in db.execute("""SELECT sn,state,warehouse,model,data FROM assets a WHERE order_id=? OR EXISTS
                    (SELECT 1 FROM after_cases c WHERE c.order_id=? AND c.sn=a.sn AND c.kind='rma'
                     AND json_extract(c.data,'$.redelivery_order_id')=a.order_id) ORDER BY sn""",(oid,oid))]
    cases = None if role not in OFFICE else [{**json.loads(r["data"]), "id":r["id"],"sn":r["sn"],"kind":r["kind"],"state":r["state"]}
             for r in db.execute("SELECT id,sn,kind,state,data FROM after_cases WHERE order_id=? ORDER BY rowid DESC", (oid,))]
    attempts = rows(db,"SELECT ordinal,arrival_local,timezone,outcome,data,actor,ts FROM delivery_attempts WHERE order_id=? ORDER BY ordinal", (oid,))
    for r in attempts:
        r.update(json.loads(r.pop("data")))
    platform = db.execute("SELECT state,data FROM platform_receipts WHERE order_id=?", (oid,)).fetchone() if role != "driver" else None
    return {"pending_sns":sorted(pending_sns(o)), "version":o["version"], "quotes":quotes, "assets":assets, "cases":cases, "attempts":attempts,
            "receipt":{**json.loads(platform["data"]), "state":platform["state"]} if platform else None,
            "rights":rights(o,role)}


def ordered_sns(order):
    return {s.strip().upper() for s in re.split(r"[,，;；\r\n]+",order.get("sn","")) if s.strip()}


def pending_sns(order):
    return ordered_sns(order) - set(order.get("completed_sns", []))


def assert_attempt_resolved(db, order):
    if not ordered_sns(order) or pending_sns(order):
        raise ApiError(409, "仍缺逐台交接记录或本次授权未送成，请登记剩余 SN 和对应 POD")


def service_units(order, body):
    previous = {u["sn"]: u for u in order.get("service_units", [])}
    pending = ordered_sns(order) - {sn for sn,u in previous.items() if u.get("state","passed")=="passed"}
    records = body.get("service_units")
    if not isinstance(records,list) or not records:
        raise ApiError(400,"请逐台登记本次复测结果及客户确认")
    for unit in records:
        sn=required(unit,"sn",300).upper()
        state=unit.get("state","passed")
        if sn not in pending or state not in {"passed","parts_pending"}:
            raise ApiError(409,"SN 已完成、重复、不在本单内，或技术状态无效")
        pending.remove(sn)
        previous[sn]=dict(sn=sn,state=state,result=required(unit,"result"),customer_ref=required(unit,"customer_ref"))
    return list(previous.values())


def technical(db, order, body, user):
    from core import money
    if user["role"] not in {"admin","dispatch","procurement"}:
        raise ApiError(403,"技术委托须由采购或调度确认")
    if not order.get("addon_l5") or order["status"] not in {"new","ready","delivered"} or order.get("result_ref"):
        raise ApiError(409,"只能为已购且尚未完成的技术动作建立委托")
    previous=order.get("technical_order")
    if previous and order["status"]!="delivered":
        raise ApiError(409,"已有有效 T5 委托")
    if previous:
        reason=required(body,"change_reason")
        order.setdefault("technical_history",[]).append(dict(previous,state="superseded",change_reason=reason))

    item = {k:required(body,k) for k in ("executor_id","acceptance_ref","scope")}
    import supply
    item.update(amount=float(money(body.get("amount"))), id=order["id"]+"-T5", state="accepted",
                product="T5",supplier_id=required(body,"supplier_id"),condition_ref=body.get("condition_ref",""))
    item["capability_snapshot"]=supply.assert_eligible(db,item,dict(order,level="L5",addon_l4=False))
    item["version"]=(previous or {}).get("version",0)+1
    order["technical_order"]=item
    return save(db,order,user,"technical_order",encode(item))


def platform_instruction(db,order,body,user):
    if user["role"] not in {"admin","dispatch","procurement"}:
        raise ApiError(403,"指定承运指令须由采购或调度核实")
    if order.get("procurement_mode") not in {"platform","ltl","brand_fleet"} or order["status"] not in {"ready","new"} or order.get("pickup"):
        raise ApiError(409,"非平台指定承运，或已签发")
    from review import scope_snapshot, day
    item={k:required(body,k) for k in ("account_ref","instruction_ref","executor_id","carrier","acceptance_ref","valid_until")}
    mode=order["procurement_mode"]
    if mode=="brand_fleet":
        from core import money
        if user["role"]!="admin":
            raise ApiError(403,"品牌自有车队调度与内部分摊须主管批准")
        item.update(allocation=float(money(body.get("allocation"))),cost_center=required(body,"cost_center"),kind="internal")
    else:
        item.update(bol_ref=required({**body,"bol_ref":body.get("bol_ref") or body.get("bol_pro")},"bol_ref"),pickup_ref=required(body,"pickup_ref"),identity_ref=required(body,"identity_ref"),kind=mode)
    day(item["valid_until"])
    item["scope_snapshot"]=scope_snapshot(order)
    if mode=="brand_fleet":
        item.update(supplier_id=item["executor_id"],product="T2",payee_id="INTERNAL")
        order["internal_instruction"]=item
    order["platform_instruction"]=item
    return save(db,order,user,"platform_instruction",encode(item))


def station_mandate(db,o,body,user):
    if user["role"] not in {"admin","procurement","dispatch"} or o["route"]!="C2" or o["status"]!="ready":
        raise ApiError(403,"仅限 C2 首段签发前登记站点书面接收")
    if o.get("second_leg") or o.get("station_mandate"):
        raise ApiError(409,"本票已有接站资料，请按同一站点核准二程")
    set_station_mandate(db,o,body)
    return save(db,o,user,"station_mandate",encode(o["station_mandate"]))


def set_station_mandate(db,o,body):
    from supply import entity
    mandate={k:required(body,k) for k in ("station_id","station_supplier_id","station_executor_id","station_acceptance_ref")}
    station=entity(db,"warehouse",mandate["station_id"])
    if not station.get("zip"):
        raise ApiError(409,"登记接收站实际五位 ZIP 后才能核储存能力")
    mandate.update(station_zip=station["zip"],station_name=station["name"])
    o["station_mandate"]=mandate
    assert_station_authority(db,o)


def second_leg(db,o,body,user):
    from core import money
    from supply import entity,assert_eligible
    from review import day,scope_snapshot
    if user["role"] not in {"admin","procurement","dispatch"}:
        raise ApiError(403,"二程选择和改派须由采购或调度办理")
    if o["route"] not in {"C1","C2"} or o["status"] not in {"ready","at_station"}:
        raise ApiError(409,"二程只可在首次签发前或驻站时重新委托")
    old=o.get("second_leg")
    if o["status"]=="at_station" and not o.get("station_receipts"):
        raise ApiError(409,"驻站旧单缺逐台接收凭据，请补核后再派")
    item={k:required(body,k) for k in ("supplier_id","executor_id","product","carrier","acceptance_ref",
                                        "approved_ref","quote_ref","valid_until","station_id")}
    item["condition_ref"]=body.get("condition_ref","")
    station=entity(db,"warehouse",item["station_id"])
    if o["status"]=="ready":
        if not o.get("station_mandate"):
            set_station_mandate(db,o,body)
        elif o["station_mandate"]["station_id"]!=item["station_id"]:
            raise ApiError(409,"二程起仓须与本票书面接站库址一致")
        else:
            assert_station_authority(db,o)
    if o["status"]=="at_station" and station["name"]!=o.get("station_name"):
        raise ApiError(409,"二程须从本票已实际签收的站点重新放行")
    supplier=entity(db,"supplier",item["supplier_id"])
    if item["carrier"]!=supplier["name"]:raise ApiError(409,"二程合同方名称与所选稳定主体不符")
    if day(item["valid_until"])<max(now()[:10],o.get("window_end","")[:10]):
        raise ApiError(409,"二程承接已过期或未覆盖窗口")
    item["amount"]=float(money(body.get("amount")))
    item.update(scope_snapshot=scope_snapshot(o),station_name=station["name"])
    assert_eligible(db,item,dict(o,warehouse=station["name"]))
    if old and o.get("station_pending"):
        raise ApiError(409,"请先撤销二程未执行授权并释放原班时段，再确认备援委托")
    if old:
        if old["station_id"]!=item["station_id"] and o["status"]=="at_station":
            raise ApiError(409,"已交入的实物不可随改派变更站点")
        item["change_reason"]=required(body,"change_reason")
    item["ordinal"]=1+int(old["ordinal"] if old else 0)
    item["payee_id"]=o.get("selected_quote",{}).get("supplier_id") if o["route"]=="C1" else item["supplier_id"]
    if o["route"]=="C1" and not item["payee_id"]:raise ApiError(409,"C1 须先确认主合同委托及应付主体")
    if old:
        prior=dict(old,state="revoked",revoked_by=user["username"],reason=item["change_reason"])
        o.setdefault("second_leg_history",[]).append(prior)
        if o["route"]=="C2" and o["status"]=="at_station":
            original=money(o["approved_cost"])
            waived=money(old["amount"]) if body.get("waiver_ref") else money(0)
            storage=money(body.get("storage_cost",0))
            revised=original-waived+money(item["amount"])+storage
            item.update(waiver_ref=body.get("waiver_ref",""),disputed=float(money(old["amount"])-waived),storage_cost=float(storage))
            o["c2_replacement"]=dict(previous=float(original),credited=float(waived),replacement=item["amount"],
                station_increment=float(storage),budget=float(revised),disputed=item["disputed"])
            o["approved_cost"]=float(revised)
    item.update(state="accepted",actor=user["username"])
    o["second_leg"]=item
    return save(db,o,user,"second_leg",encode(item))


def assert_second_leg(db,o,body):
    import supply
    from review import scope_snapshot
    leg=o.get("second_leg",{})
    if not leg or not o.get("station_receipts") or leg.get("state")!="accepted":
        raise ApiError(409,"二程缺书面委托、接受或逐台驻站交接，请由采购重新委托")
    if body.get("carrier")!=leg["carrier"] or leg["station_name"]!=o["station_name"]:
        raise ApiError(409,"二程实际承运和起点须匹配驻站有效委托")
    if leg["scope_snapshot"]!=scope_snapshot(o) or leg["valid_until"]<max(now()[:10],o["window_end"][:10]):
        raise ApiError(409,"二程委托已失效，请复核窗口与范围")
    supply.assert_eligible(db,leg,dict(o,warehouse=o["station_name"]))
    o["executor_id"]=leg["executor_id"]


def assert_station_authority(db,o):
    import supply
    m=o.get("station_mandate") or {}
    product=dict(supplier_id=m.get("station_supplier_id"),executor_id=m.get("station_executor_id"),product="T3",amount=0,
                 condition_ref=m.get("station_acceptance_ref"))
    supply.assert_eligible(db,product,dict(o,warehouse=m.get("station_name"),zip=m.get("station_zip",""),level="receive",addon_l4=False))


def station_receipts(db,o,body):
    assert_station_authority(db,o)
    facts=body.get("units")
    if not isinstance(facts,list):raise ApiError(409,"请逐台登记在站签收、状态及凭证")
    pending=ordered_sns(o)
    result=[]
    for fact in facts:
        if not isinstance(fact,dict):raise ApiError(400,"逐台站收记录无效")
        sn=required(fact,"sn").upper()
        if sn not in pending:raise ApiError(409,"站收 SN 重复或不在本单")
        pending.remove(sn)
        result.append(dict(sn=sn,condition=required(fact,"condition"),evidence=required(fact,"evidence")))
    if pending:raise ApiError(409,"尚有未登记的站收 SN")
    if o["station_mandate"]["station_name"]!=body.get("station_name"):
        raise ApiError(409,"实际站点与二程委托起点不符")
    o["station_mandate"]["signed_by"]=body.get("custodian")
    o["station_receipts"]=result
    o["first_leg_receipt"]=dict(driver=o.get("driver"),executor_id=o.get("executor_id"),
        carrier=o.get("carrier"),issue_version=o.get("issue_version"),dispatch_ref=o.get("dispatch_ref"),units=result)


def add_attempt(db,o,body,user):
    from core import check_issue
    import lifecycle
    if not rights(o,user["role"])["attempt"]:
        raise ApiError(403,"当前岗位或交付环节不能登记尝试")
    if o.get("pickup"):
        if not o.get("pickup_gate"):
            raise ApiError(409,"仓门须先核提货人、车辆净开口、实物外廓和固定")
    else:
        check_issue(o,body)
    arrival=localtime(required(body,"arrival_local"),"arrival_local")
    finished=localtime(required(body,"finished_local"),"finished_local")
    if finished < arrival:raise ApiError(400,"本次作业结束不能早于到场时刻")
    previous=db.execute("SELECT ordinal,data FROM delivery_attempts WHERE order_id=? ORDER BY ordinal DESC LIMIT 1",(o["id"],)).fetchone()
    if previous and arrival < json.loads(previous["data"])["finished_local"]:
        raise ApiError(409,"新尝试应在上次作业结束后")
    pending=pending_sns(o)
    units=body.get("units")
    if not pending or not isinstance(units,list) or len(units)!=len(pending):
        raise ApiError(409,"本次只处理所有尚欠交的 SN，已交台不得重复作业")
    facts=[]
    completed=set(o.get("completed_sns",[]))
    for unit in units:
        if not isinstance(unit,dict):raise ApiError(400,"逐台记录格式错误")
        sn=required(unit,"sn",300).upper()
        outcome=required(unit,"outcome",20)
        if sn not in pending or outcome not in {"success","partial","failed"}:
            raise ApiError(400,"SN 重复、已完成、不属于本票或结果无效")
        pending.remove(sn)
        fact=dict(sn=sn,outcome=outcome,details=required(unit,"details"),location=required(unit,"location"))
        if outcome=="success":
            pod=unit.get("pod_id")
            if type(pod)!=int or not db.execute("SELECT 1 FROM files WHERE order_id=? AND category='pod' AND id=?",(o["id"],pod)).fetchone():
                raise ApiError(409,"成功交接的每台 SN 须关联本票有效 POD")
            if fact["location"]!=o["endpoint"]:
                raise ApiError(409,"成功交接位置须与签发终点一致；未到位请登记部分完成")
            fact["pod_id"]=pod
            completed.add(sn)
        facts.append(fact)
    results={u["outcome"] for u in facts}
    outcome=next(iter(results)) if len(results)==1 else "partial"
    data={k:required(body,k) for k in ("location","evidence")}
    data.update(units=facts,finished_local=finished,release_version=o.get("issue_version"),
                assignment_id=o.get("gate_grant_id"), driver=o.get("driver"), executor_id=o.get("executor_id"),
                vehicle_id=(o.get("release_route") or {}).get("resource_id"), crew_id=(o.get("release_route") or {}).get("crew_id"),
                carrier_ref=(o.get("platform_instruction") or {}).get("bol_ref"),
                leg="仓内自提" if o.get("pickup") else "二程" if o["status"]=="last_mile" else "直送")
    if not o.get("pickup"):
        import gate
        gate.require_released(db,o)
        grant=gate.active(db,o["id"],o.get("gate_leg",1))
        data.update(assignment_version=grant["version"],actual_plate=grant.get("plate"),handover_ref=grant.get("release_ref"))
    if outcome!="success":
        data.update(next_step=required(body,"next_step"),custodian=required(body,"custodian"))
    for fact in facts:
        if fact["outcome"]!="success":continue
        row=db.execute("SELECT * FROM assets WHERE sn=? AND order_id=?", (fact["sn"],o["id"])).fetchone()
        if not row or row["state"] not in {"reserved","transit"}:
            raise ApiError(409,"交接实物保管状态有变，请核对 SN")
        custody=json.loads(row["data"])
        custody.update(custody_ref=data["evidence"],custodian=o["customer"],location=fact["location"],pod_id=fact["pod_id"])
        lifecycle.update_asset(db,row,"delivered",user,custody,o["id"])
    o["completed_sns"]=sorted(completed)
    o["physical_progress"]="complete" if not pending_sns(o) else "partial" if completed else "open"
    ordinal=previous["ordinal"]+1 if previous else 1
    db.execute("INSERT INTO delivery_attempts(order_id,ordinal,arrival_local,timezone,outcome,data,actor,ts) VALUES(?,?,?,?,?,?,?,?)",
               (o["id"],ordinal,arrival,o["timezone"],outcome,encode(data),user["username"],now()))
    return save(db,o,user,"attempt",f"第 {ordinal} 次 · {len(completed)}/{o['quantity']} 台已交 · {data['evidence']}")


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
        release=o.get("channel_release") or {}
        if release.get("channel")=="amazon" and release["shipment_ref"]!=saved["shipment_ref"]:
            raise ApiError(409,"平台货件号与本票 F04 发运凭据不一致")
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
    match=re.fullmatch(r"/api/ops/folder/([a-zA-Z0-9_-]+)(?:/(attempts|receipts|technical|platform-instruction|second-leg|station-mandate))?",path)
    if not match:
        raise ApiError(404,"作业夹接口不存在")
    oid,sub=match.groups()
    order=get_order(db,oid,user)
    if method=="GET" and not sub:
        return get_folder(db,order,user)
    if method=="POST" and sub:
        if order.get("sales_review_pending") and sub in {"platform-instruction","second-leg","station-mandate","technical"}:
            raise ApiError(409,"销售范围变更待物流复核，禁止签订新委托")
        check_version(order,body)
        return {"order":{"attempts":add_attempt,"receipts":record_receipt,"technical":technical,"platform-instruction":platform_instruction,"second-leg":second_leg,"station-mandate":station_mandate}[sub](db,order,body,user)}
    raise ApiError(405,"作业夹操作不支持此方法")

