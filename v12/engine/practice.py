"""Guided practice on real domain records; mounted ONLY by the two synthetic demo adapters.
Each handoff runs as the authenticated operator, inside one transaction. No role override.
"""
import base64
import json
import core, operations, folder, review

SN = ("DFW-Q01-M01-01", "DFW-Q01-M01-02")
DAY = "2026-11-05"
STEPS = [
 ("sales","确认销售承诺","同址两台 M01，一层机位 L3，另购 L5；保留原窗口。"),
 ("warehouse","登记装柜与海运","按演练班期建立 40HQ / 28 台 ASN。两台归本票，其余未售。"),
 ("warehouse","休斯敦到港并办理提离","登记晚靠两天、监管放行、船方放货、场站可提及提离；原预约保留。"),
 ("warehouse","达拉斯收货并锁台","逐台登记 27 台合格、1 台受损隔离，从合格机中锁定本票两台。"),
 ("procurement","登记三份同范围报价","现行 680，B 直送 580，C2 全程 656；310 仅为二程。"),
 ("finance","复核现行基线","核对原仓、原窗、动作、五组费用及有效版本。"),
 ("procurement","选用 B 并委托技术","只签一份运输委托，另出一份独立 T5 技术单。"),
 ("dispatch","核实车辆与签发","核十二项、车组、容量与路程凭证，签发本票当前版本。"),
 ("warehouse","仓口按签发版验放","核 SN 和签发版本，登记离仓，接手实物保管。"),
 ("driver","逐台签收","核对每台实际到位与已购动作，两台显式关联同址签名。"),
 ("service","逐台复测启用","核对两台联网与支付测试，登记客户确认。"),
 ("finance","核美国段账单","原仓 30 + 配送含等待 445 + 技术 120；原线等待条件未核。"),
]
def provision_training(db):
    """Install fictional fleet catalog once, separate from each role's business actions."""
    import routing,partner
    partner.schema(db)
    from demo_seed import DEMO_NAMES
    for role,name in DEMO_NAMES.items():
        db.execute("INSERT OR IGNORE INTO users(username,name,role,passhash) VALUES(?,?,?,'!')",(role,name,'driver' if role=='driver_alt' else role))
    db.execute("INSERT OR IGNORE INTO users(username,name,role,passhash) VALUES('supplier','分包执行方乙','supplier','!')")
    db.execute("INSERT OR IGNORE INTO supplier_logins VALUES('supplier','SIM-SUB-B')")
    routing.example_plan(db,dict(id="SIM-RESOURCE-CATALOG",version=1,warehouse="Dallas",window_start=DAY+"T09:00"),{"role":"admin","username":"demo-fixture"},executor="SIM-SUB-B")
    provision_sailings(db)

def provision_sailings(db):
    if not db.execute("SELECT 1 FROM metadata WHERE key='training_sailings_v1'").fetchone():
        wh=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')='Dallas'").fetchone()
        if wh:
            import supply
            base=dict(voyage="SIM-SHA-HOU-01",origin="Shanghai",port="Houston",warehouse_id=wh[0],
                      origin_zone="Asia/Shanghai",port_zone="America/Chicago",transshipment="直航",
                      source="DFW 培训班期表 · 全部日期为演练",confirmation="demo",
                      doc_cutoff="2026-09-28T10:00:00+08:00",gate_cutoff="2026-09-29T16:00:00+08:00",
                      planned_etd="2026-10-01T10:00:00+08:00",planned_eta="2026-10-22T10:00:00-05:00",
                      pickup_eta="2026-10-22T14:00:00-05:00",planned_warehouse="2026-10-23T10:00:00-05:00")
            alternate=dict(base,voyage="SIM-SHA-HOU-02",transshipment="演练中转 1 次",planned_eta="2026-10-24T10:00:00-05:00",
                           pickup_eta="2026-10-24T14:00:00-05:00",planned_warehouse="2026-10-25T10:00:00-05:00")
            ids=supply.register_sailings(db,{"candidates":[base,alternate]},{"role":"admin","username":"demo-fixture"})["ids"]
            db.execute("INSERT INTO metadata VALUES('training_sailings_v1',?)",(ids[0],))
