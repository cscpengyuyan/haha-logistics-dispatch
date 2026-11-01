from datetime import datetime,timedelta
import core
import operations
import lifecycle
import folder
import supply
DEMO_NAMES = dict(admin="演练管理员", sales="销售专员", warehouse="仓库主管", dispatch="调度专员",
                  driver="演练车组", driver_alt="演练备援司机", finance="财务专员", service="售后专员", procurement="采购专员")
def seed(db):
    for role, name in DEMO_NAMES.items():
        db.execute("INSERT INTO users(username,name,role,passhash) VALUES(?,?,?,'!')", (role, name, "driver" if role=="driver_alt" else role))
    admin = {"role": "admin", "username": "admin"}
    day = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    rows = [
        ("Dallas", "TX", "75201", 32.778,-96.806, "Dallas", "M01", 2, "B", "L3", "ready"),
        ("Plano", "TX", "75074", 33.021,-96.699, "Dallas", "M04", 1, "B", "L3", "dispatched"),
        ("Fort Worth", "TX", "76102", 32.755,-97.328, "Dallas", "M06", 1, "B", "L2", "new"),
        ("Irving", "TX", "75038", 32.87,-96.968, "Dallas", "M01", 1, "A", "L1", "ready"),
        ("New York", "NY", "10001", 40.751,-73.997, "New Jersey", "M03", 1, "C2", "L2", "in_transit"),
        ("Tacoma", "WA", "98402", 47.252,-122.443, "Fife", "M02", 1, "C1", "L2", "exception"),
        ("Arlington", "TX", "76010", 32.735, -97.079, "Dallas", "M02", 1, "B", "L3", "ready"),
    ]
    to_issue=[]
    for i,(city,state,zip_code,lat,lng,warehouse,model,qty,route,level,target) in enumerate(rows,1):
        for n in range(1,qty+1):
            lifecycle.receipt(db,dict(sn=f"DEMO-{i}-{n}",warehouse=warehouse,model=model,bin=f"A-{i:02d}",condition="演练已验合格",batch=f"DEMO-ASN-{i}",evidence=f"DEMO-GRN-{i}",state="available"),admin)
        order = core.create_order(db, {"customer": ["展厅","零售点","办公楼","自提客户","合作商","物业","门店"][i-1] + f" · 演练 {i:02d}",
             "city":city,"zip":zip_code,"state":state,"address":city+" 演练作业点（城市范围示例）",
             "lat":lat,"lng":lng,"warehouse":warehouse,"model":model,"quantity":qty,"route":route,
             "level":level,"pickup":i==4,"procurement_mode":"platform" if target in {"dispatched","in_transit"} else "company","endpoint":"仓库装车区" if i==4 else "本单约定的" + {"L3":"一层营业机位","L2":"入口门厅","L1":"卸货区"}[level],
             "window_start":day+"T09:00","window_end":day+"T16:00",
             "timezone":{"WA":"America/Los_Angeles","NY":"America/New_York"}.get(state,"America/Chicago"),
             "contact":"演练收货岗","delivery_actions":"按约定终点交接，逐台签认",
             "notes":"虚构数据，仅用于操作练习。地图坐标为演练位置。"},admin)
        oid=order["id"]
        def act(action, **data):
            nonlocal order
            order = core.apply_action(db,oid,dict(data,action=action,version=order["version"]),admin)
        if target != "new":
            act("ready",sn=", ".join(f"DEMO-{i}-{n}" for n in range(1,qty+1)),release_ref=f"DEMO-R{i}")
        if target in {"dispatched","in_transit"}:
            to_issue.append((i,order,target))
        if target == "exception":
            act("exception",reason="等待物业准入凭证",custodian="演练仓库",next_step="调度向物业核实并登记回执")
    if operations:
        operations.seed_demo(db)
    # These are *new synthetic* instruction records, never retroactively assigned to old tickets.
    for i,order,target in to_issue:
        instruction=dict(account_ref="DEMO-ACCOUNT",instruction_ref=f"DEMO-INSTR-{i}",executor_id=f"DEMO-CARRIER-{i}",
                         bol_pro=f"SIM-BOL-{i}",pickup_ref=f"SIM-PICK-{i}",identity_ref="SIM-ID-CARRIER",carrier="演练指定车组",acceptance_ref=f"DEMO-ACCEPT-{i}",valid_until=day)
        order=folder.platform_instruction(db,order,instruction,admin)
        if order["route"]=="C2":
            station=db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')='New Jersey'").fetchone()[0]
            supplier=operations.save_resource(db,dict(type="supplier",name="SIM-NJ Local Team",address="SIM-NJ Dock",
                ability="T2",qualification="S3",evidence="SIM-NJ-S3"),admin)["resource"]
            sid=supplier["id"]
            supply.qualify(db,dict(supplier_id=sid,executor_id=sid,product="T2",warehouse_id=station,zip=order["zip"],model=order["model"],
                action=order["level"],decision="Y",insurance_until=day,valid_until=day,evidence="SIM-NJ-CAP"),admin)
            storage=operations.save_resource(db,dict(type="supplier",name="SIM-NJ Storage Only",address="SIM receiving dock",
                ability="T3",qualification="S3",evidence="SIM-STORAGE"),admin)["resource"]["id"]
            supply.qualify(db,dict(supplier_id=storage,executor_id=storage,product="T3",warehouse_id=station,zip="07102",model=order["model"],
                action="receive",decision="Y",insurance_until=day,valid_until=day,evidence="SIM-Dock"),admin)
            order=folder.second_leg(db,order,dict(station_supplier_id=storage,station_executor_id=storage,station_acceptance_ref="SIM-STORAGE-ACCEPT",supplier_id=sid,executor_id=sid,product="T2",station_id=station,carrier=supplier["name"],
                acceptance_ref="SIM-NJ-ACCEPT",approved_ref="SIM-2-OK",quote_ref="SIM-LEG2",amount=280,valid_until=day),admin)
        dispatch=dict(action="dispatch",version=order["version"],driver="driver",carrier="演练指定车组",
                      dispatch_ref=f"DEMO-D{i}",handoff_ref="DEMO-H1",approved_cost=600 if order["route"]=="C2" else 250,
                      checks={k:f"DEMO-F04-{i}-{k}" for k in core.CHECKS})
        order=core.apply_action(db,order["id"],dispatch,admin)
        if target=="in_transit":
            import gate
            gate.verify(db,core.get_order(db,order["id"],admin),dict(release_version=order["issue_version"],
                pickup_code=instruction["pickup_ref"],bol_ref=instruction["bol_pro"],identity_ref=instruction["identity_ref"],
                sns=[order["sn"]],evidence="DEMO-GATE-HANDOVER"),admin)
