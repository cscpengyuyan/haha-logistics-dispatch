from datetime import datetime,timedelta
import core
import operations
import lifecycle
DEMO_NAMES = dict(admin="演练管理员", sales="销售专员", warehouse="仓库主管", dispatch="调度专员",
                  driver="演练车组", finance="财务专员", service="售后专员")
def seed(db):
    for role, name in DEMO_NAMES.items():
        db.execute("INSERT INTO users(username,name,role,passhash) VALUES(?,?,?,'!')", (role, name, role))
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
    for i,(city,state,zip_code,lat,lng,warehouse,model,qty,route,level,target) in enumerate(rows,1):
        for n in range(1,qty+1):
            lifecycle.receipt(db,dict(sn=f"DEMO-{i}-{n}",warehouse=warehouse,model=model,bin=f"A-{i:02d}",condition="演练已验合格",batch=f"DEMO-ASN-{i}",evidence=f"DEMO-GRN-{i}",state="available"),admin)
        order = core.create_order(db, {"customer": ["展厅","零售点","办公楼","自提客户","合作商","物业","门店"][i-1] + f" · 演练 {i:02d}",
             "city":city,"zip":zip_code,"state":state,"address":city+" 演练作业点（城市范围示例）",
             "lat":lat,"lng":lng,"warehouse":warehouse,"model":model,"quantity":qty,"route":route,
             "level":level,"pickup":i==4,"endpoint":"仓库装车区" if i==4 else "本单约定的" + {"L3":"一层营业机位","L2":"入口门厅","L1":"卸货区"}[level],
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
            act("dispatch", driver="driver",carrier="演练车组",dispatch_ref=f"DEMO-D{i}",handoff_ref="DEMO-H1",
                approved_cost=250,checks={key:f"DEMO-F04-{i} 行 {n}" for n,key in enumerate(core.CHECKS,1)})
        if target == "in_transit":
            act("depart")
        if target == "exception":
            act("exception",reason="等待物业准入凭证",custodian="演练仓库",next_step="调度向物业核实并登记回执")
    if operations:
        operations.seed_demo(db)
