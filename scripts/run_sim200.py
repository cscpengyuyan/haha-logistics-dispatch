"""Replay SIM200 through V13 domain services; persist every success and rejection.

Usage: python -X utf8 scripts/run_sim200.py --output docs/sim200/run
Re-running resumes committed steps. Only a new dedicated output directory is initialized.
Carrier evidence below is explicitly a synthetic test double, NOT a real-road integration test.
"""
import argparse, base64, collections, hashlib, json, sqlite3, sys, time
from datetime import date,timedelta
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'v13'/'engine'))
import core, simulation, operations, sales, lifecycle, supply, folder, gate, routing, practice
U=simulation.actor

class Replay:
    def __init__(self,path):
        self.path=path;path.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(path/'SIM200.sqlite3');self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        exists=self.db.execute("SELECT 1 FROM sqlite_master WHERE name='metadata'").fetchone()
        if exists:simulation.only_demo(self.db)
        core.core_schema(self.db);operations.init_db(self.db);gate.schema(self.db)
        self.db.execute("INSERT OR IGNORE INTO metadata VALUES('mode','demo')")
        self.db.execute("CREATE TABLE IF NOT EXISTS sim200_steps (oid TEXT,step TEXT,result TEXT,PRIMARY KEY(oid,step))")
        self.db.execute("CREATE TABLE IF NOT EXISTS sim200_trace (seq INTEGER PRIMARY KEY,oid TEXT,step TEXT,data TEXT)")
        self.db.commit();self.rows=simulation.generate();self.resources=None

    def order(self,oid):return core.get_order(self.db,oid,U('dispatch'))

    def step(self,oid,name,role,fn,business_time=None,expect_error=False):
        old=self.db.execute('SELECT result FROM sim200_steps WHERE oid=? AND step=?',(oid,name)).fetchone()
        if old:return json.loads(old[0])
        before=self.db.execute('SELECT version,status FROM orders WHERE id=?',(oid,)).fetchone()
        event=dict(order_id=oid,step=name,role=role,actor=role,wall_clock=core.now(),business_time=business_time or '2026-11-01T00:00:00Z',
            before_version=before['version'] if before else None,before_status=before['status'] if before else None)
        account=self.db.execute('SELECT role FROM users WHERE username=?',(role,)).fetchone()
        if account:event['role']=account[0]
        try:
            with self.db:
                out=fn()
                if expect_error:raise AssertionError('Expected the real domain service to reject this action')
                after=self.db.execute('SELECT version,status FROM orders WHERE id=?',(oid,)).fetchone()
                event.update(assertion='passed',after_version=after['version'] if after else None,after_status=after['status'] if after else None,response=out)
                self.db.execute('INSERT INTO sim200_steps VALUES(?,?,?)',(oid,name,json.dumps(out,ensure_ascii=False)))
                self.db.execute('INSERT INTO sim200_trace(oid,step,data) VALUES(?,?,?)',(oid,name,json.dumps(event,ensure_ascii=False)))
                return out
        except Exception as exc:
            self.db.rollback();event.update(assertion='expected_rejection' if expect_error and isinstance(exc,core.ApiError) else 'failed',error=str(exc),status_code=getattr(exc,'status',None))
            with self.db:
                self.db.execute('INSERT INTO sim200_trace(oid,step,data) VALUES(?,?,?)',(oid,name,json.dumps(event,ensure_ascii=False)))
                if expect_error and isinstance(exc,core.ApiError):
                    self.db.execute('INSERT INTO sim200_steps VALUES(?,?,?)',(oid,name,json.dumps(event,ensure_ascii=False)));return event
            raise

    def action(self,oid,name,role,**data):
        o=self.order(oid)
        return core.apply_action(self.db,oid,dict(data,action=name,version=o['version']),U(role))

    def qualify(self,sid,wh,zip_code,action,product='T2'):
        data=dict(supplier_id=sid,executor_id=sid,product=product,warehouse_id=wh,zip=zip_code,model='M01',action=action)
        cell=core.encode([data[k] for k in supply.CELL])
        old=self.db.execute('SELECT data FROM capability WHERE cell=?',(cell,)).fetchone()
        if old:return json.loads(old[0])
        return supply.qualify(self.db,dict(data,decision='Y',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-CAPABILITY'),U('procurement'))

    def setup(self):
        self.resources=simulation.provision(self.db);self.db.commit()
        self.step('BATCH','sales_import','sales',lambda:simulation.import_orders(self.db,U('sales')))
        repeated=self.step('BATCH','sales_duplicate','sales',lambda:simulation.import_orders(self.db,U('sales')))
        assert repeated['added']==0 and repeated['changed']==0
        for row in self.rows:
            o=row['order'];oid=o['id'];m=row['coverage']
            self.step(oid,'logistics_handoff','dispatch',lambda oid=oid,o=o:sales.handoff(self.db,dict(id=oid,version=self.order(oid)['version'],level=o['level']),U('dispatch')),o['window_start'])
            edit={k:o[k] for k in ('route','lat','lng','location_precision','coordinate_ref','procurement_mode','pack_version','a_channel')}
            self.step(oid,'confirm_route_location','dispatch',lambda oid=oid,edit=edit:core.edit_order(self.db,oid,dict(edit,version=self.order(oid)['version']),U('dispatch')),o['window_start'])
            if not m['ocean_batch']:
                for sn in m['serials']:
                    self.step(oid,'initial_receipt_'+sn,'warehouse',lambda o=o,sn=sn,m=m:lifecycle.receipt(self.db,dict(sn=sn,warehouse=o['warehouse'],model=o['model'],bin='SIM-A',condition='SIM QC 合格',batch='SIM-D 已有前置库存' if m['existing_positioned'] else 'SIM-INITIAL',state='available',evidence='SIM-INITIAL-GRN'),U('warehouse')),'2026-10-30T10:00:00Z')
        self.ocean()

    def ocean(self):
        for n in range(1,5):
            key=f'SIM-OCEAN-{n}';items=[r for r in self.rows if r['coverage']['ocean_batch']==n]
            wh=self.resources['places']['Dallas'];units=[dict(sn=sn,model='M01',order_id=r['order']['id'],packing=dict(length_cm=100,width_cm=83,height_cm=191,weight_kg=226,upright=True,nonstackable=True)) for r in items for sn in r['coverage']['serials']]
            booked=self.step(key,'book','warehouse',lambda:supply.book(self.db,dict(voyage=key,batch=key,container=key+'-CN',asn=key,origin='SIM Shanghai',port='SIM Houston',warehouse_id=wh['id'],warehouse_zone=wh['timezone'],origin_zone='Asia/Shanghai',port_zone='America/Chicago',owner='warehouse',procurement_ref='SIM-WRITTEN-BOOKING',evidence='SIM-BOOK',mode='FCL',inland='road',seal='SIM-SEAL',bill_of_lading='SIM-BL',pickup_site='SIM-PORT',inland_owner='SIM-DRAY',planned_etd='2026-10-01T10:00:00+08:00',planned_eta='2026-10-22T10:00:00-05:00',planned_warehouse='2026-10-25T10:00:00-05:00',units=units),U('warehouse')),'2026-09-30T10:00:00+08:00')
            sid=booked['shipment']['id']
            def mile(kind,at):
                return supply.milestone(self.db,dict(id=sid,version=supply.shipment(self.db,sid)['version'],kind=kind,at=at,evidence='SIM-'+kind,custodian='SIM-CUSTODY'),U('warehouse'))
            events=[('shipping_docs','2026-09-30T10:00:00+08:00'),('loaded','2026-10-01T10:00:00+08:00'),('eta','2026-10-24T10:00:00-05:00'),('arrived','2026-10-24T10:00:00-05:00'),('handoff_site','2026-10-24T11:00:00-05:00'),('customs','2026-10-24T12:00:00-05:00'),('carrier_release','2026-10-24T13:00:00-05:00'),('terminal_ready','2026-10-24T14:00:00-05:00')]
            if n==2:events += [('hold','2026-10-24T14:05:00-05:00')]
            for kind,at in events:self.step(key,kind,'warehouse',lambda kind=kind,at=at:mile(kind,at),at)
            if n==2:
                self.step(key,'held_pickup_rejected','warehouse',lambda:mile('pickup','2026-10-24T15:00:00-05:00'),expect_error=True)
                self.step(key,'clear_hold','warehouse',lambda:mile('clear_hold','2026-10-24T15:30:00-05:00'))
            for kind,at in [('pickup','2026-10-24T16:00:00-05:00'),('warehouse_arrival','2026-10-25T10:00:00-05:00'),('empty_return','2026-10-26T10:00:00-05:00')]:
                self.step(key,kind,'warehouse',lambda kind=kind,at=at:mile(kind,at),at)
            for j,unit in enumerate(units):
                sn=unit['sn'];oid=unit['order_id'];held=n==4 and j==0
                self.step(oid,'ocean_receive_'+sn,'warehouse',lambda sn=sn,held=held:supply.receive(self.db,dict(id=sid,version=supply.shipment(self.db,sid)['version'],sn=sn,state='hold' if held else 'available',condition='SIM 待复检' if held else 'SIM 合格',bin='SIM-QC',custodian='warehouse',evidence='SIM-GRN'),U('warehouse')),'2026-10-25T10:30:00-05:00')
                if held:
                    self.step(oid,'quarantined_reservation_rejected','warehouse',lambda oid=oid:self.action(oid,'ready','warehouse',sn=','.join(next(r['coverage']['serials'] for r in self.rows if r['order']['id']==oid)),release_ref='SIM-QC-BLOCK'),expect_error=True)
                    self.step(oid,'qc_release','warehouse',lambda sn=sn:lifecycle.inspect_asset(self.db,dict(sn=sn,version=self.db.execute('SELECT version FROM assets WHERE sn=?',(sn,)).fetchone()[0],state='available',bin='SIM-A',condition='SIM 复检合格',evidence='SIM-QC-RELEASE'),U('warehouse')))

    def commission(self,oid,m):
        o=self.order(oid);fleet=self.resources['fleets'][m['vehicle_number']-1];supplier=fleet['supplier'];sid=supplier['id'];wh=self.resources['places'][o['city']]
        for a in [o['level']]+(['L4'] if o['addon_l4'] else []):self.qualify(sid,wh['id'],o['zip'],a)
        q=operations.save_resource(self.db,dict(type='quote',name='SIM Full price '+oid,order_id=oid,carrier=supplier['name'],path=o['route'],scope='SIM 全程交付，含适用专项及技术；币种 USD',comparison_ref='SIM-SAME-SCOPE',amount=400,valid_until='2036-12-31',evidence='SIM-QUOTE',supplier_id=sid,executor_id=sid,product='T2',accepted_ref='SIM-ACCEPT',origin_cost=40,station_cost=40,delivery_cost=200,special_cost=120,other_cost=0),U('procurement'))['resource']
        operations.award_quote(self.db,dict(id=q['id'],quote_version=q['version'],version=o['version'],approval_ref='SIM-APPROVAL'),U('procurement'))
        o=self.order(oid)
        if o['procurement_mode']=='platform':
            folder.platform_instruction(self.db,o,dict(account_ref='SIM-ACCOUNT',instruction_ref='SIM-INSTR',executor_id=sid,carrier=supplier['name'],acceptance_ref='SIM-ACCEPT',valid_until='2036-12-31',bol_ref='SIM-BOL-'+oid,pickup_ref='SIM-PICK-'+oid,identity_ref='SIM-ID'),U('procurement'))
        if o['addon_l5']:
            self.qualify(sid,wh['id'],o['zip'],'L5','T5')
            folder.technical(self.db,self.order(oid),dict(supplier_id=sid,executor_id=sid,acceptance_ref='SIM-T5-ACCEPT',scope='SIM 独立逐台启用验收',amount=120),U('procurement'))
        if o['route'] in ('C1','C2'):
            station=self.resources['places'][o['city']+' station']
            self.qualify(sid,station['id'],station['zip'],'receive','T3')
            for a in [o['level']]+(['L4'] if o['addon_l4'] else []):self.qualify(sid,station['id'],o['zip'],a)
            mandate=dict(station_id=station['id'],station_supplier_id=sid,station_executor_id=sid,station_acceptance_ref='SIM-STORAGE')
            if o['route']=='C2':folder.station_mandate(self.db,self.order(oid),mandate,U('procurement'))
            else:folder.second_leg(self.db,self.order(oid),dict(mandate,supplier_id=sid,executor_id=sid,product='T2',carrier=supplier['name'],valid_until='2036-12-31',quote_ref='SIM-LAST-QUOTE',approved_ref='SIM-LAST-APPROVAL',acceptance_ref='SIM-LAST-ACCEPT',amount=150),U('procurement'))
        return dict(supplier=supplier,quote=q)

    def dispatch(self,oid,m,leg=1):
        o=self.order(oid);fleet=self.resources['fleets'][m['vehicle_number']-1];sid=fleet['supplier']['id'];day=o['window_start'][:10]
        data=dict(carrier=fleet['supplier']['name'],approved_cost=400,dispatch_ref='SIM-ISSUE',handoff_ref='SIM-HANDOFF',all_legs_contract='SIM-C1-CONTRACT',receiver_site='SIM-SITE',appointment_ref='SIM-APT',shipment_ref='SIM-FBA',label_ref='SIM-LABEL',receiving_terms='SIM-DOCK-TERMS',receiver_contact='SIM receiver',handoff_terms='SIM unload',checks={k:'SIM-'+k for k in core.CHECKS})
        if o['procurement_mode']!='platform' or leg==2:
            origin=self.resources['places'][o['city']+(' station' if leg==2 else '')]
            link=gate.network(self.db,dict(executor_id=sid,crew_id=fleet['crew']['id'],vehicle_id=fleet['vehicle']['id'],driver=fleet['driver'],plate='SIM-'+str(m['vehicle_number']),warehouse_id=origin['id'],zip=o['zip'],model='M01',level=o['level'],product='T2',valid_until='2036-12-31',insurance_until='2036-12-31',evidence='SIM-NET'),U('procurement'))
            g=gate.invite(self.db,o,dict(leg=leg,link_id=link['id'],evidence='SIM-INVITE'),U('procurement'))
            gate.handle(self.db,'POST',f'/api/gate/{oid}/accept',dict(version=o['version'],grant_version=g['version'],leg=leg,evidence='SIM-ACCEPT'),U('procurement'))
            p=dict(name='SIM Route '+oid,warehouse=origin['name'],date=day,start_time='12:00' if leg==2 else '08:00',timezone=o['timezone'],resource_id=fleet['vehicle']['id'],crew_id=fleet['crew']['id'],executor_id=sid,order_ids=[oid],order_versions={oid:o['version']},road_basis='carrier',
                checks=dict(driver=fleet['driver'],scope_ref='SIM-SCOPE',handling_ref='SIM-TOOL',shift_start=day+'T07:00',shift_end=day+'T19:00',warehouse_start=day+'T07:00',warehouse_end=day+'T17:00',return_min=25),
                stops={oid:dict(from_id=origin['id'],road_ref='SIM-CONTROLLED-CARRIER-EVIDENCE-NOT-REAL-ROAD',dock_ref='SIM-DOCK',package_ref='SIM-PACK',height=191,kg=226,length_cm=100,width_cm=83,required_people=2,required_tools='dolly,straps',requires_lift='yes',travel=30,admission=10,unload=10,service=40,finish_by=day+'T17:00')})
            route=operations.save_route(self.db,p,U('dispatch'))['route']
            data.update(driver=fleet['driver'],route_id=route['id'],route_version=route['version'])
        return self.action(oid,'station_release' if leg==2 else 'dispatch','dispatch',**data)

    def verify(self,oid,m,wrong=False):
        o=self.order(oid);fleet=self.resources['fleets'][m['vehicle_number']-1]
        b=dict(release_version=o['issue_version'],pickup_code=o['pickup_code'],bol_ref='SIM-BOL-'+oid,identity_ref='SIM-ID',sns=['SIM-WRONG'] if wrong else m['serials'],evidence='SIM-GATE',driver=fleet['driver'],plate='SIM-'+str(m['vehicle_number']),crew_id=fleet['crew']['id'],vehicle_id=fleet['vehicle']['id'])
        return gate.verify(self.db,o,b,U('warehouse'))

    def complete(self,oid,m):
        o=self.order(oid);day=o['window_start'][:10]
        role='warehouse' if o.get('pickup') else 'dispatch' if o['procurement_mode']=='platform' and o['route'] not in ('C1','C2') else 'driver'
        u=U(role)
        if role=='driver':u['username']=self.resources['fleets'][m['vehicle_number']-1]['driver']
        fid=core.add_file(self.db,oid,dict(version=o['version'],release_version=o.get('issue_version'),category='pod',name=oid+'-SIM.pdf',base64=practice.synthetic_pod()),u)['file']['id']
        o=self.order(oid)
        folder.add_attempt(self.db,o,dict(release_version=o.get('issue_version'),arrival_local=day+'T14:00',finished_local=day+'T14:45',location=o['endpoint'],evidence='SIM-POD-'+oid,units=[dict(sn=sn,outcome='success',details='SIM 逐台交接',location=o['endpoint'],pod_id=fid) for sn in m['serials']]),u)
        o=self.order(oid)
        return core.apply_action(self.db,oid,dict(action='pickup' if o.get('pickup') else 'deliver',version=o['version'],release_version=o.get('issue_version'),signer='SIM collector' if o.get('pickup') else 'SIM receiver',delivered_at=day+'T14:45',delivery_note='SIM-DONE',dispatch_ref='SIM-PU',approved_cost=0,endpoint_receipt_ref='SIM-F05'),u)

    def flow(self,row):
        o=row['order'];m=row['coverage'];oid=o['id']
        times=dict(reserve='06:30',commission='06:45',dispatch='07:30',dock_handover='08:00',station_receive='10:30',purchase_last_mile='11:00',station_release='11:30',station_gate='12:00',delivery='14:45',technical_acceptance='15:30',settlement='16:30',platform_receipt='16:00')
        step=lambda name,role,fn,**kw:self.step(oid,name,role,fn,o['window_start'][:10]+'T'+times.get(name,'06:00'),**kw)
        if m.get('recovery'):
            step('wrong_sn_blocked','warehouse',lambda:self.action(oid,'ready','warehouse',sn='SIM-NOT-IN-STOCK',release_ref='SIM-BAD'),expect_error=True)
        step('reserve','warehouse',lambda:self.action(oid,'ready','warehouse',sn=','.join(m['serials']),release_ref='SIM-RESERVE'))
        if m['expected_terminal']=='cancelled':
            step('cancel','sales',lambda:self.action(oid,'cancel','sales',reason='SIM 客户取消，未出库'));return
        if o['pickup']:
            step('pickup_gate','warehouse',lambda:self.action(oid,'pickup_gate','warehouse',collector='SIM collector',authority_ref='SIM-PU',vehicle_ref='SIM-PU-CAR',secure_ref='SIM-STRAP',package_height_cm=191,door_cm=240,gross_kg=226,payload_kg=1000))
        else:
            step('commission','procurement',lambda:self.commission(oid,m))
            step('dispatch','dispatch',lambda:self.dispatch(oid,m))
            if m.get('recovery'):step('wrong_gate_sn_blocked','warehouse',lambda:self.verify(oid,m,True),expect_error=True)
            step('dock_handover','warehouse',lambda:self.verify(oid,m))
            if o['route'] in ('C1','C2'):
                st=self.resources['places'][o['city']+' station'];fleet=self.resources['fleets'][m['vehicle_number']-1];sid=fleet['supplier']['id']
                step('station_receive','warehouse',lambda:self.action(oid,'station_receive','warehouse',station_name=st['name'],custodian='SIM station',receipt_ref='SIM-STATION-GRN',units=[dict(sn=sn,condition='SIM 完好',evidence='SIM-SCAN') for sn in m['serials']]))
                if o['route']=='C2':
                    step('missing_last_mile_blocked','dispatch',lambda:self.action(oid,'station_release','dispatch',carrier='SIM',dispatch_ref='SIM'),expect_error=True)
                    step('purchase_last_mile','procurement',lambda:folder.second_leg(self.db,self.order(oid),dict(station_id=st['id'],supplier_id=sid,executor_id=sid,product='T2',carrier=fleet['supplier']['name'],valid_until='2036-12-31',quote_ref='SIM-LAST-QUOTE',approved_ref='SIM-LAST-APPROVE',acceptance_ref='SIM-LAST-ACCEPT',amount=150),U('procurement')))
                step('station_release','dispatch',lambda:self.dispatch(oid,m,2))
                if o['route']=='C2' and int(oid[-3:])<=163:
                    step('revoke_second_leg','procurement',lambda:gate.handle(self.db,'POST',f'/api/gate/{oid}/revoke',dict(version=self.order(oid)['version'],grant_version=gate.active(self.db,oid,2)['version'],evidence='SIM 承接改派'),U('procurement')))
                    step('replace_second_leg','procurement',lambda:folder.second_leg(self.db,self.order(oid),dict(station_id=st['id'],supplier_id=sid,executor_id=sid,product='T2',carrier=fleet['supplier']['name'],valid_until='2036-12-31',quote_ref='SIM-REVISED-LAST',approved_ref='SIM-REVISED-APPROVE',acceptance_ref='SIM-REVISED-ACCEPT',amount=150,change_reason='SIM 原班次撤回后改约',waiver_ref='SIM 原班次免收',storage_cost=12),U('procurement')))
                    step('resign_second_leg','dispatch',lambda:self.dispatch(oid,m,2))
                step('station_gate','warehouse',lambda:self.verify(oid,m))
        delivery_actor='warehouse' if o['pickup'] else 'dispatch' if o['procurement_mode']=='platform' and o['route'] not in ('C1','C2') else self.resources['fleets'][m['vehicle_number']-1]['driver']
        if 53<=int(oid[-3:])<=62:
            def failed_attempt():
                current=self.order(oid)
                return folder.add_attempt(self.db,current,dict(release_version=current['issue_version'],arrival_local=o['window_start'][:10]+'T10:00',finished_local=o['window_start'][:10]+'T10:15',location=o['endpoint'],evidence='SIM 首次到场失败',next_step='SIM 取得物业准入后再次尝试',custodian=delivery_actor,units=[dict(sn=sn,outcome='failed',details='SIM 物业临时拒绝准入',location=o['endpoint']) for sn in m['serials']]),dict(role='driver',username=delivery_actor))
            step('failed_first_attempt',delivery_actor,failed_attempt)
        step('delivery',delivery_actor,lambda:self.complete(oid,m))
        if o['addon_l5']:
            step('technical_acceptance','service',lambda:self.action(oid,'service_complete','service',result_ref='SIM-TECH-PASS',service_units=[dict(sn=sn,result='SIM 联网支付测试通过',customer_ref='SIM-TECH-CUSTOMER') for sn in m['serials']]))
        if o.get('a_channel')=='amazon' and not o['pickup']:
            step('platform_receipt','sales',lambda:folder.record_receipt(self.db,self.order(oid),dict(shipment_ref='SIM-FBA',signed_qty=o['quantity'],received_qty=o['quantity'],state='closed',resolution='SIM 平台实收',evidence='SIM-RECEIPT',owner='sales'),U('sales')))
        step('settlement','finance',lambda:self.action(oid,'settle','finance',actual_cost=0 if o['pickup'] else self.order(oid)['approved_cost'],invoice_ref='SIM-INVOICE-'+oid,paid_ref='SIM-PAID'))

    def export(self,failures):
        traces=[json.loads(r[0]) for r in self.db.execute('SELECT data FROM sim200_trace ORDER BY seq')]
        (self.path/'trace.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in traces),encoding='utf-8')
        result=simulation.summary(self.db,U('dispatch'));result['failures']=failures
        states=dict(self.db.execute("SELECT state,count(*) FROM assets WHERE sn GLOB 'SIM-SN-*' GROUP BY state"))
        result.update(engine=str(Path(core.__file__).relative_to(ROOT)),inventory=states,real_road_integration='not_run: synthetic carrier evidence only',
            aftercare_closed=self.db.execute("SELECT count(*) FROM after_cases WHERE kind='restore' AND state='closed'").fetchone()[0],
            expected_rejections=sum(r['assertion']=='expected_rejection' for r in traces),trace_events=len(traces))
        mains=[self.order(r['order']['id']) for r in self.rows]
        children=[core.unpack(r) for r in self.db.execute("SELECT * FROM orders WHERE json_extract(data,'$.order_kind')='repair_redelivery'")]
        result.update(first_delivery_unique_sns=len({sn for o in mains for sn in o.get('completed_sns',[])}),
            main_actual_cost=sum(o.get('actual_cost',0) for o in mains),repair_actual_cost=sum(o.get('actual_cost',0) for o in children),
            repair_redelivery_orders=len(children),repair_redelivery_settled=sum(o['status']=='settled' for o in children),
            open_aftercare=self.db.execute("SELECT count(*) FROM after_cases WHERE state!='closed'").fetchone()[0],
            cancelled_sn_locks=self.db.execute("SELECT count(*) FROM sn_locks l JOIN orders o ON o.id=l.order_id WHERE o.status='cancelled'").fetchone()[0],
            orphan_bookings=self.db.execute("SELECT count(*) FROM route_bookings b LEFT JOIN orders o ON b.oid=o.id WHERE o.id IS NULL").fetchone()[0] if self.db.execute("SELECT 1 FROM sqlite_master WHERE name='route_bookings'").fetchone() else 0,
            initial_stock_units=sum(len(r['coverage']['serials']) for r in self.rows if not r['coverage']['ocean_batch']),
            ocean_receipt_units=self.db.execute('SELECT count(*) FROM manifest WHERE receipt IS NOT NULL').fetchone()[0])
        if result['complete']:
            assert result['first_delivery_unique_sns']==252 and states=={'available':8,'delivered':252}
            assert result['cancelled_sn_locks']==result['orphan_bookings']==0
        result['full_acceptance']=result['complete'] and result['aftercare_closed']==20 and result['real_road_integration']=='passed'
        (self.path/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        (self.path/'results.csv').write_text('order_id,status,version\n'+''.join(f"{r['id']},{r['status']},{r['version']}\n" for r in result['rows']),encoding='utf-8-sig')
        return result

    def aftercare(self,row):
        oid=row['order']['id'];m=row['coverage'];sn=m['serials'][0];o=self.order(oid)
        day=(date.fromisoformat(o['window_start'][:10])+timedelta(days=20)).isoformat()
        step=lambda name,role,fn,**kw:self.step(oid,'aftercare_'+name,role,fn,day+'T10:00',**kw)
        def case(cid):return dict(self.db.execute('SELECT * FROM after_cases WHERE id=?',(cid,)).fetchone())
        def advance(cid,to,role,**data):
            return lifecycle.advance_case(self.db,dict(data,id=cid,version=case(cid)['version'],to=to),U(role))
        body=dict(order_id=oid,sn=sn,issue='SIM 故障诊断',custodian='SIM 客户',owner='service',next_step='SIM 诊断审批',due=day+'T17:00',evidence='SIM-FAULT')
        restore=step('diagnosis','service',lambda:lifecycle.make_case(self.db,dict(body,kind='restore'),U('service')))
        step('approve_machine_repair','service',lambda:advance(restore['id'],'authorized','service',strategy='machine',approval_ref='SIM-REPAIR-APPROVAL',next_step='SIM 原机回收'))
        rma=step('rma','service',lambda:lifecycle.make_case(self.db,dict(body,kind='rma',item_type='machine',purpose='repair',reason_ref=restore['id']),U('service')))
        wh=self.resources['places'][o['city']]
        step('authorize_return','service',lambda:advance(rma['id'],'authorized','service',approval_ref='SIM-RMA-OK',return_to=wh['name'],part_ref=sn,receiver_id=wh['id'],receiver_acceptance='SIM-RECEIVER',protection_ref='SIM-PROTECTION',redelivery_ref='SIM-RETURN-PLAN'))
        step('return_shipped','service',lambda:advance(rma['id'],'shipped','service',tracking='SIM-RETURN-TRACK',custodian='SIM 回收车组'))
        step('return_received','warehouse',lambda:advance(rma['id'],'received','warehouse',receipt_ref='SIM-REPAIR-GRN',inspection='SIM 原机隔离待修'))
        step('premature_redelivery_rejected','dispatch',lambda:lifecycle.redelivery(self.db,dict(id=rma['id'],version=case(rma['id'])['version'],approval_ref='SIM-TOO-EARLY',procurement_mode='company',window_start=day+'T09:00',window_end=day+'T17:00',delivery_actions='SIM 原机回送'),U('dispatch')),expect_error=True)
        tech='sim_tech_'+str((int(oid[-3:])-1)%4+1)
        def bench():
            old=self.db.execute("SELECT version FROM repair_bench WHERE warehouse_id=? AND model='M01'",(wh['id'],)).fetchone()
            return lifecycle.authorize_bench(self.db,dict(warehouse_id=wh['id'],model='M01',version=old[0] if old else 0,evidence='SIM-BENCH',valid_until='2036-12-31',technician=tech),U('admin'))
        step('bench_authorization','admin',bench)
        step('repair_test_release',tech,lambda:lifecycle.repair_release(self.db,dict(id=rma['id'],version=case(rma['id'])['version'],test_result='SIM 原故障维修复测通过',release_ref='SIM-TECH-RELEASE',return_plan='SIM 原机回送原址',protection_ref='SIM-PROTECT'),dict(role='service',username=tech)))
        outbound=step('redelivery_order','dispatch',lambda:lifecycle.redelivery(self.db,dict(id=rma['id'],version=case(rma['id'])['version'],approval_ref='SIM-RETURN-OK',procurement_mode='company',window_start=day+'T09:00',window_end=day+'T17:00',delivery_actions='SIM 原机原址回送'),U('dispatch')))
        rid=outbound['order']['id']
        for name,role,fn in [('commission','procurement',lambda:self.commission(rid,m)),('dispatch','dispatch',lambda:self.dispatch(rid,m)),('gate','warehouse',lambda:self.verify(rid,m)),('delivered','driver',lambda:self.complete(rid,m)),('settled','finance',lambda:self.action(rid,'settle','finance',actual_cost=self.order(rid)['approved_cost'],invoice_ref='SIM-REPAIR-INVOICE',paid_ref='SIM-REPAIR-PAID'))]:
            self.step(rid,name,role,fn,day+'T14:45')
        step('customer_restored','service',lambda:advance(restore['id'],'closed','service',test_result='SIM 原机原故障复测通过',customer_ref='SIM 原客户验收',recovered_at=day+'T16:00'))
        step('rma_closed','finance',lambda:advance(rma['id'],'closed','finance',credit_amount=0,credit_ref='SIM 无贷项，运输维修费用已核',disposition='SIM 原SN原址回送验收结案'))

def generate_files(path):
    path.mkdir(parents=True,exist_ok=True);rows=simulation.generate();expected=simulation.validate(rows)
    data=json.dumps(dict(seed=simulation.SEED,start=simulation.START,expected=expected,records=rows),ensure_ascii=False,indent=2).encode()
    (path/'SIM200.json').write_bytes(data);(path/'SIM200_sales.csv').write_bytes(simulation.sales_csv(rows))
    package=dict(seed=simulation.SEED,synthetic=True,initial_stock_units=174,ocean_units=86,
        initial_assets=[dict(sn=sn,warehouse=r['order']['warehouse'],model='M01',state='available',source='SIM-D' if r['coverage']['existing_positioned'] else 'SIM-INITIAL') for r in rows if not r['coverage']['ocean_batch'] for sn in r['coverage']['serials']],
        ocean_batches=[dict(id=f'SIM-OCEAN-{n}',orders=[r['order']['id'] for r in rows if r['coverage']['ocean_batch']==n],serials=[sn for r in rows if r['coverage']['ocean_batch']==n for sn in r['coverage']['serials']]) for n in range(1,5)],
        locations=[dict(name='SIM '+r[1]+suffix,timezone=r[6],zip=r[3],lat=r[4]+(0.003 if suffix else 0),lng=r[5]+(0.003 if suffix else 0),coordinate_basis='synthetic_grid_unverified') for r in simulation.REGIONS for suffix in ('',' 接站')],
        suppliers=[dict(name=f'SIM 供应商 {n:02}',products=['T2','T3','T5'],qualification='S3',evidence=f'SIM-SUPPLIER-{n:02}') for n in range(1,13)],
        fleets=[dict(vehicle=f'SIM 车辆 {n:02}',crew=f'SIM 班组 {n:02}',driver=f'sim_driver_{n:02}',supplier=f'SIM 供应商 {(n-1)%12+1:02}',capacity_units=3 if n%2 else 6,payload_kg=2000,floor_length_cm=650,floor_width_cm=240,door_width_cm=230,door_height_cm=240,lift_capacity_kg=850,headcount=3) for n in range(1,19)],
        technicians=[f'sim_tech_{n}' for n in range(1,5)],
        packing=dict(model='M01',fictional=True,length_cm=100,width_cm=83,height_cm=191,weight_kg=226,upright=True,nonstackable=True),
        limits=['Resource calendar exception days and capacity offers require separate planner fixtures; this file does not prove those constraints.','Grid coordinates and carrier time evidence are synthetic business-test inputs, not real-road verification.'])
    (path/'SIM200_resources.json').write_text(json.dumps(package,ensure_ascii=False,indent=2),encoding='utf-8')
    (path/'sha256.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in path.iterdir() if p.name in {'SIM200.json','SIM200_sales.csv','SIM200_resources.json'}},indent=2))
    return expected

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',default='docs/sim200/run');ap.add_argument('--generate-only',action='store_true');ap.add_argument('--prepare-only',action='store_true');ap.add_argument('--limit',type=int,default=200);args=ap.parse_args()
    generate_files(ROOT/'v13'/'data'/'sim200')
    if args.generate_only:return
    run=Replay(ROOT/args.output);failures=[];start=time.perf_counter()
    try:
        run.setup()
        if args.prepare_only:
            for row in run.rows:
                oid=row['order']['id'];m=row['coverage']
                run.step(oid,'reserve','warehouse',lambda oid=oid,m=m:run.action(oid,'ready','warehouse',sn=','.join(m['serials']),release_ref='SIM-RESERVE'))
                if not row['order']['pickup'] and m['expected_terminal']!='cancelled':
                    run.step(oid,'commission','procurement',lambda oid=oid,m=m:run.commission(oid,m))
            result=run.export([]);print(json.dumps({k:v for k,v in result.items() if k!='rows'},ensure_ascii=False));return
        for row in run.rows[:args.limit]:
            try:run.flow(row)
            except Exception as exc:
                failures.append(dict(id=row['order']['id'],error=str(exc)))
                print(row['order']['id'],str(exc),flush=True)
        for row in run.rows[:args.limit]:
            if row['coverage']['aftercare']:
                try:run.aftercare(row)
                except Exception as exc:
                    failures.append(dict(id=row['order']['id'],phase='aftercare',error=str(exc)))
                    print(row['order']['id'],'aftercare',str(exc),flush=True)
        result=run.export(failures);print(json.dumps({k:v for k,v in result.items() if k!='rows'},ensure_ascii=False));print('elapsed_seconds',round(time.perf_counter()-start,3))
    finally:run.db.close()

if __name__=='__main__':main()

