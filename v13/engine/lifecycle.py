"""Individual equipment custody and conditional recovery, claims, and RMA cases."""
import json
import re
import sqlite3
import uuid
from core import ApiError, encode, get_order, money, now, required

CASE_EDITORS = {"restore": {"service", "dispatch"}, "claim": {"service", "dispatch", "finance"},
                "rma": {"service", "warehouse", "finance"}}
CASE_READERS = {"admin", "warehouse", "dispatch", "finance", "service"}
FLOW = {
    "restore": [("open","authorized","授权处理",("strategy","approval_ref","next_step")),
                ("authorized","closed","恢复验收",("test_result","customer_ref","recovered_at"))],
    "claim": [("open","filed","正式提交",("claimant","carrier","claim_amount","delivery_ref")),
              ("filed","decided","取得书面裁定",("approved_amount","decision_ref")),
              ("decided","closed","核实到账／未赔",("received_amount","payment_ref","gap_note"))],
    "rma": [("open","authorized","退回授权",("approval_ref","return_to","part_ref")),
            ("authorized","shipped","交寄／回运",("tracking","custodian")),
            ("shipped","received","收货与查验",("receipt_ref","inspection")),
            ("received","closed","结清实物及贷项",("credit_amount","credit_ref","disposition"))]
}


def init_db(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS repair_bench (
            warehouse_id TEXT NOT NULL,model TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,
            PRIMARY KEY(warehouse_id,model));
        CREATE TABLE IF NOT EXISTS assets(sn TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,
            warehouse TEXT NOT NULL,model TEXT NOT NULL,order_id TEXT REFERENCES orders(id),data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS assets_order ON assets(order_id);
        CREATE TABLE IF NOT EXISTS after_cases(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,
            kind TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),sn TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS life_log(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,item TEXT NOT NULL,
            version INTEGER NOT NULL,actor TEXT NOT NULL,ts TEXT NOT NULL,snapshot TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS life_log_item ON life_log(kind,item,id);
    """)
    # Upgrade orders already carrying SN locks. Custody is derived; preserve the uncertainty for review.
    rows = db.execute("""SELECT l.sn,l.order_id,o.data,o.status FROM sn_locks l JOIN orders o ON o.id=l.order_id
        LEFT JOIN assets a ON a.sn=l.sn WHERE a.sn IS NULL""").fetchall()
    for row in rows:
        order = json.loads(row["data"])
        status = order.get("previous_status") if row["status"] == "exception" else row["status"]
        state = {"in_transit":"transit","at_station":"station","last_mile":"transit",
                 "delivered":"delivered","settled":"delivered"}.get(status,"reserved")
        data = {"bin":"待仓库复核","condition":"历史放行记录","batch":"历史订单迁入",
                "evidence":order.get("release_ref","待复核"),"updated_at":now()}
        inserted = db.execute("INSERT OR IGNORE INTO assets VALUES(?,1,?,?,?,?,?)",
                              (row["sn"],state,order["warehouse"],order["model"],row["order_id"],encode(data)))
        if inserted.rowcount:
            log(db,"assets",row["sn"],1,{"username":"migration"},dict(data,state=state,order_id=row["order_id"]))


def log(db,kind,item,version,user,data):
    db.execute("INSERT INTO life_log(kind,item,version,actor,ts,snapshot) VALUES(?,?,?,?,?,?)",
               (kind,item,version,user["username"],now(),encode(data)))


def row_obj(row):
    return {**json.loads(row["data"]),**{k:row[k] for k in row.keys() if k != "data"}}


def expect_version(row, body):
    if type(body.get("version")) is not int or body.get("version") != row["version"]:
        raise ApiError(409,"记录已被更新，请刷新后重新核对")


def receipt(db,body,user, *, from_manifest=False):
    if user["role"] not in {"admin","warehouse"}:
        raise ApiError(403,"需要仓库岗位")
    keys = ("sn","warehouse","model","bin","condition","batch","evidence")
    data={k:required(body,k,300) for k in keys}
    sn = data.pop("sn").upper()
    if not from_manifest and db.execute("SELECT 1 FROM sqlite_master WHERE name='manifest'").fetchone() and db.execute("SELECT 1 FROM manifest WHERE sn=?", (sn,)).fetchone():
        raise ApiError(409,"该 SN 已在海运预报中，请从关联 ASN 逐台验收")
    if re.search(r"[;,，；、\s]",sn):
        raise ApiError(400,"逐台入账，请输入单个无空格或分隔符的 SN")
    state = body.get("state")
    if state not in {"pending_qc","available","hold"}:
        raise ApiError(400,"实收时请选择待质检、验合格或隔离")
    # Origin warehouse remains authoritative for matching a new reservation.
    warehouse,model = data.pop("warehouse"),data.pop("model")
    data["received_at"] = data["updated_at"] = now()
    data["custodian"] = str(body.get("custodian") or user["username"])[:300]
    if from_manifest and body.get("packing"):
        data["packing"] = body["packing"]
    if body.get("free_until"):
        from datetime import date
        try:
            data["free_until"] = date.fromisoformat(body["free_until"]).isoformat()
        except (ValueError,TypeError):
            raise ApiError(400,"请填写仓库当地免仓截止日期")
    try:
        db.execute("INSERT INTO assets VALUES(?,1,?,?,?,NULL,?)",(sn,state,warehouse,model,encode(data)))
    except sqlite3.IntegrityError:
        raise ApiError(409,"该 SN 已入账。请更新已有实物记录")
    obj = dict(data,sn=sn,state=state,version=1,warehouse=warehouse,model=model,order_id=None)
    log(db,"assets",sn,1,user,obj)
    return obj


def update_asset(db,row,state,user,data,order_id):
    version = row["version"]+1
    data["updated_at"] = now()
    db.execute("UPDATE assets SET version=?,state=?,order_id=?,data=? WHERE sn=?",
               (version,state,order_id,encode(data),row["sn"]))
    obj = dict(data,state=state,version=version,sn=row["sn"],order_id=order_id,
               model=row["model"],warehouse=row["warehouse"])
    log(db,"assets",row["sn"],version,user,obj)
    return obj


def inspect_asset(db,body,user):
    if user["role"] not in {"admin","warehouse"}:
        raise ApiError(403,"需要仓库岗位")
    sn=required(body,"sn").upper()
    row=db.execute("SELECT * FROM assets WHERE sn=?",(sn,)).fetchone()
    if not row:
        raise ApiError(404,"设备不存在")
    expect_version(row,body)
    if json.loads(row["data"]).get("count_open"):
        raise ApiError(409,"本台盘点差异待核，须由另一管理岗凭授权更正")
    if row["state"] not in {"pending_qc","available","hold"} or body.get("state") not in {"available","hold"}:
        raise ApiError(409,"已锁定或交运的设备不能更改在库状态，请先处理订单交接")
    fields={k:required(body,k,300) for k in ("bin","condition","evidence")}
    return update_asset(db,row,body["state"],user,{**json.loads(row["data"]),**fields},None)


def reserve(db, order, serials, user):
    if not set(order.get("positioned_sns",[]))<=set(serials):
        raise ApiError(409,"本票有已售前置 SN，请按销售回执核对该台实物")
    for sn in serials:
        row=db.execute("SELECT * FROM assets WHERE sn=?",(sn,)).fetchone()
        if row is None or row["state"]!="available" or row["warehouse"]!=order["warehouse"] or row["model"]!=order["model"]:
            raise ApiError(409,f"设备 {sn} 尚未实收验合格、已锁定，或与本票仓库／型号不一致")
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='positioning'").fetchone():
            task=db.execute("SELECT state,json_extract(data,'$.sale_order') FROM positioning WHERE sn=? ORDER BY rowid DESC LIMIT 1",(sn,)).fetchone()
            if task and task[0] in {"pending","approved"}:
                raise ApiError(409,"该台有未结前置任务，请先办理 D 转销售")
            if task and task[0]=="sold" and task[1]!=order["id"] and db.execute(
                    "SELECT 1 FROM orders WHERE id=? AND status!='cancelled'",(task[1],)).fetchone():
                raise ApiError(409,"该台已由前置任务转入另一张销售订单")
        data=json.loads(row["data"])
        data["custody_ref"]=order["release_ref"]
        update_asset(db,row,"reserved",user,data,order["id"])


def move(db, order, state, user, custody_ref):
    rows=db.execute("SELECT * FROM assets WHERE order_id=?",(order["id"],)).fetchall()
    if len(rows)!=order["quantity"]:
        raise ApiError(409,"本票实物台账数量不符，请仓库核对")
    for row in rows:
        data=json.loads(row["data"])
        data["custody_ref"]=custody_ref
        data["custodian"] = {
            "available":order["warehouse"], "transit":order.get("driver") or order.get("custodian") or order.get("carrier",""),
            "station":order.get("custodian",""), "delivered":order.get("signer","")
        }.get(state,"")
        if state=="station":
            data["station_name"]=order.get("station_name","")
        update_asset(db,row,state,user,data,None if state=="available" else order["id"])


def case_permissions(kind, state, role, data=None):
    target=next((s for s in FLOW[kind] if s[0]==state),None)
    if not target or (role!="admin" and role not in CASE_EDITORS[kind]):
        return None
    if role!="admin":
        if kind=="restore" and role!="service":
            return None
        if kind=="claim" and target[1]=="closed" and role!="finance":
            return None
        if kind=="rma" and ((target[1]=="closed" and role!="finance") or
                            (target[1]=="received" and role!="warehouse") or
                            (target[1] in {"authorized","shipped"} and role=="finance")):
            return None
    fields=list(target[3])
    if kind=="rma" and (data or {}).get("item_type")=="machine" and target[1]=="authorized":
        fields.extend(["receiver_id","receiver_acceptance","protection_ref","redelivery_ref"])
    return {"to":target[1],"label":target[2],"fields":fields}


def case_view(row,user):
    obj=row_obj(row)
    obj["next"]=case_permissions(row["kind"],row["state"],user["role"],json.loads(row["data"]))
    return obj


def make_case(db,body,user):
    kind=required(body,"kind",20)
    if kind not in FLOW or (user["role"]!="admin" and user["role"] not in CASE_EDITORS[kind]):
        raise ApiError(403,"此岗位不能开启该类工单")
    order=get_order(db,required(body,"order_id"),user)
    sn=required(body,"sn",300).upper()
    linked=db.execute("SELECT 1 FROM assets WHERE sn=? AND order_id=?", (sn,order["id"])).fetchone()
    if not linked:
        raise ApiError(400,"工单 SN 须关联本订单已分配的实物")
    data={k:required(body,k) for k in ("issue","custodian","owner","next_step","due","evidence")}
    from core import localtime
    localtime(data["due"],"due")
    if kind=="rma":
        item_type=body.get("item_type")
        if item_type not in {"part","machine"}:
            raise ApiError(400,"RMA 工单请区分零部件与整机")
        data["item_type"]=item_type
        purpose=required(body,"purpose",40)
        if purpose not in {"repair","commercial"}:raise ApiError(400,"请区分维修移运与商业退回")
        data.update(purpose=purpose,reason_ref=required(body,"reason_ref"))
        if purpose=="repair" and item_type=="machine":
            restore=db.execute("SELECT * FROM after_cases WHERE id=? AND order_id=? AND sn=? AND kind='restore'",(data["reason_ref"],order["id"],sn)).fetchone()
            if not restore or restore["state"]!="authorized" or json.loads(restore["data"]).get("strategy")!="machine":
                raise ApiError(409,"只有已批准整机移修的恢复工单才能签发维修 RMA")
        if purpose=="commercial":
            data["seller_approval"]=required(body,"seller_approval")
        if item_type=="machine":
            state=db.execute("SELECT state FROM assets WHERE sn=?",(sn,)).fetchone()["state"]
            if state!="delivered":
                raise ApiError(409,"整机回运须先核实交付保管状态，处理原运输单异常后再开启")
            if db.execute("""SELECT 1 FROM after_cases WHERE sn=? AND kind='rma' AND state!='closed'
                AND json_extract(data,'$.item_type')='machine'""",(sn,)).fetchone():
                raise ApiError(409,"本机已有未结整机退运单")
    data["timezone"]=order["timezone"]
    data["updated_at"]=now()
    cid="AC-"+uuid.uuid4().hex[:10].upper()
    db.execute("INSERT INTO after_cases VALUES(?,1,'open',?,?,?,?)",(cid,kind,order["id"],sn,encode(data)))
    result=dict(data,id=cid,version=1,state="open",kind=kind,order_id=order["id"],sn=sn)
    log(db,"cases",cid,1,user,result)
    return dict(result,next=case_permissions(kind,"open",user["role"],data))


def advance_case(db,body,user):
    cid=required(body,"id")
    row=db.execute("SELECT * FROM after_cases WHERE id=?",(cid,)).fetchone()
    if not row:
        raise ApiError(404,"工单不存在")
    expect_version(row,body)
    rule=case_permissions(row["kind"],row["state"],user["role"],json.loads(row["data"]))
    if not rule or body.get("to")!=rule["to"]:
        raise ApiError(403,"当前岗位或工单状态不允许此交接")
    data=json.loads(row["data"])
    for field in rule["fields"]:
        if field.endswith("_amount"):
            data[field]=float(money(body.get(field)))
        else:
            data[field]=required(body,field)
    if row["kind"]=="restore" and rule["to"]=="closed" and data.get("strategy")=="machine":
        rma=db.execute("SELECT data FROM after_cases WHERE order_id=? AND sn=? AND kind='rma' AND json_extract(data,'$.reason_ref')=? ORDER BY rowid DESC LIMIT 1",
                       (row["order_id"],row["sn"],cid)).fetchone()
        rid=json.loads(rma["data"]).get("redelivery_order_id") if rma else None
        delivery=get_order(db,rid,user) if rid else {}
        if (delivery.get("status") not in {"delivered","settled"} or delivery.get("completed_sns")!=[row["sn"]]
                or not delivery.get("signer") or not delivery.get("delivered_at")):
            raise ApiError(409,"须先把本 SN 实际复送到原机位并关联签收 POD，之后才能核客户恢复")
        data["redelivery_order_id"]=rid
        data["original_fault_retest"]=data["test_result"]
    if row["kind"]=="restore" and rule["to"]=="authorized" and data["strategy"] not in {"remote","parts","onsite","loaner","machine"}:
        raise ApiError(400,"请选择远程、寄件、上门、备机或整机移修")
    if row["kind"]=="rma" and data.get("item_type")=="machine" and rule["to"]=="authorized":
        import supply
        receiver=supply.entity(db,"warehouse",data["receiver_id"])
        if receiver["name"]!=data["return_to"]:raise ApiError(409,"接收仓名称与稳定库址 ID 不符")
    if row["kind"]=="rma" and rule["to"]=="closed" and data.get("purpose")=="repair" and data["item_type"]=="machine" and not data.get("technical_release"):
        raise ApiError(409,"返修待验，财务不能代替技术放行整机")
    if row["kind"]=="rma" and rule["to"]=="closed" and data.get("purpose")=="repair" and data.get("item_type")=="machine":
        rid=data.get("redelivery_order_id")
        if not rid or get_order(db,rid,user)["status"] not in {"delivered","settled"}:
            raise ApiError(409,"须核对返修机的复送签收记录")
    if "recovered_at" in rule["fields"]:
        from core import localtime
        localtime(data["recovered_at"],"recovered_at")
        if data.get("strategy")=="machine" and data["recovered_at"]<delivery["delivered_at"]:
            raise ApiError(409,"原机位复测与客户恢复时刻不能早于复送签收")
    if row["kind"]=="rma" and data.get("item_type")=="machine" and rule["to"] in {"shipped","received"}:
        asset=db.execute("SELECT * FROM assets WHERE sn=? AND order_id=?",(row["sn"],row["order_id"])).fetchone()
        expected="delivered" if rule["to"]=="shipped" else "returning"
        if not asset or asset["state"]!=expected:
            raise ApiError(409,"整机当前保管状态已变化，请仓库复核")
        custody=json.loads(asset["data"])
        shipped=rule["to"]=="shipped"
        custody.update(custodian=data["custodian"] if shipped else data["return_to"],
                        custody_ref=data["tracking"] if shipped else data["receipt_ref"],
                        aftercare_id=cid)
        if not shipped:
            custody["receiver_id"]=data["receiver_id"]
            custody["physical_location"]=data["return_to"]
        update_asset(db,asset,"returning" if shipped else "returned_hold",user,custody,row["order_id"])
    data["updated_at"]=now()
    db.execute("UPDATE after_cases SET version=version+1,state=?,data=? WHERE id=?",(rule["to"],encode(data),cid))
    updated=db.execute("SELECT * FROM after_cases WHERE id=?",(cid,)).fetchone()
    log(db,"cases",cid,updated["version"],user,row_obj(updated))
    return case_view(updated,user)


def authorize_bench(db,body,user):
    from supply import entity
    from review import day
    if user["role"]!="admin":raise ApiError(403,"维修工位授权须由主管登记")
    place=required(body,"warehouse_id")
    entity(db,"warehouse",place)
    model=required(body,"model")
    evidence=required(body,"evidence")
    valid_until=day(required(body,"valid_until"))
    if not re.fullmatch(r"M0[1-7]",model):raise ApiError(400,"机型无效")
    row=db.execute("SELECT version FROM repair_bench WHERE warehouse_id=? AND model=?",(place,model)).fetchone()
    if (row and body.get("version")!=row[0]) or (not row and body.get("version",0)!=0):
        raise ApiError(409,"工位授权已更新，刷新后重核")
    version=1+int(row[0] if row else 0)
    data=dict(evidence=evidence,valid_until=valid_until,technician=required(body,"technician"))
    if not db.execute("SELECT 1 FROM users WHERE username=? AND role='service' AND active=1",(data["technician"],)).fetchone():
        raise ApiError(409,"请选择已启用的技术账号")
    db.execute("INSERT INTO repair_bench VALUES(?,?,?,?) ON CONFLICT(warehouse_id,model) DO UPDATE SET version=excluded.version,data=excluded.data",
               (place,model,version,encode(data)))
    log(db,"bench",place+"/"+model,version,user,data)
    return dict(warehouse_id=place,model=model,version=version,**data)


def repair_release(db,body,user):
    if user["role"] not in {"admin","service"}:raise ApiError(403,"技术放行须由受权技师办理")
    cid=required(body,"id")
    case=db.execute("SELECT * FROM after_cases WHERE id=? AND state='received' AND kind='rma'",(cid,)).fetchone()
    if not case:raise ApiError(409,"须为在站待验维修单")
    expect_version(case,body);data=json.loads(case["data"])
    if data.get("purpose")!="repair" or data.get("item_type")!="machine":raise ApiError(409,"此单不是整机移修")
    asset=db.execute("SELECT * FROM assets WHERE sn=? AND order_id=?",(case["sn"],case["order_id"])).fetchone()
    if not asset or asset["state"]!="returned_hold":raise ApiError(409,"本机不在返修隔离位")
    bench=db.execute("SELECT * FROM repair_bench WHERE warehouse_id=? AND model=?",(data.get("receiver_id"),asset["model"])).fetchone()
    authority=json.loads(bench["data"]) if bench else {}
    if authority.get("valid_until","")<now()[:10] or authority.get("technician")!=user["username"]:
        raise ApiError(409,"当前工位或技师未取得本机型有效技术授权，保持隔离")
    facts={k:required(body,k) for k in ("test_result","release_ref","return_plan","protection_ref")}
    custody=json.loads(asset["data"]);custody.update(facts,bench_version=bench["version"])
    update_asset(db,asset,"redelivery_ready",user,custody,case["order_id"])
    data.update(technical_release=facts,technician=user["username"],bench_version=bench["version"])
    db.execute("UPDATE after_cases SET version=version+1,data=? WHERE id=? AND version=?",(encode(data),cid,case["version"]))
    obj=db.execute("SELECT * FROM after_cases WHERE id=?",(cid,)).fetchone()
    log(db,"cases",cid,obj["version"],user,row_obj(obj))
    return case_view(obj,user)


def redelivery(db,body,user):
    """Reserve a customer's released machine exclusively to its new outbound task."""
    import core
    if user["role"] not in {"admin","dispatch"}:raise ApiError(403,"机位复送委托须由调度批准")
    cid=required(body,"id")
    case=db.execute("SELECT * FROM after_cases WHERE id=? AND kind='rma' AND state='received'",(cid,)).fetchone()
    if not case:raise ApiError(409,"须为已有收货凭据的返修单")
    expect_version(case,body)
    data=json.loads(case["data"])
    if not data.get("technical_release") or data.get("purpose")!="repair" or data.get("redelivery_order_id"):
        raise ApiError(409,"尚未技术放行或复送任务已存在，请查本机记录")
    old=get_order(db,case["order_id"],user)
    sn=case["sn"]
    asset=db.execute("SELECT * FROM assets WHERE sn=? AND state='redelivery_ready' AND order_id=?",(sn,old["id"])).fetchone()
    if not asset:raise ApiError(409,"本台实物状态或归属已变，请核对")
    ref=required(body,"approval_ref")
    mode=required(body,"procurement_mode")
    prepared={k:old[k] for k in ("model","customer","endpoint","address","zip","level","timezone","addon_l4","lat","lng",
                                 "city","state","site_note","contact") if k in old}
    prepared.update(warehouse=data["return_to"],quantity=1,pickup=False,addon_l5=False,route="B",
                    procurement_mode=mode,window_start=required(body,"window_start"),window_end=required(body,"window_end"),
                    delivery_actions=required(body,"delivery_actions"),crm_ref=cid+"-复送")
    task=core.create_order(db,prepared,user)
    order=get_order(db,task["id"],user)
    order.update(order_kind="repair_redelivery",rma_id=cid,source_order_id=old["id"],sn=sn,release_ref=data["technical_release"]["release_ref"],
                 status="ready",redelivery_authority=ref)
    guard=db.execute("UPDATE sn_locks SET order_id=? WHERE sn=? AND order_id=?",(order["id"],sn,old["id"]))
    if guard.rowcount!=1:raise ApiError(409,"原 SN 锁记录缺失或占用变化；先复核，不可重复派送")
    db.execute("UPDATE assets SET warehouse=? WHERE sn=?",(prepared["warehouse"],sn))
    custody=json.loads(asset["data"]);custody.update(custodian=prepared["warehouse"],rma_id=cid,source_order_id=old["id"],custody_ref=ref)
    update_asset(db,db.execute("SELECT * FROM assets WHERE sn=?",(sn,)).fetchone(),"reserved",user,custody,order["id"])
    order=core.save(db,order,user,"repair_redelivery",ref)
    data.update(redelivery_order_id=order["id"],redelivery_authority=ref)
    db.execute("UPDATE after_cases SET version=version+1,data=? WHERE id=?",(encode(data),cid))
    updated=db.execute("SELECT * FROM after_cases WHERE id=?",(cid,)).fetchone()
    log(db,"cases",cid,updated["version"],user,row_obj(updated))
    core.event(db,old["id"],user,"repair_redelivery",sn+" → "+order["id"]+" / "+ref)
    return {"record":case_view(updated,user),"order":order}


def handle(db,method,path,body,user):
    if not path.startswith("/api/lifecycle/"):
        return None
    route=path[len("/api/lifecycle/"):]
    if user["role"]=="driver" or (("cases" in route) and user["role"] not in CASE_READERS):
        raise ApiError(403,"当前岗位不可见此台账")
    if route=="repair-benches":
        if user["role"] not in {"admin","service","warehouse"}:raise ApiError(403,"此岗位不能查看工位")
        if method=="GET":return {"records":[row_obj(r) for r in db.execute("SELECT * FROM repair_bench")]}
        if method=="POST":return {"record":authorize_bench(db,body,user)}
    if route=="redelivery" and method=="POST":return redelivery(db,body,user)
    if route=="technical-release" and method=="POST":return {"record":repair_release(db,body,user)}
    if method=="GET" and route=="assets":
        return {"records":[row_obj(r) for r in db.execute("SELECT * FROM assets ORDER BY rowid DESC")]}
    if method=="GET" and route=="cases":
        return {"records":[case_view(r,user) for r in db.execute("SELECT * FROM after_cases ORDER BY rowid DESC")]}
    if method=="POST" and route=="assets":
        if body.get("action") not in {"receive","inspect"}:
            raise ApiError(400,"未知库存操作")
        return {"record":(receipt if body["action"]=="receive" else inspect_asset)(db,body,user)}
    if method=="POST" and route=="cases":
        if body.get("action") not in {"open","advance"}:
            raise ApiError(400,"未知工单操作")
        return {"record":(make_case if body["action"]=="open" else advance_case)(db,body,user)}
    for kind in ("assets","cases"):
        if method=="GET" and route.startswith(kind+"/history/"):
            from urllib.parse import unquote
            item=unquote(route[len(kind+"/history/"):])
            return {"history":[dict(r) for r in db.execute("SELECT version,actor,ts,snapshot FROM life_log WHERE kind=? AND item=? ORDER BY id DESC",(kind,item))]}
    raise ApiError(404,"接口不存在")
