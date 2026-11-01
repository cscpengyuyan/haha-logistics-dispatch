"""Fetch bounded public OSM road samples for reproducible SIM200 road tests."""
import json,hashlib,urllib.request,urllib.parse,xml.etree.ElementTree as ET
from pathlib import Path
REGIONS={'Houston':(29.7304,-95.3998,29.7984,-95.3278),'Los_Angeles':(34.0222,-118.2737,34.0902,-118.2017),'Atlanta':(33.719,-84.418,33.787,-84.346)}
out=Path('data/road-sim200');out.mkdir(parents=True,exist_ok=True)
for name,bbox in REGIONS.items():
 p=out/(name+'.osm')
 if not p.exists():
  bounds=','.join(map(str,bbox))
  query=f'[out:xml][timeout:90];way[highway]({bounds})->.roads;(.roads;rel(bw.roads)[type=restriction];);(._;>;);out meta;'
  url='https://overpass.kumi.systems/api/interpreter?'+urllib.parse.urlencode({'data':query})
  with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'HAHA-SIM200-QA/1.0 (bounded fictional logistics test)'}),timeout=110) as r:raw=r.read()
  root=ET.fromstring(raw)
  if root.find('remark') is not None:raise RuntimeError(root.find('remark').text)
  p.write_bytes(raw)
 root=ET.fromstring(p.read_bytes())
 info={'region':name,'bbox':bbox,'source':'https://overpass-api.de/api/interpreter','osm_base':root.find('meta').attrib if root.find('meta') is not None else {},'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'nodes':len(root.findall('node')),'ways':len(root.findall('way'))}
 p.with_suffix('.source.json').write_text(json.dumps(info,indent=2))
 print(json.dumps(info),flush=True)
