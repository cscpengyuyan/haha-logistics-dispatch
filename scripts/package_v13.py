"""Build a local Windows/Python 3.12 V13 package; never include a live database."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
destination = Path(args.output).resolve()
destination.parent.mkdir(parents=True, exist_ok=True)
chosen = set()
for pattern in ('*.py', '*.cmd', 'requirements-*.txt', 'README.md', 'LICENSE*'):
    chosen.update(p for p in ROOT.glob(pattern) if p.is_file())
for folder in ('v13', 'scripts', 'tests', 'docs', '.deps/optimizer', '.deps/roads', 'data/road-sim200'):
    for p in (ROOT / folder).rglob('*'):
        if not p.is_file() or '__pycache__' in p.parts or p.suffix == '.pyc':
            continue
        name = p.relative_to(ROOT).as_posix()
        if p.suffix in {'.db', '.sqlite', '.sqlite3'} and name != 'v13/data/sim200-ready.sqlite3':
            continue
        if name.startswith('docs/sim200/') and any('/' + q + '/' in name for q in ('ready', 'run', 'planning')):
            continue
        if name.startswith('data/road-sim200/') and p.suffix not in {'.json', '.gph'}:
            continue
        if name == 'scripts/publish_v13.py':
            continue
        chosen.add(p)
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
    for p in sorted(chosen):
        package.write(p, 'V13-Logistics/' + p.relative_to(ROOT).as_posix())
result = dict(path=str(destination), files=len(chosen), bytes=destination.stat().st_size,
              sha256=hashlib.sha256(destination.read_bytes()).hexdigest(), runtime='Windows x64 / Python 3.12',
              start='V13-Logistics/Start-V13-Full.cmd', data='Synthetic SIM200 only; no live database included')
destination.with_suffix('.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(result, ensure_ascii=False))
