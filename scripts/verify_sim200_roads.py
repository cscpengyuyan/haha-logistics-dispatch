"""Real native truck graph checks, distinct from the synthetic business replay."""
import argparse,hashlib,json,math,os,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'v13'/'engine'))
import simulation

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--dfw-config',required=True);ap.add_argument('--regions',nargs='+',default=['DFW','Houston','Los_Angeles','Atlanta']);args=ap.parse_args()
    import valhalla
    out=ROOT/'data'/'road-sim200';report_dir=ROOT/'docs'/'sim200'/'roads';report_dir.mkdir(parents=True,exist_ok=True)
    records=simulation.generate();report={};snap_map={}
    options=dict(costing='truck',costing_options=dict(truck=dict(length=8,width=2.5,height=3.5,weight=10,axle_load=6)),units='kilometers')
    for name in args.regions:
        region=name.replace('_',' ');cfg=Path(args.dfw_config) if name=='DFW' else out/(name+'-config.json')
        os.chdir(cfg.parent);start=time.perf_counter();actor=valhalla.Actor(cfg.name)
        subset=[r for r in records if r['coverage']['region']==region]
        city=subset[0]['order']['city'];geo=next(r for r in simulation.REGIONS if r[1]==city)
        raw_points=[dict(id=r['order']['id'],lat=r['order']['lat'],lon=r['order']['lng']) for r in subset]
        raw_points += [dict(id='SIM '+city,lat=geo[4],lon=geo[5]),dict(id='SIM '+city+' 接站',lat=geo[4]+.003,lon=geo[5]+.003)]
        unique={};details=[]
        for offset in range(0,len(raw_points),15):
            chunk=raw_points[offset:offset+15]
            located=actor.locate(dict(options,locations=[{k:p[k] for k in ('lat','lon')} for p in chunk],verbose=True))
            for original,loc in zip(chunk,located):
                edges=[e for e in loc.get('edges',[]) if e.get('edge',{}).get('access',{}).get('truck')]
                if not edges:raise RuntimeError(name+' no reachable truck edge for '+original['id'])
                edge=min(edges,key=lambda e:e['distance']);point=dict(lat=edge['correlated_lat'],lon=edge['correlated_lon'])
                key=(point['lat'],point['lon'])
                if key not in unique:unique[key]=point
                details.append(dict(id=original['id'],input=original,snapped=point,offset_m=edge['distance'],osm_way_id=edge['edge_info']['way_id'],street_names=edge['edge_info'].get('names',[])))
        pts=list(unique.values());matrix=actor.matrix(dict(options,sources=pts,targets=pts))
        cells=matrix['sources_to_targets']
        assert len(cells)==len(pts) and all(len(row)==len(pts) for row in cells)
        assert all(type(c['time']) in (int,float) and type(c['distance']) in (int,float) and c['time']>=0 and c['distance']>=0 for row in cells for c in row)
        route=actor.route(dict(options,locations=pts[:3]+[pts[0]]))
        assert len(route['trip']['legs'])==3 and all(leg.get('shape') for leg in route['trip']['legs'])
        durations=[[int(cells[i][j]['time']) for j in range(3)] for i in range(3)]
        distances=[[round(cells[i][j]['distance']*1000) for j in range(3)] for i in range(3)]
        vroom_input=dict(vehicles=[dict(id=i,profile='truck',start_index=0,end_index=0,capacity=[1],time_window=[0,86400]) for i in (1,2)],jobs=[dict(id=i,location_index=i,delivery=[1],service=600,time_windows=[[0,80000]]) for i in (1,2)],matrices=dict(truck=dict(durations=durations,distances=distances)))
        proc=subprocess.run([sys.executable,'-c',"import vroom;vroom.main(['vroom','-t','2'])"],input=json.dumps(vroom_input).encode(),capture_output=True,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        proc.check_returncode();vr=json.loads(proc.stdout)
        assert not vr['unassigned'] and len(vr['routes'])==2
        raw=dict(request_options=options,points=pts,matrix=matrix,closed_route=route,vroom_input=vroom_input,vroom_output=vr)
        raw_path=report_dir/(name+'-native.json');raw_path.write_text(json.dumps(raw,ensure_ascii=False),encoding='utf-8')
        snap_map[name]=details
        source=json.loads((out/(name+'.source.json')).read_text()) if name!='DFW' else dict(source='preexisting DFW fixture',config_sha256=hashlib.sha256(cfg.read_bytes()).hexdigest())
        result=dict(status='passed',valhalla_version=valhalla.__version__,source=source,input_orders=len(subset),unique_snapped_points=len(pts),matrix_pairs=len(pts)**2,
            asymmetric_pairs=sum(cells[i][j]['time']!=cells[j][i]['time'] for i in range(len(pts)) for j in range(i)),
            route_km=route['trip']['summary']['length'],route_seconds=route['trip']['summary']['time'],geometry_legs=3,vroom_vehicles_used=2,vroom_unassigned=0,
            max_snap_offset_m=max(p['offset_m'] for p in details),seconds=round(time.perf_counter()-start,3),raw_sha256=hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            limits=['Bounded city sample, no intercity routes','No live traffic or official truck permit guarantee','Snapping proves OSM road geometry, not customer entrance verification'])
        report[name]=result;print(json.dumps(result,ensure_ascii=False),flush=True)
        (report_dir/'road-integration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        (report_dir/'coordinate-snap-map.json').write_text(json.dumps(snap_map,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
