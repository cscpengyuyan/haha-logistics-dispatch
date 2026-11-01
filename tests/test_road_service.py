"""HTTP planner contract and opt-in acceptance on an operator's actual DFW graph."""
import copy
import json
import os
import unittest
from unittest.mock import patch

from test_routing import ADMIN, DAY, Scenario
import core
import operations
import road_service
import routing


class RoadInputs(unittest.TestCase):
    def setUp(self):
        self.s = Scenario()
        self.addCleanup(self.s.close)
        self.client = self.s.login("dispatch")
        db = self.s.db
        vehicle = routing.resource(db,"vehicle",self.s.routes[0]["resource_id"])
        values = dict(floor_width_cm=230,floor_length_cm=700,door_width_cm=210,truck_length_m=8.2,truck_width_m=2.44,truck_height_m=3.6,gross_t=10,axle_load_t=5)
        operations.save_resource(db,{**vehicle,"type":"vehicle",**values},ADMIN)
        depot = routing.origin_resource(db,"Dallas")
        operations.save_resource(db,{**depot,"type":"warehouse","lat":32.7832,"lng":-96.8012,
                                      "address":"SIM Dallas origin entrance","evidence":"SIM-ENTRANCE"},ADMIN)
        for index,(lat,lon) in enumerate([(32.779,-96.799),(32.785,-96.802),(32.7843,-96.792),
                                           (32.7775,-96.7914),(32.7815,-96.8068)]):
            o = self.s.orders[index]
            o.update(lat=lat,lng=lon,location_precision="dock",coordinate_ref=f"SIM-ENTRY-{index}")
            self.s.orders[index] = core.save(db,o,ADMIN,"confirm_site","SIM-KEYFRAME")
        db.commit()

    def plan(self, indices):
        orders = [self.s.orders[i] for i in indices]
        data = routing.example_plan(self.s.db,orders[0],ADMIN,executor="SIM-TX")
        facts = next(iter(data["stops"].values()))
        data.update(order_ids=[o["id"] for o in orders],order_versions={o["id"]:o["version"] for o in orders},
                    stops={o["id"]:{**facts,"length_cm":105,"width_cm":92,"finish_by":DAY+"T17:30"} for o in orders},
                    optimize=True,service_minutes=45)
        return data

    def calc(self, body):
        return self.s.request(self.client,"/api/road/plan",body)

    def save(self, data, road):
        return self.s.request(self.client,"/api/ops/routes",{**data,"order_ids":road["order_ids"],
                              "road_basis":"valhalla_truck","road_id":road["id"]})


