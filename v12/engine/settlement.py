"""Evidence-linked cost worksheets. Estimates never write a payable or approve a pilot."""
from calendar import monthrange
from datetime import date
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
import hashlib
import json
import re
import uuid

import core
import review
from core import ApiError, required

CENT=Decimal(".01")


def whole(v, minimum=0):
    if not re.fullmatch(r"[0-9]{1,6}",str(v)) or int(v)<minimum:
        raise ApiError(400,"请输入范围内的整数")
    return int(v)


def amount(v):
    return core.money(v)


def dollars(v):
    return float(v.quantize(CENT,rounding=ROUND_HALF_UP))


def allocation(b):
    total=amount(b.get("common"))
    rows=b.get("stops")
    if not isinstance(rows,list) or not 1<=len(rows)<=500 or not all(isinstance(r,dict) for r in rows):
        raise ApiError(400,"请按站点列出占位和专属费用")
    ids=[required(r,"id",120) for r in rows]
    if len(set(ids))!=len(ids):raise ApiError(400,"站点重复")
    weights=[whole(r.get("weight"),1) for r in rows]
    exclusive=[amount(r.get("specific")) for r in rows]
    exact=[total*w/sum(weights) for w in weights]
    shares=[v.quantize(CENT,rounding=ROUND_DOWN) for v in exact]
    cents=int((total-sum(shares))/CENT)
    for i in sorted(range(len(rows)),key=lambda i:(-(exact[i]-shares[i]),ids[i]))[:cents]:
        shares[i]+=CENT
    return {"rows":[{"id":k,"common":dollars(c),"specific":dollars(x),"total":dollars(c+x)}
                    for k,c,x in zip(ids,shares,exclusive)],"total":dollars(total+sum(exclusive)),
            "allocated_common":dollars(sum(shares))}


def incentives(b):
    base,new,reward,labour,benefit=(amount(b.get(k)) for k in ("base","candidate","route_award","labour","benefit"))
    rate=amount(b.get("cap_pct"))
    if rate>100:raise ApiError(400,"预算百分比不可大于 100")
    delta=base-new
    cap=(max(delta,Decimal(0))*rate/100).quantize(CENT,rounding=ROUND_DOWN)
    used=benefit+reward+labour
    return dict(gross=dollars(delta),cap=dollars(cap),used=dollars(used),remaining=dollars(delta-used),
                within=used<=cap,forecast_only=True)


def storage(b):
    orders=whole(b.get("orders"),1);pallets=whole(b.get("pallets"),1)
    if orders>pallets:raise ApiError(400,"本测算按整托出库，出库单不能超过托数")
    inbound,unload,rent,outbound,load,bol,minimum,setup=(amount(b.get(k)) for k in (
        "inbound","unload","rent","outbound","load","bol","minimum","setup"))
    if type(b.get("first_exempt")) is not bool:raise ApiError(400,"请明确首月豁免是否适用")
    variable=inbound+pallets*(unload+rent+load)+orders*(outbound+bol)
    topup=max(Decimal(0),minimum-variable) if not b["first_exempt"] else Decimal(0)
    return dict(subtotal=dollars(variable),topup=dollars(topup),setup=dollars(setup),total=dollars(variable+topup+setup))


def recovery(b):
    common=sum(amount(b.get(k)) for k in ("pack","parts","retest"))
    diagnostic=amount(b.get("diagnosis"))
    choices=b.get("plans")
    if not isinstance(choices,list) or len(choices)!=3 or not all(isinstance(x,dict) for x in choices):
        raise ApiError(400,"请分别填专车、顺带和就近的未来费用")
    results=[]
    for p in choices:
        # On a combined run the pickup column is only the incremental detour.
        spend=common+sum(amount(p.get(k)) for k in ("pickup","redelivery","handling","repair","storage","wait"))
        days=whole(p.get("days"))
        results.append(dict(future=dollars(spend),with_diagnosis=dollars(spend+diagnostic),days=days,
                            within=days<=whole(b.get("deadline"),1)))
    return dict(plans=results,common=dollars(common),forecast_only=True)


