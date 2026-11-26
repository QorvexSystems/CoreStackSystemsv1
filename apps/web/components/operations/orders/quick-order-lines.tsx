'use client';

import { Minus, Package, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCurrency } from '@/lib/utils';
import { formatQuantity, getAvailableStock, getQuantityStep } from '../pos/pos-utils';
import type { CartItem } from '../pos/types';

type Props = {
  items: CartItem[];
  disabled?: boolean;
  onUpdateQuantity: (productId: string, quantity: number) => void;
};

export function QuickOrderLines({ items, disabled = false, onUpdateQuantity }: Props) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-5 py-10 text-center">
        <Package className="mx-auto mb-3 h-9 w-9 text-zinc-400" />
        <p className="font-medium text-zinc-800">Todavía no hay productos en esta orden</p>
        <p className="mt-1 text-sm text-zinc-500">Escanea un código o busca un producto para empezar.</p>
      </div>
    );
  }

  return (
    <ol className="space-y-2" aria-label="Productos en orden de incorporación">
      {items.map((item, index) => {
        const product = item.product;
        const step = getQuantityStep(product);
        const available = getAvailableStock(product);
        const unitPrice = item.quantity > 0 ? Number(item.total ?? 0) / item.quantity : 0;
        return (
          <li key={product.id} className="rounded-xl border border-zinc-200 bg-white p-3 sm:p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">
                {index + 1}
              </span>
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-100">
                {product.imageUrl ? (
                  // The catalog already stores the image URL; no placeholder imagery is generated.
                  <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : <Package className="h-6 w-6 text-zinc-400" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug text-zinc-950">{product.name}</p>
                {!item.commonProduct ? (
                  <span className={product.inventoryDestination === 'WAREHOUSE'
                    ? 'mt-1 inline-flex rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900'
                    : 'mt-1 inline-flex rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800'}>
                    {product.inventoryDestination === 'WAREHOUSE' ? 'Almacén B2B' : 'Inventario'}
                  </span>
                ) : null}
                <p className="mt-0.5 text-xs text-zinc-500">
                  {[product.sku || product.barcode, product.category?.name].filter(Boolean).join(' · ')}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {item.commonProduct ? 'Producto común · sin inventario' : (product.trackInventory || product.inventoryDestination === 'WAREHOUSE')
                    ? `Existencia: ${formatQuantity(available)}` : 'Sin control de existencia'}
                </p>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onUpdateQuantity(product.id, 0)}
                aria-label={`Quitar ${product.name}`}
                className="rounded-md p-2 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-3">
              <div className="flex items-center gap-2">
                <Button type="button" size="icon" variant="outline" className="h-9 w-9" disabled={disabled}
                  onClick={() => onUpdateQuantity(product.id, item.quantity - step)} aria-label={`Reducir ${product.name}`}>
                  <Minus className="h-4 w-4" />
                </Button>
                <Input type="number" value={item.quantity} min={step} step={step} disabled={disabled}
                  onChange={(event) => {
                    if (event.target.value !== '') onUpdateQuantity(product.id, Number(event.target.value));
                  }}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label={`Cantidad de ${product.name}`} className="h-9 w-16 text-center font-semibold" />
                <Button type="button" size="icon" variant="outline" className="h-9 w-9"
                  disabled={disabled || (product.trackInventory && item.quantity + step > available)}
                  onClick={() => onUpdateQuantity(product.id, item.quantity + step)} aria-label={`Aumentar ${product.name}`}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="text-right">
                <p className="text-xs text-zinc-500">{formatCurrency(unitPrice)} × {formatQuantity(item.quantity)}</p>
                <p className="text-base font-bold text-zinc-950">{formatCurrency(Number(item.total ?? 0))}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
