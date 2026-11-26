'use client';

import { createPortal } from 'react-dom';
import { useEffect, useState, type ReactNode } from 'react';

/** Tracks the visible screen, including tablet keyboards and browser toolbars. */
export function KeyboardDialogLayer({ children, onDismiss, className = '', label, lockBody = true }: {
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
  label?: string;
  lockBody?: boolean;
}) {
  const [viewport, setViewport] = useState<{ top: number; left: number; height: number; width: number } | null>(null);
  useEffect(() => {
    const visual = window.visualViewport;
    let timer: ReturnType<typeof setTimeout>;
    const reveal = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest('[data-keyboard-dialog]'))
          active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }, 80);
    };
    const update = () => {
      setViewport({ top: visual?.offsetTop ?? 0, left: visual?.offsetLeft ?? 0, height: visual?.height ?? window.innerHeight, width: visual?.width ?? window.innerWidth });
      reveal();
    };
    update();
    const previous = document.body.style.overflow;
    if (lockBody) document.body.style.overflow = 'hidden';
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', reveal);
    return () => {
      clearTimeout(timer);
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', reveal);
      if (lockBody) document.body.style.overflow = previous;
    };
  }, [lockBody]);
  if (!viewport) return null;
  return createPortal(
    <div data-keyboard-dialog aria-label={label} className={`fixed z-[115] flex items-center justify-center overflow-hidden bg-slate-950/65 p-3 backdrop-blur-sm [&_input]:text-base [&_textarea]:text-base [&_select]:text-base ${className}`}
      style={{ top: viewport.top, left: viewport.left, height: viewport.height, width: viewport.width }}
      onMouseDown={(event) => event.target === event.currentTarget && onDismiss?.()}>
      {children}
    </div>, document.body,
  );
}
