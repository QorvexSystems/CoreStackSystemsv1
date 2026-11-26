'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ActionDialog } from '@/components/ui/action-dialog';
import { ReceptionClauses } from './reception-clauses';
import { Button } from '@/components/ui/button';

export function ReceptionSignatureDialog({ customerName, summary, pending, onClose, onConfirm }: {
  customerName: string;
  summary: React.ReactNode;
  pending: boolean;
  onClose: () => void;
  onConfirm: (dataUrl?: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<{ id: number; x: number; y: number; distance: number } | null>(null);
  const ink = useRef(false);
  const [signature, setSignature] = useState<string | null>(null);

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    ink.current = false;
    stroke.current = null;
    setSignature(null);
  };
  useEffect(clear, []);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * event.currentTarget.width / bounds.width,
      y: (event.clientY - bounds.top) * event.currentTarget.height / bounds.height,
    };
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current?.id !== event.pointerId) return;
    stroke.current = null;
    setSignature(ink.current ? event.currentTarget.toDataURL('image/png') : null);
  };

  return (
    <ActionDialog
      open
      size="lg"
      title="Firma del formulario de recepción"
      description={`${customerName}, revisa los datos y firma con el lápiz o el dedo si deseas dejar constancia. La firma es opcional.`}
      summary={summary}
      confirmLabel={signature ? "Confirmar firma y guardar recepción" : "Guardar recepción sin firma"}
      cancelLabel="Volver al formulario"
      isPending={pending}
      onClose={onClose}
      onConfirm={() => onConfirm(signature ?? undefined)}
    >
      <ReceptionClauses />
      <p className="text-sm text-muted-foreground">Confirmo los datos y las evidencias registrados en esta recepción.</p>
      <canvas
        ref={canvasRef}
        width={1000}
        height={360}
        aria-label="Pizarra para la firma del cliente"
        className="block aspect-[25/9] w-full touch-none rounded-xl border-2 border-dashed border-slate-400 bg-white"
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => {
          if (pending || stroke.current || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          stroke.current = { id: event.pointerId, ...point(event), distance: 0 };
          setSignature(null);
        }}
        onPointerMove={(event) => {
          const previous = stroke.current;
          if (pending || !previous || previous.id !== event.pointerId) return;
          event.preventDefault();
          const next = point(event);
          const context = event.currentTarget.getContext('2d');
          if (!context) return;
          context.strokeStyle = '#172033';
          context.lineWidth = 3;
          context.lineCap = 'round';
          context.lineJoin = 'round';
          context.beginPath();
          context.moveTo(previous.x, previous.y);
          context.lineTo(next.x, next.y);
          context.stroke();
          const distance = previous.distance + Math.hypot(next.x - previous.x, next.y - previous.y);
          stroke.current = { id: event.pointerId, ...next, distance };
          if (distance > 8) ink.current = true;
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Firma dentro del recuadro. Puedes borrarla y volver a intentarlo.</span>
        <Button type="button" variant="outline" onClick={clear} disabled={pending}>Borrar firma</Button>
      </div>
    </ActionDialog>
  );
}
