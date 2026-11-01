import base64
import hashlib
import hmac
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import sms_worker
import communications
import core


class LiveTransport(unittest.TestCase):
    """All transports and provider signatures are synthetic. No socket or real secret is used."""
    def setUp(self):
        self.db=sqlite3.connect(":memory:",isolation_level=None)
        self.addCleanup(self.db.close)
        self.db.row_factory=sqlite3.Row
        core.core_schema(self.db)
        communications.init_db(self.db)
        self.db.execute("INSERT INTO metadata VALUES('mode','production')")
        self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES('dispatch','Dispatcher','dispatch','!')")
        self.o={"warehouse":"Dallas","address":"Synthetic","zip":"75201","timezone":"America/Chicago","level":"L3","endpoint":"floor 1",
                "window_start":"2026-11-05T09:00","window_end":"2026-11-05T15:00"}
        self.db.execute("INSERT INTO orders VALUES('T1',1,'ready',?)",(core.encode(self.o),))
        self.u={"username":"dispatch","role":"dispatch"}
        self.start=datetime(2026,11,1,16,tzinfo=timezone.utc)
        self.due=datetime(2026,11,4,16,tzinfo=timezone.utc)
        self.cfg={"account":"AC"+"1"*32,"token":"fake-testing-only-signature-string","origin":"https://test.invalid","sender":"+15005550006"}
        self.sid="SM"+"2"*32
        self.sms("save",version=0,start=self.o["window_start"],end=self.o["window_end"],hour=10,zone="America/Chicago",
                 phone="+15005550007",owner="dispatch",consent=True,consent_ref="test opt-in",carrier_ref="test appointment")
        self.job=self.sms("queue",version=1,template="T2")["jobs"][0]
        self.body={"version":1,"template":"T2","job":self.job["id"],"authorize_charges":True}
        self.path=sms_worker.STATUS+self.job["id"]
        self.posts=[]

    def sms(self,action,**data):
        return communications.handle(self.db,"POST","/api/communications/"+action+"/T1",data,self.u,self.start)

    def authorize(self,**kw):
        return sms_worker.authorize(self.db,"T1",{**self.body,**kw},self.u,self.cfg,self.start)

    def step(self,clock=None,fail=False):
        def mock(_cfg,job):
            self.posts.append(job["id"])
            if fail:raise TimeoutError()
            return {"sid":self.sid,"status":"queued"}
        return sms_worker.once(self.db,self.cfg,clock or self.due,transport=mock)

    def callback(self,path,**fields):
        f={"AccountSid":self.cfg["account"],"MessageSid":self.sid,**fields}
        sig=self.cfg["origin"]+path+"".join(k+f[k] for k in sorted(f))
        digest=base64.b64encode(hmac.new(self.cfg["token"].encode(),sig.encode(),hashlib.sha1).digest()).decode()
        sms_worker.webhook(self.db,self.cfg,path,urlencode(f).encode(),digest)

    def state(self):return communications.jobs(self.db,"T1")[0]

    def test_explicit_authorization_and_idempotent_delivery(self):
        self.assertFalse(self.step())
        with self.assertRaises(core.ApiError):self.authorize(authorize_charges=False)
        self.authorize();self.authorize()
        self.assertFalse(self.step(self.due-timedelta(seconds=1)))
        self.assertTrue(self.step());self.assertFalse(self.step())
        self.assertEqual(len(self.posts),1)
        self.assertEqual(self.state()["state"],"submitted")
        with self.assertRaises(core.ApiError):
            sms_worker.webhook(self.db,self.cfg,self.path,urlencode({"MessageSid":self.sid}).encode(),"invalid")
        self.callback(self.path,MessageStatus="delivered")
        self.callback(self.path,MessageStatus="sent")
        self.callback(self.path,MessageStatus="delivered")
        self.assertEqual(self.state()["state"],"delivered")
        self.assertEqual(communications.load(self.db,"T1")["customer"],"待回复")

    def test_optout_suppresses_even_after_authorization(self):
        self.authorize()
        args={"Body":"STOP","From":"+15005550007","To":self.cfg["sender"]}
        self.callback(sms_worker.INCOMING,**args);self.callback(sms_worker.INCOMING,**args)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sms_inbound").fetchone()[0],1)
        self.assertFalse(self.step());self.assertEqual(self.state()["state"],"manual")
        self.assertEqual(self.posts,[])

    def test_unknown_submit_no_retry_and_failure_code(self):
        self.authorize();self.step(fail=True)
        self.assertEqual(self.state()["state"],"manual");self.assertFalse(self.step())
        self.callback(self.path,MessageStatus="undelivered",ErrorCode="30003")
        self.assertEqual(self.state()["error_code"],"30003");self.assertEqual(self.state()["sid"],self.sid)
        self.assertEqual(len(self.posts),1)

    def test_missed_slot_and_demo_are_suppressed(self):
        self.authorize();self.step(self.due+timedelta(minutes=20))
        self.assertEqual(self.state()["state"],"manual");self.assertEqual(self.posts,[])
        self.db.execute("UPDATE metadata SET value='demo' WHERE key='mode'")
        with self.assertRaises(core.ApiError):self.step()

    def test_cancel_authorized_job(self):
        self.authorize()
        self.sms("cancel",version=1)
        self.assertFalse(self.step());self.assertEqual(self.state()["state"],"cancelled")


if __name__=="__main__":unittest.main()
