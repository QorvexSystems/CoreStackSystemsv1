import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

// Liveness only. Certificate must identify the provisioned VM4 address even
// though this check connects through loopback inside the same container.
try {
  const ca = await readFile('/run/secrets/postgresql-ca.crt', 'utf8');
  await new Promise<void>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: 8443, path: '/health/live',
      ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
      checkServerIdentity: (_name, cert) => checkServerIdentity('10.0.0.1', cert),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024) req.destroy(new Error('OVERSIZED_HEALTH'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200 || parsed.status !== 'ok' || parsed.mode !== 'unsigned-registration' || parsed.sendable !== false) throw new Error();
          resolve();
        } catch { reject(new Error('INVALID_HEALTH')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('HEALTH_TIMEOUT')), 2000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
} catch {
  console.error('REGISTRATION_HEALTH_FAILED');
  process.exitCode = 1;
}
