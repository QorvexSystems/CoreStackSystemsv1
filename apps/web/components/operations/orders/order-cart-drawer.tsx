'use client';

import { ChevronRight, ShoppingCart, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn, formatCurrency } from '@/lib/utils';

type OrderCartDrawerProps = {
  open: boolean;
  itemCount: number;
  total: number;
  onClose: () => void;
  onClear: () => void;
  children: ReactNode;
};

export function OrderCartDrawer({
  open,
  itemCount,
  total,
  onClose,
  onClear,
  children,
}: OrderCartDrawerProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, open]);

  if (!mounted) return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Cerrar carrito"
        onClick={onClose}
        className={cn(
          'fixed inset-x-0 bottom-0 top-16 z-40 bg-zinc-950/35 backdrop-blur-[2px] transition-opacity lg:left-[4.5rem]',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        id="order-cart-drawer"
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-hidden={!open}
        inert={!open}
        aria-label="Carrito y datos de la orden"
        className={cn(
          'fixed bottom-20 right-0 top-16 z-50 flex w-full flex-col border-l border-zinc-200 bg-zinc-50 shadow-2xl transition-transform duration-300 ease-out sm:w-[min(30rem,calc(100vw-1rem))] md:w-[45vw] md:min-w-[25rem] md:max-w-[28.75rem] lg:bottom-0',
          open ? 'visible translate-x-0' : 'invisible translate-x-full',
        )}
      >
        <div className="flex min-h-16 items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShoppingCart className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-zinc-950">Tu orden</p>
              <p className="truncate text-xs text-muted-foreground">
                {itemCount} producto(s) · {formatCurrency(total)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClear}
              disabled={!itemCount}
              className="text-danger hover:bg-danger/5 hover:text-danger"
            >
              Limpiar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Cerrar panel"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="surface-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
          {children}
        </div>
      </aside>
    </>,
    document.body,
  );
}

type CartSummaryBarProps = {
  itemCount: number;
  total: number;
  onOpen: () => void;
};

export function CartSummaryBar({ itemCount, total, onOpen }: CartSummaryBarProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed bottom-24 left-3 right-3 z-30 sm:left-auto sm:right-6 sm:w-auto lg:bottom-5">
      <button
        type="button"
        aria-controls="order-cart-drawer"
        aria-label={`Abrir carrito con ${itemCount} productos`}
        onClick={onOpen}
        className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-left text-white shadow-[0_14px_36px_rgba(9,9,11,0.24)] transition hover:-translate-y-0.5 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
          <ShoppingCart className="h-5 w-5" />
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-bold text-zinc-950">
            {itemCount > 99 ? '99+' : itemCount}
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold sm:flex-none">
          Carrito · {itemCount} producto(s) ·{' '}
          <strong className="font-bold">{formatCurrency(total)}</strong>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-zinc-300" aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
