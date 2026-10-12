'use client';

import { PackagePlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type CommonProductDraft = {
  description: string;
  unit: string;
  unitPrice: number;
  quantity: number;
};

type CommonProductDialogProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (draft: CommonProductDraft) => void;
};

export function CommonProductDialog({ open, onClose, onAdd }: CommonProductDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [description, setDescription] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const parsedUnitPrice = Number(unitPrice);
  const parsedQuantity = Number(quantity);
  const validUnitPrice = Number.isFinite(parsedUnitPrice) && parsedUnitPrice > 0;
  const validQuantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const unitTax = validUnitPrice ? Math.round(parsedUnitPrice * 0.18 * 100) / 100 : 0;
  const finalUnitPrice = validUnitPrice
    ? Math.round((parsedUnitPrice + unitTax) * 100) / 100
    : 0;
  const finalTotal =
    validUnitPrice && validQuantity
      ? Math.round(finalUnitPrice * parsedQuantity * 100) / 100
      : 0;

  const formatMoney = (value: number) =>
    new Intl.NumberFormat('es-DO', {
      style: 'currency',
      currency: 'DOP',
      minimumFractionDigits: 2,
    }).format(value);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setDescription('');
    setUnitPrice('');
    setQuantity('1');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-950/45 p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="common-product-title"
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-5">
          <div>
            <h2 id="common-product-title" className="flex items-center gap-2 text-lg font-semibold">
              <PackagePlus className="h-5 w-5" />
              Producto común
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Se guardará solamente en esta venta y no afectará el inventario.
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <form
          className="space-y-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!description.trim()) {
              setError('Escribe el nombre del producto.');
              return;
            }
            if (!validUnitPrice) {
              setError('Escribe un precio válido mayor que cero.');
              return;
            }
            if (!validQuantity) {
              setError('Escribe una cantidad válida mayor que cero.');
              return;
            }
            onAdd({
              description: description.trim(),
              unit: 'UNIT',
              unitPrice: Math.round(parsedUnitPrice * 100) / 100,
              quantity: Math.round(parsedQuantity * 100) / 100,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="common-product-name">Nombre</Label>
            <Input
              id="common-product-name"
              autoFocus
              maxLength={160}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Ej. Botella de agua especial"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="common-product-price">Precio unitario sin ITBIS</Label>
              <Input
                id="common-product-price"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="common-product-quantity">Cantidad</Label>
              <Input
                id="common-product-quantity"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
          </div>
          <div className="rounded-lg border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span>ITBIS por unidad (18%)</span>
              <span>{formatMoney(unitTax)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 font-semibold text-zinc-950">
              <span>Precio final por unidad</span>
              <span>{formatMoney(finalUnitPrice)}</span>
            </div>
            {validQuantity && parsedQuantity !== 1 ? (
              <div className="mt-2 flex items-center justify-between gap-3 border-t border-blue-100 pt-2 font-semibold text-blue-700">
                <span>Total por {parsedQuantity} unidades</span>
                <span>{formatMoney(finalTotal)}</span>
              </div>
            ) : null}
          </div>
          {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit">Agregar al carrito</Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
