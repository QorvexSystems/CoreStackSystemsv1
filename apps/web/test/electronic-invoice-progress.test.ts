import assert from 'node:assert/strict';
import test from 'node:test';
import { electronicInvoiceRefreshInterval, isElectronicInvoiceDelayed } from '../lib/electronic-invoice-progress';
const pending={documentType:'FISCAL_CREDIT_ELECTRONIC_31',fiscalStatus:'PENDING_SEQUENCE',createdAt:'2026-11-24T12:00:00Z'};
test('pending E31/E32 refresh quickly and report a two-minute delay',()=>{
  for(const documentType of ['FISCAL_CREDIT_ELECTRONIC_31','CONSUMER_ELECTRONIC_32']) {
    const invoice={...pending,documentType};
    assert.equal(electronicInvoiceRefreshInterval(invoice,Date.parse('2026-11-24T12:00:01Z')),750);
    assert.equal(electronicInvoiceRefreshInterval(invoice,Date.parse('2026-11-24T12:00:30Z')),2000);
    assert.equal(electronicInvoiceRefreshInterval(invoice,Date.parse('2026-11-24T12:02:00Z')),5000);
    assert.equal(isElectronicInvoiceDelayed(invoice,Date.parse('2026-11-24T12:01:59Z')),false);
    assert.equal(isElectronicInvoiceDelayed(invoice,Date.parse('2026-11-24T12:02:00Z')),true);
  }
});
test('review/rejection continues slow read-only refresh for eventual reconciliation',()=>{
  for(const fiscalStatus of ['FAILED','REJECTED']) {
    assert.equal(electronicInvoiceRefreshInterval({...pending,fiscalStatus}),15000);
    assert.equal(isElectronicInvoiceDelayed({...pending,fiscalStatus},Date.parse('2026-11-24T13:00:00Z')),false);
  }
});
test('accepted/cancelled/local invoices never poll as pending fiscal work',()=>{
  for(const fiscalStatus of ['ACCEPTED','CANCELLED']) assert.equal(electronicInvoiceRefreshInterval({...pending,fiscalStatus}),false);
  assert.equal(electronicInvoiceRefreshInterval({...pending,documentType:'LOCAL_SALE_NOTE'}),false);
  assert.equal(electronicInvoiceRefreshInterval(undefined),false);
});
test('invalid/future timestamps never fabricate an overdue warning',()=>{
  assert.equal(isElectronicInvoiceDelayed({...pending,createdAt:'invalid'}),false);
  assert.equal(isElectronicInvoiceDelayed(pending,Date.parse('2026-11-24T11:00:00Z')),false);
  assert.equal(electronicInvoiceRefreshInterval({...pending,createdAt:'invalid'}),2000);
  assert.equal(electronicInvoiceRefreshInterval(pending,Date.parse('2026-11-24T11:00:00Z')),2000);
});
