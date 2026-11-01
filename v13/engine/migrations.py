"""Versioned, reversible legacy scope migration (T36).

``migrate(db)`` is safe inside a caller transaction: its savepoint never commits
the caller's work. Every changed row has an exact before-image in this database.
Use ``migrate_file(path, backup_path)`` for an additional whole-database backup
before an offline upgrade. No delivery endpoint is inferred from prose or L4/L5.
"""
import argparse
import json
import sqlite3
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

VERSION = "v13.scope.1"
LEVELS = {"L1", "L2", "L3"}
DEFAULTS = {"route": "", "level": "", "endpoint": "", "timezone": "",
            "window_start": "", "window_end": "", "lat": None, "lng": None,
            "pickup": False}


class MigrationError(ValueError):
    pass


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _atomic(db):
    name = "scope_" + uuid.uuid4().hex
    db.execute("SAVEPOINT " + name)
    try:
        yield
        db.execute("RELEASE " + name)
    except BaseException:
        db.execute("ROLLBACK TO " + name)
        db.execute("RELEASE " + name)
        raise


def _schema(db):
    # executescript would commit an outer transaction; use individual statements.
    db.execute("""CREATE TABLE IF NOT EXISTS scope_migration_runs(
        id TEXT PRIMARY KEY, migration TEXT NOT NULL, created TEXT NOT NULL,
        actor TEXT NOT NULL, state TEXT NOT NULL, backup_ref TEXT NOT NULL,
        summary TEXT NOT NULL, rolled_back TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS scope_migration_rows(
        run_id TEXT NOT NULL REFERENCES scope_migration_runs(id),
        entity TEXT NOT NULL, object_id TEXT NOT NULL, before_version INTEGER NOT NULL,
        before_state TEXT NOT NULL, before_data TEXT NOT NULL,
        after_version INTEGER NOT NULL, after_data TEXT NOT NULL,
        PRIMARY KEY(run_id,entity,object_id))""")


def _object(raw, label):
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise MigrationError(label + "：JSON 损坏；未修改此批次") from exc
    if not isinstance(data, dict):
        raise MigrationError(label + "：记录不是对象；未修改此批次")
    return data


def pending_issues(order):
    """Current, actionable migration issues; history is never a clearance flag."""
    issues = []
    def add(code, field, message, next_step):
        issues.append(dict(code=code, object_id=order.get("id"), field=field,
                           message=message, next_step=next_step))
    if order.get("level") not in LEVELS:
        add("ENDPOINT_REQUIRED", "level", "旧附加服务未说明实际 L1/L2/L3 交付终点",
            "销售按原合同补录实际终点和依据；已放行订单先按正常流程撤回或变更")
    if not order.get("endpoint"):
        add("ENDPOINT_DESCRIPTION_REQUIRED", "endpoint", "实际交付位置缺失", "销售补录合同约定的具体交接位置")
    if order.get("pickup") and (order.get("route") != "A" or order.get("level") != "L1"):
        add("PICKUP_SCOPE_CONFLICT", "pickup", "旧自提标记与路径或终点冲突", "销售核实自提；只有 A/L1 才能使用仓口自提")
    for key in ("addon_l4", "addon_l5", "pickup"):
        if type(order.get(key)) is not bool:
            add("ACTION_SCOPE_REQUIRED", key, "旧附项标记不是明确布尔值", "销售按合同明确该动作是否包含")
    return issues


def _order(data, resolution, run_id):
    changed = dict(data)
    legacy = data.get("level") in {"L4", "L5"}
    migrated = any(isinstance(item, dict) and item.get("migration") == VERSION
                   for item in data.get("scope_migrations", []))
    if resolution is not None:
        if not isinstance(resolution, dict) or resolution.get("level") not in LEVELS:
            raise MigrationError("终点补正必须明确 level=L1/L2/L3")
        if not isinstance(resolution.get("evidence"), str) or not resolution["evidence"].strip():
            raise MigrationError("终点补正必须提供合同或确认依据 evidence")
        if set(resolution) - {"level", "endpoint", "evidence"}:
            raise MigrationError("终点补正含不支持的字段")
        if data.get("level") in LEVELS and data["level"] != resolution["level"]:
            raise MigrationError("已有明确终点不得通过迁移工具改约，请使用正常销售变更流程")
    for key, default in DEFAULTS.items():
        changed.setdefault(key, default)
    for key, alias in (("addon_l4", "L4"), ("addon_l5", "L5")):
        for source in (key, alias):
            if source in data and type(data[source]) is not bool:
                raise MigrationError(source + " 不是布尔值，请核对原记录；不会把字符串真假自动转换")
        changed[key] = bool(data.get(key) or (not migrated and data.get(alias)) or data.get("level") == alias)
    # A pre-existing technical commission is explicit evidence of a purchased
    # action, not evidence of the physical delivery endpoint.
    if not migrated and isinstance(data.get("technical_order"), dict) and data["technical_order"]:
        changed["addon_l5"] = True
    if legacy:
        changed["level"] = ""
    if resolution is not None:
        changed["level"] = resolution["level"]
        if "endpoint" in resolution:
            if not isinstance(resolution["endpoint"], str) or not resolution["endpoint"].strip():
                raise MigrationError("补正的 endpoint 必须是非空具体位置")
            changed["endpoint"] = resolution["endpoint"].strip()
        changed["endpoint_ref"] = resolution["evidence"].strip()
        if changed.get("pickup") and (changed.get("route") != "A" or changed["level"] != "L1"):
            raise MigrationError("自提补正必须同时满足 A 路径和 L1 终点")
    if changed == data:
        return None
    history = list(data.get("scope_migrations", []))
    history.append(dict(migration=VERSION, run_id=run_id, original_level=data.get("level"),
                        added_fields=sorted(set(changed) - set(data)),
                        pending_fields=sorted({x["field"] for x in pending_issues(changed)}),
                        resolution=resolution))
    changed["scope_migrations"] = history
    return changed


