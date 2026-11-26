import assert from 'node:assert/strict';
import { enqueueFiscalDispatch, createFiscalDispatchQueue } from '../src/dispatch-repository.ts';
import { runDispatchOnce } from '../src/dispatch-worker.ts';
import type { FiscalScope } from '../src/catalog.ts';
import type { FiscalRegistrationConnection } from '../src/request-repository.ts';

// Called with a pinned client in a disposable fixture; no live ERP database.
export async function testDispatch(
  connection: FiscalRegistrationConnection,
  scope: FiscalScope,
  input: Record<string, unknown>,
  contender: FiscalRegistrationConnection,
) {
  const request = {
    ...input,
    operationId: 'erp-dispatch-operation',
    source: { documentId: 'erp-synthetic-1', revision: '2026-09-21T12:00:00.000Z' },
  };
  await connection.query('BEGIN', []);
  await enqueueFiscalDispatch(connection, scope, request);
  await connection.query('ROLLBACK', []);
  assert.equal(
    (await connection.query('SELECT id FROM corestack_erp_fiscal.dispatch', [])).rows.length,
    0,
  );
  await connection.query('BEGIN', []);
  const created = await enqueueFiscalDispatch(connection, scope, request);
  const reused = await enqueueFiscalDispatch(connection, scope, request);
  assert.equal(reused.id, created.id);
  assert.equal(reused.reused, true);
  await connection.query('COMMIT', []);
  await connection.query('BEGIN', []);
  await assert.rejects(
    enqueueFiscalDispatch(connection, scope, { ...request, operationId: 'conflicting-operation' }),
    /ERP_DISPATCH_CONFLICT/,
  );
  await connection.query('ROLLBACK', []);
  await connection.query('BEGIN', []);
  await connection.query(
    'SELECT id FROM corestack_erp_fiscal.dispatch WHERE id=$1::bigint FOR UPDATE',
    [created.id],
  );
  assert.equal(await createFiscalDispatchQueue(contender, scope).claim(), null);
  await connection.query('ROLLBACK', []);
  await assert.rejects(
    connection.query("UPDATE corestack_erp_fiscal.dispatch SET request_text='{}'", []),
    /FISCAL_DISPATCH_EVIDENCE_IMMUTABLE/,
  );
  const queue = createFiscalDispatchQueue(connection, scope);
  const first = await queue.claim();
  assert.ok(first);
  assert.equal(await queue.claim(), null);
  await connection.query(
    "UPDATE corestack_erp_fiscal.dispatch SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1::bigint",
    [first.id],
  );
  const recovered = await queue.claim();
  assert.ok(recovered);
  assert.notEqual(first.leaseToken, recovered.leaseToken);
  assert.equal(first.requestText, recovered.requestText);
  const ack = { documentId: '123', encf: 'E310000000002', payloadSha256: first.payloadSha256 };
  assert.equal(await queue.acknowledge(first, ack), false);
  assert.equal(await queue.defer(recovered, 'UNCONFIRMED'), true);
  assert.equal(await queue.claim(), null);
  await connection.query(
    "UPDATE corestack_erp_fiscal.dispatch SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1::bigint",
    [first.id],
  );
  const other = createFiscalDispatchQueue(connection, { ...scope, tenantId: 'other' });
  assert.equal(await other.claim(), null);
  assert.deepEqual(
    await runDispatchOnce(queue, scope, async () => ({
      ...ack,
      stage: 'RESERVED',
      sendable: false,
    })),
    { result: 'REGISTERED' },
  );
  assert.equal(await queue.claim(), null);
  await assert.rejects(
    connection.query(
      "UPDATE corestack_erp_fiscal.dispatch SET state='PENDING',document_id=NULL,encf=NULL",
      [],
    ),
    /FISCAL_DISPATCH_TERMINAL/,
  );
  const second = {
    ...request,
    operationId: 'second-operation',
    source: { ...request.source, documentId: 'erp-synthetic-2' },
  };
  await connection.query('BEGIN', []);
  const secondJob = await enqueueFiscalDispatch(connection, scope, second);
  await connection.query('COMMIT', []);
  await connection.query(
    'UPDATE corestack_erp_fiscal.dispatch SET attempts=9 WHERE id=$1::bigint',
    [secondJob.id],
  );
  const finalAttempt = await queue.claim();
  assert.ok(finalAttempt);
  assert.equal(finalAttempt.id, secondJob.id);
  assert.equal(await queue.defer(finalAttempt, 'UNCONFIRMED'), true);
  assert.equal(await queue.claim(), null);
  const reviewed = await connection.query(
    'SELECT state,attempts FROM corestack_erp_fiscal.dispatch WHERE id=$1::bigint',
    [secondJob.id],
  );
  assert.equal(reviewed.rows[0]!.state, 'REVIEW_REQUIRED');
  assert.equal(reviewed.rows[0]!.attempts, 10);
}
