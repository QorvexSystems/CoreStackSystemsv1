\set ON_ERROR_STOP on
-- Run locally as postgres only after the same SCRAM password is stored on VM4.
BEGIN;
SET LOCAL statement_timeout='10s';
DO $$
BEGIN
 IF current_database()<>'rivnu_fiscal_prod' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'Use local postgres administrator in rivnu_fiscal_prod';
 END IF;
 IF (SELECT count(*) FROM fiscal_meta.issuer_scope)<>1 OR NOT EXISTS(
  SELECT FROM fiscal_meta.issuer_scope WHERE singleton
   AND tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126'
   AND environment='production'
 ) THEN RAISE EXCEPTION 'Unexpected production issuer scope'; END IF;
 IF NOT EXISTS(
  SELECT FROM pg_authid WHERE rolname='rivnu_fe_prod_range'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
   AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit=4
   AND rolpassword LIKE 'SCRAM-SHA-256$%'
   AND (rolvaliduntil IS NULL OR rolvaliduntil>now())
 ) THEN RAISE EXCEPTION 'Range role must be locked, restricted and have SCRAM'; END IF;
 IF EXISTS(
  SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
  WHERE r.rolname='rivnu_fe_prod_range'
 ) THEN RAISE EXCEPTION 'Range role has unexpected memberships'; END IF;
 IF NOT has_database_privilege('rivnu_fe_prod_range',current_database(),'CONNECT')
  OR has_database_privilege('rivnu_fe_prod_range',current_database(),'CREATE,TEMP')
  OR NOT has_schema_privilege('rivnu_fe_prod_range','fiscal_meta','USAGE')
  OR NOT has_schema_privilege('rivnu_fe_prod_range','corestack_fiscal','USAGE')
  OR NOT has_table_privilege('rivnu_fe_prod_range','fiscal_meta.issuer_scope','SELECT')
  OR has_table_privilege('rivnu_fe_prod_range','corestack_fiscal.sequence_range','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR NOT has_function_privilege('rivnu_fe_prod_range','corestack_fiscal.register_authorized_range(text,text,text,smallint,bigint,bigint,bigint,text,date,date)','EXECUTE')
 THEN RAISE EXCEPTION 'Range role privileges differ from approved state'; END IF;
 IF current_setting('ssl')<>'on' OR EXISTS(SELECT FROM pg_hba_file_rules WHERE error IS NOT NULL)
 THEN RAISE EXCEPTION 'TLS/HBA verification failed'; END IF;
 IF NOT EXISTS(
  SELECT FROM pg_hba_file_rules WHERE type='hostssl'
   AND database=ARRAY['rivnu_fiscal_prod'] AND user_name=ARRAY['rivnu_fe_prod_range']
   AND address='10.0.0.1' AND netmask='255.255.255.255' AND auth_method='scram-sha-256'
 ) THEN RAISE EXCEPTION 'Exact VM4 HBA rule missing'; END IF;
END $$;
ALTER ROLE rivnu_fe_prod_range LOGIN;
COMMIT;
SELECT 'RIVNU_FISCAL_PRODUCTION_RANGE_LOGIN_ENABLED' AS result;
-- Remote TLS, identity and denial tests remain mandatory.
