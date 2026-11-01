"""T01/T02/T13: real business facts -> feasible candidates -> selection -> F04.

Synthetic users, commercial evidence and carrier travel times are explicit test
fixtures. No order, asset, quote, gate or dispatch state is written around its
domain API; only authentication accounts and the empty demo schema are seeded.
These tests are business integration evidence, not a live road-network claim.
"""
import copy
import itertools
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'v13'/'engine'))
import core,gate,lifecycle,operations,planning,routing,supply

DAY='2030-07-10'
def user(role):return dict(username=role,role=role)


class BusinessFixture:
    def __init__(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        core.core_schema(self.db);operations.init_db(self.db);planning.init_db(self.db);gate.schema(self.db)
        self.db.execute("INSERT INTO metadata VALUES('mode','demo')")
        for role in core.ROLES:
            self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES(?,?,?,'!')",(role,'SIM '+role,role))
        for driver in ('sim_driver_a','sim_driver_b','sim_driver_c'):
            self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES(?,?,'driver','!')",(driver,driver))
        self.supplier=self.resource('supplier','SIM actual contracted fleet','procurement',address='SIM company',ability='T2,L3,L4',qualification='S3',evidence='SIM-QUALIFICATION')
        self.capabilities=set();self.serials={};self.counter=0

    def resource(self,kind,name,role='dispatch',**fields):
        return operations.save_resource(self.db,dict(type=kind,name=name,**fields),user(role))['resource']

    def warehouse(self,name,lat=32.78,lng=-96.80):
        return self.resource('warehouse',name,'warehouse',address='SIM witnessed warehouse dock',zip='75201',lat=lat,lng=lng,timezone='America/Chicago',evidence='SIM-WAREHOUSE-DOCK')

    def vehicle(self,name,capacity,payload=2000):
        return self.resource('vehicle',name,capacity_units=capacity,tie_slots=capacity,payload_kg=payload,door_cm=240,door_width_cm=230,
            floor_length_cm=650,floor_width_cm=240,truck_length_m=8,truck_width_m=2.5,truck_height_m=3.5,gross_t=10,axle_load_t=6,
            equipment='SIM tail lift and restraints',lift_capacity_kg=850,executor_id=self.supplier['id'],evidence='SIM-VEHICLE-SPECS')

    def crew(self,name,stairs=False):
        return self.resource('crew',name,coverage='75201',headcount=3,tools='dolly,straps'+(',stair_climber' if stairs else ''),
            equipment='SIM stair training and lifting kit' if stairs else 'SIM ground-level delivery kit',qualified_until='2036-12-31',executor_id=self.supplier['id'],evidence='SIM-TRAINING-STAIRS' if stairs else 'SIM-TRAINING-GROUND')

    def order(self,warehouse,quantity=1,l4=False):
        self.counter+=1;n=self.counter
        o=core.create_order(self.db,dict(crm_ref='SIM-CAPACITY-'+str(n),customer='SIM receiver '+str(n),address='SIM entrance '+str(n),contact='SIM receiver',
            city='Dallas',state='TX',zip='75201',warehouse=warehouse['name'],model='M01',quantity=quantity,route='B',level='L3',addon_l4=l4,addon_l5=False,
            site_note='SIM stairs surveyed; powered stair climber and three trained people required' if l4 else 'SIM ground floor dock',
            endpoint='SIM final placement '+str(n),window_start=DAY+'T08:00',window_end=DAY+'T18:00',timezone='America/Chicago',lat=32.78+n*.001,lng=-96.8,
            location_precision='dock',coordinate_ref='SIM witnessed receiving entrance',pack_version='SIM-PACK-v1',procurement_mode='company'),user('sales'))
        sns=['SIM-CAPACITY-'+str(n)+'-'+str(i) for i in range(quantity)]
        for sn in sns:
            lifecycle.receipt(self.db,dict(sn=sn,model='M01',warehouse=warehouse['name'],bin='SIM-A1',batch='SIM-RECEIPT',condition='SIM intact',state='available',evidence='SIM-GRN-'+sn),user('warehouse'))
        o=core.apply_action(self.db,o['id'],dict(action='ready',version=o['version'],sn=','.join(sns),release_ref='SIM-RESERVATION'),user('warehouse'))
        self.serials[o['id']]=sns
        for action in ['L3']+(['L4'] if l4 else []):
            key=(warehouse['id'],action)
            if key not in self.capabilities:
                supply.qualify(self.db,dict(supplier_id=self.supplier['id'],executor_id=self.supplier['id'],warehouse_id=warehouse['id'],zip='75201',model='M01',action=action,product='T2',decision='Y',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-WRITTEN-'+action+'-QUALIFICATION'),user('procurement'))
                self.capabilities.add(key)
        quote=self.resource('quote','SIM confirmed full price '+str(n),'procurement',order_id=o['id'],carrier=self.supplier['name'],path='B',scope='SIM complete physical delivery'+(' including surveyed L4 stairs' if l4 else ''),
            comparison_ref='SIM-EQUAL-SCOPE',valid_until='2036-12-31',evidence='SIM-WRITTEN-FULL-PRICE',supplier_id=self.supplier['id'],executor_id=self.supplier['id'],product='T2',accepted_ref='SIM-CARRIER-ACCEPTED',
            origin_cost=40,station_cost=0,delivery_cost=260 if l4 else 360,special_cost=100 if l4 else 0,other_cost=0,amount=400)
        operations.award_quote(self.db,dict(id=quote['id'],quote_version=quote['version'],version=o['version'],approval_ref='SIM-FULL-PRICE-APPROVED'),user('procurement'))
        return core.get_order(self.db,o['id'],user('dispatch'))

    def route(self,orders,warehouse,vehicle,crew,driver):
        checks=dict(driver=driver,scope_ref='SIM-CONTRACT-AND-SKILL',handling_ref='SIM-EXACT-VEHICLE-TOOL-REVIEW',shift_start=DAY+'T07:00',shift_end=DAY+'T19:00',warehouse_start=DAY+'T07:00',warehouse_end=DAY+'T17:00',return_min=20)
        stops={};previous=warehouse['id']
        for o in orders:
            stops[o['id']]=dict(from_id=previous,travel=10,road_ref='SIM-CARRIER-WRITTEN-LEG-NOT-REAL-ROAD',admission=5,service=45 if o['addon_l4'] else 30,unload=10,
                height=191,length_cm=100,width_cm=83,kg=226,lift_extra_kg=0,required_people=3 if o['addon_l4'] else 2,required_tools='dolly,straps'+(',stair_climber' if o['addon_l4'] else ''),
                requires_lift='yes',dock_ref='SIM-DOCK-SURVEY',package_ref='SIM-PACK-v1')
            previous=o['id']
        return operations.save_route(self.db,dict(name='SIM '+warehouse['name']+' '+vehicle['name']+' '+crew['name']+' '+','.join(o['id'] for o in orders),warehouse=warehouse['name'],date=DAY,start_time='08:00',timezone=warehouse['timezone'],
            order_ids=[o['id'] for o in orders],order_versions={o['id']:o['version'] for o in orders},resource_id=vehicle['id'],crew_id=crew['id'],executor_id=self.supplier['id'],road_basis='carrier',checks=checks,stops=stops),user('dispatch'))['route']

    def optimize(self,orders):
        return operations.handle(self.db,'POST','/api/ops/plans/optimize',dict(order_ids=[o['id'] for o in orders],budget_seconds=5,planning_scope='delivery_complete'),user('dispatch'))['plan']

    def adopt_and_handover(self,plan):
        out=operations.handle(self.db,'POST','/api/ops/plans/'+plan['id']+'/adopt',dict(version=plan['version'],candidate_id=plan['candidates'][0]['id'],idempotency_key='SIM-ADOPT-'+plan['id']),user('dispatch'))
        for route in out['routes']:
            for oid in route['order_ids']:
                o=core.get_order(self.db,oid,user('dispatch'))
                link=gate.network(self.db,dict(executor_id=self.supplier['id'],crew_id=route['crew_id'],vehicle_id=route['resource_id'],driver=route['checks']['driver'],plate='SIM-'+route['resource_id'],
                    warehouse_id=route['warehouse_id'],zip=o['zip'],model=o['model'],level=o['level'],product='T2',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-REAL-ROUTE-ROSTER'),user('procurement'))
                g=gate.invite(self.db,o,dict(leg=1,link_id=link['id'],evidence='SIM-F04-NOMINATION'),user('procurement'))
                gate.handle(self.db,'POST','/api/gate/'+oid+'/accept',dict(version=o['version'],grant_version=g['version'],evidence='SIM-F04-ACCEPT'),user('procurement'))
                core.apply_action(self.db,oid,dict(action='dispatch',version=o['version'],driver=route['checks']['driver'],carrier=self.supplier['name'],approved_cost=400,dispatch_ref='SIM-F04',route_id=route['id'],route_version=route['version'],checks={k:'SIM-CONFIRMED-'+k for k in core.CHECKS}),user('dispatch'))
                o=core.get_order(self.db,oid,user('dispatch'))
                gate.verify(self.db,o,dict(release_version=o['issue_version'],pickup_code=o['pickup_code'],sns=self.serials[oid],driver=route['checks']['driver'],plate='SIM-'+route['resource_id'],crew_id=route['crew_id'],vehicle_id=route['resource_id'],evidence='SIM-SCANNED-SN-HANDOVER'),user('warehouse'))
        return out['routes']


class CapacityAndOriginAcceptance(unittest.TestCase):
    def setUp(self):
        self.f=BusinessFixture();self.addCleanup(self.f.db.close)

    def test_t01_three_actual_l4_orders_share_the_only_qualified_stair_crew(self):
        f=self.f;wh=f.warehouse('SIM Dallas actual warehouse')
        orders=[f.order(wh,l4=True) for _ in range(3)]
        qualified=f.crew('SIM only trained stair crew',stairs=True);ordinary=f.crew('SIM ground crew')
        van=f.vehicle('SIM stair vehicle',3);other=f.vehicle('SIM ordinary vehicle',3)
        good=f.route(orders,wh,van,qualified,'sim_driver_a')
        bad=f.route(orders,wh,other,ordinary,'sim_driver_b')
        self.assertFalse(good['check_result']['issues'])
        self.assertTrue(any('工具' in x for x in bad['check_result']['issues']))
        # Individually feasible singles compete for the same scarce crew at 08:00.
        for o in orders:f.route([o],wh,van,qualified,'sim_driver_a')
        self.assertEqual(f.db.execute("SELECT count(*) FROM capability WHERE json_extract(data,'$.action')='L4'").fetchone()[0],1)
        plan=f.optimize(orders)
        self.assertEqual(plan['precheck']['ready_count'],3,plan['precheck'])
        self.assertEqual(plan['coverage']['assigned'],3,plan['unassigned'])
        self.assertEqual(len(plan['routes']),1)
        self.assertEqual(plan['routes'][0]['crew_id'],qualified['id'])
        self.assertEqual(set(plan['routes'][0]['order_ids']),{o['id'] for o in orders})
        self.assertTrue(any(r['crew_id']==ordinary['id'] and r['issues'] for r in plan['draft_routes']))
        adopted=f.adopt_and_handover(plan)
        self.assertEqual(len(adopted),1)
        self.assertEqual(f.db.execute("SELECT count(*) FROM orders WHERE status='in_transit'").fetchone()[0],3)
        self.assertEqual({r[0] for r in f.db.execute("SELECT crew FROM route_bookings WHERE cancelled=''")},{qualified['id']})

    def test_t02_two_unit_small_and_four_unit_large_truck_compete_using_actual_capacity(self):
        f=self.f;wh=f.warehouse('SIM Dallas actual warehouse')
        orders=[f.order(wh,quantity=q) for q in (1,2,3)]
        small=f.vehicle('SIM small 2 units',2,payload=452);large=f.vehicle('SIM large 4 units',4,payload=904)
        ca=f.crew('SIM small crew');cb=f.crew('SIM large crew')
        for count in (1,2,3):
            for subset in itertools.combinations(orders,count):
                f.route(subset,wh,small,ca,'sim_driver_a');f.route(subset,wh,large,cb,'sim_driver_b')
        generated,_=planning.generated(f.db,orders,{})
        quantities={o['id']:o['quantity'] for o in orders}
        self.assertTrue(generated)
        for route in generated:
            actual=routing.resource(f.db,'vehicle',route['resource_id'])
            self.assertLessEqual(sum(quantities[i] for i in route['order_ids']),actual['capacity_units'])
        plan=f.optimize(orders)
        self.assertEqual(plan['coverage']['assigned'],3,plan['unassigned'])
        chosen={r['resource_id']:r for r in plan['routes']}
        self.assertEqual(set(chosen),{small['id'],large['id']})
        self.assertEqual(chosen[small['id']]['order_ids'],[orders[1]['id']])
        self.assertEqual(set(chosen[large['id']]['order_ids']),{orders[0]['id'],orders[2]['id']})
        for vid,limit in ((small['id'],2),(large['id'],4)):
            self.assertEqual(max(x['units'] for x in chosen[vid]['load_profile']),limit)
            self.assertEqual(max(x['kg'] for x in chosen[vid]['load_profile']),limit*226)
        self.assertTrue(any(r['resource_id']==small['id'] and r['issues'] and sum(quantities[i] for i in r['order_ids'])>2 for r in plan['draft_routes']))
        adopted=f.adopt_and_handover(plan)
        self.assertEqual(len(adopted),2)
        self.assertEqual(f.db.execute("SELECT count(*) FROM assets WHERE state='transit'").fetchone()[0],6)

    def test_t13_two_actual_warehouses_split_routes_and_keep_each_serial_origin(self):
        f=self.f;a=f.warehouse('SIM actual warehouse A',32.78,-96.80);b=f.warehouse('SIM actual warehouse B',32.82,-96.91)
        oa=f.order(a);ob=f.order(b);orders=[oa,ob]
        va=f.vehicle('SIM A truck',2);vb=f.vehicle('SIM B truck',2);ca=f.crew('SIM A crew');cb=f.crew('SIM B crew')
        f.route([oa],a,va,ca,'sim_driver_a');f.route([ob],b,vb,cb,'sim_driver_b')
        mixed=f.route(orders,a,va,ca,'sim_driver_a')
        relabeled=f.route([ob],a,vb,cb,'sim_driver_b')
        self.assertTrue(any('持货点' in i or '库存锁' in i for i in mixed['check_result']['issues']))
        self.assertTrue(any('持货点' in i or '库存锁' in i for i in relabeled['check_result']['issues']))
        before={row['sn']:(row['warehouse'],row['order_id']) for row in f.db.execute('SELECT * FROM assets')}
        self.assertEqual(before[f.serials[oa['id']][0]],(a['name'],oa['id']))
        self.assertEqual(before[f.serials[ob['id']][0]],(b['name'],ob['id']))
        plan=f.optimize(orders)
        self.assertEqual(plan['coverage']['assigned'],2,plan['unassigned'])
        self.assertEqual(len(plan['routes']),2)
        self.assertEqual({r['warehouse'] for r in plan['routes']},{a['name'],b['name']})
        for r in plan['routes']:
            self.assertEqual(len(r['order_ids']),1)
            oid=r['order_ids'][0]
            self.assertEqual(r['sns'],f.serials[oid])
            self.assertTrue(all(before[sn]==(r['warehouse'],oid) for sn in r['sns']))
            self.assertTrue(all(slot['start_location']==r['warehouse'] for slot in r['occupancy']))
        adopted=f.adopt_and_handover(plan)
        self.assertEqual({r['warehouse'] for r in adopted},{a['name'],b['name']})
        self.assertEqual(before,{row['sn']:(row['warehouse'],row['order_id']) for row in f.db.execute('SELECT * FROM assets')})
        self.assertEqual(f.db.execute("SELECT count(*) FROM assets WHERE state='transit'").fetchone()[0],2)


if __name__=='__main__':unittest.main()
