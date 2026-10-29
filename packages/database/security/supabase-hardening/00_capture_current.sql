\set ON_ERROR_STOP on
-- Solo lectura. Ejecutar con psql desde una carpeta vacía y conservar ambos archivos:
--   psql "$DIRECT_URL" -X -f 00_capture_current.sql
-- No usa tablas auxiliares ni modifica la base.

\pset format csv
\pset footer off
\o security-permissions-before.csv

SELECT 'SCHEMA' object_type, n.nspname object_name, '' arguments,
       CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END grantee,
       x.privilege_type, x.is_grantable, x.grantor::regrole::text grantor,
       NULL::boolean rls_enabled, NULL::boolean force_rls
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) x
WHERE n.nspname='public'
UNION ALL
SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
       c.relname, '', CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
       x.privilege_type, x.is_grantable, x.grantor::regrole::text,
       CASE WHEN c.relkind IN ('r','p') THEN c.relrowsecurity END,
       CASE WHEN c.relkind IN ('r','p') THEN c.relforcerowsecurity END
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE c.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) x
WHERE n.nspname='public' AND c.relkind IN ('r','p','S')
UNION ALL
SELECT 'FUNCTION',p.proname,pg_get_function_identity_arguments(p.oid),
       CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
       x.privilege_type,x.is_grantable,x.grantor::regrole::text,NULL,NULL
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
WHERE n.nspname='public'
UNION ALL
SELECT 'DEFAULT_'||CASE d.defaclobjtype WHEN 'r' THEN 'TABLE' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FUNCTION' ELSE d.defaclobjtype::text END,
       d.defaclrole::regrole::text||'@'||COALESCE(n.nspname,'*'),'',
       CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
       x.privilege_type,x.is_grantable,x.grantor::regrole::text,NULL,NULL
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) x
WHERE COALESCE(n.nspname,'public')='public'
ORDER BY 1,2,3,4,5;

\o security-restore-exact.generated.sql
\pset format unaligned
\pset tuples_only on
SELECT '-- GENERATED from the database state at '||clock_timestamp()||E'\n\\set ON_ERROR_STOP on\nBEGIN;';

SELECT format('ALTER TABLE public.%I %s ROW LEVEL SECURITY;',c.relname,CASE WHEN c.relrowsecurity THEN 'ENABLE' ELSE 'DISABLE' END)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname;

SELECT format('GRANT %s ON SCHEMA public TO %s%s;',string_agg(x.privilege_type,', ' ORDER BY x.privilege_type),
 CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
 CASE WHEN bool_or(x.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) x
WHERE n.nspname='public' AND (x.grantee=0 OR x.grantee::regrole::text IN ('anon','authenticated')) GROUP BY x.grantee;

SELECT format('GRANT %s ON TABLE public.%I TO %s%s;',string_agg(x.privilege_type,', ' ORDER BY x.privilege_type),c.relname,
 CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
 CASE WHEN bool_or(x.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (x.grantee=0 OR x.grantee::regrole::text IN ('anon','authenticated'))
GROUP BY c.relname,x.grantee ORDER BY c.relname,x.grantee;

SELECT format('GRANT %s ON SEQUENCE public.%I TO %s%s;',string_agg(x.privilege_type,', ' ORDER BY x.privilege_type),c.relname,
 CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
 CASE WHEN bool_or(x.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) x
WHERE n.nspname='public' AND c.relkind='S' AND (x.grantee=0 OR x.grantee::regrole::text IN ('anon','authenticated'))
GROUP BY c.relname,x.grantee ORDER BY c.relname,x.grantee;

SELECT format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO %s%s;',p.proname,pg_get_function_identity_arguments(p.oid),
 CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
 CASE WHEN bool_or(x.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
WHERE n.nspname='public' AND (x.grantee=0 OR x.grantee::regrole::text IN ('anon','authenticated'))
GROUP BY p.oid,p.proname,x.grantee ORDER BY p.proname,pg_get_function_identity_arguments(p.oid),x.grantee;

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT %s ON %s TO %s%s;',d.defaclrole::regrole::text,
 string_agg(x.privilege_type,', ' ORDER BY x.privilege_type),
 CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' END,
 CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
 CASE WHEN bool_or(x.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) x
WHERE n.nspname='public' AND d.defaclobjtype IN ('r','S','f') AND (x.grantee=0 OR x.grantee::regrole::text IN ('anon','authenticated'))
GROUP BY d.defaclrole,d.defaclobjtype,x.grantee ORDER BY d.defaclrole::regrole::text,d.defaclobjtype,x.grantee;

SELECT 'COMMIT;';
\o
\pset tuples_only off
\pset format aligned
\echo Wrote security-permissions-before.csv and security-restore-exact.generated.sql

