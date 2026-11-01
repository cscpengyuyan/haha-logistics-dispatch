"""Disposable, loopback-only synthetic rehearsal. Closing this process discards its private database."""
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
import argparse
import server
import practice

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=18765)
    parser.add_argument('--from-sales',action='store_true',help='从空白 DFW-Q01 开始，而不是从提货演示交接点开始')
    args=parser.parse_args()
    with TemporaryDirectory(prefix='haha-v12-walkthrough-') as workspace:
        path=Path(workspace)/'synthetic.sqlite3';server.initialize(path,True)
        if not args.from_sales:
            with closing(server.connect(path)) as db:
                for i,(role,_,_) in enumerate(practice.STEPS[:7]):
                    u=dict(username=role,role=role);db.execute("BEGIN IMMEDIATE")
                    with db:
                        state=practice.view(db,u)
                        practice.advance(db,dict(cursor=i,version=state['version'],reference=f'SIM-Q01-{i+1}'),u)
        with server.Server(('127.0.0.1',args.port),path,True) as app:
            print(f"http://127.0.0.1:{app.server_port}/v12/#{'tasks' if args.from_sales else 'gate'}",flush=True)
            try:app.serve_forever()
            except KeyboardInterrupt:pass

if __name__=='__main__':main()
