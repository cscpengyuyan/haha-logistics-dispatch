"""Real V13 API candidate generation / CP-SAT / adoption integration on SIM200.

Needs an existing ready-phase SIM200 database and genuine Valhalla/VROOM URLs.
Uses synthetic business evidence and real road calculations, recorded separately.
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'v13'/'engine'))
import core, operations, planning, simulation


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',default='docs/sim200/ready/SIM200.sqlite3')
    parser.add_argument('--output',default='docs/verification/v13/optimizer-live')
    args=parser.parse_args()
    path=Path(args.output);path.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path/'optimizer.sqlite3');db.row_factory=sqlite3.Row
    with sqlite3.connect(args.source) as source:source.backup(db)
    planning.init_db(db)
    resource=simulation.provision(db)
    rows={r['order']['id']:r for r in simulation.generate()}
    ids=['SIM200-053','SIM200-067','SIM200-081','SIM200-054','SIM200-068','SIM200-082']
    user=simulation.actor('dispatch')
    for oid in ids:
        o=core.get_order(db,oid,user);metadata=rows[oid]['coverage'];fleet=resource['fleets'][metadata['vehicle_number']-1]
        day=o['window_start'][:10]
        planning.save_profile(db,'order',dict(id=oid,order_version=o['version'],evidence='SIM-PACK-AND-SERVICE-CONFIRMATION',data={'stop':dict(kg=226,height=191,length_cm=100,width_cm=83,lift_extra_kg=80,required_people=2,required_tools='dolly,straps',requires_lift='yes',service=40,unload=10,admission=10,dock_ref='SIM-ENTRANCE-CONFIRMATION',package_ref='SIM-M01-PALLET-v1',finish_by=day+'T17:00')}),user)
        # Multiple real physical vehicle/day alternatives; each uses its own driver.
        rid=fleet['vehicle']['id'];prior=db.execute("SELECT version,data FROM dispatch_profiles WHERE kind='resource' AND id=?",(rid,)).fetchone()
        data=json.loads(prior['data']) if prior else {'shifts':{}}
        data['shifts'][day]=[dict(start_times=['08:00','10:00'],road_basis='estimate',checks=dict(driver=fleet['driver'],shift_start=day+'T07:00',shift_end=day+'T19:00',warehouse_start=day+'T07:00',warehouse_end=day+'T17:00',return_min=25,scope_ref='SIM-SCOPE',handling_ref='SIM-TOOLS'))]
        planning.save_profile(db,'resource',dict(id=rid,version=prior['version'] if prior else None,evidence='SIM-RESOURCE-CALENDAR',data=data),user)
    db.commit()
    results=[]
    for label in ['cold','warm']:
        start=time.monotonic()
        result=operations.handle(db,'POST','/api/ops/plans/optimize',dict(order_ids=ids,objective='lowest_cost',planning_scope='delivery_complete',calculate_roads=True,budget_seconds=120),user)
        db.commit();plan=result['plan']
        (path/(label+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        assert plan['coverage']['assigned']==len(ids), (plan['coverage'],plan['road_errors'],plan['unassigned'])
        assert plan['validation_status']=='passed',plan['precheck']
        assert plan['candidates'][0]['solver']['solver']=='OR-Tools CP-SAT'
        assert all(r['road_basis']=='valhalla_truck' and r['road'].get('return_leg') for r in plan['routes'])
        assert sum(x['amount_minor'] for x in plan['cost_items'])==plan['total_minor']
        results.append(dict(run=label,plan_id=plan['id'],seconds=time.monotonic()-start,coverage=plan['coverage'],cost_minor=plan['total_minor'],route_count=len(plan['routes']),metrics=plan['metrics'],solver=plan['candidates'][0]['solver']))
    adopt_body=dict(version=plan['version'],candidate_id=plan['candidates'][0]['id'],idempotency_key='SIM-ADOPT-ONCE')
    with db:adopted=operations.handle(db,'POST',f"/api/ops/plans/{plan['id']}/adopt",adopt_body,user)
    with db:repeated=operations.handle(db,'POST',f"/api/ops/plans/{plan['id']}/adopt",adopt_body,user)
    assert adopted==repeated
    count=db.execute("SELECT count(*) FROM registry WHERE type='route'").fetchone()[0]
    rejected=False
    try:
        with db:operations.handle(db,'POST',f"/api/ops/plans/{plan['id']}/adopt",dict(adopt_body,candidate_id='different'),user)
    except core.ApiError as error:rejected=error.status==409
    assert rejected
    summary=dict(business_data='SIM synthetic evidence',roads='Real Valhalla truck / VROOM',road_data_date=os.getenv('HH_ROAD_DATA_DATE'),results=results,
                 adoption='passed',idempotent_retry='passed',different_payload_same_key='rejected 409',saved_routes=count)
    (path/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
