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


def receipt(db,body,user):
    if user["role"] not in {"admin","warehouse"}:
        raise ApiError(403,"需要仓库岗位")
    keys = ("sn","warehouse","model","bin","condition","batch","evidence")
    data={k:required(body,k,300) for k in keys}
    sn = data.pop("sn").upper()
    if re.search(r"[;,，；、\s]",sn):
        raise ApiError(400,"逐台入账，请输入单个无空格或分隔符的 SN")
    state = body.get("state")
    if state not in {"available","hold"}:
        raise ApiError(400,"实收时请选择验合格或隔离")
    # Origin warehouse remains authoritative for matching a new reservation.
    warehouse,model = data.pop("warehouse"),data.pop("model")
    data["updated_at"] = now()
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
    if row["state"] not in {"available","hold"} or body.get("state") not in {"available","hold"}:
        raise ApiError(409,"已锁定或交运的设备不能更改在库状态，请先处理订单交接")
    fields={k:required(body,k,300) for k in ("bin","condition","evidence")}
    return update_asset(db,row,body["state"],user,{**json.loads(row["data"]),**fields},None)


def reserve(db, order, serials, user):
    for sn in serials:
        row=db.execute("SELECT * FROM assets WHERE sn=?",(sn,)).fetchone()
        if row is None or row["state"]!="available" or row["warehouse"]!=order["warehouse"] or row["model"]!=order["model"]:
            raise ApiError(409,f"设备 {sn} 尚未实收验合格、已锁定，或与本票仓库／型号不一致")
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
            "available":order["warehouse"], "transit":order.get("driver",""),
            "station":order.get("custodian",""), "delivered":order.get("signer","")
        }.get(state,"")
        if state=="station":
            data["station_name"]=order.get("station_name","")
        update_asset(db,row,state,user,data,None if state=="available" else order["id"])


def case_permissions(kind, state, role):
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
    return {"to":target[1],"label":target[2],"fields":target[3]}


def case_view(row,user):
    obj=row_obj(row)
    obj["next"]=case_permissions(row["kind"],row["state"],user["role"])
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
    return dict(result,next=case_permissions(kind,"open",user["role"]))


def advance_case(db,body,user):
    cid=required(body,"id")
    row=db.execute("SELECT * FROM after_cases WHERE id=?",(cid,)).fetchone()
    if not row:
        raise ApiError(404,"工单不存在")
    expect_version(row,body)
    rule=case_permissions(row["kind"],row["state"],user["role"])
    if not rule or body.get("to")!=rule["to"]:
        raise ApiError(403,"当前岗位或工单状态不允许此交接")
    data=json.loads(row["data"])
    for field in rule["fields"]:
        if field.endswith("_amount"):
            data[field]=float(money(body.get(field)))
        else:
            data[field]=required(body,field)
    if "recovered_at" in rule["fields"]:
        from core import localtime
        localtime(data["recovered_at"],"recovered_at")
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
        update_asset(db,asset,"returning" if shipped else "returned_hold",user,custody,row["order_id"])
    data["updated_at"]=now()
    db.execute("UPDATE after_cases SET version=version+1,state=?,data=? WHERE id=?",(rule["to"],encode(data),cid))
    updated=db.execute("SELECT * FROM after_cases WHERE id=?",(cid,)).fetchone()
    log(db,"cases",cid,updated["version"],user,row_obj(updated))
    return case_view(updated,user)


def handle(db,method,path,body,user):
    if not path.startswith("/api/lifecycle/"):
        return None
    route=path[len("/api/lifecycle/"):]
    if user["role"]=="driver" or (("cases" in route) and user["role"] not in CASE_READERS):
        raise ApiError(403,"当前岗位不可见此台账")
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
