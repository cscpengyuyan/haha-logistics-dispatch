"""T36: real SQLite legacy-shaped records, attachments, drafts and recovery.

The fixture is synthetic (not a customer database). Legacy rows are inserted as
raw historical JSON, then read/edited through the real V13 APIs after migration.
"""
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "v13" / "engine"))
import core
import migrations
import operations
import planning

ADMIN = dict(username="admin", role="admin")


def connect(path=":memory:"):
    db = sqlite3.connect(path, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    core.core_schema(db)
    operations.init_db(db)
    planning.init_db(db)
    db.execute("INSERT OR IGNORE INTO metadata VALUES('mode','demo')")
    return db


def old_order(db, oid="OLD-L4", level="L4", **extra):
    data = dict(customer="旧版演练客户", address="SIM public intersection", zip="75201",
                warehouse="SIM Dallas", model="M01", quantity=1, route="B", level=level,
                endpoint="原合同约定位置（不据此猜测层级）", owner="sales", notes="原始备注",
                created_at="2025-01-01T00:00:00+00:00", technical_receipt="SIM-HISTORIC-RECEIPT")
    data.update(extra)
    # Deliberately retain the original JSON formatting, not migration encoding.
    raw = json.dumps(data, ensure_ascii=False, indent=2)
    db.execute("INSERT INTO orders VALUES(?,7,'new',?)", (oid, raw))
    db.execute("INSERT INTO events(order_id,ts,actor,action,note) VALUES(?,?,?,?,?)",
               (oid, "2025-01-01T00:00:00Z", "sales", "legacy_import", "原值历史"))
    db.execute("INSERT INTO files(order_id,name,category,mime,ts,actor,content) VALUES(?,?,?,?,?,?,?)",
               (oid, "旧回执.bin", "pod", "application/octet-stream", "2025-01-01", "sales", b"\x00original-pod\xff"))
    db.execute("INSERT INTO sn_locks VALUES(?,?)", ("SN-" + oid, oid))
    return raw


def dump_rows(db, table):
    return [tuple(r) for r in db.execute("SELECT * FROM " + table + " ORDER BY rowid")]


class MigrationContracts(unittest.TestCase):
    def setUp(self):
        self.db = connect()
    def tearDown(self):
        self.db.close()

    def test_l4_l5_split_without_guessing_endpoint_and_preserve_history(self):
        raw = old_order(self.db)
        commission = dict(supplier_id="TECH-SIM", acceptance_ref="ORIGINAL-COMMISSION")
        old_order(self.db, "OLD-L5", "L5", addon_l4=True, technical_order=commission)
        files, locks, events = (dump_rows(self.db, t) for t in ("files", "sn_locks", "events"))
        result = migrations.migrate(self.db)
        self.assertEqual(result["orders"], 2)
        self.assertEqual(len(result["pending"]), 2)
        l4 = core.get_order(self.db, "OLD-L4", ADMIN)
        l5 = core.get_order(self.db, "OLD-L5", ADMIN)
        self.assertEqual(l4["level"], "")
        self.assertEqual(l4["endpoint"], "原合同约定位置（不据此猜测层级）")
        self.assertTrue(l4["addon_l4"])
        self.assertFalse(l4["addon_l5"])
        self.assertTrue(l5["addon_l4"] and l5["addon_l5"])
        self.assertEqual(l5["technical_order"], commission)
        self.assertEqual(l4["technical_receipt"], "SIM-HISTORIC-RECEIPT")
        self.assertEqual(l4["version"], 8)
        self.assertEqual(dump_rows(self.db, "files"), files)
        self.assertEqual(dump_rows(self.db, "sn_locks"), locks)
        self.assertEqual(dump_rows(self.db, "events")[:2], events)
        audit = self.db.execute("SELECT before_data FROM scope_migration_rows WHERE object_id='OLD-L4'").fetchone()[0]
        self.assertEqual(audit, raw)
        codes = [x["code"] for x in planning.precheck(self.db, {"order_ids": ["OLD-L4"]}, ADMIN)["issues"]]
        self.assertIn("ENDPOINT_REQUIRED", codes)

    def test_missing_fields_read_and_sales_correction_through_real_api(self):
        old_order(self.db)
        migrations.migrate(self.db)
        original = core.get_order(self.db, "OLD-L4", ADMIN)
        self.assertEqual(original["timezone"], "")
        self.assertIsNone(original["lat"])
        amended = core.edit_order(self.db, "OLD-L4", dict(version=8, level="L3", endpoint="已确认一层机位",
            endpoint_ref="SIM-CONTRACT-4", timezone="America/Chicago", window_start="2030-07-01T09:00",
            window_end="2030-07-01T17:00", lat=32.78, lng=-96.8), ADMIN)
        self.assertTrue(amended["addon_l4"])
        self.assertEqual(migrations.pending_issues(amended), [])
        self.assertEqual(amended["scope_migrations"][0]["original_level"], "L4")
        self.assertNotIn("ENDPOINT_REQUIRED", [x["code"] for x in planning.precheck(self.db, {"order_ids": ["OLD-L4"]}, ADMIN)["issues"]])

    def test_idempotent_repeat_and_late_legacy_import(self):
        old_order(self.db)
        first = migrations.migrate(self.db)
        rows = dump_rows(self.db, "orders")
        second = migrations.migrate(self.db)
        self.assertIsNone(second["run_id"])
        self.assertEqual(dump_rows(self.db, "orders"), rows)
        old_order(self.db, "LATE", "L5")
        third = migrations.migrate(self.db)
        self.assertNotEqual(first["run_id"], third["run_id"])
        self.assertEqual(third["orders"], 1)

    def test_confirmed_manifest_requires_evidence_and_does_not_change_known_endpoint(self):
        old_order(self.db)
        with self.assertRaisesRegex(migrations.MigrationError, "依据"):
            migrations.migrate(self.db, resolutions={"OLD-L4": dict(level="L3")})
        self.assertEqual(core.get_order(self.db, "OLD-L4", ADMIN)["level"], "L4")
        migrations.migrate(self.db, resolutions={"OLD-L4": dict(level="L3", evidence="SIM-CONTRACT-4")})
        known = core.get_order(self.db, "OLD-L4", ADMIN)
        self.assertEqual((known["level"], known["endpoint_ref"]), ("L3", "SIM-CONTRACT-4"))
        with self.assertRaisesRegex(migrations.MigrationError, "正常销售"):
            migrations.migrate(self.db, resolutions={"OLD-L4": dict(level="L2", evidence="SIM-OTHER")})

    def test_existing_addons_aliases_and_technical_commission_are_not_lost(self):
        old_order(self.db, "KNOWN", "L2", addon_l4=True, addon_l5=False, L5=True)
        old_order(self.db, "TECH", "L3", addon_l4=False, technical_order={"ref": "OLD-TECH"})
        migrations.migrate(self.db)
        known = core.get_order(self.db, "KNOWN", ADMIN)
        tech = core.get_order(self.db, "TECH", ADMIN)
        self.assertEqual(known["level"], "L2")
        self.assertTrue(known["addon_l4"] and known["addon_l5"])
        self.assertTrue(tech["addon_l5"])
        self.assertEqual(tech["technical_order"], {"ref": "OLD-TECH"})

    def test_pickup_does_not_allow_unknown_endpoint_clearance(self):
        old_order(self.db, level="L5", pickup=True, route="A")
        migrations.migrate(self.db)
        order = core.get_order(self.db, "OLD-L4", ADMIN)
        codes = {x["code"] for x in migrations.pending_issues(order)}
        self.assertEqual(codes, {"ENDPOINT_REQUIRED", "PICKUP_SCOPE_CONFLICT"})
        with self.assertRaisesRegex(migrations.MigrationError, "自提补正"):
            migrations.migrate(self.db, resolutions={"OLD-L4": dict(level="L3", evidence="SIM-PICKUP")})

    def test_restart_cannot_resurrect_legacy_addon_after_explicit_sales_change(self):
        old_order(self.db, "CHANGED", "L2", L4=True, L5=True, technical_order={"ref": "HISTORIC"})
        migrations.migrate(self.db)
        changed = core.edit_order(self.db, "CHANGED", dict(version=8, addon_l4=False, addon_l5=False), ADMIN)
        result = migrations.migrate(self.db)
        self.assertIsNone(result["run_id"])
        current = core.get_order(self.db, "CHANGED", ADMIN)
        self.assertEqual(current["version"], changed["version"])
        self.assertFalse(current["addon_l4"] or current["addon_l5"])

    def test_legacy_draft_is_readable_and_requires_recheck_preserving_issued_route(self):
        old_order(self.db)
        draft = '{"order_ids":["OLD-L4"],"check_result":{},"original_note":"keep"}'
        issued = '{"order_ids":["ISSUED"],"check_result":{}}'
        old_order(self.db, "ISSUED", "L2", release_route=dict(id="SIGNED", route_version=3))
        old_order(self.db, "HISTORIC", "L2", release_route=dict(id="UNKNOWN-SIGNED"))
        self.db.execute("UPDATE orders SET status='dispatched' WHERE id='ISSUED'")
        self.db.execute("INSERT INTO registry VALUES('DRAFT','route',2,?)", (draft,))
        self.db.execute("INSERT INTO registry VALUES('SIGNED','route',3,?)", (issued,))
        self.db.execute("INSERT INTO registry VALUES('UNKNOWN-SIGNED','route',1,?)", ('{"order_ids":["HISTORIC"]}',))
        result = migrations.migrate(self.db)
        self.assertEqual(result["drafts"], 1)
        routes = {r["id"]: r for r in operations.list_records(self.db, True, ADMIN)}
        self.assertEqual(routes["DRAFT"]["phase"], "待重新核验")
        self.assertEqual(routes["SIGNED"]["phase"], "已签发")
        self.assertEqual(self.db.execute("SELECT data FROM registry WHERE id='SIGNED'").fetchone()[0], issued)
        self.assertEqual(self.db.execute("SELECT version FROM registry WHERE id='UNKNOWN-SIGNED'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT before_data FROM scope_migration_rows WHERE object_id='DRAFT'").fetchone()[0], draft)
        self.assertEqual(routes["DRAFT"]["original_note"], "keep")
        self.assertEqual(migrations.migrate(self.db)["drafts"], 0)

    def test_database_failure_rolls_back_entire_batch_including_audit_and_events(self):
        old_order(self.db, "A", "L4")
        old_order(self.db, "Z", "L5")
        baseline = {t: dump_rows(self.db, t) for t in ("orders", "events", "files")}
        self.db.execute("CREATE TRIGGER fail_second BEFORE UPDATE ON orders WHEN NEW.id='Z' BEGIN SELECT RAISE(ABORT,'simulated disk constraint'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "simulated"):
            migrations.migrate(self.db)
        for table, rows in baseline.items():
            self.assertEqual(dump_rows(self.db, table), rows)
        self.assertFalse(self.db.execute("SELECT 1 FROM sqlite_master WHERE name='scope_migration_runs'").fetchone())

    def test_caller_transaction_is_not_committed(self):
        self.db.execute("BEGIN IMMEDIATE")
        old_order(self.db)
        migrations.migrate(self.db)
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM orders").fetchone()[0], 0)

    def test_logical_rollback_restores_exact_json_but_versions_stay_monotonic(self):
        raw = old_order(self.db)
        report = migrations.migrate(self.db)
        result = migrations.rollback_run(self.db, report["run_id"])
        row = self.db.execute("SELECT version,data FROM orders").fetchone()
        self.assertEqual((row[0], row[1]), (9, raw))
        self.assertEqual(result["restored"], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 3)
        self.assertEqual(migrations.rollback_run(self.db, report["run_id"])["restored"], 0)

    def test_rollback_never_overwrites_later_business_edits_or_partially_reverts(self):
        old_order(self.db, "A", "L4")
        old_order(self.db, "Z", "L5")
        report = migrations.migrate(self.db)
        core.edit_order(self.db, "Z", dict(version=8, notes="later business edit"), ADMIN)
        before = dump_rows(self.db, "orders")
        with self.assertRaisesRegex(migrations.MigrationError, "不覆盖新资料"):
            migrations.rollback_run(self.db, report["run_id"])
        self.assertEqual(dump_rows(self.db, "orders"), before)


class FileRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source, self.backup = self.root / "old.sqlite", self.root / "before.sqlite"
        self.db = connect(self.source)
        self.raw = old_order(self.db)
        self.db.execute("INSERT INTO users VALUES(1,'admin','SIM','admin','!',1)")
        self.db.execute("INSERT INTO sessions VALUES('old-session',1,9999999999)")
        self.baseline = {t: dump_rows(self.db, t) for t in ("orders", "events", "files", "sn_locks")}
        self.db.close()
    def tearDown(self):
        self.tmp.cleanup()

    def test_full_backup_upgrade_and_restore_to_new_path_with_session_revocation(self):
        report = migrations.migrate_file(self.source, self.backup)
        self.assertEqual(report["orders"], 1)
        for path in (self.backup,):
            with closing(sqlite3.connect(path)) as db:
                for table, rows in self.baseline.items():
                    self.assertEqual(dump_rows(db, table), rows)
        restored = self.root / "restored.sqlite"
        migrations.restore_file(self.backup, restored)
        with closing(sqlite3.connect(restored)) as db:
            for table, rows in self.baseline.items():
                self.assertEqual(dump_rows(db, table), rows)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        with self.assertRaises(FileExistsError):
            migrations.restore_file(self.backup, self.source)

    def test_failed_upgrade_keeps_original_and_full_backup(self):
        with closing(sqlite3.connect(self.source)) as db:
            data = json.loads(self.raw)
            data["addon_l4"] = "false"
            db.execute("UPDATE orders SET data=?", (json.dumps(data),))
            db.commit()
            original = dump_rows(db, "orders")
        with self.assertRaisesRegex(migrations.MigrationError, "不是布尔值"):
            migrations.migrate_file(self.source, self.backup)
        for path in (self.source, self.backup):
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(dump_rows(db, "orders"), original)
                self.assertEqual(dump_rows(db, "files"), self.baseline["files"])

    def test_existing_backup_or_source_alias_is_never_overwritten(self):
        for path in (self.source, self.backup):
            if path == self.backup:
                path.write_bytes(b"KEEP EXISTING BACKUP")
            with self.assertRaises(FileExistsError):
                migrations.migrate_file(self.source, path)
        self.assertEqual(self.backup.read_bytes(), b"KEEP EXISTING BACKUP")
        with closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(dump_rows(db, "orders"), self.baseline["orders"])


if __name__ == "__main__":
    unittest.main()
