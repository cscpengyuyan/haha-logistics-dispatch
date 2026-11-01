"""Versioned domestic RFQs. Quotes, stock and dispatch mandates use the existing ledgers."""
import json
import uuid
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal

import core
import operations
import review
import supply
from core import ApiError, encode, required
from routing_zones import zone

READ = {"procurement","dispatch","admin","finance"}
WRITE = READ - {"finance"}
PREFIX = "/api/ops/procurement"
STAGES = ("待询","询价草稿","已询","部分回价","待定标","待书面委托","已委托")
PATHS = {"A":"原渠道交付","B":"原库存仓直送","C1":"经站 · 单一主承","C2":"经站 · 分段采购"}
EXPENSES = operations.COSTS


def init_db(db):
    db.execute("""CREATE TABLE IF NOT EXISTS domestic_rfq(
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), data TEXT NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS rfq_by_ticket ON domestic_rfq(order_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS ocean_rfq(id TEXT PRIMARY KEY,candidate TEXT NOT NULL,
        version INTEGER NOT NULL,data TEXT NOT NULL,shipment TEXT UNIQUE REFERENCES shipments(id))""")


def pack_for(db,o):
    row=db.execute("SELECT data FROM domestic_rfq WHERE id=? AND order_id=?",(o.get("active_rfq"),o["id"])).fetchone()
    return json.loads(row[0]) if row else None


def offers(db,o):
    return [operations.record(row) for row in db.execute(
        "SELECT * FROM registry WHERE type='quote' AND json_extract(data,'$.order_id')=? ORDER BY rowid",(o["id"],))]


def positive(value):
    try:
        return 0 < float(value) < 10000
    except (ValueError,TypeError):
        return False


def site_problems(o):
    problems=[]
    if o.get("sales_review_pending"):problems.append("销售范围已修订，待物流复核接手")
    if o.get("level") not in ("L1","L2","L3") or not o.get("endpoint_ref"):
        problems.append("待物流核实合同已购终点及凭据")
    if str(o.get("endpoint") or "").strip().casefold() in {"","待确认","unknown","inside","inside delivery","门口","送到门口"}:
        problems.append("待客户明确交接点、门内外或最终机位")
    if o.get("level") in ("L2","L3"):
        for field,title in (("door_width_cm","门净宽"),("door_height_cm","门净高")):
            if not positive(o.get(field)):problems.append(title+"待补测（cm）")
    if not o.get("pack_version"):problems.append("待核包装规格版本")
    if not all(o.get(k) for k in ("window_start","window_end","timezone")):problems.append("待核本地作业窗及时区")
    if o.get("addon_l4") and not o.get("path_survey_ref"):problems.append("L4 待专项工法及购买依据")
    if o.get("survey_required") and not o.get("path_survey_ref"):problems.append("复杂通道待专项勘查")
    if o.get("survey_required") and not o.get("addon_l4"):problems.append("现场需复杂搬运，待专项购买依据或客户同意替代终点")
    if o.get("addon_l5") and not (o.get("technical_order") or o.get("technical_ref")):problems.append("L5 待技术购买依据及独立授权预约")
    return problems


def offer_problems(o,q):
    problems=site_problems(o)
    if q.get("reply_state")!="firm":problems.append("尚非书面可执行价")
    if q.get("quoted_level")!=o.get("level"):problems.append("终点范围不一致："+str(q.get("quoted_level") or "未知"))
    if not q.get("same_window"):problems.append("未确认相同执行窗")
    if q.get("window_schema")==2:
        start,end=q.get("execution_start"),q.get("execution_end")
        if not (start and end):problems.append("待回承运方实际执行起止时间")
        elif end<=start or start<(o.get("window_start") or "") or end>(o.get("window_end") or ""):
            problems.append("实际执行窗不在本票约定窗口内")
        elif o.get("timezone") and end<=datetime.now(timezone.utc).astimezone(zone(o["timezone"])).strftime("%Y-%m-%dT%H:%M"):
            problems.append("承运方实际执行窗已过")
    if not q.get("same_liability"):problems.append("未确认相同责任及保管范围")
    if not q.get("execution_ref"):problems.append("待车辆载重、车门、尾板、车组及现场能力书证")
    if not q.get("accepted_ref"):problems.append("待本票承接回执")
    if q.get("path") in {"C1","C2"} and not q.get("station_ref"):problems.append("待接站库址、保管及窗口书证")
    if q.get("path")=="C2" and not q.get("last_leg_ref"):problems.append("待二程承接")
    if o.get("level")=="L1" and o.get("site_type") in {"住宅","residential"} and not q.get("unload_ref"):
        problems.append("住宅交接待承运方确认卸货位置")
    return problems


