"""Optional loopback worker for an operator-owned Valhalla graph and native VROOM."""
import argparse
import json
import os
import subprocess
import sys
import math
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def select_region(regions, request):
    """Require every matrix/route point to be inside one explicit local graph."""
    if not isinstance(request, dict):
        raise ValueError("Request must be an object")
    points=request.get('locations')
    if not points:
        sources,targets=request.get('sources',[]),request.get('targets',[])
        if not isinstance(sources,list) or not isinstance(targets,list):raise ValueError('Matrix sources and targets must be arrays')
        points=sources+targets
    if not isinstance(points,list) or not points:
        raise ValueError("Locations are required")
    for p in points:
        if not isinstance(p,dict) or any(type(p.get(k)) not in (int,float) or not math.isfinite(p[k]) for k in ('lat','lon')):
            raise ValueError("Each location requires finite latitude and longitude")
    matches=[]
    for region in regions:
        south,west,north,east=region['bbox']
        if all(south<=p['lat']<=north and west<=p['lon']<=east for p in points):matches.append(region)
    if len(matches)!=1:
        raise ValueError("ROAD_OUTSIDE_COVERAGE: all stops must fit one bounded city sample; intercity routing is unavailable")
    return matches[0]


def load_regions(manifest):
    path=Path(manifest).resolve();data=json.loads(path.read_text(encoding='utf-8'))
    regions=data.get('regions',[])
    if not regions or len({r['id'] for r in regions})!=len(regions):raise ValueError('Unique regions are required')
    for r in regions:
        if len(r['bbox'])!=4 or not(r['bbox'][0]<r['bbox'][2] and r['bbox'][1]<r['bbox'][3]):raise ValueError('Invalid region bbox')
        cfg=(path.parent/r['config']).resolve();body=json.loads(cfg.read_text(encoding='utf-8'))
        for key in ('tile_dir','tile_extract','traffic_extract','admin','timezone'):
            value=body.get('mjolnir',{}).get(key)
            if value and not Path(value).is_absolute():
                # Relative native paths avoid platform-dependent Unicode filename handling.
                body['mjolnir'][key]=os.path.relpath(cfg.parent/value,Path.cwd()).replace('\\','/')
        r['config_data']=body
    return regions


def serve(config, port, regions_manifest=None):
    from valhalla import Actor, __version__
    regions=load_regions(regions_manifest) if regions_manifest else []
    actors={r['id']:Actor(r['config_data']) for r in regions}
    actor = Actor(str(config)) if not regions else None

    class Worker(BaseHTTPRequestHandler):
        def answer(self, status, data):
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/status":
                self.answer(200, {"version": __version__, "data_date": os.environ.get("HH_ROAD_DATA_DATE", "") if not regions else 'per-region',
                    "coverage": os.environ.get("HH_ROAD_COVERAGE", "") if not regions else ', '.join(r['id'] for r in regions),
                    "regions":[{k:r.get(k) for k in ('id','name','bbox','data_date','source','source_sha256')} for r in regions],
                    "cross_region_routes":False if regions else None,"traffic":"static OSM; no live traffic"})
            else:
                self.answer(404, {"error": "Unknown operation"})

        def do_POST(self):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 512000:
                    return self.answer(413, {"error": "Invalid request size"})
                req = json.loads(self.rfile.read(size))
                if self.path == "/":
                    child = subprocess.run(
                        [sys.executable, "-c", "import vroom; vroom.main(['vroom','-t','2'])"],
                        input=json.dumps(req).encode(), capture_output=True, timeout=20,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    result = json.loads(child.stdout)
                    if child.returncode:
                        return self.answer(422, result)
                elif self.path in ("/sources_to_targets", "/route"):
                    selected=select_region(regions,req) if regions else None
                    current=actors[selected['id']] if selected else actor
                    operation = current.matrix if self.path == "/sources_to_targets" else current.route
                    result = operation(req)
                    if selected:result['coverage_region']={k:selected.get(k) for k in ('id','bbox','data_date','source')}
                else:
                    return self.answer(404, {"error": "Unknown operation"})
                self.answer(200, result)
            except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
                self.answer(422, {"error": str(error)[:240]})

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", port), Worker) as httpd:
        print("Road worker listening on loopback", httpd.server_port, flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, nargs='?')
    parser.add_argument("--regions",type=Path,help='Manifest of bounded city graphs; rejects routes spanning different regions')
    parser.add_argument("--port", type=int, default=18802)
    args = parser.parse_args()
    if not args.config and not args.regions:parser.error('config or --regions is required')
    serve(args.config, args.port, args.regions)
