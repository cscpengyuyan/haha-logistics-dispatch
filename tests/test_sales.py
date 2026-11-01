import base64
import io
import json
import sys
import sqlite3
import unittest
import zipfile
from xml.etree import ElementTree as ET
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"v12"/"engine"))
import communications
import core
import gate
import lifecycle
import operations
import procurement
import sales
import sales_workbook as book

def fixture_rows():
    return [dict(crm_ref="DEMO-GROUP",site_id=s,line_id=l,model=m,quantity=q,zip=z,window_start=w)
            for s,l,m,q,z,w in [("01","001","M01","2","06103","2026-11-10T09:00"),("01","002","Raw New Model","1","06103","2026-11-10T09:00"),
                                  ("02","001","M03","1","75201","2026-11-12T14:00")]]

def rows_file(rows,extras=None):
    return source(book.template(main_rows=rows,site_rows=extras))
def source(data):
    return dict(filename="synthetic-sales.xlsx",base64=base64.b64encode(data).decode())

class Sales(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:");self.addCleanup(self.db.close);self.db.row_factory=sqlite3.Row
        core.core_schema(self.db);operations.init_db(self.db)
        self.db.execute("INSERT INTO metadata VALUES('mode','demo')")
        self.u={"role":"sales","username":"sales"}
    def submit(self,b):
        report=sales.preview(self.db,b)[0]
        return report,sales.confirm(self.db,dict(b,token=report["token"]),self.u)
    def test_workbook_lines_and_precision(self):
        rows=fixture_rows();sup=[dict(crm_ref="DEMO-GROUP",site_id="01",line_id="001",door_width_cm="120"),
                                dict(crm_ref="ORPHAN",site_id="01",line_id="101",door_width_cm="130")]
        p,r=self.submit(rows_file(rows,sup));self.assertEqual((p["errors"],len(p["unmatched"]),r["added"]),([],1,3))
        self.assertEqual(self.submit(rows_file(rows,sup))[1]["added"],0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sales_history").fetchone()[0],3)
        o=core.get_order(self.db,r["tickets"]["DEMO-GROUP / 01 / 001"],self.u)
        self.assertEqual((o["route"],o["level"],o["timezone"],o["status"],o["door_width_cm"],o["zip"]),("","","","intake","120","06103"))
        self.assertTrue(any("型号" in x for x in p["rows"][1]["missing"]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM sn_locks").fetchone()[0],0)
        rows[1]["window_start"]="2026-11-11T12:00"
        self.assertIn("第 7 行",sales.preview(self.db,rows_file(rows))[0]["errors"][0])
        first,second=list(r["tickets"].values())[:2]
        self.db.executemany("INSERT INTO registry VALUES(?,?,1,?)",[("Q1","quote",json.dumps(dict(order_id=first))),("Q2","quote",json.dumps(dict(order_id=second))),
          ("R1","route",json.dumps(dict(order_ids=[first,second])))])
        self.db.execute("INSERT INTO sms_jobs(id,oid,version,template,phone,state,due,text,reason) VALUES('SMS1',?,1,'T2','+12145550124','authorized','X','X','')",(first,))
        rows[0]["window_start"]=rows[1]["window_start"]
        v=sales.preview(self.db,rows_file(rows))[0]
        self.assertEqual(set(v["rows"][0]["impact"]),{"报价 Q1","路线 R1","短信 SMS1"})
        self.assertEqual(set(v["rows"][1]["impact"]),{"报价 Q2","路线 R1"})
        self.assertEqual(v["rows"][2]["impact"],[])
    def test_sample_handoff_and_roles(self):
        raw=source(book.template(example=True));p,r=self.submit(raw)
        self.assertEqual(p["errors"],[]);self.assertEqual(p["rows"][0]["missing"],[])
        oid=next(iter(r["tickets"].values()));b=dict(id=oid,version=1,level="L3",confirm_demo_site=True)
        with self.assertRaises(core.ApiError):sales.handoff(self.db,b,self.u)
        with self.assertRaises(core.ApiError):sales.dispatch(self.db,"GET","/api/sales/lines",{},{"role":"driver"})
        o=sales.handoff(self.db,b,{"role":"dispatch","username":"logistics"})["order"]
        self.assertEqual((o["status"],o["route"],o["level"],o["lat"],o["quantity"],o["addon_l5"]),("new","","L3",32.779,2,False))
        self.assertEqual(o["endpoint_ref"],"SIM-CONTRACT-L3")
        with self.assertRaises(core.ApiError):sales.confirm(self.db,{**raw,"token":p["token"]},self.u)
    def test_mapped_csv_and_csv_standalone(self):
        blob='CRM Order ID,Site ID,Line ID,Vendor SKU,Qty,Postal Code\r\nDEMO-CSV,01,001,raw,2,01234\r\n'.encode("utf-8-sig")
        b=dict(filename="crm.csv",base64=base64.b64encode(blob).decode())
        p=sales.preview(self.db,b)[0];self.assertIn("Vendor SKU",p["unmapped"])
        self.submit({**b,"mapping":{"Vendor SKU":"model"}})
        p=sales.preview(self.db,b)[0];self.assertEqual((p["unmapped"],p["rows"][0]["state"]),([],"完全重复"))
    def test_revision_with_locked_sns_and_role_boundaries(self):
        _,r=self.submit(source(book.template(example=True)))
        oid=next(iter(r["tickets"].values()))
        dispatcher={"role":"dispatch","username":"dispatch"};warehouse={"role":"warehouse","username":"warehouse"}
        o=sales.handoff(self.db,dict(id=oid,version=1,level="L3",confirm_demo_site=True),dispatcher)["order"]
        for sn in ("SIM-REV-1","SIM-REV-2"):
            lifecycle.receipt(self.db,dict(sn=sn,model="M01",bin="SIM",warehouse="Dallas",condition="intact",
                              batch="SIM",evidence="SIM-GRN",state="available"),warehouse)
        o=core.apply_action(self.db,oid,dict(version=o["version"],action="ready",sn="SIM-REV-1,SIM-REV-2",release_ref="SIM-LOCK"),warehouse)
        self.assertNotIn("phone",o);self.assertNotIn("sms_consent_ref",o)
        raw=json.loads(self.db.execute("SELECT facts FROM sales_lines WHERE oid=?",(oid,)).fetchone()[0])
        _,r=self.submit(rows_file([{**raw,"quantity":"1"}]))
        o=core.get_order(self.db,oid,dispatcher)
        self.assertTrue(o["sales_review_pending"])
        self.assertNotIn("dispatch",core.actions(o,"dispatch"))
        with self.assertRaises(core.ApiError):gate.verify(self.db,o,{},warehouse)
        with self.assertRaisesRegex(core.ApiError,"已锁实物与变更不符"):
            sales.handoff(self.db,dict(id=oid,version=o["version"],level="L3"),dispatcher)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM assets WHERE state='reserved'").fetchone()[0],2)
        old=sales.reject_change(self.db,dict(id=oid,version=o["version"],evidence="SIM-CUSTOMER-ORIGINAL"),dispatcher)["order"]
        self.assertEqual((old["quantity"],old["sales_review_pending"]),(2,False))
    def test_ambiguous_endpoint_special_access_and_purchase_evidence(self):
        _,r=self.submit(source(book.template(example=True)));oid=next(iter(r["tickets"].values()))
        d={"role":"dispatch","username":"dispatch"}
        b=dict(id=oid,version=1,level="L2",facts={"endpoint":"inside delivery"})
        with self.assertRaisesRegex(core.ApiError,"模糊表述"):sales.handoff(self.db,b,d)
        b.update(level="L3",facts={"site_access":"需专项勘查","access":"狭小转角","l5_purchased":"是"})
        with self.assertRaisesRegex(core.ApiError,"技术购买依据"):sales.handoff(self.db,b,d)
        b["facts"]["l5_purchased"]="否"
        o=sales.handoff(self.db,b,d)["order"]
        self.assertEqual((o["survey_required"],o["addon_l4"],o["addon_l5"]),(True,False,False))
        self.assertIn("复杂通道待专项勘查",procurement.site_problems(o))
        residential={**o,"level":"L1","site_type":"住宅","survey_required":False}
        self.assertTrue(any("住宅" in msg for msg in procurement.offer_problems(residential,{"path":"B"})))
        self.assertFalse(any("住宅" in msg for msg in procurement.offer_problems(residential,{"path":"B","unload_ref":"SIM-CARRIER-CURBSIDE"})))
        self.assertFalse(sales.survey_needed({"liftgate":"是","customer_wants":"最终摆位","access":"平层无楼梯"}))
    def test_logistics_clarification_survives_unrelated_sales_change(self):
        _,r=self.submit(source(book.template(example=True)));oid=next(iter(r["tickets"].values()))
        d={"role":"dispatch","username":"dispatch"}
        sales.handoff(self.db,dict(id=oid,version=1,level="L3",facts={"endpoint":"一楼经客户确认的东侧 3 号机位"}),d)
        raw=json.loads(self.db.execute("SELECT facts FROM sales_lines WHERE oid=?",(oid,)).fetchone()[0])
        self.submit(rows_file([{**raw,"window_end":"15:00"}]))
        v=core.get_order(self.db,oid,d)["version"]
        o=sales.handoff(self.db,dict(id=oid,version=v,level="L3"),d)["order"]
        self.assertTrue(o["window_end"].endswith("T15:00"))
        self.assertEqual(o["endpoint"],"一楼经客户确认的东侧 3 号机位")
    def test_missing_column_vs_withdrawn_door_measurement(self):
        _,r=self.submit(source(book.template(example=True)));oid=next(iter(r["tickets"].values()))
        d={"role":"dispatch","username":"dispatch"}
        o=sales.handoff(self.db,dict(id=oid,version=1,level="L3",confirm_demo_site=True),d)["order"]
        o.update(active_rfq="SIM-ACTIVE-RFQ",training_road={"quote_id":"SIM-QUOTE"})
        core.save(self.db,o,d,"fixture","synthetic")
        raw=json.loads(self.db.execute("SELECT facts FROM sales_lines WHERE oid=?",(oid,)).fetchone()[0])
        self.assertEqual(self.submit(rows_file([raw]))[1]["changed"],0)  # no supplement row
        site={**raw,"door_width_cm":""}
        form=book.template(main_rows=[raw],site_rows=[site])
        # A legacy sheet without either width column must leave the existing dimension alone.
        stripped=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(form)) as original,zipfile.ZipFile(stripped,"w") as out:
            for path in original.namelist():
                buf=original.read(path)
                if path=="xl/worksheets/sheet2.xml":
                    for k in ("door_width_cm","door_width_in"):buf=buf.replace(book.FIELDS[k].split("|")[0].encode(),b"unused")
                out.writestr(path,buf)
        self.assertEqual(self.submit(source(stripped.getvalue()))[1]["changed"],0)
        p,_=self.submit(source(form))
        self.assertEqual(p["rows"][0]["changes"]["door_width_cm"],["140",""])
        self.assertEqual(set(p["rows"][0]["impact"]),{"询价包 SIM-ACTIVE-RFQ","演练路线 "+oid+" · SIM-QUOTE"})
        o=core.get_order(self.db,oid,d);self.assertTrue(o["sales_review_pending"])
        revised=sales.handoff(self.db,dict(id=oid,version=o["version"],level="L3"),d)["order"]
        self.assertEqual(revised["door_width_cm"],"")
        self.assertTrue(any("门净宽" in m for m in procurement.site_problems(revised)))
        self.assertNotIn("training_road",revised)
    def test_template_lists_and_audited_preview_correction(self):
        with zipfile.ZipFile(io.BytesIO(book.template())) as z:
            lists=[]
            for i in (1,2):
                tree=ET.fromstring(z.read(f"xl/worksheets/sheet{i}.xml"))
                lists.extend(x.find("{*}formula1").text for x in tree.findall(".//{*}dataValidation"))
            for values in book.ENUMS.values():self.assertIn('"'+",".join(values)+'"',lists)
        b=rows_file(fixture_rows())
        b["corrections"]=[dict(sheet="销售交单",row=7,field="model",value="M02")]
        _,created=self.submit(b);oid=created["tickets"]["DEMO-GROUP / 01 / 002"]
        info=sales.dispatch(self.db,"GET","/api/sales/history/"+oid,{},self.u)["history"][0]
        self.assertTrue(info["origin"]["model"].endswith("人工校正"));self.assertEqual(info["facts"]["model"],"M02")
        del b["corrections"];p=sales.preview(self.db,b,self.u)[0]
        self.assertEqual(p["rows"][1]["state"],"完全重复")
        self.assertTrue(all(r["state"]=="完全重复" for r in p["rows"]))
    def test_handoff_rechecks_existing_site_window(self):
        _,r=self.submit(source(book.template(example=True)));first=next(iter(r["tickets"].values()))
        raw=json.loads(self.db.execute("SELECT facts FROM sales_lines WHERE oid=?",(first,)).fetchone()[0])
        self.submit(rows_file([{**raw,"line_id":"002","model":"M03"}]))
        with self.assertRaisesRegex(core.ApiError,"同站明细 002"):
            sales.handoff(self.db,dict(id=first,version=1,level="L3",facts={"window_end":"15:30"}),
                          {"role":"dispatch","username":"dispatch"})
if __name__=="__main__":unittest.main()
