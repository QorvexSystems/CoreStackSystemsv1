'use strict';

// One reviewed repair of an ERP projection, NOT a fiscal reissue or queue reset.
// Run inside rivnu-api as its normal runtime user. Default is read-only.
const {createHash} = require('node:crypto');
const {PrismaClient} = require('/app/packages/database/generated/client');
const {createElectronicRangeRegistrationClientFromEnvironment} = require('/app/apps/api/dist/modules/fiscal-sequences/electronic-range-registration.client.js');
const db = new PrismaClient();
const tenantId = 'cmqn0r66a0002lit0vxbzq5l4', invoiceId = 'cmwv4w51d0055p607e4y0zb4i';
const issuerRnc = '40220429126', documentId = '7', encf = 'E310000000005';
const originalHash = '2017b1630f38da55d0a21638cf30fcc36d9c12c40188e2278ea794233f8af456';
const normalizedHash = '742f2411d8705075832a2666250b56d48fcddfbbd5767f831c2b1eed68cc7d8b';
const auditAction = 'FISCAL_ACCEPTED_PROJECTION_RECONCILED';
const check = (ok, code) => {if (!ok) throw Error(code);};
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).sort(([a],[b]) => a<b?-1:a>b?1:0)
    .map(([key,child]) => JSON.stringify(key)+':'+canonical(child)).join(',') + '}' : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');

async function originalState(tx, lock = false) {
  if (lock) await tx.$queryRawUnsafe('SELECT id FROM public."Invoice" WHERE id=$1 AND "tenantId"=$2 FOR UPDATE',invoiceId,tenantId);
  const rows = await tx.$queryRawUnsafe(`SELECT id::text,request_text,payload_sha256,state,attempts,last_error,document_id,encf
    FROM corestack_erp_fiscal.dispatch WHERE id=8 AND tenant_id=$1 AND invoice_id=$2 AND issuer_rnc=$3 AND environment='production'`,tenantId,invoiceId,issuerRnc);
  const invoice = await tx.invoice.findFirst({where:{id:invoiceId,tenantId},include:{electronicDocument:{
    select:{id:true,provider:true,status:true,externalId:true,trackId:true,errorMessage:true},
  }}});
  check(rows.length===1 && invoice, 'TARGET_MISSING');
  const row=rows[0];
  check(row.state==='REVIEW_REQUIRED' && row.attempts===10 && row.last_error==='ATTEMPTS_EXHAUSTED' &&
    row.document_id===null && row.encf===null && row.payload_sha256===originalHash, 'ORIGINAL_DISPATCH_CHANGED');
  check(invoice.documentType==='FISCAL_CREDIT_ELECTRONIC_31' && invoice.total.eq('27449.90'), 'ORIGINAL_INVOICE_CHANGED');
  return {row,invoice};
}

async function main() {
  const apply=process.argv.includes('--apply');
  const {parseFiscalRequest}=await import('/app/packages/fiscal/src/contract.ts');
  const {row,invoice}=await originalState(db);
  const original=JSON.parse(row.request_text), request=parseFiscalRequest(original);
  const scope={tenantId,issuerRnc,environment:'production'};
  check(original.source.documentId===invoiceId && sha(canonical({scope,request:original}))===originalHash &&
    sha(canonical({scope,request}))===normalizedHash, 'ORIGINAL_REQUEST_HASH_CHANGED');
  const client=createElectronicRangeRegistrationClientFromEnvironment();
  check(client, 'CORE_CLIENT_DISABLED');
  const status=await client.readDocumentStatus(tenantId,documentId);
  check(status.sourceDocumentId===invoiceId && status.encf===encf && status.delivery==='ACCEPTED' && status.trackId,
    'CORE_ACCEPTANCE_NOT_VERIFIED');
  const representation=await client.readPrintedRepresentation(tenantId,documentId);
  check(representation.scope.tenantId===tenantId && representation.scope.environment==='production' &&
    representation.issuerRnc===issuerRnc && representation.encf===encf && representation.total==='27449.90' &&
    representation.lines.length===3 && /^[a-f0-9]{64}$/.test(representation.signedSha256), 'PRINTED_EVIDENCE_NOT_VERIFIED');
  if (!apply) {console.log('E31_EXISTING_ACCEPTED_PRINTABLE_PROJECTION_REPAIR_READY');return;}
  if (invoice.eNcf===encf && invoice.fiscalStatus==='ACCEPTED' && invoice.status==='ACCEPTED') {
    check(invoice.electronicDocument?.externalId===documentId, 'EXISTING_LINK_CONFLICT');
    console.log('E31_PROJECTION_ALREADY_RECONCILED');return;
  }
  check(invoice.eNcf===null && invoice.status==='PENDING_ECF' && invoice.fiscalStatus==='FAILED', 'ERP_PROJECTION_CHANGED');
  // Reviewed reconciliation: replay the EXACT immutable original operation.
  // VM4 already exposes this source as ACCEPTED. The authoritative idempotency
  // check must confirm REUSED and the normalized digest, not allocate a number.
  const ack=await client.registerFiscalRequest(tenantId,issuerRnc,original,normalizedHash);
  check(ack.reused===true && ack.documentId===documentId && ack.encf===encf && ack.payloadSha256===normalizedHash,
    'EXISTING_RESERVATION_NOT_CONFIRMED');
  await db.$transaction(async tx=>{
    const current=await originalState(tx,true), i=current.invoice;
    check(current.row.request_text===row.request_text && i.eNcf===null && i.status==='PENDING_ECF' && i.fiscalStatus==='FAILED',
      'ERP_CHANGED_BEFORE_RECONCILIATION');
    check(!await tx.auditLog.findFirst({where:{tenantId,entityId:invoiceId,action:auditAction}}), 'REPAIR_ALREADY_RECORDED');
    await tx.auditLog.create({data:{tenantId,action:auditAction,entity:'Invoice',entityId:invoiceId,metadata:{
      reason:'ERP_RAW_HASH_DIFFERS_FROM_CORE_TRIMMED_TEXT_HASH',dispatchId:'8',
      originalHash,normalizedHash,documentId,encf,trackId:status.trackId,
      signedSha256:representation.signedSha256,sourceSha256:representation.sourceSha256,
      before:{invoiceNumber:i.invoiceNumber,status:i.status,fiscalStatus:i.fiscalStatus,eNcf:i.eNcf,
        electronicDocument:i.electronicDocument},
      dispatchRetained:'REVIEW_REQUIRED_IMMUTABLE_HISTORY_RESOLVED_BY_THIS_AUDIT',
      monetaryDataUnchanged:true,noFiscalReissue:true,
    }}});
    await tx.invoice.update({where:{id:invoiceId},data:{invoiceNumber:'RIV-'+encf,eNcf:encf,status:'ACCEPTED',fiscalStatus:'ACCEPTED'}});
    await tx.electronicDocument.upsert({where:{invoiceId},
      create:{tenantId,invoiceId,provider:'DGII_DIRECT',status:'ACCEPTED',externalId:documentId,trackId:status.trackId},
      update:{status:'ACCEPTED',externalId:documentId,trackId:status.trackId,errorMessage:null}});
    // Do not alter immutable queue evidence, payments, stock, lines or amounts.
  });
  console.log('E31_EXISTING_ACCEPTANCE_RECONCILED_PRINT_READY_NO_REISSUE');
}
main().catch(error=>{console.error(/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'E31_RECONCILIATION_FAILED');process.exitCode=1;})
  .finally(()=>db.$disconnect());
