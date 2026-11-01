"""Versioned sales intake. Confirmation reparses the original file inside the caller's write transaction."""
import base64
import hashlib
import json
import re
import uuid
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
import core
from sales_workbook import ALIASES, ENUMS, FIELDS, KEYS, compact, parse_file, template

READ = {"sales","dispatch","admin"}
STATES=set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split())
SITE_SCOPE=("address","city","state","zip","window_date","window_start","window_end","timezone")
SENSITIVE=set(SITE_SCOPE)|{"fulfillment","warehouse","endpoint","endpoint_ref","delivery_actions","model","quantity","phone","sms_consent","sms_consent_ref","entrance","floor","door_width_cm","door_height_cm","site_note","access","liftgate","dock","forklift","admission","site_type"}
SENSITIVE.update({"site_access","path_survey_ref","l4_purchased","l4_evidence","l5_purchased","l5_evidence","technical_ref","unload_ref"})
SENSITIVE.update({"customer","contact","activation","carry_distance","unpack","window_type"})

def purchased(f,key):
    return str(f.get(key,"")).lower() in {"是","已购","yes","true"}

def survey_needed(f):
    if f.get("site_access") in ("需专项勘查","标准通道"):
        return f["site_access"]=="需专项勘查"
    text=f.get("access","")
    return any(signal in text for signal in ("需爬楼","有楼梯","需搬上楼","狭小转角","狭窄转角","需特殊搬运"))
