'use client';

import { CompanyDocumentDetails } from './company-document-details';
import { ReceptionClauses } from './reception-clauses';
import { brand } from '@/lib/brand';
import type { WorkshopTicket } from '@/lib/api';

export function WorkshopReceptionDocument({ ticket }: { ticket: WorkshopTicket }) {
  const reception = ticket.reception;
  const date = (value?: string | null) =>
    value
      ? new Date(value).toLocaleString('es-DO', {
          timeZone: 'America/Santo_Domingo',
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '—';
  const fields = [
    ['Cliente', ticket.customer.name],
    ['Teléfono', ticket.customer.phone],
    ['Vehículo', `${ticket.vehicle.make} ${ticket.vehicle.model} ${ticket.vehicle.year ?? ''}`],
    ['Placa', ticket.vehicle.licensePlate],
    ['Color', ticket.vehicle.color],
    ['VIN / chasis', ticket.vehicle.vin],
    [
      'Kilometraje de entrada',
      reception ? `${Number(reception.mileage).toLocaleString('es-DO')} km` : null,
    ],
    ['Combustible', reception?.fuelLevel],
    ['Fecha de recepción', date(reception?.receivedAt)],
    ['Recibido por', reception?.createdBy.name],
  ];
  return (
    <article className="reception-document flex min-h-[960px] flex-col rounded-xl border bg-white p-6 text-zinc-950 sm:p-8 print:rounded-none print:border-0 print:p-0">
      <header className="flex items-center justify-between gap-5 border-b border-zinc-200 pb-5">
        <div className="flex items-center gap-4">
          <img
            src={brand.logoPath}
            alt={`Logo ${brand.name}`}
            className="h-20 w-20 object-contain"
          />
          <div>
            <p className="text-lg font-bold">{brand.name}</p>
            <p className="text-xs text-zinc-500">{brand.businessType}</p>
            <CompanyDocumentDetails />
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-[.18em] text-zinc-500">
            Recepción de vehículo
          </p>
          <p className="mt-1 text-xl font-semibold">{ticket.ticketNumber}</p>
          <p className="mt-1 text-xs text-zinc-500">Copia del cliente</p>
        </div>
      </header>
      {!reception ? (
        <p className="mt-5 text-sm">Esta orden no tiene un formulario de recepción registrado.</p>
      ) : (
        <>
          <dl className="reception-fields my-6 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3 print:grid-cols-3">
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</dt>
                <dd className="mt-1 break-words text-sm font-medium">{value || 'No registrado'}</dd>
              </div>
            ))}
          </dl>
          <div className="reception-notes space-y-4 border-t border-zinc-200 pt-5">
            {[
              ['Motivo de ingreso', ticket.complaint],
              ['Condición exterior', reception.exteriorCondition],
              ['Condición interior', reception.interiorCondition],
              ['Testigos del tablero', reception.warningLights],
              ['Accesorios', reception.accessories],
              ['Pertenencias', reception.belongings],
              ['Observaciones de recepción', reception.observations],
            ].map(([label, value]) => (
              <section key={label} className="break-inside-avoid">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {label}
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                  {value || 'Sin observaciones registradas'}
                </p>
              </section>
            ))}
          </div>
          {reception.imageUrls.length ? (
            <section className="reception-photos mt-6 break-inside-avoid border-t border-zinc-200 pt-4">
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Evidencias del vehículo
              </h3>
              <div className="grid grid-cols-3 gap-3">
                {reception.imageUrls.map((url, index) => (
                  <figure key={url}>
                    <img
                      src={url}
                      alt={`Evidencia ${index + 1}`}
                      className="h-32 w-full rounded-md border object-contain"
                    />
                    <figcaption className="mt-1 text-[10px] text-zinc-500">
                      Evidencia {index + 1}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}
          <section className="reception-signature mt-8 break-inside-avoid border-t border-zinc-200 pt-5">
            <p className="text-xs text-zinc-500">
              Constancia de los datos y del estado del vehículo registrados al momento de su
              recepción.
            </p>
            <div className="mt-5 max-w-xs">
              {reception.signatureUrl ? (
                <img
                  src={reception.signatureUrl}
                  alt="Firma del cliente"
                  className="h-24 w-full object-contain"
                />
              ) : (
                <div className="h-24" />
              )}
              <p className="border-t border-zinc-400 pt-2 text-center text-xs">
                {ticket.customer.name} · Firma del cliente
              </p>
              <p className="mt-1 text-center text-[10px] text-zinc-500">
                {reception.signatureUrl
                  ? `Firma registrada el ${date(reception.signedAt)}`
                  : 'Sin firma digital registrada · Firma opcional'}
              </p>
            </div>
          </section>
          <div className="mt-auto pt-4">
            <ReceptionClauses compact />
          </div>
        </>
      )}
      <footer className="mt-7 border-t border-zinc-200 pt-3 text-[10px] text-zinc-400">
        {brand.name} · Recepción de vehículo · {ticket.ticketNumber}
      </footer>
    </article>
  );
}
