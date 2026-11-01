"""Regression cases 3, 4 and 8 including version conflicts, bypass and replay."""
import sqlite3
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"v13"/"engine"))
import core, operations, lifecycle, supply


class SupplyTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory=sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        core.core_schema(self.db)
        operations.init_db(self.db)
        self.admin={"role":"admin","username":"qa"}
        self.warehouse={"role":"warehouse","username":"wh"}
        def resource(**body):
            return operations.save_resource(self.db,body,self.admin)["resource"]["id"]
        self.wh=resource(type="warehouse",name="Test DFW",address="Demo loading bay",timezone="America/Chicago")
        self.wh2=resource(type="warehouse",name="Test NJ",address="Demo NJ",timezone="America/New_York")
        self.supplier=resource(type="supplier",name="Demo principal",ability="T2",address="Demo bay",qualification="S3")
        self.book=dict(voyage="QA vessel",batch="B-1",container="C-1",asn="ASN-1",origin="Demo origin",port="Demo Houston",
                       warehouse_id=self.wh,warehouse_zone="America/Chicago",mode="FCL",inland="road",owner="wh",
                       procurement_ref="REF-B",evidence="REF-B",seal="SIM-SEAL",bill_of_lading="SIM-BL",pickup_site="SIM terminal",inland_owner="SIM crew",
                       planned_etd="2030-01-01T08:00:00+08:00",planned_eta="2030-01-12T08:00:00-06:00",
                       planned_warehouse="2030-01-13T08:00:00-06:00",units=[dict(sn=sn,model="M01") for sn in ["QA-A","QA-B"]])
        self.db.commit()

    def call(self,action,data,user=None):
        with self.db:
            return operations.handle(self.db,"POST","/api/supply/"+action,data,user or self.warehouse)

    def start(self):
        self.ship=self.call("book",self.book)["shipment"]

    def event(self,kind,at="2030-01-12T18:00:00Z"):
        b=dict(id=self.ship["id"],version=self.ship["version"],at=at,kind=kind,custodian="QA",evidence="REF-"+kind)
        self.ship=self.call("milestone",b)["shipment"]

    def order(self):
        return core.create_order(self.db,dict(customer="Demo",address="Demo",city="Demo",zip="06103",warehouse="Test DFW",
                model="M01",quantity=1,route="B",level="L3",endpoint="Demo room"),self.admin)

    def test_delay_only_unlocked_supply_dependent_orders(self):
        first,second=self.order(),self.order()
        self.book["units"][0]["order_id"]=first["id"]
        self.book["units"][1]["order_id"]=second["id"]
        with self.db:
            lifecycle.receipt(self.db,dict(sn="EXISTING",warehouse="Test DFW",model="M01",bin="A",condition="ok",batch="old",evidence="REF0",state="available"),self.warehouse)
            core.apply_action(self.db,second["id"],dict(action="ready",version=1,sn="EXISTING",release_ref="REF0"),self.warehouse)
        self.start()
        self.event("eta","2030-01-14T08:00:00-06:00")
        self.assertEqual(self.ship["events"][-1]["order_ids"],[first["id"]])
        self.assertEqual(self.ship["warehouse_eta"],"2030-01-15T14:00:00+00:00")
        self.assertEqual(self.db.execute("SELECT count(*) FROM events WHERE action='supply_review'").fetchone()[0],1)
        self.assertEqual(set(r[0] for r in self.db.execute("SELECT sn FROM assets")),{"EXISTING"})

    def test_stock_count_isolates_one_unit_and_requires_independent_approval(self):
        item=dict(sn="COUNT-M01",model="M01",batch="SIM-GRN",warehouse="Test DFW",state="available",bin="A",condition="ok",evidence="SIM-GRN")
        lifecycle.receipt(self.db,item,self.warehouse)
        report=dict(action="report",version=1,sn=item["sn"],evidence="SIM-COUNT",reason="托位与台账不符")
        self.assertEqual(self.call("stock-count",report,self.warehouse)["asset"]["state"],"hold")
        self.assertTrue(self.call("stock-count",report,self.warehouse)["replayed"])
        with self.assertRaisesRegex(core.ApiError,"盘点差异"):
            lifecycle.inspect_asset(self.db,dict(item,version=2),self.warehouse)
        fix=dict(action="resolve",version=2,sn=item["sn"],state="available",approval_ref="SIM-APP",
                 bin="B",condition="复点、检验合格",evidence="SIM-FIX")
        with self.assertRaises(core.ApiError):self.call("stock-count",fix,self.warehouse)
        with self.assertRaisesRegex(core.ApiError,"另一名"):
            self.call("stock-count",fix,dict(self.admin,username=self.warehouse["username"]))
        self.assertEqual(self.call("stock-count",fix,self.admin)["asset"]["bin"],"B")
        self.assertTrue(self.call("stock-count",fix,self.admin)["replayed"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM life_log WHERE item=?", (item["sn"],)).fetchone()[0],3)

    def test_booking_requires_purchase_authority(self):
        self.book.pop("procurement_ref")
        with self.assertRaisesRegex(core.ApiError,"头程采购确认"):
            self.start()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM shipments").fetchone()[0],0)

    def test_release_receipt_and_replay(self):
        self.start()
        self.assertTrue(self.call("book",self.book)["replayed"])
        self.event("shipping_docs");self.event("loaded");self.event("arrived");self.event("handoff_site")
        receipt=dict(id=self.ship["id"],sn="QA-A",state="available",bin="A1",condition="ok",evidence="DEMO-GRN-1",custodian="QA")
        with self.assertRaises(core.ApiError):
            self.call("receive",dict(receipt,version=self.ship["version"]))
        with self.assertRaises(core.ApiError):
            lifecycle.receipt(self.db,dict(receipt,warehouse="Test DFW",model="M01",batch="x"),self.warehouse)
        for kind in ["customs","carrier_release","terminal_ready"]:
            with self.assertRaises(core.ApiError):self.event("pickup")
            self.event(kind)
        self.event("pickup");self.event("warehouse_arrival")
        self.assertEqual(self.db.execute("SELECT count(*) FROM assets").fetchone()[0],0)
        body=dict(receipt,version=self.ship["version"])
        self.ship=self.call("receive",body)["shipment"]
        self.assertTrue(self.call("receive",body)["replayed"])
        self.call("receive",dict(body,version=self.ship["version"],sn="QA-B",state="hold",condition="damage"))
        self.assertEqual([(r[0],r[1]) for r in self.db.execute("SELECT sn,state FROM assets ORDER BY sn")],[("QA-A","available"),("QA-B","hold")])
        self.assertTrue(self.call("book",self.book)["replayed"])
        with self.assertRaises(core.ApiError):self.event("empty_return")
        with self.assertRaises(core.ApiError):
            self.call("transfer",dict(sn="QA-B",version=1,action="send",target_id=self.wh2,evidence="r",custodian="QA",approval_ref="r"))

    def test_replenishment_and_age_across_transfer(self):
        o=lifecycle.receipt(self.db,dict(sn="TEST-X",warehouse="Test DFW",model="M01",bin="B1",
             condition="ok",evidence="ga",batch="local",state="available"),self.warehouse)
        b=dict(sn=o["sn"],version=1,action="send",target_id=self.wh2,custodian="out",approval_ref="D-01",evidence="D-E")
        self.assertEqual(self.call("transfer",b)["asset"]["state"],"transfer")
        result=self.call("transfer",dict(sn=o["sn"],version=2,action="accept",state="hold",custodian="in",condition="damage",bin="hold",evidence="D-R"))["asset"]
        self.assertEqual((result["warehouse"],result["state"],result["received_at"]),("Test NJ","hold",o["received_at"]))
        calc=supply.replenish(10,3,4,10,2)
        self.assertEqual((calc["position"],calc["suggested"]),(9,3))

    def test_qualification_scope_and_expiry(self):
        b=dict(supplier_id=self.supplier,executor_id="DEMO-EXEC",product="T2",warehouse_id=self.wh,zip="06103",model="M01",
               action="L3",decision="Y",evidence="QA workbook",valid_until="2099-12-31",insurance_until="2099-12-31")
        o=self.order();q=dict(supplier_id=self.supplier,executor_id="DEMO-EXEC",product="T2",amount=580)
        prior=self.call("qualify",b,self.admin)["card"];self.assertEqual(prior["zip"],"06103")
        self.assertEqual(len(supply.assert_eligible(self.db,q,o)),1)
        for changed in [dict(warehouse="Test NJ"),dict(zip="75000"),dict(model="M06"),dict(addon_l4=True)]:
            with self.assertRaises(core.ApiError):supply.assert_eligible(self.db,q,dict(o,**changed))
        with self.assertRaises(core.ApiError):supply.assert_eligible(self.db,dict(q,executor_id="ANOTHER"),o)
        for decision in ["N","U","C","Y"]:
            prior=self.call("qualify",dict(b,version=prior["version"],decision=decision,condition="two workers",
                                        insurance_until="2020-01-01" if decision=="Y" else b["insurance_until"]),self.admin)["card"]
            with self.assertRaises(core.ApiError):supply.assert_eligible(self.db,q,o)
            if decision=="C":self.assertTrue(supply.assert_eligible(self.db,dict(q,condition_ref="QA-current"),o))

    def test_contract_tariff_no_zone_inference(self):
        b=dict(supplier_id=self.supplier,warehouse_id=self.wh2,zip="06103",model="M01",product="T2")
        self.call("tariff",dict(b,action="save",zone="H",rate_version="SIM-corrected",evidence="sim",amount=111),self.admin)
        r=self.call("tariff",dict(b,action="check"),self.admin)
        self.assertEqual((r["zone"],r["status"],r["amount"]),("H","rfq",None))
        self.call("tariff",dict(b,action="save",version=1,zone="H",rate_version="SIM-corrected-v2",evidence="sim",amount=111,valid_until="2099-01-01"),self.admin)
        self.assertEqual(self.call("tariff",dict(b,action="check"),self.admin)["amount"],111)
        self.assertEqual(self.call("tariff",dict(b,action="check",zip=""),self.admin)["status"],"rfq")
        o=self.order()
        inquiry=self.call("tariff",dict(b,action="inquire",warehouse_id=self.wh,zip="",order_id=o["id"],scope_ref="test-scope-v1",owner="P",evidence="SIM-request"),self.admin)["inquiry"]
        self.assertEqual(inquiry["order_id"],o["id"])
        with self.assertRaises(core.ApiError):
            self.call("tariff",dict(b,action="save",version=2,zone="none",rate_version="mock",evidence="sim"),self.admin)
        self.call("tariff",dict(b,action="save",version=2,zone="H",rate_version="SIM-expired",evidence="sim",amount=111,valid_until="2020-01-01"),self.admin)
        self.assertIsNone(self.call("tariff",dict(b,action="check"),self.admin)["amount"])
        for mismatch in [dict(warehouse_id=self.wh),dict(zip="06104"),dict(product="T1")]:
            self.assertIsNone(self.call("tariff",dict(b,action="check",**mismatch),self.admin)["amount"])
        with self.assertRaises(core.ApiError):self.call("tariff",dict(b,action="check",zip="6103"),self.admin)

    def test_original_schedule_and_offset_survive_updates(self):
        self.start()
        base=dict(kind="loaded",at="2030-01-01T08:00:00+08:00",evidence="plan-v1",owner="qa",id=self.ship["id"],version=1)
        self.ship=self.call("schedule",base)["shipment"]
        self.ship=self.call("schedule",dict(base,evidence="plan-v2",at="2030-01-02T08:00:00+08:00",version=2))["shipment"]
        self.event("shipping_docs","2030-01-02T08:00:00+08:00");self.event("loaded","2030-01-02T09:00:00+08:00")
        versions=self.ship["schedules"]["loaded"]
        self.assertEqual(versions[0]["at"],"2030-01-01T00:00:00+00:00")
        self.assertEqual(versions[1]["source_time"],"2030-01-02T08:00:00+08:00")
        self.assertEqual(self.ship["events"][-1]["source_time"],"2030-01-02T09:00:00+08:00")
        with self.assertRaises(core.ApiError):self.call("schedule",dict(base,version=self.ship["version"]))

    def test_role_boundary(self):
        with self.assertRaises(core.ApiError):
            self.call("book",self.book,{"role":"driver","username":"driver"})
        with self.assertRaises(core.ApiError):
            operations.handle(self.db,"GET","/api/supply/cards",{},self.warehouse)

    def test_pending_qc_and_sn_photo_permissions(self):
        self.start()
        for k in ("shipping_docs","loaded","arrived","handoff_site","customs","carrier_release","terminal_ready","pickup","warehouse_arrival"):
            self.event(k)
        photo="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6l8AAAAASUVORK5CYII="
        body=dict(id=self.ship["id"],version=self.ship["version"],sn="QA-A",bin="QA1",state="pending_qc",condition="pending",evidence="SIM-GRN",custodian="QA",photo=photo)
        self.call("receive",body)
        self.assertTrue(self.call("receive",body)["replayed"])
        with self.assertRaises(core.ApiError):self.call("receipt-photo",body,{"role":"driver","username":"driver"})
        stored=self.call("receipt-photo",body)
        self.assertEqual((stored["mime"],stored["base64"]),("image/png",photo))
        order=self.order()
        with self.assertRaises(core.ApiError):lifecycle.reserve(self.db,order,["QA-A"],self.warehouse)
        qc=lifecycle.inspect_asset(self.db,dict(sn="QA-A",version=1,state="available",bin="A01",condition="approved",evidence="SIM-QC"),self.warehouse)
        self.assertEqual(qc["state"],"available")

    def test_resume_legacy_loaded_batch_without_recreating_departure(self):
        # Snapshot of an already loaded manifest from before documentation fields existed.
        from json import loads
        self.start()
        sid=self.ship["id"]
        legacy=loads(self.db.execute("SELECT data FROM shipments WHERE id=?",(sid,)).fetchone()[0])
        for k in ("seal","bill_of_lading","pickup_site","inland_owner"):
            legacy.pop(k,None)
        loaded=dict(kind="loaded",at=supply.instant("2030-01-01T08:00:00+08:00"),custodian="old",evidence="old BOL")
        legacy["events"]=[loaded]
        with self.db:
            self.db.execute("UPDATE shipments SET data=?,version=2 WHERE id=?",(core.encode(legacy),sid))
        supply.init_db(self.db)
        self.ship=supply.shipment(self.db,sid)
        self.event("arrived")
        self.ship=self.call("milestone",dict(id=sid,version=self.ship["version"],kind="handoff_site",at="2030-01-12T18:00:00Z",
                        custodian="current",evidence="current paper",bill_of_lading="BL",pickup_site="terminal",inland_owner="SIM"))["shipment"]
        for k in ("customs","carrier_release","terminal_ready","pickup","warehouse_arrival"):
            self.event(k)
        self.assertEqual(self.ship["events"][0],loaded)
        self.assertNotIn("shipping_docs",{e["kind"] for e in self.ship["events"]})
        self.assertTrue(all(not u["receipt"] for u in self.ship["units"]))

    def test_candidate_booking_delay_preview_28_receipts_and_review(self):
        candidate={k:self.book[k] for k in ("voyage","origin","port","warehouse_id","planned_etd","planned_eta","planned_warehouse")}
        candidate.update(origin_zone="Asia/Shanghai",port_zone="America/Chicago",confirmation="demo",source="SIM carrier bulletin",
                         transshipment="direct",doc_cutoff="2029-12-28T08:00:00+08:00",gate_cutoff="2029-12-29T08:00:00+08:00",
                         pickup_eta="2030-01-12T12:00:00-06:00")
        with self.assertRaises(core.ApiError):
            self.call("candidates",dict(candidates=[candidate,dict(candidate,gate_cutoff="2030-03-01T08:00:00Z")]))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sailing_options").fetchone()[0],0)
        def register(c):return self.call("candidates",dict(candidates=[c]))["ids"][0]
        rid=register(candidate)
        self.assertEqual(register(candidate),rid)
        oid=self.order()["id"]
        pack=dict(length_cm=100,width_cm=83,height_cm=191,weight_kg=226,upright=True,nonstackable=True)
        self.book.update(candidate_id=rid,planned_warehouse="not caller controlled",units=[
            dict(sn=f"DFW-{i:02d}",model="M01",order_id=oid if i==1 else None,packing=pack) for i in range(1,29)])
        self.start()
        self.assertEqual(self.ship["units"][0]["packing"],pack)
        self.assertNotEqual(register(dict(candidate,source="version 2")),rid)
        self.assertEqual(self.ship["candidate"]["source"],candidate["source"])
        late="2030-01-14T08:00:00-06:00"
        impact=self.call("preview-eta",dict(id=self.ship["id"],at=late,version=1))
        self.assertEqual((impact["pending"],impact["orders"][0]["id"]),(28,oid))
        self.assertEqual(supply.shipment(self.db,self.ship["id"])["version"],1)
        self.event("eta",late)
        self.assertEqual(self.ship["planned_eta"],supply.instant(candidate["planned_eta"]))
        self.assertEqual(self.ship["warehouse_eta"],impact["warehouse_eta"])
        self.assertEqual({t["role"] for t in self.ship["reviews"]},{"warehouse","dispatch"})
        review=next(t for t in self.ship["reviews"] if t["role"]=="dispatch")
        receipt=dict(task_id=review["id"],id=self.ship["id"],version=self.ship["version"],evidence="customer confirmed original slot")
        with self.assertRaises(core.ApiError):self.call("close-review",receipt)
        self.ship=self.call("close-review",receipt,dict(role="dispatch",username="D"))["shipment"]
        with self.assertRaises(core.ApiError):self.event("loaded")
        for kind in ["shipping_docs","loaded","arrived","handoff_site","customs","carrier_release","terminal_ready","pickup","warehouse_arrival"]:
            self.event(kind,"2030-01-15T12:00:00Z")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM assets").fetchone()[0],0)
        for i in range(1,29):
            state="available" if i<28 else "hold"
            body=dict(version=self.ship["version"],id=self.ship["id"],sn=f"DFW-{i:02d}",state=state,custodian="qa",condition=state,bin="DFW",evidence=f"GRN-{i}")
            self.ship=self.call("receive",body)["shipment"]
        self.assertTrue(self.call("receive",body)["replayed"])
        self.assertEqual(dict(self.db.execute("SELECT state,count(*) FROM assets GROUP BY state")),{"available":27,"hold":1})

if __name__=="__main__":
    unittest.main()
