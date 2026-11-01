"""V13-specific optimizer regressions: exact known optima and fail-closed inputs."""
import copy
import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'v13' / 'engine'))
import core
import operations
import planning
import planning_solver as solver
import routing


def route(ids, price, vehicle='v', crew='c', start=100, end=200, **kw):
    return dict(order_ids=ids, total_minor=price, finish=end, occupancy=[
        dict(kind='vehicle', id=vehicle, start=start, end=end, start_location='w', end_location='w'),
        dict(kind='crew', id=crew, start=start, end=end, start_location='w', end_location='w')], **kw)


class Selection(unittest.TestCase):
    def check_both(self, ids, routes, expected):
        for native in (False, True):
            result = solver.choose(ids, routes, 3, native=native)
            self.assertTrue(result['proven'], result)
            self.assertEqual(set(result['indices']), set(expected), result)
    def test_sparse_skill_kept_for_difficult_order(self):
        self.check_both(['ordinary', 'stairs'], [route(['ordinary'], 10), route(['stairs'], 100), route(['ordinary'], 20, 'v2', 'c2')], [1, 2])
    def test_same_crew_across_vehicles_conflicts(self):
        self.check_both(['a', 'b'], [route(['a'], 10), route(['b'], 5, 'v2'), route(['b'], 30, 'v2', 'c2')], [0, 2])
    def test_complete_coverage_precedes_low_partial_cost(self):
        self.check_both(['a', 'b'], [route(['a'], 1), route(['a', 'b'], 9999999)], [1])
    def test_activation_cost_changes_actual_best_choice(self):
        self.check_both(['a', 'b'], [route(['a'], 10, activations={'fleet-day':100}), route(['b'], 10, 'v2', 'c2', activations={'fleet-day':100}), route(['a', 'b'], 150)], [0, 1])
        self.assertEqual(solver.cost([route(['a'],10,activations={'day':100}),route(['b'],10,activations={'day':100})]),120)
    def test_pool_capacity_cannot_be_counted_twice(self):
        pool = [{'key':'shared-day', 'quantity':1, 'capacity':1}]
        self.check_both(['a', 'b'], [route(['a'], 1,pools=pool),route(['b'],1,'v2','c2',pools=pool),route(['b'],3,'v3','c3')], [0, 2])
    def test_same_sn_cannot_be_reserved_twice(self):
        self.check_both(['a', 'b'], [route(['a'],1,sns=['x']),route(['b'],1,'v2','c2',sns=['x']),route(['b'],5,'v3','c3',sns=['y'])],[0,2])
    def test_nonoverlap_requires_reposition_between_origins(self):
        a=route(['a'],1,start=100,end=200);b=route(['b'],1,start=300,end=400)
        b['occupancy'][0]['start_location']='other'
        self.assertTrue(solver.conflict(a,b))
        b['occupancy'][0]['reposition_seconds']=99
        self.assertFalse(solver.conflict(a,b))
    def test_return_is_included_in_occupancy(self):
        self.assertTrue(solver.conflict(route(['a'],1,end=220),route(['b'],1,start=210,end=300)))
    def test_short_budget_never_claims_infeasibility(self):
        result=solver.choose([str(i) for i in range(30)],[route([str(i)],i,vehicle=str(i),crew=str(i)) for i in range(30)],.001,native=False)
        if result['exhausted']:
            self.assertFalse(result['proven'])


