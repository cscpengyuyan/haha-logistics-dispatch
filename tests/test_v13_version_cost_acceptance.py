"""T17/T23/T25 business-boundary acceptance on isolated synthetic records.

The SIM200 snapshot contains synthetic contracts, stock and coordinates. Road
provider IO is a deterministic adapter fixture; real compute, persistence,
version checks, pricing and adoption execute unchanged. This is not a live-road
or a complete 200-order optimization acceptance test.
"""
import copy
import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
import core
import folder
import operations
import planning
import review
import road_service
import test_handoff_branches

ADMIN = {"username": "admin", "role": "admin"}


class C1CommissionAcceptance(unittest.TestCase):
    def test_t17_remove_only_second_leg_blocks_first_release_and_recommission_restores_it(self):
        # Reuse the normal receipt/reservation/capability setup, not a mocked
        # release implementation. Do not inherit its unrelated test methods.
        h = test_handoff_branches.HandoffBranches()
        h.setUp()
        self.addCleanup(h.doCleanups)
        h.create("C1")
        h.delegate()
        principal = h.principal["id"]
        h.qualify(h.wh, "L1", "T2", "75201")
        h.qualify(h.station, "receive", "T3", "07102")
        h.qualify(h.station, "L1", "T2", "75201")
        quote = operations.save_resource(h.db, dict(type="quote", name="SIM C1 whole chain",
            carrier=h.principal["name"], path="C1", order_id=h.o["id"], supplier_id=principal,
            executor_id=principal, scope="line haul, receiving and final delivery",
            comparison_ref="SIM-C1-SCOPE", valid_until="2036-11-01", evidence="SIM contract",
            accepted_ref="SIM signed", product="T2", amount=100,
            **dict(zip(operations.COSTS, [10, 30, 30, 30, 0]))), ADMIN)["resource"]
        h.o = operations.award_quote(h.db, dict(id=quote["id"], quote_version=quote["version"],
            version=h.o["version"], approval_ref="SIM approved"), ADMIN)["order"]
        onward = dict(station_id=h.station, supplier_id=principal, executor_id=principal,
            product="T2", carrier=h.principal["name"], valid_until="2036-11-01",
            quote_ref="SIM onward quote", approved_ref="SIM onward approved",
            acceptance_ref="SIM onward accepted", amount=30, station_supplier_id=principal,
            station_executor_id=principal, station_acceptance_ref="SIM receiving accepted")
        h.o = folder.second_leg(h.db, h.o, onward, ADMIN)
        h.db.commit()
        complete = core.get_order(h.db, h.o["id"], ADMIN)
        core.assert_commission(h.db, dict(complete, carrier=h.principal["name"], approved_cost=100))

        # Deliberately remove exactly one persisted field to isolate this gate;
        # this fault injection is not a supported production editing workflow.
        stored = json.loads(h.db.execute("SELECT data FROM orders WHERE id=?", (h.o["id"],)).fetchone()[0])
        self.assertIn("second_leg", stored)
        stored.pop("second_leg")
        h.db.execute("UPDATE orders SET data=? WHERE id=?", (core.encode(stored), h.o["id"]))
        h.db.commit()
        before = core.get_order(h.db, h.o["id"], ADMIN)
        self.assertEqual(before, {k: v for k, v in complete.items() if k != "second_leg"})
        tables = ("orders", "events", "assets", "sn_locks", "gate_grants")
        baseline = {t: [tuple(r) for r in h.db.execute("SELECT * FROM " + t + " ORDER BY rowid")] for t in tables}
        with self.assertRaisesRegex(core.ApiError, "缺少本票二程书面委托") as failure:
            h.dispatch(handoff_ref="SIM handoff", all_legs_contract="SIM combined contract")
        self.assertEqual(failure.exception.status, 409)
        for table in tables:
            self.assertEqual([tuple(r) for r in h.db.execute("SELECT * FROM " + table + " ORDER BY rowid")], baseline[table], table)

        h.o = folder.second_leg(h.db, core.get_order(h.db, h.o["id"], ADMIN), onward, ADMIN)
        h.db.commit()
        h.dispatch(handoff_ref="SIM handoff", all_legs_contract="SIM combined contract")
        self.assertEqual(h.o["status"], "dispatched")
        self.assertEqual(h.o["second_leg"]["state"], "accepted")
        self.assertEqual(h.o["chain_contract"]["principal"], principal)
        self.assertEqual(h.o["station_mandate"], complete["station_mandate"])
        self.assertEqual(h.o["selected_quote"], complete["selected_quote"])


