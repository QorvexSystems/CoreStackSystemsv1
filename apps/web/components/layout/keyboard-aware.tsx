'use client';

import { useEffect } from 'react';

const TEXT_INPUT = /^(text|email|tel|number|search|password|url|date|datetime-local|time|month)$/;

function wantsKeyboard(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.getAttribute('inputmode') === 'none') return false; // usa el pad numérico propio
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) return !element.readOnly && TEXT_INPUT.test(element.type || 'text');
  return element.isContentEditable;
}

/**
 * En tablets y celulares: cuando se abre el teclado, el campo activo sube al centro de la parte visible
 * (también dentro de los diálogos) y se agrega espacio abajo para que el teclado no tape el contenido.
 */
export function KeyboardAware() {
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const viewport = window.visualViewport;
    let timer: number | undefined;

    const reveal = () => {
      const active = document.activeElement;
      if (!wantsKeyboard(active)) return;
      window.clearTimeout(timer);
      // Espera a que el teclado termine de abrir.
      timer = window.setTimeout(() => active.scrollIntoView({ block: 'center', behavior: 'smooth' }), 280);
    };

    const onViewportResize = () => {
      if (!viewport) return;
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.body.style.paddingBottom = inset > 80 ? `${inset}px` : '';
      document.documentElement.style.setProperty('--keyboard-inset', `${inset > 80 ? inset : 0}px`);
      if (inset > 80) reveal();
    };

    document.addEventListener('focusin', reveal);
    viewport?.addEventListener('resize', onViewportResize);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('focusin', reveal);
      viewport?.removeEventListener('resize', onViewportResize);
      document.body.style.paddingBottom = '';
    };
  }, []);
  return null;
}
