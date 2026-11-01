import sqlite3
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"v13"/"engine"))
import core
import lifecycle
import operations
import procurement


class ProcurementTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory=sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        core.core_schema(self.db)
        operations.init_db(self.db)
        self.db.execute("INSERT INTO metadata VALUES('mode','demo')")
        self.admin={"role":"admin","username":"admin"}
        self.buyer={"role":"procurement","username":"buyer"}
        self.wh={"role":"warehouse","username":"warehouse"}
        self.day=(date.today()+timedelta(days=5)).isoformat()
        operations.save_resource(self.db,dict(type="warehouse",name="Dallas",address="Synthetic Dallas dock",timezone="America/Chicago",zip="75201"),self.admin)
        o=core.create_order(self.db,dict(customer="Synthetic",warehouse="Dallas",address="Synthetic delivery dock",zip="75201",timezone="America/Chicago",
             model="M01",level="L3",route="B",quantity=2,endpoint="First floor machine position",window_start=self.day+"T09:00",
             window_end=self.day+"T16:00",pack_version="SIM-PALLET-01"),self.admin)
        self.oid=o["id"]
        o=core.get_order(self.db,self.oid,self.admin)
        o.update(route="",door_width_cm="140",door_height_cm="230",endpoint_ref="SIM-L3",dock="No",liftgate="Yes")
        core.save(self.db,o,self.admin,"confirm_scope","Synthetic scope")
        self.base=procurement.PREFIX+"/"+self.oid

    def state(self):
        return operations.handle(self.db,"GET",self.base,{},self.buyer)

    def send(self,action,**fields):
        with self.db:
            return operations.handle(self.db,"POST",self.base+"/"+action,{**fields,"version":self.state()["version"]},self.buyer)

    def reserve(self):
        for sn in ["SIM-001","SIM-002"]:
            lifecycle.receipt(self.db,dict(sn=sn,warehouse="Dallas",model="M01",bin="A",condition="OK",batch="DEMO",state="available",evidence="SIM-QC"),self.wh)
        core.apply_action(self.db,self.oid,dict(action="ready",version=self.state()["version"],sn="SIM-001,SIM-002",release_ref="SIM-F02"),self.wh)
        self.db.commit()

    def test_full_flow_revision_and_stale_scope(self):
        self.assertEqual(self.state()["quotes"],[])
        self.assertEqual(self.send("open",deadline=self.day)["stage"],"询价草稿")
        self.assertEqual(self.send("sent",recipient="Sim Carrier",evidence="SIM-SENT")["stage"],"已询")
        self.assertEqual(self.send("sample")["stage"],"部分回价")
        self.reserve()
        s=self.state()
        quotes={q["path"]:q for q in s["quotes"]}
        self.assertEqual([quotes[k]["amount"] for k in ("A","B","C1","C2")],[240,510,545,490])
        self.assertFalse(quotes["A"]["eligible"])
        self.assertNotIn("delta",quotes["A"])
        self.assertTrue(quotes["B"]["eligible"])
        self.assertTrue(quotes["C1"]["eligible"])
        self.assertIn("待二程承接",quotes["C2"]["reasons"])
        self.assertEqual(quotes["C2"]["delta"],-20)
        self.assertEqual(s["recommended"],quotes["B"]["id"])
        self.assertEqual(s["stage"],"待定标")
        self.assertEqual(s["commission"],{})
        def choose(q):
            return self.send("approve",quote_id=q["id"],quote_version=q["version"],approval_ref="SIM-OK",reason="Same window, confirmed written terms")
        with self.assertRaises(core.ApiError):choose(quotes["C2"])
        with self.assertRaises(core.ApiError):self.send("commission",commission_ref="SIM-SIGN")
        self.assertEqual(choose(quotes["B"])["stage"],"待书面委托")
        s=self.send("commission",commission_ref="SIM-SIGN")
        self.assertEqual(s["commission"]["commission_ref"],"SIM-SIGN")
        self.assertEqual(s["commission"]["amount"],510)
        self.assertEqual(s["stage"],"已委托")
        o=core.get_order(self.db,self.oid,self.admin)
        core.assert_commission(self.db,dict(o,carrier=quotes["B"]["carrier"],approved_cost=510))
        self.send("reply",**dict(quotes["C2"],quote_version=quotes["C2"]["version"],last_leg_ref="SIM-FINAL-ACCEPT"))
        s=self.state()
        self.assertEqual(s["commission"]["id"],quotes["B"]["id"])
        self.assertEqual(s["recommended"],quotes["C2"]["id"])
        self.assertEqual(len(s["quotes"]),4)
        o=core.get_order(self.db,self.oid,self.admin)
        o["door_width_cm"]=""
        core.save(self.db,o,self.admin,"site_change","Door must be remeasured")
        s=self.state()
        self.assertFalse(s["approved"])
        self.assertFalse(s["scope_current"])
        self.assertFalse(any(q["eligible"] for q in s["quotes"]))
        with self.assertRaises(core.ApiError):core.assert_commission(self.db,dict(o,carrier=quotes["B"]["carrier"],approved_cost=510))

    def test_expired_incomplete_and_permission(self):
        self.reserve()
        self.send("open",deadline=self.day)
        q=next(q for q in self.send("sample")["quotes"] if q["path"]=="B")
        q["origin_cost"]=""
        q["quote_version"]=q["version"]
        s=self.send("reply",**q)
        changed=next(x for x in s["quotes"] if x["id"]==q["id"])
        self.assertIsNone(changed.get("amount"))
        self.assertFalse(changed["eligible"])
        q.update(quote_version=changed["version"],origin_cost=0,valid_until="2001-01-01")
        s=self.send("reply",**q)
        changed=next(x for x in s["quotes"] if x["id"]==q["id"])
        self.assertFalse(changed["eligible"])
        self.assertTrue(any("过期" in r for r in changed["reasons"]))
        with self.assertRaises(core.ApiError):operations.handle(self.db,"GET",self.base,{},self.wh)
        with self.assertRaises(core.ApiError):
            operations.award_quote(self.db,dict(id=changed["id"],quote_version=changed["version"],version=s["version"],approval_ref="direct"),self.admin)

    def test_prebooking_ocean_procurement(self):
        import supply
        wh=self.db.execute("SELECT id FROM registry WHERE type='warehouse'").fetchone()[0]
        dt=self.day+"T10:00:00+00:00"
        candidate=dict(voyage="SIM-VOY",origin="Factory dock",port="Houston",warehouse_id=wh,origin_zone="Asia/Shanghai",port_zone="America/Chicago",
                       transshipment="Direct",source="Training bulletin",confirmation="demo",**dict.fromkeys(supply.SAILING_DATES,dt))
        cid=supply.register_sailings(self.db,{"candidates":[candidate]},self.wh)["ids"][0]
        def action(a,**b):
            with self.db:return operations.handle(self.db,"POST",procurement.PREFIX+"/ocean/"+a,b,self.buyer)
        f=action("open",candidate_id=cid,units=2,currency="USD",unloading="Unloaded at Dallas door",deadline=self.day)
        common={k:f[k] for k in ("origin","warehouse_id","units","currency","unloading","window")}
        base=dict(supplier="Synthetic NVOCC",origin_charge=0,port_charge=80,cfs_charge=0,inland_charge=150,other_charge=0,
                  included="Origin and insurance included",excluded="None",valid_until=self.day,evidence="SIM-TARIFF",**common)
        f=action("quote",id=f["id"],version=f["version"],mode="FCL",basis="container",basis_qty=1,rate=900,**base)
        f=action("quote",id=f["id"],version=f["version"],mode="LCL",basis="W/M",basis_qty=3,rate=100,**base)
        f=action("quote",id=f["id"],version=f["version"],mode="LCL",basis="CBM",basis_qty=3,rate=80,**{**base,"origin":"another dock"})
        q1,q2,bad=f["quotes"]
        self.assertEqual(q1["total"],1130);self.assertEqual(q2["per_unit"],265)
        self.assertFalse(bad["scope_match"])
        decide=dict(id=f["id"],version=f["version"],procurement_ref="SIM-OCEAN-AWARD",reason="Same endpoints, same unloading and window")
        with self.assertRaises(core.ApiError):action("award",quote_id=bad["id"],**decide)
        f=action("award",quote_id=q2["id"],**decide)
        option=supply.handle(self.db,"GET","/api/supply/candidates",{},self.wh)["candidates"][0]
        self.assertEqual(option["booking_awards"][0]["ref"],"SIM-OCEAN-AWARD")
        booking=dict(candidate_id=cid,procurement_ref="SIM-OCEAN-AWARD",ocean_rfq_id=f["id"],evidence="SIM-BL",batch="B1",
                     container="SIM-HBL",asn="SIM-ASN",owner="Warehouse",mode="LCL",inland="road",units=[dict(sn="SEA-01",model="M01"),dict(sn="SEA-02",model="M01")])
        with self.assertRaises(core.ApiError):supply.book(self.db,{**booking,"units":booking["units"][:1]},self.wh)
        s=supply.book(self.db,booking,self.wh)["shipment"]
        self.assertEqual(s["ocean_award"]["quote_id"],q2["id"])
        state=operations.handle(self.db,"GET",procurement.PREFIX+"/ocean",{},self.buyer)
        self.assertEqual(state["requests"][0]["shipment"],s["id"])
        self.assertTrue(supply.book(self.db,booking,self.wh)["replayed"])
        with self.assertRaises(core.ApiError):supply.book(self.db,{**booking,"asn":"SIM-OTHER"},self.wh)

    def comparison_fixture(self):
        self.reserve()
        self.send("open",deadline=self.day)
        return {q["path"]:q for q in self.send("sample")["quotes"]}

    def revise(self,q,**changes):
        result=self.send("reply",**{**q,"quote_version":q["version"],**changes})
        return next(x for x in result["quotes"] if x["id"]==q["id"])

    def test_missing_actual_execution_window(self):
        q=self.comparison_fixture()["B"]
        revised=self.revise(q,execution_start="",execution_end="")
        self.assertFalse(revised["eligible"])
        self.assertIn("待回承运方实际执行起止时间",revised["reasons"])
        self.assertIsNone(self.state()["recommended"])

    def test_actual_execution_window_outside_promise(self):
        q=self.comparison_fixture()["B"]
        revised=self.revise(q,execution_end=self.day+"T18:00")
        self.assertFalse(revised["eligible"])
        self.assertIn("实际执行窗不在本票约定窗口内",revised["reasons"])

    def test_expired_execution_window_even_with_valid_price(self):
        q=self.comparison_fixture()["B"]
        after=datetime.fromisoformat(self.day+"T23:59:00").replace(tzinfo=timezone.utc)
        with patch("procurement.datetime") as clock:
            clock.now.return_value=after
            checked=next(x for x in self.state()["quotes"] if x["id"]==q["id"])
            self.assertFalse(checked["eligible"])
            self.assertIn("承运方实际执行窗已过",checked["reasons"])

    def test_unlike_cost_conditions_or_responsibilities_have_no_price_winner(self):
        quotes=self.comparison_fixture()
        b,c1=quotes["B"],quotes["C1"]
        for name,params in [
            ("surcharge",dict(charge_terms="capped",trigger="Waiting after 30 min",trigger_cap=75)),
            ("missing cost declaration",dict(charge_terms="unknown")),
            ("different confirmed slot",dict(execution_start=self.day+"T10:00")),
            ("different liability",dict(liability_terms="Custody exception during unloading")),
            ("different inclusions",dict(inclusions="Unloading excluded")),
        ]:
            with self.subTest(name=name):
                changed=self.revise(b,**params)
                s=self.state()
                self.assertTrue(changed["eligible"])
                self.assertIsNone(s["recommended"])
                self.assertNotIn("delta",changed)
                decision=self.send("approve",quote_id=changed["id"],quote_version=changed["version"],
                    backup_id=c1["id"],reason="Human review of differing terms",approval_ref="SIM-HUMAN")
                self.assertIsNone(decision["approval"]["backup_delta"])
                restored={k:b.get(k) for k in params}
                b=self.revise(changed,**restored)
                self.assertEqual(self.state()["recommended"],b["id"])

    def test_single_source_retains_manual_approval_without_price_claim(self):
        quotes=self.comparison_fixture()
        self.revise(quotes["C1"],valid_until="2000-01-01")
        s=self.state()
        self.assertIsNone(s["recommended"])
        self.assertIn("单一来源",s["comparison_note"])
        chosen=quotes["B"]
        result=self.send("approve",quote_id=chosen["id"],quote_version=chosen["version"],
            reason="Only insured truck on the confirmed date",approval_ref="SIM-SOLE")
        self.assertEqual(result["stage"],"待书面委托")

    def test_existing_signed_quote_keeps_evidence_and_does_not_win_price_ranking(self):
        quotes=self.comparison_fixture()
        q=quotes["B"]
        self.send("approve",quote_id=q["id"],quote_version=q["version"],reason="Signed same window",approval_ref="SIM-OK")
        self.send("commission",commission_ref="SIM-LEGACY-SIGN")
        # Reproduce a persisted pre-upgrade quote without adding facts to its written record.
        self.db.execute("""UPDATE registry SET data=json_remove(data,'$.window_schema','$.execution_start','$.execution_end',
            '$.liability_terms','$.charge_terms') WHERE id=?""",(q["id"],))
        s=self.state()
        self.assertEqual(s["commission"]["commission_ref"],"SIM-LEGACY-SIGN")
        self.assertEqual(s["stage"],"已委托")
        self.assertIsNone(s["recommended"])
        self.assertIn("执行开始",s["comparison_note"])
        o=core.get_order(self.db,self.oid,self.admin)
        core.assert_commission(self.db,dict(o,carrier=q["carrier"],approved_cost=q["amount"]))


if __name__=="__main__":unittest.main()