class TestPlannerContract(RoadInputs):
    def test_provider_contract_changes_rollback_and_fail_closed(self):
        data = self.plan([0,1,2])
        seen = []
        def fake(name,path,req):
            seen.append((path,req))
            if path == "/sources_to_targets":
                return {"sources_to_targets":[[{"time":abs(j-i)*30} for i in range(4)] for j in range(4)]}
            if path == "/":
                return {"code":0,"routes":[{"steps":[{"type":"job","id":i} for i in [2,3,1]]}],"unassigned":[]}
            points = [[p["lon"],p["lat"]] for p in req["locations"]]
            return {"code":"Ok","routes":[{"geometry":{"type":"LineString","coordinates":points},
                                          "legs":[{"distance":510,"duration":43} for _ in points[1:]]}]}
        with patch.dict(os.environ,HH_VALHALLA_URL="http://127.0.0.1:1",HH_VROOM_URL="http://127.0.0.1:1"),patch.object(road_service,"post",side_effect=fake):
            status, body = self.calc(data)
            self.assertEqual(status,200,body)
            road = body["road"]
            self.assertEqual(road["order_ids"],[data["order_ids"][i] for i in [1,2,0]])
            self.assertEqual([p for p,r in seen],["/sources_to_targets","/","/route"])
            self.assertEqual(seen[0][1]["costing_options"]["truck"],{"length":8.2,"width":2.44,"height":3.6,"weight":10.0,"axle_load":5.0})
            self.assertEqual(seen[0][1]["costing_options"],seen[2][1]["costing_options"])
            self.assertEqual(seen[1][1]["vehicles"][0]["capacity"],[6,1600,700])
            self.assertEqual(len(seen[1][1]["matrices"]["truck"]["durations"]),4)
            self.assertEqual(seen[2][1]["locations"][1],seen[0][1]["sources"][2])
            status,result = self.save(data,road)
            self.assertEqual(status,200,result)
            self.assertEqual(result["route"]["road"],road)
            self.assertEqual(result["route"]["stops"][road["order_ids"][0]]["travel"],"1")
            altered = copy.deepcopy(data);altered["start_time"]="09:00"
            self.assertEqual(self.save(altered,road)[0],409)
            with self.assertRaisesRegex(core.ApiError,"不可用"):
                road_service.check_live()
        # A manually supplied label cannot mint a server result.
        self.assertEqual(self.save(data,{**road,"id":"fake"})[0],409)
        for basis in ["demo_cache","estimate","private_osrm"]:
            status,out = self.s.request(self.client,"/api/ops/routes",{**data,"road_basis":basis})
            self.assertEqual(status,200,out)
            self.assertIn("仅可存草案","".join(out["route"]["check_result"]["issues"]))

    def test_permissions_cutoff_and_unverified_address(self):
        data = self.plan([0])
        self.assertEqual(self.s.request(self.s.login("driver"),"/api/road/plan",data)[0],403)
        data["stops"][data["order_ids"][0]]["finish_by"]=DAY+"T08:01"
        self.assertEqual(self.calc(data)[0],422)
        o = self.s.orders[0];o["location_precision"]="zip"
        self.s.orders[0] = core.save(self.s.db,o,ADMIN,"address","SIM-ZIP")
        self.s.db.commit()
        status,body = self.calc(self.plan([0]))
        self.assertEqual(status,422,body)
        self.assertIn("实际入口",body["error"])


@unittest.skipUnless(os.environ.get("HH_LIVE_DFW")=="1","needs a real DFW Valhalla and VROOM deployment")
class TestDFWRoads(RoadInputs):
    def test_two_address_sets_reorder_and_reopen(self):
        summaries = []
        for indices in ([0,1,2],[2,3,4]):
            data = self.plan(indices)
            status,response = self.calc(data)
            self.assertEqual(status,200,response)
            road = response["road"]
            self.assertEqual(len(road["legs"]),3)
            self.assertEqual(set(road["order_ids"]),set(data["order_ids"]))
            self.assertGreater(len(road["geometry"]),8)
            self.assertTrue(all(l["distance"]>0 and l["duration"]>0 for l in road["legs"]))
            status,response = self.save(data,road)
            self.assertEqual(status,200,response)
            self.assertEqual(response["route"]["check_result"]["issues"],[])
            drafts = operations.list_records(self.s.db,True,ADMIN)
            restored = next(r for r in drafts if r["id"]==response["route"]["id"])
            self.assertEqual(restored["road"],road)
            summaries.append(dict(source=road["source"],timestamp=road["timestamp"],
                                  meters=round(sum(l["distance"] for l in road["legs"])),
                                  seconds=round(sum(l["duration"] for l in road["legs"])),
                                  points=len(road["geometry"]),revision=restored["version"]))
            manual = {**data,"order_ids":list(reversed(road["order_ids"])),"optimize":False}
            status,result = self.calc(manual)
            self.assertEqual(status,200,result)
            self.assertEqual(result["road"]["order_ids"],manual["order_ids"])
            self.assertNotEqual(result["road"]["geometry"],road["geometry"])
        with patch.dict(os.environ,HH_VALHALLA_URL="http://127.0.0.1:1"):
            status, failed = self.s.issue(self.client,2,restored)
            self.assertEqual(status,503,failed)
        status, issued = self.s.issue(self.client,2,restored)
        self.assertEqual(status,200,issued)
        self.assertEqual(issued["order"]["release_route"]["route_version"],restored["version"])
        road_service.check_live()
        print("DFW real truck results:",json.dumps(summaries))


if __name__ == "__main__":
    unittest.main()
