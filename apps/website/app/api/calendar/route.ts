import { NextResponse, type NextRequest } from 'next/server';
import { erpRequest } from '@/lib/erp';
import { allowRequest, clientIp } from '@/lib/rate-limit';
import { DATE_KEY, handleErpError, jsonError, noStore } from '@/lib/route-helpers';
import type { AvailabilityCalendar } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!allowRequest(`calendar:${clientIp(request.headers)}`, 90, 60_000))
    return jsonError(429, 'Demasiadas consultas. Espera un momento.');
  const from = request.nextUrl.searchParams.get('from') ?? '';
  const days = Number(request.nextUrl.searchParams.get('days') ?? 62);
  if (!DATE_KEY.test(from)) return jsonError(400, 'Fecha inicial inválida.');
  if (!Number.isInteger(days) || days < 1 || days > 186) return jsonError(400, 'Rango inválido.');
  try {
    const { data } = await erpRequest<AvailabilityCalendar>('GET', '/channel/hotel/calendar', {
      query: { from, days },
    });
    return NextResponse.json(data, noStore);
  } catch (error) {
    return handleErpError(error);
  }
}