class CostAndVersionAcceptance(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        # Open read-only, then back up to RAM: tests never mutate the published
        # snapshot or share mutable state with another test/worker.
        source = sqlite3.connect((ROOT / "v13/data/sim200-ready.sqlite3").as_uri() + "?mode=ro", uri=True)
        try:
            source.backup(self.db)
        finally:
            source.close()
        self.db.execute("PRAGMA foreign_keys=ON")
        self.oid = "SIM200-053"
        self.provider_calls = []
        self.enterContext(patch.dict(os.environ, HH_VALHALLA_URL="http://127.0.0.1:1", HH_VROOM_URL="http://127.0.0.1:1"))
        self.enterContext(patch.object(road_service, "MATRIX_CACHE", {}))
        self.enterContext(patch.object(road_service, "post", side_effect=self.provider))

    def provider(self, service, path, payload):
        self.provider_calls.append(path)
        if path == "/sources_to_targets":
            n = len(payload["sources"])
            return {"sources_to_targets": [[{"time": abs(i-j)*60} for j in range(n)] for i in range(n)]}
        if path == "/":
            return {"code": 0, "routes": [{"steps": [{"type": "job", "id": job["id"]} for job in payload["jobs"]]}], "unassigned": []}
        self.assertEqual(path, "/route")
        points = [[p["lon"], p["lat"]] for p in payload["locations"]]
        return {"code": "Ok", "routes": [{"geometry": {"type": "LineString", "coordinates": points},
                "legs": [{"distance": 500, "duration": 60} for _ in points[1:]]}]}

    def order(self):
        return core.get_order(self.db, self.oid, ADMIN)

    def optimize(self, **fields):
        return operations.handle(self.db, "POST", "/api/ops/plans/optimize",
            dict(order_ids=[self.oid], budget_seconds=2, **fields), ADMIN)["plan"]

    def real_road_plan(self):
        generated = self.optimize()
        self.assertEqual(generated["validation_status"], "passed", generated["unassigned"])
        route = {k: copy.deepcopy(v) for k, v in generated["routes"][0].items() if k not in {"id", "version"}}
        road = road_service.compute(self.db, route, ADMIN)["road"]
        self.db.commit()
        route.update(road_basis="valhalla_truck", road_id=road["id"])
        saved = operations.handle(self.db, "POST", "/api/ops/routes", route, ADMIN)["route"]
        self.db.commit()
        self.assertEqual(saved["check_result"]["issues"], [])
        plan = self.optimize(route_candidates=[saved])
        self.assertEqual(plan["validation_status"], "passed", plan["unassigned"])
        self.assertEqual(plan["total_minor"], 40000)
        self.db.commit()
        return route, road, plan

    def assert_plan_and_cost_stale(self, route, plan):
        with self.assertRaisesRegex(core.ApiError, "STALE_INPUT"):
            planning.save_result(self.db, plan, ADMIN)
        with self.assertRaisesRegex(core.ApiError, "STALE_INPUT") as failure:
            operations.handle(self.db, "POST", "/api/ops/plans/" + plan["id"] + "/adopt",
                dict(version=plan["version"], candidate_id=plan["candidates"][0]["id"], idempotency_key="SIM-OLD-PLAN"), ADMIN)
        self.assertEqual(failure.exception.status, 409)
        items, issues = planning.route_cost(self.db, route, [self.order()])
        self.assertEqual(items, [])
        self.assertEqual([x["code"] for x in issues], ["COST_INCOMPLETE"])
        self.assertEqual(planning.plan_get(self.db, plan["id"])["version"], plan["version"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM dispatch_idempotency WHERE key='SIM-OLD-PLAN'").fetchone()[0], 0)

    def edit_reserved_order(self, **changes):
        old = self.order()
        sns = old["sn"]
        order = core.apply_action(self.db, self.oid, dict(action="unrelease", version=old["version"], reason="SIM approved correction"), ADMIN)
        order = core.edit_order(self.db, self.oid, dict(version=order["version"], **changes), ADMIN)
        order = core.apply_action(self.db, self.oid, dict(action="ready", version=order["version"], sn=sns, release_ref="SIM re-reserved"), ADMIN)
        self.db.commit()
        self.assertEqual(order["status"], "ready")
        self.assertEqual(order["sn"], sns)
        return order

    def assert_old_road_rejected(self, route, order):
        with self.assertRaisesRegex(core.ApiError, "订单版本已变更"):
            operations.handle(self.db, "POST", "/api/ops/routes", route, ADMIN)
        # Replacing only the visible order version cannot launder a stale
        # server road receipt into a route calculated for the new input.
        with self.assertRaisesRegex(core.ApiError, "请重算"):
            operations.handle(self.db, "POST", "/api/ops/routes", dict(route, order_versions={self.oid: order["version"]}), ADMIN)

    def test_t23_cheaper_base_quote_missing_l4_line_is_excluded_and_cannot_win(self):
        self.oid = "SIM200-109"
        order = self.order()
        self.assertTrue(order["addon_l4"])
        full = planning.current_quote(self.db, order)
        cheap_body = {k: v for k, v in full.items() if k not in {"id", "version", "special_cost"}}
        cheap_body.update(type="quote", name="SIM low base, L4 price not returned", amount=1,
                          origin_cost=0, station_cost=0, delivery_cost=1, other_cost=0)
        cheap = operations.handle(self.db, "POST", "/api/ops/resources", cheap_body, ADMIN)["resource"]
        self.assertLess(cheap["amount"], full["amount"])
        self.assertNotIn("special_cost", cheap)
        self.assertEqual(cheap["pricing_status"], "incomplete")
        comparison = review.comparison(self.db, self.oid, ADMIN)
        excluded = next(q for q in comparison["quotes"] if q["id"] == cheap["id"])
        self.assertIn("五行费用", excluded["excluded"])
        self.assertIsNone(excluded["difference"])
        with self.assertRaisesRegex(core.ApiError, "五行费用"):
            operations.award_quote(self.db, dict(id=cheap["id"], quote_version=cheap["version"],
                version=order["version"], approval_ref="SIM attempted low award"), ADMIN)
        self.assertEqual(self.order()["selected_quote"], order["selected_quote"])
        plan = self.optimize()
        self.assertEqual(plan["validation_status"], "passed")
        self.assertEqual(plan["coverage"]["order_complete"], 1)
        self.assertEqual(plan["total_minor"], 40000)
        self.assertEqual({i["source"] for i in plan["cost_items"]}, {full["id"]})
        # Completing the omitted L4 amount is a real admissibility change.
        complete = operations.save_resource(self.db, dict(cheap, type="quote", special_cost=500, amount=501), ADMIN)["resource"]
        order = operations.award_quote(self.db, dict(id=complete["id"], quote_version=complete["version"],
            version=order["version"], approval_ref="SIM full-scope approved"), ADMIN)["order"]
        items, errors = planning.route_cost(self.db, {}, [order])
        self.assertEqual(errors, [])
        self.assertEqual(sum(i["amount_minor"] for i in items), 50100)

    def test_t25_order_window_change_invalidates_plan_cost_and_old_road_receipt(self):
        route, road, plan = self.real_road_plan()
        order = self.edit_reserved_order(window_start="2026-11-11T10:00")
        self.assertNotIn("selected_quote", order)
        self.assert_plan_and_cost_stale(route, plan)
        self.assert_old_road_rejected(route, order)

    def test_t25_package_revision_invalidates_plan_cost_and_old_road_receipt(self):
        route, road, plan = self.real_road_plan()
        order = self.edit_reserved_order(pack_version="SIM-M01-PALLET-v2")
        self.assertEqual(order["pack_version"], "SIM-M01-PALLET-v2")
        self.assertNotIn("selected_quote", order)
        self.assert_plan_and_cost_stale(route, plan)
        self.assert_old_road_rejected(route, order)

    def test_t25_price_revision_blocks_old_plan_and_cost_but_reuses_unchanged_road_matrix(self):
        route, road, plan = self.real_road_plan()
        old = self.order()
        quote = planning.current_quote(self.db, old)
        updated = operations.save_resource(self.db, dict(quote, type="quote",
            delivery_cost=quote["delivery_cost"] + 25, amount=quote["amount"] + 25), ADMIN)["resource"]
        self.db.commit()
        self.assertEqual(self.order(), old)  # Isolate a quote-only edit.
        self.assertEqual(updated["version"], quote["version"] + 1)
        self.assert_plan_and_cost_stale(route, plan)
        # Price-only corrections do not change road geometry. Reusing a road
        # receipt does not make its stale selected price valid or release cargo.
        reused = operations.save_route(self.db, route, ADMIN)["route"]
        self.assertEqual(reused["road"]["id"], road["id"])
        invalid = self.optimize(route_candidates=[reused])
        self.assertEqual(invalid["coverage"]["assigned"], 0)
        self.assertIsNone(invalid["total_minor"])
        self.assertIn("COST_INCOMPLETE", [i["code"] for i in invalid["precheck"]["issues"]])

        accepted = operations.award_quote(self.db, dict(id=updated["id"], quote_version=updated["version"],
            version=old["version"], approval_ref="SIM revised price approved"), ADMIN)["order"]
        refreshed = dict(route, order_versions={self.oid: accepted["version"]})
        new_road = road_service.compute(self.db, refreshed, ADMIN)["road"]
        self.db.commit()
        self.assertTrue(new_road["matrix_cache_hit"])
        self.assertEqual(new_road["geometry"], road["geometry"])
        refreshed.update(road_id=new_road["id"])
        saved = operations.save_route(self.db, refreshed, ADMIN)["route"]
        self.db.commit()
        revised_plan = self.optimize(route_candidates=[saved])
        self.assertEqual(revised_plan["validation_status"], "passed", revised_plan["unassigned"])
        self.assertEqual(revised_plan["total_minor"], 42500)
        self.assertEqual(revised_plan["cost_items"][0]["source_version"], updated["version"])
        self.assertEqual(self.provider_calls.count("/sources_to_targets"), 1)


if __name__ == "__main__":
    unittest.main()
