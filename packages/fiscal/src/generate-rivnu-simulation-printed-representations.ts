import { createHash, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { preparePrintedRepresentation, renderPrintedRepresentation } from './printed-representation.ts';
import { securityCodeFromGeneratedSignature, unsignedXmlFromGeneratedSignature } from './pkcs12-signer.ts';
import { parseSerializedXml } from './xml.ts';

const inputRoot = '/input';
const outputRoot = '/output';
const expectedReportSha256 = '366ad3f61a6a6062c3ce305be335536ba0288e90505d0200bae46cad27a36949';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const selections = Object.freeze([
  ['31', 'E310000300001', 'RI-31-E310000300001.pdf'],
  ['32 >= RD$250mil', 'E320000300001', 'RI-32-MAYOR-250MIL-E320000300001.pdf'],
  ['33', 'E330000300001', 'RI-33-E330000300001.pdf'],
  ['34', 'E340000300001', 'RI-34-E340000300001.pdf'],
  ['41', 'E410000300001', 'RI-41-E410000300001.pdf'],
  ['43', 'E430000300001', 'RI-43-E430000300001.pdf'],
  ['44', 'E440000300001', 'RI-44-E440000300001.pdf'],
  ['45', 'E450000300001', 'RI-45-E450000300001.pdf'],
  ['46', 'E460000300001', 'RI-46-E460000300001.pdf'],
  ['47', 'E470000300001', 'RI-47-E470000300001.pdf'],
  ['32 < RD$250mil', 'E320000300003', 'RI-32-MENOR-250MIL-E320000300003.pdf'],
] as const);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const ensure = (value: unknown, code: string): asserts value => {
  if (!value) throw Error(code);
};

type ReportEntry = {
  type: number;
  encf: string;
  unsignedSha256: string;
  signedSha256: string;
  securityCode: string;
  total: string;
};
type SigningReport = {
  profile: string;
  scope: typeof scope;
  certificateSha256: string;
  ecf: ReportEntry[];
};

async function command(program: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const process = spawn(program, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', XML_CATALOG_FILES: '' },
    });
    let diagnostics = '';
    process.stderr.on('data', (chunk) => {
      if (diagnostics.length < 4096) diagnostics += String(chunk);
    });
    const timer = setTimeout(() => process.kill('SIGKILL'), 30_000);
    process.once('error', reject);
    process.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error(`COMMAND_FAILED_${program.toUpperCase().replace(/\W/g, '_')}`));
    });
  });
}

const reportText = await readFile(`${inputRoot}/signing-report.json`, 'utf8');
ensure(digest(reportText) === expectedReportSha256, 'PRINT_REPORT_HASH_MISMATCH');
const report = JSON.parse(reportText) as SigningReport;
ensure(
  report.profile === 'RIVNU_SIMULATION_20261019_ATTEMPT3_V1' &&
    JSON.stringify(report.scope) === JSON.stringify(scope) &&
    report.certificateSha256 === 'a4348bad3005f70073f5d048d7789a9f9289addb3004ca84319feb1e5f41012d' &&
    report.ecf.length === 25,
  'PRINT_REPORT_INVALID',
);
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const generated: Record<string, unknown>[] = [];

