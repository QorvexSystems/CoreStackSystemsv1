BEGIN;
DO $$ BEGIN IF current_database()<>'rivnu_dgii_preview' THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF; END $$;
CREATE TABLE corestack_preview_ecf.rehearsal (
 preparation_id bigint PRIMARY KEY REFERENCES corestack_preview_ecf.preparation(id),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 terminal boolean NOT NULL DEFAULT false,
 result jsonb,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMIT;
