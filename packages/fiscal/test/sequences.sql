\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE t smallint; a text; b text; failed boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[31,32,33,34,41,43,44,45,46,47]::smallint[] LOOP
    PERFORM corestack_fiscal.register_range('test','101010632','certification',t,
      9999999998,9999999999,'2026-01-01','2026-12-31','SYNTHETIC');
    a := corestack_fiscal.reserve_encf('test','101010632','certification',t,
      'first-'||t,repeat('a',64),'2026-09-20');
    b := corestack_fiscal.reserve_encf('test','101010632','certification',t,
      'first-'||t,repeat('a',64),'2026-09-20');
    IF a <> 'E'||t||'9999999998' OR a <> b THEN RAISE EXCEPTION 'Reservation/retry failed'; END IF;
    b := corestack_fiscal.reserve_encf('test','101010632','certification',t,
      'last-'||t,repeat('b',64),'2026-09-20');
    IF b <> 'E'||t||'9999999999' THEN RAISE EXCEPTION 'Max sequence failed'; END IF;
    failed := false;
    BEGIN
      PERFORM corestack_fiscal.reserve_encf('test','101010632','certification',t,'exhausted-'||t,repeat('a',64),'2026-09-20');
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Exhaustion not enforced'; END IF;
    failed := false;
    BEGIN
      PERFORM corestack_fiscal.reserve_encf('test','101010632','certification',t,'first-'||t,repeat('c',64),'2026-09-20');
    EXCEPTION WHEN raise_exception THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Changed payload accepted'; END IF;
  END LOOP;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.register_range('test','101010632','certification',31::smallint,9999999999,9999999999,
      '2027-01-01','2027-12-31','OVERLAP');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Overlap accepted'; END IF;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.reserve_encf('test','101010632','production',31::smallint,'prod',repeat('a',64),'2026-09-20');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Production must be disabled'; END IF;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.reserve_encf('other','101010632','certification',31::smallint,'first-31',repeat('a',64),'2026-09-20');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Cross-tenant reservation'; END IF;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.reserve_encf('test','101010641','certification',31::smallint,'first-31',repeat('a',64),'2026-09-20');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Cross-RNC reservation'; END IF;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.reserve_encf('test','101010632','certification',32::smallint,'first-31',repeat('a',64),'2026-09-20');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Type changed during retry'; END IF;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.reserve_encf('test','101010632','certification',31::smallint,'first-31',repeat('a',64),'2026-09-21');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Date changed during retry'; END IF;
  PERFORM corestack_fiscal.register_range('test','101010632','precertification',31::smallint,1,10,'2026-01-01','2026-12-31','OTHER-ENV');
  a := corestack_fiscal.reserve_encf('test','101010632','precertification',31::smallint,'first-31',repeat('a',64),'2026-09-20');
  IF a <> 'E310000000001' THEN RAISE EXCEPTION 'Environment isolation failed'; END IF;
  failed := false;
  BEGIN
    PERFORM corestack_fiscal.reserve_encf('test','101010632','precertification',31::smallint,'expired',repeat('a',64),'2027-01-01');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Expiry ignored'; END IF;
END;
$$;
ROLLBACK;
