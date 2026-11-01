"""Create the optional, synthetic loading dock and three new stops in a demo DB."""
from datetime import datetime,timedelta,timezone

import core
import folder
import gate
import lifecycle
import operations
import routing

SITES = [("Main St",32.779,-96.799),("Akard St",32.785,-96.802),("Live Oak St",32.7843,-96.792)]


def prepare(db,user):
    if user["role"] not in ("dispatch","admin"):
        raise core.ApiError(403,"仅调度可开始路线演练")
    if db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()[0] != "demo":
        raise core.ApiError(404,"演练样单仅在演练库开放")
    existing=db.execute("SELECT value FROM metadata WHERE key='dfw_truck_demo_v1'").fetchone()
    if existing:
        return {"route_id":existing[0]}
    actor={"username":"demo-fixture","role":"admin"}
    day=(datetime.now(timezone.utc)+timedelta(days=1)).date().isoformat()
    name="Dallas · 三站路线演练仓"
    depot=operations.save_resource(db,dict(type="warehouse",name=name,address="Synthetic depot, downtown Dallas",
           timezone="America/Chicago",lat=32.7832,lng=-96.8012,zip="75201",evidence="SIM · 合成装卸口"),actor)["resource"]
    orders=[];stops={}
    for i,(street,lat,lng) in enumerate(SITES,1):
        sn=f"SIM-DFW-ROAD-{i}"
        o=core.create_order(db,dict(customer=f"演练收货人 {i}",crm_ref=sn,address="Synthetic loading entrance · "+street,
            city="Dallas",state="TX",zip="75201",contact="模拟收货岗",warehouse=name,model="M01",quantity=1,
            lat=lat,lng=lng,location_precision="dock",coordinate_ref=sn+"-SIM-DOCK",route="B",level="L3",
            endpoint="演练机位",procurement_mode="brand_fleet",timezone="America/Chicago",
            window_start=day+"T08:00",window_end=day+"T17:00"),actor)
        lifecycle.receipt(db,dict(sn=sn,model="M01",bin="SIM-1",warehouse=name,condition="intact",
                                 batch="SIM-ROUTE",evidence=sn+"-SIM-GRN",state="available"),actor)
        o=core.apply_action(db,o["id"],dict(action="ready",version=o["version"],sn=sn,release_ref=sn+"-SIM"),actor)
        o=folder.platform_instruction(db,o,dict(account_ref="SIM-ACCOUNT",instruction_ref="SIM-ROUTE",
                   executor_id="SIM-ROAD-TX",carrier="演练车组",acceptance_ref="SIM-ACK",valid_until=day,
                   allocation=0,cost_center="SIM-DFW"),actor)
        sample=routing.example_plan(db,o,actor,executor="SIM-ROAD-TX",crew_coverage="75201")
        if i==1:
            vehicle=routing.resource(db,"vehicle",sample["resource_id"])
            operations.save_resource(db,{**vehicle,"type":"vehicle","floor_width_cm":230,"floor_length_cm":700,
                 "door_width_cm":210,"truck_length_m":8.2,"truck_width_m":2.44,"truck_height_m":3.6,
                 "gross_t":10,"axle_load_t":5},actor)
            link=gate.network(db,dict(executor_id="SIM-ROAD-TX",crew_id=sample["crew_id"],vehicle_id=vehicle["id"],
                 driver="driver",plate="SIM-DFW",warehouse_id=depot["id"],zip="75201",model="M01",level="L3",
                 product="T2",valid_until=day,insurance_until=day,evidence="SIM-ROAD-ROSTER"),actor)
        grant=gate.invite(db,o,dict(leg=1,link_id=link["id"],evidence=sn),actor)
        gate.handle(db,"POST",f"/api/gate/{o['id']}/accept",dict(leg=1,version=o["version"],
                    grant_version=grant["version"],evidence="SIM-ROAD-ACCEPT"),actor)
        orders.append(o)
        stop=sample["stops"][o["id"]]
        stop.update(length_cm=105,width_cm=92,finish_by=day+"T17:30",travel="",road_ref="")
        stops[o["id"]]=stop
    data={**sample,"name":"Dallas 三站 · 合成订单","road_basis":"estimate","order_ids":[o["id"] for o in orders],
          "order_versions":{o["id"]:o["version"] for o in orders},"stops":stops}
    rid=operations.save_route(db,data,actor)["route"]["id"]
    db.execute("INSERT INTO metadata VALUES('dfw_truck_demo_v1',?)",(rid,))
    return {"route_id":rid}
