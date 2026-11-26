// Disposable DB + synthetic credential only. Never run this against VM3.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectFiscalDatabase } from '../src/postgres-connection.ts';
import { registerFiscalRequest } from '../src/request-repository.ts';
import { runPreparationOnce } from '../src/preparation-worker.ts';
import { createFiscalRegistrationServer } from '../src/http-service.ts';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { checkServerIdentity } from 'node:tls';
import { testDispatch } from './dispatch-integration.ts';
import { testTransport } from './transport-integration.ts';
import { readFiscalPreparation } from '../src/preparation-repository.ts';
import {
  createFiscalRegistrationClient,
  FiscalTransportError,
} from '../src/registration-client.ts';

const folder = await mkdtemp(join(tmpdir(), 'fiscal-integration-'));
try {
  const passwordFile = join(folder, 'password');
  await writeFile(passwordFile, 'disposable-only', { mode: 0o400 });
  const scope = {
    tenantId: 'cmqn0r66a0002lit0vxbzq5l4',
    issuerRnc: '40220429126',
    environment: 'precertification' as const,
  };
  const config = {
    host: '127.0.0.1',
    port: 5432,
    database: 'rivnu_fiscal_pre',
    user: 'rivnu_fe_pre_runtime',
    passwordFile,
    caFile: '/run/test-ca.crt',
    scope,
  };
  const connection = await connectFiscalDatabase(config);
  try {
    const input = JSON.parse(
      await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
    );
    input.issuer.rnc = scope.issuerRnc;
    const erpClient = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: 'disposable-only',
      ssl: {
        ca: await readFile(config.caFile, 'utf8'),
        rejectUnauthorized: true,
        checkServerIdentity: (_name, cert) => checkServerIdentity(config.host, cert),
      },
    });
    await erpClient.connect();
    try {
      await testDispatch(
        { query: async (sql, values) => erpClient.query(sql, [...values]) },
        scope,
        input,
        connection,
      );
    } finally {
      await erpClient.end();
    }
    const token = 'synthetic_integration_registration_token_0123456789';
    const tls = {
      cert: await readFile('/run/test-server.crt', 'utf8'),
      key: await readFile('/run/test-server.key', 'utf8'),
    };
    await testTransport(tls, await readFile(config.caFile, 'utf8'), scope, input);
    let loseAcknowledgment = true;
    const receiver = createFiscalRegistrationServer({
      scope,
      bearerToken: token,
      tls,
      connection: {
        query: async (sql, values) => {
          const result = await connection.query(sql, values);
          if (loseAcknowledgment) {
            loseAcknowledgment = false;
            throw new Error('Simulated acknowledgment loss AFTER real commit');
          }
          return result;
        },
      },
    });
    await new Promise<void>((resolve) => receiver.listen(0, '0.0.0.0', resolve));
    let first: { documentId: string; encf: string; reused: boolean };
    try {
      const origin = `https://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
      const transportConfig = {
        origin,
        ca: await readFile('/run/test-ca.crt', 'utf8'),
        bearerToken: token,
        scope,
      };
      const send = createFiscalRegistrationClient(transportConfig);
      await assert.rejects(send(input), { outcome: 'UNCONFIRMED' });
      first = await send(input);
      assert.equal(first.reused, true);
      assert.equal(first.encf, 'E310000000001');
      await assert.rejects(
        createFiscalRegistrationClient({
          ...transportConfig,
          bearerToken: 'wrong_token_with_valid_length_01234567890123456789',
        })(input),
        { outcome: 'REJECTED' },
      );
      await assert.rejects(
        createFiscalRegistrationClient({
          ...transportConfig,
          origin: origin.replace('127.0.0.1', '127.0.0.2'),
        })(input),
        FiscalTransportError,
      );
      await assert.rejects(
        createFiscalRegistrationClient({ ...transportConfig, ca: tls.cert })(input),
        FiscalTransportError,
      );
    } finally {
      receiver.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
    const duplicate = await registerFiscalRequest(connection, scope, input);
    assert.equal(first.documentId, duplicate.documentId);
    assert.equal(duplicate.reused, true);
    const processed = await runPreparationOnce(connection, scope);
    assert.equal(processed.result, 'UNSIGNED_XML_STORED');
    const saved = await connection.query(
      'SELECT corestack_fiscal.read_preparation($1::bigint) AS saved',
      [first.documentId],
    );
    const artifact = saved.rows[0]!.saved as { state: string; xml: string; sendable: boolean };
    assert.equal(artifact.state, 'DONE');
    assert.equal(artifact.sendable, false);
    assert.ok(artifact.xml.includes(`<RNCEmisor>${scope.issuerRnc}</RNCEmisor>`));
    const visible = await readFiscalPreparation(connection, first.documentId);
    assert.equal(visible!.xml, artifact.xml);
    assert.equal(visible!.schemaValidated, true);
    assert.equal(visible!.signed, false);
    assert.equal(await readFiscalPreparation(connection, '9223372036854775807'), null);
    assert.equal((await runPreparationOnce(connection, scope)).result, 'IDLE');
    await assert.rejects(connection.query('DELETE FROM corestack_fiscal.document_artifact', []), {
      code: '42501',
    });
  } finally {
    await connection.close();
  }
  await assert.rejects(
    connectFiscalDatabase({ ...config, scope: { ...scope, tenantId: 'wrong' } }),
    /FISCAL_DATABASE_CONNECTION_REJECTED/,
  );
  await assert.rejects(
    connectFiscalDatabase({ ...config, database: 'rivnu_production' }),
    /FISCAL_DATABASE_CONNECTION_REJECTED/,
  );
  console.log(
    'PASS: ERP outbox rollback/replay/fencing + authenticated HTTPS + CA/hostname rejection + lost-ack replay + real pg driver + strict TLS + atomic registration + XSD worker + immutable XML + scope/DB restrictions.',
  );
} finally {
  await rm(folder, { recursive: true, force: true });
}
