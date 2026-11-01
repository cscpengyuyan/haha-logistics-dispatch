import unittest

from test_release_gates import ADMIN, fresh, core, folder, operations
import gate
import lifecycle
import review
import supply

WH=dict(role="warehouse",username="warehouse")
DISPATCH=dict(role="dispatch",username="dispatch")
TECH=dict(role="service",username="service")
FIN=dict(role="finance",username="finance")
POD="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+dPR0AAAAASUVORK5CYII="


class TwoMachines(unittest.TestCase):
    def setUp(self):
        self.db=fresh()
        self.addCleanup(self.db.close)
        o=next(x for x in core.list_orders(self.db,ADMIN) if x["quantity"]==2 and x["status"]=="ready")
        self.oid=o["id"];self.sns=o["sn"].split(", ")
        self.act("unrelease",WH,reason="reset for platform scope")
        core.edit_order(self.db,self.oid,dict(version=self.o()["version"],addon_l5=True,procurement_mode="platform"),ADMIN)
        self.act("ready",WH,sn=o["sn"],release_ref="SIM-SN")
        day=o["window_end"][:10]
        s=operations.save_resource(self.db,dict(type="supplier",name="SIM T5",address="SIM DOCK",qualification="S3",ability="T5",evidence="TECH"),ADMIN)["resource"]
        self.whid=next(v["id"] for v in operations.list_records(self.db,False,ADMIN) if v["type"]=="warehouse" and v["name"]=="Dallas")
        supply.qualify(self.db,dict(supplier_id=s["id"],executor_id=s["id"],product="T5",warehouse_id=self.whid,zip=o["zip"],model="M01",
            action="L5",decision="Y",valid_until=day,insurance_until=day,evidence="SIM-CAP"),ADMIN)
        folder.technical(self.db,self.o(),dict(supplier_id=s["id"],executor_id=s["id"],acceptance_ref="SIM-T5",scope="activate",amount=120),ADMIN)
        folder.platform_instruction(self.db,self.o(),dict(account_ref="SIM",instruction_ref="REF",executor_id="SIM account",carrier="Network",
            acceptance_ref="ACK",valid_until=day,bol_ref="BOL",pickup_ref="PICK",identity_ref="ID"),ADMIN)
        o=self.act("dispatch",DISPATCH,carrier="Network",dispatch_ref="SIM",approved_cost=580,checks={k:"SIM "+k for k in core.CHECKS})
        gate.verify(self.db,self.o(),dict(release_version=o["issue_version"],pickup_code="PICK",bol_ref="BOL",identity_ref="ID",sns=self.sns,evidence="HANDOFF"),WH)
        self.file=core.add_file(self.db,self.oid,dict(version=self.o()["version"],category="pod",name="test.png",base64=POD),DISPATCH)["file"]["id"]
        self.day=day

    def o(self):return core.get_order(self.db,self.oid,ADMIN)
    def act(self,action,user,**body):
        with self.db:return core.apply_action(self.db,self.oid,dict(body,action=action,version=self.o()["version"]),user)
    def attempt(self,units,start,end,**extra):
        o=self.o()
        with self.db:return folder.add_attempt(self.db,o,dict(units=units,release_version=o["issue_version"],location=o["endpoint"],evidence="ATT",
            arrival_local=self.day+"T"+start,finished_local=self.day+"T"+end,**extra),DISPATCH)
    def unit(self,sn,result="success"):
        return dict(sn=sn,outcome=result,location=self.o()["endpoint"] if result=="success" else "entrance",details="SIM movement",pod_id=self.file)
    def deliver(self):
        return self.act("deliver",DISPATCH,release_version=self.o()["issue_version"],signer="SIM Receiver",delivered_at=self.day+"T13:00",delivery_note="SIM")
    def test_partial_retry_and_independent_technical_completion(self):
        a,b=self.sns
        self.attempt([self.unit(a),self.unit(b,"partial")],"10:00","10:35",custodian="SIM crew",next_step="retry SN B")
        self.assertEqual(self.o()["completed_sns"],[a]);self.assertEqual(self.o()["physical_progress"],"partial")
        with self.assertRaises(core.ApiError):self.deliver()
        with self.assertRaises(core.ApiError):self.attempt([self.unit(a),self.unit(b)],"11:00","11:35")
        self.attempt([self.unit(b)],"11:00","11:35");self.deliver()
        receipt=folder.record_receipt(self.db,self.o(),dict(signed_qty=2,received_qty=1,shipment_ref="AMZ-TEST",evidence="REPORT",
            owner="SIM ORDER DESK",state="open",next_step="verify",due=self.day+"T18:00"),ADMIN)
        self.assertEqual(folder.get_folder(self.db,receipt,ADMIN)["receipt"]["state"],"open")
        tech=lambda sn,state:dict(sn=sn,state=state,result="test",customer_ref="SIM")
        self.act("service_complete",TECH,result_ref="PARTIAL",service_units=[tech(a,"passed"),tech(b,"parts_pending")])
        self.assertEqual(self.o()["status"],"delivered");self.assertEqual(self.o()["technical_order"]["state"],"open")
        self.assertNotIn("result_ref",self.o())
        self.act("service_complete",TECH,result_ref="FINAL",service_units=[tech(b,"passed")])
        self.act("settle",FIN,actual_cost=595,change_cost=15,change_ref="WAIT",invoice_ref="US",usa_lines=dict(origin=30,delivery_wait=445,technical=120))
        self.assertEqual(self.o()["approved_variance"],15);self.assertEqual(self.o()["cost_expression"],"K＋T＋595 待结")
        self.assertIsNone(next(r for r in review.query(self.db,{},FIN)["rows"] if r["id"]==self.oid)["settled_diff"])

    def test_remote_restore_and_isolated_machine_repair(self):
        a,b=self.sns
        self.attempt([self.unit(a),self.unit(b)],"10:00","10:35");self.deliver()
        def new(sn,kind,**fields):
            return lifecycle.make_case(self.db,dict(order_id=self.oid,sn=sn,kind=kind,issue="SIM",custodian="Receiver",
                  owner="service",due=self.day+"T18:00",evidence="SIM-E1",next_step="triage",**fields),TECH)
        def advance(c,target,user=TECH,**kw):
            return lifecycle.advance_case(self.db,dict(id=c["id"],version=c["version"],to=target,**kw),user)
        restore=advance(new(a,"restore"),"authorized",strategy="remote",approval_ref="SIM-A",next_step="remote update")
        remote=advance(restore,"closed",test_result="OK",customer_ref="verified",recovered_at=self.day+"T14:00")
        self.assertEqual(remote["state"],"closed")
        with self.assertRaises(core.ApiError):new(a,"rma",item_type="machine",purpose="repair",reason_ref=remote["id"])
        c=advance(new(b,"restore"),"authorized",strategy="machine",approval_ref="SIM-B",next_step="repair")
        repair=new(b,"rma",item_type="machine",purpose="repair",reason_ref=c["id"])
        repair=advance(repair,"authorized",approval_ref="MOVE",return_to="Dallas",part_ref=b,receiver_id=self.whid,
                       receiver_acceptance="SIM-RECEIVER",protection_ref="FRAME",redelivery_ref="BACK-TO-SITE")
        repair=advance(repair,"shipped",tracking="SIM-RMA",custodian="RETURN TEAM")
        repair=advance(repair,"received",WH,receipt_ref="R-GRN",inspection="QUARANTINE")
        release=dict(id=repair["id"],version=repair["version"],test_result="load test passed",release_ref="SIM-REPAIR",return_plan="customer retest",protection_ref="upright")
        with self.assertRaises(core.ApiError):lifecycle.repair_release(self.db,release,TECH)
        self.assertEqual(self.db.execute("SELECT state FROM assets WHERE sn=?",(b,)).fetchone()[0],"returned_hold")
        lifecycle.authorize_bench(self.db,dict(warehouse_id=self.whid,model="M01",valid_until=self.day,technician="service",evidence="BENCH"),ADMIN)
        repair=lifecycle.repair_release(self.db,release,TECH)
        self.assertEqual(self.db.execute("SELECT state FROM assets WHERE sn=?",(b,)).fetchone()[0],"redelivery_ready")
        self.assertEqual(self.db.execute("SELECT state FROM after_cases WHERE id=?",(c["id"],)).fetchone()[0],"authorized")
        with self.assertRaisesRegex(core.ApiError,"复送"):
            advance(c,"closed",test_result="not yet onsite",customer_ref="early",recovered_at=self.day+"T15:00")
        task=lifecycle.redelivery(self.db,dict(id=repair["id"],version=repair["version"],approval_ref="R-BUDGET",procurement_mode="platform",
            delivery_actions="return to original endpoint",window_start=self.day+"T14:00",window_end=self.day+"T18:00"),DISPATCH)
        self.assertEqual(task["order"]["sn"],b)
        self.assertEqual(task["order"]["source_order_id"],self.oid)
        self.assertNotIn("unrelease",core.actions(task["order"],"warehouse"))
        with self.assertRaisesRegex(core.ApiError,"复送"):
            advance(task["record"],"closed",FIN,credit_amount=0,credit_ref="SIM NO CREDIT",disposition="staged")
