"""Check the exact synthetic database included in the public V13 release."""
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
p = ROOT / 'v13/data/sim200-ready.sqlite3'
with sqlite3.connect(p) as db:
    db.row_factory = sqlite3.Row
    orders = [dict(json.loads(r['data']), id=r['id'], status=r['status']) for r in db.execute('SELECT * FROM orders')]
    users = [dict(r) for r in db.execute('SELECT * FROM users')]
    assert len(orders) == 200 and len({x['id'] for x in orders}) == 200
    assert all(x['id'].startswith('SIM200-') and x.get('customer', '').startswith('SIM ') for x in orders)
    assert all(re.sub(r'\D', '', x.get('phone', '')) in {'12025550100', '2025550100', ''} and x.get('sms_consent') in {False, None, '否', 'no'} for x in orders)
    assert all(x['passhash'] == '!' and x['name'].startswith('SIM ') for x in users)
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    audit = dict(path=p.relative_to(ROOT).as_posix(), sha256=hashlib.sha256(p.read_bytes()).hexdigest(), orders=200,
                 only_sim_customer_ids=True, non_operational_passwords=True, synthetic_phone=True, sms_disabled=True,
                 profiles=[dict(kind=r[0], count=r[1]) for r in db.execute('SELECT kind,count(*) FROM dispatch_profiles GROUP BY kind')],
                 states=[dict(state=r[0], count=r[1]) for r in db.execute('SELECT status,count(*) FROM orders GROUP BY status')],
                 integrity='ok', notes='Ready-state synthetic fixture; terminal acceptance database is separate.')
(ROOT / 'docs/verification/v13/public-release-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf8')
print(json.dumps(audit))
