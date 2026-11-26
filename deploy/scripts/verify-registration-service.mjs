// Run inside the registration container. No valid fiscal request or DB write.
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import assert from 'node:assert/strict';
const ca = await readFile('/run/secrets/postgresql-ca.crt', 'utf8');
const token = (await readFile('/run/secrets/fiscal_registration_token', 'utf8')).trim();
async function probe(authorization, expectedIdentity = '10.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 8443, path: '/internal/v1/requests',
      method: 'POST', ca, rejectUnauthorized: true, agent: false,
      checkServerIdentity: (_name, cert) => checkServerIdentity(expectedIdentity, cert),
      headers: { authorization, 'content-type': 'application/json', 'content-length': 2 },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('TIMEOUT')), 3000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end('{}');
  });
}
try {
  assert.equal(await probe('Bearer invalid'), 401);
  assert.equal(await probe(`Bearer ${token}`), 422);
  await assert.rejects(probe(`Bearer ${token}`, 'wrong.invalid'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  console.log('PASS: strict TLS, wrong identity rejected, missing credential rejected, authenticated invalid contract rejected before registration. No valid document submitted.');
} catch {
  console.error('REGISTRATION_SMOKE_FAILED');
  process.exitCode = 1;
}