def cohort(rows):
    seen=set()
    for row in rows:
        if row["id"] in seen:raise ApiError(409,"首派队列包含重复订单")
        seen.add(row["id"])
    real=[r for r in rows if not r["sample"]]
    missing=[r["id"] for r in real if r["settled_diff"] is None]
    reasons=[]
    if len(real)<20:reasons.append("真实首派未达 20 票")
    if missing:reasons.append("存在未核清费用或缺同范围可执行基线")
    net=sum((Decimal(str(r["settled_diff"])) for r in real if r["settled_diff"] is not None),Decimal(0))
    if not missing and real and net<=0:reasons.append("结算净额未大于零")
    # Service, safety and approval records are separate; the monetary gate cannot release volume.
    return dict(real=len(real),samples=len(rows)-len(real),total=len(rows),missing=missing,
                net=dollars(net) if real and not missing else None,financial_ready=bool(real) and not reasons,
                reasons=reasons or ["须复核同类原窗、首派、首次就位启用、货损、安全与双人审批"],may_expand=False)


def pilot_tables(db):
    db.execute("CREATE TABLE IF NOT EXISTS pilot_evidence(month TEXT NOT NULL, item TEXT NOT NULL, version INTEGER NOT NULL, "
               "data TEXT NOT NULL, PRIMARY KEY(month,item))")
    db.execute("CREATE TABLE IF NOT EXISTS pilot_log(seq INTEGER PRIMARY KEY,month TEXT NOT NULL,item TEXT NOT NULL,actor TEXT NOT NULL,ts TEXT NOT NULL,data TEXT NOT NULL)")


def cohort_rows(db,b,user):
    month=required(b,"month",7)
    try:dt=date.fromisoformat(month+"-01")
    except ValueError:raise ApiError(400,"请输入首派月份 YYYY-MM")
    end=f"{month}-{monthrange(dt.year,dt.month)[1]:02d}"
    report=review.query(db,{"basis":"dispatch","start":dt.isoformat(),"end":end},user)
    mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
    production=mode is not None and mode[0]=="production"
    rows=[]
    for r in report["rows"]:
        o=core.get_order(db,r["id"],user)
        rows.append(dict(r,sample=not production or bool(o.get("training")),order_version=o["version"],
            supplier_id=(o.get("selected_quote") or {}).get("supplier_id") or "",
            group=" · ".join([o["warehouse"],o["model"],o["level"]+("+L4" if o.get("addon_l4") else "")+("+L5" if o.get("addon_l5") else "")])))
    return month,end,report["as_of"],rows


