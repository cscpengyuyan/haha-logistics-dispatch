"""Refresh same-origin public cache keys, including dynamically imported Python source."""
from pathlib import Path
import hashlib,re,os
ROOT=Path(__file__).resolve().parent/os.environ.get('HH_APP_VERSION','v13')
def digest(paths):
    h=hashlib.sha256()
    for p in paths:h.update(p.name.encode());h.update(p.read_bytes().replace(b'\r\n',b'\n'))
    return h.hexdigest()[:12]
def update():
    worker=ROOT/'demo-worker.js';demo=ROOT/'demo.js';app=ROOT/'app.js';html=ROOT/'index.html'
    ws=digest([worker,*sorted((ROOT/'engine').glob('*.py'))])
    s=demo.read_text(encoding='utf8')
    demo.write_text(re.sub(r'demo-worker\.js(?:\?v=[a-z0-9]+)?','demo-worker.js?v='+ws,s),encoding='utf8')
    s=app.read_text(encoding='utf8')
    for name in ('vendor/leaflet.js','vendor/us-states.js','dispatch-map.js'):
        s=re.sub(r"script\('\./"+re.escape(name)+r"(?:\?v=[a-z0-9]+)?'\)","script('./"+name+'?v='+digest([ROOT/name])+"')",s)
    app.write_text(s,encoding='utf8')
    html.write_text(re.sub(r'((?:src|href)="\./)([^"?]+\.(?:js|css))(?:\?v=[a-z0-9]+)?(")',lambda m:m[1]+m[2]+'?v='+digest([ROOT/m[2]])+m[3],html.read_text(encoding='utf8')),encoding='utf8')
if __name__=='__main__':update()
