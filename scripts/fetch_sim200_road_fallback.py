"""Bounded retry for publicly sourced OSM road samples; no synthetic fallback."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib,json,urllib.request,urllib.parse,xml.etree.ElementTree as ET
REGIONS={'Los_Angeles':(34.0422,-118.2537,34.0702,-118.2217),'Atlanta':(33.739,-84.398,33.767,-84.366)}
ROOT=Path(__file__).resolve().parents[1]/'data'/'road-sim200'
def fetch(item):
    name,bbox=item;path=ROOT/(name+'.osm')
    for endpoint in ['https://overpass.kumi.systems/api/interpreter','https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter']:
        q=f'[out:xml][timeout:40];way[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|service)$"]({",".join(map(str,bbox))})->.r;(.r;rel(bw.r)[type=restriction];);(._;>;);out meta;'
        try:
            url=endpoint+'?'+urllib.parse.urlencode({'data':q})
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'HAHA-SIM200-bounded-QA/1.0'}),timeout=55) as response:raw=response.read()
            root=ET.fromstring(raw)
            if root.tag!='osm' or root.find('remark') is not None:raise RuntimeError('incomplete query')
            path.write_bytes(raw)
            info=dict(region=name,bbox=bbox,source=endpoint,query=q,osm_base=root.find('meta').attrib if root.find('meta') is not None else {},nodes=len(root.findall('node')),ways=len(root.findall('way')),sha256=hashlib.sha256(raw).hexdigest())
            path.with_suffix('.source.json').write_text(json.dumps(info,indent=2));print(json.dumps(info),flush=True);return
        except Exception as e:print(name,endpoint,type(e).__name__,str(e),flush=True)
    raise RuntimeError(name+' real OSM download failed')
if __name__=='__main__':
    with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(fetch,REGIONS.items()))
