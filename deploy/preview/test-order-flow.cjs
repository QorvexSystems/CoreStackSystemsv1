// Deliberately fixed to the isolated local preview; never accepts a remote URL.
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:4101';
const tenantId = 'cmt397emm0002nm0ogb50l2q6';
async function main() {
  let token;
  async function call(path, body, expected, overrideTenant = tenantId) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': overrideTenant,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (expected) assert.equal(response.status, expected, `${path}: unexpected HTTP status`);
    else assert.ok(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  const auth = await call('/auth/login', {
    email: 'admin@rivnu.local',
    password: 'DemoPassword123!',
  });
  assert.ok(
    auth.memberships.some((m) => m.tenantId === tenantId && m.tenantSlug === 'ferreteria-rivnu'),
  );
  assert.ok(!auth.memberships.some((m) => m.tenantId === 'cmqn0r66a0002lit0vxbzq5l4'));
  token = auth.accessToken;
  const product = await call('/products', {
    name: 'PRUEBA ECF SIN VALIDEZ ' + Date.now(),
    fiscalItemKind: 'GOOD',
    price: 100,
    stock: 0,
    minStock: 0,
    trackInventory: false,
    taxCategory: 'ITBIS_18',
    taxRate: 0.18,
  });
  const order = await call('/orders', {
    destination: 'CASH_SALE',
    fiscalIssuanceMode: 'ELECTRONIC_ECF',
    clientName: 'PRUEBA SINTETICA SIN VALIDEZ',
    items: [{ productId: product.id, quantity: 1 }],
  });
  assert.equal(order.fiscalDocumentTypeSnapshot, 'CONSUMER_ELECTRONIC_32');
  const cashier = await call('/auth/login', {
    email: 'cajero@rivnu.local',
    password: 'DemoPassword123!',
  });
  assert.ok(cashier.memberships.some((m) => m.tenantId === tenantId));
  token = cashier.accessToken;
  let session = await call('/cash/sessions/current');
  if (!session) {
    const registers = await call('/cash/registers');
    assert.ok(registers.length);
    session = await call('/cash/sessions/open', {
      cashRegisterId: registers[0].id,
      openingAmount: 1,
    });
  }
  await call(`/orders/${order.id}/claim`, { cashSessionId: session.id });
  const path = `/pos/orders/${order.id}/synthetic-preparation`;
  const [first, second] = await Promise.all([call(path, {}), call(path, {})]);
  assert.ok(['PENDING', 'DONE'].includes(first.state), JSON.stringify(first));
  assert.equal(first.id, second.id);
  if (process.env.EXPECT_AUTONOMOUS === 'true') {
    assert.equal(first.state, 'PENDING');
    assert.equal(second.state, 'PENDING');
    console.log('AUTONOMOUS_RECOVERY_PENDING');
  }
  let read;
  for (let attempt = 0; attempt < 240; attempt++) {
    read = await call(path);
    if (read?.state === 'DONE' || read?.state === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(read.state, 'DONE', JSON.stringify(read));
  assert.equal(read.result.sendable, false);
  assert.equal(read.result.signed, false);
  if (process.env.EXPECT_REMOTE === 'true') assert.equal(read.executionMode, 'REMOTE_VM4');
  // In recovery mode, no additional POST may help finish the operation.
  const persisted =
    process.env.EXPECT_AUTONOMOUS === 'true' ? await call(path) : await call(path, {});
  assert.equal(persisted.result.xml, read.result.xml);
  assert.equal(read.id, first.id);
  assert.equal(read.stale, false);
  if (process.env.EXPECT_REHEARSAL === 'true') {
    const rehearsalPath = `/pos/orders/${order.id}/synthetic-rehearsal`;
    const [a, b] = await Promise.all([call(rehearsalPath, {}), call(rehearsalPath, {})]);
    assert.equal(a.preparationId, b.preparationId);
    let result;
    for (let attempt = 0; attempt < 180; attempt++) {
      result = await call(rehearsalPath);
      if (result?.terminal) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(result?.result?.state, 'ACCEPTED');
    assert.ok(result.result.model);
    assert.equal(result.result.model.sourceSha256, read.result.sha256);
    assert.equal(result.result.model.encf, read.result.encf);
    assert.equal(result.synthetic, true);
    assert.equal(result.sendable, false);
    assert.ok(result.result.model.notice.includes('SIN VALIDEZ FISCAL'));
    const replay = await call(rehearsalPath, {});
    assert.deepEqual(replay, result);
    await call(rehearsalPath, undefined, 403, 'synthetic-unrelated-tenant');
    await call(rehearsalPath, {}, 403, 'synthetic-unrelated-tenant');
    if (process.env.PREVIEW_ARTIFACT_DIR) {
      const fs = require('node:fs/promises');
      await fs.writeFile(
        process.env.PREVIEW_ARTIFACT_DIR + '/rehearsal-model.json',
        JSON.stringify(result.result.model),
        { mode: 0o600 },
      );
      await fs.writeFile(
        process.env.PREVIEW_ARTIFACT_DIR + '/rehearsal-ids.json',
        JSON.stringify({
          orderId: order.id,
          preparationId: read.id,
          signedSha256: result.result.model.signedSha256,
        }),
        { mode: 0o600 },
      );
    }
    console.log(
      'PASS LIVE ERP -> VM4 -> SYNTHETIC XMLDSig -> QUEUE -> SIMULATOR -> PERSISTED ERP RI; idempotent; cross-tenant blocked',
    );
  }
  await call(path, undefined, 403, 'synthetic-unrelated-tenant');
  await call(
    '/pos/sales/complete',
    {
      orderId: order.id,
      cashSessionId: session.id,
      paymentMethod: 'CASH',
      amountReceived: 118,
    },
    400,
  );
  const after = await call(`/orders/${order.id}`);
  assert.equal(after.invoiceId, null);
  console.log(
    JSON.stringify({
      result: 'PASS',
      orderId: order.id,
      orderNumber: order.orderNumber,
      preparationId: first.id,
      state: read.state,
      executionMode: read.executionMode,
      signed: false,
      sendable: false,
      concurrentRetry: 'same document',
      crossTenant: 'blocked',
      checkout: 'blocked',
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
