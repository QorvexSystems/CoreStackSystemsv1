// ENSAYO de migración en PostgreSQL LOCAL (contenedor Docker de pruebas). No usa Supabase ni credenciales reales.
// Variables obligatorias (credenciales locales de prueba, nunca las reales):
//   REHEARSAL_PG_CONTAINER  nombre del contenedor PostgreSQL de pruebas
//   REHEARSAL_PG_URL_BASE   p. ej. postgresql://USUARIO:CLAVE@127.0.0.1:PUERTO  (el host debe ser local)
//   1. Historial completo desde cero (solo migraciones previas) y datos históricos SINTÉTICOS representativos.
//   2. Aplicación de las migraciones nuevas sobre esa base con datos: los datos históricos deben quedar idénticos.
//   3. Importación de los 174 grupos / 312 variantes, idempotencia y colisión con un producto antiguo (aborta sin escribir).
//   4. Recuperación ante una migración fallida (objeto preexistente) con `migrate resolve`.
// Uso (desde packages/database):  node rehearsal/run.mjs --catalog=<catalog.normalized.json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CONTAINER = process.env.REHEARSAL_PG_CONTAINER;
const URL_BASE = process.env.REHEARSAL_PG_URL_BASE;
if (!CONTAINER || !URL_BASE) throw new Error("Define REHEARSAL_PG_CONTAINER y REHEARSAL_PG_URL_BASE (base local de pruebas).");
const base = new URL(URL_BASE);
if (!["127.0.0.1", "localhost"].includes(base.hostname)) throw new Error("El ensayo solo corre contra PostgreSQL local.");
const PG_USER = decodeURIComponent(base.username);
const NEW_MIGRATIONS = ["web_catalog_grouping", "channel_nonce", "web_catalog_sku_approval"];
const arg = (n) => process.argv.find((a) => a.startsWith(`${n}=`))?.slice(n.length + 1);
const catalog = arg("--catalog");
if (!catalog) throw new Error("Indica --catalog=<ruta a catalog.normalized.json>.");
const root = resolve(".");
const migrationsDir = join(root, "prisma/migrations");
const ok = (m) => console.log(`  PASS ${m}`);
const step = (n) => console.log(`\n== ${n}`);

