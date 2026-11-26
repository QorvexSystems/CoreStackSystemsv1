'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, FileDigit, Hourglass, Lock, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import { closeFiscalSequence, createFiscalSequence, getFiscalSequences, type FiscalSequence } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { isAccountantSession, isAdminSession } from '@/lib/authorization';
import { normalizeDominicanDocument, validateDominicanDocument } from '@/lib/dominican-documents';
import { cn } from '@/lib/utils';

type DocType = 'FISCAL_CREDIT_ELECTRONIC_31' | 'CONSUMER_ELECTRONIC_32';

const types: Array<{ value: DocType; prefix: string; title: string; detail: string }> = [
  {
    value: 'FISCAL_CREDIT_ELECTRONIC_31',
    prefix: 'E31',
    title: 'E31 · Crédito fiscal',
    detail: 'Para empresas o personas que necesitan sustentar el gasto (con RNC o cédula).',
  },
  {
    value: 'CONSUMER_ELECTRONIC_32',
    prefix: 'E32',
    title: 'E32 · Consumo',
    detail: 'Para consumidores finales.',
  },
];

const statusInfo: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: 'En uso', tone: 'bg-emerald-50 text-emerald-700' },
  INACTIVE: { label: 'En espera', tone: 'bg-sky-50 text-sky-700' },
  EXHAUSTED: { label: 'Agotado', tone: 'bg-slate-100 text-slate-600' },
  EXPIRED: { label: 'Vencido', tone: 'bg-rose-50 text-rose-700' },
};

const ncf = (prefix: string, number: number) => `${prefix}${String(number).padStart(10, '0')}`;

