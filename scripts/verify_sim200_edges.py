"""Focused scenario copies for actual D replenishment and shortage replacement.

Never edits the completed SIM200 acceptance database or public snapshot.
"""
import argparse,json,sys
from pathlib import Path
from run_sim200 import Replay,ROOT,U
import core,simulation,supply,lifecycle

def verify(output):
    run=Replay(output);db=run.db
    run.resources=simulation.provision(db);db.commit()
    wh=run.resources['places']['Dallas'];target=run.resources['places']['Houston']
    def step(name,role,fn,reject=False):return run.step('SIM200-005-D-copy',name,role,fn,expect_error=reject)
    def plan(demand):return supply.stock_plan(db,dict(warehouse_id=target['id'],model='M01',horizon='2026-11-14T23:59:00-06:00',demand=demand,safety=1),U('warehouse'))
    low,base,high=[step('target_'+str(n),'warehouse',lambda n=n:plan(n)) for n in (0,2,4)]
    assert [v['suggested'] for v in (low,base,high)]==[1,3,5]
    for n in range(1,4):
        sn=f'SIM-D-FUTURE-{n}'
        step('source_'+sn,'warehouse',lambda:lifecycle.receipt(db,dict(sn=sn,warehouse=wh['name'],model='M01',bin='SIM-A',condition='SIM 合格',batch='SIM-D-FUTURE-SOURCE',evidence='SIM-GRN',state='available'),U('warehouse')))
        task=step('request_'+sn,'warehouse',lambda:supply.position(db,dict(action='request',sn=sn,version=1,target_id=target['id'],storage_right_ref='SIM TARGET-STOCK-3',evidence='SIM 人工目标库存补货依据'),U('warehouse')))
        step('send_before_approval_'+sn,'warehouse',lambda:supply.transfer(db,dict(action='send',sn=sn,version=1,target_id=target['id'],approval_ref='SIM-D-APPROVAL',custodian='SIM 承运人',evidence='SIM-SEND'),U('warehouse')),reject=True)
        step('same_person_approval_'+sn,'warehouse',lambda:supply.position(db,dict(action='approve',id=task['id'],version=1,approval_ref='SIM-D-APPROVAL'),dict(role='admin',username='warehouse')),reject=True)
        step('approve_'+sn,'admin',lambda:supply.position(db,dict(action='approve',id=task['id'],version=1,approval_ref='SIM-D-APPROVAL'),U('admin')))
        approved=step('approved_stock_'+sn,'warehouse',lambda:plan(2));assert approved['eligible']==n-1
        step('send_'+sn,'warehouse',lambda:supply.transfer(db,dict(action='send',sn=sn,version=1,target_id=target['id'],approval_ref='SIM-D-APPROVAL',custodian='SIM 承运人',evidence='SIM-SEND'),U('warehouse')))
        travelling=step('in_transit_stock_'+sn,'warehouse',lambda:plan(2));assert travelling['eligible']==n-1
        step('accept_'+sn,'warehouse',lambda:supply.transfer(db,dict(action='accept',sn=sn,version=2,bin='SIM-HOU',condition='SIM 实收合格',state='available',custodian='SIM Houston',evidence='SIM-DEST-GRN'),U('warehouse')))
        received=step('received_stock_'+sn,'warehouse',lambda:plan(2));assert received['eligible']==n
    assert received['suggested']==0

    # Two demanded units, one missing original SN, one extra replacement candidate on manifest.
    row=simulation.generate()[93];oid=row['order']['id'];m=row['coverage'];original=m['serials'][0];good=m['serials'][1];replacement='SIM-REPLACEMENT-094-01'
    o=dict(row['order']);o['simulation_id']=o.pop('id')
    run.step(oid,'sales_create_copy','sales',lambda:core.create_order(db,o,U('sales')))
    units=[dict(sn=sn,model='M01',order_id=oid if sn!=replacement else None) for sn in (original,good,replacement)]
    booked=run.step(oid,'book_shortage_copy','warehouse',lambda:supply.book(db,dict(voyage='SIM-EDGE-SEA',batch='SIM-EDGE-SEA',container='SIM-CN-EDGE',asn='SIM-EDGE-ASN',origin='SIM Shanghai',port='SIM Houston',warehouse_id=wh['id'],warehouse_zone=wh['timezone'],origin_zone='Asia/Shanghai',port_zone='America/Chicago',owner='warehouse',procurement_ref='SIM-BOOK-APPROVED',evidence='SIM-BOOK',mode='FCL',inland='road',seal='SIM-SEAL',bill_of_lading='SIM-BL',pickup_site='SIM-PORT',inland_owner='SIM-DRAY',planned_etd='2026-10-01T10:00:00+08:00',planned_eta='2026-10-24T10:00:00-05:00',planned_warehouse='2026-10-25T10:00:00-05:00',units=units),U('warehouse')))
    sid=booked['shipment']['id']
    events=[('shipping_docs','2026-09-30T10:00:00+08:00'),('loaded','2026-10-01T10:00:00+08:00'),('arrived','2026-10-24T10:00:00-05:00'),('handoff_site','2026-10-24T11:00:00-05:00'),('customs','2026-10-24T12:00:00-05:00'),('carrier_release','2026-10-24T13:00:00-05:00'),('terminal_ready','2026-10-24T14:00:00-05:00'),('pickup','2026-10-24T15:00:00-05:00'),('warehouse_arrival','2026-10-25T10:00:00-05:00')]
    for kind,at in events:
        run.step(oid,'ocean_'+kind,'warehouse',lambda kind=kind,at=at:supply.milestone(db,dict(id=sid,version=supply.shipment(db,sid)['version'],kind=kind,at=at,custodian='SIM-SEA',evidence='SIM-'+kind),U('warehouse')),at)
    for kind,sn in [('short',original),('damage',replacement)]:
        run.step(oid,'difference_'+kind,'warehouse',lambda kind=kind,sn=sn:supply.discrepancy(db,dict(id=sid,version=supply.shipment(db,sid)['version'],kind=kind,sn=sn,owner='warehouse',custodian='SIM-QC',evidence='SIM-DIFF-'+kind),U('warehouse')))
    def receive(sn,state):return supply.receive(db,dict(id=sid,version=supply.shipment(db,sid)['version'],sn=sn,state=state,bin='SIM-QC',condition='SIM 货况核对',evidence='SIM-GRN-'+sn,custodian='warehouse'),U('warehouse'))
    run.step(oid,'damaged_direct_available_rejected','warehouse',lambda:receive(replacement,'available'),expect_error=True)
    run.step(oid,'receive_good','warehouse',lambda:receive(good,'available'))
    run.step(oid,'receive_replacement_hold','warehouse',lambda:receive(replacement,'hold'))
    run.step(oid,'short_sn_reserve_rejected','warehouse',lambda:run.action(oid,'ready','warehouse',sn=original+','+good,release_ref='SIM-SHORT-BLOCK'),expect_error=True)
    run.step(oid,'hold_sn_reserve_rejected','warehouse',lambda:run.action(oid,'ready','warehouse',sn=replacement+','+good,release_ref='SIM-HOLD-BLOCK'),expect_error=True)
    run.step(oid,'replacement_qc_release','warehouse',lambda:lifecycle.inspect_asset(db,dict(sn=replacement,version=db.execute('SELECT version FROM assets WHERE sn=?',(replacement,)).fetchone()[0],state='available',bin='SIM-A',condition='SIM 包装修复并复检合格',evidence='SIM-QC-RELEASE'),U('warehouse')))
    run.step(oid,'replacement_authority','warehouse',lambda:run.action(oid,'note','warehouse',note=f'SIM 合法换配：原预报 {original} 实际短少，改配已实收复检 {replacement}，另一台 {good} 保留；授权 SIM-REPLACEMENT-OK。'))
    row['coverage']['serials']=[replacement,good]
    run.flow(row)
    assert run.order(oid)['status']=='settled'
    assert not db.execute('SELECT 1 FROM assets WHERE sn=?',(original,)).fetchone()
    assert db.execute('SELECT receipt FROM manifest WHERE sn=?',(original,)).fetchone()[0] is None
    assert set(run.order(oid)['completed_sns'])=={replacement,good}
    states=dict(db.execute('SELECT state,count(*) FROM assets GROUP BY state'))
    assert states=={'available':3,'delivered':2}
    traces=[json.loads(r[0]) for r in db.execute('SELECT data FROM sim200_trace ORDER BY seq')]
    (output/'trace.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in traces),encoding='utf8')
    result=dict(copy_id='SIM200-edge-cases-v1',source_main_ids=['SIM200-005','SIM200-094'],T39=dict(status='passed_business_api',low=1,base=3,high=5,requested=3,approved_by_independent_admin=True,stock_increases_only_after_receipt=True,final_available=3,remaining_replenishment=0),
        T42=dict(status='passed_business_api',manifest_units=3,actual_receipts=2,missing_original=original,replacement=replacement,quarantine_rejections=2,final_order_state='settled',delivered_sns=run.order(oid)['completed_sns']),
        T06=dict(status='not_implemented',reason='strict_load only decreases delivery quantities; no pickup load delta'),T30=dict(status='not_implemented',reason='No executed-prefix/current-location/onboard-SN planning input contract'),
        inventory=states,trace_events=len(traces),actual_expected_rejections=sum(t['assertion']=='expected_rejection' for t in traces))
    (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');db.close();return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',default='docs/sim200/edge-cases');a=p.parse_args();print(json.dumps(verify(ROOT/a.output),ensure_ascii=False))
