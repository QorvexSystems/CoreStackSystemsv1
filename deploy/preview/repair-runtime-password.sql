\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database() <> 'corestack_preview_remote' THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF;
 EXECUTE format('ALTER ROLE preview_runtime PASSWORD %L', btrim(pg_read_file('/run/preview-runtime-password'), E'\r\n '));
END $$;
