"""Build bounded OSM fixtures with locally installed Valhalla, preserving sources."""
import argparse,hashlib,json,os,subprocess,sys,time,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base-config',required=True);ap.add_argument('regions',nargs='+');args=ap.parse_args()
    import osmium,valhalla
    out=ROOT/'data'/'road-sim200';os.chdir(out)
    package=Path(valhalla.__file__).parent
    exe=package/'bin'/'valhalla_build_tiles.exe'
    env=dict(os.environ,PATH=str(package.parent/'pyvalhalla.libs')+os.pathsep+os.environ.get('PATH',''))
    class Convert(osmium.SimpleHandler):
        def __init__(self,writer):super().__init__();self.writer=writer
        def node(self,x):self.writer.add_node(x)
        def way(self,x):self.writer.add_way(x)
        def relation(self,x):self.writer.add_relation(x)
    for region in args.regions:
        src=Path(region+'.osm');pbf=Path(region+'.osm.pbf')
        root=ET.fromstring(src.read_bytes())
        if root.tag!='osm' or root.find('remark') is not None:raise ValueError('Not a complete OSM response')
        if not pbf.exists():
            with osmium.SimpleWriter(str(pbf)) as writer:Convert(writer).apply_file(str(src))
        conf=json.loads(Path(args.base_config).read_text())
        conf['mjolnir'].update(tile_dir=region+'-graph',tile_extract='',concurrency=2)
        conf['mjolnir']['data_processing']['use_admin_db']=False
        # This sample has no civil timezone polygons. Business timestamps remain explicit UTC.
        conf['logging']={'type':'','color':False}
        cp=Path(region+'-config.json');cp.write_text(json.dumps(conf),encoding='utf-8')
        started=time.perf_counter()
        proc=subprocess.run([str(exe),'-c',str(cp),str(pbf)],env=env,capture_output=True,timeout=240,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        Path(region+'-build.log').write_bytes(proc.stdout+proc.stderr)
        print(json.dumps(dict(region=region,returncode=proc.returncode,seconds=round(time.perf_counter()-started,3),pbf_sha256=hashlib.sha256(pbf.read_bytes()).hexdigest(),valhalla=valhalla.__version__)),flush=True)
        proc.check_returncode()

if __name__=='__main__':main()
