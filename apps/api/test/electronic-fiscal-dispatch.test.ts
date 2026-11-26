import assert from 'node:assert/strict';
import test from 'node:test';
import { ElectronicFiscalDispatchService } from '../src/modules/fiscal-sequences/electronic-fiscal-dispatch.service';
import { ElectronicRangeTransportError } from '../src/modules/fiscal-sequences/electronic-range-registration.client';
import { electronicSalesDigest } from '../src/modules/fiscal-documents/electronic-sales-guard';
import { electronicSalesFixture, salesScope } from './fixtures/electronic-sales';

function harness(error?: Error, requestText = JSON.stringify(electronicSalesFixture()), changed = 1) {
  const statements: unknown[][] = [], invoiceFailures: unknown[] = [], reservations: unknown[] = [];
  let posts = 0;
  const claim = { id:'1',tenantId:salesScope.tenantId,invoiceId:'synthetic-invoice',issuerRnc:'101010632',operationId:'synthetic-operation',
    requestText,payloadSha256:electronicSalesDigest(salesScope,electronicSalesFixture()),leaseToken:'00000000-0000-4000-8000-000000000001',attempts:1 };
  const tx = {
    $queryRaw: async()=>[],
    $executeRaw: async (_sql: TemplateStringsArray,...values: unknown[]) => {statements.push(values);return changed;},
    auditLog:{create:async()=>({})},
    invoice: {
      updateMany: async (value: {data:{eNcf?:string}}) => {
        if(value.data.eNcf)reservations.push(value);else invoiceFailures.push(value);return {count:1};
      },
    },
    electronicDocument: {upsert: async () => ({})},
  };
  const prisma = {$queryRaw:async(sql:TemplateStringsArray)=>sql.join('').includes('WITH candidate')?[claim]:[],
    $transaction:async(fn: (client:typeof tx)=>Promise<void>)=>fn(tx)};
  const route = process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE;
  delete process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE;
  let service: ElectronicFiscalDispatchService;
  try {service=new ElectronicFiscalDispatchService(prisma as never);}
  finally {if(route!==undefined) process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE=route;}
  Object.assign(service!, {scheduleReconciliation:()=>{},client:{registerFiscalRequest:async()=>{
    posts++;if(error)throw error;return {documentId:'1',encf:'E310000000001',payloadSha256:claim.payloadSha256,reused:false};
  }},logger:{log:()=>{},warn:()=>{},error:()=>{}}});
  return {service:service!,claim,tx,prisma,run:()=>(service! as unknown as {tick:()=>Promise<void>}).tick(),statements,invoiceFailures,reservations,posts:()=>posts};
}

test('a valid remote acknowledgement with a different digest stops immediately for review',async()=>{
  const h=harness(new ElectronicRangeTransportError('UNCONFIRMED','ACK_PAYLOAD_HASH_MISMATCH'));
  await h.run();
  assert.equal(h.posts(),1);
  assert.equal(h.statements[0]![0],'REVIEW_REQUIRED');
  assert.equal(h.statements[0]![1],'INVALID_SNAPSHOT');
  assert.equal(h.invoiceFailures.length,1);
  assert.equal(h.reservations.length,0);
});
test('a transient uncertain transport result retains the same immutable operation for retry',async()=>{
  const h=harness(new ElectronicRangeTransportError('UNCONFIRMED'));
  await h.run();
  assert.equal(h.posts(),1);
  assert.equal(h.statements[0]![0],'PENDING');
  assert.equal(h.statements[0]![1],'UNCONFIRMED');
  assert.equal(h.invoiceFailures.length,0);
});
test('an explicit rejection is not retried as a network problem',async()=>{
  const h=harness(new ElectronicRangeTransportError('REJECTED'));
  await h.run();
  assert.equal(h.statements[0]![0],'REVIEW_REQUIRED');
  assert.equal(h.statements[0]![1],'REJECTED');
});
test('an invalid immutable snapshot stops before any remote request',async()=>{
  const h=harness(undefined,'not-json');
  await h.run();
  assert.equal(h.posts(),0);
  assert.equal(h.statements[0]![0],'REVIEW_REQUIRED');
  assert.equal(h.statements[0]![1],'INVALID_SNAPSHOT');
});
test('an acknowledged request links the existing invoice and remote document transactionally',async()=>{
  const h=harness();await h.run();
  assert.equal(h.posts(),1);
  assert.equal(h.invoiceFailures.length,0);
  assert.equal(h.reservations.length,1);
  assert.ok(h.statements[0]!.includes('E310000000001'));
});

test('a corrupt digest cannot reach transport even when its JSON is valid',async()=>{
  const h=harness();h.claim.payloadSha256='0'.repeat(64);await h.run();
  assert.equal(h.posts(),0);assert.equal(h.statements[0]![1],'INVALID_SNAPSHOT');
});
test('a snapshot for another invoice/operation cannot reach transport',async()=>{
  const request=electronicSalesFixture();request.source.documentId='another-invoice';
  const h=harness(undefined,JSON.stringify(request));h.claim.payloadSha256=electronicSalesDigest(salesScope,request);
  await h.run();assert.equal(h.posts(),0);
});
test('a stale lease never changes invoice status or links another document',async()=>{
  const h=harness(new ElectronicRangeTransportError('REJECTED'),undefined,0);
  await h.run();assert.equal(h.invoiceFailures.length,0);assert.equal(h.reservations.length,0);
});
test('losing the acknowledgement lease cannot downgrade an already registered invoice',async()=>{
  const h=harness(undefined,undefined,0);await h.run();
  assert.equal(h.posts(),1);assert.equal(h.invoiceFailures.length,0);assert.equal(h.reservations.length,0);
});
test('a blocked registration never blocks the separate acceptance lane',async()=>{
  const h=harness();let reconciled=0,release!:()=>void;
  const blocked=new Promise<boolean>(resolve=>{release=()=>resolve(false);});
  Object.assign(h.service,{tick:()=>blocked,schedule:()=>{},
    reconcileOne:async()=>{reconciled++;return true;}});
  const worker=h.service as any;
  worker.run();worker.runReconciliation();
  await worker.reconciling;
  assert.equal(reconciled,1);assert.ok(worker.running);
  release();await h.service.onModuleDestroy();
});

