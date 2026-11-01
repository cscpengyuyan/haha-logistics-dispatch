"""Real, local HTTP concurrency checks. All orders, sessions and attachments are disposable."""
import contextlib
import concurrent.futures
import http.cookiejar
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
import core, folder, gate, lifecycle, operations, routing
ADMIN={"username":"admin","role":"admin"}
DAY="2030-07-10"


class Scenario:
    def __init__(self):
        self.tmp=tempfile.TemporaryDirectory()
        path=Path(self.tmp.name)/"routes.sqlite3"
        server.initialize(path,True)
        self.db=server.connect(path)
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES('dispatch2','模拟调度乙','dispatch',?)",(server.password_hash('simulation-test-only'),))
        self.orders=[self.order(i) for i in range(5)]
        self.routes=[self.route([0],"08:00"),self.route([1],"08:00"),self.route([2,3],"11:00"),self.route([4],"15:00")]
        self.db.commit()
        self.service=server.Server(("127.0.0.1",0),path,True)
        self.url="http://127.0.0.1:"+str(self.service.server_port)
        self.worker=threading.Thread(target=self.service.serve_forever,daemon=True);self.worker.start()

    def close(self):
        self.service.shutdown();self.service.server_close();self.worker.join();self.db.close();self.tmp.cleanup()

    def order(self,n):
        db=self.db;sn=f"SIM-ROUTE-{n}"
        o=core.create_order(db,dict(crm_ref=sn,customer="SIM loading dock",warehouse="Dallas",address="SIM Dock "+str(2 if n==3 else n),contact="SIM Receiver",city="Dallas",state="TX",zip="75201",model="M01",quantity=1,lat=32.78+(2 if n==3 else n)*.01,lng=-96.806,endpoint="SIM lobby",level="L3",procurement_mode="brand_fleet",route="B",timezone="America/Chicago",window_start=DAY+"T08:00",window_end=DAY+"T18:00"),ADMIN)
        lifecycle.receipt(db,dict(sn=sn,model="M01",bin="SIM-Z1",warehouse="Dallas",condition="intact",batch="SIM-ASN",evidence=sn,state="available"),ADMIN)
        o=core.apply_action(db,o['id'],dict(action="ready",version=o["version"],sn=sn,release_ref="SIM-GRN"),ADMIN)
        o=folder.platform_instruction(db,o,dict(account_ref="SIM-COST-CENTER",instruction_ref="SIM-INTERNAL",executor_id="SIM-TX",carrier="SIM Fleet",acceptance_ref="SIM-ACK",valid_until=DAY,allocation=0,cost_center="SIM-TX"),ADMIN)
        plan=routing.example_plan(db,o,ADMIN,executor="SIM-TX")
        if n==0:
            dr=gate.network(db,dict(executor_id="SIM-TX",crew_id=plan["crew_id"],vehicle_id=plan["resource_id"],driver="driver",plate="SIM-PLATE",warehouse_id=routing.origin_resource(db,"Dallas")["id"],zip="75201",model="M01",level="L3",product="T2",valid_until=DAY,insurance_until=DAY,evidence="SIM-ROSTER"),ADMIN)
            self.link=dr['id']
        grant=gate.invite(db,o,dict(leg=1,link_id=self.link,evidence=sn),ADMIN)
        gate.handle(db,"POST",f"/api/gate/{o['id']}/accept",dict(leg=1,version=o['version'],grant_version=grant['version'],evidence="SIM-ACK"),ADMIN)
        return o

    def route(self,indices,start):
        orders=[self.orders[i] for i in indices]
        data=routing.example_plan(self.db,orders[0],ADMIN,executor="SIM-TX")
        data.update(name="SIM-"+start+"-"+str(indices),start_time=start,order_ids=[o['id'] for o in orders],order_versions={o['id']:o['version'] for o in orders})
        data["checks"]["warehouse_end"]=DAY+"T17:00"
        for i,o in enumerate(orders[1:],1):
            data["stops"][o["id"]]={**data["stops"][orders[0]["id"]],"from_id":orders[i-1]["id"]}
        return operations.save_route(self.db,data,ADMIN)["route"]

    def request(self,client,path,body):
        req=urllib.request.Request(self.url+path,data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Origin":self.url})
        try:
            with client.open(req) as res:return res.status,json.load(res)
        except urllib.error.HTTPError as e:return e.code,json.load(e)

    def login(self,name):
        client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        status,out=self.request(client,"/api/login" if name=="dispatch2" else "/api/demo-login",{"username":name,"password":"simulation-test-only"})
        assert status==200,(status,out)
        return client

    def issue(self,client,index,route):
        o=self.orders[index]
        return self.request(client,"/api/orders/"+o['id']+"/actions",dict(action="dispatch",version=o["version"],driver=route["checks"]["driver"],carrier="SIM Fleet",approved_cost=0,dispatch_ref="SIM-F04",route_id=route["id"],route_version=route["version"],checks={k:"SIM-CHECK-"+k for k in core.CHECKS}))


class TestDispatchRoutes(unittest.TestCase):
    def setUp(self):
        self.s=Scenario();self.addCleanup(self.s.close)
    def test_two_accounts_compete_then_multistop_and_nonoverlap(self):
        a,b=self.s.login("dispatch"),self.s.login("dispatch2")
        barrier=threading.Barrier(2)
        def send(c,i):
            barrier.wait();return self.s.issue(c,i,self.s.routes[i])
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            f=pool.submit(send,a,0);g=pool.submit(send,b,1)
            results=[f.result(),g.result()]
        self.assertEqual(sorted(status for status,_ in results),[200,409],results)
        self.assertIn("占用",next(body['error'] for status,body in results if status==409))
        # The shared 11:00 two-stop run may issue both tickets; the 15:00 route may reuse this crew.
        for i,r in [(2,2),(3,2),(4,3)]:
            status,data=self.s.issue(b,i,self.s.routes[r]);self.assertEqual(status,200,data)
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM orders WHERE json_extract(data,'$.release_route.executor_id')='SIM-TX'").fetchone()[0],4)

    def check_one_shared_resource(self,only):
        db=self.s.db;o=self.s.orders[1];r=self.s.routes[1]
        original=gate.active(db,o["id"],1)
        gate.handle(db,"POST",f"/api/gate/{o['id']}/revoke",dict(leg=1,version=o["version"],grant_version=original["version"],evidence="SIM-CHANGE"),ADMIN)
        old=gate.obj(db.execute("SELECT * FROM gate_links WHERE id=?",(self.s.link,)).fetchone())
        new={k:v for k,v in old.items() if k not in ("id","version","type")}
        for kind,key,route_key in (("crew","crew_id","crew_id"),("vehicle","vehicle_id","resource_id")):
            if kind==only:continue
            existing=routing.resource(db,kind,new[key])
            copy={k:v for k,v in existing.items() if k not in ("id","version")}
            copy.update(type=kind,name=copy["name"]+" B")
            new[key]=operations.save_resource(db,copy,ADMIN)["resource"]["id"];r[route_key]=new[key]
        if only!="driver":
            db.execute("INSERT INTO users(username,name,role,passhash) VALUES('driver2','模拟驾驶乙','driver','!')")
            new["driver"]="driver2";r["checks"]["driver"]="driver2"
        g=gate.network(db,new,ADMIN)
        invite=gate.invite(db,o,dict(leg=1,link_id=g["id"],evidence="SIM-LINK"),ADMIN)
        gate.handle(db,"POST",f"/api/gate/{o['id']}/accept",dict(leg=1,version=o["version"],grant_version=invite["version"],evidence="SIM-ACK"),ADMIN)
        r=operations.save_route(db,r,ADMIN)["route"]
        a,b=self.s.login("dispatch"),self.s.login("dispatch2")
        barrier=threading.Barrier(2)
        def race(client,index,route):barrier.wait();return self.s.issue(client,index,route)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            x=pool.submit(race,a,0,self.s.routes[0]);y=pool.submit(race,b,1,r)
            statuses=[x.result(),y.result()]
        self.assertEqual(sorted(code for code,_ in statuses),[200,409],statuses)
        self.assertIn("占用",next(v["error"] for code,v in statuses if code==409))

    def test_only_vehicle_overlaps(self):
        self.check_one_shared_resource("vehicle")

    def test_only_driver_overlaps(self):
        self.check_one_shared_resource("driver")

    def test_leased_vehicle_and_contracted_crew_require_leg_evidence(self):
        db=self.s.db;o=self.s.orders[0];initial=self.s.routes[0]
        # Re-register the same assets to their actual owners.
        for kind,key in (("vehicle","resource_id"),("crew","crew_id")):
            r=routing.resource(db,kind,initial[key])
            operations.save_resource(db,{**r,"type":kind,"executor_id":"SIM-OWNER-"+kind},ADMIN)
        route=self.s.route([0],"08:00")
        self.assertTrue(any("租车" in i for i in route["check_result"]["issues"]))
        status,b=self.s.issue(self.s.login("dispatch"),0,route)
        self.assertEqual(status,409,b)
        g=gate.active(db,o["id"],1)
        gate.handle(db,"POST",f"/api/gate/{o['id']}/revoke",dict(leg=1,version=o['version'],grant_version=g['version'],evidence="SIM-REASSIGN"),ADMIN)
        old=gate.obj(db.execute("SELECT * FROM gate_links WHERE id=?",(self.s.link,)).fetchone())
        current=gate.network(db,{**old,"hire_ref":"SIM-LEASE","mandate_ref":"SIM-CREW-MANDATE","starts_on":DAY},ADMIN)
        g=gate.invite(db,o,dict(leg=1,link_id=current["id"],evidence="SIM-NOMINATION"),ADMIN)
        gate.handle(db,"POST",f"/api/gate/{o['id']}/accept",dict(leg=1,version=o['version'],grant_version=g['version'],evidence='SIM-ACCEPT'),ADMIN)
        route=self.s.route([0],"08:00")
        self.assertEqual(route["check_result"]["issues"],[])
        status,b=self.s.issue(self.s.login("dispatch"),0,route)
        self.assertEqual(status,200,b)
        self.assertEqual(b["order"]["release_route"]["executor_id"],"SIM-TX")

    def test_confirmed_shared_stop_keeps_each_ticket_sn_and_labor(self):
        s=self.s;r=s.routes[2];orders=s.orders[2:4];a,b=orders
        f=r["stops"][b["id"]]
        self.assertEqual(r["check_result"]["stop_count"],2)
        f.update(merge_after=a["id"],merge_ref="SIM-SIGNED-SAME-DOCK")
        merged=operations.save_route(s.db,r,ADMIN)["route"]
        result=merged["check_result"];self.assertEqual(result["issues"],[])
        self.assertEqual(result["stop_count"],1)
        times=result["timeline"];self.assertEqual([t["stop"] for t in times],[1,1])
        self.assertEqual([t["sns"] for t in times],[a["sn"],b["sn"]])
        self.assertEqual(times[1]["start"],times[0]["departure"])
        self.assertEqual(sum(t["service_minutes"] for t in times),80)
        for key,value in (("contact","OTHER"),("window_end",DAY+"T18:15"),("endpoint","different door")):
            invalid=routing.check_route(s.db,r,[a,{**b,key:value}])
            self.assertIn("同停确认失效","".join(invalid["issues"]))
        client=s.login("dispatch")
        outputs=[s.issue(client,i,merged) for i in (2,3)]
        self.assertEqual([c for c,_ in outputs],[200,200],outputs)
        self.assertEqual([x["order"]["release_route"]["stop"] for _,x in outputs],[1,1])

    def test_time_evidence_and_capacity_guards(self):
        db=self.s.db;orders=self.s.orders[:2];r=self.s.route([0,1],"09:00")
        a,b=orders
        r['stops'][a['id']].update(travel=20,admission=0,service=60)
        r['stops'][b['id']].update(travel=35,admission=15,site_end=DAY+'T11:00')
        report=routing.check_route(db,r,orders)
        self.assertIn("第 2 站 开工晚 10 分钟",report['issues'])
        self.assertEqual(report['timeline'][1]['start'],DAY+'T16:10:00+00:00')
        r['stops'][b['id']].update(kg='10000',height='300',from_id='stale',dock_ref='',required_people=4,required_tools='not-in-crew-kit')
        issues="".join(routing.check_route(db,r,orders)['issues'])
        for text in ("包装高度","载重","装卸口","实此段起点","人数不足","工具未落实","尾板额定载重不足"):
            self.assertIn(text,issues)
        low=[dict(o,location_precision="zip") for o in orders]
        self.assertIn("ZIP 代表点不能签发","".join(routing.check_route(db,r,low)["issues"]))
        self.assertFalse(routing.point({'lat':0,'lng':0}))
        self.assertFalse(routing.point({'lat':None,'lng':-95}))

    def test_coverage_rejects_nj_crew_and_timezone_needs_unique_instant(self):
        o=self.s.orders[0];plan=routing.example_plan(self.s.db,o,ADMIN,executor="SIM-TX",crew_coverage="07102")
        r=operations.save_route(self.s.db,plan,ADMIN)['route']
        self.assertIn("覆盖","".join(r['check_result']['issues']))
        code,body=self.s.issue(self.s.login('dispatch'),0,r)
        self.assertEqual(code,409,body);self.assertIn("覆盖",body['error'])
        self.assertIsNone(routing.local_utc("2030-11-03T01:30","America/Chicago"))
        self.assertIsNone(routing.local_utc("2030-03-10T02:15","America/Chicago"))
        self.assertEqual(routing.local_utc("2030-11-03T01:30-05:00","America/Chicago"),routing.local_utc("2030-11-03T01:30-05:00","America/New_York"))
        self.assertEqual(routing.local_utc("2030-07-10T08:00","America/Chicago"),routing.local_utc("2030-07-10T09:00","America/New_York"))

if __name__=='__main__':
    if sys.argv[1:] in (['serve'],['serve-perf']):
        s=Scenario()
        try:
            if sys.argv[1]=='serve-perf':
                s.db.execute("BEGIN IMMEDIATE")
                for n in range(1000):
                    core.create_order(s.db,dict(crm_ref=f"PERF-{n:04d}",customer=f"SIM row {n}",warehouse="Dallas",address=f"synthetic site {n}",city="Dallas",state="TX",zip="75201",model="M01",quantity=1,lat=32.69+(n%40)*.004,lng=-96.91+(n//40)*.003,endpoint="SIM lobby",level="L3",route="B",timezone="America/Chicago",window_start=DAY+"T08:00",window_end=DAY+"T18:00"),ADMIN)
                s.db.commit()
            print(json.dumps(dict(url=s.url,orders=[o['id'] for o in s.orders],routes=[r['id'] for r in s.routes])),flush=True)
            sys.stdin.readline()
        finally:s.close()
    else:unittest.main()
