'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Barcode, CheckCircle2, Minus, PackageCheck, Plus, Search, X } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmWarehouseOrderDispatch, type WarehousePendingDispatch } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { trapModalFocus } from './modal-focus';
import { formatQuantity } from './pos/pos-utils';
import { useCurrentSession } from './session-required';

const BarcodeCameraScanner = dynamic(
  () => import('./barcode-camera-scanner').then((module) => module.BarcodeCameraScanner),
  { ssr: false },
);

export function WarehouseOrderDispatchDialog({
  order,
  onClose,
}: {
  order: WarehousePendingDispatch | null;
  onClose: () => void;
}) {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const [mounted, setMounted] = useState(false);
  const [note, setNote] = useState('');
  const [barcode, setBarcode] = useState('');
  const [verified, setVerified] = useState<Record<string, number>>({});

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!order) return;
    setNote('');
    setBarcode('');
    setVerified({});
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      trapModalFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [order]);

  const verificationComplete = useMemo(
    () =>
      Boolean(
        order?.items.length &&
        order.items.every(
          (item) => Math.abs((verified[item.id] ?? 0) - Number(item.quantity)) < 0.0005,
        ),
      ),
    [order, verified],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!session || !order) throw new Error('Sesión requerida.');
      if (!verificationComplete) {
        throw new Error('Escanea o confirma todas las unidades antes de despachar.');
      }
      return confirmWarehouseOrderDispatch(
        session.tenantId,
        session.accessToken,
        order.id,
        order.items.map((item) => ({
          orderItemId: item.id,
          quantity: verified[item.id] ?? 0,
        })),
        note,
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-pending-dispatches'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-movements'] }),
      ]);
      toast.success('Entrega confirmada.');
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo confirmar la entrega.');
    },
  });

  if (!mounted || !order) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  function scanProduct(value: string) {
    if (!order) return;
    const code = normalizeCode(value);
    if (!code) return;

    const matchingItem = order.items.find((item) => {
      const required = Number(item.quantity);
      const current = verified[item.id] ?? 0;
      return (
        current < required - 0.0005 &&
        [item.barcode, item.sku].some((candidate) => normalizeCode(candidate ?? '') === code)
      );
    });

    if (!matchingItem) {
      const belongsToCompletedLine = order.items.some((item) =>
        [item.barcode, item.sku].some((candidate) => normalizeCode(candidate ?? '') === code),
      );
      toast.error(
        belongsToCompletedLine
          ? 'La cantidad requerida de este producto ya está completa.'
          : 'Este código no pertenece a la orden.',
      );
      resetBarcodeInput();
      return;
    }

    changeVerifiedQuantity(matchingItem.id, 1);
    toast.success('Producto verificado', {
      id: `warehouse-scan-${order.id}`,
      description: matchingItem.description,
    });
    resetBarcodeInput();
  }

  function resetBarcodeInput() {
    setBarcode('');
    window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
  }

  function changeVerifiedQuantity(itemId: string, delta: number) {
    const item = order?.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const required = Number(item.quantity);
    setVerified((current) => ({
      ...current,
      [itemId]: Math.max(0, Math.min(required, (current[itemId] ?? 0) + delta)),
    }));
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/55 p-3 backdrop-blur-sm sm:p-5">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-dispatch-title"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-white shadow-[0_24px_80px_rgba(15,23,42,0.35)]"
      >
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PackageCheck className="h-5 w-5" />
            </span>
            <div>
              <h2 id="order-dispatch-title" className="text-lg font-semibold">
                Preparar y despachar orden
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {order.orderNumber} · {order.invoice?.invoiceNumber}
              </p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5" />
          </Button>
        </header>
        <form
          className="surface-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
          onSubmit={submit}
        >
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Cliente</span>
              <span className="font-medium">
                {order.customer?.name ?? order.clientName ?? 'Consumidor final'}
              </span>
            </div>
            <div className="mt-2 flex justify-between gap-4">
              <span className="text-muted-foreground">Total cobrado</span>
              <span className="font-semibold">
                {formatCurrency(Number(order.invoice?.total ?? 0))}
              </span>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
            <div>
              <p className="font-semibold">Escanear productos</p>
              <p className="text-xs text-muted-foreground">
                Usa la pistola, escribe el código o abre la cámara. Cada lectura suma una unidad.
              </p>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Barcode className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={barcodeInputRef}
                  value={barcode}
                  onChange={(event) => setBarcode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      scanProduct(barcode);
                    }
                  }}
                  placeholder="Escanea código de barras o SKU"
                  className="h-11 pl-9"
                  autoComplete="off"
                />
              </div>
              <Button
                type="button"
                size="icon"
                className="h-11 w-11"
                onClick={() => scanProduct(barcode)}
                aria-label="Verificar código"
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <BarcodeCameraScanner onDetected={scanProduct} label="Usar cámara" />
          </div>

          <div className="divide-y rounded-lg border">
            {order.items.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-3 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {[item.sku, item.barcode].filter(Boolean).join(' · ') ||
                      'Sin código registrado'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => changeVerifiedQuantity(item.id, -1)}
                    disabled={(verified[item.id] ?? 0) <= 0}
                    aria-label={`Restar ${item.description}`}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="min-w-20 text-center font-semibold">
                    {formatQuantity(verified[item.id] ?? 0)} /{' '}
                    {formatQuantity(Number(item.quantity))}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => changeVerifiedQuantity(item.id, 1)}
                    disabled={(verified[item.id] ?? 0) >= Number(item.quantity) - 0.0005}
                    aria-label={`Sumar ${item.description}`}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="order-dispatch-note">Nota de entrega</Label>
            <textarea
              id="order-dispatch-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={300}
              rows={3}
              placeholder="Persona que recibe u observación opcional"
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            {verificationComplete
              ? 'Orden verificada. Puedes confirmar la entrega física.'
              : 'Completa todas las cantidades. El inventario ya fue descontado en caja y no se descontará nuevamente.'}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending || !verificationComplete}>
              <CheckCircle2 className="h-4 w-4" />
              {mutation.isPending ? 'Confirmando...' : 'Confirmar despacho'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function normalizeCode(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}
