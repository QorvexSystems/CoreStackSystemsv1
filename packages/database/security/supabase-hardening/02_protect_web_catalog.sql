\set ON_ERROR_STOP on
-- Run only after the three additive web-catalog migrations exist.
SELECT to_regclass('public."WebProduct"') IS NOT NULL AS web_product_exists,
       to_regclass('public."ChannelNonce"') IS NOT NULL AS channel_nonce_exists \gset
\if :web_product_exists
\else
  \echo 'WebProduct does not exist; aborting'
  \quit 3
\endif
\if :channel_nonce_exists
\else
  \echo 'ChannelNonce does not exist; aborting'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public."WebProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChannelNonce" ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public."WebProduct", public."ChannelNonce" FROM anon, authenticated;
COMMIT;

