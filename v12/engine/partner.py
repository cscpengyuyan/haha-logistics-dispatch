"""Supplier sessions see only their assigned execution legs. No general order search."""
import core,gate
def schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS supplier_logins(username TEXT PRIMARY KEY REFERENCES users(username),executor_id TEXT NOT NULL)")
def control(db,path,method,b,u):
    schema(db);gate.schema(db)
    if path=='/api/supplier/bind' and method=='POST':
        gate.role(u)  # administrator only
        username=core.required(b,'username');executor=core.required(b,'executor_id')
        if not db.execute("SELECT 1 FROM users WHERE username=? AND role='supplier' AND active=1",(username,)).fetchone():raise core.ApiError(400,"须选启用的供应商账号")
        if not db.execute("SELECT 1 FROM gate_links WHERE json_extract(data,'$.executor_id')=?",(executor,)).fetchone():raise core.ApiError(400,"先登记执行方及人车关系")
        db.execute("INSERT INTO supplier_logins VALUES(?,?) ON CONFLICT(username) DO UPDATE SET executor_id=excluded.executor_id",(username,executor))
        gate.log(db,'network',0,'supplier_login_bound',u,{'account':username,'executor_id':executor,'ref':core.required(b,'evidence')})
        return {'ok':True}
    if u['role']!='supplier':raise core.ApiError(403,"仅供应商账号")
    allowed=db.execute("SELECT executor_id FROM supplier_logins WHERE username=?",(u['username'],)).fetchone()
    if path=='/api/supplier/work' and method=='GET':
        rows=db.execute("SELECT * FROM gate_grants WHERE json_extract(data,'$.executor_id')=? ORDER BY rowid DESC",(allowed[0],)) if allowed else []
        return {'assignments':[{k:v for k,v in gate.obj(x).items() if k in ('id','version','state','order_id','leg','crew_id','vehicle_id','driver','plate','sns','issue_version')} for x in rows]}
    if path=='/api/supplier/reply' and method=='POST' and allowed:
        g=gate.obj(db.execute("SELECT * FROM gate_grants WHERE id=? AND json_extract(data,'$.executor_id')=?",(core.required(b,'id'),allowed[0])).fetchone())
        if not g:raise core.ApiError(404,"没有此项委托")
        if g['state']!='invited' or g['version']!=b.get('version'):raise core.ApiError(409,"委托已更新，请刷新确认")
        if b.get('decision') not in ('accept','refuse'):raise core.ApiError(400,"选择接受或拒绝")
        accepted=b['decision']=='accept';ref=core.required(b,'evidence')
        if accepted:gate.validate(db,core.get_order(db,g['oid'],u),g)
        gate.update(db,g,'accepted' if accepted else 'refused',acceptance_ref=ref,accepted_by=u['username'])
        gate.log(db,g['oid'],g['leg'],b['decision'],u,dict(grant=g['id'],evidence=ref))
        return {'ok':True}
    raise core.ApiError(404,"接口不存在")
def restrict(db,path,method,b,u):
    if path.startswith('/api/supplier/'):return control(db,path,method,b,u)
    if u['role']=='supplier':
        if method=='GET' and path in ('/api/orders','/api/ops/routes','/api/ops/resources'):return {path.rsplit('/',1)[-1]:[]}
        raise core.ApiError(403,"此账号仅可查看或回复自己的运段委托")
