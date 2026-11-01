"""Order-scoped claims, appointment events and controlled CRM import / replay."""
import hashlib,json,re,sqlite3
import core
def schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS handoff (oid TEXT PRIMARY KEY REFERENCES orders(id),version INT NOT NULL,data TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS import_inbox (source TEXT,external_id TEXT,version INT,digest TEXT,state TEXT,payload TEXT,oid TEXT,error TEXT,actor TEXT,ts TEXT,PRIMARY KEY(source,external_id))")
def assignment(db,oid):
    r=db.execute("SELECT version,data FROM handoff WHERE oid=?",(oid,)).fetchone()
    return dict(json.loads(r['data']),version=r['version']) if r else dict(version=0,owner='',contact_owner='',events=[])
def imp(db,b,u):
    if u['role'] not in ('admin','sales'):raise core.ApiError(403,'请由销售或管理员导入 CRM')
    ext=core.required(b,'external_id',120);payload=b.get('order')
    if not isinstance(payload,dict):raise core.ApiError(400,"须提供一票 CRM 对象")
    digest=hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    row=db.execute("SELECT * FROM import_inbox WHERE source='CRM' AND external_id=?",(ext,)).fetchone()
    if row:
        if row['state']=='done':
            if digest!=row['digest']:raise core.ApiError(409,"该外部业务号已导入；请回原单修订")
            return {'state':'done','order_id':row['oid'],'replayed':True}
        if row['version']!=b.get('version'):raise core.ApiError(409,'待核记录已变化，请先读取当前版本')
    # Preserve a failed import for manual remediation without creating a half-order.
    v=row['version']+1 if row else 1
    db.execute("SAVEPOINT external_order")
    try:
        order=core.create_order(db,{**payload,'crm_ref':ext},u);oid=order['id'];state,error='done',''
    except core.ApiError as ex:
        db.execute("ROLLBACK TO external_order");oid=None;state,error='needs_review',str(ex)
    db.execute("RELEASE external_order")
    db.execute("INSERT INTO import_inbox VALUES('CRM',?,?,?,?,?,?,?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET version=excluded.version,digest=excluded.digest,state=excluded.state,payload=excluded.payload,oid=excluded.oid,error=excluded.error,actor=excluded.actor,ts=excluded.ts",(ext,v,digest,state,core.encode(payload),oid,error,u['username'],core.now()))
    return {'state':state,'error':error,'version':v,'order_id':oid}
def handle(db,path,method,b,u):
    schema(db)
    if path=='/api/team/import':
        if method=='POST':return imp(db,b,u)
        if u['role'] not in ('admin','sales'):raise core.ApiError(403,'无导入复核权限')
        return {'queue':[dict(r) for r in db.execute("SELECT external_id,version,payload,error,actor,ts FROM import_inbox WHERE state='needs_review'")]}
    match=re.fullmatch(r'/api/team/([a-zA-Z0-9_-]+)',path)
    if not match:raise core.ApiError(404,"任务不存在")
    oid=match[1];o=core.get_order(db,oid,u)
    if u['role'] in ('driver','supplier'):raise core.ApiError(403,'仅内部岗位可办理移交')
    s=assignment(db,oid)
    if method=='GET':return s
    core.check_version(o,b)
    if b.get('task_version')!=s['version']:raise core.ApiError(409,'认领/预约记录已被同事更新，请刷新后核对')
    a=core.required(b,'action');ref=core.required(b,'evidence');actor=u['username']
    if a=='claim':
        if s['owner'] and actor!=s['owner']:raise core.ApiError(409,'已有经办人，请由原经办人移交或主管代理')
        s['owner']=actor
    elif a in ('handoff','return','delegate','escalate'):
        if actor!=s['owner'] and u['role']!='admin':raise core.ApiError(403,'由原经办人或主管交接')
        target=core.required(b,'to',64)
        if not db.execute("SELECT 1 FROM users WHERE username=? AND active=1 AND role NOT IN ('driver','supplier')",(target,)).fetchone():raise core.ApiError(400,'接手人须是启用的内部账号')
        s['owner']=target
    elif a in ('channel','sent','delivered','reply','confirmed','opt_out'):
        if u['role'] not in ('sales','service','dispatch','admin'):raise core.ApiError(403,'非对外预约岗位')
        if s['contact_owner'] and s['contact_owner']!=actor:raise core.ApiError(409,'已有对外联络人，须先移交')
        s['contact_owner']=actor
        if a=='channel':
            s['channel']=core.required(b,'channel');s['alternative']=core.required(b,'alternative');s['contact_hours']=core.required(b,'contact_hours')
        else:
            if not s.get('channel'):raise core.ApiError(409,'先核客户同意的联系方式与当地可联系时段')
            seq=['sent','delivered','reply','confirmed']
            if a in seq[1:] and s.get('contact_state')!=seq[seq.index(a)-1]:raise core.ApiError(409,'前置联络事件尚未核实，不能推定对方已确认')
            if a=='opt_out':s['channel']=s['alternative']
            s['contact_state']=a
    else:raise core.ApiError(400,'未知移交动作')
    if a in ('handoff','delegate') and s['contact_owner']==actor:s['contact_owner']=s['owner']
    s['events'].append(dict(action=a,actor=actor,to=s['owner'],evidence=ref,at=core.now()))
    version=s.pop('version')+1
    db.execute("INSERT INTO handoff VALUES(?,?,?) ON CONFLICT(oid) DO UPDATE SET version=excluded.version,data=excluded.data",(oid,version,core.encode(s)))
    return dict(s,version=version)
