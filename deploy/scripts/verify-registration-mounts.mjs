// Disposable Compose run with the exact service mounts; no private values logged.
import { readFile, stat } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { connectFiscalDatabase } from '/app/fiscal/src/postgres-connection.ts';
try {
  for (const path of ['/run/secrets/fiscal_registration_token', '/run/secrets/registration-server.key', '/run/secrets/postgresql-password']) {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.uid !== 1000 || (metadata.mode & 0o777) !== 0o400) throw new Error();
  }
  const token = (await readFile('/run/secrets/fiscal_registration_token', 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error();
  const cert = await readFile('/run/secrets/registration-server.crt', 'utf8');
  const key = await readFile('/run/secrets/registration-server.key', 'utf8');
  const leaf = new X509Certificate(cert);
  if (leaf.checkIP('10.0.0.1') !== '10.0.0.1' || Date.parse(leaf.validTo) <= Date.now()) throw new Error();
  createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
  const config = JSON.parse(await readFile('/run/config/fiscal-registration.json', 'utf8'));
  const connection = await connectFiscalDatabase(config);
  await connection.close();
  console.log('PASS: individual secrets protected, TLS key/certificate match, strict DB TLS and provisioned fiscal scope verified. No registration performed.');
} catch {
  console.error('REGISTRATION_MOUNTS_OR_DATABASE_REJECTED');
  process.exitCode = 1;
}
