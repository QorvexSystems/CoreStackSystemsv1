// Offline rendering port only. Not connected to unsigned POS preparations.
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { assertDgiiQrCapacity, type QrContext, type QrTelemetry } from './dgii-qr-capacity';

export function renderSyntheticFiscalQr(url: string, record?: QrTelemetry) {
  if (url.length > 1024) throw Error('INVALID_QR_PAYLOAD');
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    !['ecf.dgii.gov.do', 'fc.dgii.gov.do'].includes(parsed.hostname) ||
    !/^\/(testecf|certecf)\/consultatimbre(fc)?$/.test(parsed.pathname)
  )
    throw Error('SYNTHETIC_QR_DESTINATION_REQUIRED');
  // Accept historical lowercase keys on read, but reject alias duplicates/extras.
  const values = new Map<string, string>();
  for (const [key, value] of parsed.searchParams) {
    const normalized = key.toLowerCase();
    if (
      values.has(normalized) ||
      !value ||
      ![
        'rncemisor',
        'rnccomprador',
        'encf',
        'fechaemision',
        'montototal',
        'fechafirma',
        'codigoseguridad',
      ].includes(normalized)
    )
      throw Error('INVALID_TIMBRE_QUERY');
    values.set(normalized, value);
  }
  const encf = values.get('encf') ?? '';
  if (!/^E\d{12}$/.test(encf)) throw Error('INVALID_TIMBRE_QUERY');
  const documentType = Number(encf.slice(1, 3)) as QrContext['documentType'];
  const rfce = parsed.hostname === 'fc.dgii.gov.do';
  if (parsed.pathname.endsWith('consultatimbrefc') !== rfce || (rfce && documentType !== 32))
    throw Error('INVALID_TIMBRE_QUERY');
  const required = [
    'rncemisor',
    'encf',
    'montototal',
    'codigoseguridad',
    ...(!rfce ? ['fechaemision', 'fechafirma'] : []),
    ...(documentType === 31 ? ['rnccomprador'] : []),
  ];
  if (
    required.some((key) => !values.has(key)) ||
    (rfce && values.size !== 4) ||
    !/^(\d{9}|\d{11})$/.test(values.get('rncemisor') ?? '') ||
    (values.has('rnccomprador') && !/^(\d{9}|\d{11})$/.test(values.get('rnccomprador')!)) ||
    !/^[A-Za-z0-9+/]{6}$/.test(values.get('codigoseguridad') ?? '') ||
    !/^(0|[1-9]\d{0,15})\.\d{2}$/.test(values.get('montototal') ?? '') ||
    (!rfce &&
      (!/^\d{2}-\d{2}-\d{4}$/.test(values.get('fechaemision') ?? '') ||
        !/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(values.get('fechafirma') ?? '')))
  )
    throw Error('INVALID_TIMBRE_QUERY');
  const plan = assertDgiiQrCapacity(
    url,
    {
      documentType,
      environment: parsed.pathname.startsWith('/testecf/') ? 'precertification' : 'certification',
    },
    record,
  );
  const svg = renderToStaticMarkup(
    <QRCodeSVG
      xmlns="http://www.w3.org/2000/svg"
      value={[...plan.segments]}
      minVersion={plan.version}
      level="L"
      boostLevel={false}
      marginSize={4}
      size={228}
      title="QR de prueba sin validez fiscal"
    />,
  );
  // Library minVersion is not a maximum: require the explicitly selected v8/v9.
  const matrix = plan.version === 8 ? 57 : 61;
  if (!svg.includes(`viewBox="0 0 ${matrix} ${matrix}"`))
    throw Error('DGII_QR_ENCODER_VERSION_MISMATCH');
  return svg;
}
