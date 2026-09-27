'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, PackagePlus, Save, X } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { countWarehouseStock, receiveWarehouseStock, type Product } from '@/lib/api';
import { formatQuantity } from './pos/pos-utils';
import { useCurrentSession } from './session-required';
import { trapModalFocus } from './modal-focus';

type StockProduct = Pick<Product, 'id' | 'name' | 'sku' | 'unit' | 'cost'> & {
  available: number;
};

export function WarehouseStockDialog({
  product,
  mode,
  onClose,
}: {
  product: StockProduct | null;
  mode: 'receive' | 'count';
  onClose: () => void;
}) {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [mounted, setMounted] = useState(false);
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const isReceive = mode === 'receive';

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!product) return;
    setQuantity(isReceive ? '' : String(product.available));
    setUnitCost(product.cost ? String(Number(product.cost)) : '');
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
  }, [isReceive, product]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!session || !product) throw new Error('Sesión requerida.');
      const numericQuantity = Number(quantity);
      if (!Number.isFinite(numericQuantity) || numericQuantity < (isReceive ? 0.001 : 0)) {
        throw new Error('Indica una cantidad válida.');
      }
      if (!reason.trim()) throw new Error('El motivo es obligatorio.');
      if (isReceive) {
        if (!reference.trim()) throw new Error('La referencia de entrada es obligatoria.');
        return receiveWarehouseStock(session.tenantId, session.accessToken, product.id, {
          quantity: numericQuantity,
          unitCost: unitCost === '' ? undefined : Number(unitCost),
          reference: reference.trim(),
          reason: reason.trim(),
        });
      }
      return countWarehouseStock(session.tenantId, session.accessToken, product.id, {
        countedQuantity: numericQuantity,
        reference: reference.trim() || undefined,
        reason: reason.trim(),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-products'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-stock'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-movements'] }),
      ]);
      toast.success(
        isReceive ? 'Entrada registrada correctamente.' : 'Conteo aplicado correctamente.',
      );
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo actualizar la existencia.');
    },
  });

  if (!mounted || !product) return null;
  const fractionalQuantity = allowsFraction(product.unit);
  const step = fractionalQuantity ? '0.001' : '1';
  const minimum = isReceive ? (fractionalQuantity ? '0.001' : '1') : '0';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/55 p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !mutation.isPending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="warehouse-stock-dialog-title"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.35)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              {isReceive ? (
                <PackagePlus className="h-5 w-5" />
              ) : (
                <ClipboardCheck className="h-5 w-5" />
              )}
            </span>
            <div>
              <h2 id="warehouse-stock-dialog-title" className="text-lg font-semibold">
                {isReceive ? 'Registrar entrada' : 'Aplicar conteo físico'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{product.name}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5" />
          </Button>
        </header>
        <form className="space-y-4 p-5" onSubmit={submit}>
          <div className="flex items-center justify-between rounded-lg border bg-muted/35 p-3 text-sm">
            <span className="text-muted-foreground">Existencia registrada</span>
            <span className="font-semibold">{formatQuantity(product.available)}</span>
          </div>
          <div className="space-y-2">
            <Label htmlFor="warehouse-stock-quantity">
              {isReceive ? 'Cantidad recibida' : 'Cantidad contada'} *
            </Label>
            <Input
              id="warehouse-stock-quantity"
              type="number"
              min={minimum}
              step={step}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
            />
          </div>
          {isReceive ? (
            <div className="space-y-2">
              <Label htmlFor="warehouse-stock-cost">Costo unitario</Label>
              <Input
                id="warehouse-stock-cost"
                type="number"
                min="0"
                step="0.01"
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="warehouse-stock-reference">
              Referencia {isReceive ? '*' : '(opcional)'}
            </Label>
            <Input
              id="warehouse-stock-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder={isReceive ? 'Factura, recepción o documento' : 'Acta o conteo'}
              maxLength={160}
              required={isReceive}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="warehouse-stock-reason">Motivo *</Label>
            <Input
              id="warehouse-stock-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                isReceive ? 'Compra, devolución o entrada manual' : 'Conteo físico o corrección'
              }
              maxLength={300}
              required
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              <Save className="h-4 w-4" />
              {mutation.isPending
                ? 'Guardando...'
                : isReceive
                  ? 'Registrar entrada'
                  : 'Aplicar conteo'}
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
