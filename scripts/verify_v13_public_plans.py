"""Exercise shared browser/native plan contracts against the public SIM fixture."""
import json,sqlite3,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'v13'/'engine'))
import planning,simulation,core
from unittest.mock import patch

path=ROOT/'docs/sim200/planning-public'
db=sqlite3.connect(path/'SIM200.sqlite3');db.row_factory=sqlite3.Row
user=simulation.actor('dispatch');results=[]
cases=[('C1',['SIM200-129'],'delivery_complete'),('L5',['SIM200-139'],'delivery_complete'),('C2-stage',['SIM200-159'],'authorized_stage'),
       ('pickup',['SIM200-189'],'delivery_complete'),('browser-six',['SIM200-053','SIM200-067','SIM200-081','SIM200-054','SIM200-068','SIM200-082'],'delivery_complete'),
       ('full-200',[f'SIM200-{i:03}' for i in range(1,201)],'delivery_complete')]
native=planning.planning_solver.choose
for label,ids,scope in cases:
    start=time.monotonic()
    def bounded(*a,**kw):return native(*a,**dict(kw,native=False))
    with patch.object(planning.planning_solver,'choose',side_effect=bounded if label=='browser-six' else native):
        plan=planning.optimize(db,dict(order_ids=ids,planning_scope=scope,budget_seconds=30),user)['plan']
    db.commit()
    if label!='full-200':assert plan['coverage']['assigned']==len(ids),(label,plan['unassigned'])
    if label=='C1':assert len(plan['routes'][0]['segments'])==2
    if label=='L5':assert plan['routes'][0]['technical_tasks']
    if label=='C2-stage':assert plan['coverage']['order_complete']==0 and plan['pending_legs']
    if label=='pickup':assert not plan['routes'][0]['occupancy']
    if label=='browser-six':assert plan['candidates'][0]['solver']['solver']=='bounded_exact_search'
    (path/(label+'.json')).write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8')
    results.append(dict(case=label,coverage=plan['coverage'],cost_minor=plan['total_minor'],seconds=time.monotonic()-start,metrics=plan['metrics'],status=plan['solve_status']))
# A real later station release must be rejected when processing misses all slots.
oid='SIM200-129';profile=planning.profiles(db,'order')[oid]
data={k:v for k,v in profile.items() if k!='profile_version'};data['station_processing_minutes']=600
planning.save_profile(db,'order',dict(id=oid,version=profile['profile_version'],order_version=core.get_order(db,oid,user)['version'],evidence='SIM STATION DELAY',data=data),user)
delayed=planning.optimize(db,dict(order_ids=[oid],budget_seconds=10),user,publish=False)['plan']
assert delayed['coverage']['assigned']==0
db.rollback()
(path/'station-delay.json').write_text(json.dumps(delayed,ensure_ascii=False,indent=2),encoding='utf8')
results.append(dict(case='station-processing-misses-onward',assigned=0,assertion='passed'))
(path/'cases-summary.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(results,ensure_ascii=False,indent=2))
