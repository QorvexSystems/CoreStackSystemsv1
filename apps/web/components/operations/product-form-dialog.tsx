'use client';

import { PackagePlus, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { ProductForm } from './product-form';

type ProductFormDialogProps = {
  open: boolean;
  productId?: string;
  onClose: () => void;
  onSaved: () => void;
};

export function ProductFormDialog({ open, productId, onClose, onSaved }: ProductFormDialogProps) {
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!mounted || !open) return null;

  const editing = Boolean(productId);
  const dialogTitleId = editing ? 'edit-product-dialog-title' : 'new-product-dialog-title';
  const DialogIcon = editing ? Pencil : PackagePlus;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/55 p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.35)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <DialogIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 id={dialogTitleId} className="text-lg font-semibold text-zinc-950">
                {editing ? 'Editar producto' : 'Nuevo producto'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {editing
                  ? 'Actualiza la ficha del producto y guarda los cambios.'
                  : 'Completa la ficha para agregarlo al catálogo de ALLPA.'}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Cerrar formulario"
          >
            <X className="h-5 w-5" />
          </Button>
        </header>

        <div className="surface-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <ProductForm key={productId ?? 'new'} productId={productId} embedded onSaved={onSaved} onCancel={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
