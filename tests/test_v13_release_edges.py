"""Release-edge evidence: real route validation/adoption and durable worker fencing.

All orders and road durations are synthetic. The worker race controls scheduling
with events but executes the real optimizer, SQLite claim and publication code.
"""
import copy
import json
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
import core
import dispatch_jobs
import operations
import planning
import routing
from test_routing import Scenario, ADMIN, DAY


class RouteReleaseEdges(unittest.TestCase):
    def setUp(self):
        self.s = Scenario()
        self.addCleanup(self.s.close)

    def test_t29_second_route_failure_rolls_back_real_first_route_and_retry_is_idempotent(self):
        db = self.s.db
        routes = [copy.deepcopy(self.s.routes[0]), copy.deepcopy(self.s.routes[3])]
        self.assertTrue(all(not r["check_result"]["issues"] for r in routes))
        ids = [oid for r in routes for oid in r["order_ids"]]
        plan = dict(id="PLAN-SIM-ATOMIC", plan_id="PLAN-SIM-ATOMIC", version=1,
                    state="candidates_ready", order_ids=ids, input_hash=planning.snapshot(db, ids, ADMIN)[1],
                    candidates=[dict(id="candidate-1", validation_status="passed", unassigned=[], routes=routes)])
        # Previously feasible candidate now fails its mandatory adopt-time route
        # check. The first route is actually saved before the second is rejected.
        routes[1]["stops"][ids[1]]["dock_ref"] = ""
        planning.plan_save(db, plan)
        tables = ("registry", "registry_log", "orders", "assets", "route_bookings", "dispatch_idempotency")
        baseline = {name: [tuple(r) for r in db.execute("SELECT * FROM " + name + " ORDER BY rowid")] for name in tables}
        body = dict(version=1, candidate_id="candidate-1", idempotency_key="SIM-ADOPT-ONCE")
        db.execute("BEGIN IMMEDIATE")
        with self.assertRaisesRegex(core.ApiError, "复核失败"):
            planning.adopt(db, plan["id"], body, ADMIN)
        # Savepoint is essential: even a caller catching the exception and
        # committing must not leave the already-written first route behind.
        db.commit()
        for name, rows in baseline.items():
            self.assertEqual([tuple(r) for r in db.execute("SELECT * FROM " + name + " ORDER BY rowid")], rows, name)
        self.assertEqual(planning.plan_get(db, plan["id"])["version"], 1)
        routes[1]["stops"][ids[1]]["dock_ref"] = "SIM-DOCK-RESTORED"
        planning.plan_save(db, plan)
        adopted = planning.adopt(db, plan["id"], body, ADMIN)
        repeated = planning.adopt(db, plan["id"], body, ADMIN)
        self.assertEqual(adopted, repeated)
        self.assertEqual(len(adopted["routes"]), 2)
        self.assertEqual(adopted["plan"]["version"], 2)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM registry WHERE type='route'").fetchone()[0], 6)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_idempotency").fetchone()[0], 1)
        # Adopting valid drafts does not falsely issue orders or reserve trucks.
        self.assertEqual([tuple(r) for r in db.execute("SELECT * FROM route_bookings ORDER BY rowid")], baseline["route_bookings"])
        self.assertEqual([tuple(r) for r in db.execute("SELECT * FROM orders ORDER BY rowid")], baseline["orders"])

    def test_t11_arrival_and_start_inside_window_but_finish_after_explicit_cutoff(self):
        order = copy.deepcopy(self.s.orders[0])
        order["window_end"] = DAY + "T09:30"
        route = copy.deepcopy(self.s.routes[0])
        route["start_time"] = "09:00"
        stop = route["stops"][order["id"]]
        stop.update(travel=20, admission=0, service=60, finish_by=DAY + "T09:30")
        checked = routing.check_route(self.s.db, route, [order])
        timing = checked["timeline"][0]
        cutoff = routing.local_utc(order["window_end"], order["timezone"]).isoformat()
        self.assertLessEqual(timing["arrival"], cutoff)
        self.assertLessEqual(timing["start"], cutoff)
        self.assertGreater(timing["departure"], cutoff)
        self.assertEqual(timing["late"], 0)
        self.assertEqual(checked["issues"], ["第 1 站 作业结束超过约定完工时刻或时刻无效"])
        stop["service"] = 10
        self.assertEqual(routing.check_route(self.s.db, route, [order])["issues"], [])

    def test_t05_weight_passes_while_door_height_and_floor_independently_fail(self):
        db, order = self.s.db, self.s.orders[0]
        route = copy.deepcopy(self.s.routes[0])
        stop = route["stops"][order["id"]]
        vehicle = routing.resource(db, "vehicle", route["resource_id"])
        self.assertLess(float(stop["kg"]) * order["quantity"], float(vehicle["payload_kg"]))
        stop["height"] = float(vehicle["door_cm"]) + 1
        issues = routing.check_route(db, route, [order])["issues"]
        self.assertEqual(issues, ["第 1 站 包装高度超过车辆净开口"])
        stop.update(height=193, length_cm=250, width_cm=100, lift_extra_kg=0)
        operations.save_resource(db, dict(vehicle, type="vehicle", floor_length_cm=200,
            floor_width_cm=220, door_width_cm=210), ADMIN)
        self.assertEqual(routing.check_route(db, route, [order])["issues"], [])
        load_errors, _ = planning.strict_load(db, route, [order])
        self.assertEqual([(e["code"], e["field"]) for e in load_errors], [("LOAD_CONFLICT", "floor_length_cm")])
        stop["length_cm"] = 150
        self.assertEqual(planning.strict_load(db, route, [order])[0], [])


