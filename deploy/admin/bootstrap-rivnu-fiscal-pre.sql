\set ON_ERROR_STOP on
-- Initial infrastructure only. Run by local PostgreSQL administrator.
-- No e-NCF ranges, invoice data, passwords or ERP modifications.
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_database WHERE datname='rivnu_fiscal_pre')
 OR EXISTS (SELECT FROM pg_roles WHERE rolname IN
 ('rivnu_fe_pre_owner','rivnu_fe_pre_migrator','rivnu_fe_pre_runtime')) THEN
   RAISE EXCEPTION 'Fiscal database/roles already exist; inspect, do not overwrite';
 END IF;
END $$;
BEGIN;
CREATE ROLE rivnu_fe_pre_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rivnu_fe_pre_migrator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rivnu_fe_pre_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
GRANT rivnu_fe_pre_owner TO rivnu_fe_pre_migrator WITH INHERIT FALSE;
COMMIT;
-- CREATE DATABASE cannot run inside a transaction. Failures retain NOLOGIN roles.
CREATE DATABASE rivnu_fiscal_pre OWNER rivnu_fe_pre_owner TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE rivnu_fiscal_pre FROM PUBLIC;
GRANT CONNECT ON DATABASE rivnu_fiscal_pre TO rivnu_fe_pre_migrator, rivnu_fe_pre_runtime;
ALTER ROLE rivnu_fe_pre_runtime IN DATABASE rivnu_fiscal_pre SET search_path = pg_catalog;
ALTER ROLE rivnu_fe_pre_runtime IN DATABASE rivnu_fiscal_pre SET statement_timeout = '30s';
ALTER ROLE rivnu_fe_pre_runtime IN DATABASE rivnu_fiscal_pre SET idle_in_transaction_session_timeout = '30s';
\connect rivnu_fiscal_pre
BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SET LOCAL ROLE rivnu_fe_pre_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;
CREATE SCHEMA fiscal_meta AUTHORIZATION rivnu_fe_pre_owner;
REVOKE ALL ON SCHEMA fiscal_meta FROM PUBLIC;
CREATE TABLE fiscal_meta.issuer_scope (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 tenant_id text NOT NULL CHECK(tenant_id='cmt397emm0002nm0ogb50l2q6'),
 issuer_rnc text NOT NULL CHECK(issuer_rnc='40220429126'),
 environment text NOT NULL CHECK(environment='precertification'),
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fiscal_meta.issuer_scope(singleton,tenant_id,issuer_rnc,environment)
 VALUES(true,'cmt397emm0002nm0ogb50l2q6','40220429126','precertification');
GRANT USAGE ON SCHEMA fiscal_meta TO rivnu_fe_pre_runtime;
GRANT SELECT ON fiscal_meta.issuer_scope TO rivnu_fe_pre_runtime;
COMMIT;
SELECT 'FISCAL_DATABASE_CREATED_RUNTIME_NOLOGIN' AS result;