def _draft(data, run_id):
    if data.get("scope_draft_migration") == VERSION:
        return None
    check = data.get("check_result")
    malformed_check = check is not None and (not isinstance(check, dict) or not isinstance(check.get("issues"), list))
    required = {"order_ids", "order_versions", "timezone", "return_policy", "check_result"}
    if required <= set(data) and not malformed_check:
        return None
    changed = dict(data)
    changed.setdefault("order_ids", [])
    changed.setdefault("timezone", "")
    changed.setdefault("return_policy", None)
    # No invented costs, geometry, dates or full-delivery scope. All previous
    # calculated values remain traceable in the exact before-image.
    changed["order_versions"] = {}
    changed["check_result"] = {"issues": ["旧草案缺少新版核验字段，请重新选择终点、时区和回程后核验"]}
    changed["scope_draft_migration"] = VERSION
    changed["migration_run_id"] = run_id
    changed["migration_recheck_required"] = True
    return changed


def migrate(db, *, resolutions=None, actor="system:migration", backup_ref=""):
    """Migrate existing rows, atomically and idempotently; return a compact report.

    resolutions is an optional {order_id: {level, evidence, endpoint?}} manifest
    of human-confirmed facts. It never permits changing a known valid endpoint.
    Events, attachments, SN locks, commissions and issued routes are preserved.
    """
    resolutions = resolutions or {}
    if not isinstance(resolutions, dict):
        raise MigrationError("resolutions 必须为按订单 ID 索引的对象")
    run_id = "MIG-" + uuid.uuid4().hex
    report = dict(migration=VERSION, run_id=None, orders=0, drafts=0, pending=[])
    with _atomic(db):
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"orders", "events", "metadata"} <= tables:
            raise MigrationError("须先初始化共享订单库结构")
        rows = list(db.execute("SELECT id,version,status,data FROM orders ORDER BY id"))
        if set(resolutions) - {r[0] for r in rows}:
            raise MigrationError("终点补正包含不存在的订单 ID")
        changes, signed = [], set()
        for oid, version, status, raw in rows:
            data = _object(raw, oid)
            release = data.get("release_route") or {}
            if isinstance(release, dict) and release.get("id"):
                signed.add((release["id"], release.get("route_version")))
            after = _order(data, resolutions.get(oid), run_id)
            current = dict(after or data, id=oid)
            problems = pending_issues(current)
            if problems:
                report["pending"].append(dict(id=oid, issues=problems))
            if after is not None:
                changes.append(("order", oid, version, status, raw, _json(after)))
                report["orders"] += 1
        if "registry" in tables:
            for rid, version, raw in db.execute("SELECT id,version,data FROM registry WHERE type='route' ORDER BY id"):
                if (rid, version) in signed or (rid, None) in signed:
                    continue
                after = _draft(_object(raw, rid), run_id)
                if after is not None:
                    changes.append(("route", rid, version, "route", raw, _json(after)))
                    report["drafts"] += 1
        _schema(db)
        if not changes:
            return report
        report["run_id"] = run_id
        timestamp = _now()
        db.execute("INSERT INTO scope_migration_runs VALUES(?,?,?,?,?,?,?,NULL)",
                   (run_id, VERSION, timestamp, actor, "applied", str(backup_ref), _json(report)))
        for entity, oid, version, state, before, after in changes:
            db.execute("INSERT INTO scope_migration_rows VALUES(?,?,?,?,?,?,?,?)",
                       (run_id, entity, oid, version, state, before, version + 1, after))
            table, kind = ("orders", "status") if entity == "order" else ("registry", "type")
            result = db.execute(f"UPDATE {table} SET version=version+1,data=? WHERE id=? AND version=? AND {kind}=? AND data=?",
                                (after, oid, version, state, before))
            if result.rowcount != 1:
                raise MigrationError("迁移期间记录已变化；整个批次已回滚")
            if entity == "order":
                db.execute("INSERT INTO events(order_id,ts,actor,action,note) VALUES(?,?,?,?,?)",
                           (oid, timestamp, actor, "scope_migration", run_id + " · 原值已备份，缺少终点必须补正"))
            elif "registry_log" in tables:
                db.execute("INSERT INTO registry_log(item,version,actor,ts,snapshot) VALUES(?,?,?,?,?)",
                           (oid, version + 1, actor, timestamp, after))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('scope_migration_version',?)", (VERSION,))
    return report


