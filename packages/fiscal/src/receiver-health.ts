import { request } from 'node:https';
import { readFileSync } from 'node:fs';

const requestHealth = request({
  hostname: '10.0.0.1',
  port: 8444,
  path: '/health/live',
  method: 'GET',
  ca: readFileSync('/run/secrets/tls/server.crt'),
  servername: 'rivnu-fiscal-receiver.internal',
  timeout: 2000,
}, (response) => process.exit(response.statusCode === 200 ? 0 : 1));
requestHealth.once('timeout', () => requestHealth.destroy(Error('timeout')));
requestHealth.once('error', () => process.exit(1));
requestHealth.end();