test('bursts of committed-sale hints are coalesced and cannot overlap dispatch cycles',async()=>{
  const h=harness();let cycles=0,release!:()=>void;
  const delays:number[]=[];
  Object.assign(h.service,{tick:()=>{cycles++;return new Promise(resolve=>{release=()=>resolve(false);});},
    schedule:(delay:number)=>{delays.push(delay);}});
  const worker=h.service as any;
  worker.run();worker.run();for(let n=0;n<50;n++)h.service.wake();
  assert.equal(cycles,1);assert.deepEqual(delays,[]);
  release();await worker.running;
  assert.deepEqual(delays,[0]);
  await h.service.onModuleDestroy();h.service.wake();assert.deepEqual(delays,[0]);
});

test('registered work drains without adding two seconds per sale',async()=>{
  const h=harness();const delays:number[]=[];
  Object.assign(h.service,{schedule:(delay:number)=>{delays.push(delay);}});
  const worker=h.service as any;worker.run();await worker.running;
  assert.equal(h.posts(),1);assert.deepEqual(delays,[0]);
  await h.service.onModuleDestroy();
});

test('four independent status GETs run concurrently; one failure cannot hide acceptance',async()=>{
  const h=harness();let inflight=0,max=0;
  const releases:Array<()=>void>=[],reads:string[]=[];
  h.prisma.$queryRaw=async()=>Array.from({length:4},(_,n)=>({id:String(n+1),tenantId:salesScope.tenantId,
    invoiceId:`invoice-${n+1}`,documentId:String(n+1),encf:`E31000000000${n+1}`})) as never;
  h.tx.electronicDocument=Object.assign(h.tx.electronicDocument,{updateMany:async()=>({count:1})});
  Object.assign(h.service,{client:{readDocumentStatus:async(_tenant:string,id:string)=>{
    reads.push(id);inflight++;max=Math.max(max,inflight);
    await new Promise<void>(resolve=>releases.push(resolve));inflight--;
    if(id==='1')throw Error('synthetic-timeout');
    return {sourceDocumentId:`invoice-${id}`,encf:`E31000000000${id}`,
      preparation:'DONE',signing:'ENQUEUED',delivery:'ACCEPTED',trackId:`track-${id}`};
  }}});
  const work=(h.service as any).reconcileOne();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(max,4);releases.forEach(release=>release());await work;
  assert.deepEqual(reads,['1','2','3','4']);assert.equal(h.invoiceFailures.length,3);
  assert.equal(h.posts(),0);
});
test('the expired final lease becomes review-required without sending a fiscal POST',async()=>{
  const h=harness();let audited=0;
  h.prisma.$queryRaw=async()=>[];
  h.tx.$queryRaw=async()=>[{id:'1',invoiceId:'synthetic-invoice',tenantId:salesScope.tenantId}] as never;
  h.tx.auditLog.create=async()=>{audited++;return {};};
  await h.run();assert.equal(h.posts(),0);assert.equal(h.invoiceFailures.length,1);assert.equal(audited,1);
});

test('failed status reads rotate through documents instead of starving newer ones',async()=>{
  const h=harness();const reads:string[]=[];
  const candidates=[{id:'1',tenantId:salesScope.tenantId,invoiceId:'invoice-1',documentId:'1',encf:'E310000000001'},
    {id:'2',tenantId:salesScope.tenantId,invoiceId:'invoice-2',documentId:'2',encf:'E310000000002'}];
  h.prisma.$queryRaw=async (_sql:TemplateStringsArray,...values:any[])=>{
    const after=values[0] as bigint;
    return [candidates.find(c=>BigInt(c.id)>after)??candidates[0]] as never;
  };
  Object.assign(h.service,{client:{readDocumentStatus:async (_tenant:string,id:string)=>{reads.push(id);throw Error('unavailable');}}});
  const reconcile=()=>(h.service as unknown as {reconcileOne:()=>Promise<void>}).reconcileOne();
  await reconcile();await reconcile();await reconcile();assert.deepEqual(reads,['1','2']);
  // A failed GET backs off without blocking rotation to other documents.
  Object.assign(h.service,{reconcileCursor:0n});
  (h.service as any).reconcileAfter.clear();
  await reconcile();assert.deepEqual(reads,['1','2','1']);
});

test('status backoff bookkeeping is bounded for long-lived rejected invoices',()=>{
  const h=harness();const worker=h.service as any;
  for(let n=0;n<2000;n++)worker.deferReconciliation(String(n),15_000);
  assert.equal(worker.reconcileAfter.size,1024);
});
