"""Production-only Twilio adapter. No scheduled message leaves the local queue before its due time."""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from server import connect
import communications
import core
from routing_zones import zone

STATUS="/api/twilio/status/"
INCOMING="/api/twilio/incoming"
ERR=core.ApiError


def settings(environ=None):
    env=environ if environ is not None else os.environ
    if env.get("HH_SMS_LIVE")!="1":return None
    ac=env.get("TWILIO_ACCOUNT_SID","")
    token=env.get("TWILIO_AUTH_TOKEN","")
    sender=env.get("TWILIO_FROM_NUMBER","")
    base=env.get("HH_SMS_PUBLIC_ORIGIN","").rstrip("/")
    url=urlsplit(base)
    if (not re.fullmatch(r"AC[0-9a-fA-F]{32}",ac) or len(token)<24 or not re.fullmatch(r"\+[1-9][0-9]{7,14}",sender)
            or url.scheme!="https" or not url.hostname or url.path or url.query or url.fragment or url.username or url.password):
        return None
    return {"account":ac,"token":token,"sender":sender,"origin":base}


def require_live(db,cfg):
    mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
    if not cfg or not mode or mode[0]!="production":raise ERR(409,"正式短信未启用或库模式不符")


def authorize(db,oid,body,user,cfg,clock):
    require_live(db,cfg)
    if user["role"] not in communications.ROLES:raise ERR(403,"此岗位不能授权短信")
    o=core.get_order(db,oid,user)
    a=communications.load(db,oid)
    if not a["version"] or body.get("version")!=a["version"] or a.get("owner")!=user["username"]:
        raise ERR(409,"须由本版预约登记的通知责任人授权")
    if body.get("authorize_charges") is not True:raise ERR(400,"需要明确授权该条付费短信")
    t=body.get("template")
    j=db.execute("SELECT * FROM sms_jobs WHERE oid=? AND version=? AND template=? AND phone=?",
                 (oid,a["version"],t,a["phone"])).fetchone()
    if not j or j["id"]!=body.get("job"):raise ERR(409,"请预览并明确授权本版短信")
    if not re.fullmatch(r"\+[1-9][0-9]{7,14}",a["phone"]) or re.fullmatch(r"\+1\d{3}55501\d\d",a["phone"]):
        raise ERR(400,"正式库不接受无效或保留的虚构号码")
    if j["state"]=="queued":
        _,why=communications.check(db,o,a,t,clock)
        if why:raise ERR(409,"；".join(why))
        db.execute("INSERT INTO sms_provider(job,actor,approved_at) VALUES(?,?,?)",(j["id"],user["username"],clock.isoformat()))
        db.execute("UPDATE sms_jobs SET state='authorized' WHERE id=?",(j["id"],))
        core.event(db,oid,user,"sms_authorized","已授权本条付费短信 "+j["id"])
    elif j["state"]!="authorized":raise ERR(409,"该短信已撤销、进入人工流程或已提交")
    return communications.handle(db,"GET","/api/communications/ticket/"+oid,{},user)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args):return None


def send(cfg,j):
    url="https://api.twilio.com/2010-04-01/Accounts/"+cfg["account"]+"/Messages.json"
    credentials=base64.b64encode((cfg["account"]+":"+cfg["token"]).encode()).decode()
    form={"To":j["phone"],"From":cfg["sender"],"Body":j["text"],"StatusCallback":cfg["origin"]+STATUS+j["id"]}
    req=Request(url,data=urlencode(form).encode(),headers={"Authorization":"Basic "+credentials,
              "Content-Type":"application/x-www-form-urlencoded"})
    try:
        with build_opener(NoRedirect).open(req,timeout=6) as res:obj=json.loads(res.read(65536))
    except HTTPError as error:
        # Persist provider codes only, never a raw response with customer data.
        try:code=int(json.loads(error.read(8192)).get("code"))
        except (ValueError,TypeError,AttributeError):code=error.code
        raise ERR(502,"Twilio "+str(code)) from None
    return obj


