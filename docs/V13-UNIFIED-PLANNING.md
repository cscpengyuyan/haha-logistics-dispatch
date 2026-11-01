# V13 unified planning implementation

The shared plan API is `/api/ops/plans`. The HTTP service and public Python worker
load the same `v13/engine/planning.py` and `planning_solver.py` modules. Plans do
not replace F04, inventory reservation, gate verification, technical acceptance,
settlement or aftercare authorization.

## APIs

- `POST /precheck`: `order_ids`, `planning_scope` (`delivery_complete` or
  `authorized_stage`). Returns per-object error codes, fields and next steps.
- `POST /optimize`: same scope plus `objective`, `budget_seconds`, optional
  `route_candidates`, `calculate_roads` and hard `locks`. Supported locks are
  `station_order`, `vehicle_id`, `crew_id`, `date`; unknown locks return 422.
- `GET /{plan_id}` and `GET /`: restore a saved plan or list recent plans.
- `POST /{plan_id}/adopt`: `version`, `candidate_id`, `idempotency_key`. Requires
  unchanged input snapshot and full coverage of the chosen scope. Saves a batch
  of current route drafts in a savepoint. Failure rolls back the entire batch.
  An identical retry returns the prior result; changed content returns 409.
- `POST /profiles/order` and `/profiles/resource`: dispatch-maintained versioned
  stop facts, per-vehicle calendars and explicit synthetic/carrier road evidence.
- `POST /profiles/rate_card`, `/profiles/stage`, `/profiles/technical`,
  `/profiles/commitment`: procurement-confirmed, evidence-backed terms. Required
  amounts are integer USD cents; omitted amounts are not interpreted as zero.

The owner HTTP service provides asynchronous jobs separately. Its worker calls
`optimize(..., publish=False)`, checks the current job lease, and only then calls
`save_result` inside the result-commit transaction.

## Selection and validation

Candidate groups use actual warehouse, date, selected executor, individual
vehicle capacity and matching crews. Origin changes require a real task or an
explicitly evidenced repositioning time; relabeling a warehouse is not permitted.
Road-service requests are deduplicated and cover new orders before extra choices
for earlier orders. The native adapter supplies genuine directional truck routes,
including the return leg. Browser practice uses explicitly marked synthetic
carrier evidence and never claims a real truck-road calculation.

CP-SAT chooses a compatible candidate set. Browser mode uses bounded search with
the same hard constraints. Order coverage is optimized first, then the chosen
objective. Vehicle, crew, driver, technician, SN and shared-capacity conflicts
remain hard constraints. Daily activation prices are charged once; confirmed
route rates support base, per-order, per-unit, per-stop and minimum charges.
Integer residual allocation conserves the route amount. Optimality only applies
to the generated candidate set. Pruned candidates and budget limits are disclosed.

C1 complete paths join a supplier promise or first route, actual station
capacity/processing requirements and a future second route. The future route
uses a hypothetical received state for planning only; no inventory is created.
Adoption retains the future dependency and saves only the currently authorized
segment. Actual station receipt is required before the normal second-leg API can
authorize shipment. C2 authorized-stage plans require separately confirmed stage
price, storage rate/capacity, custody responsibility and a downstream owner and
deadline; their whole-order completion remains zero. L5 is a separate technician
occupancy with explicit authorization, tools, price and delivery dependency.

Conservative floor rows are released at each delivery stop, together with units
and weight. Mixed delivery/collection routes accept existing authorized machine
RMAs at the exact same verified customer entrance as a delivery stop. Every
collection references the real delivered SN, case and asset versions, measured
return packaging, explicit handling time/window, approved charge and destination
warehouse. Arbitrary pickup fields are rejected. Units, weight, conservative
floor length and fixing slots are updated after every load/unload action;
initial load and every pickup are checked against all four vehicle limits.

`POST /api/ops/collections/confirm` is service/admin-only and confirms pickup
facts on an already authorized machine RMA without moving the asset. Dispatch
uses `/api/ops/collections/compare` with `{route: ...}` to compare the same
geographical route with collection before versus after delivery. Routes carry
`collections: {delivery_order_id: [{rma_id,version,asset_version,before_delivery}]}`.
The stop's `service` includes `delivery_service_minutes` plus confirmed collection
handling. The whole visit must fit the pickup window and the route must include
return to the RMA receiver. Submit the alternatives as normal `route_candidates`
to the shared optimizer; include `required_collections: {delivery_order_id:
[rma_id]}` to lock the required return scope. A cheaper delivery-only candidate
cannot replace that task. Coverage reports the required and assigned collection
counts separately. The approved collection charge is added in integer cents.

