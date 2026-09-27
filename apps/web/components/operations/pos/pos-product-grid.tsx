'use client';

import { Package, Plus, ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Product } from '@/lib/api';
import { cn, formatCurrency } from '@/lib/utils';
import {
  canAddProduct,
  formatQuantity,
  getAvailableStock,
  getProductInitials,
  getProductPrice,
} from './pos-utils';

type PosProductGridProps = {
  products: Product[];
  quantitiesByProduct: Record<string, number>;
  inventorySource?: 'SALES_INVENTORY' | 'WAREHOUSE';
  isLoading?: boolean;
  onAddProduct: (product: Product) => void;
};

export function PosProductGrid({
  products,
  quantitiesByProduct,
  inventorySource = 'SALES_INVENTORY',
  isLoading,
  onAddProduct,
}: PosProductGridProps) {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="h-44 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm"
          >
            <div className="flex gap-3">
              <div className="h-20 w-20 shrink-0 rounded-lg bg-zinc-100" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-4 w-3/4 rounded-sm bg-zinc-100" />
                <div className="h-3 w-1/2 rounded-sm bg-zinc-100" />
                <div className="h-5 w-2/5 rounded-sm bg-zinc-100" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!products.length) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-muted-foreground">
        No hay productos para esa búsqueda. Prueba con nombre, SKU, marca o código.
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {products.map((product) => {
        const quantityInCart = quantitiesByProduct[product.id] ?? 0;
        const availableStock = getAvailableStock(product);
        const lowStock = product.trackInventory && availableStock <= Number(product.minStock);
        const outOfStock = product.trackInventory && availableStock <= 0;
        const disabled = !canAddProduct(product, quantityInCart);

        return (
          <article
            key={product.id}
            className={cn(
              'group flex min-h-44 flex-col rounded-xl border border-zinc-200 bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md',
              outOfStock && 'opacity-60',
            )}
          >
            <div className="flex gap-3">
              <ProductImage product={product} />
              <div className="min-w-0 flex-1">
                <Badge
                  variant={outOfStock ? 'danger' : lowStock ? 'warning' : 'success'}
                  className="mb-2 max-w-full"
                >
                  {outOfStock
                    ? 'Sin stock'
                    : inventorySource === 'WAREHOUSE'
                      ? `Almacén · ${formatQuantity(availableStock)}`
                      : product.trackInventory
                        ? lowStock
                          ? `Stock bajo · ${formatQuantity(availableStock)}`
                          : `En stock · ${formatQuantity(availableStock)}`
                        : 'Servicio'}
                </Badge>
                <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-zinc-950">
                  {product.name}
                </h3>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  SKU: {product.sku ?? product.barcode ?? 'Sin código'}
                </p>
              </div>
            </div>

            <div className="mt-auto flex items-end justify-between gap-3 pt-3">
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground">
                  {product.category?.name ?? 'Sin tipo'} · {product.brand ?? 'Sin proveedor'}
                </p>
                <p className="mt-0.5 text-lg font-bold tracking-tight text-zinc-950">
                  {formatCurrency(getProductPrice(product))}
                </p>
              </div>
              <Button
                type="button"
                size="icon"
                disabled={disabled}
                onClick={() => onAddProduct(product)}
                className="h-11 w-11 shrink-0 rounded-lg"
                aria-label={`Agregar ${product.name} al carrito`}
              >
                {quantityInCart ? (
                  <Plus className="h-5 w-5" />
                ) : (
                  <ShoppingCart className="h-5 w-5" />
                )}
              </Button>
            </div>

            {quantityInCart ? (
              <p className="mt-2 rounded-md bg-primary/5 px-2 py-1 text-xs font-medium text-primary">
                {formatQuantity(quantityInCart)} en el carrito
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function ProductImage({ product }: { product: Product }) {
  const [failed, setFailed] = useState(false);

  if (product.imageUrl && !failed) {
    return (
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-100 p-2">
        <img
          src={product.imageUrl}
          alt={product.name}
          className="max-h-full max-w-full object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
      <Package className="h-8 w-8" aria-hidden="true" />
      <span className="sr-only">Imagen no disponible: {getProductInitials(product)}</span>
    </div>
  );
}
