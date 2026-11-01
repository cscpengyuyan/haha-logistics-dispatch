import json, tempfile, unittest,sys
from pathlib import Path
from unittest.mock import patch
from contextlib import closing
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server,dispatch_jobs,core,planning
class Jobs(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'demo.sqlite3';server.initialize(self.path,True);self.db=server.connect(self.path);self.user={'username':'dispatch','role':'dispatch'};self.oid=self.db.execute('SELECT id FROM orders LIMIT 1').fetchone()[0]
 def tearDown(self):self.db.close();self.tmp.cleanup()
 def create(self,**extra):
  return dispatch_jobs.handle(self.db,'POST','/api/ops/jobs',{'order_ids':[self.oid],**extra},self.user)['job']
 def test_same_key_same_result_different_content_conflicts(self):
  a=self.create(idempotency_key='job-repeat-0001');b=self.create(idempotency_key='job-repeat-0001');self.assertEqual(a['id'],b['id'])
  with self.assertRaises(core.ApiError):self.create(idempotency_key='job-repeat-0001',objective='earliest_finish')
 def test_cancelled_late_completion_cannot_publish(self):
  job=self.create()
  def calculate(db,body,user,publish):
   with closing(server.connect(self.path)) as other:dispatch_jobs.handle(other,'POST','/api/ops/jobs/'+job['id']+'/cancel',{},user)
   return {'plan':{'plan_id':'LATE'}}
  with patch.object(planning,'optimize',side_effect=calculate),patch.object(planning,'save_result') as save:
   dispatch_jobs.run_one(server.connect,self.path,job['id']);save.assert_not_called()
  self.assertEqual(dispatch_jobs.view(dispatch_jobs.get(self.db,job['id'],self.user))['state'],'cancelled')
 def test_real_job_publishes_and_scopes_user(self):
  job=self.create();dispatch_jobs.run_one(server.connect,self.path,job['id'])
  end=dispatch_jobs.view(dispatch_jobs.get(self.db,job['id'],self.user));self.assertEqual(end['state'],'completed',end)
  self.assertIsNotNone(end['plan_id'])
  with self.assertRaises(core.ApiError):dispatch_jobs.get(self.db,job['id'],dict(username='other',role='dispatch'))
 def test_stale_queue_fails_without_plan(self):
  job=self.create();self.db.execute('UPDATE orders SET version=version+1 WHERE id=?',(self.oid,))
  dispatch_jobs.run_one(server.connect,self.path,job['id']);end=dispatch_jobs.view(dispatch_jobs.get(self.db,job['id'],self.user));self.assertEqual(end['state'],'failed');self.assertIn('STALE_INPUT',end['error']['message'])
if __name__=='__main__':unittest.main()
