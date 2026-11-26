\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database()<>'rivnu_dgii_preview' THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF;
END $$;
ALTER TABLE corestack_preview_ecf.preparation
 ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 10),
 ADD COLUMN recovery_after timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX preview_remote_recovery ON corestack_preview_ecf.preparation(recovery_after,id)
 WHERE execution_mode='REMOTE_VM4' AND state='PENDING' AND recovery_attempts<10;
COMMIT;
