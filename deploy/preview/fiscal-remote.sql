\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'rivnu_dgii_preview' THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF;
END $$;
ALTER TABLE corestack_preview_ecf.preparation
 ADD COLUMN execution_mode text NOT NULL DEFAULT 'LOCAL' CHECK(execution_mode IN ('LOCAL','REMOTE_VM4')),
 ADD COLUMN remote_ack jsonb;
CREATE OR REPLACE FUNCTION corestack_preview_ecf.immutable_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.order_id,NEW.revision,NEW.snapshot,NEW.planned_at,NEW.created_at,NEW.execution_mode)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.order_id,OLD.revision,OLD.snapshot,OLD.planned_at,OLD.created_at,OLD.execution_mode)
 OR OLD.state IN ('DONE','FAILED')
 OR (OLD.remote_ack IS NOT NULL AND NEW.remote_ack IS DISTINCT FROM OLD.remote_ack)
 THEN RAISE EXCEPTION 'IMMUTABLE_PREVIEW_PREPARATION'; END IF;
 RETURN NEW;
END $$;
COMMIT;
