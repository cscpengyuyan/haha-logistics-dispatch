"""T29: real F04 rollback, authoritative idempotency and concurrent HTTP replay."""
import concurrent.futures
import copy
import json
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
import batch_release
import core
import gate
import operations
import planning
from test_routing import Scenario, ADMIN

PATH = batch_release.PATH


class AtomicF04(unittest.TestCase):
    def setUp(self):
        self.s = Scenario()
        self.addCleanup(self.s.close)
        batch_release.schema(self.s.db)
        self.dispatch = dict(username="dispatch", role="dispatch")

    def item(self, index, route_index):
        o, r = self.s.orders[index], self.s.routes[route_index]
        return dict(order_id=o["id"], action="dispatch", version=o["version"],
                    driver=r["checks"]["driver"], carrier="SIM Fleet", approved_cost=0,
                    dispatch_ref="SIM-BATCH-F04-" + str(index), route_id=r["id"], route_version=r["version"],
                    checks={k: "SIM-F04-" + str(index) + "-" + k for k in core.CHECKS})

    def snapshot(self):
        tables = [r[0] for r in self.s.db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        # HTTP sessions and request journal are transport bookkeeping, not F04
        # effects. Everything else must be byte-for-byte identical after failure.
        return {t: [tuple(r) for r in self.s.db.execute('SELECT * FROM "' + t + '" ORDER BY rowid')]
                for t in tables if t not in {"sessions", "request_journal"}}

    def assert_failed_after_first_write(self, body, expected):
        db, baseline, statements = self.s.db, self.snapshot(), []
        db.execute("BEGIN IMMEDIATE")
        db.set_trace_callback(statements.append)
        try:
            with self.assertRaisesRegex(core.ApiError, expected):
                operations.handle(db, "POST", PATH, body, self.dispatch)
        finally:
            db.set_trace_callback(None)
        # Deliberately commit after catching the error: the handler's savepoint
        # must already have removed the first successful dispatch and gate issue.
        self.assertTrue(db.in_transaction)
        db.commit()
        self.assertTrue(any("UPDATE orders SET" in sql and body["items"][0]["order_id"] in sql for sql in statements))
        self.assertTrue(any("INSERT INTO route_bookings" in sql for sql in statements))
        self.assertTrue(any("INSERT INTO gate_log" in sql for sql in statements))
        self.assertEqual(self.snapshot(), baseline)

    def test_second_missing_real_check_rolls_back_first_order_booking_gate_and_events(self):
        body = dict(idempotency_key="SIM-MISSING-PAPERS", items=[self.item(0, 0), self.item(4, 3)])
        body["items"][1]["checks"].pop("papers")
        self.assert_failed_after_first_write(body, "全部回滚.*papers")
        # Failure does not consume the key. A corrected request can safely use it.
        body["items"][1]["checks"]["papers"] = "SIM-PAPERS-CONFIRMED"
        result = operations.handle(self.s.db, "POST", PATH, body, self.dispatch)
        self.assertEqual(result["batch"]["count"], 2)
        self.assertTrue(all(o["status"] == "dispatched" for o in result["orders"]))
        self.assertEqual(operations.handle(self.s.db, "POST", PATH, body, self.dispatch), result)

    def test_second_conflicting_vehicle_and_crew_rolls_back_first_issue_completely(self):
        # Both individual drafts were feasible. Their actual simultaneous use
        # conflicts only after the first F04 reserves the shared physical assets.
        self.assertEqual(self.s.routes[0]["check_result"]["issues"], [])
        self.assertEqual(self.s.routes[1]["check_result"]["issues"], [])
        body = dict(idempotency_key="SIM-RESOURCE-CONFLICT", items=[self.item(0, 0), self.item(1, 1)])
        self.assert_failed_after_first_write(body, "全部回滚.*占用")

    def test_concurrent_http_retry_issues_same_route_two_tickets_once_and_rejects_changed_payload(self):
        body = dict(idempotency_key="SIM-CONCURRENT-REPLAY", items=[self.item(2, 2), self.item(3, 2)])
        clients = [self.s.login("dispatch"), self.s.login("dispatch")]
        barrier = threading.Barrier(2)
        def submit(client):
            barrier.wait()
            return self.s.request(client, PATH, body)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            outputs = list(pool.map(submit, clients))
        self.assertEqual([status for status, _ in outputs], [200, 200], outputs)
        self.assertEqual(outputs[0][1], outputs[1][1])
        result = outputs[0][1]
        self.assertEqual(result["batch"]["state"], "issued")
        ids = [item["order_id"] for item in body["items"]]
        for oid in ids:
            order = core.get_order(self.s.db, oid, self.dispatch)
            original = next(o for o in self.s.orders if o["id"] == oid)
            self.assertEqual(order["version"], original["version"] + 1)
            self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM events WHERE order_id=? AND action='dispatch'", (oid,)).fetchone()[0], 1)
            self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM gate_log WHERE oid=? AND action='issue'", (oid,)).fetchone()[0], 1)
            self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM route_bookings WHERE oid=? AND cancelled=''", (oid,)).fetchone()[0], 1)
            self.assertEqual(gate.active(self.s.db, oid, 1)["state"], "issued")
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM dispatch_release_batches").fetchone()[0], 1)
        recorded = json.loads(self.s.db.execute("SELECT request FROM dispatch_release_batches").fetchone()[0])
        self.assertEqual(recorded, body)
        before = self.snapshot()
        changed = copy.deepcopy(body)
        changed["items"][0]["dispatch_ref"] = "SIM-OTHER-REFERENCE"
        code, error = self.s.request(clients[0], PATH, changed)
        self.assertEqual(code, 409)
        self.assertIn("IDEMPOTENCY_CONFLICT", error["error"])
        self.assertEqual(self.snapshot(), before)
        # Another actor cannot obtain the first actor's cached issue receipt.
        with self.assertRaises(core.ApiError):
            batch_release.release(self.s.db, body, ADMIN)
        self.assertEqual(self.snapshot(), before)

    def test_role_unknown_empty_duplicate_and_action_guards_do_not_mutate(self):
        body = dict(idempotency_key="SIM-GUARDS", items=[self.item(0, 0)])
        baseline = self.snapshot()
        for role in ("sales", "warehouse", "driver", "finance", "procurement"):
            with self.subTest(role=role), self.assertRaises(core.ApiError) as caught:
                operations.handle(self.s.db, "POST", PATH, body, dict(username=role, role=role))
            self.assertEqual(caught.exception.status, 403)
        bad = [dict(body, items=[]), dict(body, items=[body["items"][0]] * 2),
               dict(body, items=[body["items"][0]] * 201), dict(body, items=[None]),
               dict(body, force=True), dict(body, idempotency_key=""),
               dict(body, items=[dict(self.item(0, 0), order_id="")]),
               dict(body, items=[dict(self.item(0, 0), order_id="UNKNOWN-ORDER")]),
               dict(body, items=[dict(self.item(0, 0), action="depart")]),
               dict(body, items=[dict(self.item(0, 0), version=True)]),
               dict(body, items=[dict(self.item(0, 0), skip_checks=True)]),
               dict(body, items=[dict(self.item(0, 0), checks={**self.item(0, 0)["checks"], "force": "YES"})]),
               dict(body, plan_id="PLAN-UNKNOWN")]
        for candidate in bad:
            with self.subTest(body=candidate), self.assertRaises(core.ApiError):
                operations.handle(self.s.db, "POST", PATH, candidate, self.dispatch)
            self.assertEqual(self.snapshot(), baseline)
        for method, url in (("GET", PATH), ("POST", PATH + "/anything")):
            with self.assertRaises(core.ApiError):
                operations.handle(self.s.db, method, url, body, self.dispatch)
        self.assertEqual(self.snapshot(), baseline)

    def test_outer_caller_can_roll_back_successful_batch_and_its_receipt(self):
        baseline = self.snapshot()
        self.s.db.execute("BEGIN IMMEDIATE")
        result = batch_release.release(self.s.db, dict(idempotency_key="SIM-OUTER-ROLLBACK", items=[self.item(0, 0)]), self.dispatch)
        self.assertEqual(result["orders"][0]["status"], "dispatched")
        self.assertTrue(self.s.db.in_transaction)
        self.s.db.rollback()
        self.assertEqual(self.snapshot(), baseline)

    def test_linked_plan_requires_adopted_current_exact_order_and_actual_route_set(self):
        db = self.s.db
        routes = [copy.deepcopy(self.s.routes[0]), copy.deepcopy(self.s.routes[3])]
        ids = [r["order_ids"][0] for r in routes]
        plan = dict(id="PLAN-SIM-F04", plan_id="PLAN-SIM-F04", version=1, state="candidates_ready",
                    order_ids=ids, input_hash=planning.snapshot(db, ids, ADMIN)[1], validation_status="passed",
                    candidates=[dict(id="C1", validation_status="passed", unassigned=[], routes=routes)])
        planning.plan_save(db, plan)
        body = dict(idempotency_key="SIM-PLAN-F04", items=[self.item(0, 0), self.item(4, 3)], plan_id=plan["id"], plan_version=1)
        with self.assertRaisesRegex(core.ApiError, "已采用"):
            batch_release.release(db, body, self.dispatch)
        adopted = planning.adopt(db, plan["id"], dict(version=1, candidate_id="C1", idempotency_key="SIM-ADOPT-F04"), ADMIN)
        with self.assertRaisesRegex(core.ApiError, "版本已变"):
            batch_release.release(db, body, self.dispatch)
        body["plan_version"] = adopted["plan"]["version"]
        with self.assertRaisesRegex(core.ApiError, "实际采用"):
            batch_release.release(db, body, self.dispatch)
        for item, route in zip(body["items"], adopted["routes"]):
            item.update(route_id=route["id"], route_version=route["version"])
        with self.assertRaisesRegex(core.ApiError, "集合"):
            batch_release.release(db, dict(body, items=body["items"][:1]), self.dispatch)
        result = batch_release.release(db, body, self.dispatch)
        self.assertEqual(result["batch"]["plan_version"], 2)
        self.assertEqual(result["batch"]["plan_id"], plan["id"])
        self.assertTrue(all(o["status"] == "dispatched" for o in result["orders"]))


if __name__ == "__main__":
    unittest.main()
