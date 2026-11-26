'use client';

import { ChevronRight, ShoppingCart, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn, formatCurrency } from '@/lib/utils';

type OrderCheckoutDialogProps = {
  open: boolean;
  itemCount: number;
  total: number;
  onClose: () => void;
  onClear: () => void;
  clearDisabled?: boolean;
  children: ReactNode;
  footer: ReactNode;
};

export function OrderCheckoutDialog({
  open,
  itemCount,
  total,
  onClose,
  onClear,
  clearDisabled = false,
  children,
  footer,
}: OrderCheckoutDialogProps) {
  const [mounted, setMounted] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => setMounted(true), []);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
      previousFocus?.focus();
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-[70] flex items-center justify-center p-3 transition-opacity sm:p-6',
        open ? 'visible opacity-100' : 'invisible pointer-events-none opacity-0',
      )}
    >
      <button type="button" aria-label="Cerrar ventana de la orden" onClick={onClose}
        className="absolute inset-0 bg-zinc-950/50 backdrop-blur-[2px]" />
      <section
        id="order-checkout-dialog"
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-hidden={!open}
        inert={!open}
        aria-labelledby="order-checkout-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          )).filter((element) => element.offsetParent !== null);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl sm:max-h-[min(88dvh,56rem)]"
      >
        <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShoppingCart className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p id="order-checkout-title" className="font-semibold text-zinc-950">Tu orden</p>
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
              disabled={!itemCount || clearDisabled}
              className="text-danger hover:bg-danger/5 hover:text-danger"
            >
              Limpiar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              ref={closeButtonRef}
              onClick={onClose}
              aria-label="Cerrar ventana"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="surface-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain bg-zinc-50 p-3 sm:p-5">
          {children}
        </div>
        <div className="shrink-0 border-t border-zinc-200 bg-white px-4 py-3 sm:px-5">
          {footer}
        </div>
      </section>
    </div>,
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
        aria-controls="order-checkout-dialog"
        aria-label={`Abrir resumen para finalizar la orden de ${itemCount} productos`}
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
