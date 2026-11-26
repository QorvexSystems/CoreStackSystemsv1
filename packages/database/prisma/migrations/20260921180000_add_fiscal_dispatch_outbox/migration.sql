-- ERP-side transport queue. Not the fiscal VM3 schema and not an e-NCF sequence.
-- Deliberately SQL-managed; accessed through parameterized statements, not Prisma models.
BEGIN;
CREATE SCHEMA corestack_erp_fiscal;
REVOKE ALL ON SCHEMA corestack_erp_fiscal FROM PUBLIC;
CREATE TABLE corestack_erp_fiscal.dispatch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public."Tenant"(id) ON DELETE RESTRICT,
  invoice_id text NOT NULL REFERENCES public."Invoice"(id) ON DELETE RESTRICT,
  issuer_rnc text NOT NULL CHECK (issuer_rnc ~ '^([0-9]{9}|[0-9]{11})$'),
  environment text NOT NULL CHECK (environment IN ('precertification','certification')),
  operation_id text NOT NULL,
  request_text text NOT NULL CHECK (octet_length(request_text) BETWEEN 1 AND 524288),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','REGISTERED','REVIEW_REQUIRED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  document_id text,
  encf text,
  last_error text CHECK (last_error IN ('UNCONFIRMED','REJECTED','INVALID_SNAPSHOT','ATTEMPTS_EXHAUSTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, issuer_rnc, environment, operation_id),
  UNIQUE (tenant_id, environment, invoice_id),
  CHECK ((state = 'RUNNING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'REGISTERED') = (document_id IS NOT NULL AND encf IS NOT NULL))
);
CREATE INDEX dispatch_due ON corestack_erp_fiscal.dispatch (tenant_id, issuer_rnc, environment, next_attempt_at, id)
  WHERE state IN ('PENDING','RUNNING');

CREATE FUNCTION corestack_erp_fiscal.protect_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'FISCAL_DISPATCH_EVIDENCE_IMMUTABLE';
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.invoice_id,NEW.issuer_rnc,NEW.environment,
    NEW.operation_id,NEW.request_text,NEW.payload_sha256,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.invoice_id,OLD.issuer_rnc,OLD.environment,
    OLD.operation_id,OLD.request_text,OLD.payload_sha256,OLD.created_at) THEN
    RAISE EXCEPTION 'FISCAL_DISPATCH_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD.state IN ('REGISTERED','REVIEW_REQUIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'FISCAL_DISPATCH_TERMINAL';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION corestack_erp_fiscal.protect_dispatch() FROM PUBLIC;
CREATE TRIGGER dispatch_immutable BEFORE UPDATE OR DELETE ON corestack_erp_fiscal.dispatch
 FOR EACH ROW EXECUTE FUNCTION corestack_erp_fiscal.protect_dispatch();
CREATE TRIGGER dispatch_no_truncate BEFORE TRUNCATE ON corestack_erp_fiscal.dispatch
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_erp_fiscal.protect_dispatch();
REVOKE ALL ON ALL TABLES IN SCHEMA corestack_erp_fiscal FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA corestack_erp_fiscal FROM PUBLIC;
-- Runtime grants are intentionally a deployment review step, not PUBLIC grants.
COMMIT;
