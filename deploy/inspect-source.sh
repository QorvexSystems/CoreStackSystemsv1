#!/bin/sh
set -eu

conn=$(sed -n 's/^DIRECT_URL="\([^"]*\)".*/\1/p' /run/source.env | head -n 1)
if [ -z "$conn" ]; then
  conn=$(sed -n 's/^DIRECT_URL=\([^#[:space:]]*\).*/\1/p' /run/source.env | head -n 1)
fi
if [ -z "$conn" ]; then
  echo 'DIRECT_URL no está presente en el archivo fuente' >&2
  exit 1
fi

export PGCONNECT_TIMEOUT=12 PGSSLMODE=require
psql "$conn" -X -v ON_ERROR_STOP=1 -At <<'SQL'
BEGIN READ ONLY;
SELECT 'database', current_database(), current_setting('server_version');
SELECT 'tenant', slug, name FROM public."Tenant" ORDER BY slug;
SELECT 'counts',
  (SELECT count(*) FROM public."User"),
  (SELECT count(*) FROM public."HotelRoom"),
  (SELECT count(*) FROM public."HotelGuest"),
  (SELECT count(*) FROM public."HotelReservation"),
  (SELECT count(*) FROM public."_prisma_migrations");
SELECT 'barbershop_accounts', count(*) FROM public."User"
  WHERE lower(email) IN (
    'admin@barbershop.local',
    'barbero1@barbershop.local',
    'barbero2@barbershop.local',
    'contador@barbershop.local'
  );
SELECT 'hotel_accounts', count(*) FROM public."User"
  WHERE lower(email) IN (
    'admin@hotelancla.local',
    'recepcion@hotelancla.local',
    'contador@hotelancla.local'
  );
SELECT 'migration_status',
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)
FROM public."_prisma_migrations";
COMMIT;
SQL