const psql = (db, q) => execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", PG_USER, "-d", db, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const admin = (q) => psql("postgres", q);
const urlFor = (db) => `${URL_BASE.replace(/\/+$/, "")}/${db}`;
function prisma(db, schema, ...args) {
  return execFileSync("npx", ["prisma", ...args, "--schema", schema], { env: { ...process.env, DATABASE_URL: urlFor(db), DIRECT_URL: urlFor(db) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
}
function prismaTry(db, schema, ...args) {
  try { return { ok: true, out: prisma(db, schema, ...args) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}
const recreate = (db) => { admin(`drop database if exists ${db} with (force)`); admin(`create database ${db}`); };

// Esquema "previo": el mismo schema.prisma con solo las migraciones anteriores a la integración (migrate deploy no compara el esquema).
const work = mkdtempSync(join(tmpdir(), "rehearsal-"));
const phase1 = join(work, "prisma");
mkdirSync(join(phase1, "migrations"), { recursive: true });
cpSync(join(root, "prisma/schema.prisma"), join(phase1, "schema.prisma"));
for (const name of readdirSync(migrationsDir)) {
  if (NEW_MIGRATIONS.some((n) => name.endsWith(`_${n}`))) continue;
  cpSync(join(migrationsDir, name), join(phase1, "migrations", name), { recursive: true });
}
const phase2Schema = join(root, "prisma/schema.prisma");
const oldCount = readdirSync(join(phase1, "migrations")).filter((n) => /^\d/.test(n)).length;

const SEED = `
insert into "Tenant"(id,name,slug,"updatedAt") values ('t-hist','Unique Personalizado (ensayo)','unique-personalizado',now());
insert into "User"(id,email,name,"updatedAt") values ('u-hist','hist@ensayo.local','Histórico (sintético)',now());
insert into "Customer"(id,"tenantId",name,"documentType","updatedAt") values ('c-hist','t-hist','Cliente histórico sintético','CONSUMER_FINAL',now());
insert into "Product"(id,"tenantId",name,sku,price,stock,"reservedStock",status,"updatedAt") values
 ('p-old-1','t-hist','Producto antiguo 1','OLD-001',1000,10,2,'ACTIVE',now()),
 ('p-old-2','t-hist','Producto antiguo 2','OLD-002',2500,6,0,'ACTIVE',now()),
 ('p-old-3','t-hist','Producto antiguo 3','OLD-003',800,3,0,'ACTIVE',now());
insert into "InventoryMovement"(id,"tenantId","productId",type,quantity,"newStock") values
 ('m1','t-hist','p-old-1','INITIAL_STOCK',12,12),('m2','t-hist','p-old-2','INITIAL_STOCK',6,6),('m3','t-hist','p-old-3','INITIAL_STOCK',3,3),('m4','t-hist','p-old-1','OUTBOUND',2,10);
insert into "SalesOrder"(id,"tenantId","orderNumber","createdById","updatedAt") values ('o-hist','t-hist','ORD-HIST-1','u-hist',now());
insert into "SalesOrderItem"(id,"salesOrderId","productId",description,quantity,"unitPrice","taxRate",subtotal,total) values ('oi-hist','o-hist','p-old-1','Producto antiguo 1',2,1000,0.18,2000,2360);
insert into "Invoice"(id,"tenantId","invoiceNumber","updatedAt") values ('i-hist','t-hist','FAC-HIST-1',now());
insert into "InvoiceItem"(id,"invoiceId","productId",description,quantity,"unitPrice","taxRate",subtotal,total) values ('ii-hist','i-hist','p-old-2','Producto antiguo 2',1,2500,0.18,2500,2950);
`;

// Huella por tabla usando solo las columnas que existían ANTES de las migraciones nuevas.
function checksums(db, columnsByTable) {
  const out = {};
  for (const [table, cols] of Object.entries(columnsByTable)) {
    const list = cols.map((c) => `"${c}"`).join(",");
    out[table] = psql(db, `select count(*)||':'||coalesce(md5(string_agg(row(${list})::text,'|' order by row(${list})::text)),'-') from "${table}"`);
  }
  return out;
}
const tablesAndColumns = (db) => {
  const rows = psql(db, `select table_name||'.'||column_name from information_schema.columns where table_schema='public' and table_name not like '\\_%' order by table_name, ordinal_position`).split("\n");
  return rows.reduce((m, r) => { const [t, c] = r.split("."); (m[t] ??= []).push(c); return m; }, {});
};

try {
  step("1. Historial desde cero (solo migraciones previas) + datos históricos sintéticos");
  recreate("unique_erp_rehearsal_test");
  prisma("unique_erp_rehearsal_test", join(phase1, "schema.prisma"), "migrate", "deploy");
  assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from _prisma_migrations where finished_at is not null`), String(oldCount));
  ok(`${oldCount} migraciones previas aplicadas desde cero`);
  psql("unique_erp_rehearsal_test", SEED);
  assert.equal(psql("unique_erp_rehearsal_test", `select sum(stock)||'/'||sum("reservedStock") from "Product"`), "19/2");
  const before = tablesAndColumns("unique_erp_rehearsal_test");
  const sumsBefore = checksums("unique_erp_rehearsal_test", before);
  ok(`datos históricos: 3 productos antiguos (19 unidades, 2 reservadas), 4 movimientos, 1 orden, 1 factura; huellas de ${Object.keys(before).length} tablas`);

  step("2. Aplicar las migraciones nuevas sobre la base con datos");
  prisma("unique_erp_rehearsal_test", phase2Schema, "migrate", "deploy");
  assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null`), "0");
  ok("migraciones nuevas aplicadas sin errores");
  const sumsAfter = checksums("unique_erp_rehearsal_test", before);
  assert.deepEqual(sumsAfter, sumsBefore);
  ok(`los datos históricos de ${Object.keys(before).length} tablas son idénticos (mismas columnas previas): órdenes, facturas, movimientos, reservas y productos antiguos intactos`);
  const drift = execFileSync("npx", ["prisma", "migrate", "diff", "--from-url", urlFor("unique_erp_rehearsal_test"), "--to-schema-datamodel", phase2Schema, "--script"], { env: { ...process.env, DATABASE_URL: urlFor("unique_erp_rehearsal_test"), DIRECT_URL: urlFor("unique_erp_rehearsal_test") }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  assert.match(drift, /empty migration/i);
  ok("el esquema resultante coincide exactamente con schema.prisma (sin deriva)");
  assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from "Product" where "webProductId" is not null or "skuApprovedAt" is not null`), "0");
  ok("los productos antiguos no quedaron vinculados a ningún grupo web ni con SKU aprobado");

  step("3. Importación de 174 grupos / 312 variantes y sus verificaciones");
  const importEnv = { ...process.env, DATABASE_URL: urlFor("unique_erp_rehearsal_test"), DIRECT_URL: urlFor("unique_erp_rehearsal_test"), WEB_CATALOG_IMPORT_ISOLATED: "I_UNDERSTAND_THIS_IS_NOT_THE_REAL_DATABASE" };
  const runImport = (extra = []) => execFileSync("npx", ["tsx", "src/web-catalog-import/cli.ts", `--catalog=${catalog}`, "--mode=isolated", "--out=.tmp/rehearsal", ...extra], { env: importEnv, encoding: "utf8", shell: process.platform === "win32" }).match(/"status": "(\w+)"/)[1];
  assert.equal(runImport(), "APPLIED");
  const counts = psql("unique_erp_rehearsal_test", `select (select count(*) from "WebProduct")||'/'||(select count(*) from "Product" where "webProductId" is not null)||'/'||(select count(*) from "Product")`);
  assert.equal(counts, "174/312/315");
  ok("174 grupos, 312 variantes y 315 productos en total (3 antiguos + 312 nuevos)");
  assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from "Product" where "skuApprovedAt" is not null`), "122");
  ok("solo los 122 SKU originales sin cambio nacen aprobados; los 190 candidatos quedan pendientes de aprobación");
  assert.equal(runImport(), "NO_CHANGES");
  ok("segunda ejecución: NO_CHANGES (idempotente)");
  const sumsAfterImport = checksums("unique_erp_rehearsal_test", before);
  for (const t of ["Invoice", "InvoiceItem", "SalesOrder", "SalesOrderItem", "InventoryMovement", "Customer", "User", "Tenant"]) assert.equal(sumsAfterImport[t], sumsBefore[t], t);
  assert.equal(psql("unique_erp_rehearsal_test", `select string_agg(id||':'||stock||'/'||"reservedStock"||'/'||status,',' order by id) from "Product" where id like 'p-old-%'`), "p-old-1:10/2/ACTIVE,p-old-2:6/0/ACTIVE,p-old-3:3/0/ACTIVE");
  assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from "InventoryMovement"`) + psql("unique_erp_rehearsal_test", `select count(*) from "InventorySyncJob"`), "40");
  ok("tras importar: órdenes, facturas, movimientos y reservas idénticos; los 3 productos antiguos conservan existencias (19) y estado; 0 movimientos nuevos y 0 InventorySyncJob");

  step("4. Colisión con un producto antiguo y recuperación");
  psql("unique_erp_rehearsal_test", `insert into "Tenant"(id,name,slug,"updatedAt") values ('t-coll','Tenant con colisión','coll-tenant',now()); insert into "Product"(id,"tenantId",name,sku,price,"updatedAt") values ('p-coll','t-coll','Antiguo con SKU candidato','UP-0002-01',10,now())`);
  const bad = execFileSync("npx", ["tsx", "src/web-catalog-import/cli.ts", `--catalog=${catalog}`, "--mode=isolated", "--tenant=coll-tenant", "--out=.tmp/rehearsal-coll"], { env: importEnv, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] }).toString();
  void bad;
} catch (error) {
  if (error.status === 1 && /ABORTED_CONFLICTS/.test(`${error.stdout}`)) {
    assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from "WebProduct" where "tenantId"='t-coll'`), "0");
    assert.equal(psql("unique_erp_rehearsal_test", `select count(*) from "Product" where "tenantId"='t-coll'`), "1");
    ok("un SKU antiguo que coincide con un candidato aborta la importación (ABORTED_CONFLICTS) sin escribir nada; el producto antiguo no se toca");
    await recovery();
  } else {
    throw error;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

async function recovery() {
  step("5. Migración fallida y recuperación");
  recreate("unique_erp_rehearsal2_test");
  prisma("unique_erp_rehearsal2_test", join(phase1, "schema.prisma"), "migrate", "deploy");
  psql("unique_erp_rehearsal2_test", `create table "WebProduct"(id text)`); // objeto preexistente que hace fallar la migración
  const failed = prismaTry("unique_erp_rehearsal2_test", phase2Schema, "migrate", "deploy");
  assert.equal(failed.ok, false);
  assert.match(failed.out, /web_catalog_grouping/);
  assert.equal(psql("unique_erp_rehearsal2_test", `select count(*) from pg_type where typname='WebAvailabilityPolicy'`), "0");
  assert.equal(psql("unique_erp_rehearsal2_test", `select count(*) from information_schema.columns where table_name='Product' and column_name in ('webProductId','webOptions','legacyEcommerceVariantId')`), "0");
  assert.equal(psql("unique_erp_rehearsal2_test", `select to_regclass('"ChannelNonce"') is null`), "t");
  ok("la migración fallida no dejó nada a medias (sin enum, sin columnas nuevas) y las siguientes no se aplicaron");
  psql("unique_erp_rehearsal2_test", `drop table "WebProduct"`);
  const name = readdirSync(migrationsDir).find((n) => n.endsWith("_web_catalog_grouping"));
  prisma("unique_erp_rehearsal2_test", phase2Schema, "migrate", "resolve", "--rolled-back", name);
  prisma("unique_erp_rehearsal2_test", phase2Schema, "migrate", "deploy");
  assert.equal(psql("unique_erp_rehearsal2_test", `select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null`), String(oldCount + NEW_MIGRATIONS.length));
  ok("tras retirar el objeto conflictivo: `migrate resolve --rolled-back` + `migrate deploy` completan las 3 migraciones nuevas");
  console.log("\nRESULTADO: ensayo de migración superado");
  admin("drop database if exists unique_erp_rehearsal2_test with (force)");
}
void existsSync; void writeFileSync;
