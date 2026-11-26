import { readFile } from 'node:fs/promises';
import { request } from 'node:https';

try {
  const ca = await readFile('/run/secrets/registration-ca.crt', 'utf8');
  const req = request(
    {
      host: '127.0.0.1',
      port: 8443,
      path: '/health/live',
      method: 'GET',
      ca,
      servername: 'rivnu-range-registration.internal',
      rejectUnauthorized: true,
      timeout: 2500,
    },
    (res) => {
      res.resume();
      res.once('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
    },
  );
  req.once('timeout', () => req.destroy());
  req.once('error', () => process.exit(1));
  req.end();
} catch {
  process.exit(1);
}