The normal route checker and F04 signing both revalidate this load sequence.
Signing reserves each RMA/SN once, departure checks the current authorization,
and actual RMA warehouse receipt releases the return reservation. Existing
RMA shipped/received operations remain the source of custody changes. Independent
pickup-only locations and automatic discovery of return tasks are not generated;
different pickup coordinates are explicitly rejected instead of silently adding
an uncalculated trip. Thus T06 is covered for same-site mixed delivery/collection,
not represented as unrestricted multi-location pickup-and-delivery routing.

## Verification and reproducibility

`python -X utf8 tests/test_v13_planning.py -v` passes 22 tests, including native and
browser solver known optima, scarce skills, independent crew use, SN conflicts,
shared capacity, actual daily costs, DST, integer money, permissions, invalid
locks, L5 dependencies, same-route technician overlap and repositioning, staff
deactivation, floor release, snapshot staleness and adoption rollback.

`python -X utf8 tests/test_v13_mixed_load.py -v` passes 16 additional tests using
actual delivery, RMA approval, stock receipt/reservation, procurement and F04
services in a disposable SIM database. For a two-unit delivery and one authorized
return, delivery-first peaks at 2 units / 452 kg / 200 cm floor / 2 fixing slots;
collection-first peaks at 3 / 678 / 300 / 3 and is excluded from selection and
signing. Tests also cover return cost, unauthorized/free-SN pickup, different site,
missing service time, stale authorization, duplicate reservations, first-leg
station mismatch, lift payload and actual RMA receipt. Reproducible comparison evidence is
`docs/verification/v13/T06-mixed-load.json`.

Install `requirements-optimizer.txt` into `.deps/optimizer`. Native CP-SAT version
9.15.6755 was installed and exercised. `python dispatch_optimizer.py` reports the
actual engine capability. The public worker does not import the native package.

`scripts/verify_v13_optimizer.py` uses six SIM200 orders across two dates and
multiple physical vehicles with genuine Valhalla/VROOM and CP-SAT. After the
return-leg signature fix it produced 60 candidates, 24 feasible candidates,
6/6 coverage and USD 2,400.00; cold/warm total times were 23.00/21.19 seconds.
Adoption, identical retry and rejection of different content under the same key
passed. Evidence is in `docs/verification/v13/optimizer-live/`.

`scripts/seed_sim200_planning.py --source docs/sim200/ready-public/SIM200.sqlite3
--output docs/sim200/planning-public/SIM200.sqlite3` prepares 180 order profiles,
16 physical-vehicle calendars, supplier commitments, stage terms and technicians
through normal maintenance APIs, preserving the input database. All these
business facts and carrier times are labeled SIM controlled fixtures.

`scripts/verify_v13_public_plans.py` verifies C1, L5, authorized C2, self-pickup,
six-order bounded browser selection and a station-processing delay that correctly
prevents onward dispatch. The full 200-order ready-state diagnostic assigned 156
orders and left 44 unassigned, without relaxing constraints:

- Eight designated cancellations still await their cancellation action in this
  ready-state snapshot and intentionally have no awarded transport quotation.
- Thirty C2 orders await second-leg procurement. They can be planned separately
  as authorized stages; they are not counted as complete delivery.
- Six Houston C1 orders (129–134) have individually feasible complete paths but
  reuse vehicle/crew/driver 11 between the original warehouse and the station.
  Their cross-origin repositioning is not evidenced, so the combined plan rejects
  the conflicting combination. These are diagnosed resource conditions, not
  claimed physical capacity exhaustion or proof of global infeasibility.

The diagnostic generated 806 including composite/technical alternatives, of which
580 were individually feasible, in approximately 4.25 seconds total. This is
distinct from the separate 200-order business-lifecycle terminal replay and from
the six-order real-road integration. Full 200-order real-road joint optimization,
automatic discovery and routing of independent return stops and all production
operational data are not represented as completely accepted by these tests.