def table(db):
    db.execute("CREATE TABLE IF NOT EXISTS practice_run (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, state TEXT NOT NULL)")
def state(db):
    r=db.execute("SELECT cursor,state FROM practice_run WHERE id=1").fetchone()
    return (r[0],json.loads(r[1])) if r else (0,{})
def view(db,user):
    table(db);n,s=state(db)
    oid=s.get("oid");o=None
    if oid:
        try:o=core.present(core.get_order(db,oid,user),user)
        except core.ApiError:
            if user["role"]!="driver":raise
            oid=None
    price=user["role"] in {"admin","finance","dispatch","procurement"}
    steps=[dict(role=r,title=t,detail=d if price or r not in {"finance","procurement"} else "此环节由授权岗位核对。") for r,t,d in STEPS]
    return dict(cursor=n,steps=steps,id=oid,version=o["version"] if o else None,order_status=o["status"] if o else None,
        issue_version=o.get("issue_version") if o else None,serials=SN if oid else [],
        actual=o.get("actual_cost") if o and price else None, approved=o.get("approved_cost") if o and price else None,
        quotes=s.get("totals",[]) if price else [],log=[e for e in s.get("log",[]) if price or e["role"] not in {"finance","procurement"}],
        can_act=n<len(STEPS) and user["role"]==STEPS[n][0] and (user["role"]!="driver" or oid is not None))
