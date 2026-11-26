import { NextResponse, type NextRequest } from 'next/server';
import { erpRequest } from '@/lib/erp';
import { allowRequest, clientIp } from '@/lib/rate-limit';
import { handleErpError, jsonError, noStore } from '@/lib/route-helpers';
import type { ReservationConfirmation, ReservationRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const originHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
};
const integer = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : NaN);

/**
 * Envía la reserva pagada al ERP. Solo se reenvían campos conocidos: el monto nunca viaja desde el
 * navegador, lo calcula el ERP con la tarifa vigente. La pasarela es una simulación (no se cobra nada).
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (origin && originHost(origin) !== host) return jsonError(403, 'Origen no permitido.');
  if (!allowRequest(`reservation:${clientIp(request.headers)}`, 6, 10 * 60_000))
    return jsonError(429, 'Has enviado varias solicitudes seguidas. Espera unos minutos o escríbenos por WhatsApp.');

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, 'Solicitud inválida.');
  // Campo trampa: invisible para personas, los robots lo completan.
  if (text(body.website, 200)) return jsonError(400, 'Solicitud inválida.');

  const payload: ReservationRequest = {
    reference: text(body.reference, 64),
    roomTypeId: text(body.roomTypeId, 40),
    checkIn: text(body.checkIn, 10),
    checkOut: text(body.checkOut, 10),
    adults: integer(body.adults),
    children: integer(body.children ?? 0),
    firstName: text(body.firstName, 80),
    lastName: text(body.lastName, 80),
    documentType: body.documentType === 'PASSPORT' ? 'PASSPORT' : 'CEDULA',
    documentNumber: text(body.documentNumber, 20),
    phone: text(body.phone, 20),
    notes: text(body.notes, 500) || undefined,
    paymentMethod: 'CARD',
    cardLast4: /^\d{4}$/.test(text(body.cardLast4, 4)) ? text(body.cardLast4, 4) : undefined,
    cardBrand: text(body.cardBrand, 20) || undefined,
  };
  // En la web no hay reservas sin pago: la pasarela debe haber completado el cobro.
  if (body.paymentMethod !== 'CARD') return jsonError(400, 'Completa el pago para confirmar tu reserva.');
  if (!payload.roomTypeId) return jsonError(400, 'Selecciona una habitación.');
  if (!payload.firstName || !payload.lastName) return jsonError(400, 'Escribe tu nombre completo.');
  if (payload.documentType === 'CEDULA' && payload.documentNumber.replace(/\D/g, '').length !== 11)
    return jsonError(400, 'Escribe los 11 dígitos de tu cédula.');
  if (payload.documentNumber.replace(/[^A-Za-z0-9]/g, '').length < 5)
    return jsonError(400, 'Escribe tu número de cédula o pasaporte.');
  if (!payload.phone) return jsonError(400, 'Escribe tu teléfono o WhatsApp.');

  try {
    const { status, data } = await erpRequest<ReservationConfirmation>(
      'POST',
      '/channel/hotel/reservations',
      { body: payload },
    );
    return NextResponse.json(data, { status, ...noStore });
  } catch (error) {
    return handleErpError(error);
  }
}
