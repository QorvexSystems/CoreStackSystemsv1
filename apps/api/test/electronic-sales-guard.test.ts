import assert from 'node:assert/strict';
import test from 'node:test';
import { electronicSalesDigest, validateElectronicSalesRequest } from '../src/modules/fiscal-documents/electronic-sales-guard';
import { analyzeFiscalRequest } from '../../../packages/fiscal/src/mapper.ts';
import { electronicSalesFixture, salesScope } from './fixtures/electronic-sales';

const variants: Array<[string,(r:any)=>void]> = [
  ['empty description',r=>{r.lines[0].description='';}],
  ['description too long',r=>{r.lines[0].description='x'.repeat(81);}],
  ['hidden control',r=>{r.lines[0].description='Bad\u0001name';}],
  ['invalid XML Unicode',r=>{r.lines[0].description='Bad\uD800name';}],
  ['untrimmed text',r=>{r.lines[0].description=' Name ';}],
  ['issuer name too long',r=>{r.issuer.fiscalName='x'.repeat(151);}],
  ['issuer address too long',r=>{r.issuer.address='x'.repeat(101);}],
  ['buyer name too long',r=>{r.buyer.fiscalName='x'.repeat(151);}],
  ['empty buyer name',r=>{r.buyer.fiscalName='';}],
  ['wrong issuer',r=>{r.issuer.rnc='101010641';}],
  ['invalid buyer',r=>{r.buyer.identifier='123';}],
  ['missing E31 buyer',r=>{delete r.buyer;}],
  ['foreign E31 buyer',r=>{r.buyer.kind='FOREIGN';r.buyer.identifier='PASSPORT';}],
  ['zero quantity',r=>{r.lines[0].quantity='0.00';}],
  ['negative quantity',r=>{r.lines[0].quantity='-1.00';}],
  ['exponential quantity',r=>{r.lines[0].quantity='1e2';}],
  ['quantity precision loss',r=>{r.lines[0].quantity='1.001';}],
  ['price precision loss',r=>{r.lines[0].unitPrice='100.00001';}],
  ['negative discount',r=>{r.lines[0].discount='-0.01';}],
  ['discount exceeds price',r=>{r.lines[0].discount='100.01';}],
  ['tax drift',r=>{r.expectedTotals.itbis='18.01';}],
  ['net drift',r=>{r.expectedTotals.net='100.01';}],
  ['total drift',r=>{r.expectedTotals.total='118.01';}],
  ['unexpected withholding',r=>{r.expectedTotals.isrWithheld='1.00';}],
  ['unknown product kind',r=>{r.lines[0].kind=null;}],
  ['unknown tax bucket',r=>{r.lines[0].billingIndicator=9;}],
  ['missing lines',r=>{r.lines=[];}],
  ['too many lines',r=>{r.lines=Array.from({length:1001},(_,i)=>({...r.lines[0],sourceLineId:`line-${i}`}));}],
  ['duplicate source lines',r=>{r.lines.push({...r.lines[0]});}],
  ['invalid date',r=>{r.issuedOn='2026-02-30';}],
  ['cash due date',r=>{r.payment.dueOn='2027-01-01';}],
  ['missing credit due date',r=>{r.payment.type=2;}],
  ['credit due before issue',r=>{r.payment.type=2;r.payment.dueOn='2026-11-23';}],
  ['unknown income',r=>{r.incomeType='99';}],
  ['unknown root field',r=>{r.unexpected=true;}],
  ['unsupported type',r=>{r.type=34;}],
];
for(const [name,change] of variants) test(`producer rejects ${name} before payment commit`,()=>{
  const request=electronicSalesFixture();change(request);
  assert.throws(()=>validateElectronicSalesRequest(request,salesScope),/Datos fiscales inválidos/);
});
for(const type of [31,32] as const) test(`E${type} producer agrees with core for 100 synthetic price/discount cases`,()=>{
  for(let index=0;index<100;index++) {
    const request=electronicSalesFixture(type), net=10000-index,tax=Math.round(net*18/100);
    request.lines[0]!.discount=(index/100).toFixed(2);
    request.expectedTotals.net=(net/100).toFixed(2);
    request.expectedTotals.itbis=(tax/100).toFixed(2);
    request.expectedTotals.total=((net+tax)/100).toFixed(2);
    validateElectronicSalesRequest(request,salesScope);
    const checked=analyzeFiscalRequest({...salesScope,environment:'certification'},request);
    assert.deepEqual(checked.request,request);
    assert.equal(electronicSalesDigest(salesScope,request).length,64);
  }
});
test('E32 rejects the same missing-identity threshold that the deployed core rejects',()=>{
  const request:any=electronicSalesFixture(32);delete request.buyer;
  request.lines[0].unitPrice='250000.0000';
  request.expectedTotals={net:'250000.00',itbis:'45000.00',total:'295000.00',itbisWithheld:'0.00',isrWithheld:'0.00'};
  assert.throws(()=>validateElectronicSalesRequest(request,salesScope),/comprador requerido/);
});
test('valid Unicode and significant internal spaces are preserved, not silently rewritten',()=>{
  const request=electronicSalesFixture();request.lines[0]!.description='Aceite  🔧 & filtros';
  validateElectronicSalesRequest(request,salesScope);
  assert.deepEqual(analyzeFiscalRequest({...salesScope,environment:'certification'},request).request,request);
});