def synthetic_pod():
    # Real one-page PDF with explicit synthetic SN coverage; no customer signature is reused.
    msg=b"BT /F1 12 Tf 40 700 Td (PRACTICE ONLY: DFW-Q01 / M01-01 and M01-02 / L3 accepted) Tj ET"
    bodies=[b"<< /Type /Catalog /Pages 2 0 R >>",b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",b"<< /Length "+str(len(msg)).encode()+b" >>\nstream\n"+msg+b"\nendstream"]
    b=b"%PDF-1.4\n";offsets=[0]
    for i,v in enumerate(bodies,1):
        offsets.append(len(b));b+=f"{i} 0 obj\n".encode()+v+b"\nendobj\n"
    x=len(b);b+=b"xref\n0 6\n0000000000 65535 f \n"+b"".join(f"{v:010} 00000 n \n".encode() for v in offsets[1:])+f"trailer << /Root 1 0 R /Size 6 >>\nstartxref\n{x}\n%%EOF".encode()
    return base64.b64encode(b).decode()
def advance(db,body,user):
    table(db);n,s=state(db)
    if n >= len(STEPS) or n!=body.get("cursor"):raise core.ApiError(409,"接力步骤已更新，请刷新")
    if STEPS[n][0]!=user["role"]:raise core.ApiError(403,"请切换至本步骤的岗位")
    ref=core.required(body,"reference",180)
    oid=s.get("oid")
    def order():return core.get_order(db,oid,user)
    def act(action,**kw):return core.apply_action(db,oid,dict(action=action,version=order()["version"],**kw),user)
    def resource(**kw):return operations.save_resource(db,kw,user)["resource"]
    def sea(op,**kw):
        import supply
        result=supply.handle(db,"POST","/api/supply/"+op,kw,user)
        if "shipment" in result:s.update(ship=result["shipment"]["id"],sv=result["shipment"]["version"])
        return result
    def milestone(k,t):
        handoff=dict(bill_of_lading="SIM-BL-DFW",pickup_site="Houston 演练堆场 H1",inland_owner="演练车组") if k=="handoff_site" else {}
        sea("milestone",id=s["ship"],version=s["sv"],kind=k,at=t,evidence=ref+"-"+k,custodian="DFW 头程演练岗",**handoff)
    if oid and body.get("version")!=order()["version"]:raise core.ApiError(409,"原单已被更新，请刷新并复核最新版本")
    if n in (9,10) and body.get("serials")!=list(SN):raise core.ApiError(400,"请明确核对本票两台设备")
    if n==0:
        o=core.create_order(db,dict(crm_ref="DFW-Q01",customer="DFW 演练展厅",address="达拉斯虚构一层作业点",zip="75201",city="Dallas",state="TX",lat=32.778,lng=-96.806,model="M01",quantity=2,warehouse="Dallas",route="B",level="L3",addon_l5=True,endpoint="一层营业机位",delivery_actions="拆箱、到位、调平；独立技术单联网及支付复测",timezone="America/Chicago",window_start=DAY+"T09:00",window_end=DAY+"T16:00",contact="演练收货岗",notes="虚构演练；"+ref),user)
        oid=s["oid"]=o["id"]
        s["wh"]=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')='Dallas'").fetchone()[0]
    elif n==1:
        provision_sailings(db)
        candidate=db.execute("SELECT value FROM metadata WHERE key='training_sailings_v1'").fetchone()[0]
        serials=[*SN,*(f"DFW-40HQ-{i:02d}" for i in range(3,29))]
        # Explicitly fictional pallet measurements, never reused as a real equipment specification.
        packing=dict(length_cm=100,width_cm=83,height_cm=191,weight_kg=226,upright=True,nonstackable=True)
        sea("book",candidate_id=candidate,batch="DFW-Q01-B",container="SIM-40HQ-01",seal="SIM-SEAL-01",
            bill_of_lading="SIM-BL-DFW",pickup_site="Houston 演练堆场 H1",inland_owner="演练车组",
            asn="SIM-ASN-Q01",mode="FCL",inland="road",owner=user["username"],evidence=ref,
            units=[dict(sn=k,model="M01",order_id=oid if k in SN else None,packing=packing) for k in serials])
        milestone("shipping_docs","2026-09-29T10:00:00+08:00")
        milestone("loaded","2026-10-01T10:00:00+08:00")
    elif n==2:
        milestone("eta","2026-10-24T10:00:00-05:00")
        for i,k in enumerate(("arrived","handoff_site","customs","carrier_release","terminal_ready","pickup")):
            milestone(k,f"2026-10-24T{10+i:02}:00:00-05:00")
    elif n==3:
        import supply
        milestone("warehouse_arrival","2026-10-25T10:00:00-05:00")
        for unit in supply.shipment(db,s["ship"])["units"]:
            k=unit["sn"]; damaged=k=="DFW-40HQ-28"
            sea("receive",id=s["ship"],version=s["sv"],sn=k,state="hold" if damaged else "available",
                condition="外包装破损，待复检" if damaged else "逐台验合格",bin="DFW-QA" if damaged else "DFW-A01",
                evidence=ref+"-"+k,custodian=user["username"])
            if damaged:
                sea("difference",id=s["ship"],version=s["sv"],sn=k,kind="damage",owner=user["username"],
                    evidence=ref+"-"+k,custodian=user["username"])
        act("ready",sn=",".join(SN),release_ref=ref)
    elif n==4:
        import supply
        s["quotes"]=[];s["totals"]=[]
        for label,path,rows in [("现行","B",(30,0,510,140,0)),("B直送","B",(30,0,410,140,0)),("C2经站","C2",(150,56,310,140,0))]:
            rid=resource(type="supplier",name="DFW样例 "+label,address="演练营业地址",ability="T2",qualification="S3",evidence=ref)["id"]
            executor="SIM-SUB-B" if label=="B直送" else "SIM-"+rid
            for action in ("L3","L5"):
                supply.handle(db,"POST","/api/supply/qualify",dict(supplier_id=rid,executor_id=executor,warehouse_id=s["wh"],product="T2",zip="75201",model="M01",action=action,decision="Y",valid_until="2036-12-31",insurance_until="2036-12-31",evidence=ref),user)
            q=resource(type="quote",name=label,carrier="DFW样例 "+label,path=path,order_id=oid,scope="Dallas 同址两台 M01 L3 + L5；同一原窗与包装",comparison_ref="SIM-Q01-R1",amount=sum(rows),**dict(zip(operations.COSTS,rows)),valid_until="2036-12-31",evidence=ref+"-"+label,executor_id=executor,accepted_ref=ref,supplier_id=rid,product="T2",current_ref=ref if label=="现行" else "")
            s["quotes"].append(q["id"]);s["totals"].append({"name":label,"amount":q["amount"]})
        s['t5']=resource(type="supplier",name="DFW 样例独立技师",address="虚构技术点",ability="T5",qualification="S3",evidence=ref)["id"]
        supply.handle(db,"POST","/api/supply/qualify",dict(supplier_id=s['t5'],executor_id=s['t5'],warehouse_id=s["wh"],product="T5",zip="75201",model="M01",action="L5",decision="Y",valid_until="2036-12-31",insurance_until="2036-12-31",evidence=ref),user)
    elif n==5:
        m,b,*_=s["quotes"];review.lock_baseline(db,dict(order_id=oid,order_version=order()["version"],main_id=m,alt_id=b,main_version=1,alt_version=1,baseline_version=0,confirmation=ref),user)
    elif n==6:
        operations.award_quote(db,dict(id=s["quotes"][1],quote_version=1,version=order()["version"],approval_ref=ref),user)
        folder.handle(db,"POST",f"/api/ops/folder/{oid}/technical",dict(version=order()["version"],supplier_id=s["t5"],executor_id=s["t5"],acceptance_ref=ref,scope="两台逐机启用",amount=120),user)
        import routing,gate
        o=order();q=o['selected_quote'];plan=routing.example_plan(db,o,user,executor=q['executor_id'])
        link=gate.network(db,dict(executor_id=q['executor_id'],crew_id=plan['crew_id'],vehicle_id=plan['resource_id'],driver='driver',plate='SIM-TX-201',warehouse_id=s['wh'],zip='75201',model='M01',level='L3',product='T2',valid_until='2036-12-31',insurance_until='2036-12-31',evidence=ref),user)
        s['link']=link['id']
    elif n==7:
        import routing
        import gate
        o=order()
        grant=gate.active(db,oid,1)
        if not grant or grant['state']!='accepted':raise core.ApiError(409,"先从仓口验放页由采购登记分包依据及乙书面接受，再由调度签发")
        plan=routing.example_plan(db,o,user,executor=o['selected_quote']['executor_id'])
        route=operations.save_route(db,plan,user)["route"]
        act("dispatch",carrier=o["selected_quote"]["carrier"],driver="driver",dispatch_ref=ref,approved_cost=580,checks={k:ref+"-"+k for k in core.CHECKS},route_id=route["id"],route_version=route["version"])
    elif n==8:
        import gate
        o=order()
        if o['status']!='in_transit':raise core.ApiError(409,"请先在仓口验放页逐台核实实到司机、车辆、提货号与签发版")
        gate.require_released(db,o)
    elif n==9:
        o=order();fid=core.add_file(db,oid,dict(version=o["version"],release_version=o["issue_version"],category="pod",name="DFW-Q01-synthetic.pdf",base64=synthetic_pod()),user)["file"]["id"]
        units=[dict(sn=k,outcome="success",details="拆箱、到位、调平",location="一层营业机位",pod_id=fid) for k in SN]
        folder.handle(db,"POST",f"/api/ops/folder/{oid}/attempts",dict(version=order()["version"],release_version=o["issue_version"],arrival_local=DAY+"T10:00",finished_local=DAY+"T10:45",location="一层营业机位",evidence=ref,units=units),user)
        act("deliver",release_version=o["issue_version"],signer="虚构收货岗",delivered_at=DAY+"T10:45",delivery_note=ref)
    elif n==10:act("service_complete",result_ref=ref,service_units=[dict(sn=k,result="联网、支付复测通过",customer_ref=ref+"-"+k) for k in SN])
    else:act("settle",actual_cost=595,change_cost=15,change_ref=ref+"-续等批准",invoice_ref=ref,usa_lines=dict(origin=30,delivery_wait=445,technical=120))
    s.setdefault("log",[]).append(dict(role=user["role"],actor=user["username"],at=core.now(),reference=ref,step=n))
    db.execute("INSERT INTO practice_run VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,state=excluded.state",(n+1,json.dumps(s,ensure_ascii=False)))
    return view(db,user)
def handle(db,method,body,user):
    if method=="GET":return view(db,user)
    if method=="POST":return advance(db,body,user)
    raise core.ApiError(405,"不支持此方法")

