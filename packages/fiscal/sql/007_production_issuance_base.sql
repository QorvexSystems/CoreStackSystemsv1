-- Production issuance foundation installed after 006_production_authorized_ranges.sql.
-- Request/preparation/signing/delivery tables are installed by migrations 002-005.
-- Runtime identities receive EXECUTE only; direct table DML remains forbidden.
BEGIN;

-- 006 created this as an unnamed inline multi-column CHECK. PostgreSQL names
-- that form sequence_range_checkN, so resolve it by the constrained column
-- instead of assuming a generated name.
DO $$
DECLARE existing_name name;
DECLARE matching_count integer;
BEGIN
  SELECT count(*),min(constraint_row.conname::text)::name
    INTO matching_count,existing_name
  FROM (
    SELECT DISTINCT constraint_entry.conname
    FROM pg_constraint constraint_entry
    JOIN pg_attribute attribute_entry
      ON attribute_entry.attrelid=constraint_entry.conrelid
     AND attribute_entry.attnum=ANY(constraint_entry.conkey)
    WHERE constraint_entry.conrelid='corestack_fiscal.sequence_range'::regclass
      AND constraint_entry.contype='c'
      AND attribute_entry.attname='next_number'
  ) constraint_row;
  IF matching_count<>1 OR existing_name IS NULL THEN
    RAISE EXCEPTION 'expected exactly one next_number check constraint';
  END IF;
  EXECUTE format(
    'ALTER TABLE corestack_fiscal.sequence_range DROP CONSTRAINT %I',
    existing_name
  );
END $$;

ALTER TABLE corestack_fiscal.sequence_range
  ALTER COLUMN next_number DROP NOT NULL,
  ADD CONSTRAINT sequence_range_next_number_check
    CHECK(next_number IS NULL OR next_number BETWEEN first_number AND last_number);

CREATE TABLE corestack_fiscal.sequence_reservation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  range_id bigint NOT NULL REFERENCES corestack_fiscal.sequence_range(id),
  tenant_id text NOT NULL,
  issuer_rnc text NOT NULL,
  environment text NOT NULL CHECK(environment='production'),
  ecf_type smallint NOT NULL,
  operation_id text NOT NULL CHECK(length(btrim(operation_id)) BETWEEN 1 AND 200),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  encf text NOT NULL CHECK(encf ~ '^E[0-9]{12}$'),
  business_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,issuer_rnc,environment,operation_id),
  UNIQUE(tenant_id,issuer_rnc,environment,encf)
);

CREATE FUNCTION corestack_fiscal.reserve_encf(
  p_tenant text,p_rnc text,p_environment text,p_type smallint,
  p_operation text,p_payload_sha256 text,p_business_date date
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE previous corestack_fiscal.sequence_reservation%ROWTYPE;
DECLARE selected corestack_fiscal.sequence_range%ROWTYPE;
DECLARE result text;
BEGIN
  IF p_environment<>'production' OR p_tenant IS NULL OR btrim(p_tenant)=''
     OR p_rnc!~'^([0-9]{9}|[0-9]{11})$'
     OR p_type NOT IN (31,32,33,34,41,43,44,45,46,47)
     OR p_operation IS NULL OR btrim(p_operation)=''
     OR p_payload_sha256!~'^[a-f0-9]{64}$' OR p_business_date IS NULL
  THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid reservation request'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array(p_tenant,p_rnc,p_environment)::text,0)
  );
  SELECT * INTO previous FROM corestack_fiscal.sequence_reservation
   WHERE tenant_id=p_tenant AND issuer_rnc=p_rnc AND environment=p_environment
     AND operation_id=p_operation;
  IF FOUND THEN
    IF previous.ecf_type<>p_type OR previous.payload_sha256<>p_payload_sha256
       OR previous.business_date<>p_business_date
    THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='idempotency conflict'; END IF;
    RETURN previous.encf;
  END IF;

  SELECT * INTO selected FROM corestack_fiscal.sequence_range
   WHERE tenant_id=p_tenant AND issuer_rnc=p_rnc AND environment='production'
     AND ecf_type=p_type AND next_number IS NOT NULL
     AND (authorized_at IS NULL OR authorized_at<=p_business_date)
     AND (valid_until IS NULL OR valid_until>=p_business_date)
   ORDER BY first_number,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='no usable authorized e-NCF range';
  END IF;

  result:='E'||p_type::text||lpad(selected.next_number::text,10,'0');
  UPDATE corestack_fiscal.sequence_range
   SET next_number=CASE WHEN selected.next_number=selected.last_number
                        THEN NULL ELSE selected.next_number+1 END
   WHERE id=selected.id;
  INSERT INTO corestack_fiscal.sequence_reservation(
    range_id,tenant_id,issuer_rnc,environment,ecf_type,operation_id,
    payload_sha256,encf,business_date
  ) VALUES(
    selected.id,p_tenant,p_rnc,'production',p_type,p_operation,
    p_payload_sha256,result,p_business_date
  );
  RETURN result;
END $$;

CREATE FUNCTION corestack_fiscal.read_authorized_ranges() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,corestack_fiscal,fiscal_meta AS $$
DECLARE binding fiscal_meta.range_registration_identity%ROWTYPE;
DECLARE result jsonb;
BEGIN
  SELECT * INTO binding FROM fiscal_meta.range_registration_identity
   WHERE login_role=session_user;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unbound identity'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'rangeId',r.id::text,
    'registrationId',r.registration_id,
    'ecfType',r.ecf_type,
    'startNumber',r.first_number::text,
    'endNumber',r.last_number::text,
    'nextNumber',CASE WHEN r.next_number IS NULL THEN NULL ELSE r.next_number::text END,
    'remaining',CASE WHEN r.next_number IS NULL THEN '0'
                     ELSE (r.last_number-r.next_number+1)::text END,
    'used',(r.last_number-r.first_number+1-
      CASE WHEN r.next_number IS NULL THEN 0 ELSE r.last_number-r.next_number+1 END)::text,
    'authorizationNumber',r.authorization_reference,
    'authorizedAt',r.authorized_at,
    'validUntil',r.valid_until,
    'exhausted',r.next_number IS NULL
  ) ORDER BY r.ecf_type,r.first_number,r.id),'[]'::jsonb)
  INTO result FROM corestack_fiscal.sequence_range r
   WHERE (r.tenant_id,r.issuer_rnc,r.environment)=
         (binding.tenant_id,binding.issuer_rnc,binding.environment);
  RETURN result;
END $$;

REVOKE ALL ON corestack_fiscal.sequence_reservation FROM PUBLIC;
REVOKE ALL ON SEQUENCE corestack_fiscal.sequence_reservation_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.reserve_encf(text,text,text,smallint,text,text,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.read_authorized_ranges() FROM PUBLIC;
COMMIT;
