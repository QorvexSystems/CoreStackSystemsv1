// One-shot VM4 test. It signs only a synthetic seed and never contacts DGII.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createPkcs12XmlSigner } from '../src/pkcs12-signer.ts';

const workRoot = '/work';
const signer = await createPkcs12XmlSigner({
  scope: {
    tenantId: 'cmt397emm0002nm0ogb50l2q6',
    issuerRnc: '40220429126',
    environment: 'precertification',
  },
  p12Path: '/run/secrets/rivnu/certificate.p12',
  passwordPath: '/run/secrets/rivnu/password',
  rootCertificatePath: '/run/trust/digifirma/root.crt',
  subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
  crlPath: '/run/trust/digifirma/subordinate.crl.pem',
  expectedCertificateSha256: 'a4348bad3005f70073f5d048d7789a9f9289addb3004ca84319feb1e5f41012d',
  workRoot,
});

try {
  const unsigned =
    '<?xml version="1.0" encoding="utf-8"?><SemillaModel><valor>CORESTACK-RIVNU-OFFLINE-SELF-TEST</valor><Fecha>2026-10-06T00:00:00Z</Fecha></SemillaModel>';
  const signed = await signer.sign(unsigned);
  await signer.verify(signed);
  await assert.rejects(
    signer.verify(signed.replace('CORESTACK-RIVNU-OFFLINE-SELF-TEST', 'TAMPERED-OFFLINE-SELF-TEST')),
    /SIGNER_COMMAND_FAILED_XML_SIGNATURE_VERIFICATION/,
  );
  console.log('RIVNU_CERTIFICATE_FINGERPRINT_VERIFIED');
  console.log('RIVNU_XMLDSIG_CREATED_AND_VERIFIED');
  console.log('RIVNU_XMLDSIG_TAMPER_REJECTED');
} finally {
  await signer.close();
}

assert.deepEqual(await readdir(workRoot), []);
console.log('RIVNU_SELF_TEST_ARTIFACTS_REMOVED');
console.log('RIVNU_SIGNER_SELF_TEST_COMPLETE_NOT_ACTIVATED');
