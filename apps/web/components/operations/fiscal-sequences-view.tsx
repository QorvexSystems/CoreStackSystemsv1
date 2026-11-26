'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  createElectronicFiscalRange,
  createFiscalSequence,
  getElectronicFiscalRanges,
  getFiscalSequences,
  retryElectronicFiscalRange,
  type ElectronicFiscalRange,
  type FiscalSequence,
  type LocalNcfDocumentType,
} from '@/lib/api';
import {
  getStatusVariant,
  translateInvoiceDocumentType,
  translateStatus,
} from '@/lib/display-labels';
import { formatDateOnly } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { SessionRequired, useCurrentSession } from './session-required';

const electronicTypes = [31, 32, 33, 34, 41, 43, 44, 45, 46, 47] as const;
const electronicNames: Record<(typeof electronicTypes)[number], string> = {
  31: 'Crédito fiscal',
  32: 'Consumo',
  33: 'Nota de débito',
  34: 'Nota de crédito',
  41: 'Compras',
  43: 'Gastos menores',
  44: 'Regímenes especiales',
  45: 'Gubernamental',
  46: 'Exportaciones',
  47: 'Pagos al exterior',
};

type ElectronicRegistrationType = `E${(typeof electronicTypes)[number]}`;
type RegistrationType = LocalNcfDocumentType | ElectronicRegistrationType;

