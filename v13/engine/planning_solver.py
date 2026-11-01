"""Integer candidate selection shared by native CP-SAT and the bounded browser solver.

Input candidates have already passed business validation. This module never relaxes
capacity, time, inventory or coverage constraints to obtain a cheaper solution.
"""
import time
import sys
from pathlib import Path

if sys.platform != 'emscripten':
    _deps = Path(__file__).resolve().parents[2] / '.deps' / 'optimizer'
    if _deps.is_dir():
        sys.path.insert(0, str(_deps))


def conflict(a, b):
    if set(a['order_ids']) & set(b['order_ids']):
        return True
    if set(a.get('sns', [])) & set(b.get('sns', [])):
        return True
    for x in a.get('occupancy', []):
        for y in b.get('occupancy', []):
            if x['kind'] == y['kind'] and x['id'] == y['id']:
                if max(x['start'], y['start']) < min(x['end'], y['end']):
                    return True
                # Distinct locations require a verified repositioning allowance.
                first, last = (x, y) if x['end'] <= y['start'] else (y, x)
                if first.get('end_location') != last.get('start_location'):
                    seconds = last.get('reposition_seconds')
                    if seconds is None or first['end'] + seconds > last['start']:
                        return True
    return False


def cost(selected):
    """Activation/day prices are charged once, with an identical source amount."""
    activations = {}
    total = 0
    for c in selected:
        total += c['total_minor']
        for key, amount in c.get('activations', {}).items():
            if key in activations and activations[key] != amount:
                raise ValueError('Conflicting activation price: ' + key)
            activations[key] = amount
    return total + sum(activations.values())


def pool_ok(selected):
    used, limits = {}, {}
    for c in selected:
        for p in c.get('pools', []):
            key = p['key']
            used[key] = used.get(key, 0) + p['quantity']
            limits[key] = min(limits.get(key, p['capacity']), p['capacity'])
    return all(used[k] <= limits[k] for k in used)


def score(selected, objective):
    covered = len({o for c in selected for o in c['order_ids']})
    price = cost(selected)
    finish = max((c.get('finish', 0) for c in selected), default=0)
    transfers = sum(c.get('transfers', 0) for c in selected)
    secondary = (finish, price) if objective == 'earliest_finish' else (transfers, price) if objective == 'fewest_transfers' else (price, finish)
    return (-covered, *secondary, len(selected))


def choose(ids, candidates, budget=10, objective='lowest_cost', native=True):
    start = time.monotonic()
    if native:
        try:
            from ortools.sat.python import cp_model
        except ImportError:
            pass
        else:
            return _cp(ids, candidates, max(.01, budget), objective, cp_model)
    # Branch on the most constrained uncovered order. Every branch preserves hard
    # constraints. Search limits report an incumbent, never a false infeasibility.
    by_id = {oid: [i for i, c in enumerate(candidates) if oid in c['order_ids']] for oid in ids}
    best, best_score, visits, exhausted = [], score([], objective), 0, False
    deadline = start + max(.001, budget)
    def visit(chosen, remaining):
        nonlocal best, best_score, visits, exhausted
        visits += 1
        if visits > 100000 or time.monotonic() >= deadline:
            exhausted = True
            return
        current = [candidates[i] for i in chosen]
        value = score(current, objective)
        if value < best_score:
            best, best_score = chosen[:], value
        covered = -value[0]
        if not remaining or covered + len(remaining) < -best_score[0]:
            return
        oid = min(remaining, key=lambda o: len(by_id[o]))
        for i in sorted(by_id[oid], key=lambda i: candidates[i]['total_minor']):
            c = candidates[i]
            if not set(c['order_ids']) <= remaining:
                continue
            if any(conflict(c, candidates[j]) for j in chosen) or not pool_ok(current + [c]):
                continue
            visit(chosen + [i], remaining - set(c['order_ids']))
            if exhausted:
                return
        visit(chosen, remaining - {oid})
    visit([], set(ids))
    return dict(indices=best, solver='bounded_exact_search', exhausted=exhausted,
                proven=not exhausted, seconds=time.monotonic()-start, nodes=visits)


def _cp(ids, candidates, budget, objective, cp):
    start = time.monotonic()
    model = cp.CpModel()
    xs = [model.NewBoolVar('route_' + str(i)) for i in range(len(candidates))]
    coverage = []
    for oid in ids:
        terms = [xs[i] for i, c in enumerate(candidates) if oid in c['order_ids']]
        model.Add(sum(terms) <= 1)
        coverage.extend(terms)
    for i, a in enumerate(candidates):
        for j in range(i):
            if conflict(a, candidates[j]):
                model.Add(xs[i] + xs[j] <= 1)
    pool_keys = {p['key'] for c in candidates for p in c.get('pools', [])}
    for key in pool_keys:
        terms, capacities = [], []
        for i, c in enumerate(candidates):
            for p in c.get('pools', []):
                if p['key'] == key:
                    terms.append(xs[i] * p['quantity'])
                    capacities.append(p['capacity'])
        model.Add(sum(terms) <= min(capacities))
    activation = {}
    for i, c in enumerate(candidates):
        for key, amount in c.get('activations', {}).items():
            if key in activation and activation[key][1] != amount:
                raise ValueError('Conflicting activation price: ' + key)
            if key not in activation:
                activation[key] = (model.NewBoolVar('activation_' + key), amount, [])
            activation[key][2].append(xs[i])
    for variable, amount, items in activation.values():
        model.AddMaxEquality(variable, items)
    price = sum(x * c['total_minor'] for x, c in zip(xs, candidates)) + sum(v * amount for v, amount, _ in activation.values())
    solver = cp.CpSolver()
    solver.parameters.max_time_in_seconds = budget
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 20261101
    # Exact lexicographic coverage priority avoids money-weighted hard-constraint relaxation.
    model.Maximize(sum(coverage))
    status = solver.Solve(model)
    if status not in (cp.OPTIMAL, cp.FEASIBLE):
        return dict(indices=[], solver='OR-Tools CP-SAT', exhausted=status == cp.UNKNOWN,
                    proven=status == cp.INFEASIBLE, seconds=time.monotonic()-start, nodes=solver.NumBranches())
    first = [i for i, x in enumerate(xs) if solver.Value(x)]
    coverage_optimal = status == cp.OPTIMAL
    model.Add(sum(coverage) == sum(len(candidates[i]['order_ids']) for i in first))
    if objective == 'earliest_finish':
        finish = model.NewIntVar(0, max((c.get('finish', 0) for c in candidates), default=0), 'finish')
        for x, c in zip(xs, candidates):
            model.Add(finish >= c.get('finish', 0) * x)
        model.Minimize(finish)
    elif objective == 'fewest_transfers':
        model.Minimize(sum(x * c.get('transfers', 0) for x, c in zip(xs, candidates)))
    else:
        model.Minimize(price)
    solver.parameters.max_time_in_seconds = max(.001, budget - (time.monotonic()-start))
    status = solver.Solve(model)
    indices = [i for i, x in enumerate(xs) if solver.Value(x)] if status in (cp.OPTIMAL, cp.FEASIBLE) else first
    return dict(indices=indices, solver='OR-Tools CP-SAT', exhausted=status != cp.OPTIMAL,
                proven=coverage_optimal and status == cp.OPTIMAL, seconds=time.monotonic()-start, nodes=solver.NumBranches())
