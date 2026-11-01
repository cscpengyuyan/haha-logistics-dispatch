"""Start the packaged V13 synthetic shared service and its bounded road worker."""
import argparse
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
from urllib.request import urlopen
from contextlib import closing

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--road-port', type=int, default=18803)
    args = parser.parse_args()
    if args.port == args.road_port:
        raise SystemExit('Business and road ports must differ.')
    for port in (args.port, args.road_port):
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                raise SystemExit(f'Port {port} is in use. Choose --port / --road-port; existing processes are left running.')
    roads = ROOT / '.deps' / 'roads'
    manifest = ROOT / 'data' / 'road-sim200' / 'regions.json'
    if not (roads / 'valhalla').is_dir() or not manifest.is_file():
        raise SystemExit('Native road package / regional graphs missing. Use the full Windows package, or Start-V13-Demo.cmd for the browser demo.')
    path = ROOT / 'data' / 'v13-sim200.sqlite3'
    if not path.exists():
        with closing(sqlite3.connect(ROOT / 'v13/data/sim200-ready.sqlite3')) as source, closing(sqlite3.connect(path)) as destination:
            source.backup(destination)
    env = os.environ.copy()
    env['PYTHONPATH'] = str(roads) + os.pathsep + str(ROOT / '.deps/optimizer')
    env.update(PYTHONUTF8='1', HH_APP_VERSION='v13', HH_VALHALLA_URL=f'http://127.0.0.1:{args.road_port}',
               HH_VROOM_URL=f'http://127.0.0.1:{args.road_port}', HH_ROAD_COVERAGE='DFW / Houston / Los Angeles / Atlanta bounded SIM regions',
               HH_ROAD_DATA_DATE='per-region manifest; see /status')
    logdir = ROOT / 'data' / 'logs'
    logdir.mkdir(parents=True, exist_ok=True)
    with (logdir / 'roads.log').open('a', encoding='utf8') as log:
        worker = subprocess.Popen([sys.executable, '-X', 'utf8', str(ROOT / 'road_host.py'), '--regions', str(manifest), '--port', str(args.road_port)],
                                  cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            for _ in range(100):
                if worker.poll() is not None:
                    raise RuntimeError('Road worker failed. See data/logs/roads.log; Python 3.12 64-bit is required by this package.')
                try:
                    with urlopen(env['HH_VALHALLA_URL'] + '/status', timeout=1) as response:
                        status = json.load(response)
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Road worker startup timed out; see data/logs/roads.log')
            print('V13 synthetic shared database: ' + str(path), flush=True)
            print(f'Open http://127.0.0.1:{args.port}/v13/#map', flush=True)
            print('Road graphs are limited to four test regions. Ctrl+C stops both services.', flush=True)
            service = subprocess.Popen([sys.executable, '-X', 'utf8', str(ROOT / 'server.py'), '--demo', '--db', str(path), '--port', str(args.port)], cwd=ROOT, env=env)
            try:
                return service.wait()
            finally:
                if service.poll() is None:
                    service.terminate()
                    service.wait(timeout=10)
        finally:
            if worker.poll() is None:
                worker.terminate()
                worker.wait(timeout=10)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
