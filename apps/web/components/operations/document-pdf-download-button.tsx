'use client';
import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getSession } from '@/lib/auth-session';

export function DocumentPdfDownloadButton({ kind, id, number }: { kind: 'quote' | 'reception' | 'invoice'; id: string; number: string }) {
  const [busy, setBusy] = useState(false);
  return <Button type="button" variant="outline" disabled={busy} onClick={async () => {
    const session = getSession();
    if (!session) { toast.error('Inicia sesión de nuevo para descargar el documento.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/documents/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, session }), signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      if (!blob.type.includes('application/pdf')) throw new Error('El servidor no devolvió un PDF válido.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${kind === 'quote' ? 'cotizacion' : kind === 'reception' ? 'recepcion' : 'factura'}-${number.replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo descargar el PDF.');
    } finally { setBusy(false); }
  }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{busy ? 'Preparando PDF…' : 'Descargar archivo PDF'}</Button>;
}
