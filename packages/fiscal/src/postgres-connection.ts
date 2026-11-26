import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import { Pool } from 'pg';
import type { FiscalScope } from './catalog.ts';
import { assertScope } from './catalog.ts';
import { requireFiscal } from './contract.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export type FiscalDatabaseConfig = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  passwordFile: string;
  caFile: string;
  scope: FiscalScope;
}>;

/** No URL parsing, TLS opt-out, role switching or administrator credentials. */
export async function connectFiscalDatabase(
  config: FiscalDatabaseConfig,
): Promise<FiscalRegistrationConnection & { close(): Promise<void> }> {
  assertScope(config.scope);
  try {
    assertFiscalEnvironmentEnabled(config.scope);
  } catch {
    requireFiscal(false, 'PRODUCTION_DISABLED', 'scope.environment');
  }
  requireFiscal(
    typeof config.host === 'string' && /^[a-zA-Z0-9.:-]+$/.test(config.host),
    'INVALID_DATABASE_CONFIG',
    'host',
  );
  requireFiscal(
    Number.isInteger(config.port) && config.port > 0 && config.port <= 65535,
    'INVALID_DATABASE_CONFIG',
    'port',
  );
  requireFiscal(
    /^[a-z][a-z0-9_]{0,62}$/.test(config.database) && /^[a-z][a-z0-9_]{0,62}$/.test(config.user),
    'INVALID_DATABASE_CONFIG',
    'identity',
  );
  requireFiscal(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'UNSAFE_TLS_ENVIRONMENT', 'tls');
  const password = await readFile(config.passwordFile, 'utf8');
  requireFiscal(
    password.length > 0 && password.length <= 4096 && !/[\r\n\0]/.test(password),
    'INVALID_DATABASE_SECRET',
    'passwordFile',
  );
  const ca = await readFile(config.caFile, 'utf8');
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password,
    ssl: {
      ca,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      checkServerIdentity: (_name, cert) => checkServerIdentity(config.host, cert),
    },
    max: 2,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    query_timeout: 20000,
    idle_in_transaction_session_timeout: 15000,
    application_name: 'corestack-fiscal-preparation',
  });
  // Idle-socket errors must not crash the process or expose server SQL/data.
  pool.on('error', () => {});
  try {
    const result = await pool.query(`SELECT current_user AS identity, s.ssl,
      m.tenant_id, m.issuer_rnc, m.environment,
      r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
      FROM fiscal_meta.issuer_scope m CROSS JOIN pg_stat_ssl s
      JOIN pg_roles r ON r.rolname=current_user WHERE s.pid=pg_backend_pid()`);
    const row = result.rows[0];
    requireFiscal(
      result.rows.length === 1 &&
        row.identity === config.user &&
        row.ssl === true &&
        row.tenant_id === config.scope.tenantId &&
        row.issuer_rnc === config.scope.issuerRnc &&
        row.environment === config.scope.environment &&
        !row.rolsuper &&
        !row.rolcreatedb &&
        !row.rolcreaterole &&
        !row.rolreplication &&
        !row.rolbypassrls,
      'DATABASE_IDENTITY_MISMATCH',
      'connection',
    );
  } catch {
    await pool.end();
    throw new Error('FISCAL_DATABASE_CONNECTION_REJECTED');
  }
  return {
    async query(sql, values) {
      try {
        return await pool.query(sql, [...values]);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const safe =
          typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'DB_UNAVAILABLE';
        throw Object.assign(new Error('FISCAL_DATABASE_OPERATION_FAILED'), { code: safe });
      }
    },
    close: () => pool.end(),
  };
}
