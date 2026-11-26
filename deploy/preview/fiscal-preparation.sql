\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'rivnu_dgii_preview' THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS corestack_preview_ecf;
CREATE TABLE corestack_preview_ecf.preparation (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id text NOT NULL REFERENCES public."Tenant"(id),
 order_id text NOT NULL REFERENCES public."SalesOrder"(id),
 revision text NOT NULL,
 snapshot jsonb NOT NULL,
 planned_at text NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','DONE','FAILED')),
 result jsonb,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,order_id,revision)
);
CREATE FUNCTION corestack_preview_ecf.immutable_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.order_id,NEW.revision,NEW.snapshot,NEW.planned_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.order_id,OLD.revision,OLD.snapshot,OLD.planned_at,OLD.created_at)
 OR OLD.state IN ('DONE','FAILED') THEN RAISE EXCEPTION 'IMMUTABLE_PREVIEW_PREPARATION'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preparation_immutable BEFORE UPDATE ON corestack_preview_ecf.preparation
 FOR EACH ROW EXECUTE FUNCTION corestack_preview_ecf.immutable_preparation();
REVOKE ALL ON SCHEMA corestack_preview_ecf FROM PUBLIC;
COMMIT;
