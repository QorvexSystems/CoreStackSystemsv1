export function normalizeBarcodeInput(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function getBarcodeLookupCandidates(value: string) {
  const normalized = normalizeBarcodeInput(value);
  const candidates = new Set<string>();

  addCandidate(candidates, normalized);

  const withoutAimPrefix = normalized.replace(/^\][A-Z][0-9]/, '');
  addCandidate(candidates, withoutAimPrefix);

  const compact = withoutAimPrefix.replace(/[^A-Z0-9]/g, '');
  addCandidate(candidates, compact);

  const qvInternalMatch = compact.match(/^QV([A-Z]{2,4})(\d{6})$/);

  if (qvInternalMatch) {
    addCandidate(candidates, `QV-${qvInternalMatch[1]}-${qvInternalMatch[2]}`);
  }

  const digits = withoutAimPrefix.replace(/\D/g, '');
  addCandidate(candidates, digits);

  if (digits.length === 14 && digits.startsWith('0')) {
    addCandidate(candidates, digits.slice(1));
  }

  const gs1GtinMatch = digits.match(/^01(\d{14})/);

  if (gs1GtinMatch) {
    addCandidate(candidates, gs1GtinMatch[1]);

    if (gs1GtinMatch[1].startsWith('0')) {
      addCandidate(candidates, gs1GtinMatch[1].slice(1));
    }
  }

  if (digits.length > 13) {
    addCandidate(candidates, digits.slice(-13));
  }

  return [...candidates];
}

function addCandidate(candidates: Set<string>, value: string | undefined) {
  if (value) {
    candidates.add(value);
  }
}
