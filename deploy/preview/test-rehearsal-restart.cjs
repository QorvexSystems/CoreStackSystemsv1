// Read-only verification of a previously completed local-preview rehearsal.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
async function main() {
  const saved = JSON.parse(await fs.readFile('/artifacts/rehearsal-ids.json','utf8'));
  const model = JSON.parse(await fs.readFile('/artifacts/rehearsal-model.json','utf8'));
  const base='http://127.0.0.1:4101';
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'cajero@rivnu.local',password:'DemoPassword123!'})});
  assert.ok(login.ok);
  const auth=await login.json();
  const headers={authorization:`Bearer ${auth.accessToken}`,'x-tenant-id':'cmt397emm0002nm0ogb50l2q6'};
  const response=await fetch(base+`/pos/orders/${saved.orderId}/synthetic-rehearsal`,{headers});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.terminal,true);assert.equal(result.result.state,'ACCEPTED');
  assert.equal(result.preparationId,saved.preparationId);
  assert.deepEqual(result.result.model,model);
  console.log('PASS after VM4/API restart: same persisted document, signature hash, simulated acceptance and RI; GET only');
}
main().catch(()=>{console.error('RESTART_VERIFICATION_FAILED');process.exitCode=1;});