def manual(db,job,why):
    db.execute("UPDATE sms_jobs SET state='manual',reason=? WHERE id=?",(why,job))


def once(db,cfg,clock=None,transport=send):
    require_live(db,cfg)
    clock=clock or datetime.now(timezone.utc)
    now=clock.isoformat(timespec="seconds")
    db.execute("BEGIN IMMEDIATE")
    with db:
        # After an interrupted POST there is no safe automatic retry.
        db.execute("""UPDATE sms_jobs SET state='manual',reason='提交结果待核 Twilio 记录，禁止自动重发' WHERE state='submitting'
            AND id IN (SELECT job FROM sms_provider WHERE attempted_at<?)""",((clock-timedelta(minutes=2)).isoformat(timespec="seconds"),))
        j=db.execute("SELECT * FROM sms_jobs WHERE state='authorized' AND due<=? ORDER BY due,id LIMIT 1",(now,)).fetchone()
        if not j:return False
        db.execute("UPDATE sms_jobs SET state='submitting' WHERE id=?",(j["id"],))
        db.execute("UPDATE sms_provider SET attempted_at=? WHERE job=?",(now,j["id"]))
    # The committed claim prevents duplicate POSTs on concurrent workers or a crash.
    # Hold a short write lock over the last authorization check and the single provider call.
    db.execute("BEGIN IMMEDIATE")
    with db:
        if db.execute("SELECT state FROM sms_jobs WHERE id=?",(j["id"],)).fetchone()[0]!="submitting":return True
        actor=db.execute("""SELECT u.* FROM users u JOIN sms_provider p ON p.actor=u.username
             WHERE p.job=? AND u.active=1""",(j["id"],)).fetchone()
        a=communications.load(db,j["oid"])
        o=core.get_order(db,j["oid"],{"role":"admin"})
        why=[]
        if not actor or actor["role"] not in communications.ROLES or actor["username"]!=a.get("owner"):why.append("通知责任人授权已变")
        if a["version"]!=j["version"] or a.get("phone")!=j["phone"]:why.append("预约或收件人已改版")
        if o["status"] in {"cancelled","settled","closed"}:why.append("订单已取消或关单")
        if not why:
            _,why=communications.check(db,o,a,j["template"],clock,True)
            if (clock-datetime.fromisoformat(j["due"])).total_seconds()>900:why.append("已错过授权发送时段")
            if a["zone"]:
                day=clock.astimezone(zone(a["zone"])).date()
                times=db.execute("""SELECT p.attempted_at FROM sms_jobs j JOIN sms_provider p ON p.job=j.id
                    WHERE j.phone=? AND p.attempted_at IS NOT NULL AND j.id<>? AND p.attempted_at>=?""",
                    (j["phone"],j["id"],(clock-timedelta(days=2)).isoformat(timespec="seconds")))
                if sum(datetime.fromisoformat(r[0]).astimezone(zone(a["zone"])).date()==day for r in times)>=3:why.append("当日频控")
        if why:
            manual(db,j["id"],"；".join(why)+"，请电话跟进")
            return True
        try:
            result=transport(cfg,j)
            sid=result.get("sid","")
            if not re.fullmatch(r"SM[0-9a-fA-F]{32}",sid):raise ValueError()
            db.execute("UPDATE sms_provider SET sid=?,provider_state=?,price=?,currency=? WHERE job=?",
                       (sid,result.get("status","accepted"),result.get("price"),result.get("price_unit"),j["id"]))
            db.execute("UPDATE sms_jobs SET state='submitted',reason='' WHERE id=?",(j["id"],))
        except ERR as exc:
            code=str(exc).removeprefix("Twilio ")
            db.execute("UPDATE sms_provider SET error_code=? WHERE job=?",(code,j["id"]))
            manual(db,j["id"],"供应商拒绝 / 提交待核 "+code+"，请电话跟进")
        except (OSError,ValueError,TypeError,AttributeError):
            manual(db,j["id"],"提交结果待核 Twilio 记录，禁止自动重发")
        return True


