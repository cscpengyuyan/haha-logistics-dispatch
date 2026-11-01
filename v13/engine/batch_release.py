"""Atomic, explicitly evidenced F04 issuance; never manufactures approvals.

Each item goes through core.preflight and core.apply_action. The whole batch,
including gate changes, bookings, events and idempotency receipt, shares one
SAVEPOINT. An existing caller transaction is never committed by this module.
"""
import hashlib
import json
import uuid
from contextlib import contextmanager
import core

PATH = "/api/ops/dispatch-batches/release"
ITEM_FIELDS = {"order_id", "action", "version", "driver", "carrier", "dispatch_ref",
               "approved_cost", "checks", "handoff_ref", "window_start", "window_end",
               "route_id", "route_version", "direct_plan", "all_legs_contract", "a_channel",
               "receiver_site", "appointment_ref", "shipment_ref", "label_ref", "receiving_terms",
               "receiver_contact", "handoff_terms"}


def schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS dispatch_release_batches(
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, key TEXT NOT NULL,
        digest TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL,
        created TEXT NOT NULL, UNIQUE(actor,key))""")


@contextmanager
def atomic(db):
    own = not db.in_transaction
    if own:
        db.execute("BEGIN IMMEDIATE")
    name = "release_batch_" + uuid.uuid4().hex
    db.execute("SAVEPOINT " + name)
    try:
        yield
        db.execute("RELEASE " + name)
        if own:
            db.commit()
    except BaseException:
        db.execute("ROLLBACK TO " + name)
        db.execute("RELEASE " + name)
        if own:
            db.rollback()
        raise


def request(body):
    if not isinstance(body, dict):
        raise core.ApiError(400, "批量签发请求须为对象")
    extra = set(body) - {"items", "idempotency_key", "plan_id", "plan_version"}
    if extra:
        raise core.ApiError(400, "不支持的批量签发字段：" + ", ".join(sorted(extra)))
    key = core.required(body, "idempotency_key", 200)
    items = body.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 200:
        raise core.ApiError(400, "批量签发须包含 1–200 票")
    ids = []
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise core.ApiError(400, f"第 {index} 项须为明确订单签发对象")
        unknown = set(item) - ITEM_FIELDS
        if unknown:
            raise core.ApiError(400, f"第 {index} 项含不支持字段：" + ", ".join(sorted(unknown)))
        oid = core.required(item, "order_id", 100)
        if oid != item["order_id"]:
            raise core.ApiError(400, "订单 ID 不应包含首尾空白")
        if item.get("action") not in {"dispatch", "station_release"}:
            raise core.ApiError(400, "批量入口仅允许 dispatch 或 station_release")
        if type(item.get("version")) is not int or item["version"] < 1:
            raise core.ApiError(400, oid + " 缺少明确当前订单版本")
        if isinstance(item.get("checks"), dict) and set(item["checks"]) - set(core.CHECKS):
            raise core.ApiError(400, oid + " 包含未知 F04 核验项")
        ids.append(oid)
    if len(set(ids)) != len(ids):
        raise core.ApiError(400, "同一批次不能重复签发同一订单")
    if ("plan_id" in body) != ("plan_version" in body):
        raise core.ApiError(400, "关联计划须同时提供 plan_id 和 plan_version")
    if "plan_id" in body:
        core.required(body, "plan_id", 100)
        if type(body["plan_version"]) is not int or body["plan_version"] < 1:
            raise core.ApiError(400, "关联计划版本无效")
    try:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    except (ValueError, TypeError) as exc:
        raise core.ApiError(400, "批量签发数据不是有效 JSON") from exc
    return key, ids, encoded, hashlib.sha256(encoded.encode()).hexdigest()


def linked_plan(db, body, ids):
    if "plan_id" not in body:
        return
    import planning
    plan = planning.plan_get(db, body["plan_id"])
    if plan.get("version") != body["plan_version"]:
        raise core.ApiError(409, "关联计划版本已变，请重新核对签发范围")
    if plan.get("state") != "adopted_pending_release" or plan.get("validation_status") != "passed":
        raise core.ApiError(409, "关联计划须为已采用并通过核验的计划")
    candidate = next((c for c in plan.get("candidates", []) if c.get("id") == plan.get("adopted_candidate")), None)
    if not candidate or candidate.get("validation_status") != "passed" or candidate.get("unassigned"):
        raise core.ApiError(409, "已采用候选缺失或仍有未排订单")
    if set(plan.get("order_ids", [])) != set(ids):
        raise core.ApiError(409, "本批订单集合须与关联的已采用计划完全一致")
    routes = set(plan.get("adopted_routes", []))
    commitments = {oid for r in plan.get("adopted_commitments", [])
                   if r.get("kind") == "supplier_commitment" for oid in r.get("order_ids", [])}
    for item in body["items"]:
        if item.get("direct_plan") or (item.get("route_id") not in routes and
                                      not (not item.get("route_id") and item["order_id"] in commitments)):
            raise core.ApiError(409, item["order_id"] + " 未使用关联计划实际采用的路线或承运委托")


def release(db, body, user):
    if user.get("role") not in {"admin", "dispatch"}:
        raise core.ApiError(403, "仅管理员或调度可批量签发")
    actor = core.required(user, "username", 64)
    key, ids, encoded, digest = request(body)
    with atomic(db):
        schema(db)
        prior = db.execute("SELECT digest,result FROM dispatch_release_batches WHERE actor=? AND key=?", (actor, key)).fetchone()
        if prior:
            if prior[0] != digest:
                raise core.ApiError(409, "IDEMPOTENCY_CONFLICT：同一签发重试编号不能用于不同请求")
            return json.loads(prior[1])
        linked_plan(db, body, ids)
        results = []
        for item in body["items"]:
            oid = item["order_id"]
            params = {k: v for k, v in item.items() if k != "order_id"}
            try:
                # Validate every item's real twelve references, also for a
                # station release. Do this sequentially under the savepoint;
                # failure in a later item rolls back earlier real issuances.
                core.preflight(params)
                results.append(core.apply_action(db, oid, params, user))
            except core.ApiError as exc:
                raise core.ApiError(exc.status, f"批量签发已全部回滚；{oid}：{exc}") from exc
        stamp, bid = core.now(), "BATCH-" + uuid.uuid4().hex
        result = dict(batch=dict(id=bid, state="issued", order_ids=ids, count=len(results),
                                actor=actor, created_at=stamp, plan_id=body.get("plan_id"),
                                plan_version=body.get("plan_version")), orders=results)
        # Persist the exact supplied evidence with the receipt, including new
        # second-leg F04 checks; retries return the original issue versions/codes.
        db.execute("INSERT INTO dispatch_release_batches VALUES(?,?,?,?,?,?,?)",
                   (bid, actor, key, digest, encoded, core.encode(result), stamp))
        return result


def handle(db, method, path, body, user):
    if path != PATH:
        raise core.ApiError(404, "批量签发接口不存在")
    if method != "POST":
        raise core.ApiError(405, "批量签发需要 POST")
    return release(db, body, user)
