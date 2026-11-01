"""Native V13 optimizer capability diagnostic and CP-SAT candidate selector.

The HTTP service imports v13/engine/planning. Install the pinned optimizer extra
to enable CP-SAT. The public worker intentionally falls back to bounded search.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'v13' / 'engine'))
from planning_solver import choose


def capabilities():
    try:
        import ortools
        version = ortools.__version__
    except ImportError:
        version = None
    return {'business_version':'v13', 'cp_sat':bool(version), 'ortools_version':version,
            'fallback':'bounded_exact_search', 'optimality_scope':'generated_candidates'}


if __name__ == '__main__':
    if '--solve' in sys.argv:
        data = json.load(sys.stdin)
        print(json.dumps(choose(data['order_ids'], data['candidates'], data.get('budget_seconds', 30), data.get('objective', 'lowest_cost'))))
    else:
        print(json.dumps(capabilities()))
