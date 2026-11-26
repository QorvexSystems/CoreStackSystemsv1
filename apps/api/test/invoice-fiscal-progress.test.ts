import assert from 'node:assert/strict';
import test from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { InvoicesService } from '../src/modules/invoices/invoices.service';

test('progress is tenant-scoped, lightweight and read-only',async()=>{
  let query:any;
  const row={id:'synthetic-invoice',tenantId:'synthetic-tenant',fiscalStatus:'SENT'};
  const service=new InvoicesService({invoice:{findFirst:async(args:any)=>{query=args;return row;}}} as never,{} as never);
  assert.equal(await service.fiscalProgress('synthetic-tenant','synthetic-invoice'),row);
  assert.deepEqual(query.where,{tenantId:'synthetic-tenant',id:'synthetic-invoice'});
  assert.equal(query.include,undefined);
  for(const field of ['items','payments','customer','tenant','fiscalCustomerSnapshot']) {
    assert.equal(query.select[field],undefined);
  }
});
test('progress never exposes an invoice belonging to another tenant',async()=>{
  const service=new InvoicesService({invoice:{findFirst:async()=>null}} as never,{} as never);
  await assert.rejects(service.fiscalProgress('other-tenant','synthetic-invoice'),NotFoundException);
});
