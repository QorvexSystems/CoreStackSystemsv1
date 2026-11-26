import { brand } from './brand';

export function appointmentWhatsappMessage(appointment: {
  startsAt: string;
  reason: string;
  customer: { name: string };
  vehicle: { make: string; model: string; licensePlate?: string | null };
}) {
  const date = new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(appointment.startsAt));
  const time = new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(appointment.startsAt));
  const vehicle = [
    appointment.vehicle.make,
    appointment.vehicle.model,
    appointment.vehicle.licensePlate,
  ]
    .filter(Boolean)
    .join(' · ');
  return `Hola ${appointment.customer.name}, le compartimos los datos de su cita en ${brand.name}:\n\nFecha: ${date}\nHora: ${time}\nVehículo: ${vehicle}\nMotivo: ${appointment.reason}\n\nDirección: ${brand.address}\nTel.: ${brand.phone}\n\nPor favor, confirme su asistencia respondiendo a este mensaje.`;
}
