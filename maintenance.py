"""Offline migration inspection and reversible restore into an unused database path."""
import argparse,json,sqlite3
from contextlib import closing
from pathlib import Path

def source(path):
    if not path.is_file():raise ValueError("找不到数据库")
    db=sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True)
    if db.execute("PRAGMA integrity_check").fetchone()[0]!="ok":db.close();raise ValueError("完整性校验失败")
    if not {"metadata","orders","files","events"}<={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}:db.close();raise ValueError("不是共享工作库")
    return db

def inspect(path):
    with closing(source(path)) as db:
        mode=db.execute("SELECT value FROM metadata WHERE key='mode'").fetchone()[0]
        pending=[]
        for oid,status,data in db.execute("SELECT id,status,data FROM orders"):
            o=json.loads(data)
            if not o.get("pickup") and status in ("dispatched","in_transit","at_station","last_mile","delivered","settled") and not o.get("gate_grant_id"):
                pending.append(dict(id=oid,status=status,reason="历史承运/人车未核；不得按姓名自动归属"))
        return dict(mode=mode,orders=db.execute("SELECT COUNT(*) FROM orders").fetchone()[0],attachments=db.execute("SELECT COUNT(*) FROM files").fetchone()[0],legacy_review=pending)
def copy_db(src,dst,clear_sessions):
    with closing(source(src)) as origin:
        with dst.open("xb"):pass
        try:
            with closing(sqlite3.connect(dst)) as db:
                origin.backup(db)
                if clear_sessions:
                    with db:db.execute("DELETE FROM sessions")
            return inspect(dst)
        except BaseException:
            dst.unlink(missing_ok=True)
            raise
def restore(src,dst):return copy_db(src,dst,True)

if __name__=="__main__":
    p=argparse.ArgumentParser();cmd=p.add_subparsers(dest="action",required=True)
    cmd.add_parser("preflight").add_argument("source",type=Path)
    for name in ("backup","restore"):
        r=cmd.add_parser(name);r.add_argument("source",type=Path);r.add_argument("destination",type=Path)
    a=p.parse_args();print(json.dumps(inspect(a.source) if a.action=="preflight" else copy_db(a.source,a.destination,a.action=="restore"),ensure_ascii=False,indent=2))