def init_db(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS sales_sources(id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS sales_lines(crm TEXT,site TEXT,line TEXT,oid TEXT NOT NULL UNIQUE REFERENCES orders(id),
       rev INTEGER NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(crm,site,line));
    CREATE TABLE IF NOT EXISTS sales_history(oid TEXT,rev INTEGER,source TEXT,origin TEXT NOT NULL,facts TEXT NOT NULL,
       actor TEXT NOT NULL,ts TEXT NOT NULL,PRIMARY KEY(oid,rev));
    CREATE TABLE IF NOT EXISTS sales_mappings(header TEXT PRIMARY KEY,field TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sales_unmatched(source TEXT,location TEXT,PRIMARY KEY(source,location));
    CREATE TABLE IF NOT EXISTS sales_confirmations(oid TEXT PRIMARY KEY,source_rev INTEGER NOT NULL,facts TEXT NOT NULL);
    """)

def label(k):
    return FIELDS[k].split("|")[0]

def missing(f):
    keys=["sales_owner","contact","phone","fulfillment","state","zip","endpoint","endpoint_ref","window_start","window_end","window_type","timezone"]
    keys.append("warehouse" if f.get("fulfillment") in ("授权自提","pickup") else "address")
    gaps=[label(k) for k in keys if not f.get(k) or f[k] in ("未知","待核","待确认")]
    if f.get("state") and f["state"].upper() not in STATES:gaps.append("州代码待核")
    if f.get("zip") and not re.fullmatch(r"[0-9]{5}(?:-[0-9]{4})?",f["zip"]):gaps.append("五位 ZIP 或 ZIP+4 待核")
    if not re.fullmatch(r"M0[1-7]",f.get("model","")):gaps.append("原始型号须对照主数据 M01–M07")
    if f.get("fulfillment") and f["fulfillment"] not in ("授权自提","送货","delivery","pickup"):gaps.append("确认送货或授权自提")
    if f.get("timezone") and f["timezone"] not in core.ZONES:gaps.append("当地时区须核对")
    if f.get("phone") and not re.fullmatch(r"\+?[0-9\s().-]{7,23}",f["phone"]):gaps.append("核对联系电话")
    for k in ("window_start","window_end"):
        if f.get(k):
            try: core.localtime(local_timestamp(f,k),k)
            except core.ApiError:gaps.append(label(k)+"须为当地日期时间")
    if f.get("window_start") and f.get("window_end") and local_timestamp(f,"window_end")<=local_timestamp(f,"window_start"):gaps.append("结束须晚于开始")
    for k,evidence in (("l4_purchased","l4_evidence"),("l5_purchased","l5_evidence")):
        if purchased(f,k) and not f.get(evidence):gaps.append(label(evidence))
    return gaps

def local_timestamp(f,k):
    t=f.get(k,"").replace(" ","T")
    return f.get("window_date","")+"T"+t if re.fullmatch(r"\d\d:\d\d",t) else t

def source(body):
    name=core.required(body,"filename",180)
    if not isinstance(body.get("base64"),str) or len(body["base64"])>6_000_000:raise core.ApiError(413,"请选择小于 4 MB 的文件")
    try: data=base64.b64decode(body["base64"],validate=True)
    except ValueError as e: raise core.ApiError(400,"文件内容损坏") from e
    if not data or len(data)>4_000_000:raise core.ApiError(413,"文件为空或超过 4 MB")
    return name,data,hashlib.sha256(data).hexdigest()

def affected(db,oid):
    records=db.execute("SELECT id,type,data FROM registry WHERE type IN ('quote','route') AND (json_extract(data,'$.order_id')=? OR EXISTS (SELECT 1 FROM json_each(registry.data,'$.order_ids') WHERE value=?))",(oid,oid))
    refs=[("报价 " if r[1]=="quote" else "路线 ")+r[0] for r in records]
    refs += ["短信 "+r[0] for r in db.execute("SELECT id FROM sms_jobs WHERE oid=? AND state IN ('queued','manual','authorized','submitting')",(oid,))]
    return refs

def validate_mapping(mapping):
    if not isinstance(mapping,dict) or len(mapping)>150 or not all(isinstance(h,str) and len(h)<=150 and f in FIELDS for h,f in mapping.items()):
        raise core.ApiError(400,"字段映射无效")

def preview(db,body,user=None):
    name,data,digest=source(body)
    sheets,headrow=parse_file(name,data)
    overrides=body.get("mapping",{})
    validate_mapping(overrides)
    aliases={**ALIASES,**dict(db.execute("SELECT header,field FROM sales_mappings")),**{compact(h):k for h,k in overrides.items()}}
    unmapped,problems,orphans=set(),[],[]
    groups={}
    for sheet in ("销售交单","现场补充"):
        if sheet not in sheets:continue
        rows=sheets[sheet]
        headers=next((r for n,r in rows if n==headrow),{})
        cols={}
        for col,header in headers.items():
            if not header:continue
            k=aliases.get(compact(header))
            if not k:unmapped.add(header);continue
            if k in cols.values():problems.append(f"{sheet} 第 {headrow} 行：多个列映射到 {label(k)}")
            cols[col]=k
        if not set(KEYS)<=set(cols.values()):
            problems.append(f"{sheet} 第 {headrow} 行：请映射 CRM订单号、站点编号、明细行号")
            continue
        for number,row in rows:
            if number<=headrow or not any(row.values()):continue
            loc=f"{sheet} 第 {number} 行"
            vals={k:row.get(c,"") for c,k in cols.items()}
            if any(len(v)>2000 or "\x00" in v for v in vals.values()):
                problems.append(loc+"：字段过长或含控制字符");continue
            key=tuple(vals[k] for k in KEYS)
            if not all(key):problems.append(loc+"：缺来源单号、站点或明细行号");continue
            existing=db.execute("SELECT * FROM sales_lines WHERE crm=? AND site=? AND line=?",key).fetchone()
            if existing and user and user["role"]=="sales" and db.execute(
                    "SELECT json_extract(data,'$.owner') FROM orders WHERE id=?",(existing["oid"],)).fetchone()[0]!=user["username"]:
                problems.append(loc+"：明细已由其他销售经办，请物流复核归属");continue
            group=groups.get(key)
            if not group and sheet=="现场补充" and not existing:orphans.append(f"{loc} · {' / '.join(key)}");continue
            if not group:
                original=json.loads(existing["facts"]) if existing else {}
                group=groups[key]={"old":original,"facts":original.copy(),"origin":{},"rows":[],"existing":dict(existing) if existing else None}
            if any(at.startswith(sheet+" ") for at in group["rows"]):
                problems.append(loc+"：同一明细键重复，另见 "+group["rows"][0]);continue
            group["rows"].append(loc)
            if sheet=="现场补充":vals={k:v for k,v in vals.items() if v}
            group["facts"].update(vals);group["origin"].update({k:loc for k in vals})
    if sum(len(rows) for rows in sheets.values())>2010:raise core.ApiError(413,"每次最多预检 2000 行")
    site_values=defaultdict(dict)
    # Include existing siblings when only one line of a multi-line site is being revised.
    for crm,site in {key[:2] for key in groups}:
        for r in db.execute("SELECT line,facts FROM sales_lines WHERE crm=? AND site=?",(crm,site)):
            if (crm,site,r[0]) not in groups:
                stored=json.loads(r[1])
                for field in SITE_SCOPE:
                    if stored.get(field):site_values[(crm,site,field)][stored[field]]=f"原明细 {r[0]}"
    summaries=[]
    for key,g in groups.items():
        facts=g["facts"];where="、".join(g["rows"])
        for dimension in ("door_width","door_height"):
            inch,cm=dimension+"_in",dimension+"_cm"
            if not facts.get(inch):continue
            try:
                inches=Decimal(facts[inch])
                if not inches.is_finite() or not 0<inches<400:raise ValueError()
                metric=(inches*Decimal("2.54")).quantize(Decimal(".01"))
                if facts.get(cm) and abs(Decimal(facts[cm])-metric)>Decimal(".01"):
                    problems.append(where+"："+label(cm)+"与英寸不一致")
                facts[cm]=format(metric,"f")
                g["origin"][cm]=g["origin"].get(inch,where)+" · 英寸 × 2.54"
            except (InvalidOperation,ValueError):
                problems.append(where+"：请核对门尺寸及单位")
        if not facts.get("model") or not re.fullmatch(r"[1-9]\d{0,2}",facts.get("quantity",""),re.ASCII):
            problems.append(where+"：待核草稿也需要原始型号及 1–999 整数台数")
        for field in SITE_SCOPE:
            value=facts.get(field)
            if value:
                siblings=site_values[(*key[:2],field)]
                if siblings and value not in siblings:problems.append(f"{where} 与 {next(iter(siblings.values()))} 的{label(field)}冲突")
                siblings[value]=where
        prior=g["existing"];changes={k:[g["old"].get(k,""),v] for k,v in facts.items() if g["old"].get(k,"")!=v}
        g["changes"]=changes
        state="新增" if not prior else "变更" if changes else "完全重复"
        g["impact"]=affected(db,prior["oid"]) if prior and SENSITIVE.intersection(changes) else []
        summaries.append({"key":key,"rows":g["rows"],"state":state,"missing":missing(facts),"changes":changes if prior else {},
                          "impact":g["impact"],"id":prior["oid"] if prior else None,"revision":prior["rev"] if prior else 0})
    report={"rows":summaries,"errors":problems,"unmatched":orphans,"unmapped":sorted(unmapped),"count":len(groups)}
    token=hashlib.sha256((digest+json.dumps(report,ensure_ascii=True,sort_keys=True)+json.dumps(overrides,sort_keys=True)).encode()).hexdigest()
    return {**report,"token":token},groups,(digest,name,data)

def apply_facts(o,f):
    for k in FIELDS:
        if k not in ("quantity","window_start","window_end"):
            o[k]=f.get(k,"")
    o["quantity"]=int(f["quantity"])
    o.update(window_start=local_timestamp(f,"window_start"),window_end=local_timestamp(f,"window_end"))
    o["state"]=o["state"].upper()

def clarified_facts(db,oid,incoming):
    """Carry verified logistics facts forward only while their underlying sales facts agree."""
    record=db.execute("""SELECT c.facts,h.facts FROM sales_confirmations c
                         JOIN sales_history h ON h.oid=c.oid AND h.rev=c.source_rev WHERE c.oid=?""",(oid,)).fetchone()
    if not record:return incoming.copy()
    confirmed,original=map(json.loads,record)
    return {k:confirmed.get(k,"") if incoming.get(k,"")==original.get(k,"") else incoming.get(k,"") for k in FIELDS}

def confirm(db,body,user):
    report,groups,src=preview(db,body,user)
    if body.get("token")!=report["token"]:raise core.ApiError(409,"预检已过期，重新预览并确认")
    if report["errors"]:raise core.ApiError(400,"未解决逐行错误")
    db.execute("INSERT OR IGNORE INTO sales_sources VALUES(?,?,?)",src)
    db.execute("DELETE FROM sales_unmatched WHERE source=?",(src[0],))
    db.executemany("INSERT OR IGNORE INTO sales_unmatched VALUES(?,?)",[(src[0],loc) for loc in report["unmatched"]])
    for h,k in body.get("mapping",{}).items():db.execute("INSERT OR REPLACE INTO sales_mappings VALUES(?,?)",(compact(h),k))
    ids={}
    for key,g in groups.items():
        prior=g["existing"]
        facts=g["facts"];ts=core.now()
        if prior:
            oid=prior["oid"];ids[" / ".join(key)]=oid
            if not g["changes"]:continue
            rev=prior["rev"]+1
            o=core.get_order(db,oid,user)
            if o["status"]=="intake":apply_facts(o,facts)
            elif SENSITIVE.intersection(g["changes"]) or o.get("sales_rejected_revision")==prior["rev"]:
                if not o.get("sales_review_pending"):o["prior_intake_revision"]=o.get("intake_revision")
                o["sales_review_pending"]=True
                o["intake_revision"]=rev
                o["sales_impact"]=g["impact"]
                import communications
                communications.invalidate(db,oid,"销售范围改版，重新核对预约")
            o["sales_revision"]=rev
            core.save(db,o,user,"sales_revision",f"交单修订 v{rev} · "+", ".join(label(k) for k in g["changes"]))
        else:
            rev=1;oid="HH-"+uuid.uuid4().hex[:12].upper();ids[" / ".join(key)]=oid
            o={"owner":user["username"],"sales_submitted_at":ts,"created_at":ts,"updated_at":ts,"route":"","level":"","lat":None,"lng":None,
               "addon_l4":False,"addon_l5":False,"pickup":False,"sales_revision":1,"training":bool(db.execute("SELECT 1 FROM metadata WHERE key='mode' AND value='demo'").fetchone())}
            apply_facts(o,facts)
            db.execute("INSERT INTO orders VALUES(?,1,'intake',?)",(oid,core.encode(o)))
            core.event(db,oid,user,"sales_intake","销售交单 · "+" / ".join(key))
        db.execute("INSERT INTO sales_lines VALUES(?,?,?,?,?,?) ON CONFLICT(crm,site,line) DO UPDATE SET rev=excluded.rev,facts=excluded.facts",(*key,oid,rev,core.encode(facts)))
        db.execute("INSERT INTO sales_history VALUES(?,?,?,?,?,?,?)",(oid,rev,src[0],core.encode(g["origin"]),core.encode(facts),user["username"],ts))
    return {"tickets":ids,"added":sum(r["state"]=="新增" for r in report["rows"]),"changed":sum(r["state"]=="变更" for r in report["rows"])}

def handoff(db,body,user):
    if user["role"] not in {"admin","dispatch"}:raise core.ApiError(403,"请由物流岗接手")
    oid=core.required(body,"id")
    row=db.execute("SELECT * FROM sales_lines WHERE oid=?",(oid,)).fetchone()
    if not row:raise core.ApiError(404,"未找到销售明细")
    o=core.get_order(db,oid,user);core.check_version(o,body)
    if o["status"] not in ("new","intake","ready"):
        raise core.ApiError(409,"已进入执行，须先办理异常或变更")
    if o["status"]!="intake" and not o.get("sales_review_pending"):
        raise core.ApiError(409,"该版本物流已接手")
    facts=clarified_facts(db,oid,json.loads(row["facts"]))
    edit=body.get("facts",{})
    if not isinstance(edit,dict) or set(edit)-set(FIELDS) or set(edit)&set(KEYS):raise core.ApiError(400,"只能澄清交单事实")
    facts.update({k:core.string(v,k) for k,v in edit.items()})
    if not re.fullmatch(r"[1-9][0-9]{0,2}",facts.get("quantity","")):raise core.ApiError(400,"请确认设备数量")
    gaps=missing(facts)
    if gaps:raise core.ApiError(409,"待销售补齐或物流核实："+"、".join(gaps))
    level=body.get("level")
    if level not in ("L1","L2","L3") or re.fullmatch(r"(inside(?: delivery)?|送到门口|门口|上门|送货上门|门内|门外|入口|未知)[。.！! ]*",facts["endpoint"].strip(),re.I):
        raise core.ApiError(409,"需核对具体交接位置及 L1/L2/L3，模糊表述不能接单")
    pickup=facts["fulfillment"] in ("授权自提","pickup")
    if pickup and level!="L1":raise core.ApiError(409,"授权仓口自提按实际仓口记录 L1")
    if o["status"]=="ready" and (o.get("quantity"),o.get("model"),o.get("warehouse"))!=(int(facts["quantity"]),facts["model"],facts.get("warehouse","")):
        raise core.ApiError(409,"已锁实物与变更不符，仓管须先撤回放行")
    if o["status"]=="ready":
        locked={r[0] for r in db.execute("SELECT sn FROM sn_locks WHERE order_id=?",(oid,))}
        reserved={r[0] for r in db.execute("SELECT sn FROM assets WHERE order_id=? AND state='reserved' AND model=? AND warehouse=?",
                                         (oid,facts["model"],facts.get("warehouse","")))}
        if len(locked)!=int(facts["quantity"]) or locked!=reserved:
            raise core.ApiError(409,"实际库存保管或 SN 锁与本票不一致，仓管须先复核")
    if o.get("selected_quote") and o.get("sales_review_pending"):
        o.setdefault("superseded_quotes",[]).append(o.pop("selected_quote"))
    if o["status"]!="intake" and any(o.get(k,"")!=facts.get(k,"") for k in ("address","zip","state","city")):
        o.update(location_precision="unknown",coordinate_ref="",lat=None,lng=None)
    apply_facts(o,facts)
    if body.get("confirm_demo_site") is True:
        if not o.get("training") or (facts["crm_ref"],facts["address"],facts["zip"])!=("DEMO-DAL-02","Synthetic loading entrance · Main St","75201"):
            raise core.ApiError(409,"此核址动作只适用于本演练点")
        o.update(lat=32.779,lng=-96.799,location_precision="dock",coordinate_ref="SIM-MAIN-ST-DOCK",pack_version="SIM-M01-PALLET")
    o.update(level=level,pickup=pickup,route="A" if pickup else "",sales_review_pending=False,logistics_owner=user["username"],
             survey_required=survey_needed(facts),addon_l4=purchased(facts,"l4_purchased"),addon_l5=purchased(facts,"l5_purchased"),
             logistics_accepted_at=core.now(),status="new" if o["status"]=="intake" else o["status"])
    for k in ("window_start","window_end","timezone"):
        if not o.get("original_"+k):o["original_"+k]=o[k]
    if o.get("warehouse"):
        wh=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(o["warehouse"],)).fetchone()
        o["warehouse_id"]=wh[0] if wh else None
    db.execute("INSERT OR REPLACE INTO sales_confirmations VALUES(?,?,?)",(oid,row["rev"],core.encode(facts)))
    return {"order":core.save(db,o,user,"logistics_handoff",f"物流接手交单 v{row['rev']} · {level} · "+facts["endpoint_ref"])}

def reject_change(db,body,user):
    if user["role"] not in {"admin","dispatch"}:raise core.ApiError(403,"仅物流岗可复核销售改版")
    o=core.get_order(db,core.required(body,"id"),user)
    core.check_version(o,body)
    if not o.get("sales_review_pending"):raise core.ApiError(409,"当前版本无待复核变更")
    ref=core.required(body,"evidence",400)
    o["sales_review_pending"]=False
    o["sales_rejected_revision"]=o["sales_revision"]
    previous=o.pop("prior_intake_revision",None)
    if previous is None:o.pop("intake_revision",None)
    else:o["intake_revision"]=previous
    return {"order":core.save(db,o,user,"sales_rejected",f"拒绝交单修订 v{o['sales_revision']} · 保留原签约条件 · "+ref)}

def dispatch(db,method,path,body,user):
    if user["role"] not in READ:raise core.ApiError(403,"该岗位无权访问销售交单原件与收件资料")
    action=path.removeprefix("/api/sales/")
    if method=="GET":
        if action=="schema":return {"fields":{k:label(k) for k in FIELDS},"enums":ENUMS}
        if action in ("template","example"):return {"base64":base64.b64encode(template(example=action=="example")).decode()}
        if action.startswith("history/"):
            oid=action.split("/",1)[1]
            if user["role"]=="sales" and core.get_order(db,oid,user).get("owner")!=user["username"]:raise core.ApiError(403,"无此交单原件权限")
            rows=db.execute("""SELECT h.rev,h.ts,h.actor,h.origin,h.facts,s.id,s.name FROM sales_history h
                JOIN sales_sources s ON s.id=h.source WHERE h.oid=? ORDER BY h.rev DESC""",(oid,))
            return {"history":[dict(rev=r[0],ts=r[1],actor=r[2],origin=json.loads(r[3]),facts=json.loads(r[4]),source=r[5],name=r[6]) for r in rows]}
        if action.startswith("source/"):
            source_id=action.split("/",1)[1]
            if user["role"]=="sales" and not db.execute("SELECT 1 FROM sales_history WHERE source=? AND actor=?",(source_id,user["username"])).fetchone():
                raise core.ApiError(403,"仅可下载本人提交的原件")
            row=db.execute("SELECT name,bytes FROM sales_sources WHERE id=?",(source_id,)).fetchone()
            if not row: raise core.ApiError(404,"导入原件不存在")
            return {"filename":row[0],"base64":base64.b64encode(row[1]).decode()}
        if action=="lines":
            lines=[]
            for row in db.execute("""SELECT s.*,o.version,o.status,o.data FROM sales_lines s JOIN orders o ON o.id=s.oid
                                   WHERE ?<>'sales' OR json_extract(o.data,'$.owner')=? ORDER BY s.rowid DESC LIMIT 250""",
                                  (user["role"],user["username"])):
                facts=json.loads(row["facts"]);o=json.loads(row["data"])
                lines.append({"id":row["oid"],"version":row["version"],"rev":row["rev"],"facts":facts,
                              "handoff_facts":clarified_facts(db,row["oid"],facts) if o.get("sales_review_pending") else facts,"status":row["status"],
                              "pending":bool(o.get("sales_review_pending")),"rejected":o.get("sales_rejected_revision")==row["rev"],
                              "missing":missing(facts),"accepted":o.get("logistics_accepted_at","")})
            pending=[r[0] for r in db.execute("SELECT location FROM sales_unmatched ORDER BY rowid DESC LIMIT 250")]
            return {"lines":lines,"unmatched":pending}
    if method=="POST":
        if action=="preview":return preview(db,body,user)[0]
        if action=="confirm":return confirm(db,body,user)
        if action=="handoff":return handoff(db,body,user)
        if action=="reject-change":return reject_change(db,body,user)
    raise core.ApiError(404,"未找到交单操作")
