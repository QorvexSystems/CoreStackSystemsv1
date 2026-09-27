'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type OrderActivityDrawerProps = {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
};

export function OrderActivityDrawer({
  open,
  title,
  description,
  onClose,
  children,
}: OrderActivityDrawerProps) {
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
        aria-label="Cerrar panel"
        onClick={onClose}
        className={cn(
          'fixed inset-x-0 bottom-0 top-16 z-40 bg-zinc-950/35 backdrop-blur-[2px] transition-opacity lg:left-[4.5rem]',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-hidden={!open}
        inert={!open}
        aria-label={title}
        className={cn(
          'fixed bottom-20 right-0 top-16 z-50 flex w-full flex-col border-l border-zinc-200 bg-zinc-50 shadow-2xl transition-transform duration-300 ease-out sm:w-[min(32rem,calc(100vw-1rem))] md:w-[46vw] md:min-w-[26rem] md:max-w-[32rem] lg:bottom-0',
          open ? 'visible translate-x-0' : 'invisible translate-x-full',
        )}
      >
        <header className="flex min-h-20 items-start justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-4">
          <div className="min-w-0">
            <h2 className="font-semibold text-zinc-950">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Cerrar panel"
          >
            <X className="h-5 w-5" />
          </Button>
        </header>
        <div className="surface-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
          {children}
        </div>
      </aside>
    </>,
    document.body,
  );
}
