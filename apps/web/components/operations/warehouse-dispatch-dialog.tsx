'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PackageMinus, Send, X } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dispatchWarehouseProduct, type Product } from '@/lib/api';
import { trapModalFocus } from './modal-focus';
import { formatQuantity } from './pos/pos-utils';
import { useCurrentSession } from './session-required';

type DispatchProduct = Pick<Product, 'id' | 'name' | 'sku' | 'unit'> & { available: number };

export function WarehouseDispatchDialog({
  product,
  onClose,
}: {
  product: DispatchProduct | null;
  onClose: () => void;
}) {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [mounted, setMounted] = useState(false);
  const [quantity, setQuantity] = useState('1');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!product) return;
    setQuantity('1');
    setReference('');
    setReason('');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    }, 0);
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
  }, [product]);

  const dispatchMutation = useMutation({
    mutationFn: () => {
      if (!session || !product) throw new Error('Sesión requerida.');
      const numericQuantity = Number(quantity);
      if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
        throw new Error('Indica una cantidad válida para despachar.');
      }
      if (numericQuantity > product.available) {
        throw new Error(`Solo hay ${formatQuantity(product.available)} unidades disponibles.`);
      }
      return dispatchWarehouseProduct(session.tenantId, session.accessToken, product.id, {
        quantity: numericQuantity,
        reference: reference.trim(),
        reason: reason.trim(),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-products'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-stock'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-movements'] }),
      ]);
      toast.success('Despacho registrado correctamente.');
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo registrar el despacho.');
    },
  });

  if (!mounted || !product) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatchMutation.mutate();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/55 p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !dispatchMutation.isPending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="warehouse-dispatch-title"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.35)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PackageMinus className="h-5 w-5" />
            </span>
            <div>
              <h2 id="warehouse-dispatch-title" className="text-lg font-semibold">
                Registrar salida manual
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{product.name}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5" />
          </Button>
        </header>
        <form className="space-y-4 p-5" onSubmit={submit}>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            Usa esta opción solo para mermas, muestras, traslados u otras salidas sin orden de
            venta. Las órdenes B2B cobradas se entregan desde “Pendientes de entrega”.
          </div>
          <div className="rounded-lg border bg-muted/35 p-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">SKU</span>
              <span className="font-medium">{product.sku ?? '—'}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Existencia disponible</span>
              <span className="font-semibold">{formatQuantity(product.available)}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dispatch-quantity">Cantidad a despachar *</Label>
            <Input
              id="dispatch-quantity"
              type="number"
              min={allowsFraction(product.unit) ? '0.001' : '1'}
              max={product.available}
              step={allowsFraction(product.unit) ? '0.001' : '1'}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dispatch-reference">Referencia *</Label>
            <Input
              id="dispatch-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Ej. entrega, pedido o destinatario"
              maxLength={160}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dispatch-reason">Motivo *</Label>
            <Input
              id="dispatch-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Despacho manual de almacén"
              maxLength={300}
              required
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={dispatchMutation.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={dispatchMutation.isPending || product.available <= 0}>
              <Send className="h-4 w-4" />
              {dispatchMutation.isPending ? 'Registrando...' : 'Confirmar salida'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function allowsFraction(unit: string) {
  return ['METER', 'FOOT', 'YARD', 'POUND'].includes(unit);
}
