import unittest
import test_supply
import settlement, supply, lifecycle, core

class FinancialTests(unittest.TestCase):
    def test_common_and_station_conserve_cent(self):
        originals={"common":300,"stops":[dict(id="A",weight=2,specific=0),dict(id="B",weight=1,specific=60)]}
        r=settlement.allocation(originals)
        self.assertEqual([x["total"] for x in r["rows"]],[200,160])
        self.assertEqual(r["allocated_common"],300)
        tie=settlement.allocation(dict(common=".01",stops=[dict(id=c,weight=1,specific=0) for c in "CBA"]))
        self.assertEqual([x["total"] for x in tie["rows"]],[0,0,.01])

    def test_shared_incentive_and_excess(self):
        b=dict(base=3120,candidate=2820,benefit=21,labour=12,route_award=18,cap_pct=20)
        r=settlement.incentives(b)
        self.assertEqual((r["gross"],r["cap"],r["used"],r["remaining"],r["forecast_only"]),(300,60,51,249,True))
        self.assertFalse(settlement.incentives(dict(b,benefit=42))["within"])

    def test_storage_single_ten_and_first_month(self):
        b=dict(orders=1,pallets=10,inbound=25,unload=10,rent=22,outbound=25,load=10,bol=25,minimum=500,setup=0,first_exempt=False)
        self.assertEqual(settlement.storage(b),dict(subtotal=495,topup=5,setup=0,total=500))
        self.assertEqual(settlement.storage(dict(b,orders=10))["total"],945)
        self.assertEqual(settlement.storage(dict(b,first_exempt=True,setup=250))["total"],745)

    def test_future_rma_cost(self):
        rows=[(180,140,40,90,0,10,2),(80,140,40,90,20,15,3),(65,65,30,155,10,0,4)]
        b=dict(pack=60,parts=150,retest=30,diagnosis=90,deadline=3,plans=[dict(zip(("pickup","redelivery","handling","repair","storage","wait","days"),x)) for x in rows])
        r=settlement.recovery(b)
        self.assertEqual([x["future"] for x in r["plans"]],[700,625,565])
        self.assertEqual([x["with_diagnosis"] for x in r["plans"]],[790,715,655])
        self.assertFalse(r["plans"][2]["within"])

    def test_pilot_complete_denominator(self):
        rows=[dict(id=str(i),sample=False,settled_diff=5) for i in range(32)]
        self.assertEqual(settlement.cohort(rows)["real"],32)
        self.assertFalse(settlement.cohort(rows[:19])["financial_ready"])
        self.assertFalse(settlement.cohort([dict(x,sample=True) for x in rows])["financial_ready"])
        rows[5]["settled_diff"]=None
        r=settlement.cohort(rows);self.assertIsNone(r["net"]);self.assertFalse(r["may_expand"]);self.assertEqual(r["missing"],["5"])

    def test_service_safety_and_candidate_consecutive_streak(self):
        group="DFW M01 L3+L5"
        rows=[dict(id=f"Q{i:02}",sample=False,settled_diff=1,first_dispatch=f"2030-01-{i:02}",
                   order_version=2,units=2,group=group,timing="on_time",first_result="success",
                   supplier_id="carrier",addon_l4=False,addon_l5=True) for i in range(1,22)]
        facts={r["id"]:dict(version=1,order_version=2,valid_release=True,scope_kept=True,pod_complete=True,
                    unsafe=False,abandoned=False,first_enable=True,damaged=0,backup=True,unclear_damage=False,standard_floor=True) for r in rows}
        facts["base:"+group]={k:[1,1] for k in ("on_time","physical","enabled")}
        facts["base:"+group]["damaged"]=[0,2]
        good=settlement.evaluate(rows,facts,True)
        self.assertTrue(good["quality_ready"]);self.assertFalse(good["may_expand"])
        self.assertEqual(good["streaks"]["carrier · "+group],21)
        facts[rows[-3]["id"]]["unclear_damage"]=True
        self.assertEqual(settlement.evaluate(rows,facts,True)["streaks"]["carrier · "+group],2)
        rows[0]["timing"]="outside"
        self.assertFalse(settlement.evaluate(rows,facts,True)["quality_ready"])
        rows[0]["timing"]="on_time";facts[rows[0]["id"]]["unsafe"]=True
        self.assertFalse(settlement.evaluate(rows,facts,True)["quality_ready"])
        facts[rows[0]["id"]]["unsafe"]=False;rows[0]["order_version"]=3
        self.assertFalse(settlement.evaluate(rows,facts,True)["quality_ready"])


