'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
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
  getElectronicFiscalRanges,
  retryElectronicFiscalRange,
  type ElectronicFiscalRange,
} from '@/lib/api';
import { formatDateOnly } from '@/lib/utils';
import { useCurrentSession } from './session-required';

const types = [31, 32, 33, 34, 41, 43, 44, 45, 46, 47] as const;
const names: Record<(typeof types)[number], string> = {
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

export function ElectronicFiscalRangesPanel() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    ecfType: 31 as (typeof types)[number],
    startNumber: '',
    endNumber: '',
    nextNumber: '',
    authorizationNumber: '',
    authorizedAt: '',
    validUntil: '',
  });
  const query = useQuery({
    queryKey: ['electronic-fiscal-ranges', session?.tenantId],
    queryFn: () => getElectronicFiscalRanges(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    refetchInterval: 5000,
  });
  const create = useMutation({
    mutationFn: () =>
      createElectronicFiscalRange(session!.tenantId, session!.accessToken, {
        ecfType: form.ecfType,
        startNumber: form.startNumber,
        endNumber: form.endNumber,
        nextNumber: form.nextNumber,
        authorizationNumber: form.authorizationNumber.trim(),
        authorizedAt: form.authorizedAt || undefined,
        validUntil: form.validUntil || undefined,
      }),
    onSuccess: async () => {
      setForm((current) => ({
        ...current,
        startNumber: '',
        endNumber: '',
        nextNumber: '',
        authorizationNumber: '',
        authorizedAt: '',
        validUntil: '',
      }));
      await queryClient.invalidateQueries({ queryKey: ['electronic-fiscal-ranges'] });
      toast.success('Rango e-NCF guardado; la sincronización fiscal se realizará automáticamente.');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'No se pudo registrar el rango.'),
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      retryElectronicFiscalRange(session!.tenantId, session!.accessToken, id),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ['electronic-fiscal-ranges'] }),
    onError: () => toast.error('No se pudo solicitar el reintento.'),
  });
  if (!session) return null;
  const canManage =
    Boolean(session.permissions.canManageFiscalSequences) ||
    ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN'].includes(session.role);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Registrar autorización e-NCF</CardTitle>
            <CardDescription>
              Copie exactamente el rango aprobado por DGII. Guardarlo no habilita emisión ni consume
              números.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="ecfType">Tipo</Label>
                <select
                  id="ecfType"
                  className="h-10 w-full rounded-md border bg-background px-3"
                  value={form.ecfType}
                  onChange={(event) =>
                    setForm({ ...form, ecfType: Number(event.target.value) as typeof form.ecfType })
                  }
                >
                  {types.map((type) => (
                    <option key={type} value={type}>
                      E{type} · {names[type]}
                    </option>
                  ))}
                </select>
              </div>
              <NumberField
                id="ecfStart"
                label="Inicial"
                value={form.startNumber}
                onChange={(value) =>
                  setForm({ ...form, startNumber: value, nextNumber: form.nextNumber || value })
                }
              />
              <NumberField
                id="ecfEnd"
                label="Final"
                value={form.endNumber}
                onChange={(value) => setForm({ ...form, endNumber: value })}
              />
              <NumberField
                id="ecfNext"
                label="Próximo disponible"
                value={form.nextNumber}
                onChange={(value) => setForm({ ...form, nextNumber: value })}
              />
              <div className="space-y-2">
                <Label htmlFor="ecfAuthorization">Autorización DGII</Label>
                <Input
                  id="ecfAuthorization"
                  maxLength={120}
                  required
                  value={form.authorizationNumber}
                  onChange={(event) =>
                    setForm({ ...form, authorizationNumber: event.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ecfAuthorizedAt">Fecha autorización</Label>
                <Input
                  id="ecfAuthorizedAt"
                  type="date"
                  value={form.authorizedAt}
                  onChange={(event) => setForm({ ...form, authorizedAt: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ecfValidUntil">Vencimiento</Label>
                <Input
                  id="ecfValidUntil"
                  type="date"
                  value={form.validUntil}
                  onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
                />
              </div>
              <div className="md:col-span-3">
                <Button disabled={create.isPending}>
                  {create.isPending ? 'Registrando…' : 'Registrar rango e-NCF'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Rangos electrónicos</CardTitle>
          <CardDescription>
            VM3 es la fuente de numeración; “Sincronizado” confirma que el núcleo fiscal registró el
            rango.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Rango</TableHead>
                <TableHead>Próximo</TableHead>
                <TableHead>Disponibles</TableHead>
                <TableHead>Usados</TableHead>
                <TableHead>Autorización</TableHead>
                <TableHead>Vigencia</TableHead>
                <TableHead>Sincronización</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data?.map((range) => (
                <RangeRow key={range.id} range={range} retry={() => retry.mutate(range.id)} />
              )) ?? null}
              {!query.isLoading && !query.data?.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    No hay rangos e-NCF registrados.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        pattern="[1-9][0-9]{0,9}"
        maxLength={10}
        required
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 10))}
      />
    </div>
  );
}

function RangeRow({ range, retry }: { range: ElectronicFiscalRange; retry(): void }) {
  const label = {
    PENDING: 'Pendiente',
    SYNCING: 'Sincronizando',
    SYNCED: 'Sincronizado',
    FAILED: 'Fallido',
  }[range.syncStatus];
  return (
    <TableRow>
      <TableCell>E{range.ecfType}</TableCell>
      <TableCell>
        {range.startNumber}–{range.endNumber}
      </TableCell>
      <TableCell>{range.nextNumber}</TableCell>
      <TableCell>
        {range.authoritative ? Number(range.remaining).toLocaleString('es-DO') : 'No disponible'}
      </TableCell>
      <TableCell>
        {range.authoritative ? Number(range.used).toLocaleString('es-DO') : 'No disponible'}
      </TableCell>
      <TableCell>{range.authorizationNumber}</TableCell>
      <TableCell>
        {range.validUntil ? formatDateOnly(range.validUntil) : 'Sin fecha indicada'}
      </TableCell>
      <TableCell>
        <Badge
          variant={
            range.syncStatus === 'SYNCED'
              ? 'success'
              : range.syncStatus === 'FAILED'
                ? 'danger'
                : 'default'
          }
        >
          {label}
        </Badge>
      </TableCell>
      <TableCell>
        {range.syncStatus === 'FAILED' ? (
          <Button size="sm" variant="outline" onClick={retry}>
            Reintentar
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
