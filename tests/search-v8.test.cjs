const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../v8/app.js'),'utf8');
const engine=source.split('/* SEARCH_ENGINE_START */')[1].split('/* SEARCH_ENGINE_END */')[0];
function setup(orders){const H={state:{orders}};vm.runInNewContext(engine,{H});return H;}
const orders=[
  {id:'H26001',customer:'Northline Market',city:'Dallas',state:'TX',zip:'75201'},
  {id:'H26002',customer:'Dallas Office',city:'Irving',state:'TX',zip:'75039'},
  {id:'H26003',customer:'Second Market',city:'Dallas',state:'TX',zip:'75202'},
  {id:'H26004',customer:'Café Equipments',city:'Plano',state:'TX',zip:'75074'},
  {id:'DEMO-01',customer:'Demo Workshop',city:'Denver',state:'CO',zip:'80202'}
];
test('a city query returns every matching order, rather than only its first hit',()=>{
  const H=setup(orders);const result=H.searchOrders('dallas');
  assert.equal(result.length,3);
  assert.deepEqual(Array.from(result,o=>o.id).sort(),['H26001','H26002','H26003']);
});
test('exact identifiers and prefixes rank before incidental matches',()=>{
  const H=setup([{id:'OTHER',customer:'H26001',city:'Dallas'},...orders]);
  assert.equal(H.searchOrders('H26001')[0].id,'H26001');
  assert.equal(H.searchOrders('h260')[0].id,'H26001');
});
test('mixed fields, ZIP, case and repeated whitespace are searchable',()=>{
  const H=setup(orders);
  assert.equal(H.searchOrders('  DALLAS    75202 ')[0].id,'H26003');
  assert.equal(H.searchOrders('Northline TX')[0].id,'H26001');
  assert.equal(H.searchOrders('75039')[0].id,'H26002');
});
test('accented names match plain keyboard input and empty input stays closed',()=>{
  const H=setup(orders);
  assert.equal(H.searchOrders('cafe')[0].id,'H26004');
  assert.equal(H.searchOrders('   ').length,0);
  assert.equal(H.searchOrders('not-a-customer').length,0);
});
test('search does not reorder or change business records',()=>{
  const original=JSON.stringify(orders);const H=setup(orders);
  H.searchOrders('dallas');H.searchOrders('H26004');
  assert.equal(JSON.stringify(orders),original);
});
