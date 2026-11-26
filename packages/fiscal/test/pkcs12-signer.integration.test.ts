// Synthetic PKI only. Exercises the production adapter without RIVNU material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import {
  createPkcs12XmlSigner,
  unsignedXmlFromGeneratedSignature,
  xmlWithoutInsignificantWhitespace,
} from '../src/pkcs12-signer.ts';
import { createPkcs12FiscalSigning } from '../src/pkcs12-fiscal-signing.ts';
import { verifyIncomingSignedXml } from '../src/receiver-xml-verifier.ts';
import { element, serializeXml } from '../src/xml.ts';
import { fixture, replaceField } from './fixtures.ts';
import { analyzeFiscalRequest, mapFiscalRequest } from '../src/mapper.ts';
import { preparePrintedRepresentation } from '../src/printed-representation.ts';

const execute = promisify(execFile);
async function openssl(args: string[]) {
  await execute('openssl', args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
}

test('PKCS12 signer validates scope/chain/CRL, signs exact enveloped XML and fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pkcs12-signer-integration-'));
  const ca = join(directory, 'ca');
  const scope = {
    tenantId: 'synthetic-pkcs12-test',
    issuerRnc: '101010632',
    environment: 'precertification' as const,
  };
  try {
    await execute('mkdir', ['-p', join(ca, 'newcerts')]);
    await writeFile(join(ca, 'index.txt'), '', { mode: 0o600 });
    await writeFile(join(ca, 'serial'), '1000\n', { mode: 0o600 });
    await writeFile(join(ca, 'crlnumber'), '1000\n', { mode: 0o600 });
    const rootKey = join(directory, 'root.key'), root = join(directory, 'root.pem');
    const subKey = join(directory, 'sub.key'), subCsr = join(directory, 'sub.csr'), sub = join(directory, 'sub.pem');
    const leafKey = join(directory, 'leaf.key'), leafCsr = join(directory, 'leaf.csr'), leaf = join(directory, 'leaf.pem');
    const password = join(directory, 'password'), p12 = join(directory, 'identity.p12');
    const crl = join(directory, 'sub.crl.pem');
    const receiverTrust = join(directory, 'receiver-trust.pem');
    await openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=SYNTHETIC ROOT',
      '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',rootKey,'-out',root]);
    await openssl(['req','-newkey','rsa:2048','-nodes','-subj','/CN=SYNTHETIC SUBORDINATE','-keyout',subKey,'-out',subCsr]);
    await writeFile(join(directory,'sub.ext'),'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',{mode:0o600});
    await openssl(['x509','-req','-in',subCsr,'-CA',root,'-CAkey',rootKey,'-CAcreateserial','-days','2',
      '-extfile',join(directory,'sub.ext'),'-out',sub]);
    const caConfig = `[ca]\ndefault_ca=local\n[local]\ndatabase=${join(ca,'index.txt')}\nnew_certs_dir=${join(ca,'newcerts')}\ncertificate=${sub}\nprivate_key=${subKey}\nserial=${join(ca,'serial')}\ncrlnumber=${join(ca,'crlnumber')}\ndefault_md=sha256\ndefault_days=1\ndefault_crl_days=1\npolicy=policy\nx509_extensions=leaf\n[policy]\ncommonName=supplied\nserialNumber=supplied\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`;
    const config = join(directory, 'openssl.cnf');
    await writeFile(config, caConfig, { mode: 0o600 });
    await openssl(['req','-newkey','rsa:2048','-nodes','-subj',`/CN=SYNTHETIC SIGNER/serialNumber=IDCDO-${scope.issuerRnc}`,
      '-keyout',leafKey,'-out',leafCsr]);
    await openssl(['ca','-batch','-config',config,'-in',leafCsr,'-out',leaf]);
    await openssl(['ca','-gencrl','-config',config,'-out',crl]);
    await writeFile(receiverTrust, `${await readFile(root, 'utf8')}\n${await readFile(sub, 'utf8')}`, { mode: 0o400 });
    await writeFile(password, 'synthetic-password', { mode: 0o400 });
    await openssl(['pkcs12','-export','-inkey',leafKey,'-in',leaf,'-certfile',sub,'-out',p12,
      '-passout',`file:${password}`,'-legacy']);
    await chmod(p12,0o400);
    const fingerprint=createHash('sha256').update(new X509Certificate(await readFile(leaf)).raw).digest('hex');
    const signer=await createPkcs12XmlSigner({scope,p12Path:p12,passwordPath:password,
      rootCertificatePath:root,subordinateCertificatePath:sub,crlPath:crl,
      expectedCertificateSha256:fingerprint,workRoot:directory});
    try {
      const unsigned='<?xml version="1.0" encoding="utf-8"?><SemillaModel><valor>synthetic-only</valor><Fecha>2026-10-05T12:00:00Z</Fecha></SemillaModel>';
      const signed=await signer.sign(unsigned);
      assert.match(signed,/<SignatureValue>/);
      assert.match(signed,/rsa-sha256/);
      assert.equal((await signer.verify(signed)).sha256,createHash('sha256').update(signed).digest('hex'));
      const incoming = await verifyIncomingSignedXml(signed, receiverTrust);
      assert.equal(incoming.actorRnc, scope.issuerRnc);
      assert.equal(incoming.unsignedXml, unsigned);
      const pinnedIncoming = await verifyIncomingSignedXml(signed, receiverTrust, fingerprint);
      assert.equal(pinnedIncoming.certificateSha256, fingerprint);
      await assert.rejects(
        verifyIncomingSignedXml(signed, receiverTrust, '0'.repeat(64)),
        /INCOMING_CERTIFICATE_FINGERPRINT_MISMATCH/,
      );
      await assert.rejects(
        verifyIncomingSignedXml(signed.replace('synthetic-only', 'tampered'), receiverTrust, fingerprint),
        /INCOMING_SIGNATURE_INVALID/,
      );
      await assert.rejects(signer.verify(signed.replace('synthetic-only','tampered')),/SIGNER_COMMAND_FAILED/);
      await assert.rejects(signer.sign(unsigned.replace('</SemillaModel>','<Signature>fake<\/Signature></SemillaModel>')),/SIGNING_INPUT_REJECTED/);

      const indented = `<?xml version="1.0" encoding="utf-8"?>
<SemillaModel>
  <valor>synthetic "quoted" O'Brien value with spaces</valor>
  <Fecha>2026-10-05T12:00:00Z</Fecha>
</SemillaModel>`;
      const normalized = xmlWithoutInsignificantWhitespace(indented);
      assert.equal(
        normalized,
        '<?xml version="1.0" encoding="utf-8"?><SemillaModel><valor>synthetic "quoted" O\'Brien value with spaces</valor><Fecha>2026-10-05T12:00:00Z</Fecha></SemillaModel>',
      );
      const signedIndented = await signer.sign(indented);
      assert.equal(unsignedXmlFromGeneratedSignature(signedIndented), normalized);
      assert.doesNotMatch(signedIndented, /<\/valor>\s+<Fecha>/);
      await signer.verify(signedIndented);
    } finally { await signer.close(); }
    await assert.rejects(createPkcs12XmlSigner({scope:{...scope,environment:'production'},p12Path:p12,passwordPath:password,
      rootCertificatePath:root,subordinateCertificatePath:sub,crlPath:crl,expectedCertificateSha256:fingerprint}),/PRODUCTION_ACTIVATION_REQUIRED/);
    await assert.rejects(createPkcs12XmlSigner({scope:{...scope,issuerRnc:'101010641'},p12Path:p12,passwordPath:password,
      rootCertificatePath:root,subordinateCertificatePath:sub,crlPath:crl,expectedCertificateSha256:fingerprint}),/SIGNER_CERTIFICATE_SCOPE_MISMATCH/);
    await assert.rejects(createPkcs12XmlSigner({scope,p12Path:p12,passwordPath:password,
      rootCertificatePath:root,subordinateCertificatePath:sub,crlPath:crl,expectedCertificateSha256:'0'.repeat(64)}),/SIGNER_CERTIFICATE_FINGERPRINT_MISMATCH/);

    const fiscal = await createPkcs12FiscalSigning({scope,p12Path:p12,passwordPath:password,
      rootCertificatePath:root,subordinateCertificatePath:sub,crlPath:crl,
      expectedCertificateSha256:fingerprint,workRoot:directory});
    try {
      const dgiiFormattedSeed = `<?xml version="1.0" encoding="UTF-8"?>
<SemillaModel>
  <valor>synthetic-dgii-seed</valor>
  <fecha>2026-10-05T12:00:00Z</fecha>
</SemillaModel>`;
      const signedSeed = await fiscal.signSeed(dgiiFormattedSeed);
      const seedEvidence = await fiscal.verify(scope, 'SEMILLA', signedSeed);
      assert.equal(seedEvidence.actorRnc, scope.issuerRnc);
      assert.equal(seedEvidence.sha256, createHash('sha256').update(signedSeed).digest('hex'));

      const e31 = serializeXml(element('ECF', fixture(31)));
      const signed31 = await fiscal.signing.signEcf(scope, e31);
      const evidence31 = await fiscal.verify(scope, 'ECF', signed31);
      assert.equal(evidence31.actorRnc, scope.issuerRnc);
      assert.equal(evidence31.encf, 'E310000000001');
      const bundle31 = await fiscal.bundle(scope, {
        unsignedEcfXml: e31, signedEcfXml: signed31, submissionXml: signed31, route: 'ECF',
      });
      assert.equal(bundle31.sourceSha256, createHash('sha256').update(e31).digest('hex'));
      assert.equal((await fiscal.printVerify(scope, {unsignedXml:e31,signedXml:signed31})).securityCode.length, 6);

      const unicodeE31 = serializeXml(element(
        'ECF',
        replaceField(fixture(31), 'RazonSocialEmisor', 'STARLIN ANTONIO RIVAS NUÑEZ'),
      ));
      const signedUnicodeE31 = await fiscal.signing.signEcf(scope, unicodeE31);
      assert.equal((await fiscal.verify(scope, 'ECF', signedUnicodeE31)).encf, 'E310000000001');

      const e32Sections = fixture(32);
      const header = e32Sections[0]!;
      e32Sections[0] = element('Encabezado', (header.value as ReturnType<typeof element>[]).map((node) =>
        node.name === 'Totales'
          ? element('Totales', [element('MontoExento', '100.00'), element('MontoTotal', '100.00')])
          : node));
      const e32 = serializeXml(element('ECF', e32Sections));
      const signed32 = await fiscal.signing.signEcf(scope, e32);
      const signedRfce = await fiscal.signing.signConsumptionSummary(scope, e32, signed32);
      const bundle32 = await fiscal.bundle(scope, {
        unsignedEcfXml: e32, signedEcfXml: signed32, submissionXml: signedRfce, route: 'RFCE',
      });
      assert.equal(bundle32.ecf.encf, 'E320000000001');
      assert.equal(bundle32.submission.encf, 'E320000000001');
      await assert.rejects(fiscal.bundle(scope, {
        unsignedEcfXml: e32.replace('100.00', '100.01'), signedEcfXml: signed32,
        submissionXml: signedRfce, route: 'RFCE',
      }), /SIGNED_SOURCE_MISMATCH/);

      // Production-shaped E32 regression: consumer final without identity,
      // taxed low-value card sale, RFCE and printed representation.
      const consumerRequest = {
          version: '1',
          operationId: 'consumer-e32-rd499',
          source: { documentId: 'invoice-rd499', revision: '2026-11-02T23:20:05.416Z' },
          type: 32,
          issuedOn: '2026-11-02',
          currency: 'DOP',
          pricesIncludeTax: false,
          issuer: {
            rnc: scope.issuerRnc,
            fiscalName: 'STARLIN ANTONIO RIVAS NUÑEZ',
            address: 'AV. PRINCIPAL 102, SANTO DOMINGO',
          },
          incomeType: '01',
          payment: { type: 1 },
          lines: [
            {
              sourceLineId: 'line-rd499',
              description: 'PRODUCTO DE PRUEBA',
              kind: 'GOOD',
              quantity: '1.00',
              unitPrice: '4.2300',
              discount: '0.00',
              billingIndicator: 1,
            },
          ],
          expectedTotals: {
            net: '4.23',
            itbis: '0.76',
            total: '4.99',
            itbisWithheld: '0.00',
            isrWithheld: '0.00',
          },
        } as const;
      const mappedConsumer = mapFiscalRequest(
        scope,
        consumerRequest,
        {
          scope,
          operationId: 'consumer-e32-rd499',
          payloadSha256: analyzeFiscalRequest(scope, consumerRequest).payloadSha256,
          encf: 'E320000000001',
          businessDate: '2026-11-02',
          validUntil: '2027-12-31',
        },
        '2026-11-02T19:20:05-04:00',
      );
      const consumerXml = serializeXml(element('ECF', mappedConsumer.sections));
      const signedConsumer = await fiscal.signing.signEcf(scope, consumerXml);
      const signedConsumerRfce = await fiscal.signing.signConsumptionSummary(
        scope,
        consumerXml,
        signedConsumer,
      );
      await fiscal.bundle(scope, {
        unsignedEcfXml: consumerXml,
        signedEcfXml: signedConsumer,
        submissionXml: signedConsumerRfce,
        route: 'RFCE',
      });
      const representation = await preparePrintedRepresentation(
        scope,
        element('ECF', mappedConsumer.sections),
        signedConsumer,
        fiscal.printVerify,
      );
      assert.equal(representation.encf, 'E320000000001');
      assert.equal(representation.total, '4.99');
      assert.match(representation.qrUrl, /consultatimbrefc/);
    } finally { await fiscal.close(); }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
