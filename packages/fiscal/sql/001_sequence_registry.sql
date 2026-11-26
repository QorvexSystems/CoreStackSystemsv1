-- Standalone fiscal database migration. NOT part of the ERP production migrations.
-- Apply only to a dedicated test database until runtime ownership/permissions are reviewed.
BEGIN;
CREATE SCHEMA corestack_fiscal;
REVOKE ALL ON SCHEMA corestack_fiscal FROM PUBLIC;

CREATE TABLE corestack_fiscal.sequence_range (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(btrim(tenant_id)) BETWEEN 1 AND 200),
  issuer_rnc text NOT NULL CHECK (issuer_rnc ~ '^([0-9]{9}|[0-9]{11})$'),
  environment text NOT NULL CHECK (environment IN ('precertification', 'certification')),
  ecf_type smallint NOT NULL CHECK (ecf_type IN (31,32,33,34,41,43,44,45,46,47)),
  first_number bigint NOT NULL CHECK (first_number BETWEEN 1 AND 9999999999),
  last_number bigint NOT NULL CHECK (last_number BETWEEN first_number AND 9999999999),
  next_number bigint CHECK (next_number BETWEEN first_number AND last_number),
  valid_from date NOT NULL,
  valid_until date CHECK (valid_until >= valid_from),
  authorization_reference text NOT NULL CHECK (length(btrim(authorization_reference)) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sequence_range_scope ON corestack_fiscal.sequence_range
  (tenant_id, issuer_rnc, environment, ecf_type, first_number);

CREATE TABLE corestack_fiscal.sequence_reservation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  range_id bigint NOT NULL REFERENCES corestack_fiscal.sequence_range(id),
  tenant_id text NOT NULL,
  issuer_rnc text NOT NULL,
  environment text NOT NULL,
  ecf_type smallint NOT NULL,
  operation_id text NOT NULL CHECK (length(btrim(operation_id)) BETWEEN 1 AND 200),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  encf text NOT NULL CHECK (encf ~ '^E[0-9]{12}$'),
  business_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, issuer_rnc, environment, operation_id),
  UNIQUE (tenant_id, issuer_rnc, environment, encf)
);

-- Shared advisory lock serializes range insertion and reservation within each fiscal scope.
-- Hash collisions only serialize unrelated scopes; they cannot grant access or mix records.
CREATE FUNCTION corestack_fiscal.register_range(
  p_tenant text, p_rnc text, p_environment text, p_type smallint,
  p_first bigint, p_last bigint, p_valid_from date, p_valid_until date, p_authorization text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, corestack_fiscal AS $$
DECLARE new_id bigint;
BEGIN
  IF p_tenant IS NULL OR btrim(p_tenant) = '' OR p_rnc IS NULL OR p_environment IS NULL
     OR p_environment NOT IN ('precertification', 'certification') THEN
    RAISE EXCEPTION 'Explicit non-production fiscal scope required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_tenant,p_rnc,p_environment)::text, 0));
  IF EXISTS (SELECT 1 FROM corestack_fiscal.sequence_range
    WHERE tenant_id=p_tenant AND issuer_rnc=p_rnc AND environment=p_environment AND ecf_type=p_type
      AND first_number <= p_last AND last_number >= p_first) THEN
    RAISE EXCEPTION 'Overlapping e-NCF authorization';
  END IF;
  INSERT INTO corestack_fiscal.sequence_range
    (tenant_id,issuer_rnc,environment,ecf_type,first_number,last_number,next_number,
     valid_from,valid_until,authorization_reference)
    VALUES (p_tenant,p_rnc,p_environment,p_type,p_first,p_last,p_first,p_valid_from,p_valid_until,p_authorization)
    RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE FUNCTION corestack_fiscal.reserve_encf(
  p_tenant text, p_rnc text, p_environment text, p_type smallint,
  p_operation text, p_payload_sha256 text, p_business_date date
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, corestack_fiscal AS $$
DECLARE
  previous corestack_fiscal.sequence_reservation%ROWTYPE;
  selected corestack_fiscal.sequence_range%ROWTYPE;
  result text;
BEGIN
  IF p_tenant IS NULL OR btrim(p_tenant) = '' OR p_rnc IS NULL OR p_environment IS NULL
     OR p_environment NOT IN ('precertification', 'certification') OR p_type IS NULL
     OR p_operation IS NULL OR btrim(p_operation) = '' OR p_business_date IS NULL
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid reservation request or production disabled';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_tenant,p_rnc,p_environment)::text, 0));
  SELECT * INTO previous FROM corestack_fiscal.sequence_reservation
    WHERE tenant_id=p_tenant AND issuer_rnc=p_rnc AND environment=p_environment AND operation_id=p_operation;
  IF FOUND THEN
    IF previous.ecf_type <> p_type OR previous.payload_sha256 <> p_payload_sha256
       OR previous.business_date <> p_business_date THEN
      RAISE EXCEPTION 'Idempotency conflict: operation data changed';
    END IF;
    RETURN previous.encf;
  END IF;
  SELECT * INTO selected FROM corestack_fiscal.sequence_range
    WHERE tenant_id=p_tenant AND issuer_rnc=p_rnc AND environment=p_environment AND ecf_type=p_type
      AND next_number IS NOT NULL AND valid_from <= p_business_date
      AND (valid_until IS NULL OR valid_until >= p_business_date)
    ORDER BY first_number, id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No usable authorized e-NCF range'; END IF;
  result := 'E' || p_type::text || lpad(selected.next_number::text, 10, '0');
  UPDATE corestack_fiscal.sequence_range SET next_number = CASE
    WHEN selected.next_number = selected.last_number THEN NULL ELSE selected.next_number + 1 END
    WHERE id = selected.id;
  INSERT INTO corestack_fiscal.sequence_reservation
    (range_id,tenant_id,issuer_rnc,environment,ecf_type,operation_id,payload_sha256,encf,business_date)
    VALUES (selected.id,p_tenant,p_rnc,p_environment,p_type,p_operation,p_payload_sha256,result,p_business_date);
  RETURN result;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA corestack_fiscal FROM PUBLIC;
-- A future runtime role receives only schema USAGE + reserve_encf EXECUTE, never table DML.
-- register_range is an administrative operation. Scope must come from authenticated context.
COMMIT;
