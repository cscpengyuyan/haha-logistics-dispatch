# V13 unified dispatch local runtime

The source baseline is `bd564c6e9c9b28c682cee8057b43ceba7cb9f62e`. The default Python service and preview now bind to **v13**; set `HH_APP_VERSION=v12` only for a deliberate legacy run. Existing V12 databases and working directories are not overwritten.

## Start on Windows (Python 3.12)

The full local delivery ZIP includes the verified Windows x64 Python 3.12 native
dependencies and four bounded regional graphs. Extract it and run
`Start-V13-Full.cmd`. It starts the local shared synthetic service and road worker,
and copies the clean SIM200 seed only when `data/v13-sim200.sqlite3` does not exist.
Existing records are retained. The browser preview is `Start-V13-Demo.cmd`.
If a port is already in use, choose explicit alternatives:

```powershell
python -X utf8 start_v13.py --port 8767 --road-port 18807
```

The source repository excludes these native binaries and graphs; the full ZIP
is a separate local artifact. A fresh source checkout can still run the browser
preview or the shared business service without native roads. For source-only
installation of the optional optimizer:

```powershell
python -m pip install --target .deps/optimizer -r requirements-optimizer.txt
python -X utf8 server.py --demo --db data/v13-demo.sqlite3 --port 8765
# http://127.0.0.1:8765/v13/#map
# GET http://127.0.0.1:8765/api/health proves static / engine / data mode.
```

Public browser preview:

```powershell
python -X utf8 preview.py --port 8766
# http://127.0.0.1:8766/v13/?dataset=sim200#map
```

The `dataset=sim200` entry loads a dedicated synthetic database into a separate IndexedDB namespace. It does not overwrite the normal V13 browser demo. Each visitor has their own local records. It is not an employee shared database and does not provide native CP-SAT. The seed snapshot is produced through actual sales/import/inventory/procurement business functions; expected outcomes are in separate acceptance evidence, not prewritten as completed statuses.

## Shared local optimization

`POST /api/ops/jobs` with order_ids, planning_scope, objective and optional idempotency_key. `GET /api/ops/jobs/{id}` restores progress after refresh; `POST /api/ops/jobs/{id}/cancel` cancels publication. The persisted job records attempts and leases. Work uses separate SQLite connections, releases transactions during solving, and checks lease, cancellation and input snapshot within a write transaction before publishing. Two jobs run concurrently at most. A crashed attempt is reclaimable after its lease expires. The synchronous optimize endpoint is reserved for the public browser adapter.

Adoption is a draft action. It rechecks versions, resources, costs and input hash. F04/warehouse release still uses the existing authorized business service; choosing a candidate does not dispatch freight.

## Road worker

Set `HH_VALHALLA_URL`, `HH_VROOM_URL`, `HH_ROAD_DATA_DATE`, `HH_ROAD_COVERAGE` in the business-service process before starting it. Both URLs can point to the same local `road_host.py` worker. A missing service is a blocking condition, never zero distance. Native road and optimization dependencies are separate from browser runtime. See `docs/sim200/roads/` for tested graph coverage, source dates and hashes. The tested four small regional graphs do not provide nationwide or intercity road coverage.

## Verification and data recovery

```powershell
python -X utf8 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/unified-workspace.test.cjs
python -X utf8 scripts/run_sim200.py --output docs/sim200/new-run
python -X utf8 maintenance.py backup data/v13-demo.sqlite3 data/v13-before-change.sqlite3
python -X utf8 maintenance.py restore data/v13-before-change.sqlite3 data/v13-restored.sqlite3
```

Backup/restore requires a new destination and checks the database mode and integrity. The SIM runner resumes from committed action receipts. Never point the simulation runner at a production database. The normal service defaults to separate `v13-demo.sqlite3` and `v13-production.sqlite3` files.

The business simulation, real roads, native solver and browser checks are separate evidence. `docs/V13-ACCEPTANCE-MATRIX.md` records remaining gaps against all 44 requirements; successful business simulation alone is not a claim of full production readiness.
