"""USD invoice register. A split invoice has one header, one row per beneficiary/order.
This records accounting evidence only. No payment processor or external booking.
"""
from decimal import Decimal
import core,json,uuid
def schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS ap_invoices(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,reference TEXT NOT NULL,issued_on TEXT NOT NULL,total TEXT NOT NULL,actor TEXT NOT NULL,UNIQUE(issuer,reference))")
    db.execute("CREATE TABLE IF NOT EXISTS ap_lines(id INTEGER PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES ap_invoices(id),oid TEXT NOT NULL REFERENCES orders(id),sn TEXT,amount TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,evidence TEXT NOT NULL,state TEXT NOT NULL,paid_ref TEXT)")
def handle(db,method,b,u):
    if u['role'] not in ('finance','admin'):raise core.ApiError(403,'账单行只供核账岗位')
    schema(db)
    if method=='GET':
        return {'lines':[dict(r) for r in db.execute("SELECT l.*,h.issuer,h.reference,h.issued_on,h.total FROM ap_lines l JOIN ap_invoices h ON h.id=l.invoice_id ORDER BY l.id DESC")]}
    act=b.get('action')
    if act=='record_payment':
        ref=core.required(b,'paid_ref');r=db.execute("SELECT state FROM ap_lines WHERE id=?",(b.get('line_id'),)).fetchone()
        if not r or r[0]!='matched':raise core.ApiError(409,'仅已匹配且未核实付的行可登记')
        db.execute("UPDATE ap_lines SET state='paid',paid_ref=? WHERE id=?",(ref,b['line_id']))
        return {'state':'paid'}
    if act!='match':raise core.ApiError(400,'选择匹配发票或登记实付凭证')
    from review import day
    issuer=core.required(b,'issuer');ref=core.required(b,'reference');issued=day(b.get('issued_on'));total=core.money(b.get('total'),signed=True)
    ls=b.get('lines')
    if not isinstance(ls,list) or not 1<=len(ls)<=100:raise core.ApiError(400,'列出各订单/设备分摊行')
    rows=[]
    for l in ls:
        if not isinstance(l,dict):raise core.ApiError(400,'费用行格式无效')
        oid=core.required(l,'order_id');o=core.get_order(db,oid,u);kind=core.required(l,'kind');evidence=core.required(l,'evidence');src=core.required(l,'source')
        amount=core.money(l.get('amount'),signed=True)
        if kind not in ('origin','delivery','technical','storage','change','credit','loss','internal'):raise core.ApiError(400,'费目无效')
        if (kind=='credit') != (amount<0):raise core.ApiError(400,'贷项须为负，其他费用不能为负')
        q=o.get('selected_quote') or o.get('platform_instruction') or {};g=o.get('second_leg') if l.get('leg')==2 else q
        payee=(o.get('technical_order') or {}).get('supplier_id') if kind=='technical' else (g or {}).get('payee_id') or (g or {}).get('supplier_id') or (g or {}).get('executor_id')
        if kind=='origin':payee=l.get('warehouse_payee') if l.get('warehouse_contract_ref') else None
        ok=bool(payee and issuer==payee and o['status'] in ('delivered','settled') and (kind!='change' or o.get('change_ref')))
        sn=l.get('sn') or ''
        if sn and not db.execute("SELECT 1 FROM assets WHERE sn=? AND order_id=?",(sn,oid)).fetchone():raise core.ApiError(409,'专项费用的 SN 不属于本票')
        rows.append((oid,sn,str(amount),kind,src,evidence,'matched' if ok else 'disputed',None))
    if sum(Decimal(x[2]) for x in rows)!=total:raise core.ApiError(409,'各分摊行之和必须等于原发票金额')
    if db.execute("SELECT 1 FROM ap_invoices WHERE issuer=? AND reference=?",(issuer,ref)).fetchone():raise core.ApiError(409,'该主体该发票已登记，不能重复记账')
    iid='INV-'+uuid.uuid4().hex[:12];db.execute("INSERT INTO ap_invoices VALUES(?,?,?,?,?,?)",(iid,issuer,ref,issued,str(total),u['username']))
    db.executemany("INSERT INTO ap_lines(invoice_id,oid,sn,amount,kind,source,evidence,state,paid_ref) VALUES(?,?,?,?,?,?,?,?,?)",[(iid,*r) for r in rows])
    return {'id':iid,'matched':sum(r[6]=='matched' for r in rows),'disputed':sum(r[6]=='disputed' for r in rows)}
