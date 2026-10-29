\set ON_ERROR_STOP on
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

WITH public_tables AS (
  SELECT c.oid,c.relname,c.relowner,c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
), checks AS (
 SELECT 'all_public_tables_have_rls' name, bool_and(relrowsecurity) ok, count(*)::text detail FROM public_tables
 UNION ALL SELECT 'anon_no_table_access',NOT EXISTS(SELECT 1 FROM public_tables WHERE has_table_privilege('anon',oid,'SELECT') OR has_table_privilege('anon',oid,'INSERT') OR has_table_privilege('anon',oid,'UPDATE') OR has_table_privilege('anon',oid,'DELETE')),'anon'
 UNION ALL SELECT 'authenticated_no_table_access',NOT EXISTS(SELECT 1 FROM public_tables WHERE has_table_privilege('authenticated',oid,'SELECT') OR has_table_privilege('authenticated',oid,'INSERT') OR has_table_privilege('authenticated',oid,'UPDATE') OR has_table_privilege('authenticated',oid,'DELETE')),'authenticated'
 UNION ALL SELECT 'untrusted_roles_no_schema_usage',NOT has_schema_privilege('anon','public','USAGE') AND NOT has_schema_privilege('authenticated','public','USAGE'),'public'
 UNION ALL SELECT 'untrusted_roles_no_public_function_execute',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))),'public functions'
 UNION ALL SELECT 'service_role_crud_preserved',bool_and(has_table_privilege('service_role',oid,'SELECT,INSERT,UPDATE,DELETE')),'service_role' FROM public_tables
 UNION ALL SELECT 'backend_role_can_crud',bool_and(has_table_privilege(:'backend_role',oid,'SELECT,INSERT,UPDATE,DELETE')),:'backend_role' FROM public_tables
 UNION ALL SELECT 'backend_role_rls_safe',(SELECT r.rolbypassrls OR NOT EXISTS(SELECT 1 FROM public_tables t WHERE t.relowner<>r.oid) FROM pg_roles r WHERE r.rolname=:'backend_role'),:'backend_role'
 UNION ALL SELECT 'creator_defaults_secure',NOT EXISTS(SELECT 1 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE d.defaclrole=to_regrole(:'creator_role') AND n.nspname='public' AND (x.grantee=0 OR x.grantee IN (to_regrole('anon'),to_regrole('authenticated')))),:'creator_role'
 UNION ALL SELECT 'web_product_protected',COALESCE((SELECT relrowsecurity AND NOT has_table_privilege('anon',oid,'SELECT') AND NOT has_table_privilege('authenticated',oid,'SELECT') FROM public_tables WHERE relname='WebProduct'),true),'if present'
 UNION ALL SELECT 'channel_nonce_protected',COALESCE((SELECT relrowsecurity AND NOT has_table_privilege('anon',oid,'SELECT') AND NOT has_table_privilege('authenticated',oid,'SELECT') FROM public_tables WHERE relname='ChannelNonce'),true),'if present'
)
SELECT * FROM checks ORDER BY name;

SELECT bool_and(ok) AS all_security_checks_pass
FROM (
 WITH public_tables AS (SELECT c.oid,c.relowner,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p'))
 SELECT bool_and(relrowsecurity) ok FROM public_tables
 UNION ALL SELECT NOT EXISTS(SELECT 1 FROM public_tables WHERE
   has_table_privilege('anon',oid,'SELECT') OR has_table_privilege('anon',oid,'INSERT') OR has_table_privilege('anon',oid,'UPDATE') OR has_table_privilege('anon',oid,'DELETE') OR
   has_table_privilege('authenticated',oid,'SELECT') OR has_table_privilege('authenticated',oid,'INSERT') OR has_table_privilege('authenticated',oid,'UPDATE') OR has_table_privilege('authenticated',oid,'DELETE'))
 UNION ALL SELECT NOT has_schema_privilege('anon','public','USAGE') AND NOT has_schema_privilege('authenticated','public','USAGE')
 UNION ALL SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')))
 UNION ALL SELECT bool_and(has_table_privilege(:'backend_role',oid,'SELECT,INSERT,UPDATE,DELETE')) FROM public_tables
 UNION ALL SELECT (SELECT r.rolbypassrls OR NOT EXISTS(SELECT 1 FROM public_tables t WHERE t.relowner<>r.oid) FROM pg_roles r WHERE r.rolname=:'backend_role')
 UNION ALL SELECT NOT EXISTS(SELECT 1 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE d.defaclrole=to_regrole(:'creator_role') AND n.nspname='public' AND (x.grantee=0 OR x.grantee IN (to_regrole('anon'),to_regrole('authenticated'))))
) q \gset
\if :all_security_checks_pass
  \echo 'Security verification passed'
\else
  \echo 'Security verification FAILED'
  \quit 5
\endif