export function FiscalSequencesView() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    registrationType: 'E32' as RegistrationType,
    startNumber: '',
    endNumber: '',
    nextNumber: '',
    authorizationNumber: '',
    authorizedAt: '',
    validUntil: '',
  });
  const sequencesQuery = useQuery({
    queryKey: ['fiscal-sequences', session?.tenantId],
    queryFn: () => getFiscalSequences(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });
  const electronicRangesQuery = useQuery({
    queryKey: ['electronic-fiscal-ranges', session?.tenantId],
    queryFn: () =>
      getElectronicFiscalRanges(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    const suggestedStart = getSuggestedRegistrationStart(
      form.registrationType,
      sequencesQuery.data ?? [],
      electronicRangesQuery.data ?? [],
    );
    if (suggestedStart === null) return;

    setForm((current) => {
      if (current.startNumber || current.nextNumber) return current;
      return { ...current, startNumber: suggestedStart, nextNumber: suggestedStart };
    });
  }, [electronicRangesQuery.data, form.registrationType, sequencesQuery.data]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('Sesión requerida.');

      if (isElectronicRegistrationType(form.registrationType)) {
        const record = await createElectronicFiscalRange(
          session.tenantId,
          session.accessToken,
          {
            ecfType: electronicTypeNumber(form.registrationType),
            startNumber: form.startNumber,
            endNumber: form.endNumber,
            nextNumber: form.nextNumber,
            authorizationNumber: form.authorizationNumber.trim(),
            authorizedAt: form.authorizedAt || undefined,
            validUntil: form.validUntil || undefined,
          },
        );
        return { kind: 'electronic' as const, record };
      }

      const record = await createFiscalSequence(session.tenantId, session.accessToken, {
        documentType: form.registrationType,
        startNumber: Number(form.startNumber),
        endNumber: Number(form.endNumber),
        nextNumber: Number(form.nextNumber),
        authorizationNumber: form.authorizationNumber.trim(),
        validUntil: form.validUntil || undefined,
      });
      return { kind: 'local' as const, record };
    },
    onSuccess: async (result) => {
      const nextStart = String(Number(result.record.endNumber) + 1);
      setForm((current) => ({
        ...current,
        startNumber: nextStart,
        endNumber: '',
        nextNumber: nextStart,
        authorizationNumber: '',
        authorizedAt: '',
        validUntil: '',
      }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fiscal-sequences'] }),
        queryClient.invalidateQueries({ queryKey: ['electronic-fiscal-ranges'] }),
        queryClient.invalidateQueries({ queryKey: ['operational-alerts'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] }),
      ]);
      toast.success(
        result.kind === 'electronic'
          ? 'Rango e-NCF registrado; la sincronización fiscal continuará automáticamente.'
          : result.record.status === 'INACTIVE'
            ? 'Bloque NCF registrado y puesto en espera.'
            : 'Bloque NCF registrado y activado.',
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'No se pudo registrar el bloque.'),
  });
  const retryMutation = useMutation({
    mutationFn: (id: string) =>
      retryElectronicFiscalRange(session!.tenantId, session!.accessToken, id),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ['electronic-fiscal-ranges'] }),
    onError: () => toast.error('No se pudo solicitar el reintento.'),
  });

  if (!session) return <SessionRequired session={session} />;

  const canManage =
    Boolean(session.permissions.canManageFiscalSequences) ||
    ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN'].includes(session.role);
  const suggestedStart = getSuggestedRegistrationStart(
    form.registrationType,
    sequencesQuery.data ?? [],
    electronicRangesQuery.data ?? [],
  );
  const loading = sequencesQuery.isLoading || electronicRangesQuery.isLoading;
  const failed = sequencesQuery.isError || electronicRangesQuery.isError;
  const empty = !sequencesQuery.data?.length && !electronicRangesQuery.data?.length;

  function submitSequence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate();
  }

  function selectRegistrationType(registrationType: RegistrationType) {
    const nextStart = getSuggestedRegistrationStart(
      registrationType,
      sequencesQuery.data ?? [],
      electronicRangesQuery.data ?? [],
    );
    setForm((current) => ({
      ...current,
      registrationType,
      startNumber: nextStart ?? '',
      endNumber: '',
      nextNumber: nextStart ?? '',
      authorizedAt: '',
      validUntil: '',
    }));
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Secuencias fiscales"
        description="Autorizaciones NCF y e-NCF asignadas por DGII."
      />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Registrar bloque autorizado</CardTitle>
            <CardDescription>
              Selecciona el tipo y copia exactamente la autorización entregada por DGII.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 md:grid-cols-3" onSubmit={submitSequence}>
              <div className="space-y-2">
                <Label htmlFor="registrationType">Tipo</Label>
                <select
                  id="registrationType"
                  value={form.registrationType}
                  onChange={(event) =>
                    selectRegistrationType(event.target.value as RegistrationType)
                  }
                  className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                >
                  <optgroup label="Comprobantes electrónicos">
                    {electronicTypes.map((type) => (
                      <option key={type} value={`E${type}`}>
                        E{type} · {electronicNames[type]}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Comprobantes NCF">
                    <option value="CONSUMER_02">B02 · Factura de consumo</option>
                    <option value="FISCAL_CREDIT_01">B01 · Crédito fiscal</option>
                  </optgroup>
                </select>
              </div>
              <SequenceNumberInput
                id="sequenceStart"
                label="Número desde"
                value={form.startNumber}
                hint={
                  suggestedStart === null
                    ? undefined
                    : `Sugerido según el historial: ${Number(suggestedStart).toLocaleString('es-DO')}`
                }
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    startNumber: value,
                    nextNumber:
                      !current.nextNumber || current.nextNumber === current.startNumber
                        ? value
                        : current.nextNumber,
                  }))
                }
              />
              <SequenceNumberInput
                id="sequenceEnd"
                label="Número hasta"
                value={form.endNumber}
                onChange={(value) => setForm((current) => ({ ...current, endNumber: value }))}
              />
              <SequenceNumberInput
                id="sequenceNext"
                label="Siguiente a utilizar"
                value={form.nextNumber}
                hint="Déjalo igual al inicio salvo que ya hayas usado números fuera de RIVNU."
                onChange={(value) => setForm((current) => ({ ...current, nextNumber: value }))}
              />
              <div className="space-y-2">
                <Label htmlFor="sequenceAuthorization">No. autorización DGII</Label>
                <Input
                  id="sequenceAuthorization"
                  value={form.authorizationNumber}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      authorizationNumber: event.target.value,
                    }))
                  }
                  required
                  maxLength={120}
                />
              </div>
              {isElectronicRegistrationType(form.registrationType) ? (
                <div className="space-y-2">
                  <Label htmlFor="sequenceAuthorizedAt">Fecha autorización</Label>
                  <Input
                    id="sequenceAuthorizedAt"
                    type="date"
                    value={form.authorizedAt}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, authorizedAt: event.target.value }))
                    }
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="sequenceValidUntil">Válida hasta</Label>
                <Input
                  id="sequenceValidUntil"
                  type="date"
                  value={form.validUntil}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, validUntil: event.target.value }))
                  }
                  required={form.registrationType === 'FISCAL_CREDIT_01'}
                />
              </div>
              <div className="md:col-span-3">
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Registrando…' : 'Registrar bloque autorizado'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Bloques fiscales registrados</CardTitle>
          <CardDescription>
            Disponibilidad y consumo de todas las secuencias NCF y e-NCF.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Prefijo</TableHead>
                <TableHead>Siguiente</TableHead>
                <TableHead>Final</TableHead>
                <TableHead>Restantes</TableHead>
                <TableHead>Progreso</TableHead>
                <TableHead>RNC/Cédula emisor</TableHead>
                <TableHead>Autorización</TableHead>
                <TableHead>Vigencia</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    Cargando bloques fiscales…
                  </TableCell>
                </TableRow>
              ) : failed ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-danger">
                    No se pudieron cargar las secuencias fiscales.
                  </TableCell>
                </TableRow>
              ) : empty ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    Todavía no hay bloques fiscales registrados.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {(electronicRangesQuery.data ?? []).map((range) => (
                    <ElectronicRangeRow
                      key={`electronic-${range.id}`}
                      range={range}
                      retry={() => retryMutation.mutate(range.id)}
                    />
                  ))}
                  {(sequencesQuery.data ?? []).map((sequence) => (
                    <LocalSequenceRow key={`local-${sequence.id}`} sequence={sequence} />
                  ))}
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function LocalSequenceRow({ sequence }: { sequence: FiscalSequence }) {
  const remaining = Math.max(sequence.endNumber - sequence.nextNumber + 1, 0);
  const total = Math.max(sequence.endNumber - sequence.startNumber + 1, 1);
  const used = Math.min(Math.max(sequence.nextNumber - sequence.startNumber, 0), total);

  return (
    <TableRow className={sequence.status === 'INACTIVE' ? 'bg-amber-50/60' : undefined}>
      <TableCell>{translateInvoiceDocumentType(sequence.documentType)}</TableCell>
      <TableCell>{sequence.prefix}</TableCell>
      <TableCell className="font-medium">
        {formatFiscalNumber(sequence.prefix, sequence.nextNumber)}
      </TableCell>
      <TableCell>{formatFiscalNumber(sequence.prefix, sequence.endNumber)}</TableCell>
      <TableCell>{remaining.toLocaleString('es-DO')}</TableCell>
      <TableCell>
        <SequenceProgress prefix={sequence.prefix} used={used} total={total} />
      </TableCell>
      <TableCell>{sequence.issuerTaxId ?? '-'}</TableCell>
      <TableCell>{sequence.authorizationNumber ?? '-'}</TableCell>
      <TableCell>{sequence.validUntil ? formatDateOnly(sequence.validUntil) : '-'}</TableCell>
      <TableCell>
        <Badge variant={getStatusVariant(sequence.status)}>
          {sequence.status === 'INACTIVE' ? 'En espera' : translateStatus(sequence.status)}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function ElectronicRangeRow({
  range,
  retry,
}: {
  range: ElectronicFiscalRange;
  retry(): void;
}) {
  const start = Number(range.startNumber);
  const end = Number(range.endNumber);
  const next = Number(range.nextNumber ?? range.startNumber);
  const total = Math.max(end - start + 1, 1);
  const used = range.authoritative
    ? Number(range.used ?? 0)
    : Math.min(Math.max(next - start, 0), total);
  const remaining = range.authoritative
    ? Number(range.remaining ?? 0)
    : Math.max(end - next + 1, 0);
  const statusLabel = range.exhausted
    ? 'Agotado'
    : range.syncStatus === 'SYNCED'
      ? 'Sincronizado'
      : range.syncStatus === 'SYNCING'
        ? 'Sincronizando'
        : range.syncStatus === 'FAILED'
          ? 'Fallido'
          : 'Pendiente';

  return (
    <TableRow>
      <TableCell>E{range.ecfType} · {electronicNames[range.ecfType]}</TableCell>
      <TableCell>{range.prefix}</TableCell>
      <TableCell className="font-medium">{formatFiscalNumber(range.prefix, next)}</TableCell>
      <TableCell>{formatFiscalNumber(range.prefix, end)}</TableCell>
      <TableCell>{remaining.toLocaleString('es-DO')}</TableCell>
      <TableCell>
        <SequenceProgress prefix={range.prefix} used={used} total={total} />
      </TableCell>
      <TableCell>{range.issuerTaxId}</TableCell>
      <TableCell>{range.authorizationNumber}</TableCell>
      <TableCell>{range.validUntil ? formatDateOnly(range.validUntil) : '-'}</TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <Badge
            variant={
              range.syncStatus === 'SYNCED'
                ? 'success'
                : range.syncStatus === 'FAILED'
                  ? 'danger'
                  : 'default'
            }
          >
            {statusLabel}
          </Badge>
          {range.syncStatus === 'FAILED' ? (
            <Button size="sm" variant="outline" onClick={retry}>
              Reintentar
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function SequenceNumberInput({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        pattern="[1-9][0-9]{0,9}"
        maxLength={10}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 10))}
        required
      />
      {hint ? <p className="text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SequenceProgress({
  prefix,
  used,
  total,
}: {
  prefix: string;
  used: number;
  total: number;
}) {
  const safeUsed = Math.min(Math.max(used, 0), total);
  const exactPercent = (safeUsed / total) * 100;
  const percent = safeUsed > 0 && exactPercent < 1 ? 1 : Math.round(exactPercent);
  const percentLabel = safeUsed > 0 && exactPercent < 1 ? '<1%' : `${percent}%`;

  return (
    <div className="min-w-32 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>{safeUsed.toLocaleString('es-DO')} usados</span>
        <span className="text-muted-foreground">{percentLabel}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Uso del bloque ${prefix}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function getSuggestedRegistrationStart(
  registrationType: RegistrationType,
  sequences: FiscalSequence[],
  electronicRanges: ElectronicFiscalRange[],
) {
  if (isElectronicRegistrationType(registrationType)) {
    const type = electronicTypeNumber(registrationType);
    const highestEnd = electronicRanges
      .filter((range) => range.ecfType === type)
      .reduce((highest, range) => Math.max(highest, Number(range.endNumber)), 0);
    return highestEnd >= 9_999_999_999 ? null : String(highestEnd + 1);
  }

  const highestEnd = sequences
    .filter((sequence) => sequence.documentType === registrationType)
    .reduce((highest, sequence) => Math.max(highest, sequence.endNumber), 0);
  return highestEnd >= 99_999_999 ? null : String(highestEnd + 1);
}

function isElectronicRegistrationType(value: RegistrationType): value is ElectronicRegistrationType {
  return /^E(?:31|32|33|34|41|43|44|45|46|47)$/.test(value);
}

function electronicTypeNumber(value: ElectronicRegistrationType) {
  return Number(value.slice(1)) as (typeof electronicTypes)[number];
}

function formatFiscalNumber(prefix: string, number: number) {
  const digits = /^B\d{2}$/.test(prefix) ? 8 : prefix === 'BA' ? 4 : 10;
  return `${prefix}${String(number).padStart(digits, '0')}`;
}
