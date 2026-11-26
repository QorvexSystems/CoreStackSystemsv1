import {
  DgiiQrCapacityError,
  planDgiiQr,
  QR_CAPACITY_BITS,
  type DgiiQrContext,
} from '../../../packages/fiscal/src/qr-capacity';

export type QrContext = DgiiQrContext;
export { DgiiQrCapacityError };
export type QrCapacityEvent = Readonly<{
  event: 'DGII_QR_VERSION_9_SELECTED' | 'DGII_QR_V9_CAPACITY_EXCEEDED';
  documentType: QrContext['documentType'];
  environment: QrContext['environment'];
  requiredBits: number;
  capacityBits: number;
  selectedVersion?: 9;
  timestamp: string;
}>;
export type QrTelemetry = (event: QrCapacityEvent) => void;
const logCapacity: QrTelemetry = (event) => console.warn(JSON.stringify(event));

export function assertDgiiQrCapacity(
  payload: string,
  context: QrContext,
  record: QrTelemetry = logCapacity,
) {
  if (
    ![31, 32, 33, 34, 41, 43, 44, 45, 46, 47].includes(context.documentType) ||
    !['precertification', 'certification', 'production'].includes(context.environment)
  )
    throw Error('INVALID_QR_CONTEXT');
  let plan;
  try {
    plan = planDgiiQr(payload, context);
  } catch (error) {
    if (!(error instanceof DgiiQrCapacityError)) throw error;
    const event: QrCapacityEvent = Object.freeze({
      event: error.code,
      documentType: error.documentType,
      environment: error.environment,
      requiredBits: error.actualBits,
      capacityBits: error.capacityBits,
      timestamp: new Date().toISOString(),
    });
    try {
      record(event);
    } catch {
      /* A telemetry outage must not bypass fiscal rejection. */
    }
    throw error;
  }
  if (plan.version === 9) {
    try {
      record(Object.freeze({
        event: 'DGII_QR_VERSION_9_SELECTED',
        documentType: context.documentType,
        environment: context.environment,
        requiredBits: plan.minimumBits,
        capacityBits: QR_CAPACITY_BITS[9],
        selectedVersion: 9,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      /* Telemetry cannot block a valid representation. */
    }
  }
  return plan;
}

export function fiscalPrintFailure(error: unknown) {
  if (error instanceof DgiiQrCapacityError)
    return {
      status: 'QR_CAPACITY_BLOCKED' as const,
      code: error.code,
      message:
        'No fue posible generar el código QR fiscal porque los datos del comprobante exceden la capacidad admitida hasta QR versión 9. El comprobante no ha sido modificado ni se ha generado un QR alternativo.',
      ...(process.env.NODE_ENV === 'development'
        ? { detail: `Required bits: ${error.actualBits}. Capacity: ${error.capacityBits}.` }
        : {}),
    };
  return {
    status: 'PRINT_FAILED' as const,
    message: 'No fue posible preparar la impresión del comprobante.',
  };
}

/** Print boundary: prepare first; never open/print a partial RI on failure.
 * Does not provide a signer, verifier or permission to activate production.
 */
export async function runFiscalPrint(
  prepareHtml: () => Promise<string>,
  present: (html: string) => void | Promise<void>,
) {
  try {
    const html = await prepareHtml();
    await present(html);
    return { status: 'PRINT_READY' as const };
  } catch (error) {
    return fiscalPrintFailure(error);
  }
}