def comparison_terms(q):
    """Labels are returned alongside the specific facts used to determine comparability."""
    trigger=None
    if q.get("charge_terms")=="capped" and q.get("trigger") and q.get("trigger_cap") is not None:
        trigger=(q["trigger"].strip(),q["trigger_cap"])
    elif q.get("charge_terms")=="none" and not q.get("trigger") and q.get("trigger_cap") in (None,0):
        trigger=("none",0)
    return {"询价版本":q.get("rfq_id"),"币种":q.get("currency"),"终点":q.get("quoted_level"),
            "执行开始":q.get("execution_start") if q.get("same_window") else None,
            "执行结束":q.get("execution_end") if q.get("same_window") else None,
            "责任及保管条款":q.get("liability_terms") if q.get("same_liability") else None,
            "包含项":q.get("inclusions"),"排除项":q.get("exclusions"),"附加费触发条件与上限":trigger}


def comparison_basis(q):
    terms=tuple(comparison_terms(q).values())
    return terms if all(terms) and q.get("window_schema")==2 else None


def stock(db,o):
    rows=db.execute("""SELECT a.sn,a.warehouse,a.state,a.order_id FROM assets a
        WHERE a.model=? AND ((a.state='reserved' AND a.order_id=?) OR
        (a.state='available' AND a.order_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM positioning p WHERE p.sn=a.sn AND (p.state IN ('pending','approved','moving') OR
          (p.state='sold' AND json_extract(p.data,'$.sale_order')<>? AND EXISTS
           (SELECT 1 FROM orders z WHERE z.id=json_extract(p.data,'$.sale_order') AND z.status<>'cancelled'))))))
        ORDER BY a.warehouse,a.sn""",(o.get("model"),o["id"],o["id"]))
    warehouses={}
    for sn,wh,state,_ in rows:
        warehouses.setdefault(wh,{"available":[],"reserved":[]})[state].append(sn)
    return warehouses


