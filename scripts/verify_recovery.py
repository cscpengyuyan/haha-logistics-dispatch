"""T30 domain integration replay: two completed stops, real fault custody, two-stop rescue.

All identity, SN, POD and carrier road references are marked synthetic. The roadmap
integration is tested separately; this script never represents these references as OSM.
"""
import argparse,copy,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_sim200 import Replay,U
import core,simulation,operations,lifecycle,folder,gate,routing,practice,recovery
DAY='2030-07-10'

def run(path,real_roads=False):
    path=Path(path);r=Replay(path);db=r.db
    old=path/'recovery-result.json'
    if old.exists():db.close();return json.loads(old.read_text(encoding='utf-8'))
    if db.execute('SELECT count(*) FROM orders').fetchone()[0]:raise RuntimeError('Use a fresh isolated output directory for this integration replay')
    r.resources=simulation.provision(db);db.commit()
    ids=[];serials={}
    for n in range(4):
        oid=f'SIM200-{53+n:03d}';ids.append(oid);sn=f'SIM-RECOVERY-{n+1:03d}';serials[oid]=[sn]
        b=copy.deepcopy(simulation.generate()[52+n]['order'])
        b.pop('id',None)
        b.update(simulation_id=oid,crm_ref=oid,customer='SIM recovery loading dock',warehouse='SIM Dallas',address=f'SIM dock {n+1}',contact='SIM receiver',city='Dallas',state='TX',zip='75201',model='M01',quantity=1,lat=32.78+n*.001,lng=-96.806,endpoint='SIM lobby',level='L3',addon_l4=False,addon_l5=False,procurement_mode='brand_fleet',route='B',timezone='America/Chicago',window_start=DAY+'T08:00',window_end=DAY+'T18:00')
        r.step(oid,'create','sales',lambda b=b:core.create_order(db,b,U('sales')))
        r.step(oid,'receive','warehouse',lambda sn=sn:lifecycle.receipt(db,dict(sn=sn,model='M01',bin='SIM-Z1',warehouse='SIM Dallas',condition='intact',batch='SIM-ASN',evidence='SIM-GRN',state='available'),U('warehouse')))
        r.step(oid,'reserve','warehouse',lambda oid=oid,sn=sn:r.action(oid,'ready','warehouse',sn=sn,release_ref='SIM-RESERVE'))
        r.step(oid,'internal_contract','admin',lambda oid=oid:folder.platform_instruction(db,r.order(oid),dict(account_ref='SIM-COST-CENTER',instruction_ref='SIM-INTERNAL',executor_id='SIM-TX',carrier='SIM Fleet',acceptance_ref='SIM-ACK',valid_until='2036-12-31',allocation=0,cost_center='SIM-TX'),U('admin')))
    plan=routing.example_plan(db,r.order(ids[0]),U('dispatch'),executor='SIM-TX');db.commit()
    link=r.step('ROUTE','original_network','procurement',lambda:gate.network(db,dict(executor_id='SIM-TX',crew_id=plan['crew_id'],vehicle_id=plan['resource_id'],driver='driver',plate='SIM-ORIGINAL',warehouse_id=routing.origin_resource(db,'SIM Dallas')['id'],zip='75201',model='M01',level='L3',product='T2',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-ROSTER'),U('procurement')))
    for oid in ids:
        def invite(oid=oid):
            o=r.order(oid);g=gate.invite(db,o,dict(leg=1,link_id=link['id'],evidence='SIM-INVITE'),U('procurement'))
            return gate.handle(db,'POST',f'/api/gate/{oid}/accept',dict(version=o['version'],grant_version=g['version'],evidence='SIM-ACK'),U('procurement'))
        r.step(oid,'accept_original','procurement',invite)
    plan.update(name='SIM T30 original four stops',order_ids=ids,order_versions={i:r.order(i)['version'] for i in ids})
    sample=copy.deepcopy(plan['stops'][ids[0]])
    for n,oid in enumerate(ids):plan['stops'][oid]=dict(sample,from_id=plan['stops'][ids[0]]['from_id'] if n==0 else ids[n-1])
    route=r.step('ROUTE','original_route','dispatch',lambda:operations.save_route(db,plan,U('dispatch')))['route']
    assert route['check_result']['issues']==[],route['check_result']['issues']
    for oid in ids:
        r.step(oid,'original_issue','dispatch',lambda oid=oid:r.action(oid,'dispatch','dispatch',driver='driver',carrier='SIM Fleet',approved_cost=0,dispatch_ref='SIM-F04',route_id=route['id'],route_version=route['version'],checks={k:'SIM-CHECK-'+k for k in core.CHECKS}))
        r.step(oid,'original_handover','warehouse',lambda oid=oid:gate.verify(db,r.order(oid),dict(release_version=r.order(oid)['issue_version'],pickup_code=r.order(oid)['pickup_code'],sns=serials[oid],driver='driver',plate='SIM-ORIGINAL',crew_id=plan['crew_id'],vehicle_id=plan['resource_id'],evidence='SIM-GATE'),U('warehouse')))
    def deliver(oid,arrival,finished):
        o=r.order(oid);u=U('driver');fid=core.add_file(db,oid,dict(version=o['version'],release_version=o['issue_version'],category='pod',name=oid+'-SIM.pdf',base64=practice.synthetic_pod()),u)['file']['id']
        o=r.order(oid);folder.add_attempt(db,o,dict(release_version=o['issue_version'],arrival_local=DAY+'T'+arrival,finished_local=DAY+'T'+finished,location=o['endpoint'],evidence='SIM-POD-'+oid,units=[dict(sn=serials[oid][0],outcome='success',details='SIM full handover',location=o['endpoint'],pod_id=fid)]),u)
        return r.action(oid,'deliver','driver',release_version=r.order(oid)['issue_version'],signer='SIM receiver',delivered_at=DAY+'T'+finished,delivery_note='SIM-DONE')
    r.step(ids[0],'deliver_first','driver',lambda:deliver(ids[0],'08:40','09:20'))
    r.step(ids[1],'deliver_second','driver',lambda:deliver(ids[1],'10:00','10:40'))
    frozen={i:dict(db.execute('SELECT * FROM orders WHERE id=?',(i,)).fetchone()) for i in ids[:2]}
    original_grants={i:dict(db.execute('SELECT * FROM gate_grants WHERE id=?',(r.order(i)['gate_grant_id'],)).fetchone()) for i in ids}
    old_tokens={i:{k:r.order(i)[k] for k in ('pickup_code','issue_version')} for i in ids[2:]}
    report=dict(route_id=route['id'],route_version=route['version'],order_versions={i:r.order(i)['version'] for i in ids},reported_at=DAY+'T11:00:00-05:00',location=dict(lat=32.781,lng=-96.806,address='SIM actual fault bay; witness verified',timezone='America/Chicago'),onboard_sns=sorted(sum((serials[i] for i in ids[2:]),[])),reason='SIM vehicle mechanical breakdown',evidence='SIM-FAULT-PHOTO',custody_ref='SIM-DRIVER-SN-COUNT',idempotency_key='fault-report')
    api=lambda path,b,role='dispatch':operations.handle(db,'POST','/api/ops/recovery'+path,b,U(role))
    r.step('RECOVERY','wrong_sn_report_rejected','dispatch',lambda:api('/report',dict(report,onboard_sns=['SIM-WRONG'])),expect_error=True)
    reported=r.step('RECOVERY','report','dispatch',lambda:api('/report',report))['case'];rid=reported['id']
    r.step('RECOVERY','report_retry','dispatch',lambda:api('/report',report))
    r.step('RECOVERY','conflicting_retry_rejected','dispatch',lambda:api('/report',dict(report,reason='changed')),expect_error=True)
    assert len(reported['frozen_prefix'])==2 and reported['remaining_ids']==ids[2:]
    r.step('RECOVERY','broken_original_vehicle_blocked','warehouse',lambda:routing.validate_departure(db,r.order(ids[0])),expect_error=True)
    r.step('RECOVERY','repair_before_cargo_handover_rejected','admin',lambda:api('/'+rid+'/repair',dict(version=reported['version'],idempotency_key='repair-before-handover',repair_ref='SIM-REPAIR',inspection_ref='SIM-INSPECT',approval_ref='SIM-APPROVE'),'admin'),expect_error=True)
    for i in ids[2:]:
        r.step(i,'ordinary_resolve_rejected','dispatch',lambda i=i:r.action(i,'resolve','dispatch',resolution='SIM unsafe old grant'),expect_error=True)
        r.step(i,'old_issue_upload_rejected','driver',lambda i=i:core.add_file(db,i,dict(version=r.order(i)['version'],release_version=old_tokens[i]['issue_version'],category='pod',name='SIM-old.pdf',base64=practice.synthetic_pod()),U('driver')),expect_error=True)
    backup=copy.deepcopy(routing.resource(db,'vehicle',plan['resource_id']));backup.pop('id');backup.pop('version');backup.update(type='vehicle',name='SIM rescue vehicle',evidence='SIM-RESCUE-VEHICLE',floor_length_cm=650,floor_width_cm=240,door_width_cm=230,truck_length_m=8,truck_width_m=2.5,truck_height_m=3.5,gross_t=10,axle_load_t=6)
    vehicle=r.step('RECOVERY','rescue_vehicle','dispatch',lambda:operations.save_resource(db,backup,U('dispatch')))['resource']
    newlink=r.step('RECOVERY','rescue_network','procurement',lambda:gate.network(db,dict(executor_id='SIM-TX',crew_id=plan['crew_id'],vehicle_id=vehicle['id'],driver='driver',plate='SIM-RESCUE',warehouse_id=routing.origin_resource(db,'SIM Dallas')['id'],zip='75201',model='M01',level='L3',product='T2',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-RESCUE-ROSTER'),U('procurement')))
    newplan=copy.deepcopy(plan);newplan.update(name='SIM T30 remaining reversed',resource_id=vehicle['id'],start_time='11:30')
    newplan['checks']['warehouse_end']=DAY+'T17:00'
    newids=list(reversed(ids[2:]));newplan['stops']={i:dict(sample,from_id=reported['origin']['id'] if n==0 else newids[n-1],road_ref='SIM-CARRIER-ACTUAL-FAULT-LEG',length_cm=100,width_cm=83,lift_extra_kg=0) for n,i in enumerate(newids)}
    road_results=[]
    def calculate_road(c,label):
        if not real_roads:return
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]));import road_service
        request=dict(newplan,warehouse=reported['origin']['name'],order_ids=newids,order_versions={i:r.order(i)['version'] for i in ids[2:]},recovery_id=rid,recovery_version=c['version'],optimize=False,road_basis='valhalla_truck')
        answer=r.step('RECOVERY','real_road_'+label,'dispatch',lambda:road_service.compute(db,request,U('dispatch')))['road']
        assert not answer['unassigned'] and len(answer['legs'])==2 and len(answer['geometry'])>2
        newplan.update(road_basis='valhalla_truck',road_id=answer['id']);road_results.append(answer)
    calculate_road(reported,'initial')
    body=dict(version=reported['version'],order_ids=newids,order_versions={i:r.order(i)['version'] for i in ids[2:]},route=newplan,idempotency_key='draft-1')
    r.step('RECOVERY','frozen_prefix_add_rejected','dispatch',lambda:api('/'+rid+'/draft',dict(body,order_ids=ids)),expect_error=True)
    drafted=r.step('RECOVERY','draft','dispatch',lambda:api('/'+rid+'/draft',body))['case']
    r.step('RECOVERY','stale_case_rejected','dispatch',lambda:api('/'+rid+'/draft',dict(body,idempotency_key='stale')),expect_error=True)
    def accept_case(c,key):return api('/'+rid+'/accept',dict(version=c['version'],idempotency_key=key,included_in_original_contract=True,links={i:newlink['id'] for i in ids[2:]},acceptance_ref='SIM-CARRIER-RESCUE-ACCEPT',approval_ref='SIM-CONTRACT-INCLUDES-RESCUE',handover_ref='SIM-FAULT-POINT-HANDOVER'),'procurement')
    accepted=r.step('RECOVERY','accept','procurement',lambda:accept_case(drafted,'accept-1'))['case']
    issued=r.step('RECOVERY','issue','dispatch',lambda:api('/'+rid+'/issue',dict(version=accepted['version'],idempotency_key='issue-1',evidence='SIM-RESCUE-F04')))['case']
    cancelbody=dict(version=issued['version'],idempotency_key='cancel-1',evidence='SIM handover slot re-confirmed')
    cancelled=r.step('RECOVERY','cancel_unexecuted','dispatch',lambda:api('/'+rid+'/cancel',cancelbody))['case']
    r.step('RECOVERY','cancel_retry','dispatch',lambda:api('/'+rid+'/cancel',cancelbody))
    assert db.execute("SELECT count(*) FROM route_bookings WHERE route_id=? AND cancelled=''",(drafted['route_id'],)).fetchone()[0]==0
    assert all(r.order(i)['status']=='exception' for i in ids[2:])
    assert recovery.vehicle_hold(db,route['resource_id'])
    calculate_road(cancelled,'after_cancel')
    drafted=r.step('RECOVERY','draft_after_cancel','dispatch',lambda:api('/'+rid+'/draft',dict(body,version=cancelled['version'],order_versions={i:r.order(i)['version'] for i in ids[2:]},idempotency_key='draft-2')))['case']
    accepted=r.step('RECOVERY','accept_after_cancel','procurement',lambda:accept_case(drafted,'accept-2'))['case']
    issued=r.step('RECOVERY','issue_after_cancel','dispatch',lambda:api('/'+rid+'/issue',dict(version=accepted['version'],idempotency_key='issue-2',evidence='SIM-RESCUE-F04-2')))['case']
    hb=dict(version=issued['version'],idempotency_key='handover',handed_at=DAY+'T11:20:00-05:00',location_id=reported['origin']['id'],driver='driver',plate='SIM-RESCUE',crew_id=plan['crew_id'],vehicle_id=vehicle['id'],evidence='SIM-ROAD-SIDE-TRANSFER',old_custodian_ref='SIM-ORIGINAL-DRIVER-SIGNED',receiving_driver_ref='SIM-RESCUE-DRIVER-SIGNED',safety_ref='SIM-SAFE-TRANSFER-BAY',tickets={i:dict(release_version=r.order(i)['issue_version'],pickup_code=r.order(i)['pickup_code'],sns=serials[i]) for i in ids[2:]})
    r.step('RECOVERY','wrong_vehicle_rejected','warehouse',lambda:api('/'+rid+'/handover',dict(hb,vehicle_id=plan['resource_id']),'warehouse'),expect_error=True)
    bad=copy.deepcopy(hb);bad['tickets'][ids[3]]['pickup_code']=old_tokens[ids[3]]['pickup_code']
    r.step('RECOVERY','second_ticket_old_code_atomic_rejected','warehouse',lambda:api('/'+rid+'/handover',bad,'warehouse'),expect_error=True)
    assert all(gate.active(db,i,1)['state']=='issued' for i in ids[2:])
    handover=r.step('RECOVERY','actual_handover','warehouse',lambda:api('/'+rid+'/handover',hb,'warehouse'))['case']
    r.step('RECOVERY','handover_retry','warehouse',lambda:api('/'+rid+'/handover',hb,'warehouse'))
    r.step('RECOVERY','executed_cancel_rejected','dispatch',lambda:api('/'+rid+'/cancel',dict(version=handover['version'],idempotency_key='invalid-cancel',evidence='SIM no')) ,expect_error=True)
    r.step(ids[3],'rescue_first_delivery','driver',lambda:deliver(ids[3],'12:10','12:50'))
    r.step(ids[2],'rescue_second_delivery','driver',lambda:deliver(ids[2],'13:30','14:10'))
    repairbody=dict(version=handover['version'],idempotency_key='actual-repair',repair_ref='SIM-REPAIR-WORKORDER',inspection_ref='SIM-MECHANICAL-INSPECTED',approval_ref='SIM-SUPERVISOR-RESUME')
    r.step('RECOVERY','repair_without_supervisor_rejected','dispatch',lambda:api('/'+rid+'/repair',repairbody),expect_error=True)
    r.step('RECOVERY','repaired_vehicle_resume','admin',lambda:api('/'+rid+'/repair',repairbody,'admin'))
    assert not recovery.vehicle_hold(db,route['resource_id'])
    assert frozen=={i:dict(db.execute('SELECT * FROM orders WHERE id=?',(i,)).fetchone()) for i in ids[:2]}
    assert all(g==dict(db.execute('SELECT * FROM gate_grants WHERE id=?',(g['id'],)).fetchone()) for g in original_grants.values())
    assert all(r.order(i)['status']=='delivered' for i in ids)
    assert db.execute("SELECT count(*) FROM assets WHERE state='delivered'").fetchone()[0]==4
    traces=[json.loads(x[0]) for x in db.execute('SELECT data FROM sim200_trace ORDER BY seq')]
    result=dict(case_id=rid,source_order_ids=ids,frozen_prefix=ids[:2],remaining_sequence=newids,status='passed',delivered=4,old_grants_unchanged=True,prefix_order_rows_byte_equal=True,old_auth_rejected=True,cancellation_preserves_custody=True,idempotency_no_duplicate_effects=True,atomic_handover_rejection=True,trace_events=len(traces),expected_rejections=sum(x['assertion']=='expected_rejection' for x in traces),road_basis='real Valhalla truck + VROOM from fault point; original run uses synthetic carrier fixture' if real_roads else 'synthetic carrier evidence; separate real-road integration required',scope='pure full-SN terminal delivery, original contracted executor, replacement vehicle, explicit witnessed fault point; no extra costs')
    path.mkdir(parents=True,exist_ok=True)
    (path/'recovery-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (path/'recovery-trace.json').write_text(json.dumps(traces,ensure_ascii=False,indent=2),encoding='utf-8')
    (path/'recovery-case.json').write_text(json.dumps(recovery.get(db,rid),ensure_ascii=False,indent=2),encoding='utf-8')
    if road_results:(path/'recovery-real-roads.json').write_text(json.dumps(road_results,ensure_ascii=False,indent=2),encoding='utf-8')
    db.close();return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',default='docs/sim200/recovery');p.add_argument('--real-roads',action='store_true');a=p.parse_args();print(json.dumps(run(a.output,a.real_roads),ensure_ascii=False,indent=2))

