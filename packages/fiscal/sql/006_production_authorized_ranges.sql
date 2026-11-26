-- Production-only fiscal range registry. Install in a dedicated, empty fiscal
-- production database after creating its NOLOGIN owner/migrator identities.
-- Scope and runtime identity rows are provisioned separately and explicitly.
BEGIN;

CREATE SCHEMA fiscal_meta;
CREATE SCHEMA corestack_fiscal;
REVOKE ALL ON SCHEMA fiscal_meta,corestack_fiscal FROM PUBLIC;

CREATE TABLE fiscal_meta.issuer_scope (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  tenant_id text NOT NULL CHECK(length(btrim(tenant_id)) BETWEEN 1 AND 200),
  issuer_rnc text NOT NULL CHECK(issuer_rnc ~ '^([0-9]{9}|[0-9]{11})$'),
  environment text NOT NULL CHECK(environment='production')
);

CREATE TABLE fiscal_meta.range_registration_identity (
  login_role name PRIMARY KEY,
  tenant_id text NOT NULL,
  issuer_rnc text NOT NULL,
  environment text NOT NULL CHECK(environment='production')
);

CREATE TABLE corestack_fiscal.sequence_range (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id text NOT NULL UNIQUE CHECK(registration_id ~ '^[a-z0-9]{20,32}$'),
  tenant_id text NOT NULL,
  issuer_rnc text NOT NULL,
  environment text NOT NULL CHECK(environment='production'),
  ecf_type smallint NOT NULL CHECK(ecf_type IN (31,32,33,34,41,43,44,45,46,47)),
  first_number bigint NOT NULL CHECK(first_number BETWEEN 1 AND 9999999999),
  last_number bigint NOT NULL CHECK(last_number BETWEEN first_number AND 9999999999),
  next_number bigint NOT NULL CHECK(next_number BETWEEN first_number AND last_number),
  authorization_reference text NOT NULL CHECK(length(btrim(authorization_reference)) BETWEEN 1 AND 120),
  authorized_at date,
  valid_until date CHECK(valid_until IS NULL OR authorized_at IS NULL OR valid_until>=authorized_at),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sequence_range_scope ON corestack_fiscal.sequence_range
  (tenant_id,issuer_rnc,environment,ecf_type,first_number);

CREATE TABLE corestack_fiscal.range_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  range_id bigint NOT NULL REFERENCES corestack_fiscal.sequence_range(id),
  event_type text NOT NULL CHECK(event_type='REGISTERED'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TYPE corestack_fiscal.authorized_range_result AS (range_id bigint,reused boolean);

CREATE FUNCTION corestack_fiscal.register_authorized_range(
  p_registration text,p_tenant text,p_rnc text,p_type smallint,
  p_first bigint,p_last bigint,p_next bigint,p_authorization text,
  p_authorized_at date,p_valid_until date
) RETURNS corestack_fiscal.authorized_range_result
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,corestack_fiscal,fiscal_meta AS $$
DECLARE identity_row fiscal_meta.range_registration_identity%ROWTYPE;
DECLARE previous corestack_fiscal.sequence_range%ROWTYPE;
DECLARE new_id bigint;
BEGIN
  SELECT * INTO identity_row FROM fiscal_meta.range_registration_identity WHERE login_role=session_user;
  IF NOT FOUND OR identity_row.tenant_id<>p_tenant OR identity_row.issuer_rnc<>p_rnc
     OR identity_row.environment<>'production' THEN
    RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='scope mismatch';
  END IF;
  IF p_registration!~'^[a-z0-9]{20,32}$' OR p_type NOT IN (31,32,33,34,41,43,44,45,46,47)
     OR p_first<1 OR p_last>9999999999 OR p_first>p_last OR p_next<p_first OR p_next>p_last
     OR length(btrim(p_authorization)) NOT BETWEEN 1 AND 120
     OR (p_valid_until IS NOT NULL AND p_authorized_at IS NOT NULL AND p_valid_until<p_authorized_at)
     THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid authorized range'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_tenant,p_rnc,'production',p_type)::text,0));
  SELECT * INTO previous FROM corestack_fiscal.sequence_range WHERE registration_id=p_registration;
  IF FOUND THEN
    IF (previous.tenant_id,previous.issuer_rnc,previous.ecf_type,previous.first_number,
        previous.last_number,previous.next_number,previous.authorization_reference,
        previous.authorized_at,previous.valid_until)
       IS DISTINCT FROM (p_tenant,p_rnc,p_type,p_first,p_last,p_next,p_authorization,p_authorized_at,p_valid_until)
       THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='idempotency conflict'; END IF;
    RETURN (previous.id,true);
  END IF;
  IF EXISTS(SELECT 1 FROM corestack_fiscal.sequence_range WHERE tenant_id=p_tenant AND issuer_rnc=p_rnc
    AND environment='production' AND ecf_type=p_type AND first_number<=p_last AND last_number>=p_first)
    THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='overlapping authorized range'; END IF;
  INSERT INTO corestack_fiscal.sequence_range(registration_id,tenant_id,issuer_rnc,environment,
    ecf_type,first_number,last_number,next_number,authorization_reference,authorized_at,valid_until)
  VALUES(p_registration,p_tenant,p_rnc,'production',p_type,p_first,p_last,p_next,p_authorization,p_authorized_at,p_valid_until)
  RETURNING id INTO new_id;
  INSERT INTO corestack_fiscal.range_event(range_id,event_type) VALUES(new_id,'REGISTERED');
  RETURN (new_id,false);
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA fiscal_meta,corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA corestack_fiscal FROM PUBLIC;
COMMIT;
