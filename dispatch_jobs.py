"""Durable local optimization queue. Leases fence cancelled and restarted attempts."""
import hashlib,json,secrets,threading,time,uuid
from contextlib import closing
import core,planning
TERMINAL={'completed','failed','cancelled'}
def schema(db):
 planning.init_db(db)
 db.execute('CREATE TABLE IF NOT EXISTS dispatch_job_keys (actor TEXT,key TEXT,digest TEXT,job_id TEXT,PRIMARY KEY(actor,key))')
def view(row):
 data=json.loads(row['data']);return dict(id=row['id'],state=row['state'],attempt=row['attempt'],version=row['version'],plan_id=row['plan_id'],result=data.get('result'),error=data.get('error'))
def get(db,jid,user):
 row=db.execute('SELECT * FROM dispatch_jobs WHERE id=?',(jid,)).fetchone()
 if not row or json.loads(row['data'])['user']['username']!=user['username']:raise core.ApiError(404,'计算任务不存在')
 return row
def handle(db,method,path,body,user):
 if user['role'] not in {'admin','dispatch'}:raise core.ApiError(403,'仅调度可以运行计算任务')
 if path=='/api/ops/jobs' and method=='POST':
  payload=dict(body);key=payload.pop('idempotency_key',None)
  if key is not None and (not isinstance(key,str) or not 8<=len(key)<=160):raise core.ApiError(422,'计算重试编号格式无效')
  digest=planning.digest(payload)
  planning.ids_from(payload)
  if key:
   prior=db.execute('SELECT digest,job_id FROM dispatch_job_keys WHERE actor=? AND key=?',(user['username'],key)).fetchone()
   if prior:
    if prior['digest']!=digest:raise core.ApiError(409,'同一重试编号不能对应不同计算输入')
    return {'job':view(get(db,prior['job_id'],user))}
  jid='JOB-'+uuid.uuid4().hex
  # Authorize and capture the input before enqueueing. Final publication checks it again.
  _,input_hash=planning.snapshot(db,payload.get('order_ids',[]),user)
  data=dict(body=payload,user={k:user[k] for k in ('username','role')},input_hash=input_hash)
  db.execute('INSERT INTO dispatch_jobs VALUES(?,?,?,?,?,?,?,?)',(jid,None,'queued',0,None,0,1,core.encode(data)))
  if key:db.execute('INSERT INTO dispatch_job_keys VALUES(?,?,?,?)',(user['username'],key,digest,jid))
  return {'job':view(get(db,jid,user))}
 suffix=path.removeprefix('/api/ops/jobs/');jid=suffix.split('/')[0]
 row=get(db,jid,user)
 if method=='GET' and '/' not in suffix:return {'job':view(row)}
 if method=='POST' and suffix==jid+'/cancel':
  if row['state'] not in TERMINAL:db.execute("UPDATE dispatch_jobs SET state='cancelled',version=version+1,lease=NULL WHERE id=?",(jid,))
  return {'job':view(get(db,jid,user))}
 raise core.ApiError(404,'计算任务接口不存在')
def run_one(connect,path,jid):
 token=secrets.token_hex(16)
 with closing(connect(path)) as db:
  db.execute('BEGIN IMMEDIATE')
  row=db.execute('SELECT * FROM dispatch_jobs WHERE id=?',(jid,)).fetchone()
  if not row or not(row['state']=='queued' or row['state']=='running' and row['expires']<time.time()):db.rollback();return
  data=json.loads(row['data']);attempt=row['attempt']+1
  db.execute("UPDATE dispatch_jobs SET state='running',attempt=?,lease=?,expires=?,version=version+1 WHERE id=?",(attempt,token,time.time()+45,jid));db.commit()
 stop=threading.Event()
 def heartbeat():
  while not stop.wait(10):
   with closing(connect(path)) as heartbeat_db:
    heartbeat_db.execute("UPDATE dispatch_jobs SET expires=? WHERE id=? AND lease=? AND state='running'",(time.time()+45,jid,token))
 thread=threading.Thread(target=heartbeat,daemon=True);thread.start()
 try:
  with closing(connect(path)) as db:
   _,current=planning.snapshot(db,data['body']['order_ids'],data['user'])
   if current!=data['input_hash']:raise core.ApiError(409,'STALE_INPUT: 排队期间输入已变化，请重新提交')
   result=planning.optimize(db,data['body'],data['user'],publish=False)
   db.commit()
   db.execute('BEGIN IMMEDIATE')
   row=db.execute('SELECT * FROM dispatch_jobs WHERE id=?',(jid,)).fetchone()
   if row['state']!='running' or row['lease']!=token or row['expires']<time.time():db.rollback();return
   planning.save_result(db,result['plan'],data['user'])
   data['result']=result
   db.execute("UPDATE dispatch_jobs SET state='completed',plan_id=?,data=?,lease=NULL,version=version+1 WHERE id=? AND lease=?",(result['plan']['plan_id'],core.encode(data),jid,token));db.commit()
 except Exception as exc:
  with closing(connect(path)) as db:
   data['error']={'message':str(exc),'status':getattr(exc,'status',500)}
   db.execute("UPDATE dispatch_jobs SET state='failed',data=?,lease=NULL,version=version+1 WHERE id=? AND lease=? AND state='running'",(core.encode(data),jid,token))
 finally:stop.set();thread.join(timeout=1)
def start(connect,path):
 stop=threading.Event();active={}
 def loop():
  while not stop.wait(.25):
   for jid,t in list(active.items()):
    if not t.is_alive():active.pop(jid)
   if len(active)>=2:continue
   try:
    with closing(connect(path)) as db:
     ids=[r[0] for r in db.execute("SELECT id FROM dispatch_jobs WHERE state='queued' OR (state='running' AND expires<?) LIMIT 2",(time.time(),))]
    for jid in ids:
     if len(active)>=2:break
     if jid in active:continue
     t=threading.Thread(target=run_one,args=(connect,path,jid),daemon=True);active[jid]=t;t.start()
   except Exception:continue
 dispatcher=threading.Thread(target=loop,daemon=True);stop.dispatcher=dispatcher;dispatcher.start();return stop
