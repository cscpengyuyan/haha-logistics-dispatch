"""Sales workbook/CSV codec, also used in the public Pyodide worker."""
import csv
import io
import posixpath
import re
import zipfile
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

from core import ApiError

# First label is emitted by the downloadable template. Remaining labels are CRM aliases.
FIELDS = {
    "crm_ref":"CRM订单号|来源单号|订单编号|CRM Order ID|Order Number",
    "site_id":"站点编号|站点号|Site ID", "line_id":"明细行号|行号|Line ID",
    "sales_owner":"销售负责人|销售姓名|Sales Owner", "customer":"客户名称|客户|收货单位|Customer",
    "model":"设备型号|型号|原始型号|SKU", "quantity":"数量|台数|Qty",
    "contact":"现场联系人|联系人|Contact Name", "phone":"联系电话|收件人电话|手机号|Phone Number",
    "fulfillment":"交付方式|送货/授权自提|Delivery Method", "warehouse":"提货仓|提货仓库|Pickup Warehouse",
    "address":"实际送货地址|交付地址|送货地址|街道地址|Address", "city":"城市|City",
    "state":"州|州代码|State", "zip":"ZIP|邮编|美国邮编|Postal Code",
    "customer_wants":"客户期望服务|客户想要|客户原话|Customer Request",
    "endpoint":"已购服务终点|合同终点|已购终点|Contract Endpoint",
    "endpoint_ref":"已购依据|合同凭据|合同条款或附件|Service Evidence",
    "delivery_actions":"已购附加动作|已购作业|Purchased Actions",
    "window_date":"期望日期|交付日期|Delivery Date", "window_start":"当地窗口开始|窗始|窗口开始|Window Start",
    "window_end":"当地窗口结束|窗止|窗口结束|Window End", "window_type":"时间窗性质|窗口性质|Window Type",
    "timezone":"收件地时区|当地时区|时区|Time Zone", "sms_consent":"短信授权|SMS Consent",
    "sms_consent_ref":"短信授权依据|短信授权证据|SMS Evidence",
    "site_type":"场所类型|现场类型|Site Type", "dock":"月台|有无月台|Dock", "forklift":"叉车|Forklift",
    "liftgate":"尾板|是否需尾板|Liftgate", "entrance":"指定入口|Entrance", "floor":"楼层与机位|楼层|Room",
    "door_width_cm":"门净宽(cm)|门净宽厘米|净门宽cm|Door Width cm",
    "door_height_cm":"门净高(cm)|门净高厘米|净门高cm|Door Height cm",
    "door_width_in":"门净宽(in)|门净宽英寸|Door Width in","door_height_in":"门净高(in)|门净高英寸|Door Height in",
    "access":"坡道台阶电梯与转角|通道限制|Access", "carry_distance":"停车至机位距离及单位|搬运距离|Carry Distance",
    "unpack":"拆包摆位清运|Unpack", "admission":"物业准入|Admission", "activation":"设备启用与附件|Activation",
    "site_note":"现场补充说明|现场说明|Site Notes", "notes":"备注|Notes",
    "site_access":"通道专项判断|Site Access Assessment","path_survey_ref":"现场勘查及工法凭据|Survey Reference",
    "l4_purchased":"专项搬运已购|Complex Handling Purchased","l4_evidence":"专项购买依据|Complex Handling Evidence",
    "l5_purchased":"技术启用已购|Activation Purchased","l5_evidence":"技术购买依据|Activation Purchase Evidence",
    "technical_ref":"授权技师及预约凭据|Authorized Technician Appointment","unload_ref":"约定卸货位置与书面回执|Unloading Point Evidence",
}
KEYS = ("crm_ref","site_id","line_id")
SITE_FIELDS = list(FIELDS)[list(FIELDS).index("site_type"):]
MAIN_FIELDS = list(FIELDS)[:list(FIELDS).index("site_type")]
ENUMS = {"fulfillment":["送货","授权自提"],"window_type":["硬窗","期望","可协商"],"sms_consent":["未知","是","否"],
         "site_type":["未知","住宅","商业","学校","仓库"],"site_access":["未知","标准通道","需专项勘查"],
         **{k:["未知","是","否"] for k in ("dock","forklift","liftgate","l4_purchased","l5_purchased")}}