def inspect(db,o):
    pack=pack_for(db,o)
    inventory=stock(db,o)
    issues=site_problems(o)
    if len(inventory.get(o.get("warehouse"),{}).get("reserved",[]))!=o.get("quantity") or o["status"]!="ready":
        issues.append("F02 待仓管核足本票实物 SN")
    quotes=offers(db,o)
    selected=o.get("selected_quote") or {}
    for q in quotes:
        reasons=[]
        if pack and q.get("rfq_id")!=pack["id"]:reasons.append("历史报价，待按本版重报")
        if q.get("rfq_id"):reasons.extend(offer_problems(o,q))
        try:
            review.validate_quote(o,q)
            supply.assert_eligible(db,q,o)
        except ApiError as exc:
            if str(exc)!="；".join(reasons):reasons.append(str(exc))
        q["reasons"]=list(dict.fromkeys(reasons+issues))
        if q.get("rfq_id") and q.get("window_schema")!=2 and (q["id"],q["version"])!=(selected.get("id"),selected.get("version")):
            q["reasons"].append("旧版书证已保留，定标前须修订并确认实际执行窗")
        q["eligible"]=not q["reasons"]
    eligible=sorted((q for q in quotes if q["eligible"]),key=lambda q:q["amount"])
    bases={comparison_basis(q) for q in eligible}
    recommended=None
    if len(eligible)<2:comparison_note="不足两份可执行回价。单一来源由经办人说明并审批。"
    elif None in bases:
        missing=[q["carrier"]+" 缺 "+"/".join(k for k,v in comparison_terms(q).items() if not v)
                 for q in eligible if comparison_basis(q) is None]
        comparison_note="人工评审，待补书证："+"；".join(missing)
    elif len(bases)!=1:
        all_terms=[comparison_terms(q) for q in eligible]
        mismatch=[key for key in all_terms[0] if len({t[key] for t in all_terms})>1]
        comparison_note="人工评审，书面条款不同："+"、".join(mismatch)
    elif eligible[0]["amount"]==eligible[1]["amount"]:comparison_note="同条件最低确定应付价并列，请人工选定主备。"
    else:
        recommended=eligible[0]
        comparison_note="同一询价包、实际执行窗、责任、含项和条件费用，按确定应付价比较。"
    for q in quotes:
        # Never rank a curbside, stale, differently conditioned or unpriced response.
        if (recommended and q.get("rfq_id")==recommended.get("rfq_id") and q.get("same_window")
            and q.get("same_liability") and q.get("quoted_level")==o.get("level")
            and q.get("scope_snapshot")==review.scope_snapshot(o) and comparison_basis(q)==comparison_basis(recommended)
            and q.get("reply_state")=="firm"
            and q.get("pricing_status")=="itemized" and q.get("valid_until","")>=max(core.now()[:10],str(o.get("window_end") or "")[:10])):
            q["delta"]=float(Decimal(str(q["amount"]))-Decimal(str(recommended["amount"])))
    pack_ok=bool(pack and pack["snapshot"]==review.scope_snapshot(o))
    approval=o.get("rfq_approval") or {}
    approved=next((q for q in eligible if q["id"]==approval.get("quote_id") and q["version"]==approval.get("quote_version")),None)
    if selected and any(q["id"]==selected.get("id") and q["version"]==selected.get("version") and q["eligible"] for q in quotes):
        stage="已委托"
    elif approved:stage="待书面委托"
    elif not pack_ok:stage="待询"
    elif eligible:stage="待定标"
    elif any(q.get("rfq_id")==pack["id"] for q in quotes):stage="部分回价"
    else:stage="已询" if pack.get("sent") else "询价草稿"
    candidates=[]
    for path,title in PATHS.items():
        group=[q for q in quotes if q["path"]==path and (not pack or q.get("rfq_id")==pack["id"])]
        reasons=[] if any(q["eligible"] for q in group) else (list(dict.fromkeys(r for q in group for r in q["reasons"])) if group else issues+["待逐票核对覆盖、能力与书面回价"])
        if o.get("pickup"):
            reasons=["授权自提止于库存仓，核人车及仓口交接回执"] if path=="A" else ["授权自提未购买派送"]
        if path=="A":
            title={"amazon":"亚马逊指定仓：核货件、标签和预约","terminal":"原卡终端：核已购终点书面覆盖"}.get(o.get("a_channel"),"客户自提" if o.get("pickup") else "原渠道：核平台或终端交接")
        candidates.append(dict(path=path,title=title,origin=o.get("warehouse"),end=o.get("endpoint"),reasons=reasons))
    return dict(order_id=o["id"],version=o["version"],pack=pack,scope_current=pack_ok,stock=inventory,stage=stage,
                candidates=candidates,quotes=quotes,recommended=(recommended or {}).get("id"),comparison_note=comparison_note,
                comparison_set=[q["carrier"]+" v"+str(q["version"]) for q in eligible],
                approval=approval,commission=selected,approved=bool(approved),site_problems=issues)


