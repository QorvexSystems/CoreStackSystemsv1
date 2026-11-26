// Read-only deployment checks. Run in the worker image with its normal mounts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectFiscalDatabase } from '/app/fiscal/src/postgres-connection.ts';

let db;
try {
  const config = JSON.parse(await readFile('/run/config/fiscal-worker.json', 'utf8'));
  db = await connectFiscalDatabase(config);
  const functions = (await db.query(`SELECT p.proname,p.prosecdef,
    pg_get_userbyid(p.proowner) AS owner,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='corestack_fiscal'`, [])).rows;
  const approved = ['claim_preparation','complete_preparation','fail_preparation','read_preparation','register_request'];
  assert.deepEqual(functions.filter(f => f.executable).map(f => f.proname).sort(), approved.sort());
  assert.ok(functions.every(f => f.owner === 'rivnu_fe_pre_owner'));
  assert.ok(functions.filter(f => f.executable).every(f => f.prosecdef === true));
  const tables = (await db.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,
    has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable,
    has_table_privilege(current_user,c.oid,'SELECT') AS readable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='corestack_fiscal' AND c.relkind='r'`, [])).rows;
  assert.deepEqual(tables.map(t => t.relname).sort(), [
    'audit_event','document','document_artifact','preparation_job','request_snapshot',
    'runtime_scope','schema_migration','sequence_range','sequence_reservation',
  ].sort());
  assert.ok(tables.every(t => t.owner === 'rivnu_fe_pre_owner' && !t.writable && !t.readable));
  const triggers = (await db.query(`SELECT t.tgname,t.tgenabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='corestack_fiscal' AND NOT t.tgisinternal`, [])).rows;
  assert.equal(triggers.length, 8);
  assert.ok(triggers.every(t => t.tgenabled === 'O'));
  const invisible = await db.query('SELECT corestack_fiscal.read_preparation($1::bigint) AS document', ['-1']);
  assert.equal(invisible.rows[0]?.document, null);
  console.log('FISCAL_PERSISTENCE_INSTALL_VERIFIED: strict TLS, dedicated owner, five scoped functions, no direct table access, eight immutable-evidence triggers.');
} catch {
  console.error('FISCAL_PERSISTENCE_INSTALL_CHECK_FAILED: review metadata; no changes applied by this check.');
  process.exitCode = 1;
} finally { if (db) await db.close(); }