def compact(s):
    return re.sub(r"[\s_*（）()：:/.、-]+","",str(s)).lower()

ALIASES = {compact(a): k for k,v in FIELDS.items() for a in [k,*v.split("|")]}
def xname(el):
    return el.tag.rsplit("}",1)[-1]

def xml(z, path):
    content = z.read(path)
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)",content,re.I):
        raise ValueError("XML entity")
    return ET.fromstring(content)

def column(index):
    s = ""
    while index:
        index,r=divmod(index-1,26)
        s=chr(65+r)+s
    return s

def worksheet(z,path,strings,formats,epoch):
    result = []
    for row in xml(z,path).iter():
        if xname(row)!="row":
            continue
        ri=int(row.get("r",len(result)+1))
        cells={}
        for cell in row:
            if xname(cell)!="c": continue
            ref=re.match(r"([A-Z]{1,3})",cell.get("r",""))
            if not ref: continue
            typ=cell.get("t","n")
            val=next((x.text or "" for x in cell if xname(x)=="v"),"")
            if typ=="s": val=strings[int(val)]
            elif typ=="inlineStr": val="".join(x.text or "" for x in cell.iter() if xname(x)=="t")
            elif val and typ=="n":
                fmt=formats[int(cell.get("s","0"))] if formats else ""
                if re.fullmatch(r"0{2,12}",fmt) and val.isdigit():
                    val=val.zfill(len(fmt))
                elif re.search(r"yy|dd|h+:m+",fmt,re.I):
                    dt=epoch+timedelta(days=float(val))
                    val=(dt.strftime("%Y-%m-%dT%H:%M") if "h" in fmt.lower() and ("d" in fmt.lower() or "y" in fmt.lower())
                         else dt.strftime("%H:%M") if "h" in fmt.lower() else dt.strftime("%Y-%m-%d"))
            cells[ref[1]]=str(val).strip()
        if any(cells.values()): result.append((ri,cells))
    return result

def read_xlsx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos=z.infolist()
        if len(infos)>500 or sum(i.file_size for i in infos)>20_000_000:
            raise ApiError(413,"工作簿解压后过大")
        wb=xml(z,"xl/workbook.xml")
        epoch=datetime(1899,12,30)
        if any(n.get("date1904") in ("1","true") for n in wb.iter()):epoch=datetime(1904,1,1)
        rels={r.get("Id"):r.get("Target") for r in xml(z,"xl/_rels/workbook.xml.rels")}
        strings=[]
        if "xl/sharedStrings.xml" in z.namelist():
            strings=["".join(t.text or "" for t in si.iter() if xname(t)=="t") for si in xml(z,"xl/sharedStrings.xml")]
        formats=[]
        if "xl/styles.xml" in z.namelist():
            styles=xml(z,"xl/styles.xml")
            builtin={**dict.fromkeys(range(14,18),"yyyy-mm-dd"),**dict.fromkeys(range(18,22),"hh:mm"),22:"yyyy-mm-dd hh:mm"}
            builtin.update({int(n.get("numFmtId")):n.get("formatCode","") for n in styles.iter() if xname(n)=="numFmt"})
            for n in styles:
                if xname(n)=="cellXfs":formats=[builtin.get(int(x.get("numFmtId","0")),"") for x in n]
        sheets={}
        for sh in wb.iter():
            if xname(sh)!="sheet" or sh.get("name") not in ("销售交单","现场补充"):continue
            target=rels[next(v for k,v in sh.attrib.items() if k.endswith("}id"))]
            path=target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl",target))
            sheets[sh.get("name")]=worksheet(z,path,strings,formats,epoch)
        if not sheets: raise ApiError(400,"未找到「销售交单」或「现场补充」工作表")
        return sheets