def make_pack(db,o,b,u):
    if o.get("pickup"):raise ApiError(409,"授权自提在原仓核人车交接，无需尾程询价")
    wh=db.execute("SELECT data FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(o.get("warehouse"),)).fetchone()
    snapshot=review.scope_snapshot(o)
    due=operations.iso_date(b.get("deadline"))
    if due<core.now()[:10]:raise ApiError(400,"询价截止不能早于今天")
    old=pack_for(db,o)
    if old and old["snapshot"]==snapshot and old["deadline"]==due:return
    rid="RFQ-"+uuid.uuid4().hex[:12].upper()
    from_address=json.loads(wh[0]).get("address") if wh else None
    lines=[("Pickup",from_address),("Warehouse",o.get("warehouse")),("Delivery",o.get("address")),("Destination ZIP",o.get("zip")),
           ("Units",str(o.get("quantity"))+" x "+str(o.get("model"))),("Packing reference",o.get("pack_version")),
           ("Purchased endpoint",o.get("endpoint")),("Service tier",o.get("level")),("Included actions",o.get("delivery_actions")),
           ("Access / site notes",o.get("site_note")),("Door clearance width / height (cm)",f"{o.get('door_width_cm') or '?'} / {o.get('door_height_cm') or '?'}"),
           ("Dock",o.get("dock")),("Liftgate",o.get("liftgate")),("Window",f"{o.get('window_start') or '?'} - {o.get('window_end') or '?'} {o.get('timezone') or '?'}"),
           ("Response due",due)]
    english="Request for quotation "+rid+" / "+o["id"]+"\n"+"\n".join(k+": "+str(v or "Pending confirmation") for k,v in lines)
    english+="\nQuote in USD for the whole ticket. Identify each leg and custodian, exact endpoint, included services, exclusions, conditional charges and caps, execution date, validity and subcontractors. Attach written capacity and insurance references."
    data=dict(id=rid,order_id=o["id"],created=core.now(),actor=u["username"],snapshot=snapshot,
              deadline=due,origin=from_address,english=english,previous=(old or {}).get("id"))
    db.execute("INSERT INTO domestic_rfq VALUES(?,?,?)",(rid,o["id"],encode(data)))
    o["active_rfq"]=rid
    o.pop("rfq_approval",None)
    core.save(db,o,u,"rfq_open",rid+" · 询价包已生成，尚未发出")


def write_reply(db,o,b,u):
    pack=pack_for(db,o)
    if not pack or pack["snapshot"]!=review.scope_snapshot(o):raise ApiError(409,"请先按当前范围生成本票询价包")
    state=supply.choice(b,"reply_state",{"coverage","declined","conditional","firm","historical"})
    path=supply.choice(b,"path",set(PATHS))
    old=None
    if b.get("id"):
        row=db.execute("SELECT * FROM registry WHERE id=? AND type='quote'",(b["id"],)).fetchone()
        old=operations.record(row) if row else {}
        if old.get("rfq_id")!=pack["id"] or old.get("order_id")!=o["id"] or old.get("version")!=b.get("quote_version"):
            raise ApiError(409,"回价记录已更新或不属于本询价包")
    q=dict(name=required(b,"carrier",140),carrier=required(b,"carrier",140),path=path,order_id=o["id"],
           comparison_ref=pack["id"],rfq_id=pack["id"],scope=pack["english"],scope_snapshot=pack["snapshot"],
           reply_state=state,currency="USD",window_schema=2,quoted_level=supply.choice(b,"quoted_level",{"L1","L2","L3","unknown"}))
    for k in ("evidence","supplier_id","executor_id","product","accepted_ref","execution_ref","station_ref","last_leg_ref",
              "unload_ref","condition_ref","zero_note","follow_up","trigger","inclusions","exclusions","liability_terms","notes","dispatched_ref"):
        q[k]=core.string(b.get(k) or "",k)
    for k in ("execution_start","execution_end"):
        q[k]=core.localtime(b[k],k) if b.get(k) else ""
    q["charge_terms"]=supply.choice({"charge_terms":b.get("charge_terms") or "unknown"},"charge_terms",{"capped","none","unknown"})
    q["same_window"]=b.get("same_window") is True
    q["same_liability"]=b.get("same_liability") is True
    q["valid_until"]=operations.iso_date(b["valid_until"]) if b.get("valid_until") else ""
    for k in (*EXPENSES,"trigger_cap"):
        if b.get(k) not in ("",None):q[k]=float(core.money(b[k]))
    complete=all(k in q for k in EXPENSES)
    if complete and not all(q[k] for k in EXPENSES) and not q["zero_note"]:
        raise ApiError(400,"请注明 0 USD 行已含或免收的依据")
    if q["trigger"] and "trigger_cap" not in q:complete=False
    q["pricing_status"]="itemized" if complete else "incomplete"
    if complete:q["amount"]=float(sum(Decimal(str(q[k])) for k in EXPENSES))
    if state=="firm" and not (q["evidence"] and q["valid_until"]):raise ApiError(400,"正式书面回价须有凭据及有效期")
    return operations.save(db,"quote",q,{"id":old["id"],"version":old["version"]} if old else {},u)


def sample(db,o,u):
    mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
    if not mode or mode[0]!="demo" or not (o.get("zip")=="75201" and o.get("model")=="M01" and o.get("quantity")==2
        and o.get("level")=="L3" and not o.get("addon_l4") and not o.get("addon_l5")):
        raise ApiError(403,"样例回价仅用于演练库中的 Dallas 75201 两台 M01、L3 未购附加服务票")
    if any(q.get("rfq_id")==o.get("active_rfq") and q.get("rfq_id") for q in offers(db,o)):raise ApiError(409,"本版已有回价")
    wh=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(o.get("warehouse"),)).fetchone()
    if not wh:raise ApiError(409,"请先核实际库存仓")
    until=max("2036-12-31",(o.get("window_end") or "")[:10])
    for path,level,costs in [("A","L1",[240,0,0,0,0]),("B","L3",[0,0,510,0,0]),("C1","L3",[0,0,545,0,0]),("C2","L3",[180,65,215,30,0])]:
        carrier="SIM Dallas "+path
        sid=operations.save_resource(db,dict(type="supplier",name=carrier,address="SIM DFW",ability="T2",qualification="S3",evidence="SIM-INS-"+path),u)["resource"]["id"]
        executor="DFW-SIM-EXEC-"+path
        supply.qualify(db,dict(supplier_id=sid,executor_id=executor,product="T2",warehouse_id=wh[0],zip="75201",model="M01",
                       action=level,decision="Y",valid_until=until,insurance_until=until,evidence="SIM-CAP-"+path),u)
        write_reply(db,o,dict(reply_state="firm",carrier=carrier,path=path,quoted_level=level,valid_until=until,
                    execution_start=o.get("window_start"),execution_end=o.get("window_end"),charge_terms="none",
                    liability_terms="Single ticket coverage from pickup through signed delivery to the contracted point",
                    supplier_id=sid,executor_id=executor,product="T2",accepted_ref="SIM-RESPONSE-"+path,
                    evidence="SIM-QUOTE-"+path,execution_ref="SIM-VEHICLE-CREW-GATE-"+path,same_window=True,
                    same_liability=path!="A",zero_note="书面全包已含其余项目；未购技术无费用",
                    station_ref="SIM-STATION-DOCK-TIME" if path in ("C1","C2") else "",
                    inclusions="Curbside only" if path=="A" else "Liftgate, two-person delivery to machine position",
                    exclusions="Inside placement" if path=="A" else "Technical activation",
                    **dict(zip(EXPENSES,costs))),u)
    core.save(db,o,u,"rfq_sample","四份演练书面回价 · 仅作验收")


