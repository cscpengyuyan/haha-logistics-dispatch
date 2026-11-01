"""Kill a claimed worker process, then reclaim its persisted job after lease expiry."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'v13/engine'))
import server, dispatch_jobs, simulation

def main():
    with tempfile.TemporaryDirectory(prefix='v13-restart-',dir=ROOT/'.release') as tmp:
        base=Path(tmp);path=base/'restart.sqlite3';marker=base/'claimed.txt'
        with closing(sqlite3.connect(ROOT/'v13/data/sim200-ready.sqlite3')) as source,closing(sqlite3.connect(path)) as target:
            source.backup(target)
        server.initialize(path,True)
        db=server.connect(path);user=simulation.actor('dispatch')
        ids=['SIM200-053','SIM200-067','SIM200-081','SIM200-054','SIM200-068','SIM200-082']
        with db:
            job=dispatch_jobs.handle(db,'POST','/api/ops/jobs',dict(order_ids=ids,idempotency_key='SIM-REAL-PROCESS-RESTART',budget_seconds=10),user)['job']
        code="""import sys,time,pathlib
import server,dispatch_jobs
old=dispatch_jobs.planning.optimize
def stop_after_claim(*a,**kw):
 pathlib.Path(sys.argv[3]).write_text('claimed')
 time.sleep(120)
 return old(*a,**kw)
dispatch_jobs.planning.optimize=stop_after_claim
dispatch_jobs.run_one(server.connect,pathlib.Path(sys.argv[1]),sys.argv[2])
"""
        worker=subprocess.Popen([sys.executable,'-B','-c',code,str(path),job['id'],str(marker)],cwd=ROOT,
                                 creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            start=time.monotonic()
            while not marker.exists() and time.monotonic()-start<10:
                if worker.poll() is not None:raise RuntimeError('Test worker exited before claiming')
                time.sleep(.1)
            assert marker.exists()
            before=dict(dispatch_jobs.get(db,job['id'],user));assert before['state']=='running' and before['attempt']==1
            worker.terminate();worker.wait(timeout=10)
            # Do not edit the lease: wait for the actual persisted deadline.
            time.sleep(max(0,before['expires']-time.time()+.1))
            dispatch_jobs.run_one(server.connect,path,job['id'])
            after=dispatch_jobs.view(dispatch_jobs.get(db,job['id'],user))
            assert after['state']=='completed' and after['attempt']==2,after
            plan=after['result']['plan'];assert plan['coverage']['assigned']==len(ids)
            retry=dispatch_jobs.handle(db,'POST','/api/ops/jobs',dict(order_ids=ids,idempotency_key='SIM-REAL-PROCESS-RESTART',budget_seconds=10),user)['job']
            assert retry['id']==job['id'] and retry['state']=='completed'
            result=dict(scenario='T43 actual worker process termination and restart',synthetic=True,
                        first_attempt='running then process terminated',first_pid=worker.pid,lease_wait_seconds=round(before['expires']-before.get('created',before['expires']-45),2),
                        recovered_attempt=after['attempt'],state=after['state'],coverage=plan['coverage'],
                        idempotent_retry_same_job=True,seconds=round(time.monotonic()-start,2))
            (ROOT/'docs/verification/v13/job-process-restart.json').write_text(json.dumps(result,indent=2),encoding='utf8')
            print(json.dumps(result),flush=True)
        finally:
            if worker.poll() is None:worker.terminate();worker.wait(timeout=10)
            db.close()

if __name__=='__main__':main()