def evaluate(rows,facts,closed):
    """Raw counts over every real first dispatch; targets entered as observed numerator/denominator."""
    stats=cohort(rows); reasons=list(stats["reasons"]) if not stats["financial_ready"] else []
    if not closed:reasons.append("首派月份尚未完整截止")
    groups={};streaks={};tickets=[]
    for r in sorted(rows,key=lambda x:(x["first_dispatch"],x["id"])):
        ticket=facts.get(r["id"],{});version=ticket.get("version",0)
        valid=bool(version and ticket.get("order_version")==r["order_version"])
        tickets.append({"id":r["id"],"sample":r["sample"],"group":r["group"],"version":version,"confirmed":valid})
        if r["sample"]:continue
        g=groups.setdefault(r["group"],dict(count=0,on_time=0,physical=0,enabled=0,enabled_total=0,damaged=0,units=0))
        g["count"]+=1;g["units"]+=r["units"];g["on_time"]+=r["timing"]=="on_time";g["physical"]+=r["first_result"]=="success"
        if r["timing"] not in ("outside","on_time") or r["first_result"] not in ("success","failed","partial"):
            reasons.append("缺少首次到场或逐台尝试证据")
        if not valid:
            reasons.append("逐票安全、服务或损伤核验待补或版本已变")
            streaks[r["supplier_id"]+" · "+r["group"]]=0
            continue
        if ticket["unsafe"] or ticket["abandoned"] or not ticket["valid_release"] or not ticket["scope_kept"] or not ticket["pod_complete"]:
            reasons.append("有效放行、保管、安全、服务范围或凭证未全数通过")
        if r["addon_l5"]:
            g["enabled_total"]+=1;g["enabled"]+=ticket["first_enable"]
        g["damaged"]+=ticket["damaged"]
        sid=r["supplier_id"]+" · "+r["group"]
        if r["supplier_id"]:
            passed=(ticket["standard_floor"] and not r["addon_l4"] and ticket["backup"] and not ticket["unclear_damage"] and ticket["pod_complete"] and ticket["valid_release"]
                    and ticket["scope_kept"] and not ticket["unsafe"] and not ticket["abandoned"] and r["settled_diff"] is not None
                    and r["first_result"]=="success" and (not r["addon_l5"] or ticket["first_enable"]))
            streaks[sid]=streaks.get(sid,0)+1 if passed else 0
    for group,g in groups.items():
        benchmark=facts.get("base:"+group,{})
        for metric,den in [("on_time","count"),("physical","count"),("enabled","enabled_total"),("damaged","units")]:
            if not g[den]:continue
            pair=benchmark.get(metric)
            if not pair or not pair[1]:reasons.append("同类服务的历史分子 / 分母待核");continue
            delta=g[metric]*pair[1]-g[den]*pair[0]
            if (metric=="damaged" and delta>0) or (metric!="damaged" and delta<0):
                reasons.append("同类原窗、首次服务或货损指标未达线")
    return dict(stats,reasons=list(dict.fromkeys(reasons)),quality_ready=not reasons,groups=groups,tickets=tickets,streaks=streaks)


def pilot(db,b,user):
    pilot_tables(db)
    month,end,as_of,rows=cohort_rows(db,b,user)
    facts={r["item"]:dict(json.loads(r["data"]),version=r["version"]) for r in db.execute(
        "SELECT * FROM pilot_evidence WHERE month=?",(month,))}
    result=evaluate(rows,facts,end<=as_of)
    snapshot={k:v for k,v in facts.items() if not k.startswith("sign:")}
    key=hashlib.sha256(core.encode([sorted((r["id"],r["order_version"],r["baseline_version"],r["settled_diff"]) for r in rows),
                                    sorted(snapshot.items())]).encode()).hexdigest()
    signatures=[v for k,v in facts.items() if k.startswith("sign:") and v.get("snapshot")==key]
    approved=len({x["role"] for x in signatures})==2 and len({x["actor"] for x in signatures})==2
    result.update(order_ids=[r["id"] for r in rows],month=month,snapshot=key,signatures=signatures,
        approved=result["quality_ready"] and approved,
        may_expand=result["quality_ready"] and approved and any(n>=10 for n in result["streaks"].values()),
        eligible_scopes=[scope for scope,n in result["streaks"].items() if n>=10] if approved and result["quality_ready"] else [],
        versions={k:v["version"] for k,v in facts.items()})
    action=b.get("action")
    if action is None:return result
    if action=="attest":
        if user["role"] not in ("dispatch","admin"):raise ApiError(403,"需要物流复核")
        oid=required(b,"order_id");r=next((r for r in rows if r["id"]==oid),None)
        if not r or b.get("order_version")!=r["order_version"]:raise ApiError(409,"订单不在本月首派队列或已改版")
        d={k:required(b,k,300) for k in ("release_ref","scope_ref","pod_ref","damage_ref")}
        for k in ("valid_release","scope_kept","pod_complete","unsafe","abandoned","first_enable","backup","unclear_damage","standard_floor"):
            if type(b.get(k)) is not bool:raise ApiError(400,"请逐项明确核验："+k)
            d[k]=b[k]
        d["damaged"]=whole(b.get("damaged"));d["order_version"]=r["order_version"]
        if d["damaged"]>r["units"]:raise ApiError(400,"损伤台数不得超过本单台数")
        item=oid
    elif action=="benchmark":
        if user["role"] not in ("finance","admin"):raise ApiError(403,"需要财务核验基线")
        group=required(b,"group")
        if group not in {r["group"] for r in rows}:raise ApiError(400,"本月无此服务分组")
        item="base:"+group;d={"evidence":required(b,"evidence",300)}
        for k in ("on_time","physical","enabled","damaged"):
            pair=b.get(k)
            if not isinstance(pair,list) or len(pair)!=2:raise ApiError(400,"请登记各指标分子 / 分母")
            n,den=(whole(x) for x in pair)
            if n>den:raise ApiError(400,"指标分子不得超过分母")
            d[k]=[n,den]
    elif action=="sign":
        if user["role"] not in ("finance","admin"):raise ApiError(403,"仅业务批准人或财务可签")
        if b.get("snapshot")!=key or not result["quality_ready"]:raise ApiError(409,"样本、服务、费用或当前版本未全部达标")
        if any(v["actor"]==user["username"] and v["role"]!=user["role"] for v in signatures):raise ApiError(403,"业务与财务需由不同人员签批")
        item="sign:"+user["role"];d=dict(role=user["role"],snapshot=key,evidence=required(b,"evidence",300))
    else:raise ApiError(400,"未知试点核验动作")
    version=facts.get(item,{}).get("version",0)
    if b.get("version")!=version:raise ApiError(409,"复核记录已更新，请重新读取")
    d.update(actor=user["username"],at=core.now())
    db.execute("INSERT INTO pilot_evidence VALUES(?,?,?,?) ON CONFLICT(month,item) DO UPDATE SET version=excluded.version,data=excluded.data",
               (month,item,version+1,core.encode(d)))
    db.execute("INSERT INTO pilot_log(month,item,actor,ts,data) VALUES(?,?,?,?,?)",(month,item,user["username"],d["at"],core.encode(d)))
    return pilot(db,{"month":month},user)


