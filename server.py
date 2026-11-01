"""Internal logistics service; runs on Python 3.10+ with no third-party dependencies."""
import argparse
import getpass
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import secrets
import sqlite3
import ssl
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import sys
ROOT = Path(__file__).resolve().parent
if (ROOT / '.deps' / 'optimizer').is_dir():
    sys.path.insert(0, str(ROOT / '.deps' / 'optimizer'))
APP_VERSION = os.environ.get('HH_APP_VERSION', 'v13')
if APP_VERSION not in {'v12', 'v13'}:
    raise RuntimeError('HH_APP_VERSION must be v12 or v13')
STATIC = ROOT / APP_VERSION
sys.path.insert(0, str(STATIC / 'engine'))
import core
import lifecycle
from core import ApiError
from static_ranges import send_archive

import operations
import road_service
from demo_seed import seed, DEMO_NAMES

SALT_BYTES = 16
ROUNDS = 600_000
SESSION_TTL = 10*3600
LOOPBACK = {"127.0.0.1", "localhost"}
MIME = {".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml",
        ".json": "application/json", ".geojson": "application/geo+json"}
LOGGER = logging.getLogger("dispatch")


def connect(path):
    db = sqlite3.connect(path, timeout=8, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def password_hash(password, salt=None):
    salt = secrets.token_bytes(SALT_BYTES) if salt is None else salt
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ROUNDS)
    return salt.hex() + "." + digest.hex()


def username(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", value):
        raise ApiError(400, "用户名限 1–64 位字母、数字、点、横线和下划线")
    return value


def initialize(path, demo):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as db:
        existing = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        mode = "demo" if demo else "production"
        if existing:
            found = db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone() if "metadata" in existing else None
            if not found or found[0] != mode:
                raise ValueError("数据库模式不匹配或文件不是本平台数据库。请为正式和演练指定不同路径。")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS request_journal (actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,key))")
        core.core_schema(db)
        if operations:
            operations.init_db(db)
        if APP_VERSION == 'v13':
            import dispatch_jobs
            dispatch_jobs.schema(db)
        db.execute("BEGIN IMMEDIATE")
        with db:
            if APP_VERSION == 'v13':
                import migrations
                migrations.migrate(db)
            existing_mode = db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
            if existing_mode and existing_mode[0] != mode:
                raise ValueError("库模式冲突")
            if not existing_mode:
                db.execute("INSERT INTO metadata VALUES('mode',?)", (mode,))
                if demo:
                    seed(db)
            elif demo and operations:
                operations.upgrade_demo_quotes(db)
            if demo and not db.execute("SELECT 1 FROM orders WHERE id GLOB 'SIM200-*' LIMIT 1").fetchone():
                import practice
                practice.provision_training(db)


def user_view(row):
    return {k: row[k] for k in ("id","username","name","role")}


def token_key(raw):
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, dbpath, demo=False, public_host=None, secure=False):
        super().__init__(addr, Handler)
        self.path = dbpath
        self.demo = demo
        self.secure = secure
        self.hosts = LOOPBACK | {addr[0].lower()}
        if public_host:
            self.hosts.add(public_host.lower())
        self.guard = threading.Lock()
        self.failures = {}
        self.fake_hash = password_hash(secrets.token_urlsafe(32))
        self.jobs_stop = None
        if APP_VERSION == 'v13':
            import dispatch_jobs
            self.jobs_stop = dispatch_jobs.start(connect, dbpath)

    def server_close(self):
        if self.jobs_stop:
            self.jobs_stop.set()
            self.jobs_stop.dispatcher.join(timeout=2)
        super().server_close()

    def allow_attempt(self, ip, account):
        # Track the pair to avoid one mistyped password locking every user behind a proxy.
        key = (ip, account)
        with self.guard:
            cutoff = time.monotonic() - 300
            if len(self.failures) > 1024:
                self.failures = {k:v for k,v in self.failures.items() if v and v[-1] > cutoff}
            items = [t for t in self.failures.get(key, []) if t > cutoff]
            if len(items) >= 8:
                raise ApiError(429, "登录尝试过于频繁，请稍后再试")
            if len(self.failures) >= 4096 and key not in self.failures:
                raise ApiError(429, "登录服务繁忙，请稍后再试")
            self.failures[key] = items + [time.monotonic()]
        return key


