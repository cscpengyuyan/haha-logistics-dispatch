"""HTTP security, evidence-backed dispatch, conflicts, idempotency and restored-state checks."""
import sys,threading,json,http.client,unittest,tempfile,sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server,maintenance,practice,core

class Shared(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/"practice.db";server.initialize(self.path,True)
        self.s=server.Server(("127.0.0.1",0),self.path,True);self.thread=threading.Thread(target=self.s.serve_forever,daemon=True);self.thread.start();self.cookies={}
        for role in ('sales','warehouse','procurement','dispatch','driver','finance','service'):
            self.cookies[role]=self.hit(None,'/api/demo-login',dict(username=role))[2]['Set-Cookie'].split(';')[0]
    def tearDown(self):
        self.s.shutdown();self.s.server_close();self.thread.join();self.tmp.cleanup()
    def hit(self,role,path,data=None,extra=None,status=200):
        h={'Content-Type':'application/json',**(extra or {})}
        if role:h['Cookie']=self.cookies[role]
        with closing(http.client.HTTPConnection('127.0.0.1',self.s.server_port,timeout=15)) as conn:
            conn.request('GET' if data is None else 'POST',path,None if data is None else json.dumps(data),h)
            r=conn.getresponse();b=r.read();obj=json.loads(b) if 'json' in r.getheader('Content-Type','') else b
            if status:self.assertEqual(r.status,status,(path,obj))
            return r.status,obj,dict(r.getheaders())
    def stage(self,n):
        for i in range(n):
            r=practice.STEPS[i][0];s=self.hit(r,'/api/practice/dfw')[1]
            self.hit(r,'/api/practice/dfw',dict(cursor=i,version=s['version'],reference='SIM-HTTP-'+str(i)))
        return self.hit('dispatch','/api/practice/dfw')[1]
    def test_unauthorized_dallas_and_dock(self):
        s=self.stage(7);oid=s['id'];o=self.hit('dispatch','/api/orders/'+oid)[1]['order']
        with closing(server.connect(self.path)) as db:
            import routing
            plan=routing.example_plan(db,o,dict(role='dispatch',username='dispatch'),executor=o['selected_quote']['executor_id'])
            wrong=routing.example_plan(db,o,dict(role='dispatch',username='dispatch'),executor=o['selected_quote']['executor_id'],crew_coverage='07102')
        rid=self.hit('dispatch','/api/ops/routes',plan)[1]['route']
        data=dict(action='dispatch',version=o['version'],driver='driver',carrier=o['selected_quote']['carrier'],dispatch_ref='SIM',approved_cost=580,checks={k:'SIM-REF-'+k for k in core.CHECKS},route_id=rid['id'],route_version=rid['version'])
        self.hit('dispatch','/api/orders/'+oid+'/actions',data,status=409)
        net=self.hit('dispatch','/api/gate/network')[1];ln=next(l for l in net['links'] if l['executor_id']==o['selected_quote']['executor_id'])
        nj={**ln,'crew_id':wrong['crew_id'],'zip':'07102'};nj.pop('id');nj.pop('version')
        bad=self.hit('procurement','/api/gate/network',nj)[1]['link']
        inv=dict(leg=1,version=o['version'],contract_ref='SIM-CUSTOMER',delegation_ref='SIM-PRIME',evidence='SIM-INV',link_id=bad['id'])
        self.hit('procurement','/api/gate/'+oid+'/invite',inv,status=409)
        self.hit('driver','/api/orders/'+oid,status=404)
        self.hit('warehouse','/api/gate/'+oid+'/verify',dict(version=o['version']),status=409)
        inv['link_id']=ln['id'];g=self.hit('procurement','/api/gate/'+oid+'/invite',inv)[1]['grant']
        self.hit('dispatch','/api/orders/'+oid+'/actions',data,status=409)
        self.hit('procurement','/api/gate/'+oid+'/accept',dict(version=o['version'],grant_version=g['version'],evidence='SIM-ACTUAL-ACCEPT'))
        o=self.hit('dispatch','/api/orders/'+oid+'/actions',data)[1]['order']
        body=dict(version=o['version'],release_version=o['issue_version'],pickup_code=o['pickup_code'],driver='driver',plate=ln['plate'],vehicle_id=ln['vehicle_id'],crew_id=ln['crew_id'],sns=list(practice.SN),evidence='SIM-GATE')
        self.hit('warehouse','/api/gate/'+oid+'/verify',{**body,'plate':'DIFFERENT'},status=409)
        self.hit('warehouse','/api/gate/'+oid+'/verify',{**body,'release_version':0},status=409)
        self.hit('driver','/api/orders/'+oid+'/actions',dict(action='depart',version=o['version'],release_version=o['issue_version']),status=409)
        self.hit('warehouse','/api/gate/'+oid+'/verify',body)
        self.hit('warehouse','/api/gate/'+oid+'/verify',body,status=409)
    def test_idempotency_backup_restore_and_permissions(self):
        doc=dict(customer='SIM',address='TEST',zip='06103',warehouse='Dallas',model='M01',quantity=1,endpoint='dock')
        h={'Idempotency-Key':'sim-restore-01'}
        oid=self.hit('sales','/api/orders',doc,h)[1]['order']['id']
        self.assertEqual(self.hit('sales','/api/orders',doc,h)[1]['order']['id'],oid)
        self.hit('sales','/api/orders',{**doc,'quantity':2},h,status=409)
        self.hit(None,'/api/orders',status=401);self.hit('driver','/api/orders/'+oid,status=404)
        self.hit('sales','/api/orders',doc,{'Origin':'https://untrusted.invalid'},403)
        dest=self.path.with_name('restored.db');pre=maintenance.inspect(self.path);self.assertEqual(maintenance.restore(self.path,dest),pre)
        with self.assertRaises(FileExistsError):maintenance.restore(self.path,dest)
        self.s.path=dest
        self.hit('sales','/api/orders',status=401)
        self.cookies['sales']=self.hit(None,'/api/demo-login',dict(username='sales'))[2]['Set-Cookie'].split(';')[0]
        self.assertEqual(self.hit('sales','/api/orders',doc,h)[1]['order']['id'],oid)
    def test_two_named_warehouse_accounts_race_same_sn(self):
        doc=dict(customer='SIM',address='TEST',zip='06103',warehouse='Dallas',model='M01',quantity=1,level='L1',endpoint='dock')
        ids=[self.hit('sales','/api/orders',doc)[1]['order'] for _ in range(2)]
        with closing(server.connect(self.path)) as db:db.execute("INSERT INTO users(username,name,role,passhash) VALUES(?,?,?,?)",('night','SIM night','warehouse',server.password_hash('test-only-123456')))
        self.cookies['night']=self.hit(None,'/api/login',dict(username='night',password='test-only-123456'))[2]['Set-Cookie'].split(';')[0]
        self.hit('warehouse','/api/lifecycle/assets',dict(action='receive',sn='WH-RACE',warehouse='Dallas',model='M01',bin='SIM',batch='ASN-SIM',condition='checked',evidence='SIM',state='available'))
        barrier=threading.Barrier(2)
        def run(arg):
            user,o=arg;barrier.wait()
            return self.hit(user,'/api/orders/'+o['id']+'/actions',dict(action='ready',version=o['version'],sn='WH-RACE',release_ref='SIM-LOCK'),status=None)[0]
        with ThreadPoolExecutor(2) as pool:self.assertEqual(sorted(pool.map(run,zip(('warehouse','night'),ids))),[200,409])
if __name__=='__main__':unittest.main()
