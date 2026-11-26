'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, SearchX, ShieldAlert } from 'lucide-react';
import { useEffect } from 'react';
import { lookupTaxIdentity, type TaxIdentityLookup } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { validateDominicanDocument } from '@/lib/dominican-documents';

export type TaxDocumentType = 'CEDULA' | 'RNC' | 'PASSPORT';

const fieldClass =
  'mt-1 h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/10';

/**
 * Cédula / RNC / pasaporte con búsqueda del nombre en el padrón de la DGII. La consulta solo se hace
 * cuando el número pasa el dígito verificador, así no se dispara en cada tecla.
 */
export function TaxIdentityField({
  documentType,
  documentNumber,
  onChange,
  onNameFound,
  allowPassport = true,
  label = 'Documento',
}: {
  documentType: TaxDocumentType;
  documentNumber: string;
  onChange: (value: { documentType: TaxDocumentType; documentNumber: string }) => void;
  /** Se llama una vez por documento encontrado, con el nombre o razón social registrado. */
  onNameFound?: (result: TaxIdentityLookup) => void;
  allowPassport?: boolean;
  label?: string;
}) {
  const fiscalType = documentType === 'PASSPORT' ? null : documentType;

  return (
    <div className="sm:col-span-2">
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <label className="block text-xs font-semibold text-slate-700">
          Tipo de documento
          <select
            className={fieldClass}
            value={documentType}
            onChange={(event) =>
              onChange({ documentType: event.target.value as TaxDocumentType, documentNumber })
            }
          >
            <option value="CEDULA">Cédula</option>
            <option value="RNC">RNC</option>
            {allowPassport ? <option value="PASSPORT">Pasaporte</option> : null}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          {label}
          <input
            className={fieldClass}
            inputMode={documentType === 'PASSPORT' ? 'text' : 'numeric'}
            placeholder={
              documentType === 'RNC' ? '1-01-12345-6' : documentType === 'CEDULA' ? '001-1234567-8' : 'Número de pasaporte'
            }
            value={documentNumber}
            maxLength={documentType === 'PASSPORT' ? 30 : 15}
            onChange={(event) => onChange({ documentType, documentNumber: event.target.value })}
          />
        </label>
      </div>
      {fiscalType ? (
        <TaxLookupHint documentType={fiscalType} documentNumber={documentNumber} onNameFound={onNameFound} />
      ) : null}
    </div>
  );
}

/** Busca la cédula/RNC en el padrón DGII (cuando pasa el dígito verificador) y muestra el resultado. */
export function TaxLookupHint({
  documentType,
  documentNumber,
  onNameFound,
}: {
  documentType: 'RNC' | 'CEDULA';
  documentNumber: string;
  onNameFound?: (result: TaxIdentityLookup) => void;
}) {
  const session = getSession();
  const digits = documentNumber.replace(/\D/g, '');
  const checksumValid = validateDominicanDocument(documentType, digits);
  const lookup = useQuery({
    queryKey: ['tax-identity', session?.tenantId, documentType, digits],
    queryFn: () => lookupTaxIdentity(session!.tenantId, session!.accessToken, documentType, digits),
    enabled: Boolean(session && checksumValid),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (lookup.data?.outcome === 'FOUND' && lookup.data.documentNumber === digits)
      onNameFound?.(lookup.data);
    // Solo cuando llega un resultado nuevo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup.data]);

  if (!digits.length) return null;
  const expectedLength = documentType === 'RNC' ? 9 : 11;
  return (
    <LookupStatus
      loading={lookup.isFetching}
      incomplete={digits.length < expectedLength}
      invalid={digits.length >= expectedLength && !checksumValid}
      result={lookup.data}
      error={lookup.error as Error | null}
      documentLabel={documentType === 'RNC' ? 'RNC' : 'cédula'}
    />
  );
}

function LookupStatus({
  loading,
  incomplete,
  invalid,
  result,
  error,
  documentLabel,
}: {
  loading: boolean;
  incomplete: boolean;
  invalid: boolean;
  result?: TaxIdentityLookup;
  error: Error | null;
  documentLabel: string;
}) {
  if (incomplete) return null;
  if (invalid)
    return (
      <Hint tone="rose" icon={ShieldAlert}>
        El número de {documentLabel} no es válido. Revisa los dígitos.
      </Hint>
    );
  if (loading)
    return (
      <Hint tone="slate" icon={Loader2} spin>
        Buscando en el padrón de la DGII…
      </Hint>
    );
  if (error)
    return (
      <Hint tone="amber" icon={ShieldAlert}>
        No se pudo consultar el padrón. Puedes escribir el nombre manualmente.
      </Hint>
    );
  if (!result) return null;
  if (result.outcome === 'FOUND')
    return (
      <Hint tone="emerald" icon={CheckCircle2}>
        <span className="font-bold">{result.name}</span>
        {result.commercialName ? ` · ${result.commercialName}` : ''}
        {result.status && result.status !== 'ACTIVO' ? ` · Estado DGII: ${result.status}` : ''}
      </Hint>
    );
  if (result.outcome === 'UNAVAILABLE')
    return (
      <Hint tone="amber" icon={ShieldAlert}>
        El padrón de la DGII aún no está cargado. Escribe el nombre manualmente.
      </Hint>
    );
  return (
    <Hint tone="slate" icon={SearchX}>
      No aparece en el padrón de la DGII (solo incluye contribuyentes registrados). Escribe el nombre
      manualmente.
    </Hint>
  );
}

const tones = {
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  rose: 'border-rose-200 bg-rose-50 text-rose-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  slate: 'border-slate-200 bg-slate-50 text-slate-600',
};

function Hint({
  tone,
  icon: Icon,
  spin,
  children,
}: {
  tone: keyof typeof tones;
  icon: typeof CheckCircle2;
  spin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <p className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tones[tone]}`}>
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${spin ? 'animate-spin' : ''}`} aria-hidden />
      <span>{children}</span>
    </p>
  );
}
