import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertAuthorizedRemoteTarget, REMOTE_CONFIRMATION, AUTHORIZED_PROJECT_REF } from './remote-guard';

const dir = mkdtempSync(join(tmpdir(), 'remote-guard-'));
const backup = join(dir, 'b.dump');
writeFileSync(backup, Buffer.alloc(4096, 1));
const good = {
  WEB_CATALOG_IMPORT_REMOTE: REMOTE_CONFIRMATION,
  DIRECT_URL: `postgresql://postgres.${AUTHORIZED_PROJECT_REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
};

test('acepta proyecto, tenant, confirmación y respaldo correctos', () => {
  const t = assertAuthorizedRemoteTarget(good, 'unique-personalizado', backup);
  assert.equal(t.backupBytes, 4096);
  assert.match(t.backupSha256, /^[0-9a-f]{64}$/);
});

test('rechaza otro proyecto, otro tenant, puerto 6543, sin confirmación y sin respaldo', () => {
  const other = { ...good, DIRECT_URL: good.DIRECT_URL.replace(AUTHORIZED_PROJECT_REF, 'otroproyecto') };
  assert.throws(() => assertAuthorizedRemoteTarget(other, 'unique-personalizado', backup), /proyecto autorizado/);
  assert.throws(() => assertAuthorizedRemoteTarget(good, 'corestack', backup), /tenant no autorizado/);
  assert.throws(() => assertAuthorizedRemoteTarget({ ...good, DIRECT_URL: good.DIRECT_URL.replace(':5432', ':6543') }, 'unique-personalizado', backup), /6543/);
  assert.throws(() => assertAuthorizedRemoteTarget({ ...good, WEB_CATALOG_IMPORT_REMOTE: 'yes' }, 'unique-personalizado', backup), /WEB_CATALOG_IMPORT_REMOTE/);
  assert.throws(() => assertAuthorizedRemoteTarget(good, 'unique-personalizado', undefined), /respaldo/);
  assert.throws(() => assertAuthorizedRemoteTarget({ ...good, DATABASE_URL: good.DIRECT_URL, DIRECT_URL: undefined }, 'unique-personalizado', backup), /DIRECT_URL/);
});