def approve(db,o,b,u,state):
    q=next((x for x in state["quotes"] if x["id"]==b.get("quote_id") and x["version"]==b.get("quote_version")),None)
    if not q or not q["eligible"] or q.get("rfq_id")!=o.get("active_rfq"):raise ApiError(409,"报价不可执行或已改版，请核实本版同范围回价")
    backup=b.get("backup_id") or ""
    if backup and not any(x["id"]==backup and x["id"]!=q["id"] and x["eligible"] and x.get("rfq_id")==q["rfq_id"] for x in state["quotes"]):
        raise ApiError(409,"备选必须是同版另一项可执行回价")
    decision=dict(quote_id=q["id"],quote_version=q["version"],backup_id=backup,approval_ref=required(b,"approval_ref",300),
                  reason=required(b,"reason"),actor=u["username"],at=core.now(),rfq_id=q["rfq_id"])
    other=next((x for x in state["quotes"] if x["id"]==backup),None)
    same_basis=other and comparison_basis(q) is not None and comparison_basis(other)==comparison_basis(q)
    decision.update(backup_version=other["version"] if other else None,
                    backup_delta=float(core.money(other["amount"])-core.money(q["amount"])) if same_basis else None,
                    window=[o.get("window_start"),o.get("window_end"),o.get("timezone")],
                    switch_condition=core.string(b.get("switch_condition") or decision["reason"],"切换条件"))
    o["rfq_approval"]=decision
    core.save(db,o,u,"rfq_approval",encode(decision))


def commission(db,o,b,u,state):
    ap=state["approval"]
    if not state["approved"]:raise ApiError(409,"委托前须有本版通过的审批与可执行回价")
    q=next(x for x in state["quotes"] if x["id"]==ap["quote_id"])
    ref=required(b,"commission_ref",300)
    o["route"]=q["path"]
    # Route selection is part of the same outer transaction as the signed mandate.
    o=core.save(db,o,u,"choose_plan",q["path"]+" · "+ap["reason"])
    return operations.award_quote(db,dict(id=q["id"],quote_version=q["version"],version=o["version"],
                       approval_ref=ap["approval_ref"]),u,written_commission=ref)


