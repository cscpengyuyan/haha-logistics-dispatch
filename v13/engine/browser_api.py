"""Runs only in the public, per-browser practice environment."""
import base64
import json
import os
import re
import sqlite3
import core
import operations
from demo_seed import seed

DBFILE = "/practice.sqlite3"
db = None

def connect_demo():
    global db
    if db is not None:
        db.close()
    db = sqlite3.connect(DBFILE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    fresh=not db.execute("SELECT 1 FROM sqlite_master WHERE name='orders'").fetchone()
    core.core_schema(db)
    with db:
        mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
        if mode and mode[0]!="demo":
            raise core.ApiError(409,"此浏览器仅可打开演练库，请核对备份来源")
        db.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES('mode','demo')")
    operations.init_db(db)
    if fresh:
        with db:
            seed(db)
    else:
        with db:
            operations.upgrade_demo_quotes(db)
    import practice
    with db: practice.provision_training(db)

def call(path,method,body,username):
    users=[dict(x) for x in db.execute("SELECT id,username,role,name FROM users ORDER BY id")]
    user=next((u for u in users if u["username"]==username),None)
    if path=="/api/session":return {"user":user,"demo":True,"demo_users":users}
    if path=="/api/demo-login":
        u=next((u for u in users if u["username"]==body.get("username")),None)
        if not u:raise core.ApiError(400,"请选择演练岗位")
        return {"user":u}
    if path=="/api/logout":return {"ok":True}
    if not user:raise core.ApiError(401,"请先选择演练岗位")
    if path=="/api/drivers":return {"drivers":[u for u in users if u["role"]=="driver"] if user["role"] in {"admin","warehouse","dispatch","procurement"} else []}
    with db:
        import partner
        limited=partner.restrict(db,path,method,body,user)
        if limited is not None:return limited
        if path=="/api/practice/dfw":
            import practice
            return practice.handle(db,method,body,user)
        if path=="/api/orders":
            if method=="GET":return {"orders":core.list_orders(db,user)}
            if method=="POST":return {"order":core.create_order(db,body,user)}
        match=re.fullmatch(r"/api/orders/([^/]+)(?:/(actions|files))?",path)
        if match:
            oid,sub=match.groups()
            if method=="GET" and not sub:return core.order_detail(db,oid,user)
            if method=="PATCH" and not sub:return {"order":core.edit_order(db,oid,body,user)}
            if method=="POST" and sub=="actions":return {"order":core.apply_action(db,oid,body,user)}
            if method=="POST" and sub=="files":return core.add_file(db,oid,body,user)
        match=re.fullmatch(r"/api/files/(\d+)",path)
        if match:
            row=db.execute("SELECT * FROM files WHERE id=?",(match[1],)).fetchone()
            if row and any(f["id"]==row["id"] for f in core.order_detail(db,row["order_id"],user)["files"]):
                return {"base64":base64.b64encode(row["content"]).decode(),"mime":row["mime"]}
            raise core.ApiError(404,"附件不存在")
        out=operations.handle(db,method,path,body,user)
        if out is not None:return out
        raise core.ApiError(404,"演练接口不存在")

def handle_json(payload):
    try:
        req=json.loads(payload)
        result=call(req["path"],req["method"],req["body"],req["username"])
        return json.dumps({"value":result},ensure_ascii=False)
    except core.ApiError as e:
        return json.dumps({"error":str(e),"status":e.status},ensure_ascii=False)

