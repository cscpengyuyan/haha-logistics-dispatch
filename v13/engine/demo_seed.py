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
    seed_planning(db, admin)


# V13 派单计划演练数据：同一个出发仓（Dallas）、覆盖未来 7 天，
# 片区（ZIP 前三码）、订单类型（L1/L2/L3）与收货时段各不相同，
# 用来演示"按时间 → 片区 → 类型 → 车次"的排车过程。
PLAN_ROWS = [
    # offset, city, zip, lat, lng, model, qty, level, window start, window end
    (1, "Frisco", "75034", 33.150, -96.823, "M01", 1, "L2", "09:00", "12:00"),
    (1, "McKinney", "75070", 33.197, -96.640, "M04", 1, "L3", "10:00", "14:00"),
    (1, "Richardson", "75080", 32.976, -96.728, "M01", 1, "L1", "13:00", "17:00"),
    (2, "Lewisville", "75067", 33.046, -96.994, "M02", 3, "L3", "09:00", "13:00"),
    (2, "Carrollton", "75006", 32.976, -96.890, "M06", 1, "L2", "10:00", "15:00"),
    (2, "Garland", "75040", 32.913, -96.639, "M01", 1, "L1", "13:00", "16:00"),
    (3, "Denton", "76201", 33.215, -97.133, "M04", 1, "L3", "08:00", "12:00"),
    (3, "Mesquite", "75149", 32.767, -96.599, "M02", 1, "L2", "10:00", "14:00"),
    (4, "Grand Prairie", "75050", 32.746, -96.997, "M01", 3, "L3", "08:00", "11:00"),
    (4, "Irving", "75061", 32.826, -96.951, "M06", 3, "L1", "09:00", "12:00"),
    (4, "Plano", "75023", 33.040, -96.750, "M04", 1, "L3", "13:00", "17:00"),
    (4, "Frisco", "75033", 33.170, -96.860, "M01", 1, "L2", "14:00", "18:00"),
    (5, "Garland", "75043", 32.860, -96.590, "M02", 1, "L2", "09:00", "13:00"),
    (5, "Richardson", "75081", 32.950, -96.700, "M01", 1, "L3", "13:00", "17:00"),
    (6, "McKinney", "75071", 33.210, -96.680, "M04", 1, "L3", "09:00", "12:00"),
    (6, "Lewisville", "75057", 33.020, -96.980, "M06", 1, "L1", "11:00", "15:00"),
    (7, "Mesquite", "75150", 32.820, -96.630, "M02", 1, "L2", "09:00", "12:00"),
    (7, "Denton", "76209", 33.230, -97.100, "M01", 1, "L3", "10:00", "14:00"),
]
ENDPOINT = {"L3": "一层营业机位", "L2": "入口门厅", "L1": "卸货区"}


def seed_planning(db, admin):
    for j, (off, city, zip_code, lat, lng, model, qty, level, ws, we) in enumerate(PLAN_ROWS, 1):
        local_day = (datetime.now() + timedelta(days=off)).strftime("%Y-%m-%d")
        sns = [f"PLAN-{j}-{n}" for n in range(1, qty + 1)]
        for n, sn in enumerate(sns, 1):
            lifecycle.receipt(db, dict(sn=sn, warehouse="Dallas", model=model, bin=f"P-{j:02d}-{n}",
                condition="演练已验合格", batch=f"PLAN-ASN-{j}", evidence=f"PLAN-GRN-{j}", state="available"), admin)
        order = core.create_order(db, {
            "customer": f"{city} 派单点 · 演练 {j:02d}",
            "city": city, "zip": zip_code, "state": "TX",
            "address": city + " 演练作业点（城市范围示例）",
            "lat": lat, "lng": lng, "warehouse": "Dallas", "model": model, "quantity": qty,
            "route": "B", "level": level, "pickup": False, "procurement_mode": "company",
            "endpoint": ENDPOINT[level],
            "window_start": local_day + "T" + ws, "window_end": local_day + "T" + we,
            "timezone": "America/Chicago", "contact": "演练收货岗",
            "delivery_actions": "按约定终点交接，逐台签认",
            "notes": "虚构派单演练数据，仅用于按时间排车练习。"}, admin)
        core.apply_action(db, order["id"], dict(action="ready", version=order["version"],
            sn=", ".join(sns), release_ref=f"PLAN-R{j}"), admin)
