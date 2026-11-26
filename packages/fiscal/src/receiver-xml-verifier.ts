import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsignedXmlFromGeneratedSignature } from './pkcs12-signer.ts';

export type VerifiedIncomingXml = Readonly<{
  actorRnc: string;
  certificateSha256: string;
  signedSha256: string;
  unsignedXml: string;
}>;

function command(program: string, args: readonly string[], timeout = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', XML_CATALOG_FILES: '' },
    });
    const diagnosticChunks: Buffer[] = [];
    let diagnosticSize = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnosticSize >= 16_384) return;
      const bounded = chunk.subarray(0, 16_384 - diagnosticSize);
      diagnosticChunks.push(bounded);
      diagnosticSize += bounded.length;
    });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('INCOMING_SIGNATURE_TOOL_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(Error('INCOMING_SIGNATURE_TIMEOUT'));
      else if (code === 0) resolve();
      else {
        const raw = Buffer.concat(diagnosticChunks).toString('utf8');
        const diagnostic = raw
          .replace(/\/tmp\/corestack-receiver-verify-[^/\s]+/g, '<verification-workspace>')
          .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
          .slice(0, 4096);
        reject(Object.assign(Error('INCOMING_SIGNATURE_INVALID'), { diagnostic }));
      }
    });
  });
}

/** Verify an XMLDSig with a separately provisioned DGII communication root.
 * The embedded leaf is identity evidence only after xmlsec builds trust to that root.
 */
export async function verifyIncomingSignedXml(
  xml: string,
  trustedPemPath: string,
  expectedCertificateSha256?: string,
): Promise<VerifiedIncomingXml> {
  if (
    typeof xml !== 'string' ||
    Buffer.byteLength(xml, 'utf8') < 1 ||
    Buffer.byteLength(xml, 'utf8') > 2 * 1024 * 1024 ||
    /<!|<\?(?!xml\s)/i.test(xml) ||
    /<(?:[A-Za-z][A-Za-z0-9]*:)?(?:Object|RetrievalMethod)\b/.test(xml)
  )
    throw Error('INCOMING_XML_REJECTED');
  const certificates = [...xml.matchAll(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/g)];
  if (certificates.length < 1 || certificates.length > 4) throw Error('INCOMING_CERTIFICATE_INVALID');
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(Buffer.from(certificates[0]![1]!.replace(/\s/g, ''), 'base64'));
  } catch {
    throw Error('INCOMING_CERTIFICATE_INVALID');
  }
  const actor = /IDCDO-(\d{11}|\d{9})(?!\d)/.exec(leaf.subject)?.[1];
  if (!actor) throw Error('INCOMING_CERTIFICATE_IDENTITY_INVALID');
  const now = Date.now();
  if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo))
    throw Error('INCOMING_CERTIFICATE_EXPIRED');
  const leafSha256 = createHash('sha256').update(leaf.raw).digest('hex');
  if (expectedCertificateSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(expectedCertificateSha256) || leafSha256 !== expectedCertificateSha256))
    throw Error('INCOMING_CERTIFICATE_FINGERPRINT_MISMATCH');

  const directory = await mkdtemp(join(tmpdir(), 'corestack-receiver-verify-'));
  const signedPath = join(directory, 'signed.xml');
  try {
    const trustArguments: string[] = [];
    if (expectedCertificateSha256 !== undefined) {
      const pinnedLeafPath = join(directory, 'pinned-leaf.pem');
      await writeFile(pinnedLeafPath, leaf.toString(), { mode: 0o600 });
      // In certification, the exact DGII test leaf is pinned above by its DER
      // SHA-256. Load only that certificate's public key for XMLDSig verification;
      // xmlsec otherwise tries to build an X.509 chain even when a non-self-signed
      // leaf is passed as trusted and rejects the DGII test request with err=20.
      trustArguments.push('--pubkey-cert-pem', pinnedLeafPath);
    } else {
      const trustSource = await readFile(trustedPemPath, 'utf8');
      const trustCertificates = trustSource.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      if (trustCertificates.length < 1 || trustCertificates.length > 8)
        throw Error('INCOMING_TRUST_INVALID');
      let trustedRoots = 0;
      for (const [index, certificate] of trustCertificates.entries()) {
        let authority: X509Certificate;
        try {
          authority = new X509Certificate(certificate);
        } catch {
          throw Error('INCOMING_TRUST_INVALID');
        }
        if (!authority.ca) throw Error('INCOMING_TRUST_INVALID');
        const selfSigned = authority.subject === authority.issuer && authority.verify(authority.publicKey);
        const path = join(directory, `trusted-${index}.pem`);
        await writeFile(path, certificate, { mode: 0o600 });
        trustArguments.push(selfSigned ? '--trusted-pem' : '--untrusted-pem', path);
        if (selfSigned) trustedRoots++;
      }
      if (trustedRoots < 1 || trustedRoots > 4) throw Error('INCOMING_TRUST_INVALID');
    }
    await writeFile(signedPath, xml, { mode: 0o600 });
    try {
      await command('xmlsec1', [
        '--verify',
        '--enabled-reference-uris',
        'empty',
        '--enabled-key-data',
        'x509',
        ...trustArguments,
        signedPath,
      ]);
    } catch (error: any) {
      // Certificates embedded in XMLDSig are public identity material. Record only
      // bounded certificate metadata so an operator can provision the correct CA;
      // never log the XML, seed, signature value, token or request headers.
      const chain = certificates.map((match) => {
        try {
          const certificate = new X509Certificate(Buffer.from(match[1]!.replace(/\s/g, ''), 'base64'));
          return {
            sha256: createHash('sha256').update(certificate.raw).digest('hex'),
            subject: certificate.subject.slice(0, 512),
            issuer: certificate.issuer.slice(0, 512),
            serial: certificate.serialNumber.slice(0, 128),
            validFrom: certificate.validFrom,
            validTo: certificate.validTo,
            infoAccess: certificate.infoAccess?.slice(0, 1024),
          };
        } catch {
          return { invalidCertificate: true };
        }
      });
      console.warn(JSON.stringify({
        event: 'INCOMING_XML_SIGNATURE_REJECTED',
        code: typeof error?.message === 'string' ? error.message : 'INCOMING_SIGNATURE_INVALID',
        diagnostic: typeof error?.diagnostic === 'string' ? error.diagnostic : undefined,
        certificates: chain,
      }));
      throw error;
    }
    return Object.freeze({
      actorRnc: actor,
      certificateSha256: leafSha256,
      signedSha256: createHash('sha256').update(xml).digest('hex'),
      unsignedXml: unsignedXmlFromGeneratedSignature(xml),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