# Reuse setup without rediscovering the parent test cases.
class SupplyExtensionTests(unittest.TestCase):
    setUp=test_supply.SupplyTests.setUp
    call=test_supply.SupplyTests.call
    start=test_supply.SupplyTests.start
    event=test_supply.SupplyTests.event

    def test_head_to_door_incomplete_scope(self):
        self.start();b=dict(id=self.ship["id"],version=self.ship["version"],vendor="QA",window_ref="W",unloading="door",
            origin_ref="Demo origin",destination_ref=self.wh,evidence="QA",mode="FCL",currency="USD",
            **dict.fromkeys(supply.HEAD_FEES,0))
        r=self.call("head-quote",dict(b,ocean_fees=400,tax=""))
        self.assertEqual((r["quote"]["known"],r["quote"]["total"]),(400,None))
        for fields in [dict(destination_ref=self.wh2),dict(origin_ref="Other port")]:
            with self.assertRaises(core.ApiError):self.call("head-quote",dict(b,version=2,**fields))
        self.assertEqual(self.call("head-quote",dict(b,version=2,mode="LCL",ocean_fees=375))["quote"]["total"],375)
        sales={"role":"sales","username":"a"}
        self.assertNotIn("head_quotes",supply.handle(self.db,"GET","/api/supply/shipments",{},sales)["shipments"][0])
        with self.assertRaises(core.ApiError):settlement.handle(self.db,"POST","/api/settlement/storage",{},sales)

    def test_unsold_position_requires_separate_signoff(self):
        a=lifecycle.receipt(self.db,dict(sn="D-STOCK",warehouse="Test DFW",model="M01",bin="A",condition="ok",batch="b",evidence="e",state="available"),self.admin)
        pos=self.call("position",dict(action="request",sn=a["sn"],version=1,target_id=self.wh2,storage_right_ref="stock authorization",evidence="d"),self.admin)
        b=dict(action="send",sn=a["sn"],version=1,target_id=self.wh2,evidence="dispatch",custodian="QA",approval_ref="written-D-approval")
        with self.assertRaises(core.ApiError):self.call("transfer",b)
        with self.assertRaises(core.ApiError):self.call("position",dict(action="approve",version=1,id=pos["id"],approval_ref=b["approval_ref"]),self.admin)
        self.call("position",dict(action="approve",version=1,id=pos["id"],approval_ref=b["approval_ref"]),{"role":"admin","username":"second"})
        self.assertEqual(self.call("transfer",b)["asset"]["state"],"transfer")
        self.assertEqual(self.call("transfer",dict(action="accept",sn=a["sn"],version=2,bin="B",state="available",evidence="grn",condition="ok",custodian="next"))["asset"]["warehouse"],"Test NJ")

    def test_short_wrong_code_never_increases_stock(self):
        self.start()
        for k in ("shipping_docs","loaded","arrived","handoff_site","customs","carrier_release","terminal_ready","pickup","warehouse_arrival"):self.event(k)
        for kind,sn in [("short","QA-A"),("unexpected","OTHER")]:
            self.ship=self.call("difference",dict(id=self.ship["id"],version=self.ship["version"],kind=kind,sn=sn,custodian="Q",evidence="D",owner="W"))["shipment"]
        self.assertEqual(len(self.ship["differences"]),2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM assets").fetchone()[0],0)
