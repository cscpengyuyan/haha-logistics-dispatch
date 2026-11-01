"""Order-scoped appointment and service SMS ledger, shared with the offline demo."""
import json
import re
from datetime import datetime, timedelta, timezone
from hashlib import sha256

import core
from routing_zones import zone, DATA

ROLES = {"admin", "service", "dispatch"}
TEMPLATES = {"T1", "T2", "T3", "T4"}


def init_db(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS appointments(oid TEXT PRIMARY KEY REFERENCES orders(id), version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sms_jobs(id TEXT PRIMARY KEY, oid TEXT NOT NULL REFERENCES orders(id), version INTEGER NOT NULL,
      template TEXT NOT NULL, phone TEXT NOT NULL, state TEXT NOT NULL, due TEXT, text TEXT NOT NULL, reason TEXT NOT NULL,
      UNIQUE(oid,version,template,phone));
    CREATE TABLE IF NOT EXISTS sms_stops(phone TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sms_provider(job TEXT PRIMARY KEY REFERENCES sms_jobs(id), actor TEXT NOT NULL,
      approved_at TEXT NOT NULL, attempted_at TEXT, sid TEXT UNIQUE, provider_state TEXT,
      error_code TEXT, price TEXT, currency TEXT);
    CREATE TABLE IF NOT EXISTS sms_inbound(sid TEXT PRIMARY KEY);
    """)
    if "zone" not in {r[1] for r in db.execute("PRAGMA table_info(sms_jobs)")}:
        db.execute("ALTER TABLE sms_jobs ADD COLUMN zone TEXT")


def scope(o):
    return [o.get(k) for k in ("address", "zip", "window_start", "window_end", "timezone", "endpoint", "level", "addon_l4", "addon_l5")]


def load(db, oid):
    row = db.execute("SELECT version,data FROM appointments WHERE oid=?", (oid,)).fetchone()
    return dict(json.loads(row[1]), version=row[0]) if row else {"version": 0}


def jobs(db, oid):
    return [dict(row) for row in db.execute("""SELECT j.*,p.sid,p.provider_state,p.error_code,p.price,p.currency
        FROM sms_jobs j LEFT JOIN sms_provider p ON p.job=j.id WHERE oid=? ORDER BY j.rowid DESC""", (oid,))]


def invalidate(db, oid, reason):
    db.execute("UPDATE sms_jobs SET state='cancelled',reason=? WHERE oid=? AND state IN ('queued','manual','authorized')", (reason, oid))
    db.execute("UPDATE sms_jobs SET state='manual',reason=? WHERE oid=? AND state='submitting'",(reason+"，提交状态待核",oid))


def parse_window(value):
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except (ValueError, TypeError):
        raise core.ApiError(400, "请输入完整的当地日期与时间")


def appointment(db, o, body, prior, user):
    if body.get("version") != prior["version"]:
        raise core.ApiError(409, "预约已更新，请刷新")
    phone = str(body.get("phone", "")).strip()
    if phone and not re.fullmatch(r"\+[1-9]\d{7,14}", phone):
        raise core.ApiError(400, "请输入带国家码的 E.164 号码")
    start, end = [parse_window(body.get(k)) for k in ("start", "end")]
    if end <= start:
        raise core.ApiError(400, "预约结束必须晚于开始")
    tz = str(body.get("zone", ""))
    if tz and tz not in DATA:
        raise core.ApiError(400, "请选择已支持的收件地时区")
    hour = body.get("hour", 10)
    if type(hour) != int or not 8 <= hour < 20:
        raise core.ApiError(400, "提醒时段限收件地 08–19 时")
    a = {k: core.string(body.get(k, ""), k, 350) for k in ("carrier_ref", "consent_ref", "owner", "eta_ref")}
    a.update(start=body["start"], end=body["end"], zone=tz, hour=hour, phone=phone,
             consent=body.get("consent") is True, scope=scope(o), customer="待回复", status="有效")
    # Identical client retries should retain the existing version and its queue.
    if all(prior.get(k) == v for k,v in a.items() if k != "customer"):
        return prior
    a["version"] = prior["version"] + 1
    invalidate(db, o["id"], "预约已改版")
    db.execute("INSERT OR REPLACE INTO appointments VALUES(?,?,?)", (o["id"], a["version"], core.encode(a)))
    core.event(db, o["id"], user, "appointment", "预约 v"+str(a["version"]))
    return a


def check(db, o, a, template, clock, delivery=False):
    reason = []
    phone = a["phone"]
    if o.get("sales_review_pending") or a.get("status") != "有效" or a["scope"] != scope(o): reason.append("订单范围或预约已变更")
    if not a["owner"]: reason.append("待指定通知责任人")
    if not (a["consent"] and a["consent_ref"] and phone): reason.append("缺号码、短信许可或凭证")
    if db.execute("SELECT 1 FROM sms_stops WHERE phone=?", (phone,)).fetchone(): reason.append("STOP 已退订")
    if not a["zone"]: return None, reason + ["收件地时区待核"]
    local = clock.astimezone(zone(a["zone"]))
    when = local
    if template == "T2":
        day = parse_window(a["start"]).date() - timedelta(days=1)
        when = datetime.combine(day, datetime.min.time(), local.tzinfo).replace(hour=a["hour"])
        if not a["carrier_ref"]: reason.append("承运方未书面确认窗口")
        if when.date() <= local.date() and not delivery: reason.append("已到提醒日或超过预发时段，转人工安排")
        if delivery and (local.date() != day or local < when): reason.append("不在当前版本提醒时段")
    if (delivery or template != "T2") and not 8 <= local.hour < 20: reason.append("收件地静默时段")
    if template == "T3" and (o["status"] not in {"in_transit","last_mile"} or not a["eta_ref"]):
        reason.append("缺实际在途和 ETA 凭据")
    if template == "T4" and (not a["carrier_ref"] or a["customer"] != "待回复"):
        reason.append("需已有预约且客户尚未回复")
    if template != "T1" and local.replace(tzinfo=None) >= parse_window(a["end"]): reason.append("预约窗口已结束")
    due = when.astimezone(timezone.utc).isoformat(timespec="seconds")
    return due, reason


def message(oid, a, t):
    span = a["start"].replace("T", " ")+" – "+a["end"].replace("T", " ")+" ("+(a["zone"] or "zone pending")+")"
    msg = {"T1":"Please contact dispatch to choose a delivery date and review your site access.",
           "T2":"Your delivery is scheduled for "+span+". Please confirm availability or request a new date.",
           "T3":"Our crew is en route. Please keep your onsite contact available. ETA update: "+a["eta_ref"],
           "T4":"We have not heard back about "+span+". Please contact dispatch to confirm or reschedule."}[t]
    return f"HAHA Delivery {oid}: {msg} Reply STOP to opt out. Message and data rates may apply."


def handle(db, method, path, body, user, clock=None):
    if user["role"] not in ROLES: raise core.ApiError(403, "该岗位不可查看或操作预约通讯")
    clock = clock or datetime.now(timezone.utc)
    action, oid = path.split("/")[-2:]
    o = core.get_order(db, oid, user)
    a = load(db, oid)
    def view():
        return {"appointment": a, "jobs": jobs(db,oid), "stale": bool(a["version"] and a["scope"] != scope(o))}
    if method == "GET" and action == "ticket": return view()
    if method != "POST": raise core.ApiError(404, "无此通讯接口")
    if action == "save":
        old_version = a["version"]
        prior_t2 = db.execute("SELECT 1 FROM sms_jobs WHERE oid=? AND version=? AND template='T2' AND (state!='cancelled' OR reason='待改约')",
                              (oid,old_version)).fetchone()
        a = appointment(db,o,body,a,user)
        if a["version"] != old_version and prior_t2:
            return handle(db,"POST","/api/communications/queue/"+oid,dict(version=a["version"],template="T2"),user,clock)
        return view()
    if not a["version"] or body.get("version") != a["version"]:
        raise core.ApiError(409, "请先保存并核对当前预约版本")
    if action in {"cancel", "reschedule", "confirm", "stop"}:
        if action == "stop":
            if not a["phone"]: raise core.ApiError(400, "缺收件号码")
            db.execute("INSERT OR IGNORE INTO sms_stops VALUES(?)",(a["phone"],))
            a["follow_up"]="已退订，请电话跟进"
            db.execute("UPDATE sms_jobs SET state='manual',reason='STOP 已退订，改电话跟进' WHERE phone=? AND state IN ('queued','authorized')",(a["phone"],))
        elif action == "confirm": a["customer"] = "客户已确认"
        else:
            a["status"] = "已取消" if action == "cancel" else "待改约"
            if action == "reschedule": a["follow_up"]="联系客户确认新窗口"
            invalidate(db,oid,a["status"])
        db.execute("UPDATE appointments SET data=? WHERE oid=?", (core.encode(a),oid))
        core.event(db, oid, user,"contact_"+action, "预约 v"+str(a["version"]))
        return view()
    t = body.get("template")
    if t not in TEMPLATES: raise core.ApiError(400, "请选择 T1 至 T4")
    key = sha256(core.encode([oid,a["version"],t,a["phone"]]).encode()).hexdigest()[:24]
    if action == "queue":
        due, reasons = check(db,o,a,t,clock)
        db.execute("INSERT OR IGNORE INTO sms_jobs (id,oid,version,template,phone,state,due,text,reason,zone) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (key,oid,a["version"],t,a["phone"],"manual" if reasons else "queued",due,message(oid,a,t),"；".join(reasons),a["zone"]))
    elif action == "simulate":
        if db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()[0] != "demo":
            raise core.ApiError(403,"模拟回执仅限演练库")
        job = db.execute("SELECT * FROM sms_jobs WHERE id=?", (key,)).fetchone()
        if not job: raise core.ApiError(404,"先生成预发任务")
        if job["state"] != "queued": return view()
        if not re.fullmatch(r"\+1\d{3}55501\d{2}", a["phone"]): raise core.ApiError(400,"演练只可使用 +1 NPA 555-01xx 虚构号码")
        # Traverse a future execution instant only inside the simulated delivery action.
        instant = max(clock, datetime.fromisoformat(job["due"]))
        _, reasons = check(db,o,a,t,instant,True)
        day = instant.astimezone(zone(a["zone"])).date()
        count = sum(datetime.fromisoformat(r[0]).astimezone(zone(a["zone"])).date() == day
                    for r in db.execute("SELECT due FROM sms_jobs WHERE phone=? AND state='simulated'",(a["phone"],)))
        if count >= 3: reasons.append("当日频控，改人工跟进")
        db.execute("UPDATE sms_jobs SET state=?,reason=? WHERE id=?", ("manual" if reasons else "simulated","；".join(reasons),key))
    elif action == "cancel-job":
        db.execute("UPDATE sms_jobs SET state='cancelled',reason='操作员撤销' WHERE id=? AND state IN ('manual','queued','authorized')",(key,))
        db.execute("UPDATE sms_jobs SET state='manual',reason='已请求撤销，提交状态待核' WHERE id=? AND state='submitting'",(key,))
    else: raise core.ApiError(404, "无此通讯动作")
    return view()
