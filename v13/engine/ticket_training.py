"""Synthetic exercise on the imported Dallas sale. All writes use normal release gates."""
import math
import core
import communications
import folder
import gate
import operations
import practice
import routing

SERIALS = ["SIM-RFQ-M01-01","SIM-RFQ-M01-02"]
PERMISSIONS = {"lock":"warehouse", "road":"dispatch","issue":"dispatch","release":"warehouse","sign":"driver","settle":"finance"}


def handle(db, method, path, body, user):
    mode = db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()
    if not mode or mode[0] != "demo":
        raise core.ApiError(404, "仅对隔离演练库开放")
    oid, action = path.split("/")[-2:]
    expected = PERMISSIONS.get(action)
    if method != "POST" or not expected or user["role"] not in {"admin",expected}:
        raise core.ApiError(403, "请切换至本环节岗位")
    o = core.get_order(db,oid,user)
    core.check_version(o,body)
    if not (o.get("training") and o.get("crm_ref")=="DEMO-DAL-02" and o["model"]=="M01" and o["quantity"]==2 and o.get("level")=="L3" and not o.get("addon_l5") and o["zip"]=="75201"):
        raise core.ApiError(409, "限本次演练导入的达拉斯两台票，先完成物流接手")
    def act(key, **kw):
        return core.apply_action(db,oid,dict(action=key,version=o["version"],**kw),user)
    if action == "lock":
        o=act("ready",sn=",".join(SERIALS),release_ref="SIM-WH-2SN-CHECKED")
    elif action=="road":
        if o["status"]!="ready" or not o.get("selected_quote") or o.get("route")!="B":
            raise core.ApiError(409,"先完成本票直送书面委托")
        if not(o.get("coordinate_ref") and o.get("location_precision")=="dock" and body.get("origin")==[32.781,-96.815] and body.get("stop")==[o.get("lat"),o.get("lng")]==[32.779,-96.799]):
            raise core.ApiError(409,"演练入口不匹配，重新核址")
        values=[body.get(k) for k in ("kilometers","duration_min")]
        if not all(type(v) in (int,float) and math.isfinite(v) and 0<v<200 for v in values):
            raise core.ApiError(400,"道路计算结果无效")
        o["training_road"]={k:body[k] for k in ("origin","stop","kilometers","duration_min")}
        o["training_road"].update(source=core.required(body,"source",300),scope=communications.scope(o),quote_id=o["selected_quote"]["id"])
        o=core.save(db,o,user,"demo_road","Dallas 试排；只用于本票演练")
    elif action=="issue":
        q=o.get("selected_quote") or {}
        road=o.get("training_road") or {}
        if o["status"]!="ready" or not q.get("id") or q["id"]!=road.get("quote_id") or road.get("scope")!=communications.scope(o) or o.get("sales_review_pending"):
            raise core.ApiError(409,"需当前版本的书面委托与本票已存道路试排")
        plan=routing.example_plan(db,o,user,executor=q["executor_id"])
        plan["stops"][oid].update(travel=math.ceil(road["duration_min"]),road_ref="SIM carrier checked Dallas drill route")
        route=operations.save_route(db,plan,user)["route"]
        origin=routing.origin_resource(db,o["warehouse"])
        link=gate.network(db,dict(executor_id=q["executor_id"],crew_id=route["crew_id"],vehicle_id=route["resource_id"],driver="driver",
                  plate="SIM-DFW-510",warehouse_id=origin["id"],zip=o["zip"],model=o["model"],level=o["level"],product=q["product"],
                  valid_until="2036-12-31",insurance_until="2036-12-31",evidence="SIM fleet and insurance"),user)
        grant=gate.invite(db,o,dict(leg=1,link_id=link["id"],evidence="SIM invite",contract_ref="SIM contract",delegation_ref="SIM delegated crew"),user)
        gate.handle(db,"POST","/api/gate/"+oid+"/accept",dict(version=o["version"],grant_version=grant["version"],leg=1,evidence="SIM crew accepted"),user)
        o=act("dispatch",driver="driver",carrier=q["carrier"],approved_cost=q["amount"],dispatch_ref="SIM approved dispatch",
              checks={k:"SIM F04 "+k for k in core.CHECKS},route_id=route["id"],route_version=route["version"])
    elif action=="release":
        g=gate.active(db,oid,1)
        if not g: raise core.ApiError(409,"需要有效派车签发")
        o=gate.verify(db,o,dict(release_version=o.get("issue_version"),pickup_code=o.get("pickup_code"),driver="driver",
                 plate=g["plate"],crew_id=g["crew_id"],vehicle_id=g["vehicle_id"],sns=SERIALS,evidence="SIM warehouse handover"),user)
    elif action=="sign":
        if body.get("serials")!=SERIALS: raise core.ApiError(400,"请逐一勾选两台 SN")
        day=o["window_start"][:10]
        added=core.add_file(db,oid,dict(version=o["version"],release_version=o["issue_version"],category="pod",name="simulation-pod.pdf",base64=practice.synthetic_pod()),user)
        units=[dict(sn=sn,outcome="success",details=o["delivery_actions"],location=o["endpoint"],pod_id=added["file"]["id"]) for sn in SERIALS]
        o=folder.add_attempt(db,core.get_order(db,oid,user),dict(release_version=o["issue_version"],arrival_local=day+"T10:00",finished_local=day+"T10:45",location=o["endpoint"],evidence="SIM POD",units=units),user)
        o=act("deliver",release_version=o["issue_version"],signer="SIM consignee",delivered_at=day+"T10:45",delivery_note="SIM received at installed position")
    elif action=="settle":
        if o.get("approved_cost")!=510:raise core.ApiError(409,"当前演练发票 510 美元与批准金额不一致，需人工核账")
        o=act("settle",actual_cost=510,change_cost=0,invoice_ref="SIM-INV-510",usa_lines={"origin":0,"delivery_wait":510,"technical":0})
    return {"order":core.present(o,user)}
