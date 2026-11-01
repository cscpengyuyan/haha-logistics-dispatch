"""Evidence-backed cohort review. No customer or contact fields are returned."""
import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from core import ApiError, encode, get_order, now, required, unpack

READ = {"admin","dispatch","finance"}
SCOPE = ("warehouse","model","quantity","zip","address","endpoint","level","addon_l4","addon_l5",
         "delivery_actions","exclusions","site_note","window_start","window_end","timezone")
CENT=Decimal("0.01")


def init_db(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS review_baselines(
      order_id TEXT NOT NULL REFERENCES orders(id),version INTEGER NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(order_id,version));
    """)


def day(s):
    try:
        d=date.fromisoformat(s)
        if d.isoformat()!=s:raise ValueError()
        return s
    except (TypeError,ValueError):
        raise ApiError(400,"复盘日期应为 YYYY-MM-DD")


def required_quote(db,oid,qid):
    row=db.execute("SELECT * FROM registry WHERE id=? AND type='quote'",(qid,)).fetchone()
    if not row:
        raise ApiError(400,"未找到书面询价记录")
    q=json.loads(row["data"])
    if q.get("pricing_status")=="incomplete":
        raise ApiError(400,"报价尚有待回费用行，不能作为已确认全价")
    if q.get("order_id")!=oid or not all(q.get(k) for k in ("evidence","comparison_ref","scope","carrier","path","valid_until")) or q.get("amount") is None:
        raise ApiError(400,"报价须关联本票并有书面凭据与同范围询价版本号")
    return {**q,"id":row["id"],"version":row["version"]}


def lock_baseline(db,body,user):
    if user["role"] not in {"admin","finance"}:raise ApiError(403,"基线须由财务或管理员锁定")
    oid=required(body,"order_id")
    order=get_order(db,oid,user)
    if type(body.get("order_version")) is not int or body["order_version"]!=order["version"]:
        raise ApiError(409,"订单版本已变更，请重新核对")
    if order["status"] not in {"new","ready"} or order.get("pickup") or db.execute(
        "SELECT 1 FROM events WHERE order_id=? AND action='dispatch'",(oid,)).fetchone():
        raise ApiError(409,"须在公司配送首次签发前锁定成本基线")
    if not order.get("window_start") or not order.get("window_end"):
        raise ApiError(400,"原方案窗口未确认，暂不能锁定比较基线")
    main=required_quote(db,oid,required(body,"main_id"))
    alt=required_quote(db,oid,required(body,"alt_id"))
    if main["id"]==alt["id"] or (main["carrier"],main["path"])==(alt["carrier"],alt["path"]):
        raise ApiError(400,"请选择不同的实际可执行方案")
    for key in ("comparison_ref","scope"):
        if main[key]!=alt[key]:
            raise ApiError(400,"两条报价的同范围版本及书面范围须一致")
    for k,q in (("main_version",main),("alt_version",alt)):
        if type(body.get(k)) is not int or body[k]!=q["version"]:raise ApiError(409,"报价版本已变化")
        if q["valid_until"]<max(order["window_start"][:10],datetime.now(timezone.utc).date().isoformat()):
            raise ApiError(400,"报价已过期或未覆盖计划作业日")
    current=db.execute("SELECT MAX(version) FROM review_baselines WHERE order_id=?",(oid,)).fetchone()[0] or 0
    if type(body.get("baseline_version")) is not int or body["baseline_version"]!=current:
        raise ApiError(409,"基线版本已变化，请刷新")
    data={"main":main,"alt":alt,"scope":{k:order.get(k) for k in SCOPE},"actor":user["username"],
          "ts":now(),"confirmation":required(body,"confirmation",600)}
    db.execute("INSERT INTO review_baselines VALUES(?,?,?)",(oid,current+1,encode(data)))
    return {"version":current+1}


def decimal(value):
    return Decimal(str(value))


def dollars(value):
    return float(value.quantize(CENT,rounding=ROUND_HALF_UP))


def query(db,body,user):
    if user["role"] not in READ:raise ApiError(403,"此岗位不能查看经营复盘")
    default_cutoff=(datetime.now(timezone.utc)-timedelta(hours=12,days=1)).date().isoformat()
    cutoff=day(body.get("as_of") or default_cutoff)
    if cutoff>default_cutoff:
        raise ApiError(400,"到期复盘请选择美国各时区均已结束的日期（最晚 "+default_cutoff+"）")
    begin=day(body["start"]) if body.get("start") else ""
    end=day(body["end"]) if body.get("end") else ""
    if begin and end and begin>end:raise ApiError(400,"日期范围无效")
    basis=body.get("basis","promise")
    if basis not in {"dispatch","promise"}:raise ApiError(400,"请选择原约期或首派期")
    for k in ("warehouse","zip","level","endpoint"):
        if not isinstance(body.get(k,""),str):raise ApiError(400,"筛选值应为文本")
    dispatches={r[0]:r[1] for r in db.execute("SELECT order_id,MIN(ts) FROM events WHERE action='dispatch' GROUP BY order_id")}
    current_baselines={r["order_id"]:r for r in db.execute("""SELECT b.* FROM review_baselines b JOIN
        (SELECT order_id,MAX(version) AS v FROM review_baselines GROUP BY order_id) x
        ON b.order_id=x.order_id AND b.version=x.v""")}
    attempts={}
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_attempts'").fetchone():
        attempts={r["order_id"]:r for r in db.execute("SELECT order_id,arrival_local,timezone,outcome FROM delivery_attempts WHERE ordinal=1")}
    has_pod={r[0] for r in db.execute("SELECT DISTINCT order_id FROM files WHERE category='pod'")}
    whs=set();rows=[];summary=Counter();actual=Decimal(0);baseline_pairs=Decimal(0);settled_pairs=Decimal(0)
    for row in db.execute("SELECT * FROM orders ORDER BY rowid DESC"):
        o=unpack(row);oid=o["id"]
        if o.get("pickup"):continue
        whs.add(o["warehouse"])
        if body.get("warehouse") and o["warehouse"]!=body["warehouse"]:continue
        if body.get("zip") and not o["zip"].startswith(body["zip"].strip()):continue
        if body.get("level") and o["level"]!=body["level"]:continue
        if body.get("endpoint") and body["endpoint"].strip().casefold() not in o["endpoint"].casefold():continue
        original=o.get("original_window_end") or "";start=o.get("original_window_start") or ""
        issued=dispatches.get(oid,""); included=issued[:10] if basis=="dispatch" else original[:10]
        if (basis=="dispatch" or begin or end) and not included:
            summary["no_basis_date"]+=1
            continue
        if begin and included<begin or end and included>end:continue
        due=bool(original and original[:10]<=cutoff)
        summary["orders"]+=1;summary["plan_units"]+=o["quantity"]
        summary["undispatched"]+=not bool(issued);summary["no_window"]+=not bool(original)
        if due:summary["due"]+=1
        first=attempts.get(oid);timing="not_due" if original else "no_window"; outcome="unknown"
        if first:
            outcome=first["outcome"] if first["outcome"] in {"success","partial","failed"} else "unknown"
        if due:
            if not issued:summary["due_unissued"]+=1
            comparable=bool(first and start and first["arrival_local"] and first["timezone"]==o.get("original_timezone"))
            if comparable:
                timing="on_time" if start<=first["arrival_local"]<=original else "outside"
                summary["timed"]+=1;summary["on_time"]+=timing=="on_time"
            else:
                timing="unissued" if not issued else "unknown"
            if outcome!="unknown":summary["outcome_known"]+=1;summary["first_success"]+=outcome=="success"
        delivered=bool(oid in has_pod and o.get("signer") and o.get("delivered_at") and o.get("delivery_note"))
        units=o["quantity"] if delivered else 0
        summary["success_units"]+=units
        paid=o.get("actual_cost") if o["status"]=="settled" and o.get("invoice_ref") and delivered else None
        if paid is not None:summary["settled"]+=1;actual+=decimal(paid)
        baseline=current_baselines.get(oid);match="missing";quote_delta=None;actual_delta=None;original_price=None;backup_price=None
        if baseline:
            data=json.loads(baseline["data"])
            if data["scope"]!={k:o.get(k) for k in SCOPE}:match="scope_changed"
            elif issued and min(data["main"]["valid_until"],data["alt"]["valid_until"])<issued[:10]:match="expired"
            else:
                match="matched";summary["pairs"]+=1
                original_price=data["main"]["amount"];backup_price=data["alt"]["amount"]
                quote_delta=dollars(decimal(original_price)-decimal(backup_price));baseline_pairs+=decimal(quote_delta)
                if paid is not None:
                    summary["settled_pairs"]+=1
                    actual_delta=dollars(decimal(original_price)-decimal(paid));settled_pairs+=decimal(actual_delta)
        rows.append({"id":oid,"warehouse":o["warehouse"],"zip":o["zip"],"level":o["level"],"route":o["route"],
            "addon_l4":o["addon_l4"],"addon_l5":o["addon_l5"],"model":o["model"],"status":o["status"],"units":o["quantity"],
            "success_units":units,"original_start":start,"original_end":original,"timezone":o.get("original_timezone"),
            "first_dispatch":issued,"arrival":first["arrival_local"] if first else None,"timing":timing,"first_result":outcome,
            "actual":paid,"comparison":match,"main":original_price,"alt":backup_price,"quote_diff":quote_delta,
            "settled_diff":actual_delta,"baseline_version":baseline["version"] if baseline else 0,
            "baseline_trace":({"scope":data["main"]["scope"],"comparison_ref":data["main"]["comparison_ref"],
              "main":data["main"]["id"]+" v"+str(data["main"]["version"])+" / "+data["main"]["evidence"],
              "alt":data["alt"]["id"]+" v"+str(data["alt"]["version"])+" / "+data["alt"]["evidence"],
              "actor":data["actor"],"ts":data["ts"],"confirmation":data["confirmation"]} if baseline else None),
            "can_lock":not issued and o["status"] in {"new","ready"} and user["role"] in {"admin","finance"},
            "order_version":o["version"]})
    totals={k:summary[k] for k in ("orders","plan_units","success_units","due","no_window","undispatched","due_unissued",
        "timed","on_time","outcome_known","first_success","settled","pairs","settled_pairs","no_basis_date")}
    totals.update(pending=summary["orders"]-summary["settled"],actual=dollars(actual) if summary["settled"] else None,
        cost_per_success=dollars(actual/summary["success_units"]) if summary["success_units"] and summary["settled"]==summary["orders"] else None,
        quote_diff=dollars(baseline_pairs) if summary["pairs"] else None,settled_diff=dollars(settled_pairs) if summary["settled_pairs"] else None)
    return {"as_of":cutoff,"basis":basis,"warehouses":sorted(whs),"summary":totals,"rows":rows}


def handle(db,method,path,body,user):
    if path=="/api/review/query" and method=="POST":return query(db,body,user)
    if path=="/api/review/baseline" and method=="POST":return lock_baseline(db,body,user)
    return None
