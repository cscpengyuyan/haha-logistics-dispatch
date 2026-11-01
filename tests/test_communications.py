"""Calendar-based reminders and appointment / receipt state are independent."""
import sqlite3
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"v12"/"engine"))

import communications as com
import core
import operations
from demo_seed import seed


class ReminderTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory=sqlite3.Row
        core.core_schema(self.db)
        operations.init_db(self.db)
        self.db.execute("INSERT INTO metadata VALUES('mode','demo')")
        seed(self.db)
        self.oid=self.db.execute("SELECT id FROM orders LIMIT 1").fetchone()[0]
        self.actor={"username":"ops","role":"dispatch"}
        self.now=datetime(2026,10,28,18,tzinfo=timezone.utc)
        self.form=dict(version=0,start="2026-11-01T10:00",end="2026-11-01T16:00",
            phone="+12145550171",zone="America/Chicago",hour=10,owner="ops",consent=True,
            consent_ref="SIM-consent",carrier_ref="SIM carrier agreement")
        self.post("save",self.form)

    def post(self,action,body,actor=None):
        with self.db:
            return com.handle(self.db,"POST",f"/api/communications/{action}/{self.oid}",body,actor or self.actor,self.now)

    def test_dst_reschedule_idempotence_stop_and_receipt(self):
        req=dict(version=1,template="T2")
        job=self.post("queue",req)["jobs"][0]
        # Fall back on Nov 1. Oct 31 10:00 CDT is 15 UTC, not 16 UTC.
        self.assertEqual((job["due"],job["state"]),("2026-10-31T15:00:00+00:00","queued"))
        self.assertEqual(len(self.post("queue",req)["jobs"]),1)
        changed=self.post("save",dict(self.form,version=1,start="2026-11-02T10:00",end="2026-11-02T16:00"))
        self.assertEqual([j["state"] for j in changed["jobs"]],["queued","cancelled"])
        self.assertEqual(changed["jobs"][0]["due"],"2026-11-01T16:00:00+00:00")
        with self.assertRaises(core.ApiError):self.post("simulate",req)
        req["version"]=2
        for _ in range(2):
            sent=self.post("simulate",req)
            self.assertEqual((sent["jobs"][0]["state"],sent["appointment"]["customer"]),("simulated","待回复"))
        stop=self.post("stop",req)
        self.assertIn("电话",stop["appointment"]["follow_up"])
        self.assertEqual(self.post("queue",dict(req,template="T1"))["jobs"][0]["state"],"manual")

    def test_customer_reschedule_replaces_reminder_without_reauthorizing_payment(self):
        self.post("queue",dict(version=1,template="T2"))
        reply=self.post("reschedule",dict(version=1))
        self.assertEqual(reply["jobs"][0]["state"],"cancelled")
        new=self.post("save",dict(self.form,version=1,start="2026-11-04T09:00",end="2026-11-04T16:00"))
        self.assertEqual([(j["version"],j["state"]) for j in new["jobs"]],[(2,"queued"),(1,"cancelled")])

    def test_late_unknown_zone_and_rights(self):
        self.now=datetime(2026,10,31,21,tzinfo=timezone.utc)
        self.assertEqual(self.post("queue",dict(version=1,template="T2"))["jobs"][0]["state"],"manual")
        changed=self.post("save",dict(self.form,version=1,zone=""))
        self.assertIn("时区待核",changed["jobs"][0]["reason"])
        with self.assertRaises(core.ApiError):
            self.post("confirm",dict(version=2),{"username":"driver","role":"driver"})
        self.assertEqual(self.post("cancel",dict(version=2))["appointment"]["status"],"已取消")