def handle(db,method,path,body,user):
    supply.allow(user,READ if method=="GET" else WRITE)
    tail=path[len(PREFIX):].strip("/").split("/")
    if tail[0]=="ocean":return ocean(db,method,tail[1:],body,user)
    if method=="GET" and tail==[""]:
        rows=[]
        for record in db.execute("SELECT * FROM orders WHERE status IN ('intake','new','ready') ORDER BY rowid DESC"):
            o=core.unpack(record)
            if o.get("pickup"):continue
            s=inspect(db,o)
            rows.append(dict(id=o["id"],ref=o.get("crm_ref") or o["id"],site=o.get("site_id"),model=o.get("model"),stage=s["stage"],order_status=o["status"]))
        counts=Counter(x["stage"] for x in rows)
        return {"orders":rows,"counts":{k:counts[k] for k in STAGES}}
    o=core.get_order(db,tail[0],user)
    if method=="GET" and len(tail)==1:return inspect(db,o)
    if method!="POST" or len(tail)!=2:raise ApiError(404,"采购操作不存在")
    core.check_version(o,body)
    if o.get("sales_review_pending"):raise ApiError(409,"新版销售事实待物流复核")
    if o["status"] not in {"new","ready"}:raise ApiError(409,"请先完成物流接手，已发运的变更须走异常流程")
    if tail[1]=="open":make_pack(db,o,body,user)
    elif tail[1]=="sent":
        pack=pack_for(db,o)
        if not pack or pack["snapshot"]!=review.scope_snapshot(o):raise ApiError(409,"请使用当前范围的询价包")
        evidence=required(body,"evidence");recipient=required(body,"recipient",140)
        sent=pack.setdefault("sent",[])
        if not any(s["evidence"]==evidence and s["recipient"]==recipient for s in sent):
            sent.append(dict(evidence=evidence,recipient=recipient,at=core.now(),actor=user["username"]))
            db.execute("UPDATE domestic_rfq SET data=? WHERE id=?",(encode(pack),pack["id"]))
            core.save(db,o,user,"rfq_sent",pack["id"]+" · "+recipient+" · "+evidence)
    elif tail[1]=="reply":
        q=write_reply(db,o,body,user)
        core.save(db,o,user,"rfq_reply",q["carrier"]+" · "+q["reply_state"]+" · v"+str(q["version"]))
    elif tail[1]=="sample":sample(db,o,user)
    elif tail[1]=="approve":approve(db,o,body,user,inspect(db,o))
    elif tail[1]=="commission":commission(db,o,body,user,inspect(db,o))
    else:raise ApiError(404,"采购操作不存在")
    return inspect(db,core.get_order(db,o["id"],user))


