const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:4101';
const tenantId = 'cmt397emm0002nm0ogb50l2q6';
async function main() {
  const orderId = process.env.PREVIEW_RECOVERY_ORDER;
  assert.match(orderId || '', /^[a-z0-9]{20,40}$/);
  const auth = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cajero@rivnu.local', password: 'DemoPassword123!' }),
  }).then((r) => r.json());
  assert.ok(auth.memberships.some((m) => m.tenantId === tenantId));
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    'x-tenant-id': tenantId,
    'Content-Type': 'application/json',
  };
  async function call(path, method = 'GET') {
    const response = await fetch(base + path, { method, headers });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  }
  const path = `/pos/orders/${orderId}/synthetic-preparation`;
  const before = await call(path);
  await call(path, 'POST');
  let after;
  for (let i = 0; i < 30; i++) {
    after = await call(path);
    if (after.state === 'DONE') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(after.state, 'DONE', JSON.stringify(after));
  assert.equal(after.id, before.id);
  assert.equal(after.executionMode, 'REMOTE_VM4');
  const persisted = await call(path, 'POST');
  assert.equal(persisted.result.xml, after.result.xml);
  console.log(
    JSON.stringify({
      result: 'PASS_REMOTE_RECOVERY',
      orderId,
      preparationId: after.id,
      remoteDocumentId: after.result.documentId,
      encf: after.result.encf,
      state: after.state,
      executionMode: after.executionMode,
      signed: after.result.signed,
      sendable: after.result.sendable,
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
