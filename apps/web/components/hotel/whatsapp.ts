/** Enlace de WhatsApp para un teléfono dominicano (10 dígitos → +1) o internacional. */
export function whatsappUrl(phone: string | null | undefined, text?: string) {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const international = digits.length === 10 ? `1${digits}` : digits;
  return `https://wa.me/${international}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
