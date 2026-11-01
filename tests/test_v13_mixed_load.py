"""T06 uses actual SIM sales/stock/delivery/RMA APIs in an isolated database."""
import copy,json,sqlite3,sys,tempfile,unittest
from contextlib import closing
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'v13'/'engine'));sys.path.insert(0,str(ROOT/'scripts'))
import core,operations,lifecycle,simulation,routing,load_profile,gate,planning
from run_sim200 import Replay
U=simulation.actor


class MixedLoad(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();path=Path(cls.tmp.name)
        source=ROOT/'docs/sim200/ready-public/SIM200.sqlite3'
        if not source.exists():source=ROOT/'v13/data/sim200-ready.sqlite3'
        if not source.exists():raise RuntimeError('Run SIM200 --prepare-only to create the authorized input fixture')
        db=sqlite3.connect(path/'SIM200.sqlite3')
        with closing(sqlite3.connect(source)) as old:old.backup(db)
        db.close()
        replay=Replay(path);db=replay.db;replay.resources=simulation.provision(db)
        row=next(x for x in replay.rows if x['order']['id']=='SIM200-053');m=row['coverage']
        # The source customer machine is genuinely dispatched, gate-released and
        # delivered through existing services before aftercare can authorize it.
        replay.dispatch('SIM200-053',m);replay.verify('SIM200-053',m);replay.complete('SIM200-053',m)
        old=core.get_order(db,'SIM200-053',U('dispatch'));day=old['window_start'][:10]
        fleet=replay.resources['fleets'][m['vehicle_number']-1]
        body=dict(order_id=old['id'],sn=m['serials'][0],kind='rma',item_type='machine',purpose='commercial',reason_ref='SIM-RETURN-REQUEST',seller_approval='SIM-SELLER-APPROVAL',issue='SIM commercial return',custodian=old['customer'],owner='service',next_step='SIM approved same-site collection',due=day+'T17:00',evidence='SIM-RMA')
        case=lifecycle.make_case(db,body,U('service'))
        warehouse=replay.resources['places']['Dallas']
        case=lifecycle.advance_case(db,dict(id=case['id'],version=case['version'],to='authorized',approval_ref='SIM-RMA-APPROVED',return_to=warehouse['name'],part_ref=m['serials'][0],receiver_id=warehouse['id'],receiver_acceptance='SIM-RECEIVER',protection_ref='SIM-PROTECTION',redelivery_ref='SIM-COMMERCIAL-DISPOSITION'),U('service'))
        asset=db.execute('SELECT version FROM assets WHERE sn=?',(m['serials'][0],)).fetchone()
        confirmed=operations.handle(db,'POST','/api/ops/collections/confirm',dict(id=case['id'],version=case['version'],asset_version=asset[0],packing=dict(length_cm=100,width_cm=83,height_cm=191,weight_kg=226,upright=True,nonstackable=True),pickup_ref='SIM-PICKUP',package_ref='SIM-MEASURED-RETURN-PACK',window_start=day+'T12:00',window_end=day+'T17:00',timezone=old['timezone'],service_minutes=20,amount_minor=2500,cost_approval_ref='SIM-RECOVERY-COST',lift_extra_kg=80),U('service'))
        # A separate normal delivery at the identical verified customer entrance.
        data={k:old[k] for k in core.FIELDS if k in old};data.update(quantity=2,crm_ref='SIM-T06-DELIVERY',window_start=day+'T12:00',window_end=day+'T17:00')
        order=core.create_order(db,data,U('sales'))
        for i in (1,2):lifecycle.receipt(db,dict(sn='SIM-T06-NEW-'+str(i),warehouse=old['warehouse'],model='M01',bin='SIM',condition='intact',batch='SIM-T06',evidence='SIM-GRN',state='available'),U('warehouse'))
        order=core.apply_action(db,order['id'],dict(action='ready',version=order['version'],sn='SIM-T06-NEW-1,SIM-T06-NEW-2',release_ref='SIM-GRN'),U('warehouse'))
        replay.commission(order['id'],m);order=core.get_order(db,order['id'],U('dispatch'))
        v=operations.save_resource(db,dict(fleet['vehicle'],type='vehicle',capacity_units=2,payload_kg=600,tie_slots=2,floor_width_cm=100,door_width_cm=100,floor_length_cm=200),U('dispatch'))['resource']
        plan=dict(name='SIM T06 mixed load',warehouse=old['warehouse'],date=day,start_time='12:00',timezone=old['timezone'],resource_id=v['id'],crew_id=fleet['crew']['id'],executor_id=fleet['supplier']['id'],order_ids=[order['id']],order_versions={order['id']:order['version']},road_basis='carrier',
            checks=dict(driver=fleet['driver'],scope_ref='SIM-MIXED-SCOPE',handling_ref='SIM-TOOLS',shift_start=day+'T07:00',shift_end=day+'T19:00',warehouse_start=day+'T07:00',warehouse_end=day+'T17:00',return_min=30),
            stops={order['id']:dict(from_id=warehouse['id'],road_ref='SIM CONTROLLED CARRIER ROAD',dock_ref='SIM-SAME-DOCK',package_ref='SIM-PACK',height=191,kg=226,length_cm=100,width_cm=83,required_people=2,required_tools='dolly,straps',requires_lift='yes',lift_extra_kg=80,travel=30,admission=10,unload=10,service=60,delivery_service_minutes=40)},
            collections={order['id']:[dict(rma_id=confirmed['rma_id'],version=confirmed['version'],asset_version=confirmed['asset_version'],before_delivery=False)]})
        db.commit();cls.fixture=path/'fixture.sqlite3'
        with closing(sqlite3.connect(cls.fixture)) as destination:db.backup(destination)
        cls.plan=plan;cls.order=order;cls.confirmed=confirmed;cls.fleet=fleet;cls.warehouse=warehouse
        db.close()

    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        with closing(sqlite3.connect(self.fixture)) as source:source.backup(self.db)
        self.p=copy.deepcopy(self.plan);self.o=core.get_order(self.db,self.order['id'],U('dispatch'))
    def tearDown(self):self.db.close()

    def test_T06_both_sequences_have_different_peak_and_overload_excluded(self):
        result=operations.handle(self.db,'POST','/api/ops/collections/compare',{'route':self.p},U('dispatch'))
        after,before=result['comparisons']
        self.assertTrue(after['feasible'],after['issues']);self.assertFalse(before['feasible'])
        self.assertEqual(after['peak'],dict(units=2,kg=452,floor_length_cm=200,tie_slots=2))
        self.assertEqual(before['peak'],dict(units=3,kg=678,floor_length_cm=300,tie_slots=3))
        self.assertEqual(after['profile'][-1]['units'],1)
        out=ROOT/'docs/verification/v13/T06-mixed-load.json';out.parent.mkdir(parents=True,exist_ok=True)
        out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')

    def test_bad_order_is_rejected_by_normal_route_validator(self):
        self.p['collections'][self.o['id']][0]['before_delivery']=True
        route=operations.save_route(self.db,self.p,U('dispatch'))['route']
        self.assertTrue(any('超过' in e for e in route['check_result']['issues']))
        self.assertEqual(route['check_result']['mixed_load']['peak']['units'],3)
    def test_valid_order_passes_same_normal_route_validator(self):
        route=operations.save_route(self.db,self.p,U('dispatch'))['route']
        self.assertEqual(route['check_result']['issues'],[])
        self.assertEqual(route['collections'],self.p['collections'])
        self.assertEqual(self.db.execute('SELECT state FROM after_cases WHERE id=?',(self.confirmed['rma_id'],)).fetchone()[0],'authorized')
    def test_unapproved_or_fictitious_pickup_cannot_be_smuggled(self):
        self.p['collections'][self.o['id']][0]['rma_id']='UNKNOWN'
        r=load_profile.check_mixed(self.db,self.p,[self.o]);self.assertIn('COLLECTION_AUTHORITY_CONFLICT',[x['code'] for x in r['issues']])
        self.p['collections'][self.o['id']][0]['sn']='FAKE'
        with self.assertRaises(core.ApiError):operations.save_route(self.db,self.p,U('dispatch'))
    def test_invalid_collection_shapes_return_422_before_comparing(self):
        for invalid in (['bad'],{self.o['id']:['bad']},{self.o['id']:[{'rma_id':self.confirmed['rma_id']}]}):
            with self.subTest(value=invalid):
                self.p['collections']=invalid
                with self.assertRaises(core.ApiError) as caught:
                    operations.handle(self.db,'POST','/api/ops/collections/compare',{'route':self.p},U('dispatch'))
                self.assertEqual(caught.exception.status,422)
    def test_changed_case_or_asset_version_fails_closed(self):
        self.p['collections'][self.o['id']][0]['asset_version']+=1
        self.assertTrue(load_profile.check_mixed(self.db,self.p,[self.o])['issues'])
    def test_extra_pickup_time_is_not_hidden(self):
        self.p['stops'][self.o['id']]['service']=40
        r=load_profile.check_mixed(self.db,self.p,[self.o]);self.assertIn('COLLECTION_TIME_REQUIRED',[x['code'] for x in r['issues']])
    def test_delivery_lift_load_not_bypassed_by_mixed_route(self):
        self.p['stops'][self.o['id']]['lift_extra_kg']=10000
        r=load_profile.check_mixed(self.db,self.p,[self.o]);self.assertIn('LIFT_CAPACITY_CONFLICT',[x['code'] for x in r['issues']])
    def test_first_leg_station_cannot_claim_customer_pickup(self):
        self.p['first_leg_ids']=[self.o['id']]
        r=load_profile.check_mixed(self.db,self.p,[self.o]);self.assertTrue(any('首程实际目的地' in x['message'] for x in r['issues']))
    def test_different_site_is_not_an_unrouted_pickup_stop(self):
        self.o['lat']+=.1
        r=load_profile.check_mixed(self.db,self.p,[self.o]);self.assertTrue(any('同一' in x['message'] for x in r['issues']))
    def test_collection_reservation_idempotent_and_cannot_double_book(self):
        route=operations.save_route(self.db,self.p,U('dispatch'))['route']
        load_profile.reserve(self.db,route);load_profile.reserve(self.db,route)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM collection_bookings WHERE active=1').fetchone()[0],1)
        other=dict(route,id='ANOTHER')
        with self.assertRaises(core.ApiError):load_profile.reserve(self.db,other)
    def test_permission_and_signature_include_collection_order(self):
        with self.assertRaises(core.ApiError):load_profile.confirm(self.db,{},U('sales'))
        a=routing.road_signature(self.p,[self.o['id']],{})
        self.p['collections'][self.o['id']][0]['before_delivery']=True
        b=routing.road_signature(self.p,[self.o['id']],{})
        self.assertNotEqual(a,b)

    def sign(self):
        f=self.fleet;o=self.o
        link=gate.network(self.db,dict(executor_id=f['supplier']['id'],crew_id=f['crew']['id'],vehicle_id=f['vehicle']['id'],driver=f['driver'],plate='SIM-T06',warehouse_id=self.warehouse['id'],zip=o['zip'],model='M01',level=o['level'],product='T2',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-NET'),U('procurement'))
        grant=gate.invite(self.db,o,dict(leg=1,link_id=link['id'],evidence='SIM-INVITE'),U('procurement'))
        gate.handle(self.db,'POST',f"/api/gate/{o['id']}/accept",dict(version=o['version'],grant_version=grant['version'],leg=1,evidence='SIM-ACCEPT'),U('procurement'))
        route=operations.save_route(self.db,self.p,U('dispatch'))['route']
        return core.apply_action(self.db,o['id'],dict(action='dispatch',version=o['version'],carrier=f['supplier']['name'],driver=f['driver'],route_id=route['id'],route_version=route['version'],approved_cost=400,dispatch_ref='SIM-T06-ISSUE',checks={k:'SIM-'+k for k in core.CHECKS}),U('dispatch'))

    def test_F04_real_signing_reserves_rma_and_departure_checks_its_version(self):
        signed=self.sign()
        self.assertEqual(signed['status'],'dispatched')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM collection_bookings WHERE active=1').fetchone()[0],1)
        routing.validate_departure(self.db,signed)
        self.db.execute('UPDATE after_cases SET version=version+1 WHERE id=?',(self.confirmed['rma_id'],))
        with self.assertRaisesRegex(core.ApiError,'回收事实已变化'):routing.validate_departure(self.db,signed)

    def test_F04_overload_cannot_be_signed(self):
        self.p['collections'][self.o['id']][0]['before_delivery']=True
        with self.assertRaisesRegex(core.ApiError,'不能签发'):self.sign()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM collection_bookings WHERE active=1').fetchone()[0],0)

    def test_optimizer_selects_valid_mixed_order_and_prices_authorized_collection(self):
        bad=copy.deepcopy(self.p);bad['collections'][self.o['id']][0]['before_delivery']=True
        plain=copy.deepcopy(self.p);plain.pop('collections')
        requested={self.o['id']:[self.confirmed['rma_id']]}
        result=operations.handle(self.db,'POST','/api/ops/plans/optimize',dict(order_ids=[self.o['id']],route_candidates=[bad,self.p,plain],required_collections=requested,budget_seconds=3),U('dispatch'))['plan']
        self.assertEqual(result['coverage']['assigned'],1,result)
        self.assertEqual(result['coverage']['collection_assigned'],1)
        self.assertEqual(result['metrics']['feasible_count'],1)
        chosen=result['routes'][0]
        self.assertFalse(chosen['collections'][self.o['id']][0]['before_delivery'])
        self.assertEqual(chosen['total_minor'],42500)
        self.assertEqual(chosen['mixed_load']['peak']['units'],2)
        self.assertTrue(any(i['code']=='COLLECTION_SCOPE_INCOMPLETE' for r in result['draft_routes'] for i in r['issues']))

    def test_actual_rma_receipt_releases_collection_reservation(self):
        self.sign();cid=self.confirmed['rma_id']
        shipped=lifecycle.advance_case(self.db,dict(id=cid,version=self.confirmed['version'],to='shipped',tracking='SIM-ACTUAL-COLLECTION',custodian=self.fleet['driver']),U('service'))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM collection_bookings WHERE active=1').fetchone()[0],1)
        received=lifecycle.advance_case(self.db,dict(id=cid,version=shipped['version'],to='received',receipt_ref='SIM-ACTUAL-RETURN-GRN',inspection='SIM intact'),U('warehouse'))
        self.assertEqual(received['state'],'received')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM collection_bookings WHERE active=1').fetchone()[0],0)


if __name__=='__main__':unittest.main()
