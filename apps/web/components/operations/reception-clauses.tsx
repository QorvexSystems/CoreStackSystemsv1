export const RECEPTION_CLAUSES = [
  'Después de 120 días no hay devolución de piezas, motores, transmisiones o repuestos dejados en este taller.',
  'Después de 10 días del vehículo estar listo para la entrega, se cobrará RD$500 por cada día adicional.',
  'El cliente dispone de 3 días después de la entrega del vehículo para reportar cualquier inconformidad con el trabajo realizado.',
] as const;

export function ReceptionClauses({ compact = false }: { compact?: boolean }) {
  return (
    <section
      aria-label="Condiciones de recepción y estadía"
      className={`reception-clauses break-inside-avoid rounded-lg border border-zinc-300 bg-zinc-50 text-zinc-950 ${compact ? 'p-3 text-[10px]' : 'p-4 text-sm'}`}
    >
      <h3
        className={
          compact
            ? 'text-[10px] font-bold uppercase tracking-wide'
            : 'text-xs font-bold uppercase tracking-wide'
        }
      >
        Condiciones de recepción y estadía
      </h3>
      <ol
        className={`mt-2 list-decimal pl-5 leading-relaxed ${compact ? 'space-y-1 text-[10px]' : 'space-y-2 text-sm'}`}
      >
        {RECEPTION_CLAUSES.map((clause) => (
          <li key={clause}>{clause}</li>
        ))}
      </ol>
    </section>
  );
}
