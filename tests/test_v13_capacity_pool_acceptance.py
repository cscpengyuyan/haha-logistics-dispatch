"""T21: real A-network and B-vehicle orders share one confirmed supplier pool.

All business objects are created through their domain APIs; there is no assumed
SIM200 supplier pairing and no hand-built solver array. Carrier facts are synthetic.
"""
import unittest
from test_v13_capacity_origin_acceptance import BusinessFixture,DAY,user
import core,folder,lifecycle,operations,planning


class CapacityPoolAcceptance(unittest.TestCase):
    def setUp(self):
        self.f=BusinessFixture();self.db=self.f.db
        self.addCleanup(self.db.close)
        self.user=user('dispatch');self.procurement=user('procurement')
        self.warehouse=self.f.warehouse('SIM actual shared-pool warehouse')
        concrete=self.f.order(self.warehouse)
        self.vehicle=self.f.vehicle('SIM concrete shared-pool vehicle',2)
        crew=self.f.crew('SIM concrete shared-pool crew')
        self.concrete_route=self.f.route([concrete],self.warehouse,self.vehicle,crew,'sim_driver_a')
        self.assertEqual(self.concrete_route['check_result']['issues'],[])
        network=core.create_order(self.db,dict(crm_ref='SIM-A-NETWORK-POOL',customer='SIM network receiver',address='SIM network entrance',contact='SIM receiver',city='Dallas',state='TX',zip='75201',warehouse=self.warehouse['name'],model='M01',quantity=1,route='A',a_channel='amazon',level='L3',endpoint='SIM platform receiving dock',procurement_mode='platform',
            window_start=DAY+'T08:00',window_end=DAY+'T18:00',timezone='America/Chicago',lat=32.785,lng=-96.805,location_precision='dock',coordinate_ref='SIM observed platform entrance',pack_version='SIM-PACK-v1'),user('sales'))
        lifecycle.receipt(self.db,dict(sn='SIM-NETWORK-POOL-001',warehouse=self.warehouse['name'],model='M01',bin='SIM-A2',batch='SIM-NETWORK-ASN',condition='SIM intact',state='available',evidence='SIM-NETWORK-GRN'),user('warehouse'))
        network=core.apply_action(self.db,network['id'],dict(action='ready',version=network['version'],sn='SIM-NETWORK-POOL-001',release_ref='SIM-NETWORK-RESERVATION'),user('warehouse'))
        supplier=self.f.supplier
        quote=self.f.resource('quote','SIM A network confirmed full price','procurement',order_id=network['id'],carrier=supplier['name'],path='A',scope='SIM complete platform delivery commitment',comparison_ref='SIM-NETWORK-EQUAL-SCOPE',valid_until='2036-12-31',evidence='SIM-NETWORK-WRITTEN-FULL-PRICE',supplier_id=supplier['id'],executor_id=supplier['id'],product='T2',accepted_ref='SIM-NETWORK-CARRIER-ACCEPT',origin_cost=40,station_cost=0,delivery_cost=360,special_cost=0,other_cost=0,amount=400)
        operations.award_quote(self.db,dict(id=quote['id'],quote_version=quote['version'],version=network['version'],approval_ref='SIM-NETWORK-FULL-PRICE-APPROVED'),self.procurement)
        network=core.get_order(self.db,network['id'],self.user)
        folder.platform_instruction(self.db,network,dict(account_ref='SIM-PLATFORM-ACCOUNT',instruction_ref='SIM-PLATFORM-INSTRUCTION',executor_id=supplier['id'],carrier=supplier['name'],acceptance_ref='SIM-PLATFORM-WRITTEN-ACCEPT',valid_until='2036-12-31',bol_ref='SIM-PLATFORM-BOL',pickup_ref='SIM-PLATFORM-PICKUP',identity_ref='SIM-PLATFORM-CARRIER-ID'),self.procurement)
        self.ids=[network['id'],concrete['id']]
        self.orders = [core.get_order(self.db, oid, self.user) for oid in self.ids]
        self.assertEqual(self.orders[0]['selected_quote']['supplier_id'],
                         self.orders[1]['selected_quote']['supplier_id'])
        self.assertEqual(self.orders[0]['window_start'], self.orders[1]['window_start'])
        self.assertEqual([o['route'] for o in self.orders],['A','B'])
        self.assertEqual([o['procurement_mode'] for o in self.orders],['platform','company'])
        self.assertEqual(self.db.execute("SELECT count(*) FROM assets WHERE state='reserved'").fetchone()[0],2)

    def set_capacity(self, capacity):
        # Use the same resource maintenance API and optimistic versions as the
        # application, not injected pre-priced solver candidates.
        profile=planning.profiles(self.db,'resource').get(self.vehicle['id'],{})
        data=dict(pool_key='SIM-confirmed-joint-fleet-network',pool_capacity=capacity)
        operations.handle(self.db,'POST','/api/ops/plans/profiles/resource',dict(id=self.vehicle['id'],version=profile.get('profile_version'),evidence='SIM shared pool acknowledgement',data=data),self.user)
        oid = self.ids[0]
        p=planning.profiles(self.db,'commitment').get(oid,{})
        data=dict(pool_key='SIM-confirmed-joint-fleet-network',capacity_units=capacity,acceptance_ref='SIM-NETWORK-CAPACITY-ACCEPT',start=DAY+'T08:00',end=DAY+'T12:00',timezone='America/Chicago')
        operations.handle(self.db,'POST','/api/ops/plans/profiles/commitment',dict(id=oid,version=p.get('profile_version'),order_version=self.orders[0]['version'],evidence='SIM shared supplier pool',data=data),self.procurement)

    def test_t21_vehicle_and_network_cannot_duplicate_supplier_capacity_then_adopt_at_two(self):
        self.set_capacity(1)
        limited = operations.handle(self.db,'POST','/api/ops/plans/optimize',dict(order_ids=self.ids,budget_seconds=10),self.user)['plan']
        self.assertEqual(limited['precheck']['issues'], [])
        feasible = [r for r in limited['draft_routes'] if not r['issues']]
        self.assertTrue(any(r.get('kind') == 'supplier_commitment' for r in feasible))
        self.assertTrue(any(r.get('resource_id') for r in feasible))
        self.assertEqual(limited['coverage']['assigned'], 1)
        self.assertEqual(limited['validation_status'], 'conditions_pending')
        self.assertTrue(any(e['code']=='CAPACITY_CONFLICT' for u in limited['unassigned'] for e in u['reasons']))
        with self.assertRaises(core.ApiError):
            operations.handle(self.db,'POST','/api/ops/plans/'+limited['id']+'/adopt',dict(version=1,candidate_id=limited['candidates'][0]['id'],idempotency_key='SIM-PARTIAL-NOT-ADOPTABLE'),self.user)
        self.assertTrue(all(core.get_order(self.db,oid,self.user)['status']=='ready' for oid in self.ids))
        self.set_capacity(2)
        complete = operations.handle(self.db,'POST','/api/ops/plans/optimize',dict(order_ids=self.ids,budget_seconds=10),self.user)['plan']
        self.assertEqual(complete['coverage']['assigned'], 2)
        self.assertEqual(complete['validation_status'], 'passed')
        self.assertEqual(len({p['key'] for r in complete['routes'] for p in r['pools']}), 1)
        self.assertEqual(sum(p['quantity'] for r in complete['routes'] for p in r['pools']), 2)
        self.assertEqual({p['key'] for r in complete['routes'] for p in r['pools']},{'SIM-confirmed-joint-fleet-network:'+DAY})
        adopted = operations.handle(self.db,'POST','/api/ops/plans/'+complete['id']+'/adopt',dict(version=1,candidate_id=complete['candidates'][0]['id'],idempotency_key='SIM-MIXED-POOL-ADOPT'),self.user)
        self.assertEqual(adopted['plan']['state'], 'adopted_pending_release')
        self.assertEqual(len(adopted['routes']), 1)
        self.assertEqual(len(adopted['plan']['adopted_commitments']), 1)
        self.assertFalse(adopted['plan']['adopted_commitments'][0]['resource_id'])
        self.assertFalse(adopted['plan']['adopted_commitments'][0]['crew_id'])
        self.assertEqual(adopted['plan']['adopted_commitments'][0]['order_ids'],[self.ids[0]])
        self.assertEqual(adopted['routes'][0]['resource_id'],self.vehicle['id'])
        self.assertEqual(adopted['routes'][0]['order_ids'],[self.ids[1]])
        self.assertFalse(self.db.execute('SELECT 1 FROM gate_grants').fetchone())
        self.assertTrue(all(core.get_order(self.db,oid,self.user)['status']=='ready' for oid in self.ids))


if __name__ == '__main__':
    unittest.main()
