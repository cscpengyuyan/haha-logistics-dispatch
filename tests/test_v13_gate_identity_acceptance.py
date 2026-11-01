"""Four concrete identity mistakes cannot move an actual reserved serial."""
import copy
import unittest
from test_v13_capacity_origin_acceptance import BusinessFixture, user, DAY
import core
import gate
import operations


class GateIdentityAcceptance(unittest.TestCase):
    def setUp(self):
        self.f = BusinessFixture()
        self.addCleanup(self.f.db.close)
        self.wh = self.f.warehouse('SIM original warehouse')
        self.vehicle = self.f.vehicle('SIM assigned vehicle', 2)
        self.crew = self.f.crew('SIM assigned crew')
        self.order = self.f.order(self.wh)

    def issue(self):
        f = self.f
        o = core.get_order(f.db,self.order['id'],user('dispatch'))
        r = f.route([o],self.wh,self.vehicle,self.crew,'sim_driver_a')
        link = gate.network(f.db,dict(executor_id=f.supplier['id'],crew_id=self.crew['id'],
            vehicle_id=self.vehicle['id'],driver='sim_driver_a',plate='SIM-CORRECT-PLATE',warehouse_id=self.wh['id'],
            zip=o['zip'],model=o['model'],level=o['level'],product='T2',valid_until=DAY,insurance_until=DAY,
            evidence='SIM named executor roster'),user('procurement'))
        g = gate.invite(f.db,o,dict(leg=1,link_id=link['id'],evidence='SIM nomination'),user('procurement'))
        gate.handle(f.db,'POST','/api/gate/'+o['id']+'/accept',dict(version=o['version'],grant_version=g['version'],
            evidence='SIM actual executor accepted'),user('procurement'))
        body = dict(action='dispatch',version=o['version'],driver='sim_driver_a',carrier=f.supplier['name'],
            approved_cost=400,dispatch_ref='SIM-F04',route_id=r['id'],route_version=r['version'],
            checks={k:'SIM-'+k for k in core.CHECKS})
        # This is an actual saved wrong-executor route; F04 must reject it,
        # rather than checking only a misspelled extra warehouse form field.
        wrong = copy.deepcopy(r)
        wrong.pop('id');wrong.pop('version')
        wrong['executor_id'] = 'SIM-UNCOMMISSIONED-EXECUTOR'
        bad = operations.save_route(f.db,wrong,user('dispatch'))['route']
        self.assertTrue(bad['check_result']['issues'])
        with self.assertRaises(core.ApiError):
            core.apply_action(f.db,o['id'],dict(body,route_id=bad['id'],route_version=bad['version']),user('dispatch'))
        self.assertEqual(core.get_order(f.db,o['id'],user('dispatch'))['status'],'ready')
        core.apply_action(f.db,o['id'],body,user('dispatch'))
        o = core.get_order(f.db,o['id'],user('dispatch'))
        return o, dict(release_version=o['issue_version'],pickup_code=o['pickup_code'],sns=f.serials[o['id']],
            driver='sim_driver_a',plate='SIM-CORRECT-PLATE',crew_id=self.crew['id'],vehicle_id=self.vehicle['id'],
            evidence='SIM witnessed warehouse scan')

    def test_t33_wrong_executor_plate_serial_and_replaced_code_all_block_then_exact_identity_releases(self):
        f = self.f
        first, original = self.issue()
        for changed in ({'plate':'SIM-WRONG-PLATE'},{'sns':['SIM-WRONG-SERIAL']}):
            with self.assertRaises(core.ApiError):
                gate.verify(f.db,first,dict(original,**changed),user('warehouse'))
            self.assertEqual(f.db.execute('SELECT state FROM assets WHERE order_id=?',(first['id'],)).fetchone()[0],'reserved')
            self.assertEqual(gate.active(f.db,first['id'],1)['state'],'issued')
        issued = gate.active(f.db,first['id'],1)
        gate.handle(f.db,'POST','/api/gate/'+first['id']+'/revoke',dict(version=first['version'],
            grant_version=issued['version'],evidence='SIM revoke before actual loading'),user('procurement'))
        second, current = self.issue()
        self.assertNotEqual(current['pickup_code'],original['pickup_code'])
        with self.assertRaises(core.ApiError):
            gate.verify(f.db,second,dict(current,pickup_code=original['pickup_code']),user('warehouse'))
        with self.assertRaises(core.ApiError):
            gate.verify(f.db,second,dict(current,release_version=original['release_version']),user('warehouse'))
        self.assertEqual(f.db.execute('SELECT state FROM assets WHERE order_id=?',(first['id'],)).fetchone()[0],'reserved')
        gate.verify(f.db,second,current,user('warehouse'))
        self.assertEqual(core.get_order(f.db,first['id'],user('dispatch'))['status'],'in_transit')
        self.assertEqual(f.db.execute('SELECT state FROM assets WHERE order_id=?',(first['id'],)).fetchone()[0],'transit')


if __name__ == '__main__':
    unittest.main()