def parse_file(name,data):
    try:
        if name.lower().endswith(".xlsx"):return read_xlsx(data),5
        if name.lower().endswith(".csv"):
            reader=csv.reader(io.StringIO(data.decode("utf-8-sig"),newline=""),strict=True)
            return {"销售交单":[(i,{column(j):v.strip() for j,v in enumerate(row,1)}) for i,row in enumerate(reader,1)]},1
        raise ApiError(400,"请选择 XLSX 工作簿或 UTF-8 CSV")
    except (ValueError,OSError,IndexError,KeyError,StopIteration,ET.ParseError,csv.Error,RuntimeError,zipfile.BadZipFile) as e:
        raise ApiError(400,"工作簿损坏、包含不支持的单元格，或 CSV 非 UTF-8") from e

def template(example=False, main_rows=None, site_rows=None):
    """Produce the same field contract in all runtimes without Excel libraries."""
    from xml.sax.saxutils import escape
    out=io.BytesIO()
    if example:
        day=(datetime.now(timezone.utc)+timedelta(days=5)).date().isoformat()
        main_rows=[dict(crm_ref="DEMO-DAL-02",site_id="01",line_id="001",sales_owner="演练销售",customer="演练商业展厅",
            model="M01",quantity="2",contact="演练收货岗",phone="+12145550124",fulfillment="送货",warehouse="Dallas",
            address="Synthetic loading entrance · Main St",city="Dallas",state="TX",zip="75201",customer_wants="放到机位",
            endpoint="一楼展厅东侧指定机位",endpoint_ref="SIM-CONTRACT-L3",delivery_actions="两人尾板卸货、经东门送到指定机位",
            window_date=day,window_start="09:00",window_end="16:00",window_type="硬窗",timezone="America/Chicago",
            sms_consent="是",sms_consent_ref="SIM-CONSENT")]
        site_rows=[dict(crm_ref="DEMO-DAL-02",site_id="01",line_id="001",site_type="商业",dock="否",forklift="否",
            liftgate="是",door_width_cm="140",door_height_cm="230",access="平层、通道已测量",activation="未购启用",
            site_note="虚构现场：门宽高及平层通道已测。SIM-SITE-MAIN")]
    names=["销售交单","现场补充","示例"]
    office="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    main="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    pkg="http://schemas.openxmlformats.org/package/2006/relationships"
    with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1,4))+'</Types>')
        z.writestr("_rels/.rels",f'<Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{office}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",f'<workbook xmlns="{main}" xmlns:r="{office}"><sheets>'+''.join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i,name in enumerate(names,1))+'</sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",f'<Relationships xmlns="{pkg}">'+''.join(f'<Relationship Id="rId{i}" Type="{office}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1,4))+f'<Relationship Id="rId4" Type="{office}/styles" Target="styles.xml"/></Relationships>')
        z.writestr("xl/styles.xml",f'<styleSheet xmlns="{main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="49" applyNumberFormat="1"/></cellXfs></styleSheet>')
        for i,name in enumerate(names,1):
            fields=MAIN_FIELDS if i!=2 else [*KEYS,*SITE_FIELDS]
            rows=[[name],["第 5 行为字段名，第 6 行起录入。三个编号及 ZIP 按文本填写。"],["只填写客户事实。未知项可留空，不要猜测服务或时区。"],[],[FIELDS[k].split("|")[0] for k in fields]]
            if i==3:rows.append(["DEMO-ONLY","01","001","演练","示例不导入","M01","2"])
            if i in (1,2):
                rows.extend([[str(facts.get(k,"")) for k in fields] for facts in ((main_rows if i==1 else site_rows) or [])])
            validations=[]
            for j,k in enumerate(fields,1):
                if k not in ENUMS or i==3:continue
                col=column(j);values=escape(",".join(ENUMS[k]))
                validations.append(f'<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="{col}6:{col}2005"><formula1>"{values}"</formula1></dataValidation>')
            checks=f'<dataValidations count="{len(validations)}">{"".join(validations)}</dataValidations>' if validations else ""
            content=''.join(f'<row r="{r}">'+''.join(f'<c r="{column(c)}{r}" t="inlineStr"><is><t>{escape(value)}</t></is></c>' for c,value in enumerate(row,1))+'</row>' for r,row in enumerate(rows,1))
            z.writestr(f"xl/worksheets/sheet{i}.xml",f'<worksheet xmlns="{main}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="{len(fields)}" width="23" style="1" customWidth="1"/></cols><sheetData>{content}</sheetData>{checks}</worksheet>')
    return out.getvalue()
