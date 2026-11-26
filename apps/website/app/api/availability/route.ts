import { NextResponse, type NextRequest } from 'next/server';
import { erpRequest } from '@/lib/erp';
import { allowRequest, clientIp } from '@/lib/rate-limit';
import { DATE_KEY, handleErpError, jsonError, noStore } from '@/lib/route-helpers';
import type { StayAvailability } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!allowRequest(`availability:${clientIp(request.headers)}`, 90, 60_000))
    return jsonError(429, 'Demasiadas consultas. Espera un momento.');
  const params = request.nextUrl.searchParams;
  const checkIn = params.get('checkIn') ?? '';
  const checkOut = params.get('checkOut') ?? '';
  const adults = Number(params.get('adults') ?? 1);
  const children = Number(params.get('children') ?? 0);
  if (!DATE_KEY.test(checkIn) || !DATE_KEY.test(checkOut))
    return jsonError(400, 'Selecciona las fechas de llegada y salida.');
  if (!Number.isInteger(adults) || !Number.isInteger(children) || adults < 1 || children < 0)
    return jsonError(400, 'Indica la cantidad de huéspedes.');
  try {
    const { data } = await erpRequest<StayAvailability>('GET', '/channel/hotel/availability', {
      query: { checkIn, checkOut, adults, children },
    });
    return NextResponse.json(data, noStore);
  } catch (error) {
    return handleErpError(error);
  }
}
