\set ON_ERROR_STOP on
-- Operator-run on VM3 after the existing password has been stored in VM4.
-- Never prints password or SCRAM verifier. All checks + LOGIN are transactional.
BEGIN;
SET LOCAL statement_timeout='10s';
DO $$
BEGIN
 IF current_database() <> 'rivnu_fiscal_pre' OR current_user <> 'postgres' THEN
  RAISE EXCEPTION 'Use local postgres administrator in rivnu_fiscal_pre';
 END IF;
 IF (SELECT count(*) FROM fiscal_meta.issuer_scope) <> 1 OR NOT EXISTS (
  SELECT FROM fiscal_meta.issuer_scope WHERE singleton
   AND tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126'
   AND environment='precertification'
 ) THEN RAISE EXCEPTION 'Unexpected issuer scope'; END IF;
 IF NOT EXISTS (SELECT FROM pg_authid WHERE rolname='rivnu_fe_pre_runtime'
  AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
  AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
  AND rolconnlimit=10 AND rolpassword LIKE 'SCRAM-SHA-256$%'
  AND (rolvaliduntil IS NULL OR rolvaliduntil > now())
 ) THEN RAISE EXCEPTION 'Runtime must be locked, restricted and have a valid SCRAM credential'; END IF;
 IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
   WHERE r.rolname='rivnu_fe_pre_runtime') THEN
  RAISE EXCEPTION 'Runtime has unexpected role memberships';
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('rivnu_fe_pre_owner','rivnu_fe_pre_migrator')
   AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Unexpected administrative role attributes';
 END IF;
 IF NOT has_database_privilege('rivnu_fe_pre_runtime',current_database(),'CONNECT')
  OR has_database_privilege('rivnu_fe_pre_runtime',current_database(),'CREATE,TEMP')
  OR has_schema_privilege('rivnu_fe_pre_runtime','public','CREATE')
  OR has_schema_privilege('rivnu_fe_pre_runtime','fiscal_meta','CREATE')
  OR NOT has_table_privilege('rivnu_fe_pre_runtime','fiscal_meta.issuer_scope','SELECT')
  OR has_table_privilege('rivnu_fe_pre_runtime','fiscal_meta.issuer_scope','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 THEN RAISE EXCEPTION 'Runtime privileges differ from approved bootstrap'; END IF;
 IF current_setting('ssl') <> 'on' OR current_setting('ssl_cert_file') <> '/etc/corestack-postgresql-tls-2026/server.crt.pem'
 THEN RAISE EXCEPTION 'Approved TLS configuration required'; END IF;
 IF EXISTS(SELECT FROM pg_hba_file_rules WHERE error IS NOT NULL) OR EXISTS (
  SELECT FROM (VALUES
   (1,'local','rivnu_fiscal_pre','postgres',NULL::text,NULL::text,'peer'),
   (2,'local','rivnu_fiscal_pre','all',NULL,NULL,'reject'),
   (3,'local','all','rivnu_fe_pre_runtime',NULL,NULL,'reject'),
   (4,'hostssl','rivnu_fiscal_pre','rivnu_fe_pre_runtime','10.0.0.1','255.255.255.255','scram-sha-256'),
   (5,'host','all','rivnu_fe_pre_runtime','0.0.0.0','0.0.0.0','reject'),
   (6,'host','all','rivnu_fe_pre_runtime','::','::','reject'),
   (7,'host','rivnu_fiscal_pre','all','0.0.0.0','0.0.0.0','reject'),
   (8,'host','rivnu_fiscal_pre','all','::','::','reject')
  ) AS e(n,t,d,u,a,m,auth)
  LEFT JOIN pg_hba_file_rules h ON h.rule_number=e.n
  WHERE h.rule_number IS NULL OR h.type IS DISTINCT FROM e.t
   OR h.database IS DISTINCT FROM ARRAY[e.d] OR h.user_name IS DISTINCT FROM ARRAY[e.u]
   OR h.address IS DISTINCT FROM e.a OR h.netmask IS DISTINCT FROM e.m
   OR h.auth_method IS DISTINCT FROM e.auth
 ) THEN RAISE EXCEPTION 'Fiscal HBA rules changed; review before enabling LOGIN'; END IF;
END $$;
ALTER ROLE rivnu_fe_pre_runtime LOGIN;
COMMIT;
SELECT 'FISCAL_RUNTIME_LOGIN_ENABLED' AS result;
-- Remote authentication and denial tests still required. No sequences consumed.