def ocean(db,method,parts,b,user):
    """One RFQ covers one declared manifest, before any inventory or booking exists."""
    cands={r["id"]:dict(json.loads(r["data"]),id=r["id"]) for r in db.execute("SELECT * FROM sailing_options")}
    if method=="GET" and not parts:
        records=[dict(json.loads(r["data"]),id=r["id"],version=r["version"],shipment=r["shipment"]) for r in
                 db.execute("SELECT * FROM ocean_rfq ORDER BY rowid DESC")]
        return {"candidates":list(cands.values()),"requests":records}
    if method!="POST" or len(parts)!=1:raise ApiError(404,"无此头程采购操作")
    action=parts[0]
    if action=="open":
        c=cands.get(required(b,"candidate_id"))
        if not c:raise ApiError(404,"候选船期不存在")
        n=b.get("units")
        if type(n) is not int or not 1<=n<=1000:raise ApiError(400,"登记同范围台数 1–1000")
        deadline=operations.iso_date(b.get("deadline"))
        if deadline<core.now()[:10]:raise ApiError(400,"询价截止已过")
        data=dict(candidate_id=c["id"],voyage=c["voyage"],origin=c["origin"],warehouse_id=c["warehouse_id"],warehouse=c["warehouse"],
                  window=c["planned_warehouse"],units=n,currency=supply.choice(b,"currency",{"USD","CNY"}),unloading=required(b,"unloading"),
                  deadline=deadline,actor=user["username"],created=core.now(),quotes=[],award=None)
        rid="ORFQ-"+uuid.uuid4().hex[:12].upper()
        db.execute("INSERT INTO ocean_rfq VALUES(?,?,1,?,NULL)",(rid,c["id"],encode(data)))
        return dict(data,id=rid,version=1)
    rid=required(b,"id")
    row=db.execute("SELECT * FROM ocean_rfq WHERE id=?",(rid,)).fetchone()
    if not row:raise ApiError(404,"头程询价不存在")
    if row["shipment"] or row["version"]!=b.get("version"):raise ApiError(409,"本询价已关联批次或已改版")
    data=json.loads(row["data"])
    if action=="quote":
        mode=supply.choice(b,"mode",{"FCL","LCL"})
        basis=supply.choice(b,"basis",{"container","W/M","CBM","ton","shipment"})
        if (mode=="FCL")!=(basis=="container"):raise ApiError(400,"FCL 按柜数，LCL 按书面报价口径")
        qty=core.money(b.get("basis_qty"))
        if qty<=0 or (basis=="container" and qty!=qty.to_integral_value()):raise ApiError(400,"计费量应为正数，柜数为整数")
        freight=core.money(b["rate"])*qty if b.get("rate") not in ("",None) else None
        fees={k:None if b.get(k) in ("",None) else float(core.money(b[k])) for k in ("origin_charge","port_charge","cfs_charge","inland_charge","other_charge")}
        same=all(b.get(k)==data[k] for k in ("origin","warehouse_id","units","currency","unloading","window"))
        total=None if freight is None or None in fees.values() else float((freight+sum(Decimal(str(v)) for v in fees.values())).quantize(Decimal(".01")))
        q=dict(id="SEA-Q-"+uuid.uuid4().hex[:10].upper(),supplier=required(b,"supplier"),mode=mode,basis=basis,basis_qty=float(qty),
               rate=None if freight is None else float(core.money(b["rate"])),fees=fees,scope_match=same,total=total,
               per_unit=round(total/data["units"],2) if total is not None and same else None,
               included=required(b,"included"),excluded=required(b,"excluded"),valid_until=operations.iso_date(b.get("valid_until")),
               evidence=required(b,"evidence"),actor=user["username"],at=core.now(),
               scope={k:b.get(k) for k in ("origin","warehouse_id","units","currency","unloading","window")})
        old=b.get("replaces")
        if old:
            prior=next((x for x in data["quotes"] if x["id"]==old and not x.get("replaced_by")),None)
            if not prior or prior["supplier"]!=q["supplier"]:raise ApiError(409,"修订的回价已过版或主体不符")
            prior["replaced_by"]=q["id"]
            if (data.get("award") or {}).get("quote_id")==old:data["award"]=None
        data["quotes"].append(q)
    elif action=="award":
        q=next((x for x in data["quotes"] if x["id"]==b.get("quote_id")),None)
        if not q or q.get("replaced_by") or not q["scope_match"] or q["total"] is None or q["valid_until"]<core.now()[:10]:
            raise ApiError(409,"头程报价不同范围、缺费项、过期或已改版")
        data["award"]=dict(quote_id=q["id"],mode=q["mode"],ref=required(b,"procurement_ref",200),
                           reason=required(b,"reason"),actor=user["username"],at=core.now())
    else:raise ApiError(404,"无此头程采购操作")
    db.execute("UPDATE ocean_rfq SET data=?,version=version+1 WHERE id=?",(encode(data),rid))
    supply.audit(db,rid,row["version"]+1,user,data)
    return dict(data,id=rid,version=row["version"]+1)


def booking_award(db,rid,candidate_id,mode,count,evidence):
    row=db.execute("SELECT * FROM ocean_rfq WHERE id=?",(rid,)).fetchone()
    if not row:raise ApiError(409,"未找到关联的中选询价包")
    rfq=json.loads(row["data"])
    a=rfq.get("award") or {}
    q=next((x for x in rfq["quotes"] if x["id"]==a.get("quote_id")),None)
    if row["shipment"] or not q or q.get("replaced_by") or q["valid_until"]<core.now()[:10] or (
            rfq["candidate_id"],rfq["units"],a["mode"],a["ref"])!=(candidate_id,count,mode,evidence):
        raise ApiError(409,"中选已使用、失效或与本航次、台数、模式、书面确认不符")
    return dict(id=rid,version=row["version"],quote_id=q["id"],ref=a["ref"])
