"""Exercise the public domain actions for original-channel delivery and transfer-to-sale."""
import unittest
from test_release_gates import fresh, ADMIN, core, folder, operations
import gate
import lifecycle
import practice
import routing
import supply


class HandoffBranches(unittest.TestCase):
    def setUp(self):
        self.db=fresh()
        self.addCleanup(self.db.close)
        self.day="2030-03-05"
        self.sn="BRANCH-SIM-1"
        self.wh=self.warehouse("Dallas")
        self.station=self.warehouse("New Jersey")
        self.principal=operations.save_resource(self.db,dict(type="supplier",name="SIM Line",ability="T2",address="SIM bay",qualification="S3"),ADMIN)["resource"]
        lifecycle.receipt(self.db,dict(sn=self.sn,warehouse="Dallas",model="M01",bin="A",condition="QC pass",batch="SIM",state="available",evidence="GRN"),ADMIN)

    def warehouse(self,name):
        return self.db.execute("SELECT id FROM registry WHERE type='warehouse' AND json_extract(data,'$.name')=?",(name,)).fetchone()[0]

    def create(self,route,**fields):
        self.o=core.create_order(self.db,dict(customer="SIM Customer",address="SIM Dock",city="Dallas",state="TX",zip="75201",lat=32.77,lng=-96.8,
            route=route,model="M01",quantity=1,warehouse="Dallas",level="L1",endpoint="Door 5",window_start=self.day+"T09:00",window_end=self.day+"T17:00",
            procurement_mode="platform",**fields),ADMIN)
        return self.o

    def act(self,action,**fields):
        with self.db:
            self.o=core.apply_action(self.db,self.o["id"],dict(version=self.o["version"],action=action,**fields),ADMIN)
        return self.o

    def delegate(self):
        self.act("ready",sn=self.sn,release_ref="SIM-lock")
        self.o=folder.platform_instruction(self.db,self.o,dict(account_ref="SIM-acct",instruction_ref="SIM-commission",
            executor_id=self.principal["id"],carrier=self.principal["name"],acceptance_ref="SIM-accepted",valid_until="2036-11-01",
            bol_ref="SIM-BOL",pickup_ref="SIM-PICK",identity_ref="SIM-ID"),ADMIN)
        self.db.commit()

    def dispatch(self,**fields):
        return self.act("dispatch",carrier=self.principal["name"],approved_cost=100,dispatch_ref="SIM-issue",
            checks={k:"SIM-"+k for k in core.CHECKS},**fields)

    def scan_network(self):
        self.o=gate.verify(self.db,self.o,dict(release_version=self.o["issue_version"],pickup_code="SIM-PICK",bol_ref="SIM-BOL",
            identity_ref="SIM-ID",sns=[self.sn],evidence="SIM-handover"),ADMIN)
        self.db.commit()

    def sign(self):
        version=self.o["issue_version"]
        upload=core.add_file(self.db,self.o["id"],dict(version=self.o["version"],category="pod",name="sim.pdf",base64=practice.synthetic_pod()),ADMIN)
        self.o=folder.add_attempt(self.db,upload["order"],dict(release_version=version,arrival_local=self.day+"T13:00",finished_local=self.day+"T13:10",
            location="Door 5",evidence="SIM-site",units=[dict(sn=self.sn,outcome="success",details="handover",location="Door 5",pod_id=upload["file"]["id"])]),ADMIN)
        self.db.commit()
        data=dict(signer="SIM receiver",delivery_note="unloaded",delivered_at=self.day+"T13:10",release_version=version)
        if self.o["route"] in {"C1","A"}:
            with self.assertRaisesRegex(core.ApiError,"endpoint_receipt_ref"):
                self.act("deliver",**data)
        self.act("deliver",endpoint_receipt_ref="SIM-F05-final",**data)
        self.assertEqual(self.o["status"],"delivered")

    def test_amazon_handoff_and_platform_receipt(self):
        self.create("A",a_channel="amazon")
        self.delegate()
        refs=dict(receiver_site="DFW5",appointment_ref="SIM-APT",shipment_ref="SIM-FBA",label_ref="SIM-FNSKU")
        with self.assertRaisesRegex(core.ApiError,"receiving_terms"):
            self.dispatch(**refs)
        self.dispatch(receiving_terms="SIM dock terms",**refs)
        self.scan_network()
        self.sign()
        confirm=dict(signed_qty=1,received_qty=1,state="closed",resolution="SIM accepted",evidence="SIM-POD",owner="sim")
        with self.assertRaisesRegex(core.ApiError,"货件号"):
            folder.record_receipt(self.db,self.o,dict(confirm,shipment_ref="wrong"),ADMIN)
        folder.record_receipt(self.db,self.o,dict(confirm,shipment_ref="SIM-FBA"),ADMIN)

    def test_dealer_endpoint(self):
        self.create("A",a_channel="terminal")
        self.delegate()
        with self.assertRaisesRegex(core.ApiError,"handoff_terms"):
            self.dispatch(receiver_site="SIM building",receiver_contact="SIM dealer")
        self.dispatch(receiver_site="SIM building",receiver_contact="SIM dealer",handoff_terms="unload at Door 5")
        self.scan_network()
        self.sign()
        self.assertEqual(self.o["endpoint_receipt"]["endpoint"],"Door 5")

    def test_authorized_pickup_ends_at_origin(self):
        self.create("A",pickup=True)
        self.act("ready",sn=self.sn,release_ref="SIM-lock")
        self.act("pickup_gate",collector="SIM collector",authority_ref="SIM-PU",vehicle_ref="SIM plate",secure_ref="SIM straps",
                 package_height_cm=195,door_cm=220,gross_kg=205,payload_kg=700)
        upload=core.add_file(self.db,self.o["id"],dict(version=self.o["version"],category="pod",name="sim.pdf",base64=practice.synthetic_pod()),ADMIN)
        self.o=folder.add_attempt(self.db,upload["order"],dict(arrival_local=self.day+"T12:00",finished_local=self.day+"T12:10",location="Door 5",evidence="SIM-GRN",
            units=[dict(sn=self.sn,outcome="success",location="Door 5",details="Loaded by collector",pod_id=upload["file"]["id"])]),ADMIN)
        self.db.commit()
        handover=dict(dispatch_ref="SIM-PU",approved_cost=0,delivered_at=self.day+"T12:10",delivery_note="SIM origin receipt")
        with self.assertRaisesRegex(core.ApiError,"提货人"):
            self.act("pickup",signer="other person",**handover)
        self.act("pickup",signer="SIM collector",**handover)
        self.assertEqual(self.o["status"],"delivered")
        self.assertNotIn("release_route",self.o)

    def qualify(self,warehouse,action,product,zip_code):
        supplier=self.principal["id"]
        supply.qualify(self.db,dict(supplier_id=supplier,executor_id=supplier,warehouse_id=warehouse,zip=zip_code,product=product,model="M01",
            action=action,decision="Y",valid_until="2036-11-01",insurance_until="2036-11-01",evidence="SIM cap"),ADMIN)

    def station_flow(self,route):
        self.create(route)
        self.delegate()
        principal=self.principal["id"]
        self.qualify(self.wh,"L1","T2","75201")
        self.qualify(self.station,"receive","T3","07102")
        self.qualify(self.station,"L1","T2","75201")
        self.db.commit()
        mandate=dict(station_id=self.station,station_supplier_id=principal,station_executor_id=principal,station_acceptance_ref="SIM storage")
        last=dict(station_id=self.station,supplier_id=principal,executor_id=principal,product="T2",carrier=self.principal["name"],
            valid_until="2036-11-01",quote_ref="SIM quote",approved_ref="SIM approve",acceptance_ref="SIM accept",amount=30)
        if route=="C1":
            quote=operations.save_resource(self.db,dict(type="quote",name="all",carrier=self.principal["name"],path=route,order_id=self.o["id"],
                supplier_id=principal,executor_id=principal,scope="line haul, handling and final",comparison_ref="scope 1",valid_until="2036-11-01",
                evidence="SIM contract",accepted_ref="SIM signed",product="T2",amount=100,**dict(zip(operations.COSTS,[10,30,30,30,0]))),ADMIN)["resource"]
            self.o=operations.award_quote(self.db,dict(id=quote["id"],quote_version=quote["version"],version=self.o["version"],approval_ref="SIM approve"),ADMIN)["order"]
            self.o=folder.second_leg(self.db,self.o,dict(last,**{k:v for k,v in mandate.items() if k!="station_id"}),ADMIN)
            self.db.commit()
            with self.assertRaisesRegex(core.ApiError,"all_legs_contract"):
                self.dispatch(handoff_ref="SIM handoff")
        else:
            with self.assertRaisesRegex(core.ApiError,"接站"):
                self.dispatch(handoff_ref="SIM handoff")
            self.o=folder.station_mandate(self.db,self.o,mandate,ADMIN)
        self.dispatch(handoff_ref="SIM handoff",all_legs_contract="SIM combined contract")
        self.scan_network()
        self.act("station_receive",station_name="New Jersey",custodian="SIM station",receipt_ref="SIM station receipt",
                 units=[dict(sn=self.sn,condition="intact",evidence="SIM station scan")])
        if route=="C2":
            with self.assertRaisesRegex(core.ApiError,"二程"):
                self.act("station_release",driver="driver",carrier=self.principal["name"],dispatch_ref="SIM")
            self.o=folder.second_leg(self.db,self.o,last,ADMIN)
        plan=routing.example_plan(self.db,self.o,ADMIN,executor=principal,crew_coverage="75201")
        signed=operations.save_route(self.db,plan,ADMIN)["route"]
        link=gate.network(self.db,dict(executor_id=principal,crew_id=signed["crew_id"],vehicle_id=signed["resource_id"],driver="driver",plate="SIM-2",
            warehouse_id=self.station,zip="75201",model="M01",level="L1",product="T2",valid_until="2036-11-01",insurance_until="2036-11-01",evidence="SIM"),ADMIN)
        grant=gate.invite(self.db,self.o,dict(leg=2,link_id=link["id"],evidence="SIM"),ADMIN)
        gate.handle(self.db,"POST","/api/gate/"+self.o["id"]+"/accept",dict(version=self.o["version"],grant_version=grant["version"],leg=2,evidence="SIM ack"),ADMIN)
        self.act("station_release",driver="driver",carrier=self.principal["name"],dispatch_ref="SIM-2",route_id=signed["id"],route_version=signed["version"])
        self.o=gate.verify(self.db,self.o,dict(release_version=self.o["issue_version"],pickup_code=self.o["pickup_code"],driver="driver",plate="SIM-2",
            crew_id=signed["crew_id"],vehicle_id=signed["resource_id"],sns=[self.sn],evidence="SIM gate"),ADMIN)
        self.sign()
        self.assertEqual(self.o["station_receipts"][0]["sn"],self.sn)
        if route=="C1":self.assertEqual(self.o["chain_contract"]["principal"],self.o["second_leg"]["payee_id"])

    def test_c1_through_principal(self):
        self.station_flow("C1")

    def test_c2_receive_before_last_mile_acceptance(self):
        self.station_flow("C2")

    def test_d_sale_at_approved_destination(self):
        wh_user=dict(role="warehouse",username="warehouse")
        task=supply.position(self.db,dict(action="request",sn=self.sn,version=1,target_id=self.station,storage_right_ref="SIM agreement",evidence="SIM"),wh_user)
        supply.position(self.db,dict(action="approve",id=task["id"],version=1,approval_ref="SIM"),ADMIN)
        supply.transfer(self.db,dict(action="send",sn=self.sn,version=1,target_id=self.station,approval_ref="SIM",custodian="SIM carrier",evidence="SIM"),wh_user)
        supply.transfer(self.db,dict(action="accept",sn=self.sn,version=2,bin="NJ",condition="intact",state="available",custodian="SIM NJ",evidence="SIM"),wh_user)
        self.create("B")
        self.o=core.edit_order(self.db,self.o["id"],dict(version=self.o["version"],warehouse="New Jersey"),ADMIN)
        row=self.db.execute("SELECT version FROM positioning WHERE id=?",(task["id"],)).fetchone()
        self.o=supply.position(self.db,dict(action="sell",id=task["id"],version=row[0],order_id=self.o["id"],order_version=self.o["version"],sale_ref="SIM sale"),wh_user)["order"]
        self.assertEqual(self.o["positioned_sns"],[self.sn])
        self.act("ready",sn=self.sn,release_ref="SIM lock")
        self.assertEqual(self.o["status"],"ready")
