BEGIN;
ALTER TABLE corestack_erp_fiscal.dispatch
  DROP CONSTRAINT dispatch_environment_check,
  ADD CONSTRAINT dispatch_environment_check
    CHECK(environment IN ('precertification','certification','production'));
COMMIT;
