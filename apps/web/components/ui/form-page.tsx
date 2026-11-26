'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Pantalla completa para crear o editar información (en vez de un popup): más espacio, textos y campos
 * más grandes para uso táctil en tablet, y botones fijos abajo.
 */
export function FormPage({
  eyebrow,
  title,
  description,
  icon,
  onBack,
  backLabel = 'Volver',
  children,
  footer,
  confirmLabel,
  cancelLabel,
  confirmDisabled,
  isPending,
  onConfirm,
  onCancel,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  onBack: () => void;
  backLabel?: string;
  children: ReactNode;
  /** Pie propio; si no se indica, se usan los botones Cancelar/Confirmar. */
  footer?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  isPending?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  return (
    // Ocupa toda el área de trabajo (sin tarjetas ni márgenes): más aire para leer y tocar en la tablet.
    <div className="-mx-3 -my-4 flex min-h-[calc(100dvh-4rem)] flex-col bg-white sm:-mx-5 sm:-my-5">
      <header className="flex items-center gap-4 border-b border-slate-200 px-4 py-4 sm:px-8 lg:px-10">
        <button
          type="button"
          onClick={onBack}
          className="flex h-12 shrink-0 items-center gap-2 rounded-xl border border-slate-200 px-4 text-base font-bold text-slate-700 active:bg-slate-50"
        >
          <ArrowLeft className="h-5 w-5" /> <span className="hidden sm:inline">{backLabel}</span>
        </button>
        {icon ? (
          <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-teal text-white sm:flex">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal">{eyebrow}</p>
          ) : null}
          <h1 className="truncate text-2xl font-extrabold text-slate-950 sm:text-3xl">{title}</h1>
          {description ? <p className="text-base text-slate-500">{description}</p> : null}
        </div>
      </header>

      <section
        className={cn(
          'flex-1 px-4 py-6 sm:px-8 lg:px-10 lg:py-8',
          // Campos y textos grandes para dedos en tablet.
          '[&_input:not([type=checkbox])]:h-14 [&_input]:text-lg [&_label]:text-base [&_select]:h-14 [&_select]:text-lg [&_textarea]:text-lg',
        )}
      >
        {children}
      </section>

      {footer !== undefined ? (
        footer
      ) : onConfirm ? (
        <div className="sticky bottom-20 z-10 flex items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-8 lg:bottom-0 lg:px-10">
          <button
            type="button"
            onClick={onCancel ?? onBack}
            disabled={isPending}
            className="h-14 rounded-xl border border-slate-300 px-8 text-lg font-bold text-slate-700 disabled:opacity-50"
          >
            {cancelLabel ?? 'Cancelar'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || isPending}
            className="flex h-14 min-w-[12rem] items-center justify-center gap-2 rounded-xl bg-teal px-10 text-lg font-bold text-white disabled:opacity-40"
          >
            {isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            {confirmLabel ?? 'Guardar'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
