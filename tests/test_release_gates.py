"""Regression tests for the three release gates. Synthetic fixtures only."""
import base64
import json
import sqlite3
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'v13' / 'engine'))
import core
import demo_seed
import folder
import operations
import review

ADMIN = {'role':'admin', 'username':'admin'}
def fresh():
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    core.core_schema(db)
    operations.init_db(db)
    with db:
        demo_seed.seed(db)
    return db

class ReleaseGates(unittest.TestCase):
    def setUp(self):
        self.db = fresh()
        self.addCleanup(self.db.close)
        self.order = next(o for o in core.list_orders(self.db, ADMIN)
                          if o['status']=='ready' and o['city']=='Dallas' and o['quantity']==2)

    def act(self, action, **body):
        with self.db:
            return core.apply_action(self.db, self.order['id'], dict(body, action=action,
                                     version=self.order['version']), ADMIN)

    def test_budget_alone_cannot_dispatch(self):
        o=self.order
        with self.assertRaisesRegex(core.ApiError,'中选|委托'):
            self.act('dispatch', driver='driver', carrier='TEST', dispatch_ref='TEST-ISSUE', approved_cost=500,
                     checks={k:'TEST-CHECK-'+k for k in core.CHECKS})

    def test_pod_alone_cannot_deliver_two_units(self):
        o=self.order
        self.db.execute("UPDATE orders SET status='in_transit' WHERE id=?", (o['id'],))
        self.db.execute("UPDATE assets SET state='transit' WHERE order_id=?", (o['id'],))
        pod = core.add_file(self.db, o['id'], dict(version=o['version'], category='pod',name='test.pdf',
                            base64=base64.b64encode(b'%PDF-1.4 synthetic test').decode()), ADMIN)
        self.order=pod['order']
        with self.assertRaisesRegex(core.ApiError,'逐台|SN'):
            self.act('deliver', signer='Fixture', delivered_at=o['window_start'], delivery_note='One file only')

    def test_alternate_cannot_be_locked_as_current(self):
        qs=folder.get_folder(self.db,self.order,ADMIN)['quotes']
        base=next(q for q in qs if q['path']=='B')
        alt=next(q for q in qs if q['path']!='B')
        with self.assertRaisesRegex(core.ApiError,'现行|基线'):
            review.lock_baseline(self.db,dict(order_id=self.order['id'], order_version=self.order['version'],
                main_id=alt['id'], main_version=alt['version'], alt_id=base['id'], alt_version=base['version'],
                confirmation='TEST-REVERSED',baseline_version=0),ADMIN)
