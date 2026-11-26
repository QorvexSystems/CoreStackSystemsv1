'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Download } from 'lucide-react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSession } from '@/lib/auth-session';
import { whatsappChatUrl } from '@/lib/whatsapp';
import { brand } from '@/lib/brand';

type Props = {
  kind?: 'reception' | 'quote' | 'invoice';
  documentId?: string;
  documentNumber?: string;
  customer: { id?: string; name: string; phone?: string | null };
  readyMessage?: string;
  label?: string;
  defaultOpen?: boolean;
  onClose?: () => void;
  dialogTitle?: string;
};

export function DocumentWhatsappButton({
  kind,
  documentId,
  documentNumber,
  customer,
  readyMessage,
  label = 'Enviar por WhatsApp',
  defaultOpen = false,
  onClose,
  dialogTitle,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const title = kind === 'invoice' ? 'factura' : kind === 'quote' ? 'cotización' : 'recepción';
  const text =
    readyMessage ??
    `Hola ${customer.name}, le compartimos su ${title} ${documentNumber ?? ''} de ${brand.name}.`;
  const whatsapp = whatsappChatUrl(phone, text);
  const validPhone = Boolean(whatsapp);
  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const prepare = async () => {
    const session = getSession();
    if (!session || !kind || !documentId) return;
    setBusy(true);
    try {
      const response = await fetch('/api/documents/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id: documentId, session }),
      });
      if (!response.ok) throw new Error(await response.text());
      setFile(
        new File(
          [await response.blob()],
          `${kind === 'quote' ? 'cotizacion' : kind === 'reception' ? 'recepcion' : 'factura'}-${(documentNumber ?? documentId).replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`,
          { type: 'application/pdf' },
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo generar el PDF.');
    } finally {
      setBusy(false);
    }
  };
  const savePhone = async () => {
    const session = getSession();
    if (!session || !customer.id || !validPhone) return;
    setBusy(true);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/customers/${customer.id}/contact`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`,
            'x-tenant-id': session.tenantId,
          },
          body: JSON.stringify({ phone: phone.trim() }),
        },
      );
      if (!response.ok) throw new Error('No se pudo actualizar el teléfono del cliente.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workshop-tickets'] }),
        queryClient.invalidateQueries({ queryKey: ['workshop-appointments'] }),
        queryClient.invalidateQueries({ queryKey: ['pos-customers'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['invoice'] }),
      ]);
      toast.success('Teléfono del cliente actualizado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar el teléfono.');
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (file && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `${title} ${documentNumber}`, text });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError'))
          toast.error('No se pudo compartir. Descarga el PDF y adjúntalo en WhatsApp Web.');
      }
      return;
    }
    download();
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setPhone(customer.phone ?? phone);
          setFile(null);
          setOpen(true);
        }}
      >
        <MessageCircle className="h-4 w-4" />
        {label}
      </Button>
      <ActionDialog
        open={open}
        title={
          dialogTitle ??
          (readyMessage ? 'Avisar al cliente por WhatsApp' : `Enviar ${title} por WhatsApp`)
        }
        description={
          readyMessage
            ? 'Revisa el teléfono y el mensaje antes de abrir el chat.'
            : 'Prepara el PDF para compartir la copia completa del documento.'
        }
        confirmLabel="Abrir chat de WhatsApp"
        confirmHref={whatsapp ?? undefined}
        confirmDisabled={!validPhone}
        isPending={busy}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        onConfirm={() => undefined}
      >
        <label className="block space-y-2 text-sm font-medium">
          Teléfono del cliente
          <Input
            inputMode="tel"
            value={phone}
            maxLength={40}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="809 555 1234"
          />
        </label>
        {!validPhone ? (
          <p className="text-xs text-amber-800">
            Escribe un teléfono válido. Para otros países, incluye el código de país.
          </p>
        ) : null}
        {customer.id ? (
          <Button
            type="button"
            variant="outline"
            disabled={!validPhone || busy}
            onClick={() => void savePhone()}
          >
            Guardar teléfono corregido
          </Button>
        ) : null}
        <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{text}</p>
        {kind ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void prepare()}>
              {file ? 'Actualizar PDF' : 'Preparar PDF'}
            </Button>
            {file ? (
              <Button type="button" variant="outline" onClick={download}>
                <Download className="h-4 w-4" />
                Descargar PDF
              </Button>
            ) : null}
            {file && typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) ? (
              <Button type="button" variant="outline" onClick={() => void share()}>
                Compartir PDF · elegir contacto
              </Button>
            ) : null}
          </div>
        ) : null}
        {kind ? (
          <p className="text-xs text-muted-foreground">
            Abrir chat usa el teléfono indicado arriba. Para adjuntar el documento, prepara y
            descarga el PDF. Si utilizas Compartir PDF, el dispositivo te pedirá elegir el contacto
            nuevamente.
          </p>
        ) : null}
      </ActionDialog>
    </>
  );
}
