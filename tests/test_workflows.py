"""Exercise roles and real shared HTTP records; no direct status mutations."""
import sys,unittest
from pathlib import Path
import test_shared as support
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import practice
class Workflow(unittest.TestCase):
    setUp=support.Shared.setUp
    tearDown=support.Shared.tearDown
    hit=support.Shared.hit
    stage=support.Shared.stage
    def test_subcontract_reply_partial_delivery_receipts_and_payees(self):
        s=self.stage(7);oid=s['id'];path='/api/orders/'+oid;gp='/api/gate/'+oid
        get=lambda role:self.hit(role,path)[1]['order']
        def action(r,a,**kw):
            o=get(r);return self.hit(r,path+'/actions',dict(version=o['version'],action=a,release_version=o.get('issue_version'),**kw))[1]['order']
        q=get('procurement')['selected_quote']
        ln=next(l for l in self.hit('procurement','/api/gate/network')[1]['links'] if l['executor_id']==q['executor_id'])
        g=self.hit('procurement',gp+'/invite',dict(leg=1,version=s['version'],link_id=ln['id'],contract_ref='SIM-CONTRACT',delegation_ref='SIM-PRIME',evidence='SIM-INV'))[1]['grant']
        self.cookies['supplier']=self.hit(None,'/api/demo-login',dict(username='supplier'))[2]['Set-Cookie'].split(';')[0]
        tasks=self.hit('supplier','/api/supplier/work')[1]['assignments'];self.assertEqual([g['id']],[x['id'] for x in tasks]);self.assertNotIn('address',tasks[0]);self.assertNotIn('amount',tasks[0])
        self.hit('supplier',path,status=403);self.hit('supplier','/api/supplier/reply',dict(id='other',version=1,decision='accept',evidence='no'),status=404)
        self.hit('supplier','/api/supplier/reply',dict(id=g['id'],version=g['version'],decision='accept',evidence='SIM-SUPPLIER-ACK'))
        self.hit('dispatch','/api/practice/dfw',dict(cursor=7,version=get('dispatch')['version'],reference='SIM-ISSUE'))
        o=get('warehouse');g=self.hit('warehouse',gp)[1]['grant'];self.hit('warehouse',gp+'/verify',dict(version=o['version'],release_version=o['issue_version'],pickup_code=g['pickup_code'],driver=g['driver'],plate=g['plate'],crew_id=g['crew_id'],vehicle_id=g['vehicle_id'],sns=list(practice.SN),evidence='SIM-DOCK'))
        o=get('driver');pod=self.hit('driver',path+'/files',dict(version=o['version'],release_version=o['issue_version'],base64=practice.synthetic_pod(),category='pod',name='two.pdf'))[1]['file']['id']
        self.hit('supplier','/api/files/'+str(pod),status=403);self.hit(None,'/api/files/'+str(pod),status=401)
        def attempt(sn_units,time):
            o=get('driver');return self.hit('driver','/api/ops/folder/'+oid+'/attempts',dict(version=o['version'],release_version=o['issue_version'],arrival_local=practice.DAY+'T'+time,finished_local=practice.DAY+'T'+time,location=o['endpoint'],evidence='SIM-attempt',custodian='SIM DRIVER',next_step='Redeliver only missing SN',units=sn_units))
        one,two=practice.SN;ok=lambda k:dict(sn=k,outcome='success',details='positioned',location=o['endpoint'],pod_id=pod)
        attempt([ok(one),dict(sn=two,outcome='partial',details='entrance only',location='entrance')],'10:00')
        self.assertEqual(self.hit('driver','/api/ops/folder/'+oid)[1]['pending_sns'],[two])
        self.hit('driver',path+'/actions',dict(action='deliver',version=get('driver')['version'],release_version=o['issue_version']),status=409)
        attempt([ok(two)],'11:00');action('driver','deliver',signer='SIM',delivered_at=practice.DAY+'T11:05',delivery_note='SIM signed both')
        rec=dict(version=get('sales')['version'],signed_qty=2,received_qty=1,state='open',evidence='SIM-platform',owner='sales',due=practice.DAY+'T17:00',next_step='reconcile platform',shipment_ref='SIM-platform-ID')
        self.hit('sales','/api/ops/folder/'+oid+'/receipts',rec)
        folder=self.hit('sales','/api/ops/folder/'+oid)[1];self.assertEqual((folder['receipt']['signed_qty'],folder['receipt']['received_qty'],len(folder['attempts'])),(2,1,2))
        unit=lambda k,state:dict(sn=k,state=state,result=state,customer_ref='SIM-Tech-'+k)
        mid=action('service','service_complete',result_ref='SIM-partial',service_units=[unit(one,'passed'),unit(two,'parts_pending')]);self.assertEqual(mid['status'],'delivered');self.assertNotIn('settle',get('finance')['allowed_actions'])
        action('service','service_complete',result_ref='SIM-tested',service_units=[unit(two,'passed')]);action('finance','settle',actual_cost=595,change_cost=15,change_ref='SIM-CHANGE',invoice_ref='SIM-US',usa_lines=dict(origin=30,delivery_wait=445,technical=120))
        line=dict(order_id=oid,sn=two,kind='delivery',amount=445,source=q['id'],evidence='SIM-POD')
        for issuer,want in [(q['executor_id'],'disputed'),(q['supplier_id'],'matched')]:
            resp=self.hit('finance','/api/billing',dict(action='match',issuer=issuer,reference='SIM-TRANSPORT',issued_on=practice.DAY,total=445,lines=[line]))[1];self.assertEqual(resp[want],1)
        self.hit('driver','/api/billing',status=403)
    def test_manual_crm_replay_and_contact(self):
        path='/api/team/import';payload=dict(external_id='CRM-SIM-CHECK',order=dict(quantity=1))
        a=self.hit('sales',path,payload)[1];self.assertEqual(a['state'],'needs_review')
        payload.update(version=a['version'],order=dict(quantity=1,customer='SIM',warehouse='Dallas',model='M01',zip='75201',address='SIM',endpoint='Dock'))
        o=self.hit('sales',path,payload)[1];self.assertTrue(self.hit('sales',path,payload)[1]['replayed'])
        tp='/api/team/'+o['order_id'];s=self.hit('sales',tp)[1]
        def event(role,a,**kw):
            return self.hit(role,tp,dict(version=1,task_version=s['version'],action=a,evidence='SIM-'+a,**kw))[1]
        s=event('sales','claim');s=event('sales','channel',channel='phone',alternative='email',contact_hours='local 10-16')
        self.hit('sales',tp,dict(version=1,task_version=s['version'],action='confirmed',evidence='not delivered'),status=409)
        for a in ('sent','delivered','reply','confirmed'):s=event('sales',a)
        s=event('sales','handoff',to='service');self.assertEqual(s['contact_owner'],'service')
        self.hit('driver',path,status=403)
