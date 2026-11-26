-- SYNTHETIC PREVIEW ONLY. This file must never run in VM3.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database() <> 'corestack_preview_remote' THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF;
END $$;
CREATE ROLE preview_owner NOLOGIN;
CREATE ROLE preview_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
DO $$ BEGIN
 EXECUTE format('ALTER ROLE preview_runtime PASSWORD %L', btrim(pg_read_file('/run/preview-runtime-password'), E'\r\n '));
END $$;
GRANT CREATE ON DATABASE corestack_preview_remote TO preview_owner;
SET ROLE preview_owner;
\i /fixture/001.sql
\i /fixture/002.sql
\i /fixture/003.sql
INSERT INTO corestack_fiscal.runtime_scope VALUES
 ('preview_runtime','cmt397emm0002nm0ogb50l2q6','40220429126','precertification');
SELECT corestack_fiscal.register_range('cmt397emm0002nm0ogb50l2q6','40220429126','precertification',
 kind::smallint,1,1000000,'2026-01-01','2027-12-31','SYNTHETIC PREVIEW - NOT DGII')
 FROM unnest(ARRAY[31,32,33,34,41,43,44,45,46,47]) AS kind;
GRANT USAGE ON SCHEMA corestack_fiscal TO preview_runtime;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='corestack_fiscal' AND p.proname IN
 ('register_request','claim_preparation','complete_preparation','fail_preparation','read_preparation')
 LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO preview_runtime',f.signature); END LOOP;
END $$;
RESET ROLE;
