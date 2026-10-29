// Isolated PostgreSQL 17 test. Creates and removes one Docker container with synthetic data only.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root=resolve('.');
const security=join(root,'security/supabase-hardening');
const migrations=join(root,'prisma/migrations');
const container=`unique-security-test-${process.pid}`;
const password='local-security-test-only';
const db='security_test';
const user='backend_prisma';
const work=mkdtempSync(join(tmpdir(),'unique-security-'));
const phase1=join(work,'prisma');
const newMigrations=['web_catalog_grouping','channel_nonce','web_catalog_sku_approval'];
const run=(file,args,options={})=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options});
const docker=(...args)=>run('docker',args);
const psql=(sql,vars=[])=>{
  const r=spawnSync('docker',['exec','-i','-w','/tmp',container,'psql','-X','-qAt','-U',user,'-d',db,'-v','ON_ERROR_STOP=1',...vars.flatMap(([k,v])=>['-v',`${k}=${v}`])],{input:sql,encoding:'utf8'});
  if(r.status!==0)throw new Error(`${r.stdout}\n${r.stderr}`); return r.stdout.trim();
};
const psqlFile=(name,vars=[])=>psql(awaitImport(name),vars);
const awaitImport=(name)=>requireText(join(security,name));
const requireText=(file)=>{if(!existsSync(file))throw new Error(`Missing ${file}`);return execFileSync(process.execPath,['-e',`process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`],{encoding:'utf8'});};
const url=(port)=>`postgresql://${user}:${password}@127.0.0.1:${port}/${db}?schema=public`;
const prisma=(port,schema,...args)=>run('npx',['prisma',...args,'--schema',schema],{cwd:root,env:{...process.env,DATABASE_URL:url(port),DIRECT_URL:url(port)},shell:process.platform==='win32'});
let started=false;
try {
  docker('run','--rm','-d','--name',container,'-e',`POSTGRES_USER=${user}`,'-e',`POSTGRES_PASSWORD=${password}`,'-e',`POSTGRES_DB=${db}`,'-p','127.0.0.1::5432','postgres:17-alpine'); started=true;
  let ready=false;
  for(let i=0;i<60;i++){const r=spawnSync('docker',['exec',container,'pg_isready','-U',user,'-d',db]);if(r.status===0){ready=true;break;} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}
  assert.ok(ready,'PostgreSQL container did not become ready');
  const port=Number(JSON.parse(docker('inspect',container))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort);

  mkdirSync(join(phase1,'migrations'),{recursive:true}); cpSync(join(root,'prisma/schema.prisma'),join(phase1,'schema.prisma'));
  for(const name of readdirSync(migrations)) if(!newMigrations.some(n=>name.endsWith(`_${n}`))) cpSync(join(migrations,name),join(phase1,'migrations',name),{recursive:true});
  prisma(port,join(phase1,'schema.prisma'),'migrate','deploy');
  psql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator NOLOGIN NOINHERIT; GRANT anon,authenticated,service_role TO authenticator;
    GRANT USAGE ON SCHEMA public TO PUBLIC,anon,authenticated,service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON ALL TABLES IN SCHEMA public TO anon,authenticated,service_role;
    GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC,anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${user} IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${user} IN SCHEMA public GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${user} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;`);
  psql(`INSERT INTO "Tenant"(id,name,slug,"updatedAt") VALUES ('tenant-security','Synthetic tenant','security-test',now());
    INSERT INTO "User"(id,email,name,"passwordHash","updatedAt") VALUES ('user-security','operator@security.test','Synthetic operator','not-a-real-hash',now());
    INSERT INTO "Product"(id,"tenantId",name,sku,price,stock,"reservedStock","updatedAt") VALUES ('product-security','tenant-security','Synthetic product','SEC-001',100,5,1,now());
    INSERT INTO "InventoryMovement"(id,"tenantId","productId",type,quantity,"previousStock","newStock") VALUES ('movement-security','tenant-security','product-security','INITIAL_STOCK',5,0,5);
    INSERT INTO "SalesOrder"(id,"tenantId","orderNumber","createdById","updatedAt") VALUES ('order-security','tenant-security','ORD-SEC-1','user-security',now());
    INSERT INTO "SalesOrderItem"(id,"salesOrderId","productId",description,quantity,"unitPrice","taxRate",subtotal,total) VALUES ('order-item-security','order-security','product-security','Synthetic product',1,100,0.18,100,118);
    INSERT INTO "Invoice"(id,"tenantId","invoiceNumber","updatedAt") VALUES ('invoice-security','tenant-security','FAC-SEC-1',now());
    INSERT INTO "InvoiceItem"(id,"invoiceId","productId",description,quantity,"unitPrice","taxRate",subtotal,total) VALUES ('invoice-item-security','invoice-security','product-security','Synthetic product',1,100,0.18,100,118);`);
  assert.equal(psql(`SET ROLE anon; SELECT count(*) FROM public."Product"; RESET ROLE;`),'1');
  psqlFile('00_capture_current.sql');
  assert.equal(psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'qorvex\\_%' ESCAPE '\\';`),'14');

  psqlFile('01_harden_existing.sql',[['backend_role',user],['creator_role',user]]);
  prisma(port,join(root,'prisma/schema.prisma'),'migrate','deploy');
  psqlFile('02_protect_web_catalog.sql');
  psql(`INSERT INTO "WebProduct"(id,"tenantId","legacyEcommerceId",slug,name,options,"publicationIntent","updatedAt") VALUES ('web-security','tenant-security','UP-SEC-1','security-product','Security product','[]','active',now());
    INSERT INTO "ChannelNonce"(id,"keyId",nonce,"expiresAt") VALUES ('nonce-security','security-test','seed-nonce',now()+interval '1 hour');`);
  psqlFile('03_verify.sql',[['backend_role',user],['creator_role',user]]);

  for(const role of ['anon','authenticated']){
    const denied=spawnSync('docker',['exec','-i',container,'psql','-X','-U',user,'-d',db,'-v','ON_ERROR_STOP=1'],{input:`SET ROLE ${role}; SELECT * FROM public."Product";`,encoding:'utf8'});
    assert.notEqual(denied.status,0,`${role} unexpectedly read Product`); assert.match(denied.stderr,/permission denied/);
    const deniedNew=spawnSync('docker',['exec','-i',container,'psql','-X','-U',user,'-d',db,'-v','ON_ERROR_STOP=1'],{input:`SET ROLE ${role}; SELECT * FROM public."WebProduct";`,encoding:'utf8'});
    assert.notEqual(deniedNew.status,0,`${role} unexpectedly read WebProduct`);
  }
  assert.equal(psql(`SET ROLE service_role; SELECT count(*) FROM public."Product"; RESET ROLE;`),'1');
  assert.equal(psql(`SELECT count(*) FROM (VALUES ('WebProduct'),('ChannelNonce')) v(n) WHERE to_regclass('public."'||v.n||'"') IS NOT NULL;`),'2');
  assert.equal(psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'qorvex\\_%' ESCAPE '\\' AND has_function_privilege('anon',p.oid,'EXECUTE');`),'0');
  assert.equal(psql(`SELECT public.qorvex_assert_credit_approval('missing'),public.qorvex_assert_receipt_differences('missing');`),'|');

  prisma(port,join(root,'prisma/schema.prisma'),'generate');
  const probe=run('npx',['tsx','security/supabase-hardening/prisma-probe.ts'],{cwd:root,env:{...process.env,DATABASE_URL:url(port),DIRECT_URL:url(port)},shell:process.platform==='win32'});
  const result=JSON.parse(probe.trim()); assert.equal(result.prismaCrud,'PASS'); assert.equal(result.customAuthRead,'PASS');

  // Validate the exact generated rollback, then re-harden and validate the prepared fallback.
  const generatedRollback=docker('exec',container,'cat','/tmp/security-restore-exact.generated.sql');
  psql(generatedRollback);
  assert.equal(psql(`SET ROLE anon; SELECT count(*) FROM public."Product"; RESET ROLE;`),'1');
  let futureDenied=spawnSync('docker',['exec','-i',container,'psql','-X','-U',user,'-d',db,'-v','ON_ERROR_STOP=1'],{input:`SET ROLE anon; SELECT * FROM public."WebProduct";`,encoding:'utf8'});
  assert.notEqual(futureDenied.status,0);
  psqlFile('01_harden_existing.sql',[['backend_role',user],['creator_role',user]]);

  psqlFile('04_restore_known_remote.sql',[['creator_role',user]]);
  assert.equal(psql(`SET ROLE anon; SELECT count(*) FROM public."Product"; RESET ROLE;`),'1');
  const stillDenied=spawnSync('docker',['exec','-i',container,'psql','-X','-U',user,'-d',db,'-v','ON_ERROR_STOP=1'],{input:`SET ROLE anon; SELECT * FROM public."WebProduct";`,encoding:'utf8'});
  assert.notEqual(stillDenied.status,0);
  console.log(JSON.stringify({postgres:'17',oldMigrations:'PASS',newMigrations:3,rlsAndGrants:'PASS',anonDenied:'PASS',authenticatedDenied:'PASS',serviceRolePreserved:'PASS',prisma:'PASS',customAuthentication:'PASS',productsOrdersInvoicesInventory:'PASS',webProductAndChannelNonce:'PASS',qorvexFunctions:'PASS',generatedExactRollback:'PASS',knownRemoteRollback:'PASS',realDataUsed:false},null,2));
} finally {
  rmSync(work,{recursive:true,force:true});
  if(started) spawnSync('docker',['rm','-f',container],{stdio:'ignore'});
}

