/* Public Pyodide UI, real file download/upload, synthetic workbook rows only. */
const { chromium } = require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'haha-sales-test-'));
 const local=!process.argv[2],base=process.argv[2]||'http://127.0.0.1:18857/v12/';
 const server=local?spawn('python',['-B','preview.py','--port','18857'],{cwd:root,stdio:'ignore',windowsHide:true}):null;
 let browser;
 try{
  if(local)for(let i=0;i<40;i++){try{if((await fetch(base)).ok)break}catch{} await new Promise(r=>setTimeout(r,150))}
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage();page.setDefaultTimeout(45000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'#sales');
  await page.locator('#signout').click();
  await page.locator('#signin select').selectOption('sales');await page.locator('#signin [type=submit]').click();
  const dl=async(label,file)=>{
    const waited=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();await (await waited).saveAs(file);
  };
  const blank=path.join(dir,'blank.xlsx'),file=path.join(dir,'sales.xlsx');
  await dl('下载交单模板',blank);
  execFileSync('python',['-B','-c',String.raw`
import io,sys,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
sys.path.insert(0,'v12/engine')
from sales_workbook import read_xlsx, column
src,dst=sys.argv[1:]
assert len(read_xlsx(Path(src).read_bytes()))==2
ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
tag=lambda k:"{"+ns+"}"+k
with zipfile.ZipFile(src) as z, zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as out:
 for item in z.infolist():
  data=z.read(item)
  if item.filename=="xl/worksheets/sheet1.xml":
   tree=ET.fromstring(data);sheet=tree.find(tag("sheetData"))
   for idx,(site,line,model,qty,zip_code) in enumerate([("01","001","M01","2","06103"),("01","002","UNKNOWN","1","06103"),("02","001","M03","1","75201")],6):
    row=ET.SubElement(sheet,tag("row"),r=str(idx))
    for col,value in [(1,"DEMO-SITE"),(2,site),(3,line),(6,model),(7,qty),(15,zip_code)]:
     cell=ET.SubElement(row,tag("c"),r=column(col)+str(idx),t="inlineStr")
     ET.SubElement(ET.SubElement(cell,tag("is")),tag("t")).text=value
   data=ET.tostring(tree,encoding="utf-8",xml_declaration=True)
  out.writestr(item,data)
`,blank,file],{cwd:root});
  const upload=async f=>{await page.locator('[data-file]').setInputFiles(f);await page.getByRole('heading',{name:/导入预检/}).waitFor()};
  await upload(file);
  const preview=page.locator('[data-preview]');assert.equal(await preview.locator('article').count(),3);
  assert.ok((await preview.innerText()).includes('原始型号须对照主数据'));
  await preview.getByText('按原表行号校正单元格',{exact:true}).click();
  await page.locator('[data-fix-row]').fill('7');await page.locator('[data-fix-key]').selectOption('model');
  await page.locator('[data-fix-value]').fill('M02');await page.getByRole('button',{name:'应用校正并预检'}).click();
  await page.getByText('校正后预检已更新。',{exact:true}).waitFor();
  assert.ok(!(await preview.innerText()).includes('原始型号须对照主数据'));
  await page.getByRole('button',{name:'确认导入'}).click();
  const lines=page.locator('[data-lines] article');await lines.first().waitFor();
  assert.equal(await lines.count(),3);
  assert.ok((await lines.allTextContents()).some(t=>t.includes('01 / 001')&&t.includes('06103')));
  await upload(file);assert.equal(await preview.locator('article').filter({hasText:'完全重复'}).count(),3);
  await page.getByRole('button',{name:'确认导入'}).click();await preview.waitFor({state:'hidden'});
  await dl('下载达拉斯两台演练工作簿',file);await upload(file);await page.getByRole('button',{name:'确认导入'}).click();
  await page.locator('[data-lines] article').filter({hasText:'DEMO-DAL-02'}).waitFor();
  await page.locator('#signout').click();await page.locator('#signin select').selectOption('dispatch');await page.locator('#signin [type=submit]').click();
  await page.goto(base+'#sales');const dal=page.locator('[data-lines] article').filter({hasText:'DEMO-DAL-02'});
  await dal.getByRole('button',{name:'澄清终点并接手'}).click();await page.locator('[name=level]').selectOption('L3');
  await page.locator('[name=confirm_demo_site]').check();await page.getByRole('button',{name:'确认接手'}).click();
  await dal.filter({hasText:'已接手'}).waitFor();
  // Delete the Excel cell itself, leaving its column heading and the remaining measurement intact.
  const revised=path.join(dir,'revised.xlsx');
  execFileSync('python',['-B','-c',`import sys,zipfile
from xml.etree import ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as src,zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as dst:
 for item in src.infolist():
  data=src.read(item)
  if item.filename=='xl/worksheets/sheet2.xml':
   tree=E.fromstring(data);row=tree.find(".//{*}row[@r='6']")
   cell=next(c for c in row if ''.join(c.itertext())=='140');row.remove(cell)
   data=E.tostring(tree,encoding='utf-8',xml_declaration=True)
  dst.writestr(item,data)`,file,revised]);
  await upload(revised);
  await preview.getByText(/门净宽.*140.*空/).waitFor();await page.getByRole('button',{name:'确认导入'}).click();
  await dal.filter({hasText:'范围变更待复核'}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS browser sales: template download, 2 sites / 3 rows, text IDs/ZIP, unknown model, audited preview correction, replay, Dallas handoff, delete workbook door width and invalidate.');
 }finally{await browser?.close();server?.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
