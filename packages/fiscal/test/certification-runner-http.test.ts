import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';

test('VM4 runner requires TLS/token, binds tenant and environment, and waits without executing unapproved plans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'certification-runner-http-'));
  const exec = promisify(execFile);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await exec('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-x509',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(directory, 'tls.key'),
      '-out',
      join(directory, 'tls.crt'),
    ]);
    const token = 's'.repeat(43);
    await writeFile(join(directory, 'token'), token, { mode: 0o600 });
    const scope = {
      tenantId: 'synthetic-certification-http',
      issuerRnc: '101010632',
      environment: 'certification',
    };
    const fingerprint = 'b'.repeat(64);
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({
        scope,
        signer: { expectedCertificateSha256: fingerprint, workRoot: '/tmp/fiscal-signer' },
        inputRoot: '/input',
        evidenceRoot: '/evidence',
        tokenFile: join(directory, 'token'),
        tlsCertificateFile: join(directory, 'tls.crt'),
        tlsKeyFile: join(directory, 'tls.key'),
        listenHost: '0.0.0.0',
        listenPort: 8445,
        approvedCases: [],
      }),
      { mode: 0o600 },
    );
    child = spawn(
      process.execPath,
      ['--experimental-strip-types', 'src/certification-runner-main.ts'],
      {
        env: { ...process.env, CERTIFICATION_RUNNER_CONFIG: join(directory, 'config.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(Error('RUNNER_START_TIMEOUT')), 8000);
      child!.stdout!.on('data', (data) => {
        if (String(data).includes('CERTIFICATION_RUNNER_READY')) {
          clearTimeout(timer);
          ready();
        }
      });
      child!.once('exit', () => {
        clearTimeout(timer);
        reject(Error('RUNNER_START_FAILED'));
      });
    });
    const ca = await readFile(join(directory, 'tls.crt'));
    const call = (body: object, credential = token, path = '/internal/v1/certification/step') =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            servername: 'localhost',
            port: 8445,
            path,
            ca,
            method: 'POST',
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (data) => chunks.push(data));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              }),
            );
          },
        );
        req.setTimeout(3000, () => req.destroy(Error('TEST_TIMEOUT')));
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    const input = {
      ...scope,
      caseId: 'synthetic-case',
      stepNumber: 2,
      certificateSha256: fingerprint,
    };
    assert.equal((await call(input, 'wrong')).status, 401);
    assert.equal((await call(input, token, '/not-allowed')).status, 404);
    for (const change of [
      { tenantId: 'other-client' },
      { environment: 'production' },
      { issuerRnc: '101010641' },
      { caseId: '../other' },
      { certificateSha256: 'a'.repeat(64) },
    ]) {
      const result = await call({ ...input, ...change });
      assert.equal(result.body.status, 'FAILED');
      assert.equal(result.body.code, 'CERTIFICATION_REQUEST_SCOPE_INVALID');
    }
    const result = await call(input);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'WAITING_INPUT');
    assert.equal(result.body.code, 'CERTIFICATION_APPROVED_PLAN_REQUIRED');
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((done) => child!.once('exit', () => done()));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
