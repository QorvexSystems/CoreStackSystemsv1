import 'server-only';
import { NextResponse } from 'next/server';
import { ErpError } from './erp';

export const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function jsonError(status: number, message: string, code?: string) {
  return NextResponse.json(
    { message, ...(code ? { code } : {}) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function handleErpError(error: unknown) {
  if (error instanceof ErpError) return jsonError(error.status, error.message, error.code);
  console.error('[website] error inesperado', error);
  return jsonError(500, 'Ocurrió un error inesperado. Intenta de nuevo.');
}

export const noStore = { headers: { 'Cache-Control': 'no-store' } };
