import test from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@qorvex/database';
import { recoverPreviewRehearsalOnce } from '../src/modules/fiscal-documents/preview-rehearsal';

test('rehearsal recovery: idempotent persisted identity, bounded retries, terminal results and production guard',async t=>{
  const names=['NODE_ENV','RIVNU_PREVIEW_GUARD','DATABASE_URL','DIRECT_URL'];
  const previous=names.map(n=>process.env[n]);
  t.after(()=>names.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];}));
  process.env.NODE_ENV='development';process.env.RIVNU_PREVIEW_GUARD='RIVNU_DGII_PREVIEW_ONLY';
  process.env.DATABASE_URL=process.env.DIRECT_URL='postgresql://rivnu_preview:synthetic@rivnu-dgii-preview-db:5432/rivnu_dgii_preview';
  for(const scenario of ['accepted','pending','exhausted','unconfirmed','unconfirmed-exhausted','idle']) {
    const writes:Array<{sql:string;values:unknown[]}>=[];
    const row={id:'9',remote_ack:{documentId:'8',encf:'E320000000008'},result:{sha256:'a'.repeat(64)},attempts:scenario.includes('exhausted')?59:0};
    const tx={
      $queryRawUnsafe:async(sql:string,tenant:string)=>{
        assert.match(sql,/FOR UPDATE OF r SKIP LOCKED/);assert.match(sql,/r.attempts<60/);
        assert.match(sql,/NOT r.terminal/);assert.equal(tenant,'cmt397emm0002nm0ogb50l2q6');
        return scenario==='idle'?[]:[row];
      },
      $executeRawUnsafe:async(sql:string,...values:unknown[])=>{writes.push({sql,values});return 1;},
    } as unknown as Prisma.TransactionClient;
    const transport:Parameters<typeof recoverPreviewRehearsalOnce>[1]=async(expected,start)=>{
      assert.deepEqual(expected,{...row.remote_ack,xmlSha256:row.result.sha256});assert.equal(start,true);
      assert.equal(writes.length,1);assert.match(writes[0].sql,/attempts=attempts\+1/);
      if(scenario.startsWith('unconfirmed'))throw Error('sensitive arbitrary transport error');
      return scenario==='accepted'?{state:'ACCEPTED',model:{synthetic:true}}:{state:'POLLING',model:null};
    };
    const result=await recoverPreviewRehearsalOnce(tx,transport);
    if(scenario==='idle'){assert.equal(result,'IDLE');assert.equal(writes.length,0);continue;}
    assert.equal(writes.length,2);
    assert.equal(writes[1].values[1],scenario==='accepted'||scenario.includes('exhausted'));
    assert.ok(!JSON.stringify(writes).includes('sensitive arbitrary'));
    if(scenario==='exhausted')assert.equal(writes[1].values[3],'SYNTHETIC_REVIEW_REQUIRED');
  }
  process.env.NODE_ENV='production';
  await assert.rejects(recoverPreviewRehearsalOnce({} as Prisma.TransactionClient));
});
