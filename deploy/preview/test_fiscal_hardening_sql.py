"""Actual worker SQL against disposable PostgreSQL; no production connections.

Run on VM2: python3 -B deploy/preview/test_fiscal_hardening_sql.py
Only the container created by this test is stopped/removed in tearDownClass.
"""
import concurrent.futures
import csv
import io
from pathlib import Path
import re
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / 'apps/api/src/modules/fiscal-sequences/electronic-fiscal-dispatch.service.ts'


class DispatchSQL(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = 'rivnu-fiscal-hardening-qa-' + uuid.uuid4().hex[:12]
        result = subprocess.run(['docker','run','--rm','-d','--pull','never','--name',cls.name,
            '--network','none','--read-only','--user','postgres','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--memory','256m','--pids-limit','64',
            '--tmpfs','/var/lib/postgresql/data:rw,uid=70,gid=70,mode=700,size=128m',
            '--tmpfs','/var/run/postgresql:rw,uid=70,gid=70,mode=700,size=4m',
            '--tmpfs','/tmp:rw,mode=1777,size=4m','-e','POSTGRES_HOST_AUTH_METHOD=trust',
            'postgres:17-alpine'],capture_output=True,text=True,timeout=30)
        if result.returncode:
            raise RuntimeError('SYNTHETIC_POSTGRES_START_FAILED')
        for _ in range(50):
            # The entrypoint first runs a temporary Unix-socket-only server.
            # Wait for its final TCP listener, not that transient init phase.
            ready = subprocess.run(['docker','exec',cls.name,'pg_isready','-h','127.0.0.1','-U','postgres'],
                                   capture_output=True,timeout=5)
            if ready.returncode == 0:
                return
            time.sleep(.1)
        subprocess.run(['docker','stop','--time','2',cls.name],capture_output=True,timeout=10)
        raise RuntimeError('SYNTHETIC_POSTGRES_NOT_READY')

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker','stop','--time','2',cls.name],capture_output=True,timeout=15)

    def sql(self, sql, database=None):
        result = subprocess.run(['docker','exec','-i',self.name,'psql','-X','-q','--csv',
            '-U','postgres','-d',database or self.database,'-v','ON_ERROR_STOP=1'],
            input=sql,capture_output=True,text=True,timeout=15)
        if result.returncode:
            raise RuntimeError('SYNTHETIC_SQL_FAILED: ' + result.stderr)
        return list(csv.DictReader(io.StringIO(result.stdout))) if result.stdout.strip() else []

    def setUp(self):
        self.database = 'test_' + uuid.uuid4().hex[:12]
        self.sql('CREATE DATABASE ' + self.database, 'postgres')
        self.sql('''CREATE TABLE public."Tenant"(id text PRIMARY KEY);
          CREATE TABLE public."Invoice"(id text PRIMARY KEY,"tenantId" text NOT NULL,
            "fiscalStatus" text NOT NULL,"eNcf" text);
          INSERT INTO public."Tenant" VALUES ('synthetic-tenant');''')
        self.sql((ROOT/'packages/database/prisma/migrations/20260921180000_add_fiscal_dispatch_outbox/migration.sql').read_text())
        self.sql((ROOT/'packages/database/prisma/migrations/20261102023000_enable_production_fiscal_dispatch/migration.sql').read_text())

    def worker_sql(self, method):
        source = WORKER.read_text().split('private async '+method+'(',1)[1]
        return re.search(r'\$queryRaw(?:<[\s\S]*?>)?`([\s\S]*?)`',source)[1]

    def seed(self, number, state='PENDING', attempts=0, expired=False):
        registered = state == 'REGISTERED'
        running = state == 'RUNNING'
        lease = "'00000000-0000-4000-8000-000000000001'::uuid" if running else 'NULL'
        until = "clock_timestamp()-interval '1 second'" if expired else "clock_timestamp()+interval '120 seconds'"
        until = until if running else 'NULL'
        document = str(number) if registered else None
        encf = 'E31'+str(number).zfill(10) if registered else None
        def literal(value):
            return 'NULL' if value is None else "'"+value+"'"
        self.sql(f'''INSERT INTO public."Invoice" VALUES('invoice-{number}','synthetic-tenant','PENDING_SIGNATURE',{literal(encf)});
          INSERT INTO corestack_erp_fiscal.dispatch
            (tenant_id,invoice_id,issuer_rnc,environment,operation_id,request_text,payload_sha256,
             state,attempts,lease_token,lease_until,document_id,encf)
          VALUES('synthetic-tenant','invoice-{number}','101010632','production','operation-{number}','{{}}',
            repeat('a',64),'{state}',{attempts},{lease},{until},{literal(document)},{literal(encf)});''')

    def test_concurrent_claims_never_claim_the_same_live_lease(self):
        self.seed(1);self.seed(2)
        query = self.worker_sql('claim')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.sql(query),range(8)))
        claimed = [row['id'] for rows in results for row in rows]
        self.assertEqual(sorted(claimed),['1','2'])

    def test_expired_final_attempt_is_closed_without_rewriting_evidence(self):
        self.seed(1,'RUNNING',10,True)
        query = self.worker_sql('expireAbandonedLease')
        self.assertEqual(self.sql(query)[0]['invoiceId'],'invoice-1')
        row = self.sql('SELECT state,attempts,request_text,payload_sha256,lease_token FROM corestack_erp_fiscal.dispatch')[0]
        self.assertEqual(row['state'],'REVIEW_REQUIRED')
        self.assertEqual(row['attempts'],'10');self.assertEqual(row['request_text'],'{}')
        self.assertEqual(row['payload_sha256'],'a'*64);self.assertEqual(row['lease_token'],'')
        self.assertEqual(self.sql(query),[])
        with self.assertRaises(RuntimeError):
            self.sql("UPDATE corestack_erp_fiscal.dispatch SET request_text='changed' WHERE id=1")

    def test_reconciliation_cursor_fairly_wraps_all_pending_documents(self):
        for number in range(1,4):
            self.seed(number,'REGISTERED')
        template = self.worker_sql('reconcileOne')
        observed = []
        for cursor in [0,1,2,3]:
            rows = self.sql(template.replace('${this.reconcileCursor}',str(cursor)))
            observed.append(rows[0]['id'])
        self.assertEqual(observed,['1','2','3','1'])

    def test_reconciliation_batch_is_bounded_and_does_not_starve_the_tail(self):
        for number in range(1,10):
            self.seed(number,'REGISTERED')
        template = self.worker_sql('reconcileOne')
        first = self.sql(template.replace('${this.reconcileCursor}','0'))
        second = self.sql(template.replace('${this.reconcileCursor}',first[-1]['id']))
        third = self.sql(template.replace('${this.reconcileCursor}',second[-1]['id']))
        self.assertEqual([r['id'] for r in first],['1','2','3','4'])
        self.assertEqual([r['id'] for r in second],['5','6','7','8'])
        self.assertEqual([r['id'] for r in third],['9','1','2','3'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