/** Secuencias fiscales del hotel: bloques de e-NCF autorizados por la DGII para E31 y E32. */
export function HotelFiscalSequencesView() {
  const session = getSession();
  const canManage = isAdminSession(session) || isAccountantSession(session) || Boolean(session?.permissions.canManageFiscalSequences);
  const [registerType, setRegisterType] = useState<DocType | null>(null);
  const [closing, setClosing] = useState<FiscalSequence | null>(null);
  const query = useQuery({
    queryKey: ['fiscal-sequences', session?.tenantId],
    queryFn: () => getFiscalSequences(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const sequences = useMemo(
    () => (query.data ?? []).filter((item) => types.some((type) => type.value === item.documentType)),
    [query.data],
  );
  const history = [...sequences].sort((a, b) =>
    a.documentType === b.documentType ? b.startNumber - a.startNumber : a.documentType.localeCompare(b.documentType),
  );

  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <p className="text-xs font-semibold text-teal">Hotel Ancla</p>
          <h1 className="mt-1 text-2xl font-extrabold text-slate-950">Secuencias fiscales</h1>
          <p className="mt-1 text-sm text-slate-500">
            Bloques de comprobantes electrónicos (e-NCF) autorizados por la DGII. Cada factura E31 o E32 toma el
            siguiente número del bloque en uso.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setRegisterType('FISCAL_CREDIT_ELECTRONIC_31')}
            className="inline-flex h-12 items-center gap-2 rounded-xl bg-teal px-5 text-sm font-bold text-white hover:bg-teal-deep"
          >
            <Plus className="h-4 w-4" /> Registrar bloque
          </button>
        ) : null}
      </header>

      <section className="grid gap-3 lg:grid-cols-2">
        {types.map((type) => (
          <SequenceCard
            key={type.value}
            type={type}
            blocks={sequences.filter((item) => item.documentType === type.value)}
            canManage={canManage}
            loading={query.isLoading}
            onRegister={() => setRegisterType(type.value)}
            onClose={setClosing}
          />
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4">
          <h2 className="text-sm font-extrabold">Historial de bloques</h2>
          <p className="text-xs text-slate-500">Todos los rangos registrados y cuántos números se han usado.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-3 py-3">Rango</th>
                <th className="px-3 py-3">Próximo</th>
                <th className="px-3 py-3">Usados</th>
                <th className="px-3 py-3">Vence</th>
                <th className="px-3 py-3">Autorización</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {history.map((block) => {
                const used = Math.max(block.nextNumber - block.startNumber, 0);
                const status = displayStatus(block);
                return (
                  <tr key={block.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-extrabold">{block.prefix}</td>
                    <td className="px-3 py-3 tabular-nums">
                      {ncf(block.prefix, block.startNumber)} – {ncf(block.prefix, block.endNumber)}
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      {['ACTIVE', 'INACTIVE'].includes(block.status) ? ncf(block.prefix, block.nextNumber) : '—'}
                    </td>
                    <td className="px-3 py-3 tabular-nums">{used.toLocaleString('es-DO')}</td>
                    <td className="px-3 py-3">{block.validUntil ? formatDate(block.validUntil) : 'Sin fecha'}</td>
                    <td className="px-3 py-3 text-xs text-slate-600">{block.authorizationNumber || '—'}</td>
                    <td className="px-3 py-3">
                      <span className={cn('rounded-full px-2 py-1 text-xs font-bold', statusInfo[status]?.tone)}>
                        {statusInfo[status]?.label ?? status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && ['ACTIVE', 'INACTIVE'].includes(block.status) ? (
                        <button
                          type="button"
                          onClick={() => setClosing(block)}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-rose-300 hover:text-rose-700"
                        >
                          Cerrar bloque
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {query.error ? <p className="border-t p-6 text-center text-sm text-rose-600">{(query.error as Error).message}</p> : null}
        {!query.isLoading && !query.error && !history.length ? (
          <p className="border-t p-6 text-center text-sm text-slate-500">Todavía no hay bloques registrados.</p>
        ) : null}
      </section>

      <RegisterBlockDialog
        type={registerType}
        sequences={sequences}
        onTypeChange={setRegisterType}
        onClose={() => setRegisterType(null)}
      />
      <CloseBlockDialog block={closing} onClose={() => setClosing(null)} />
    </div>
  );
}

function SequenceCard({
  type,
  blocks,
  canManage,
  loading,
  onRegister,
  onClose,
}: {
  type: (typeof types)[number];
  blocks: FiscalSequence[];
  canManage: boolean;
  loading: boolean;
  onRegister: () => void;
  onClose: (block: FiscalSequence) => void;
}) {
  const active = blocks.find((block) => block.status === 'ACTIVE');
  const waiting = blocks.filter((block) => block.status === 'INACTIVE');
  const total = active ? active.endNumber - active.startNumber + 1 : 0;
  const used = active ? active.nextNumber - active.startNumber : 0;
  const remaining = active ? Math.max(active.endNumber - active.nextNumber + 1, 0) : 0;
  const percent = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const days = active?.validUntil ? Math.ceil((new Date(active.validUntil).getTime() - Date.now()) / 86_400_000) : null;
  const lowStock = active && remaining <= Math.max(25, Math.ceil(total * 0.1));
  const expiringSoon = days !== null && days <= 30;
  const demo = active && (!active.validUntil || /DEMO/i.test(active.authorizationNumber ?? ''));
  const alert = !active
    ? { tone: 'rose', text: 'No hay bloque en uso: no se pueden emitir facturas de este tipo.' }
    : days !== null && days < 0
      ? { tone: 'rose', text: 'El bloque está vencido. Registra uno nuevo.' }
      : lowStock && !waiting.length
        ? { tone: 'amber', text: `Quedan ${remaining.toLocaleString('es-DO')} números. Registra el próximo bloque.` }
        : expiringSoon && !waiting.length
          ? { tone: 'amber', text: `Vence en ${days} ${days === 1 ? 'día' : 'días'}. Registra el próximo bloque.` }
          : demo
            ? { tone: 'amber', text: 'Este bloque es de prueba. Registra el rango real autorizado por la DGII.' }
            : null;

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-slate-950">{type.title}</h2>
          <p className="text-xs text-slate-500">{type.detail}</p>
        </div>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-light text-teal-deep">
          <FileDigit className="h-5 w-5" />
        </span>
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Cargando…</p>
      ) : active ? (
        <>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Próximo comprobante</p>
          <p className="mt-0.5 text-3xl font-extrabold tabular-nums text-slate-950">{ncf(active.prefix, active.nextNumber)}</p>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn('h-full rounded-full', lowStock ? 'bg-amber-500' : 'bg-teal')}
              style={{ width: `${Math.max(percent, used ? 2 : 0)}%` }}
            />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Fact label="Usados" value={used.toLocaleString('es-DO')} />
            <Fact label="Disponibles" value={remaining.toLocaleString('es-DO')} />
            <Fact
              label="Vence"
              value={active.validUntil ? formatDate(active.validUntil) : 'Sin fecha'}
              warn={expiringSoon}
            />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            Rango {ncf(active.prefix, active.startNumber)} – {ncf(active.prefix, active.endNumber)}
            {active.authorizationNumber ? ` · Autorización ${active.authorizationNumber}` : ''}
          </p>
          {waiting.length ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-sky-700">
              <Hourglass className="h-3.5 w-3.5" />
              {waiting.length === 1 ? '1 bloque en espera' : `${waiting.length} bloques en espera`}: se usa cuando este se agote.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-6 text-sm text-slate-500">Sin bloque en uso.</p>
      )}

      {alert ? (
        <p
          className={cn(
            'mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm font-semibold',
            alert.tone === 'rose' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800',
          )}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {alert.text}
        </p>
      ) : active ? (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> Bloque vigente.
        </p>
      ) : null}

      {canManage ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRegister}
            className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-teal px-4 text-sm font-bold text-teal-deep hover:bg-teal-light/40"
          >
            <Plus className="h-4 w-4" /> Nuevo bloque {type.prefix}
          </button>
          {active ? (
            <button
              type="button"
              onClick={() => onClose(active)}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-600 hover:border-rose-300 hover:text-rose-700"
            >
              <Lock className="h-4 w-4" /> Cerrar bloque
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const fieldClass =
  'mt-1.5 h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-base font-normal outline-none focus:border-teal';

function RegisterBlockDialog({
  type,
  sequences,
  onTypeChange,
  onClose,
}: {
  type: DocType | null;
  sequences: FiscalSequence[];
  onTypeChange: (type: DocType) => void;
  onClose: () => void;
}) {
  const session = getSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ start: '', end: '', authorization: '', validUntil: '', rnc: '' });
  const [activateNow, setActivateNow] = useState<boolean | null>(null);
  const meta = types.find((item) => item.value === type);
  const active = sequences.find((item) => item.documentType === type && item.status === 'ACTIVE');
  const issuer = sequences.find((item) => item.issuerDocumentNumber)?.issuerDocumentNumber ?? '';
  const rnc = form.rnc || issuer;
  // Si el bloque actual es de prueba (sin vencimiento o "DEMO"), lo normal es reemplazarlo ya.
  const activeIsDemo = Boolean(active && (!active.validUntil || /DEMO/i.test(active.authorizationNumber ?? '')));
  const useNow = activateNow ?? activeIsDemo;
  const start = Number(form.start);
  const end = Number(form.end);
  const rangeError =
    form.start && form.end && (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
      ? 'El número final debe ser mayor o igual al inicial.'
      : null;
  const rncValid = validateDominicanDocument('RNC', rnc);
  const valid =
    meta &&
    start >= 1 &&
    end >= start &&
    !rangeError &&
    form.authorization.trim() &&
    form.validUntil &&
    rncValid;

  const mutation = useMutation({
    mutationFn: () =>
      createFiscalSequence(session!.tenantId, session!.accessToken, {
        documentType: type!,
        startNumber: start,
        endNumber: end,
        nextNumber: start,
        authorizationNumber: form.authorization.trim(),
        validUntil: form.validUntil,
        issuerDocumentType: 'RNC',
        issuerDocumentNumber: normalizeDominicanDocument(rnc),
        activateNow: useNow,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['fiscal-sequences'] });
      toast.success(`Bloque ${meta?.prefix} registrado`);
      setForm({ start: '', end: '', authorization: '', validUntil: '', rnc: '' });
      setActivateNow(null);
      onClose();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  if (!type || !meta) return null;

  return (
    <ActionDialog
      open
      eyebrow="Secuencias fiscales"
      title="Registrar bloque autorizado"
      description="Copia los datos tal como aparecen en la autorización de la DGII."
      icon={<FileDigit className="h-5 w-5" />}
      confirmLabel="Registrar bloque"
      isPending={mutation.isPending}
      confirmDisabled={!valid}
      size="lg"
      onClose={onClose}
      onConfirm={() => mutation.mutate()}
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-2">
          {types.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => {
                onTypeChange(item.value);
                setActivateNow(null);
              }}
              className={cn(
                'rounded-xl border-2 p-3 text-left',
                type === item.value ? 'border-teal bg-teal-light/40' : 'border-slate-200',
              )}
            >
              <span className="block text-base font-extrabold">{item.title}</span>
              <span className="text-xs text-slate-500">{item.detail}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-slate-700">
            Desde (número) *
            <input
              className={fieldClass}
              inputMode="numeric"
              value={form.start}
              placeholder="1"
              onChange={(event) => setForm({ ...form, start: event.target.value.replace(/\D/g, '') })}
            />
            {start >= 1 ? <span className="mt-1 block text-xs text-slate-500">{ncf(meta.prefix, start)}</span> : null}
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Hasta (número) *
            <input
              className={fieldClass}
              inputMode="numeric"
              value={form.end}
              placeholder="500"
              onChange={(event) => setForm({ ...form, end: event.target.value.replace(/\D/g, '') })}
            />
            {end >= 1 ? <span className="mt-1 block text-xs text-slate-500">{ncf(meta.prefix, end)}</span> : null}
          </label>
        </div>
        {rangeError ? <p className="-mt-2 text-xs text-rose-600">{rangeError}</p> : null}
        {start >= 1 && end >= start ? (
          <p className="-mt-1 text-sm text-slate-600">
            {(end - start + 1).toLocaleString('es-DO')} comprobantes {meta.prefix}.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-slate-700">
            Número de autorización DGII *
            <input
              className={fieldClass}
              value={form.authorization}
              maxLength={80}
              onChange={(event) => setForm({ ...form, authorization: event.target.value })}
            />
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Fecha de vencimiento *
            <input
              className={fieldClass}
              type="date"
              value={form.validUntil}
              onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
            />
          </label>
        </div>
        <label className="block text-sm font-semibold text-slate-700">
          RNC del hotel (emisor) *
          <input
            className={fieldClass}
            inputMode="numeric"
            value={rnc}
            maxLength={13}
            onChange={(event) => setForm({ ...form, rnc: event.target.value })}
          />
          {rnc && !rncValid ? <span className="mt-1 block text-xs text-rose-600">El RNC no es válido.</span> : null}
        </label>
        {active ? (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 accent-teal"
              checked={useNow}
              onChange={(event) => setActivateNow(event.target.checked)}
            />
            <span className="text-sm">
              <span className="block font-bold text-slate-900">Usar este bloque desde ya</span>
              <span className="text-slate-500">
                {useNow
                  ? `El bloque actual se cierra en ${active.nextNumber > active.startNumber ? ncf(active.prefix, active.nextNumber - 1) : 'cero (no se usó y se descarta)'} y la próxima factura ${meta.prefix} sale de este bloque.`
                  : 'Queda en espera y se usa automáticamente cuando el bloque actual se agote.'}
              </span>
            </span>
          </label>
        ) : null}
      </div>
    </ActionDialog>
  );
}

function CloseBlockDialog({ block, onClose }: { block: FiscalSequence | null; onClose: () => void }) {
  const session = getSession();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => closeFiscalSequence(session!.tenantId, session!.accessToken, block!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['fiscal-sequences'] });
      toast.success('Bloque cerrado');
      onClose();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  if (!block) return null;
  const used = block.nextNumber - block.startNumber;
  return (
    <ActionDialog
      open
      tone="danger"
      eyebrow={`Bloque ${block.prefix}`}
      title="¿Cerrar este bloque?"
      description={
        used > 0
          ? `Termina en ${ncf(block.prefix, block.nextNumber - 1)}. Los números siguientes de este bloque no se podrán usar.`
          : 'Este bloque no se ha usado: se descarta.'
      }
      icon={<CalendarClock className="h-5 w-5" />}
      confirmLabel="Cerrar bloque"
      isPending={mutation.isPending}
      onClose={onClose}
      onConfirm={() => mutation.mutate()}
    >
      {block.status === 'ACTIVE' ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
          Si no hay otro bloque {block.prefix} en espera, no se podrán emitir facturas {block.prefix} hasta registrar uno.
        </p>
      ) : null}
    </ActionDialog>
  );
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cn('mt-0.5 font-extrabold tabular-nums', warn ? 'text-amber-700' : 'text-slate-900')}>{value}</dd>
    </div>
  );
}

function displayStatus(block: FiscalSequence) {
  if (block.status === 'ACTIVE' && block.validUntil && new Date(block.validUntil).getTime() < Date.now()) return 'EXPIRED';
  return block.status;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(value),
  );
}
