import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@qorvex/database';
import { recoverRemotePreparationOnce } from '../src/modules/fiscal-documents/preview-recovery.service';

test('preview recovery is guarded, scoped, bounded, and schedules before remote processing',async(t)=>{
 const names=['NODE_ENV','RIVNU_PREVIEW_GUARD','DATABASE_URL','DIRECT_URL'];
 const previous=names.map(name=>process.env[name]);
 t.after(()=>names.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i];}));
 process.env.NODE_ENV='development';process.env.RIVNU_PREVIEW_GUARD='RIVNU_DGII_PREVIEW_ONLY';
 process.env.DATABASE_URL=process.env.DIRECT_URL='postgresql://rivnu_preview:synthetic@rivnu-dgii-preview-db:5432/rivnu_dgii_preview';
 const calls:string[]=[];
 const row={id:'1',state:'PENDING',remote_ack:{documentId:'7'},snapshot:{},planned_at:'',revision:'',result:null,error_code:null};
 const tx={
  $queryRawUnsafe:async(sql:string,tenant:string)=>{
   assert.match(sql,/FOR UPDATE SKIP LOCKED/);assert.match(sql,/recovery_attempts<10/);
   assert.equal(tenant,'cmt397emm0002nm0ogb50l2q6');calls.push('claim');return [row];
  },
  $executeRawUnsafe:async(sql:string)=>{assert.match(sql,/recovery_attempts=recovery_attempts\+1/);calls.push('schedule');return 1;},
 } as unknown as Prisma.TransactionClient;
 const processor=(async(_tx:unknown,input:unknown)=>{
  assert.equal(input,row);calls.push('process');return {...row,state:'DONE'};
 }) as unknown as Parameters<typeof recoverRemotePreparationOnce>[1];
 assert.equal(await recoverRemotePreparationOnce(tx,processor),'DONE');assert.deepEqual(calls,['claim','schedule','process']);
 process.env.NODE_ENV='production';await assert.rejects(recoverRemotePreparationOnce(tx,processor));assert.equal(calls.length,3);
});

test('idle recovery does not call remote processor or perform writes',async(t)=>{
 const names=['NODE_ENV','RIVNU_PREVIEW_GUARD','DATABASE_URL','DIRECT_URL'];const previous=names.map(n=>process.env[n]);
 t.after(()=>names.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];}));
 process.env.NODE_ENV='development';process.env.RIVNU_PREVIEW_GUARD='RIVNU_DGII_PREVIEW_ONLY';
 process.env.DATABASE_URL=process.env.DIRECT_URL='postgresql://rivnu_preview:synthetic@rivnu-dgii-preview-db:5432/rivnu_dgii_preview';
 const tx={$queryRawUnsafe:async()=>[],$executeRawUnsafe:async()=>{throw Error('No write expected');}} as unknown as Prisma.TransactionClient;
 const processor=async()=>{throw Error('No remote call expected');};
 assert.equal(await recoverRemotePreparationOnce(tx,processor),'IDLE');
});