class WorkerLeaseEdges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "jobs.sqlite"
        server.initialize(self.path, True)
        self.db = server.connect(self.path)
        self.user = dict(username="dispatch", role="dispatch")
        oid = self.db.execute("SELECT id FROM orders ORDER BY id LIMIT 1").fetchone()[0]
        self.job = dispatch_jobs.handle(self.db, "POST", "/api/ops/jobs", {"order_ids": [oid]}, self.user)["job"]
    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def _late_attempt(self, fail_old):
        calculated, resume = threading.Event(), threading.Event()
        original_optimize = planning.optimize
        result_ids, errors = {}, []
        def controlled(db, body, user, publish=True):
            result = original_optimize(db, body, user, publish=publish)
            old = threading.current_thread().name == "SIM-EXPIRED-WORKER"
            result_ids["old" if old else "new"] = result["plan"]["plan_id"]
            if old:
                calculated.set()
                if not resume.wait(8):
                    raise RuntimeError("test did not release old worker")
                if fail_old:
                    raise core.ApiError(500, "SIM old attempt failed after recovery")
            return result
        def old_worker():
            try:
                dispatch_jobs.run_one(server.connect, self.path, self.job["id"])
            except BaseException as exc:
                errors.append(exc)
        with patch.object(planning, "optimize", side_effect=controlled):
            worker = threading.Thread(target=old_worker, name="SIM-EXPIRED-WORKER")
            worker.start()
            try:
                self.assertTrue(calculated.wait(5), "old worker did not compute")
                first = dispatch_jobs.get(self.db, self.job["id"], self.user)
                self.assertEqual((first["state"], first["attempt"]), ("running", 1))
                old_lease = first["lease"]
                self.db.execute("UPDATE dispatch_jobs SET expires=? WHERE id=?", (time.time() - 1, self.job["id"]))
                # A real second worker claims the expired durable row and commits
                # its independently calculated plan before attempt 1 returns.
                dispatch_jobs.run_one(server.connect, self.path, self.job["id"])
                newer = dispatch_jobs.get(self.db, self.job["id"], self.user)
                self.assertEqual((newer["state"], newer["attempt"]), ("completed", 2))
                self.assertNotEqual(newer["lease"], old_lease)
                saved = dict(newer)
            finally:
                resume.set()
                worker.join(8)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        latest = dispatch_jobs.get(self.db, self.job["id"], self.user)
        self.assertEqual(dict(latest), saved)
        self.assertEqual(latest["plan_id"], result_ids["new"])
        self.assertNotEqual(result_ids["old"], result_ids["new"])
        self.assertFalse(self.db.execute("SELECT 1 FROM dispatch_plans WHERE id=?", (result_ids["old"],)).fetchone())
        self.assertTrue(self.db.execute("SELECT 1 FROM dispatch_plans WHERE id=?", (result_ids["new"],)).fetchone())
        self.assertIsNone(dispatch_jobs.view(latest)["error"])

    def test_t43_expired_worker_late_success_cannot_publish_over_new_lease(self):
        self._late_attempt(False)

    def test_t43_expired_worker_late_failure_cannot_poison_completed_recovery(self):
        self._late_attempt(True)


if __name__ == "__main__":
    unittest.main()