def handle(db,method,path,b,user):
    op=path.rsplit("/",1)[-1]
    if method!="POST":raise ApiError(405,"请使用 POST")
    allowed={"admin","finance","dispatch"}
    if op in ("recovery","history"):allowed|={"service"}
    if user["role"] not in allowed:raise ApiError(403,"此岗位不可办理费用测算")
    if op=="history":
        oid=required(b,"order_id");core.get_order(db,oid,user)
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='cost_worksheets'").fetchone():
            return {"worksheets":[]}
        records=db.execute("SELECT * FROM cost_worksheets WHERE order_id=? ORDER BY rowid DESC",(oid,))
        return {"worksheets":[dict(id=r["id"],kind=r["kind"],actor=r["actor"],ts=r["ts"],**json.loads(r["data"]))
                for r in records if user["role"]!="service" or r["kind"]=="recovery"]}
    if op=="pilot":return pilot(db,b,user)
    funcs={"allocation":allocation,"incentive":incentives,"storage":storage,"recovery":recovery}
    if op not in funcs:raise ApiError(404,"未找到测算项目")
    result=funcs[op](b)
    if b.get("save"):
        oid=required(b,"order_id");o=core.get_order(db,oid,user);core.check_version(o,b)
        ref=required(b,"evidence",300)
        if op=="recovery":
            case=db.execute("SELECT id FROM after_cases WHERE id=? AND order_id=? AND kind IN ('restore','rma')",
                            (required(b,"case_id"),oid)).fetchone()
            if not case:raise ApiError(409,"请先核对本单对应的售后分诊 / RMA 工单")
        db.execute("CREATE TABLE IF NOT EXISTS cost_worksheets(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders,"
                   "kind TEXT NOT NULL,actor TEXT NOT NULL,ts TEXT NOT NULL,data TEXT NOT NULL)")
        rid="WORK-"+uuid.uuid4().hex[:10].upper()
        db.execute("INSERT INTO cost_worksheets VALUES(?,?,?,?,?,?)",(rid,oid,op,user["username"],core.now(),
                   core.encode(dict(inputs={k:v for k,v in b.items() if k not in ('save','version')},result=result))))
        core.event(db,oid,user,"cost_worksheet",f"费用工作表 {rid} / {op} / {ref}，待核账")
        result["worksheet_id"]=rid
    return result
