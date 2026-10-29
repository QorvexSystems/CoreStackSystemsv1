\set ON_ERROR_STOP on
-- Required: psql -v backend_role=postgres -v creator_role=postgres -f 01_harden_existing.sql
-- This is intentionally NOT executed by Prisma migrations or application startup.
\if :{?backend_role}
\else
  \echo 'backend_role is required'
  \quit 2
\endif
\if :{?creator_role}
\else
  \echo 'creator_role is required'
  \quit 2
\endif

SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=:'backend_role') AS backend_exists,
       EXISTS(SELECT 1 FROM pg_roles WHERE rolname=:'creator_role') AS creator_exists \gset
\if :backend_exists
\else
  \echo 'backend_role does not exist'
  \quit 3
\endif
\if :creator_exists
\else
  \echo 'creator_role does not exist'
  \quit 3
\endif

-- RLS without policies preserves a direct Prisma role only when it owns every table or bypasses RLS.
SELECT (r.rolbypassrls OR NOT EXISTS(
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner<>r.oid
)) AS backend_rls_safe
FROM pg_roles r WHERE r.rolname=:'backend_role' \gset
\if :backend_rls_safe
\else
  \echo 'ABORT: backend role neither BYPASSRLS nor owner of every public table'
  \quit 4
\endif

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';

REVOKE USAGE ON SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

SELECT format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
ORDER BY c.relname \gexec

-- Only the role that creates Prisma application objects is changed. Supabase internal role defaults are untouched.
ALTER DEFAULT PRIVILEGES FOR ROLE :"creator_role" IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE :"creator_role" IN SCHEMA public
  REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE :"creator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

COMMIT;

