import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createElectronicRangeRegistrationClientFromEnvironment, ElectronicRangeTransportError } from '../src/modules/fiscal-sequences/electronic-range-registration.client';

for (const mismatch of [false,true]) {
  test(`request acknowledgement ${mismatch?'digest mismatch is explicit and never accepted':'with the exact digest is accepted'}`,async t=>{
    const directory=mkdtempSync(join(tmpdir(),'synthetic-range-ack-'));
    const previous=process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE;
    const tenantId='synthetictenant00000001',expected='a'.repeat(64);
    let calls=0;
    // Synthetic local files and a mocked HTTPS request: no real credentials,
    // network, database, reservation or DGII requests are used by these tests.
    writeFileSync(join(directory,'token'),'x'.repeat(43),{mode:0o600});
    writeFileSync(join(directory,'ca'),'-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----',{mode:0o600});
    writeFileSync(join(directory,'routes'),JSON.stringify({version:1,routes:[{tenantId,issuerRnc:'101010632',
      origin:'https://synthetic.invalid',tokenFile:join(directory,'token'),caFile:join(directory,'ca')}]}),{mode:0o600});
    process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE=join(directory,'routes');
    t.mock.method(https,'request',()=>{
      calls++;
      const request=Object.assign(new EventEmitter(),{destroy:()=>{},end:()=>queueMicrotask(()=>{
        const response=Object.assign(Readable.from([Buffer.from(JSON.stringify({documentId:'1',encf:'E310000000001',
          payloadSha256:mismatch?'b'.repeat(64):expected,reused:true,stage:'RESERVED',persisted:true}))]),
          {statusCode:200,headers:{'content-type':'application/json'}});
        request.emit('response',response);
      })});
      return request;
    });
    try {
      const client=createElectronicRangeRegistrationClientFromEnvironment();
      assert.ok(client);
      if(mismatch) await assert.rejects(client.registerFiscalRequest(tenantId,'101010632',{type:31},expected),
        error=>error instanceof ElectronicRangeTransportError && error.outcome==='UNCONFIRMED' && error.diagnosticCode==='ACK_PAYLOAD_HASH_MISMATCH');
      else assert.equal((await client.registerFiscalRequest(tenantId,'101010632',{type:31},expected)).payloadSha256,expected);
      assert.equal(calls,1);
    } finally {
      if(previous===undefined) delete process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE;
      else process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE=previous;
      rmSync(directory,{recursive:true,force:true});
    }
  });
}
