import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let rendering = false;

export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > 24000)
    return new NextResponse('Solicitud demasiado grande.', { status: 413 });
  if (rendering)
    return new NextResponse('Se está preparando otro PDF. Intenta nuevamente en unos segundos.', {
      status: 429,
    });
  let browser;
  try {
    rendering = true;
    const body = await request.text();
    if (body.length > 24000)
      return new NextResponse('Solicitud demasiado grande.', { status: 413 });
    const { kind, id, session } = JSON.parse(body);
    if (
      !['reception', 'quote', 'invoice'].includes(kind) ||
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
      typeof session?.accessToken !== 'string' ||
      typeof session?.tenantId !== 'string'
    )
      return new NextResponse('Documento inválido.', { status: 400 });
    const api = process.env.NEXT_PUBLIC_API_URL!;
    const headers = {
      Authorization: `Bearer ${session.accessToken}`,
      'x-tenant-id': session.tenantId,
    };
    const accessResponse = await fetch(`${api}/auth/me`, { headers, cache: 'no-store' });
    if (!accessResponse.ok)
      return new NextResponse('Sesión inválida.', { status: accessResponse.status });
    const access = await accessResponse.json();
    if (!access.permissions?.[kind === 'invoice' ? 'invoices.reprint' : 'workorders.view'])
      return new NextResponse('No tienes permiso para este documento.', { status: 403 });
    const resourcePath = kind === 'invoice' ? `/invoices/${id}/receipt` : '/workshop/tickets';
    const resourceResponse = await fetch(`${api}${resourcePath}`, { headers, cache: 'no-store' });
    if (!resourceResponse.ok)
      return new NextResponse('No tienes acceso a este documento.', {
        status: resourceResponse.status,
      });
    const resource = await resourceResponse.json();
    if (kind !== 'invoice') {
      const ticket = resource.find((item: { id: string }) => item.id === id);
      if (
        !ticket ||
        (kind === 'reception' && !ticket.reception) ||
        (kind === 'quote' && !ticket.quoteVersions?.length)
      )
        return new NextResponse('Documento no encontrado o incompleto.', { status: 404 });
    }
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const origin = 'http://127.0.0.1:3000';
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    await context.addCookies([{ name: 'qorvex_session_active', value: '1', url: origin }]);
    await context.addInitScript(
      (data) => {
        localStorage.setItem('qorvex_session', JSON.stringify(data));
        window.print = () => undefined;
      },
      { ...session, ...access, expiresAt: Date.now() + 300000 },
    );
    await context.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (![origin, new URL(api).origin].includes(requestUrl.origin)) return route.abort();
      if (requestUrl.origin !== new URL(api).origin) return route.continue();
      const path = new URL(route.request().url()).pathname;
      if (path === '/auth/me') return route.fulfill({ json: access });
      if (path === resourcePath) return route.fulfill({ json: resource });
      return route.continue();
    });
    const page = await context.newPage();
    const path = kind === 'invoice' ? `/invoices/${id}/print` : `/workshop/${id}/${kind}/print`;
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page
      .locator(
        kind === 'invoice'
          ? '.invoice-document'
          : kind === 'reception'
            ? '#reception-print-sheet .reception-document'
            : 'article',
      )
      .first()
      .waitFor({ state: 'attached', timeout: 15000 });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => {
      await Promise.race([
        Promise.all([document.fonts.ready, ...Array.from(document.images).map((img) => img.decode().catch(() => undefined))]),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    });
    // Match the document's @page rules; headless Chromium defaults to zero margins.
    const margin = kind === 'reception' ? '10mm' : '12.7mm';
    const pdf = await page.pdf({
      format: kind === 'reception' ? 'A4' : 'Letter',
      margin: { top: margin, right: margin, bottom: margin, left: margin },
      preferCSSPageSize: true,
      printBackground: true,
    });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${kind}-${id}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return new NextResponse('No se pudo preparar el PDF. Intenta nuevamente.', { status: 500 });
  } finally {
    try {
      await browser?.close();
    } finally {
      rendering = false;
    }
  }
}