def webhook(db,cfg,path,body,signature):
    require_live(db,cfg)
    try:params=parse_qs(body.decode("utf-8"),keep_blank_values=True,strict_parsing=True,max_num_fields=128)
    except (UnicodeError,ValueError):raise ERR(400,"无效回调格式")
    signed=cfg["origin"]+path+"".join(k+v for k in sorted(params) for v in sorted(set(params[k])))
    expected=base64.b64encode(hmac.new(cfg["token"].encode(),signed.encode(),hashlib.sha1).digest()).decode()
    if not signature.isascii() or not hmac.compare_digest(signature,expected):raise ERR(403,"无效 Twilio 回调签名")
    def val(k):
        values=params.get(k,[""])
        if len(values)!=1:raise ERR(400,"无效回调字段")
        return values[0]
    sid=val("MessageSid")
    if val("AccountSid")!=cfg["account"] or not re.fullmatch(r"SM[0-9a-fA-F]{32}",sid):raise ERR(403,"回调账户或 SID 不符")
    if path==INCOMING:
        phone=val("From")
        if val("To")!=cfg["sender"] or not re.fullmatch(r"\+[1-9][0-9]{7,14}",phone):raise ERR(403,"入站收发身份不符")
        if not db.execute("INSERT OR IGNORE INTO sms_inbound VALUES(?)",(sid,)).rowcount:return
        if val("OptOutType").upper()=="STOP" or val("Body").strip().upper() in {"STOP","UNSUBSCRIBE","END","QUIT","STOPALL","CANCEL"}:
            db.execute("INSERT OR IGNORE INTO sms_stops VALUES(?)",(phone,))
            db.execute("UPDATE sms_jobs SET state='manual',reason='STOP 已退订，改电话跟进' WHERE phone=? AND state IN ('queued','authorized')",(phone,))
        else:
            # Never infer confirmation or the target order from a shared phone number.
            for row in db.execute("SELECT oid,data FROM appointments WHERE json_extract(data,'$.phone')=?",(phone,)).fetchall():
                a=json.loads(row["data"])
                if a.get("status")=="有效":
                    a["customer"]="收到回复，人工核对确认或改约"
                    db.execute("UPDATE appointments SET data=? WHERE oid=?",(core.encode(a),row["oid"]))
                    communications.invalidate(db,row["oid"],"客户回复待人工复核")
        return
    job=path.removeprefix(STATUS)
    row=db.execute("""SELECT p.sid,p.provider_state,p.attempted_at FROM sms_provider p WHERE job=?""",(job,)).fetchone()
    if not row or not row["attempted_at"] or (row["sid"] and row["sid"]!=sid):raise ERR(409,"回调与提交记录不符")
    status=val("MessageStatus")
    order={"accepted":0,"queued":1,"sending":2,"sent":3,"failed":4,"undelivered":4,"delivered":4}
    if status not in order:return
    old=row["provider_state"]
    if old in ("failed","undelivered","delivered") or order.get(old,-1)>order[status]:return
    failure=status in ("failed","undelivered")
    state="manual" if failure else "delivered" if status=="delivered" else "submitted"
    code=val("ErrorCode")[:20]
    db.execute("UPDATE sms_provider SET sid=?,provider_state=?,error_code=? WHERE job=?",(sid,status,code,job))
    db.execute("UPDATE sms_jobs SET state=?,reason=? WHERE id=?",(state,"发送失败，电话跟进 "+code if failure else "",job))


def main():
    p=argparse.ArgumentParser(description="扫描本地已授权付费短信队列")
    p.add_argument("--db",required=True,type=Path)
    p.add_argument("--once",action="store_true")
    args=p.parse_args()
    if not args.db.is_file():p.error("需要已有员工工作库")
    cfg=settings()
    if not cfg:p.error("正式短信服务未配置")
    with closing(connect(args.db)) as db:
        while True:
            found=once(db,cfg)
            if args.once:break
            if not found:time.sleep(10)


if __name__=="__main__":main()
