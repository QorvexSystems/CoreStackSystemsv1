// Read-only PostgreSQL STARTTLS probe; never authenticates or sends SQL.
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const ca = await readFile(process.argv[2] ?? '/run/ca.crt');
const expectedFingerprint = 'A5:31:CD:3B:F7:65:58:7B:7D:9E:6E:6A:CE:DD:16:84:CF:6F:EC:01:16:5F:4A:AA:B5:68:FF:4E:C9:4B:C4:EB';

function probe(identity, trustCA) {
  return new Promise((resolve, reject) => {
    let secure;
    let done = false;
    const socket = net.connect({ host: '10.0.0.4', port: 5432 });
    const timer = setTimeout(() => finish(new Error('PROBE_TIMEOUT')), 10000);
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (secure) secure.destroy();
      socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.once('data', (response) => {
      if (response.length !== 1 || response[0] !== 83) {
        finish(new Error('POSTGRESQL_SSL_NOT_ACCEPTED'));
        return;
      }
      secure = tls.connect({
        socket,
        ca: trustCA ? ca : tls.rootCertificates,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => tls.checkServerIdentity(identity, cert),
      });
      secure.once('error', (error) => finish(error));
      secure.once('secureConnect', () => {
        const peer = secure.getPeerCertificate();
        const identityError = tls.checkServerIdentity(identity, peer);
        if (identityError) return finish(identityError);
        if (!secure.authorized) return finish(new Error('TLS_NOT_AUTHORIZED'));
        finish(null, { protocol: secure.getProtocol(), fingerprint: peer.fingerprint256 });
      });
    });
  });
}

try {
  const valid = await probe('10.0.0.4', true);
  assert.equal(valid.fingerprint, expectedFingerprint, 'Unexpected server certificate');
  console.log(JSON.stringify({ test: 'trusted_CA_correct_IP', result: 'PASS', ...valid }));
  for (const [name, identity, trustCA, acceptedCodes] of [
    ['wrong_IP', '10.0.0.99', true, ['ERR_TLS_CERT_ALTNAME_INVALID']],
    ['untrusted_CA', '10.0.0.4', false, ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN']],
  ]) {
    let rejection;
    try { await probe(identity, trustCA); } catch (error) { rejection = error; }
    assert.ok(rejection && acceptedCodes.includes(rejection.code), `${name}: did not fail for the expected TLS reason`);
    console.log(JSON.stringify({ test: name, result: 'PASS_REJECTED', code: rejection.code }));
  }
  console.log('TLS_NETWORK_VERIFIED_NO_DATABASE_AUTHENTICATION');
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', code: error.code ?? 'PROBE_FAILED', message: error.message }));
  process.exitCode = 1;
}