class Handler(BaseHTTPRequestHandler):
    server_version = "Dispatch"
    sys_version = ""
    timeout = 15

    def log_message(self, format, *args):
        pass  # URLs and operator data do not belong in the access log.

    def headers_out(self, status, kind, size, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Referrer-Policy","no-referrer")
        self.send_header("X-Frame-Options","DENY")
        training = urlsplit(self.path).path.startswith("/training/")
        wasm = " 'wasm-unsafe-eval'" if training or self.server.demo else ""
        self.send_header("Content-Security-Policy", f"default-src 'self'; script-src 'self'{wasm}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: https://tiles.openfreemap.org; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def json(self, status, value, extra=None):
        payload = core.encode(value).encode("utf-8")
        self.headers_out(status, "application/json; charset=utf-8", len(payload), extra)
        self.wfile.write(payload)

    def origin_check(self):
        host = self.headers.get("Host","")
        try:
            cf = urlsplit("//"+host)
            # Reject credentials, paths and unparsable ports; allow only configured names.
            cf.port
            if cf.username is not None or cf.path or cf.hostname not in self.server.hosts:
                raise ValueError()
        except ValueError:
            raise ApiError(403, "Host 不受信任")
        origin = self.headers.get("Origin")
        if origin is not None:
            expected = ("https" if self.server.secure else "http") + "://" + host
            if origin.lower() != expected.lower():
                raise ApiError(403, "拒绝跨来源操作")
        if self.headers.get("Sec-Fetch-Site") == "cross-site" and self.command != "GET":
            raise ApiError(403, "拒绝跨站写入")

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ApiError(415, "请求需使用 JSON 格式")
        try:
            size = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise ApiError(411, "请提供请求大小")
        if not 0 < size <= 7*1024*1024:
            raise ApiError(413, "请求过大或为空")
        try:
            data = json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, RecursionError):
            raise ApiError(400, "无效 JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "请求须为 JSON 对象")
        return data

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie",""))
        except CookieError:
            return ""
        value = cookie["session"].value if "session" in cookie else ""
        return value if re.fullmatch(r"[A-Za-z0-9_-]{43}", value) else ""

    def auth(self, db):
        token = self.token()
        row = db.execute("""SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
                            WHERE u.active=1 AND s.token=? AND s.expires>?""",
                         (token_key(token), int(time.time()))).fetchone() if token else None
        return user_view(row) if row else None

    def cookie(self, token, ttl):
        return f"session={token}; Max-Age={ttl}; HttpOnly; SameSite=Strict; Path=/" + ("; Secure" if self.server.secure else "")

    def authenticate(self, db, path, body):
        name = username(body.get("username"))
        special = path == "/api/demo-login"
        if special and (not self.server.demo or self.client_address[0] != "127.0.0.1" or name not in {*DEMO_NAMES,"supplier"}):
            raise ApiError(403, "演练登录仅在本机演练库有效")
        row = db.execute("SELECT * FROM users WHERE username=? AND active=1", (name,)).fetchone()
        if special:
            if not row:
                raise ApiError(401, "账号已停用")
        else:
            key = self.server.allow_attempt(self.client_address[0], name)
            password = body.get("password","")
            if not isinstance(password,str) or len(password) > 1024:
                raise ApiError(401, "账号或密码无效")
            stored = row["passhash"] if row and row["passhash"] != "!" else self.server.fake_hash
            actual = password_hash(password, bytes.fromhex(stored.split(".")[0]))
            if not row or not hmac.compare_digest(actual, row["passhash"]):
                raise ApiError(401, "账号或密码无效")
            with self.server.guard:
                self.server.failures.pop(key,None)
        token = secrets.token_urlsafe(32)
        db.execute("DELETE FROM sessions WHERE expires<=? OR token=?", (int(time.time()),token_key(self.token())))
        db.execute("INSERT INTO sessions VALUES(?,?,?)", (token_key(token),row["id"],int(time.time())+SESSION_TTL))
        return {"user": user_view(row)}, {"Set-Cookie": self.cookie(token, SESSION_TTL)}

    def api(self, path, db, body):
        method = self.command
        if method == 'GET' and path == '/api/health':
            from importlib.util import find_spec
            return {'ok': True, 'app_version': APP_VERSION,
                    'engine_version': Path(core.__file__).parent.parent.name,
                    'static_entry': '/' + APP_VERSION + '/',
                    'data_mode': 'demo' if self.server.demo else 'production',
                    'road_configured': road_service.configured(),
                    'road_coverage': os.environ.get('HH_ROAD_COVERAGE', '未配置'),
                    'road_data_date': os.environ.get('HH_ROAD_DATA_DATE'),
                    'cp_sat_available': find_spec('ortools') is not None}
        user = self.auth(db)
        if method=="GET" and path=="/api/session":
            return {"user":user,"demo":self.server.demo,"app_version":APP_VERSION,
                    "engine_version":Path(core.__file__).parent.parent.name,
                    "routing":road_service.configured(),
                    "road_coverage":os.environ.get("HH_ROAD_COVERAGE","由运营方登记"),
                    "tiles":os.environ.get("HH_TILES_ENABLED")=="1",
                    "demo_users":[dict(r) for r in db.execute("SELECT username,role,name FROM users WHERE active=1") if r["username"] in {*DEMO_NAMES,"supplier"}] if self.server.demo else []}
        if method == "POST" and path in ("/api/login","/api/demo-login"):
            return self.authenticate(db,path,body)
        if not user:
            raise ApiError(401, "请先登录")
        if method == "POST" and path == "/api/logout":
            db.execute("DELETE FROM sessions WHERE token=?",(token_key(self.token()),))
            return {"ok":True}, {"Set-Cookie":self.cookie("",0)}
        import partner
        limited=partner.restrict(db,path,method,body,user)
        if limited is not None:return limited
        if path.startswith('/api/ops/jobs') and APP_VERSION == 'v13':
            import dispatch_jobs
            return dispatch_jobs.handle(db,method,path,body,user)
        if path == '/api/ops/plans/optimize' and APP_VERSION == 'v13' and method == 'POST':
            raise ApiError(422, '本机优化请提交 /api/ops/jobs；计算任务在独立进程线程中运行并支持取消')
        live_sms=re.fullmatch(r"/api/communications/authorize/([a-zA-Z0-9_-]+)",path)
        if live_sms and method=="POST":
            if self.server.demo or not self.server.secure:raise ApiError(403,"正式短信须使用员工 HTTPS 服务")
            import sms_worker
            from datetime import timezone
            return sms_worker.authorize(db,live_sms[1],body,user,sms_worker.settings(),datetime.now(timezone.utc))
        if path=="/api/communications/service" and method=="GET":
            import communications, sms_worker
            if user["role"] not in communications.ROLES:raise ApiError(403,"无通讯操作权限")
            return {"live":bool(not self.server.demo and self.server.secure and sms_worker.settings())}
        if method == "POST" and path == "/api/road/practice" and self.server.demo:
            import road_practice
            return road_practice.prepare(db,user)
        if method == "POST" and path == "/api/road/plan":
            return road_service.compute(db,body,user)
        if method == "POST" and path == "/api/road/candidates":
            return road_service.candidates(db,body,user)
        if path == "/api/practice/dfw":
            if not self.server.demo: raise ApiError(404,"样单仅在演练环境开放")
            import practice
            return practice.handle(db,method,body,user)
        if path == "/api/drivers" and method == "GET":
            if user["role"] not in {"dispatch","admin","warehouse","procurement"}:
                return {"drivers":[]}
            return {"drivers":[dict(r) for r in db.execute("SELECT username,name FROM users WHERE role='driver' AND active=1 ORDER BY name")]}
        if path == "/api/orders":
            if method == "GET":
                return {"orders":core.list_orders(db,user)}
            if method == "POST":
                return {"order":core.create_order(db,body,user)}
        route = re.fullmatch(r"/api/orders/([a-zA-Z0-9_-]+)(?:/(actions|files))?",path)
        if route:
            oid, subroute = route.groups()
            if not subroute and method == "GET":
                return core.order_detail(db,oid,user)
            if not subroute and method == "PATCH":
                return {"order":core.edit_order(db,oid,body,user)}
            if subroute == "actions" and method == "POST":
                return {"order":core.apply_action(db,oid,body,user)}
            if subroute == "files" and method == "POST":
                return core.add_file(db,oid,body,user)
        link = re.fullmatch(r"/api/files/(\d{1,16})",path)
        if link and method == "GET":
            row = db.execute("SELECT order_id,category FROM files WHERE id=?", (link[1],)).fetchone()
            if not row:
                raise ApiError(404,"附件不存在")
            core.get_order(db,row["order_id"],user)
            if user["role"] == "driver" and row["category"] not in {"release","pod","site"}:
                raise ApiError(403,"此附件当前岗位不可见")
            blob = db.execute("SELECT name,mime,content FROM files WHERE id=?",(link[1],)).fetchone()
            return bytes(blob["content"]), {"Content-Disposition": "attachment; filename*=UTF-8''"+quote(blob["name"],safe="")}, blob["mime"]
        if path.startswith("/api/simulation/") and self.server.demo:
            import simulation
            result = simulation.handle(db,method,path,body,user)
            if result is not None:return result
        if operations:
            result = operations.handle(db,method,path,body,user)
            if result is not None:
                return result
        raise ApiError(404, "接口不存在")

    def transact(self,path,db,body):
        key=self.headers.get("Idempotency-Key")
        if path=="/api/road/plan" or not key or self.command=="GET" or path in {"/api/login","/api/logout","/api/demo-login"}:
            return self.api(path,db,body)
        if not re.fullmatch(r"[a-zA-Z0-9_.:-]{8,128}",key):
            raise ApiError(400,"重试编号无效")
        user=self.auth(db)
        if not user: raise ApiError(401,"请先登录")
        digest=hashlib.sha256(json.dumps([user["role"],self.command,path,body],sort_keys=True).encode()).hexdigest()
        row=db.execute("SELECT digest,result FROM request_journal WHERE actor=? AND key=?",(user["username"],key)).fetchone()
        if row:
            if digest!=row["digest"]: raise ApiError(409,"重试编号已用于不同请求，请刷新后重办")
            saved=json.loads(row["result"])
            if user["role"]=="driver":
                order_id=body.get("order_id") or (path.split("/")[3] if path.startswith("/api/orders/") else None)
                if not order_id: raise ApiError(409,"操作已受理，请刷新已授权任务")
                core.get_order(db,order_id,user)
            return saved
        result=self.api(path,db,body)
        db.execute("INSERT INTO request_journal VALUES(?,?,?,?)",(user["username"],key,digest,json.dumps(result,ensure_ascii=False)))
        return result

    def static(self, path):
        if self.command not in {"GET","HEAD"}:
            raise ApiError(405, "方法不支持")
        if path in ("/","/training",'/' + APP_VERSION):
            target = '/' + APP_VERSION + '/' if path == '/' + APP_VERSION or self.server.demo else "/training/"
            self.headers_out(302,"text/plain",0,{"Location":target})
            return
        training = path.startswith("/training/")
        prefix = "/training/" if training else '/' + APP_VERSION + '/'
        if not path.startswith(prefix):
            raise ApiError(404,"文件不存在")
        relative = unquote(path[len(prefix):]) or "index.html"
        file = (STATIC / relative).resolve()
        if not file.is_relative_to(STATIC.resolve()) or not file.is_file():
            raise ApiError(404,"文件不存在")
        canonical = file.relative_to(STATIC.resolve()).as_posix()
        if not training and (canonical.startswith(("engine/", "runtime/")) or file.name in {"demo.js","demo-worker.js"}):
            raise ApiError(404,"共享服务不提供浏览器数据库")
        if file.suffix == ".pmtiles":
            return send_archive(self,file)
        payload = file.read_bytes()
        if file.name == "index.html":
            payload=payload.replace(b"<html ",b'<html data-shared-host="1" ',1)
        if file.name == "index.html" and not training:
            html = re.sub(r'<script defer src="\./demo\.js[^"]*"></script>', '', payload.decode())
            payload = html.replace("正在打开独立演练空间，首次使用需加载地图与运行库…", "正在连接共享工作库…").encode()
        self.headers_out(200,MIME.get(file.suffix,mimetypes.guess_type(file.name)[0] or "application/octet-stream"),len(payload))
        if self.command != "HEAD":
            self.wfile.write(payload)

    def execute(self):
        try:
            self.origin_check()
            path = urlsplit(self.path).path
            if re.fullmatch(r"/api/twilio/(incoming|status/[a-f0-9]{24})",path):
                self.twilio_callback(path)
                return
            if not path.startswith("/api/"):
                self.static(path)
                return
            if self.command == "HEAD":
                self.headers_out(405,"text/plain",0)
                return
            body = self.read_json() if self.command in {"POST","PATCH","PUT","DELETE"} else {}
            with closing(connect(self.server.path)) as db:
                db.execute("BEGIN" if self.command == "GET" or path in {"/api/road/plan", "/api/road/candidates"} else "BEGIN IMMEDIATE")
                with db:
                    result = self.transact(path,db,body)
            if isinstance(result,tuple):
                if len(result)==3:
                    blob,extra,mime = result
                    self.headers_out(200,mime,len(blob),extra)
                    self.wfile.write(blob)
                else:
                    self.json(200,*result)
            else:
                self.json(200,result)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError):
            return
        except ApiError as e:
            self.json(e.status, {"error":str(e)})
        except sqlite3.OperationalError as e:
            LOGGER.exception("database operation failed")
            self.json(503, {"error":"数据库暂不可用，请刷新后核对并重试"})
        except Exception:
            LOGGER.exception("request failed")
            self.json(500, {"error":"服务内部错误，修改已回滚"})

    do_HEAD=do_GET=do_POST=do_PATCH=do_PUT=do_DELETE=execute

    def twilio_callback(self,path):
        import sms_worker
        if self.command!="POST" or self.server.demo or not self.server.secure or self.path!=path:raise ApiError(403,"回调入口不可用")
        if self.headers.get_content_type()!="application/x-www-form-urlencoded":raise ApiError(415,"无效回调类型")
        try:size=int(self.headers.get("Content-Length",""))
        except ValueError:raise ApiError(411,"缺回调长度")
        if not 0<size<=32768:raise ApiError(413,"无效回调大小")
        raw=self.rfile.read(size)
        with closing(connect(self.server.path)) as db:
            db.execute("BEGIN IMMEDIATE")
            with db:sms_worker.webhook(db,sms_worker.settings(),path,raw,self.headers.get("X-Twilio-Signature",""))
        out=b"<Response/>" if path==sms_worker.INCOMING else b""
        self.headers_out(200,"application/xml",len(out))
        self.wfile.write(out)


def main():
    p = argparse.ArgumentParser(description="哈哈便利内部物流协作平台")
    p.add_argument("--db",type=Path); p.add_argument("--demo",action="store_true")
    p.add_argument("--host",default="127.0.0.1"); p.add_argument("--port",type=int,default=8765)
    p.add_argument("--tls-cert"); p.add_argument("--tls-key")
    p.add_argument("--public-host",help="允许的反向代理公开域名（不含端口）")
    p.add_argument("--behind-https",action="store_true",help="仅绑定本机且已使用 HTTPS 反向代理")
    subs=p.add_subparsers(dest="command")
    create=subs.add_parser("add-user"); create.add_argument("username"); create.add_argument("--name",required=True)
    create.add_argument("--role",choices=core.ROLES,required=True)
    subs.add_parser("reset-password").add_argument("username")
    subs.add_parser("disable-user").add_argument("username")
    subs.add_parser("backup").add_argument("destination",type=Path)
    a=p.parse_args()
    path = (a.db or ROOT/"data"/(APP_VERSION + ("-demo.sqlite3" if a.demo else "-production.sqlite3"))).resolve()
    try:
        if a.demo and (a.host not in LOOPBACK or a.public_host or a.behind_https):
            raise ValueError("演练服务只能在本机使用")
        if (a.host not in LOOPBACK and not (a.tls_cert and a.tls_key)) or bool(a.tls_cert)!=bool(a.tls_key):
            raise ValueError("开放内网监听需要 --tls-cert 与 --tls-key")
        if a.behind_https and (a.host not in LOOPBACK or not a.public_host):
            raise ValueError("HTTPS 代理模式必须绑定本机并明确 --public-host")
        initialize(path,a.demo)
        if a.command:
            if a.demo and a.command != "backup":
                raise ValueError("演练账号固定，请在正式库管理真实员工")
            with closing(connect(path)) as db:
                if a.command=="backup":
                    dest=a.destination.resolve()
                    with dest.open("xb"):
                        pass
                    with closing(sqlite3.connect(dest)) as target:
                        db.backup(target)
                    print("备份完成",dest)
                    return
                name=username(a.username)
                if a.command in {"add-user","reset-password"}:
                    password=getpass.getpass("新口令 (至少12字符): ")
                    if len(password)<12 or len(password)>1024 or password!=getpass.getpass("确认口令: "):
                        raise ValueError("口令长度不符或输入不一致")
                    digest=password_hash(password)
                db.execute("BEGIN IMMEDIATE")
                with db:
                    if a.command=="add-user":
                        db.execute("INSERT INTO users(username,name,role,passhash) VALUES(?,?,?,?)",
                                   (name,core.required(vars(a),"name",80),a.role,digest))
                    else:
                        row=db.execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()
                        if not row:
                            raise ValueError("账号不存在")
                        if a.command=="disable-user":
                            db.execute("UPDATE users SET active=0 WHERE id=?",tuple(row))
                        else:
                            db.execute("UPDATE users SET passhash=?,active=1 WHERE id=?",(digest,row["id"]))
                        db.execute("DELETE FROM sessions WHERE user_id=?",tuple(row))
            print("账号设置已保存")
            return
        httpd=Server((a.host,a.port),path,a.demo,a.public_host,bool(a.tls_cert or a.behind_https))
        if a.tls_cert:
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(a.tls_cert,a.tls_key)
            httpd.socket=ctx.wrap_socket(httpd.socket,server_side=True)
        print(f"Dispatch {APP_VERSION} / engine {Path(core.__file__).parent.parent.name} {'DEMO' if a.demo else 'INTERNAL'} · {'https' if a.tls_cert else 'http'}://{a.host}:{httpd.server_port}/{APP_VERSION}/ · {path}",flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
    except (ValueError, ApiError, OSError, sqlite3.Error) as e:
        p.exit(2, str(e)+"\n")


if __name__=="__main__":
    main()
