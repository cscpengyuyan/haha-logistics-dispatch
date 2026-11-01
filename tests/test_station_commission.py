"""Station security regressions; run the same assertions against baseline and upgrade."""
import unittest
from test_release_gates import ADMIN, fresh, core, operations


class StationCommission(unittest.TestCase):
    def setUp(self):
        self.db=fresh()
        self.addCleanup(self.db.close)
        self.order=next(o for o in core.list_orders(self.db,ADMIN) if o['city']=='New York')
        self.station=self.act('station_receive',station_name='New Jersey',custodian='Test Receiving Dock',
                              receipt_ref='STATION-R1',units=[dict(sn=self.order['sn'],condition='intact',evidence='SN-R1')])

    def act(self,action,**kwargs):
        order=core.get_order(self.db,self.order['id'],ADMIN)
        with self.db:
            return core.apply_action(self.db,order['id'],dict(action=action,version=order['version'],**kwargs),ADMIN)

    def test_unregistered_station_carrier_cannot_take_second_leg(self):
        with self.assertRaisesRegex(core.ApiError,'二程|驻站'):
            self.act('station_release',driver='driver',carrier='Unregistered Person',dispatch_ref='MADE-UP')

    def test_station_cannot_change_custody_by_assigning_its_own_driver(self):
        with self.assertRaises(core.ApiError):
            with self.db:
                core.apply_action(self.db,self.order['id'],dict(action='station_release',version=self.station['version'],
                    driver='driver',carrier='Storage Only',dispatch_ref='STORAGE-NOT-CARRIER'),
                    dict(role='warehouse',username='warehouse'))


    def test_revoke_reprice_reissue_only_second_leg(self):
        import folder,gate,routing,supply
        db=self.db
        oid=self.order["id"]
        get=lambda:core.get_order(db,oid,ADMIN)
        def issue(driver):
            o=get(); leg=o["second_leg"]; executor=leg["executor_id"]
            plan=routing.example_plan(db,o,ADMIN,executor=executor,driver=driver,crew_coverage=o["zip"])
            r=operations.save_route(db,plan,ADMIN)["route"]
            self.assertEqual([],r["check_result"]["issues"])
            link=gate.network(db,dict(executor_id=executor,crew_id=r["crew_id"],vehicle_id=r["resource_id"],driver=driver,
                plate="SIM-"+driver,warehouse_id=leg["station_id"],zip=o["zip"],model=o["model"],level=o["level"],
                product="T2",valid_until="2036-12-31",insurance_until="2036-12-31",evidence="SIM-VEH-REG"),ADMIN)
            grant=gate.invite(db,o,dict(leg=2,link_id=link["id"],evidence="SIM-TASK"),ADMIN)
            gate.handle(db,"POST",f"/api/gate/{oid}/accept",dict(version=o["version"],grant_version=grant["version"],evidence="SIM-ACK"),ADMIN)
            issued=self.act("station_release",route_id=r["id"],route_version=r["version"],driver=driver,
                            carrier=leg["carrier"],dispatch_ref="SIM-ASSIGN-"+driver)
            return dict(release_version=issued["issue_version"],pickup_code=issued["pickup_code"],driver=driver,
                        crew_id=r["crew_id"],vehicle_id=r["resource_id"],plate="SIM-"+driver,sns=[o["sn"]],evidence="SIM-SCAN")
        first=get()["first_leg_receipt"]
        old=issue("driver")
        g=gate.active(db,oid,2)
        gate.handle(db,"POST",f"/api/gate/{oid}/revoke",dict(version=get()["version"],grant_version=g["version"],evidence="原班失约"),ADMIN)
        with self.assertRaises(core.ApiError):
            gate.verify(db,get(),old,ADMIN)
        o=get();previous=o["second_leg"]
        sup=operations.save_resource(db,dict(type="supplier",name="SIM Backup",address="SIM Location",ability="T2",qualification="S3",evidence="SIM S3"),ADMIN)["resource"]
        sid=sup["id"]
        supply.qualify(db,dict(supplier_id=sid,executor_id=sid,product="T2",warehouse_id=previous["station_id"],zip=o["zip"],
            model=o["model"],action=o["level"],decision="Y",valid_until=previous["valid_until"],insurance_until=previous["valid_until"],evidence="SIM CAP"),ADMIN)
        folder.second_leg(db,o,dict(previous,supplier_id=sid,executor_id=sid,carrier=sup["name"],amount=335,storage_cost=12,
            change_reason="原班失约",waiver_ref="WAIVED-280",acceptance_ref="SIM-ACCEPT-B"),ADMIN)
        self.assertEqual(get()["approved_cost"],667)
        self.assertEqual(get()["second_leg_history"][0]["amount"],280)
        db.execute("INSERT INTO users(username,name,role,passhash) VALUES('backup','SIM replacement','driver','!')")
        new=issue("backup")
        with self.assertRaises(core.ApiError):gate.verify(db,get(),old,ADMIN)
        with self.assertRaises(core.ApiError):core.get_order(db,oid,dict(username="driver",role="driver"))
        result=gate.verify(db,get(),new,ADMIN)
        self.assertEqual(result["status"],"last_mile")
        self.assertEqual(result["first_leg_receipt"],first)
        self.assertEqual(result["second_leg"]["payee_id"],sid)