class Contracts(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        core.core_schema(self.db);operations.init_db(self.db);planning.init_db(self.db)
        self.user={'username':'dispatch','role':'dispatch'}
        self.admin={'username':'admin','role':'admin'}
        self.o=core.create_order(self.db,dict(customer='SIM',address='SIM public intersection',zip='75201',warehouse='SIM Dallas',model='SIM-M',quantity=1,route='B',level='L3',endpoint='SIM lobby',window_start='2030-07-10T08:00',window_end='2030-07-10T18:00',timezone='America/Chicago',lat=32.78,lng=-96.8),self.admin)
    def tearDown(self):self.db.close()
    def test_missing_cost_is_null_and_not_a_zero_price_winner(self):
        out=planning.optimize(self.db,{'order_ids':[self.o['id']]},self.user)['plan']
        self.assertIsNone(out['total_minor']);self.assertEqual(out['coverage']['assigned'],0)
        self.assertIn('COST_INCOMPLETE',[x['code'] for x in out['precheck']['issues']])
        self.assertEqual(out['validation_status'],'conditions_pending')
    def test_permissions_enforced_server_side(self):
        with self.assertRaises(core.ApiError) as e:
            operations.handle(self.db,'POST','/api/ops/plans/optimize',{'order_ids':[self.o['id']]},{'username':'driver','role':'driver'})
        self.assertEqual(e.exception.status,403)
    def test_unsupported_lock_not_silently_ignored(self):
        with self.assertRaisesRegex(core.ApiError,'LOCK_UNSUPPORTED'):
            planning.optimize(self.db,{'order_ids':[self.o['id']],'locks':{'supplier':'unknown'}},self.user)
    def test_unpublished_async_result_never_writes_candidate(self):
        out=planning.optimize(self.db,{'order_ids':[self.o['id']]},self.user,publish=False)['plan']
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM dispatch_plans').fetchone()[0],0)
        core.edit_order(self.db,self.o['id'],{'version':self.o['version'],'notes':'changed'},self.admin)
        with self.assertRaisesRegex(core.ApiError,'STALE_INPUT'):planning.save_result(self.db,out,self.user)
    def test_dst_repeated_and_missing_wall_time_rejected(self):
        self.assertIsNone(routing.local_utc('2026-11-01T01:30','America/Chicago'))
        self.assertIsNone(routing.local_utc('2026-03-08T02:30','America/Chicago'))
        self.assertIsNotNone(routing.local_utc('2026-11-01T01:30-05:00','America/Chicago'))
    def test_currency_precision_never_uses_float_rounding(self):
        self.assertEqual(planning.minor('12.34'),1234)
        for value in ('NaN','12.345',None,'-1'):
            self.assertIsNone(planning.minor(value))
    def test_price_card_is_procurement_only_and_missing_component_rejected(self):
        body=dict(id='SIM-RATE',evidence='SIM-RATE',data={})
        with self.assertRaises(core.ApiError) as e:planning.save_profile(self.db,'rate_card',body,self.user)
        self.assertEqual(e.exception.status,403)
        with self.assertRaises(core.ApiError) as e:planning.save_profile(self.db,'rate_card',body,{'username':'procurement','role':'procurement'})
        self.assertEqual(e.exception.status,422)
    def test_l5_requires_authorized_independent_technician_after_delivery(self):
        o=core.edit_order(self.db,self.o['id'],dict(version=self.o['version'],addon_l5=True),self.admin)
        self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES('tech','SIM technician','service','!')")
        r=dict(id='r',order_ids=[o['id']],planning_scope='delivery_complete',issues=[],occupancy=[],finish=0,total_minor=100,cost_items=[],
               check_result={'timeline':[dict(id=o['id'],departure='2030-07-10T15:00:00+00:00')]})
        missing=planning.technical_candidates(self.db,[r],{o['id']:o})
        self.assertEqual(missing[0]['issues'][0]['code'],'TECHNICAL_CAPACITY_REQUIRED')
        offer=dict(technician='tech',window_start='2030-07-10T08:00',window_end='2030-07-10T18:00',timezone='America/Chicago',service_minutes=30,
                   amount_minor=1500,price_included=False,qualification_ref='SIM-QUALIFIED',tools_ref='SIM-TOOLS',reposition_seconds=3600)
        planning.save_profile(self.db,'technical',dict(id=o['id'],order_version=o['version'],evidence='SIM-TECH',data=dict(authorization_ref='SIM-COMMISSION',offers=[offer])),{'username':'procurement','role':'procurement'})
        choices=planning.technical_candidates(self.db,[r],{o['id']:o})
        self.assertEqual(len(choices),3)
        self.assertTrue(all(c['occupancy'][0]['kind']=='technician' and c['technical_tasks'][0]['start_utc']>='2030-07-10T15:00:00+00:00' for c in choices))
        self.assertTrue(all(c['total_minor']==1600 for c in choices))

    def two_l5_tasks(self, minutes):
        first=core.edit_order(self.db,self.o['id'],dict(version=self.o['version'],addon_l5=True),self.admin)
        second=core.create_order(self.db,{**{k:first[k] for k in core.FIELDS if k in first},'customer':'SIM second customer','address':'SIM second actual site','crm_ref':'SIM-L5-TWO'},self.admin)
        self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES('tech','SIM technician','service','!')")
        for o in (first,second):
            offer=dict(technician='tech',window_start='2030-07-10T08:00',window_end='2030-07-10T18:00',timezone='America/Chicago',service_minutes=minutes,
                       amount_minor=1500,price_included=False,qualification_ref='SIM-QUALIFIED',tools_ref='SIM-TOOLS',reposition_seconds=3600)
            planning.save_profile(self.db,'technical',dict(id=o['id'],order_version=o['version'],evidence='SIM-TECH',data=dict(authorization_ref='SIM-COMMISSION',offers=[offer])),{'username':'procurement','role':'procurement'})
        r=dict(id='two-stops',order_ids=[first['id'],second['id']],planning_scope='delivery_complete',issues=[],occupancy=[],finish=0,total_minor=100,cost_items=[],
               check_result={'timeline':[dict(id=first['id'],departure='2030-07-10T15:00:00+00:00'),dict(id=second['id'],departure='2030-07-10T15:30:00+00:00')]})
        return [first['id'],second['id']],planning.technical_candidates(self.db,[r],{o['id']:o for o in (first,second)})

    def test_same_route_cannot_double_book_one_technician(self):
        ids,candidates=self.two_l5_tasks(120)
        self.assertTrue(candidates)
        self.assertTrue(all(any(e['code']=='TECHNICAL_CAPACITY_REQUIRED' for e in c['issues']) for c in candidates))
        for native in (False,True):
            selected=solver.choose(ids,[c for c in candidates if not c['issues']],1,native=native)
            self.assertEqual(selected['indices'],[])

    def test_same_route_technician_needs_reposition_between_customer_sites(self):
        ids,candidates=self.two_l5_tasks(30)
        feasible=[c for c in candidates if not c['issues']]
        self.assertEqual(len(feasible),1)
        tasks=feasible[0]['technical_tasks']
        self.assertEqual(tasks[0]['end_utc'],'2030-07-10T15:30:00+00:00')
        self.assertEqual(tasks[1]['start_utc'],'2030-07-10T16:30:00+00:00')
        for native in (False,True):
            self.assertEqual(solver.choose(ids,feasible,1,native=native)['indices'],[0])

    def test_staff_deactivation_invalidates_unpublished_plan(self):
        self.db.execute("INSERT INTO users(username,name,role,passhash) VALUES('tech','SIM technician','service','!')")
        result=planning.optimize(self.db,{'order_ids':[self.o['id']]},self.user,publish=False)['plan']
        self.db.execute("UPDATE users SET active=0 WHERE username='tech'")
        with self.assertRaisesRegex(core.ApiError,'STALE_INPUT'):
            planning.save_result(self.db,result,self.user)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM dispatch_plans').fetchone()[0],0)

    def test_atomic_adoption_rolls_back_first_route_when_second_fails(self):
        from unittest.mock import patch
        ids=[self.o['id']];pid='PLAN-ATOMIC'
        planning.plan_save(self.db,dict(id=pid,version=1,state='candidates_ready',order_ids=ids,input_hash=planning.snapshot(self.db,ids,self.user)[1],
            candidates=[dict(id='a',unassigned=[],validation_status='passed',routes=[{},{}])]))
        calls=[]
        def save(*args,**kwargs):
            if calls:raise core.ApiError(409,'simulated second route conflict')
            calls.append(1);self.db.execute("INSERT INTO registry VALUES('SIM-FIRST','route',1,'{}')")
            return {'route':{'id':'SIM-FIRST','check_result':{'issues':[]}}}
        # This unit test isolates savepoint rollback; real structure/coverage
        # validation is exercised by the lock/candidate acceptance suite.
        with patch.object(planning,'validate_adoption'),patch.object(operations,'save_route',side_effect=save):
            with self.assertRaises(core.ApiError):planning.adopt(self.db,pid,dict(version=1,candidate_id='a',idempotency_key='once'),self.user)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM registry WHERE id='SIM-FIRST'").fetchone()[0],0)
        self.assertEqual(planning.plan_get(self.db,pid)['version'],1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM dispatch_idempotency').fetchone()[0],0)
    def test_floor_space_is_released_per_stop_and_freeform_pickup_rejected(self):
        vehicle=operations.save_resource(self.db,dict(type='vehicle',name='SIM',capacity_units=3,floor_width_cm=240,floor_length_cm=650,door_width_cm=230),self.admin)['resource']
        orders=[dict(id='a',quantity=2),dict(id='b',quantity=1)]
        stop=dict(length_cm=100,width_cm=100,kg=226)
        r=dict(id='r',resource_id=vehicle['id'],stops={'a':stop,'b':stop})
        errors,loads=planning.strict_load(self.db,r,orders)
        self.assertFalse(errors)
        self.assertEqual([x['floor_length_cm'] for x in loads],[200,100,100,0])
        self.assertEqual(loads[-1]['units'],0)
        r['stops']['a']=dict(stop,pickup_quantity=1,pickup_sns=['unapproved'])
        errors,_=planning.strict_load(self.db,r,orders)
        self.assertIn('PICKUP_CHAIN_REQUIRED',[e['code'] for e in errors])


if __name__=='__main__':unittest.main()
