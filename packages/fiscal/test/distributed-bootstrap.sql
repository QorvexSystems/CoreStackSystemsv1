-- Disposable VM4 rehearsal ONLY. Never load into VM3 or an ERP database.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database() <> 'corestack_disposable_rehearsal' THEN RAISE EXCEPTION 'REHEARSAL_ONLY'; END IF;
END $$;
CREATE ROLE rehearsal_owner NOLOGIN;
CREATE ROLE rehearsal_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CREATE ON DATABASE corestack_disposable_rehearsal TO rehearsal_owner;
SET ROLE rehearsal_owner;
\i /fixture/001.sql
\i /fixture/002.sql
\i /fixture/003.sql
INSERT INTO corestack_fiscal.runtime_scope VALUES
 ('rehearsal_runtime','synthetic-distributed','101010641','precertification');
SELECT corestack_fiscal.register_range('synthetic-distributed','101010641','precertification',
 31::smallint,1,1000,'2026-01-01','2027-12-31','SYNTHETIC ONLY - NOT DGII');
GRANT USAGE ON SCHEMA corestack_fiscal TO rehearsal_runtime;
GRANT EXECUTE ON FUNCTION corestack_fiscal.register_request(text,text),
 corestack_fiscal.claim_preparation(), corestack_fiscal.read_preparation(bigint)
 TO rehearsal_runtime;
-- Signature-specific grants selected by function name; range/reservation functions remain denied.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='corestack_fiscal' AND p.proname IN ('complete_preparation','fail_preparation')
 LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO rehearsal_runtime',f.signature); END LOOP;
END $$;
RESET ROLE;