for (const [category, encf, filename] of selections) {
  const entry = report.ecf.find((candidate) => candidate.encf === encf);
  ensure(entry, 'PRINT_REPORT_ENTRY_MISSING');
  const signedXml = await readFile(`${inputRoot}/ecf-signed/${encf}.xml`, 'utf8');
  ensure(digest(signedXml) === entry.signedSha256, 'PRINT_SIGNED_XML_HASH_MISMATCH');
  const unsignedXml = unsignedXmlFromGeneratedSignature(signedXml);
  ensure(digest(unsignedXml) === entry.unsignedSha256, 'PRINT_UNSIGNED_XML_HASH_MISMATCH');
  ensure(securityCodeFromGeneratedSignature(signedXml) === entry.securityCode, 'PRINT_SECURITY_CODE_MISMATCH');

  const certificateMatch = signedXml.match(/<X509Certificate>([A-Za-z0-9+/=\s]+)<\/X509Certificate>/);
  ensure(certificateMatch, 'PRINT_CERTIFICATE_MISSING');
  const certificate = new X509Certificate(Buffer.from(certificateMatch[1].replace(/\s/g, ''), 'base64'));
  ensure(digest(certificate.raw) === report.certificateSha256, 'PRINT_CERTIFICATE_MISMATCH');
  ensure(certificate.subject.includes(`IDCDO-${scope.issuerRnc}`), 'PRINT_CERTIFICATE_SCOPE_MISMATCH');
  const signedPath = `/tmp/${encf}.xml`;
  const certificatePath = `/tmp/${encf}.pem`;
  await writeFile(signedPath, signedXml, { mode: 0o600, flag: 'wx' });
  await writeFile(certificatePath, certificate.toString(), { mode: 0o600, flag: 'wx' });
  await command('xmlsec1', [
    '--verify', '--enabled-reference-uris', 'empty', '--enabled-key-data', 'x509',
    '--pubkey-cert-pem', certificatePath, signedPath,
  ]);

  const verify = async () => ({
    sourceSha256: entry.unsignedSha256,
    signedSha256: entry.signedSha256,
    issuerRnc: scope.issuerRnc,
    encf,
    securityCode: entry.securityCode,
  });
  const model = await preparePrintedRepresentation(
    scope,
    parseSerializedXml(unsignedXml),
    signedXml,
    verify,
  );
  ensure(model.total === entry.total, 'PRINT_TOTAL_MISMATCH');
  const qrSvg = renderToStaticMarkup(
    createElement(QRCodeSVG, {
      xmlns: 'http://www.w3.org/2000/svg',
      value: model.qrUrl,
      minVersion: model.qrVersion,
      level: 'L',
      boostLevel: false,
      marginSize: 4,
      size: 228,
      title: 'QR DGII',
    }),
  );
  const matrix = model.qrVersion === 8 ? 57 : 61;
  ensure(qrSvg.includes(`viewBox="0 0 ${matrix} ${matrix}"`), 'PRINT_QR_VERSION_MISMATCH');
  const displayModel = {
    ...model,
    notice: 'AMBIENTE DE CERTIFICACIÓN — DOCUMENTO DE PRUEBA — SIN VALIDEZ FISCAL',
  };
  const compactStyle = `<style>
@page{margin:8mm}body{font-size:9px;line-height:1.1}h1{font-size:17px;margin:0 0 4px}h2{font-size:12px!important;margin:5px 0 2px!important}header p{margin:2px 0}table{margin:3px 0}th,td{padding:2px}.metadata{gap:0 10px!important}.metadata table{font-size:8.5px!important}.notice{padding:4px!important;margin:4px 0}.fiscal-footer{margin-top:6px!important}.qr{width:30mm;height:30mm}dl{font-size:8px}
</style>`;
  const html = renderPrintedRepresentation(displayModel, qrSvg).replace('</head>', `${compactStyle}</head>`);
  const htmlPath = `/tmp/${encf}.html`;
  const pdfPath = join(outputRoot, filename);
  await writeFile(htmlPath, html, { mode: 0o600, flag: 'wx' });
  await command('chromium', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ]);
  const pdf = await readFile(pdfPath);
  ensure(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 1000, 'PRINT_PDF_INVALID');
  await writeFile(pdfPath, pdf, { mode: 0o600 });
  generated.push({
    category,
    encf,
    filename,
    bytes: pdf.length,
    sha256: digest(pdf),
    qrUrl: model.qrUrl,
    qrVersion: model.qrVersion,
    signedXmlSha256: entry.signedSha256,
  });
}

const totalBytes = generated.reduce((sum, item) => sum + Number(item.bytes), 0);
ensure(totalBytes < 10_000_000, 'PRINT_SET_EXCEEDS_PORTAL_LIMIT');
const manifest = {
  profile: 'RIVNU_SIMULATION_PRINTED_REPRESENTATIONS_20261019_V1',
  sourceSigningReportSha256: expectedReportSha256,
  files: generated,
  totalBytes,
};
await writeFile(`${outputRoot}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
const manifestSize = (await stat(`${outputRoot}/manifest.json`)).size;
console.log(`RIVNU_SIMULATION_PRINTED_REPRESENTATIONS_READY_COUNT=${generated.length}`);
console.log(`TOTAL_PDF_BYTES=${totalBytes}`);
console.log(`MANIFEST_BYTES=${manifestSize}`);
