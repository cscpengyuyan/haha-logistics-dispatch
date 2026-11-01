"""T26/T27: real SIM business inputs plus controlled solver deadline boundaries.

The public fixture is opened read-only and copied to memory. Deadline injection
is deterministic and is not represented as a hardware performance benchmark.
"""
import copy
import sqlite3
import sys
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'v13/engine'))
import core,operations,planning,planning_solver as solver,simulation


def candidate(ids,price=100,vehicle='v'):
    return dict(order_ids=ids,total_minor=price,finish=200,occupancy=[dict(kind='vehicle',id=vehicle,start=100,end=200,start_location='w',end_location='w')])


def deadline_result(ids,routes,budget=1,objective='lowest_cost',found=True):
    # start, root, first feasible leaf, next branch deadline, result timestamp.
    ticks=iter([0,0,0,2,2] if found else [0,2,2])
    clock=SimpleNamespace(monotonic=lambda:next(ticks,2))
    with patch.object(solver,'time',clock):
        return solver.choose(ids,routes,1,objective,native=False)


class LockAcceptance(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        source=(ROOT/'v13/data/sim200-ready.sqlite3').as_posix()
        with closing(sqlite3.connect('file:'+source+'?mode=ro',uri=True)) as fixture:fixture.backup(self.db)
        planning.init_db(self.db);self.user=simulation.actor('dispatch')
    def tearDown(self):self.db.close()
    def solve(self,ids=('SIM200-053',),**values):
        return planning.optimize(self.db,dict(order_ids=list(ids),budget_seconds=3,**values),self.user,publish=False)['plan']
    def assert_lock_blocked(self,key,value,ids=('SIM200-053',)):
        before=self.solve(ids);self.assertEqual(before['coverage']['assigned'],len(ids))
        locks={key:value};result=self.solve(ids,locks=locks)
        self.assertEqual(result['coverage']['assigned'],0)
        self.assertEqual(result['locks'],locks)
        relevant=[x for x in result['lock_conflicts'] if x['field']=='locks.'+key]
        self.assertTrue(relevant)
        self.assertTrue(all(x['requested_value']==value and x['automatic_relaxation'] is False for x in relevant))
        self.assertTrue(any(x['otherwise_feasible'] for x in relevant))
        self.assertTrue(any(x['code']=='LOCK_CONFLICT' and x['next_step'] for u in result['unassigned'] for x in u['reasons']))
        self.assertEqual(result['validation_status'],'conditions_pending')
        return result
    def test_T26_wrong_vehicle_lock_names_conflict_and_keeps_original_lock(self):
        good=self.solve()['routes'][0]['resource_id']
        other=self.db.execute("SELECT id FROM registry WHERE type='vehicle' AND id<>? LIMIT 1",(good,)).fetchone()[0]
        result=self.assert_lock_blocked('vehicle_id',other)
        self.assertTrue(any(good in x['suggested_values'] for x in result['lock_conflicts']))
    def test_T26_wrong_crew_lock_offers_confirmed_candidate_crew(self):
        good=self.solve()['routes'][0]['crew_id']
        other=self.db.execute("SELECT id FROM registry WHERE type='crew' AND id<>? LIMIT 1",(good,)).fetchone()[0]
        result=self.assert_lock_blocked('crew_id',other)
        self.assertTrue(any(good in x['suggested_values'] for x in result['lock_conflicts']))
    def test_T26_date_lock_does_not_move_a_supplier_promise(self):
        result=self.assert_lock_blocked('date','2035-01-01',('SIM200-189',))
        self.assertTrue(any(r.get('kind')=='pickup' for r in result['draft_routes']))
        self.assertTrue(all(r['date']!='2035-01-01' for r in result['draft_routes']))
    def test_T26_supplier_promise_cannot_bypass_specific_vehicle_lock(self):
        vehicle=self.db.execute("SELECT id FROM registry WHERE type='vehicle' LIMIT 1").fetchone()[0]
        result=self.assert_lock_blocked('vehicle_id',vehicle,('SIM200-189',))
        self.assertTrue(any(x['candidate_values']==[None] for x in result['lock_conflicts']))
    def test_T26_complete_chain_checks_future_leg_and_uncontrolled_first_leg(self):
        before=self.solve(('SIM200-129',));self.assertEqual(before['coverage']['assigned'],1)
        route=before['routes'][0];self.assertEqual(len(route['segments']),2)
        vehicle=route['segments'][-1]['resource_id']
        result=self.solve(('SIM200-129',),locks={'vehicle_id':vehicle})
        self.assertEqual(result['coverage']['assigned'],0)
        self.assertTrue(any(len(x['candidate_values'])==2 and None in x['candidate_values'] for x in result['lock_conflicts']))
        physical=dict(id='two-leg',issues=[],order_ids=['a'],resource_id='first',crew_id='c',date='2030-01-01',segments=[dict(order_ids=['a'],resource_id='first',crew_id='c',date='2030-01-01'),dict(order_ids=['a'],resource_id='second',crew_id='c',date='2030-01-01')])
        errors=planning.lock_issues(physical,{'vehicle_id':'first'})
        self.assertEqual(errors[0]['candidate_values'],['first','second'])
    def test_T26_station_order_lock_is_preserved_for_each_route_segment(self):
        r=dict(id='r',issues=[],order_ids=['a','b'])
        locked={'station_order':['b','a']};original=copy.deepcopy(locked)
        errors=planning.lock_issues(r,locked)
        self.assertEqual(errors[0]['field'],'locks.station_order')
        self.assertEqual(errors[0]['suggested_values'],[['a','b']])
        self.assertEqual(locked,original)
        self.assertEqual(planning.lock_issues({**r,'order_ids':['b','a']},locked),[])
    def test_T26_compatible_lock_keeps_a_valid_candidate(self):
        route=self.solve()['routes'][0]
        locks=dict(vehicle_id=route['resource_id'],crew_id=route['crew_id'],date=route['date'],station_order=route['order_ids'])
        result=self.solve(locks=locks)
        self.assertEqual(result['coverage']['assigned'],1)
        self.assertEqual(result['locks'],locks)
        self.assertTrue(all(not planning.lock_issues(r,locks) for r in result['routes']))
    def test_T27_plan_timeout_with_solution_retains_it_when_later_passes_find_none(self):
        original=solver.choose;calls=[]
        def run(ids,routes,budget,objective):
            calls.append(objective)
            with patch.object(solver,'choose',original):return deadline_result(ids,routes,objective=objective,found=len(calls)==1)
        with patch.object(solver,'choose',side_effect=run):result=self.solve()
        self.assertEqual(result['solve_status'],'budget_exhausted_with_solution')
        self.assertEqual(result['coverage']['assigned'],1)
        self.assertEqual(result['optimality_scope'],'verified_feasible')
        self.assertFalse(result['candidates'][0]['solver']['proven'])
    def test_T27_plan_without_solution_reports_timeout_not_resource_infeasibility(self):
        original=solver.choose
        def run(ids,routes,budget,objective):
            with patch.object(solver,'choose',original):return deadline_result(ids,routes,objective=objective,found=False)
        with patch.object(solver,'choose',side_effect=run):result=self.solve()
        self.assertEqual(result['solve_status'],'timeout_no_solution')
        self.assertEqual(result['coverage']['assigned'],0)
        self.assertEqual(result['optimality_scope'],'undetermined')
        self.assertIn('SEARCH_BUDGET_EXHAUSTED',[x['code'] for u in result['unassigned'] for x in u['reasons']])
        self.assertEqual(result['validation_status'],'conditions_pending')
    def test_T27_later_pass_feasible_solution_is_not_hidden_by_first_timeout(self):
        original=solver.choose;calls=[]
        def run(ids,routes,budget,objective):
            calls.append(objective)
            with patch.object(solver,'choose',original):return deadline_result(ids,routes,objective=objective,found=len(calls)>1)
        with patch.object(solver,'choose',side_effect=run):result=self.solve()
        self.assertEqual(result['coverage']['assigned'],1)
        self.assertEqual(result['solve_status'],'budget_exhausted_with_solution')
        self.assertEqual(result['routes'],result['candidates'][0]['routes'])
        self.assertEqual(result['optimality_scope'],'verified_feasible')
    def test_T27_timeout_retry_preserves_previous_saved_feasible_plan(self):
        previous=planning.optimize(self.db,dict(order_ids=['SIM200-053'],budget_seconds=3),self.user)['plan']
        self.assertEqual(previous['coverage']['assigned'],1)
        saved_before=self.db.execute('SELECT data FROM dispatch_plans WHERE id=?',(previous['id'],)).fetchone()[0]
        original=solver.choose
        def run(ids,routes,budget,objective):
            with patch.object(solver,'choose',original):return deadline_result(ids,routes,objective=objective,found=False)
        with patch.object(solver,'choose',side_effect=run):
            timed=planning.optimize(self.db,dict(order_ids=['SIM200-053'],budget_seconds=3),self.user)['plan']
        self.assertNotEqual(previous['id'],timed['id'])
        self.assertEqual(timed['solve_status'],'timeout_no_solution')
        self.assertEqual(self.db.execute('SELECT data FROM dispatch_plans WHERE id=?',(previous['id'],)).fetchone()[0],saved_before)
    def test_server_generated_chain_still_adopts_all_current_and_future_coverage(self):
        plan=self.solve(('SIM200-129',));planning.plan_save(self.db,plan)
        out=planning.adopt(self.db,plan['id'],dict(version=1,candidate_id=plan['candidates'][0]['id'],idempotency_key='valid-chain'),self.user)
        current=out['routes']+out['plan']['adopted_commitments']
        self.assertEqual({oid for r in current for oid in r['order_ids']},{'SIM200-129'})
        self.assertEqual({oid for r in out['plan']['future_segments'] for oid in r['order_ids']},{'SIM200-129'})
    def test_persisted_chain_cannot_omit_future_segment_coverage(self):
        plan=self.solve(('SIM200-129',));plan['candidates'][0]['routes'][0]['future_segments']=[]
        planning.plan_save(self.db,plan)
        with self.assertRaisesRegex(core.ApiError,'PLAN_STRUCTURE_CONFLICT'):
            planning.adopt(self.db,plan['id'],dict(version=1,candidate_id=plan['candidates'][0]['id'],idempotency_key='broken-chain'),self.user)
    def test_chain_builder_does_not_invent_a_return_to_origin(self):
        plan=self.solve(('SIM200-129',));first,second=copy.deepcopy(plan['routes'][0]['segments'])
        first['occupancy']=[dict(kind='vehicle',id='SIM same truck',start=100,end=200,start_location=first['warehouse'],end_location='SIM actual open endpoint')]
        second['occupancy']=[dict(kind='vehicle',id='SIM same truck',start=300,end=400,start_location=first['warehouse'],end_location=second['warehouse'])]
        o=core.get_order(self.db,'SIM200-129',self.user)
        with patch.object(planning,'generated',return_value=([second],False)),patch.object(planning,'evaluated',return_value=second):
            choices=planning.complete_chains(self.db,[first],{o['id']:o},{})
        self.assertEqual(choices,[])
        self.assertEqual(first['occupancy'][0]['end_location'],'SIM actual open endpoint')


class CandidateBoundaryAcceptance(unittest.TestCase):
    def setUp(self):
        from test_v13_capacity_origin_acceptance import BusinessFixture,user
        self.f=BusinessFixture();self.db=self.f.db;self.user=user('dispatch');self.addCleanup(self.db.close)
        self.wh=self.f.warehouse('SIM boundary');self.orders=[self.f.order(self.wh),self.f.order(self.wh)]
        self.a=self.f.vehicle('SIM locked A',2);self.b=self.f.vehicle('SIM actual B',2);self.crew=self.f.crew('SIM crew')
        self.r=self.f.route(self.orders,self.wh,self.b,self.crew,'sim_driver_a');self.ids=[o['id'] for o in self.orders]
        self.segment=copy.deepcopy(self.r);self.segment.update(resource_id=self.a['id'],order_ids=self.ids[:1],order_versions={self.ids[0]:self.orders[0]['version']},stops={self.ids[0]:self.r['stops'][self.ids[0]]})
    def plan(self):return self.f.optimize(self.orders)
    def reject_adopt(self,plan):
        planning.plan_save(self.db,plan)
        before=self.db.execute("SELECT COUNT(*) FROM registry WHERE type='route'").fetchone()[0]
        with self.assertRaisesRegex(core.ApiError,'PLAN_STRUCTURE_CONFLICT'):
            planning.adopt(self.db,plan['id'],dict(version=plan['version'],candidate_id=plan['candidates'][0]['id'],idempotency_key='reject-derived'),self.user)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM registry WHERE type='route'").fetchone()[0],before)
        self.assertEqual(planning.plan_get(self.db,plan['id'])['state'],'candidates_ready')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM dispatch_idempotency').fetchone()[0],0)
    def test_client_cannot_inject_any_internal_derived_route_fields(self):
        for key,value in dict(segments=[self.segment],future_segments=[self.segment],kind='supplier_commitment',dependencies=[],technical_tasks=[],occupancy=[],pools=[],activations={},load_profile=[],cost_items=[],validation_status='passed',end_location=self.wh['name']).items():
            with self.subTest(field=key):
                injected=copy.deepcopy(self.r);injected[key]=value
                with self.assertRaisesRegex(core.ApiError,'ROUTE_DERIVED_FIELDS') as caught:
                    planning.optimize(self.db,dict(order_ids=self.ids,locks={'vehicle_id':self.a['id']},route_candidates=[injected]),self.user)
                self.assertEqual(caught.exception.status,422)
    def test_evaluated_allowlist_discards_derived_type_chain_and_fake_return(self):
        poisoned=copy.deepcopy(self.r);poisoned.update(segments=[self.segment],kind='supplier_commitment',end_location=self.wh['name']);poisoned['checks']['return_min']=0
        result=planning.evaluated(self.db,poisoned,{o['id']:o for o in self.orders},'delivery_complete')
        self.assertNotIn('kind',result);self.assertNotIn('segments',result)
        self.assertTrue(all(x['end_location']==self.ids[-1] for x in result['occupancy']))
    def test_locks_check_top_level_even_when_forged_nested_segment_matches(self):
        poisoned=dict(self.r,issues=[],segments=[self.segment])
        errors=planning.lock_issues(poisoned,{'vehicle_id':self.a['id']})
        self.assertEqual(errors[0]['candidate_values'],[self.b['id'],self.a['id']])
    def test_persisted_two_order_route_cannot_adopt_only_injected_first_order(self):
        plan=self.plan();plan['locks']={'vehicle_id':self.a['id']};plan['candidates'][0]['routes'][0]['segments']=[self.segment]
        self.reject_adopt(plan)
    def test_persisted_company_route_cannot_become_supplier_commitment(self):
        plan=self.plan();plan['candidates'][0]['routes'][0]['kind']='supplier_commitment'
        self.reject_adopt(plan)
    def test_persisted_candidate_cannot_drop_one_order_from_actual_coverage(self):
        plan=self.plan();route=plan['candidates'][0]['routes'][0]
        route['order_ids']=self.ids[:1];route['order_versions']={self.ids[0]:self.orders[0]['version']}
        self.reject_adopt(plan)
    def test_persisted_candidate_must_still_honor_original_locks(self):
        plan=self.plan();plan['locks']={'vehicle_id':self.a['id']}
        self.reject_adopt(plan)
    def test_normal_two_order_candidate_adopts_both_orders(self):
        plan=self.plan()
        result=planning.adopt(self.db,plan['id'],dict(version=1,candidate_id=plan['candidates'][0]['id'],idempotency_key='normal'),self.user)
        self.assertEqual({oid for r in result['routes'] for oid in r['order_ids']},set(self.ids))
        self.assertEqual(result['plan']['state'],'adopted_pending_release')


class SolverDeadlineAcceptance(unittest.TestCase):
    def test_T27_bounded_deadline_retains_verified_incumbent(self):
        routes=[candidate(['a'],100),candidate(['a'],200)]
        result=deadline_result(['a'],routes)
        self.assertEqual(result['indices'],[0]);self.assertTrue(result['exhausted']);self.assertFalse(result['proven'])
    def test_T27_bounded_deadline_before_first_solution_is_not_proof(self):
        result=deadline_result(['a'],[candidate(['a'])],found=False)
        self.assertEqual(result['indices'],[]);self.assertTrue(result['exhausted']);self.assertFalse(result['proven'])
    def cp_run(self,first_feasible=False,second_unknown=False,first_unknown=False):
        try:from ortools.sat.python import cp_model as cp
        except ImportError:self.skipTest('native OR-Tools optional dependency unavailable')
        real=cp.CpSolver();calls=[]
        class ControlledSolver:
            parameters=real.parameters
            def Solve(self,model):
                calls.append(1)
                if first_unknown or len(calls)==2 and second_unknown:return cp.UNKNOWN
                status=real.Solve(model)
                return cp.FEASIBLE if len(calls)==1 and first_feasible else status
            def Value(self,x):return real.Value(x)
            def NumBranches(self):return 0 if first_unknown else real.NumBranches()
        facade=SimpleNamespace(CpModel=cp.CpModel,CpSolver=ControlledSolver,OPTIMAL=cp.OPTIMAL,FEASIBLE=cp.FEASIBLE,UNKNOWN=cp.UNKNOWN,INFEASIBLE=cp.INFEASIBLE)
        # Solve real integer constraints, injecting only the phase deadline status.
        return solver._cp(['a'],[candidate(['a'],100)],1,'lowest_cost',facade)
    def test_T27_cp_second_phase_timeout_keeps_first_real_feasible_solution(self):
        result=self.cp_run(second_unknown=True)
        self.assertEqual(result['indices'],[0]);self.assertTrue(result['exhausted']);self.assertFalse(result['proven'])
    def test_T27_cp_first_phase_timeout_without_solution_is_not_infeasibility(self):
        result=self.cp_run(first_unknown=True)
        self.assertEqual(result['indices'],[]);self.assertTrue(result['exhausted']);self.assertFalse(result['proven'])
    def test_T27_cp_unproven_coverage_stays_exhausted_after_optimal_price_phase(self):
        result=self.cp_run(first_feasible=True)
        self.assertEqual(result['indices'],[0]);self.assertTrue(result['exhausted']);self.assertFalse(result['proven'])
    def test_T27_cp_worse_second_feasible_solution_cannot_replace_better_first(self):
        try:from ortools.sat.python import cp_model as cp
        except ImportError:self.skipTest('native OR-Tools optional dependency unavailable')
        for objective in ('lowest_cost','earliest_finish','fewest_transfers'):
            with self.subTest(objective=objective):
                real=cp.CpSolver();calls=[]
                class InterruptedSolver:
                    parameters=real.parameters
                    def Solve(self,model):
                        index=len(calls);calls.append(1)
                        constrained=model.Clone();constrained.Add(constrained.GetBoolVarFromProtoIndex(index)==1)
                        status=real.Solve(constrained)
                        return status if index==0 else cp.FEASIBLE
                    def Value(self,x):return real.Value(x)
                    def NumBranches(self):return real.NumBranches()
                facade=SimpleNamespace(CpModel=cp.CpModel,CpSolver=InterruptedSolver,OPTIMAL=cp.OPTIMAL,FEASIBLE=cp.FEASIBLE,UNKNOWN=cp.UNKNOWN,INFEASIBLE=cp.INFEASIBLE)
                routes=[dict(candidate(['a'],100),finish=100,transfers=0),dict(candidate(['a'],200),finish=200,transfers=1)]
                result=solver._cp(['a'],routes,1,objective,facade)
                self.assertEqual(result['indices'],[0]);self.assertTrue(result['exhausted']);self.assertFalse(result['proven'])


if __name__=='__main__':unittest.main()