def rollback_run(db, run_id, *, actor="system:migration"):
    """Restore before-images only if ALL affected rows are untouched.

    Versions continue increasing so a rollback cannot revive stale clients.
    Existing and migration events remain append-only. Full exact restoration is
    available via restore_file into a separate path while the service is stopped.
    """
    with _atomic(db):
        run = db.execute("SELECT state FROM scope_migration_runs WHERE id=?", (run_id,)).fetchone()
        if not run:
            raise MigrationError("迁移批次不存在")
        if run[0] == "rolled_back":
            return dict(run_id=run_id, state="rolled_back", restored=0)
        rows = list(db.execute("SELECT entity,object_id,before_version,before_state,before_data,after_version,after_data FROM scope_migration_rows WHERE run_id=?", (run_id,)))
        for entity, oid, _, state, _, version, after in rows:
            table, kind = ("orders", "status") if entity == "order" else ("registry", "type")
            row = db.execute(f"SELECT version,{kind},data FROM {table} WHERE id=?", (oid,)).fetchone()
            if not row or tuple(row) != (version, state, after):
                raise MigrationError(oid + " 在迁移后已有业务修改；不覆盖新资料，整个回滚未执行")
        timestamp = _now()
        for entity, oid, _, state, before, version, _ in rows:
            table = "orders" if entity == "order" else "registry"
            db.execute(f"UPDATE {table} SET version=?,data=? WHERE id=?", (version + 1, before, oid))
            if entity == "order":
                db.execute("INSERT INTO events(order_id,ts,actor,action,note) VALUES(?,?,?,?,?)",
                           (oid, timestamp, actor, "scope_migration_rollback", run_id))
            elif db.execute("SELECT 1 FROM sqlite_master WHERE name='registry_log'").fetchone():
                db.execute("INSERT INTO registry_log(item,version,actor,ts,snapshot) VALUES(?,?,?,?,?)",
                           (oid, version + 1, actor, timestamp, before))
        db.execute("UPDATE scope_migration_runs SET state='rolled_back',rolled_back=? WHERE id=?", (timestamp, run_id))
    return dict(run_id=run_id, state="rolled_back", restored=len(rows))


def _open(path, mode="ro"):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + "?mode=" + mode, uri=True, isolation_level=None, timeout=8)
    try:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise MigrationError("数据库完整性校验失败")
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"orders", "events", "files", "metadata"} <= tables:
            raise MigrationError("不是共享工作库")
        db.execute("PRAGMA foreign_keys=ON")
        return db
    except BaseException:
        db.close()
        raise


def _copy(source, destination, *, clear_sessions=False):
    destination = Path(destination).resolve()
    # Exclusive creation refuses source aliases, existing backups and overwrites.
    with destination.open("xb"):
        pass
    try:
        with closing(_open(source)) as origin, closing(sqlite3.connect(destination)) as target:
            origin.backup(target)
            if clear_sessions and target.execute("SELECT 1 FROM sqlite_master WHERE name='sessions'").fetchone():
                with target:
                    target.execute("DELETE FROM sessions")
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MigrationError("备份完整性校验失败")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return str(destination)


def migrate_file(path, backup_path, *, resolutions=None, actor="system:migration"):
    """Acquire the writer lock, back up the exact baseline, then migrate/commit."""
    with closing(_open(path, "rw")) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            backup = _copy(path, backup_path)
            report = migrate(db, resolutions=resolutions, actor=actor, backup_ref=backup)
            db.commit()
            return dict(report, backup=backup)
        except BaseException:
            db.rollback()
            raise


def restore_file(backup_path, destination):
    """Restore into a new path; never replace a running or existing database."""
    return dict(restored=_copy(backup_path, destination, clear_sessions=True), sessions_cleared=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    upgrade = commands.add_parser("migrate")
    upgrade.add_argument("source", type=Path)
    upgrade.add_argument("backup", type=Path)
    upgrade.add_argument("--resolutions", type=Path)
    restore = commands.add_parser("restore")
    restore.add_argument("backup", type=Path)
    restore.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.command == "migrate":
        facts = json.loads(args.resolutions.read_text(encoding="utf-8")) if args.resolutions else None
        result = migrate_file(args.source, args.backup, resolutions=facts)
    else:
        result = restore_file(args.backup, args.destination)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
