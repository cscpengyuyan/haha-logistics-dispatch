"""Acceptance contract for deterministic inputs, real intake and resume isolation."""
import base64
import sqlite3
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'v13'/'engine'))
import core, operations, simulation, sales

class Sim200Tests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        core.core_schema(self.db);operations.init_db(self.db)
        self.db.execute("INSERT INTO metadata VALUES('mode','demo')")
        self.addCleanup(self.db.close)

    def test_all_cross_distributions_and_serial_conservation(self):
        rows=simulation.generate();result=simulation.validate(rows)
        self.assertEqual(result['first_delivery_units'],252)
        serials=[s for r in rows for s in r['coverage']['serials']]
        self.assertEqual(len(serials),len(set(serials)))
        self.assertEqual(sum(r['coverage']['aftercare'] for r in rows),20)
        self.assertEqual(simulation.sales_csv(rows),simulation.sales_csv(simulation.generate()))

    def test_real_sales_import_idempotent_and_dispatch_handoff(self):
        with self.db:first=simulation.import_orders(self.db,simulation.actor('sales'))
        with self.db:second=simulation.import_orders(self.db,simulation.actor('sales'))
        self.assertEqual((first['added'],second['added'],second['changed']),(200,0,0))
        self.assertEqual(self.db.execute('SELECT count(*) FROM orders').fetchone()[0],200)
        self.assertEqual(self.db.execute('SELECT count(*) FROM sales_history').fetchone()[0],200)
        with self.db:result=simulation.prepare_orders(self.db,simulation.actor('dispatch'))
        self.assertEqual(result['prepared'],200)
        self.assertEqual(simulation.prepare_orders(self.db,simulation.actor('dispatch'))['prepared'],0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM orders WHERE status='new'").fetchone()[0],200)

    def test_production_and_wrong_role_cannot_import(self):
        with self.assertRaises(core.ApiError):simulation.import_orders(self.db,simulation.actor('warehouse'))
        self.db.execute("UPDATE metadata SET value='production' WHERE key='mode'")
        with self.assertRaises(core.ApiError):simulation.import_orders(self.db,simulation.actor('sales'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM orders').fetchone()[0],0)

    def test_bad_row_reports_source_line_and_cannot_mutate(self):
        rows=simulation.generate();rows[23]['order']['quantity']=0
        body=dict(filename='SIM200_bad.csv',base64=base64.b64encode(simulation.sales_csv(rows)).decode())
        report,_,_=sales.preview(self.db,body,simulation.actor('sales'))
        self.assertTrue(report['errors'])
        with self.assertRaises(core.ApiError):sales.confirm(self.db,dict(body,token=report['token']),simulation.actor('sales'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM orders').fetchone()[0],0)

    def test_fixed_create_id_rejects_conflicting_retry(self):
        simulation.provision(self.db)
        body=dict(simulation.generate()[0]['order']);body['simulation_id']=body.pop('id')
        first=core.create_order(self.db,body,simulation.actor('sales'))
        second=core.create_order(self.db,body,simulation.actor('sales'))
        self.assertEqual(first['id'],second['id'])
        with self.assertRaises(core.ApiError):core.create_order(self.db,dict(body,quantity=2),simulation.actor('sales'))

if __name__=='__main__':unittest.main()
