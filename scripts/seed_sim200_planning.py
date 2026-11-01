"""Prepare a separate public SIM200 planning snapshot via profile maintenance APIs.

Travel facts are a labeled controlled synthetic carrier fixture, not road-engine
evidence. Original source DB is preserved. No completed business states are written.
"""
import argparse,json,sqlite3,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'v13'/'engine'))
import core,operations,planning,simulation,routing


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',default='docs/sim200/ready/SIM200.sqlite3')
    parser.add_argument('--output',default='docs/sim200/planning/SIM200.sqlite3')
    args=parser.parse_args();dest=Path(args.output);dest.parent.mkdir(parents=True,exist_ok=True)
    if Path(args.source).resolve()==dest.resolve():raise ValueError('source must remain unchanged')
    db=sqlite3.connect(dest);db.row_factory=sqlite3.Row
    with sqlite3.connect(args.source) as original:original.backup(db)
    simulation.only_demo(db);planning.init_db(db);resources=simulation.provision(db)
    user=simulation.actor('dispatch');calendar={};count=0
    rows=simulation.generate();order_map={r['order']['id']:core.get_order(db,r['order']['id'],user) for r in rows}
    for row in rows:
        oid=row['order']['id'];o=order_map[oid]
        if o['status']!='ready':continue
        day=o['window_start'][:10]
        if o.get('pickup') or o.get('procurement_mode') in {'platform','ltl'}:
            promise=dict(start=day+'T09:00',end=day+'T10:00',timezone=o['timezone'],acceptance_ref='SIM-NETWORK-CAPACITY-CONFIRMATION',
                capacity_units=40,pool_key='SIM-NETWORK-'+o['city'],authorized_collector='SIM 授权提货人',identity_ref='SIM-ID',handling_minor=0)
            operations.handle(db,'POST','/api/ops/plans/profiles/commitment',dict(id=oid,order_version=o['version'],evidence='SIM SUPPLIER PROMISE NOT CONTROLLED VEHICLE',data=promise),simulation.actor('procurement'))
        if o.get('pickup') or not o.get('selected_quote'):continue
        fleet=resources['fleets'][row['coverage']['vehicle_number']-1];vehicle=fleet['vehicle'];day=o['window_start'][:10]
        origin=routing.origin_resource(db,o['warehouse'])
        stop=dict(kg=226,height=191,length_cm=100,width_cm=83,lift_extra_kg=80,required_people=3 if o.get('addon_l4') else 2,
            required_tools='dolly,straps,stair_climber' if o.get('addon_l4') else 'dolly,straps',requires_lift='yes',service=20+20*o['quantity']+(30 if o.get('addon_l4') else 0),
            unload=10,admission=10,dock_ref='SIM-PUBLIC-ENTRANCE',package_ref='SIM-M01-PALLET-v1',finish_by=day+'T17:00')
        if o['route'] in {'C1','C2'}:
            station=resources['places'][o['city']+' station'];stop.update(station_id=station['id'],timezone=station['timezone'],window_start=day+'T09:00',window_end=day+'T17:00')
        starts=[origin['id']]+[p['id'] for p in order_map.values() if p['warehouse']==o['warehouse'] and p['window_start'][:10]==day and p['id']!=oid]
        legs={key:dict(travel=30 if key==origin['id'] else 20,road_ref='SIM-CONTROLLED-CARRIER-FIXTURE-NOT-REAL-ROAD',vehicle_id=vehicle['id'],vehicle_version=vehicle['version'],date=day) for key in starts}
        facts=dict(stop=stop,legs=legs)
        if o['route'] in {'C1','C2'}:
            last_stop={k:v for k,v in stop.items() if k not in ('station_id','timezone','window_start','window_end')}
            facts.update(last_stop=last_stop,last_legs={station['id']:dict(travel=30,road_ref='SIM-CONTROLLED-LAST-LEG-NOT-REAL-ROAD',vehicle_id=vehicle['id'],vehicle_version=vehicle['version'],date=day)},station_processing_minutes=30,station_capacity_units=30,station_capacity_ref='SIM-STATION-CAPACITY')
        operations.handle(db,'POST','/api/ops/plans/profiles/order',dict(id=oid,order_version=o['version'],evidence='SIM SYNTHETIC PACK/SERVICE/ROAD FIXTURE',data=facts),user)
        if o['route']=='C2':
            operations.handle(db,'POST','/api/ops/plans/profiles/stage',dict(id=oid,order_version=o['version'],evidence='SIM AUTHORIZED STAGE CONTRACT',data=dict(receiving_acceptance_ref='SIM-STATION-ACCEPT',storage_responsibility='SIM-STATION-CUSTODIAN',downstream_owner='procurement',downstream_deadline=day+'T17:00',valid_until='2036-12-31',currency='USD',amount_minor=40000,storage_daily_minor=1500,storage_capacity_units=30)),simulation.actor('procurement'))
        if o.get('addon_l5'):
            tech='sim_tech_'+str({'Dallas':1,'Houston':2,'Los Angeles':3,'Atlanta':4}[o['city']])
            offers=[dict(technician=tech,window_start=day+'T09:00',window_end=day+'T19:00',timezone=o['timezone'],service_minutes=30,amount_minor=0,price_included=True,qualification_ref='SIM-TECH-QUALIFICATION',tools_ref='SIM-TECH-TOOLS',reposition_seconds=3600)]
            operations.handle(db,'POST','/api/ops/plans/profiles/technical',dict(id=oid,order_version=o['version'],evidence='SIM TECHNICAL PURCHASE',data=dict(authorization_ref='SIM-TECH-COMMISSION',offers=offers)),simulation.actor('procurement'))
        profile=calendar.setdefault(vehicle['id'],dict(shifts={}))
        profile['shifts'][day]=[dict(start_times=['08:00','11:00','14:00'],road_basis='carrier',checks=dict(driver=fleet['driver'],shift_start=day+'T07:00',shift_end=day+'T19:00',warehouse_start=day+'T07:00',warehouse_end=day+'T17:00',return_min=30,scope_ref='SIM-FULL-PURCHASED-SCOPE',handling_ref='SIM-TOOLS-AND-PERSONNEL'))]
        count+=1
    for rid,data in calendar.items():
        operations.handle(db,'POST','/api/ops/plans/profiles/resource',dict(id=rid,evidence='SIM SYNTHETIC CREW SHIFT',data=data),user)
    db.commit()
    ids=['SIM200-053','SIM200-067','SIM200-081','SIM200-054','SIM200-068','SIM200-082']
    result=planning.optimize(db,dict(order_ids=ids,budget_seconds=10),user)
    assert result['plan']['coverage']['assigned']==len(ids),result['plan']['unassigned']
    db.commit()
    (dest.parent/'planning-summary.json').write_text(json.dumps(dict(profiles=count,resources=len(calendar),sample=result,
        note='公开道路为受控合成承运商依据；不等于真实货车道路或完整200票联合优化。'),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(database=str(dest),profiles=count,resources=len(calendar),sample_coverage=result['plan']['coverage']),ensure_ascii=False))


if __name__=='__main__':main()
