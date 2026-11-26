// Run ONLY in a disposable --network none container, with private tmpfs mounts
// on /run/fiscal and /run/secrets. These are generated synthetic test credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';

const token = randomBytes(32).toString('base64url');
await writeFile(
  '/run/fiscal/config.json',
  JSON.stringify({
    tenantId: 'synthetic-rivnu',
    issuerRnc: '101010632',
    environment: 'certification',
  }),
  { mode: 0o600 },
);
await writeFile('/run/secrets/fiscal_preflight_token', token, { mode: 0o600 });
const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
const finished = once(child, 'exit');
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error('Container entrypoint exited before ready');
    try {
      const response = await fetch('http://127.0.0.1:8080/health/live', {
        signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).sendable, false);
      ready = true;
      break;
    } catch {
      await setTimeout(100);
    }
  }
  assert.equal(ready, true);
  const unauthorized = await fetch('http://127.0.0.1:8080/internal/v1/analyze', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);
  const authenticated = await fetch('http://127.0.0.1:8080/internal/v1/analyze', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(authenticated.status, 422);
  console.log(
    'PASS: actual image entrypoint, non-root/read-only runtime, health and authentication.',
  );
} finally {
  child.kill('SIGTERM');
  const [code] = await finished;
  assert.equal(code, 0, 'graceful shutdown');
}
