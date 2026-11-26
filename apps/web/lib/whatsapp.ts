export function normalizeWhatsappPhone(value: string): string | null {
  let digits = value.replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) digits = `1${digits}`;
  return /^[1-9][0-9]{10,14}$/.test(digits) ? digits : null;
}

export function whatsappChatUrl(phone: string, text: string): string | null {
  const target = normalizeWhatsappPhone(phone);
  return target ? `https://wa.me/${target}?text=${encodeURIComponent(text)}` : null;
}
