"""Procurement price-card boundary: actual stops, exact minima and shared fees."""
import copy
import unittest

from test_routing import Scenario, ADMIN, DAY
import operations
import planning
import planning_solver
import routing


class PriceCardAcceptance(unittest.TestCase):
    def setUp(self):
        self.s = Scenario()
        self.addCleanup(self.s.close)
        self.db = self.s.db
        self.vehicle = self.s.routes[0]['resource_id']
        self.orders = self.s.orders
        self.card = dict(supplier_id='SIM-TX', valid_from=DAY, valid_until=DAY,
            currency='USD', replaces_full_price=True,
            order_versions={o['id']: o['version'] for o in self.orders},
            base_minor=1000, minimum_minor=12001, per_order_minor=100,
            per_unit_minor=200, per_stop_minor=500, day_minor=7000,
            includes=['liftgate', 'delivery', 'handling'],
            scope='SIM signed complete price including liftgate; no duplicate quote additions')
        self.save_card()
        planning.save_profile(self.db, 'resource', dict(id=self.vehicle,
            evidence='SIM confirmed vehicle price card', data={'rate_card_id':'SIM-CARD'}), ADMIN)

    def save_card(self, version=None):
        body = dict(id='SIM-CARD', evidence='SIM procurement price agreement', data=self.card)
        if version is not None:
            body['version'] = version
        return planning.save_profile(self.db, 'rate_card', body,
            {'username':'procurement', 'role':'procurement'})

    def priced(self, source, orders):
        route = copy.deepcopy(source)
        route['check_result'] = routing.check_route(self.db, route, orders)
        self.assertEqual(route['check_result']['issues'], [])
        # A complete signed contract replaces the old all-in quote. Explicit
        # old liftgate cost must not be added again after replacement.
        items, errors, activations, pools = planning.rate_cost(self.db, route, orders,
            [dict(event='quote_liftgate', amount_minor=9999, currency='USD')], [])
        self.assertEqual(errors, [])
        self.assertEqual({i['event'] for i in items}, {'contract_route_allocation'})
        self.assertEqual({i['source'] for i in items}, {'SIM-CARD'})
        route.update(order_ids=[o['id'] for o in orders], cost_items=items,
            total_minor=sum(i['amount_minor'] for i in items), activations=activations,
            pools=pools, occupancy=[], sns=[r[0] for o in orders for r in self.db.execute(
                'SELECT sn FROM assets WHERE order_id=?',(o['id'],))], finish=1)
        return route

    def test_t22_same_confirmed_stop_minimum_and_liftgate_inclusion_conserve_cents(self):
        raw = copy.deepcopy(self.s.routes[2])
        a, b = self.orders[2:4]
        raw['stops'][b['id']].update(merge_after=a['id'], merge_ref='SIM same dock agreement')
        merged = self.priced(raw, [a, b])
        self.assertEqual(merged['check_result']['stop_count'], 1)
        self.assertEqual(merged['total_minor'], 12001)
        self.assertEqual(sorted(i['amount_minor'] for i in merged['cost_items']), [6000,6001])
        self.assertEqual(planning_solver.cost([merged]), 19001)
        # With the contractual minimum removed, the actual confirmed stop count
        # affects the price, not just the UI label.
        self.card['minimum_minor'] = 0
        self.save_card(1)
        one = self.priced(raw, [a,b])
        separate = self.priced(self.s.routes[2], [a,b])
        self.assertEqual(one['total_minor'], 2100)
        self.assertEqual(separate['total_minor'], 2600)
        self.assertEqual(sum(i['amount_minor'] for i in one['cost_items']), 2100)

    def test_t22_day_charge_changes_winning_complete_combination_once(self):
        a = self.priced(self.s.routes[0], [self.orders[0]])
        b = self.priced(self.s.routes[3], [self.orders[4]])
        ids = a['order_ids'] + b['order_ids']
        # 12,001 + 12,001 + one 7,000 daily event = 31,002. Charging
        # the day event twice would wrongly select the 35,000 alternative.
        alternative = dict(order_ids=ids, total_minor=35000, activations={},
            occupancy=[], sns=a['sns']+b['sns'], finish=1)
        for native in (False, True):
            result = planning_solver.choose(ids, [a,b,alternative], 3, native=native)
            self.assertEqual(set(result['indices']), {0,1}, result)
            self.assertEqual(planning_solver.cost([a,b]), 31002)


if __name__ == '__main__':
    unittest.main()
