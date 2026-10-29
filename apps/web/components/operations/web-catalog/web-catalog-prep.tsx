'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Layers,
  Power,
  Rocket,
  Search,
  ShieldCheck,
  Tags,
  TriangleAlert,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionDialog, type ActionDialogTone } from '@/components/ui/action-dialog';
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
import type { AuthSession } from '@/lib/auth-session';
import {
  bulkActivateVariants,
  bulkApproveSkus,
  bulkAssignCategory,
  bulkPublish,
  bulkSetAvailability,
  getSkuReview,
  getWebCatalogReview,
  getWebProduct,
  getWebProductCategories,
  listWebProducts,
  type BulkActivateResult,
  type BulkAvailabilityResult,
  type BulkCategoryResult,
  type BulkPublishResult,
  type BulkSkuApproveResult,
  type SkuReviewRow,
  type WebProductDetail,
  type WebProductListItem,
} from '@/lib/web-catalog-api';
import {
  blockerFilterLabels,
  describeBlocker,
  describeSkipReason,
  skuRuleLabels,
} from '@/lib/web-catalog-labels';
import { BlockerList, PriceRange, ProductThumb, selectClassName } from './web-catalog-ui';

const PAGE_SIZE = 25;
const MAX_BULK = 100;
const MAX_PUBLISH = 25;

type ActionKind = 'category' | 'availability' | 'sku' | 'activate' | 'publish';

const checkboxClassName =
  'h-4 w-4 shrink-0 cursor-pointer rounded border-input accent-[var(--gold-dark,#9a7a2e)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

// ------------------------------------------------------------------ utilidades

function useRefreshCatalog() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['web-products'] });
    void queryClient.invalidateQueries({ queryKey: ['web-product'] });
    void queryClient.invalidateQueries({ queryKey: ['web-catalog-review'] });
    void queryClient.invalidateQueries({ queryKey: ['web-product-categories'] });
  };
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------ panel principal

export function PreparationPanel({
  session,
  onEdit,
}: {
  session: AuthSession;
  onEdit: (id: string) => void;
}) {
  const [blocker, setBlocker] = useState('');
  const [published, setPublished] = useState<'' | 'true' | 'false'>('false');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<Record<string, WebProductListItem>>({});
  const [action, setAction] = useState<ActionKind | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setCursors([undefined]);
  }, [debounced, published, blocker]);

  const cursor = cursors[cursors.length - 1];
  const reviewQuery = useQuery({
    queryKey: ['web-catalog-review', session.tenantId],
    queryFn: () => getWebCatalogReview(session.tenantId, session.accessToken),
  });
  const listQuery = useQuery({
    queryKey: ['web-products', 'prep', session.tenantId, debounced, published, blocker, cursor ?? ''],
    queryFn: () =>
      listWebProducts(session.tenantId, session.accessToken, {
        q: debounced || undefined,
        published: published || undefined,
        blocker: blocker || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });
  const categoriesQuery = useQuery({
    queryKey: ['web-product-categories', session.tenantId],
    queryFn: () => getWebProductCategories(session.tenantId, session.accessToken),
  });

  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data]);
  const nextCursor = listQuery.data?.nextCursor ?? null;
  const page = cursors.length;
  const review = reviewQuery.data;

  // Mantiene frescos los datos de la selección cuando el listado se recarga.
  useEffect(() => {
    setSelected((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of items) {
        if (next[item.id] && next[item.id] !== item) {
          next[item.id] = item;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [items]);

  const selectedItems = Object.values(selected);
  const selectedCount = selectedItems.length;
  const allOnPage = items.length > 0 && items.every((item) => selected[item.id]);
  const someOnPage = items.some((item) => selected[item.id]);
  const pageCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pageCheckbox.current) pageCheckbox.current.indeterminate = someOnPage && !allOnPage;
  }, [someOnPage, allOnPage]);

  const toggleItem = (item: WebProductListItem) =>
    setSelected((current) => {
      const next = { ...current };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = item;
      return next;
    });
  const togglePage = () =>
    setSelected((current) => {
      const next = { ...current };
      if (allOnPage) for (const item of items) delete next[item.id];
      else for (const item of items) next[item.id] = item;
      return next;
    });

  const overLimit = selectedCount > MAX_BULK;
  const canAct = selectedCount > 0 && !overLimit;
  const canPublish = selectedCount > 0 && selectedCount <= MAX_PUBLISH;

  const cards: Array<{ key: string; label: string; value: number | undefined; code: string; hint?: string }> = [
    { key: 'groups', label: 'Grupos', value: review?.groups, code: '', hint: 'Todos' },
    { key: 'publishable', label: 'Publicables', value: review?.publishable, code: 'NONE', hint: 'Cumplen los requisitos' },
    {
      key: 'inactive',
      label: 'Variantes inactivas',
      value: review?.inactiveVariants,
      code: 'ANY_VARIANT_INACTIVE',
      hint: `de ${review?.variants ?? '…'} variantes`,
    },
    {
      key: 'undecided',
      label: 'Sin política',
      value: review?.undecidedVariants,
      code: 'ANY_VARIANT_UNDECIDED',
      hint: 'Variantes sin disponibilidad',
    },
    {
      key: 'sku',
      label: 'SKU pendientes',
      value: review?.skuPendingApproval,
      code: 'ANY_VARIANT_SKU_PENDING',
      hint: 'Variantes por aprobar',
    },
    { key: 'cat', label: 'Sin categoría', value: review?.groupsWithoutCategory, code: 'GROUP_CATEGORY_MISSING', hint: 'Grupos' },
    { key: 'img', label: 'Sin imagen', value: review?.groupsWithoutImage, code: 'GROUP_IMAGE_MISSING', hint: 'Grupos' },
    { key: 'desc', label: 'Sin descripción', value: review?.groupsWithoutDescription, code: 'GROUP_DESCRIPTION_MISSING', hint: 'Grupos' },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Preparación del catálogo importado</CardTitle>
          <CardDescription>
            Prepara muchos productos a la vez sin editarlos uno por uno. Ninguna acción cambia precios
            ni existencias, y nada se publica sin tu confirmación.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol
            className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5"
            aria-label="Orden recomendado del flujo"
          >
            {[
              ['1', 'Categoría', 'Asigna la categoría a los grupos que no la tienen.'],
              ['2', 'Disponibilidad', 'Define inventario o bajo pedido en variantes sin decidir.'],
              ['3', 'Aprobar SKU', 'Revisa las propuestas y apruébalas.'],
              ['4', 'Activar', 'Activa las variantes ya aprobadas y decididas.'],
              ['5', 'Publicar', 'Publica los grupos listos (máx. 25 a la vez).'],
            ].map(([n, title, text]) => (
              <li key={n} className="flex gap-2 rounded-md border border-border bg-muted/30 p-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {n}
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-xs text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
          </ol>

          {reviewQuery.isError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {errorText(reviewQuery.error, 'No se pudo cargar el resumen.')}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Resumen del catálogo (clic para filtrar)">
            {cards.map((card) => {
              const active = blocker === card.code;
              return (
                <button
                  key={card.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBlocker(active ? '' : card.code)}
                  className={`rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? 'border-gold-dark bg-gold-light/20' : 'border-border bg-card hover:bg-muted/40'
                  }`}
                >
                  <span className="block text-xs font-medium text-muted-foreground">{card.label}</span>
                  <span className="block text-2xl font-semibold leading-tight">{card.value ?? '…'}</span>
                  <span className="block text-xs text-muted-foreground">{card.hint}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_13rem_16rem]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-white pl-9"
            placeholder="Buscar nombre, slug, SKU o ID"
            aria-label="Buscar en la preparación"
          />
        </div>
        <select
          value={published}
          onChange={(event) => setPublished(event.target.value as '' | 'true' | 'false')}
          className={selectClassName}
          aria-label="Filtrar por estado de publicación"
        >
          <option value="false">No publicados</option>
          <option value="">Todos los estados</option>
          <option value="true">Publicados</option>
        </select>
        <select
          value={blocker}
          onChange={(event) => setBlocker(event.target.value)}
          className={selectClassName}
          aria-label="Filtrar por requisito pendiente"
        >
          <option value="">Todos los requisitos</option>
          {Object.entries(blockerFilterLabels).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div
            className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3"
            role="region"
            aria-label="Acciones masivas sobre la selección"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span aria-live="polite" className="font-medium">
                {selectedCount
                  ? `${plural(selectedCount, 'grupo seleccionado', 'grupos seleccionados')}`
                  : 'Selecciona grupos de la lista para aplicar acciones.'}
              </span>
              {selectedCount ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelected({})}>
                  Limpiar selección
                </Button>
              ) : null}
            </div>
            {overLimit ? (
              <p role="alert" className="text-xs text-amber-800">
                Máximo {MAX_BULK} grupos por operación: reduce la selección.
              </p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <Button type="button" variant="outline" disabled={!canAct} onClick={() => setAction('category')}>
                <Tags className="h-4 w-4" aria-hidden="true" /> 1. Asignar categoría
              </Button>
              <Button type="button" variant="outline" disabled={!canAct} onClick={() => setAction('availability')}>
                <Layers className="h-4 w-4" aria-hidden="true" /> 2. Definir disponibilidad
              </Button>
              <Button type="button" variant="outline" disabled={!canAct} onClick={() => setAction('sku')}>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" /> 3. Revisar y aprobar SKUs
              </Button>
              <Button type="button" variant="outline" disabled={!canAct} onClick={() => setAction('activate')}>
                <Power className="h-4 w-4" aria-hidden="true" /> 4. Activar variantes
              </Button>
              <Button type="button" disabled={!canPublish} onClick={() => setAction('publish')}>
                <Rocket className="h-4 w-4" aria-hidden="true" /> 5. Publicar seleccionados
              </Button>
            </div>
            {selectedCount > MAX_PUBLISH && !overLimit ? (
              <p className="text-xs text-muted-foreground">
                Para publicar elige {MAX_PUBLISH} grupos o menos: la publicación siempre es controlada, grupo por grupo.
              </p>
            ) : null}
          </div>

          {listQuery.isError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {errorText(listQuery.error, 'No se pudo cargar la lista.')}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground" aria-live="polite">
            <label className="flex min-h-9 cursor-pointer items-center gap-2 text-foreground">
              <input
                ref={pageCheckbox}
                type="checkbox"
                className={checkboxClassName}
                checked={allOnPage}
                disabled={!items.length}
                onChange={togglePage}
              />
              Seleccionar página
            </label>
            <span>
              {listQuery.isLoading
                ? 'Cargando…'
                : items.length
                  ? `Página ${page} · ${plural(items.length, 'grupo', 'grupos')}${
                      blocker ? ` · ${blockerFilterLabels[blocker] ?? blocker}` : ''
                    }`
                  : 'Sin resultados'}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={page <= 1}
                onClick={() => setCursors((current) => current.slice(0, -1))}
                aria-label="Página anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!nextCursor}
                onClick={() => nextCursor && setCursors((current) => [...current, nextCursor])}
                aria-label="Página siguiente"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-3 md:hidden">
            {items.map((item) => (
              <div
                key={item.id}
                className={`rounded-md border p-3 ${selected[item.id] ? 'border-gold-dark bg-gold-light/10' : 'border-border'}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className={`${checkboxClassName} mt-1`}
                    checked={Boolean(selected[item.id])}
                    onChange={() => toggleItem(item)}
                    aria-label={`Seleccionar ${item.name}`}
                  />
                  <ProductThumb src={item.primaryImage} alt={item.name} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug">{item.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.categoryLabel ?? 'Sin categoría'} · {item.id}
                    </p>
                  </div>
                </div>
                <div className="mt-2">
                  <PrepBadges item={item} />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => onEdit(item.id)}
                  aria-label={`Administrar ${item.name}`}
                >
                  Administrar
                </Button>
              </div>
            ))}
          </div>

          <div className="hidden md:block">
            <Table wrapperClassName="max-h-[60vh] rounded-md border border-border overflow-auto">
              <TableHeader className="sticky top-0 z-10 bg-card shadow-sm">
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Selección</span>
                  </TableHead>
                  <TableHead>Producto</TableHead>
                  <TableHead>Categoría</TableHead>
                  <TableHead>Preparación</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id} className={selected[item.id] ? 'bg-gold-light/10' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className={checkboxClassName}
                        checked={Boolean(selected[item.id])}
                        onChange={() => toggleItem(item)}
                        aria-label={`Seleccionar ${item.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <ProductThumb src={item.primaryImage} alt={item.name} />
                        <div className="min-w-0">
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {item.id} · <PriceRange min={item.priceMin} max={item.priceMax} /> ·{' '}
                            {plural(item.variantCount, 'variante', 'variantes')}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {item.categoryLabel ?? <span className="text-muted-foreground">Sin categoría</span>}
                    </TableCell>
                    <TableCell>
                      <PrepBadges item={item} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onEdit(item.id)}
                        aria-label={`Administrar ${item.name}`}
                      >
                        Administrar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {action === 'category' ? (
        <CategoryDialog
          session={session}
          selected={selectedItems}
          categories={(categoriesQuery.data ?? []).flatMap((entry) => (entry.name ? [entry.name] : []))}
          onClose={() => setAction(null)}
        />
      ) : null}
      {action === 'availability' ? (
        <AvailabilityDialog session={session} selected={selectedItems} onClose={() => setAction(null)} />
      ) : null}
      {action === 'sku' ? (
        <SkuDialog session={session} selected={selectedItems} onClose={() => setAction(null)} />
      ) : null}
      {action === 'activate' ? (
        <ActivateDialog session={session} selected={selectedItems} onClose={() => setAction(null)} />
      ) : null}
      {action === 'publish' ? (
        <PublishDialog session={session} selected={selectedItems} onClose={() => setAction(null)} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ insignias de preparación

function PrepBadges({ item }: { item: WebProductListItem }) {
  if (item.published) return <Badge variant="success">Publicado</Badge>;
  const prep = item.preparation;
  const groupBlockers = item.blockers.filter((code) => code.startsWith('GROUP_'));
  return (
    <div className="flex flex-wrap gap-1">
      {item.publishable ? <Badge variant="success">Listo para publicar</Badge> : null}
      {groupBlockers.map((code) => (
        <Badge key={code} variant="danger">
          {blockerFilterLabels[code] ?? code}
        </Badge>
      ))}
      {prep && prep.inactive > 0 ? <Badge variant="warning">{plural(prep.inactive, 'inactiva', 'inactivas')}</Badge> : null}
      {prep && prep.undecided > 0 ? <Badge variant="warning">{prep.undecided} sin política</Badge> : null}
      {prep && prep.skuPending > 0 ? <Badge variant="warning">{prep.skuPending} {prep.skuPending === 1 ? 'SKU por aprobar' : 'SKU por aprobar'}</Badge> : null}
      {prep && !prep.inactive && !prep.undecided && !prep.skuPending && !item.publishable && !groupBlockers.length ? (
        <Badge variant="outline">Revisar en el editor</Badge>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ piezas comunes de los diálogos

function WillWont({ will, wont }: { will: ReactNode[]; wont: ReactNode[] }) {
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <div className="rounded-md border border-border p-3">
        <p className="font-semibold">Qué hará</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
          {will.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      </div>
      <div className="rounded-md border border-border p-3">
        <p className="font-semibold">Qué no hará</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
          {wont.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Notice({ children, tone = 'warning' }: { children: ReactNode; tone?: 'warning' | 'danger' }) {
  const styles =
    tone === 'danger'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-amber-200 bg-amber-50/80 text-amber-900';
  return (
    <p role="note" className={`flex gap-2 rounded-md border p-3 text-sm ${styles}`}>
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function CheckLine({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className={`${checkboxClassName} mt-0.5`}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id} className="cursor-pointer leading-snug">
        {children}
      </label>
    </div>
  );
}

function ResultStat({ label, value, tone = 'success' }: { label: string; value: number; tone?: 'success' | 'warning' }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${tone === 'warning' ? 'text-gold-deep' : 'text-success'}`}>{value}</p>
    </div>
  );
}

function SkippedList({
  rows,
  nameOf,
}: {
  rows: Array<{ id: string; reason: string }>;
  nameOf?: (id: string) => string | undefined;
}) {
  if (!rows.length) return null;
  const shown = rows.slice(0, 40);
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold">Omitidos ({rows.length})</p>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
        {shown.map((row) => (
          <li key={`${row.id}-${row.reason}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <span className="font-medium">{nameOf?.(row.id) ?? row.id}</span>
            <span className="text-muted-foreground">{describeSkipReason(row.reason)}</span>
          </li>
        ))}
        {rows.length > shown.length ? (
          <li className="text-xs text-muted-foreground">… y {rows.length - shown.length} más.</li>
        ) : null}
      </ul>
    </div>
  );
}

type ShellProps = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: ActionDialogTone;
  pending: boolean;
  confirmDisabled?: boolean;
  result: ReactNode | null;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
};

/** Diálogo en dos fases: confirmación (qué hará y qué no) y resultado. */
function BulkShell({
  title,
  description,
  confirmLabel,
  tone = 'default',
  pending,
  confirmDisabled,
  result,
  error,
  onConfirm,
  onClose,
  children,
}: ShellProps) {
  const wrap = (node: ReactNode) => (typeof document === 'undefined' ? null : createPortal(node, document.body));
  if (result) {
    return wrap(
      <ActionDialog
        open
        size="lg"
        tone="success"
        title={title}
        description="Resultado de la operación"
        confirmLabel="Listo"
        cancelLabel="Cerrar"
        onClose={onClose}
        onConfirm={onClose}
      >
        {result}
      </ActionDialog>,
    );
  }
  return wrap(
    <ActionDialog
      open
      size="lg"
      tone={tone}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      isPending={pending}
      confirmDisabled={confirmDisabled}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      {children}
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </ActionDialog>,
  );
}

type DialogProps = { session: AuthSession; selected: WebProductListItem[]; onClose: () => void };

function nameLookup(selected: WebProductListItem[]) {
  const names = new Map(selected.map((item) => [item.id, `${item.name} (${item.id})`]));
  return (id: string) => names.get(id);
}

function SelectionSummary({ selected }: { selected: WebProductListItem[] }) {
  const names = selected.slice(0, 6).map((item) => item.id);
  return (
    <p className="text-sm">
      <strong>{plural(selected.length, 'grupo seleccionado', 'grupos seleccionados')}</strong>
      {': '}
      {names.join(', ')}
      {selected.length > names.length ? ` y ${selected.length - names.length} más` : ''}.
    </p>
  );
}

// ------------------------------------------------------------------ 1. categoría

function CategoryDialog({
  session,
  selected,
  categories,
  onClose,
}: DialogProps & { categories: string[] }) {
  const refresh = useRefreshCatalog();
  const [category, setCategory] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<BulkCategoryResult | null>(null);
  const listId = useId();
  const withCategory = selected.filter((item) => item.categoryLabel?.trim()).length;

  const mutation = useMutation({
    mutationFn: () =>
      bulkAssignCategory(session.tenantId, session.accessToken, {
        ids: selected.map((item) => item.id),
        categoryLabel: category.trim(),
        overwrite,
      }),
    onSuccess: (data) => {
      setResult(data);
      refresh();
    },
  });

  return (
    <BulkShell
      title="Asignar categoría"
      description="Aplica una misma categoría a los grupos seleccionados."
      confirmLabel={`Asignar a ${plural(selected.length, 'grupo', 'grupos')}`}
      pending={mutation.isPending}
      confirmDisabled={!category.trim()}
      error={mutation.isError ? errorText(mutation.error, 'No se pudo asignar la categoría.') : null}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
      result={
        result ? (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <ResultStat label="Grupos actualizados" value={result.applied.length} />
              <ResultStat label="Grupos omitidos" value={result.skipped.length} tone="warning" />
            </div>
            <SkippedList rows={result.skipped} nameOf={nameLookup(selected)} />
          </div>
        ) : null
      }
    >
      <SelectionSummary selected={selected} />
      <WillWont
        will={[
          'Asigna la categoría indicada a los grupos seleccionados.',
          'Por defecto solo toca los grupos que aún no tienen categoría.',
        ]}
        wont={[
          'No cambia precios, variantes, SKU ni existencias.',
          'No publica nada.',
          'No sobrescribe categorías existentes salvo que lo marques abajo.',
        ]}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${listId}-input`}>Categoría</Label>
        <Input
          id={`${listId}-input`}
          list={listId}
          value={category}
          maxLength={80}
          placeholder="Ej.: Broches y Pines"
          data-dialog-autofocus
          onChange={(event) => setCategory(event.target.value)}
        />
        <datalist id={listId}>
          {categories.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
      <div className="space-y-2 rounded-md border border-border p-3">
        <CheckLine checked={overwrite} onChange={setOverwrite}>
          Sobrescribir también las categorías ya asignadas
        </CheckLine>
        {overwrite ? (
          <Notice>
            {withCategory
              ? `${plural(withCategory, 'grupo seleccionado ya tiene', 'grupos seleccionados ya tienen')} categoría y la perderá(n): se reemplazará por la nueva.`
              : 'Ningún grupo seleccionado tiene categoría todavía, así que no habrá reemplazos.'}
          </Notice>
        ) : withCategory ? (
          <p className="text-xs text-muted-foreground">
            {plural(withCategory, 'grupo seleccionado ya tiene', 'grupos seleccionados ya tienen')} categoría y se
            omitirá(n).
          </p>
        ) : null}
      </div>
    </BulkShell>
  );
}

// ------------------------------------------------------------------ 2. disponibilidad

function AvailabilityDialog({ session, selected, onClose }: DialogProps) {
  const refresh = useRefreshCatalog();
  const [policy, setPolicy] = useState<'STOCKED' | 'MADE_TO_ORDER' | ''>('');
  const [result, setResult] = useState<BulkAvailabilityResult | null>(null);
  const undecided = selected.reduce((sum, item) => sum + (item.preparation?.undecided ?? 0), 0);

  const mutation = useMutation({
    mutationFn: () =>
      bulkSetAvailability(session.tenantId, session.accessToken, {
        ids: selected.map((item) => item.id),
        policy: policy as 'STOCKED' | 'MADE_TO_ORDER',
      }),
    onSuccess: (data) => {
      setResult(data);
      refresh();
    },
  });

  return (
    <BulkShell
      title="Definir disponibilidad (solo variantes sin decidir)"
      description="Elige cómo se venderán las variantes que todavía no tienen política."
      confirmLabel="Definir disponibilidad"
      pending={mutation.isPending}
      confirmDisabled={!policy}
      error={mutation.isError ? errorText(mutation.error, 'No se pudo definir la disponibilidad.') : null}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
      result={
        result ? (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <ResultStat label="Variantes actualizadas" value={result.updated.length} />
              <ResultStat label="Ya decididas (no se tocaron)" value={result.alreadyDecided.length} tone="warning" />
            </div>
            <p className="text-sm text-muted-foreground">
              Las variantes siguen en el estado que tenían (activas o inactivas): este paso solo fija la política.
            </p>
          </div>
        ) : null
      }
    >
      <SelectionSummary selected={selected} />
      <p className="text-sm">
        Variantes sin decidir en la selección: <strong>{undecided}</strong>.
      </p>
      <WillWont
        will={[
          'Fija la política elegida únicamente en las variantes sin decidir de los grupos seleccionados.',
          'Inventario controlado activa el control de existencias de la variante; bajo pedido lo desactiva.',
        ]}
        wont={[
          'No sobrescribe variantes que ya tienen política.',
          'No modifica existencias, precios ni SKU.',
          'No activa variantes ni publica.',
        ]}
      />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Política para las variantes sin decidir</legend>
        {(
          [
            ['STOCKED', 'Inventario controlado', 'Se vende según las existencias del ERP.'],
            ['MADE_TO_ORDER', 'Bajo pedido', 'Se fabrica o se pide al recibir la compra; no depende de existencias.'],
          ] as const
        ).map(([value, label, text]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
              policy === value ? 'border-gold-dark bg-gold-light/10' : 'border-border'
            }`}
          >
            <input
              type="radio"
              name="bulk-policy"
              className="mt-1 h-4 w-4 accent-[var(--gold-dark,#9a7a2e)]"
              checked={policy === value}
              onChange={() => setPolicy(value)}
            />
            <span className="text-sm">
              <span className="block font-semibold">{label}</span>
              <span className="block text-muted-foreground">{text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Notice>
        Es una decisión comercial: elígela solo si sabes cómo se vende este grupo de productos.
      </Notice>
    </BulkShell>
  );
}

// ------------------------------------------------------------------ 3. aprobar SKU

function SkuDialog({ session, selected, onClose }: DialogProps) {
  const refresh = useRefreshCatalog();
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<BulkSkuApproveResult | null>(null);
  const ids = selected.map((item) => item.id);

  const reviewQuery = useQuery({
    queryKey: ['web-catalog-sku-review', session.tenantId, ids.join('|')],
    queryFn: async () => {
      const pages = await Promise.all(ids.map((id) => getSkuReview(session.tenantId, session.accessToken, id)));
      return pages.flatMap((entry) => entry.items);
    },
    staleTime: 0,
  });
  const rows: SkuReviewRow[] = reviewQuery.data ?? [];
  const changed = rows.filter((row) => row.rule !== 'ORIGINAL').length;

  const mutation = useMutation({
    mutationFn: () => bulkApproveSkus(session.tenantId, session.accessToken, ids),
    onSuccess: (data) => {
      setResult(data);
      refresh();
    },
  });

  return (
    <BulkShell
      title="Revisar y aprobar SKUs"
      description="Los SKU actuales son propuestas automáticas. Aprobarlos es una decisión humana."
      confirmLabel="Aprobar estos SKU"
      tone="warning"
      pending={mutation.isPending}
      confirmDisabled={!ack || reviewQuery.isLoading || rows.length === 0}
      error={mutation.isError ? errorText(mutation.error, 'No se pudieron aprobar los SKU.') : null}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
      result={
        result ? (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <ResultStat label="Variantes con SKU aprobado" value={result.approved.length} />
              <ResultStat label="Variantes sin SKU (no aprobables)" value={result.withoutSku.length} tone="warning" />
            </div>
            <p className="text-sm text-muted-foreground">
              Los SKU no se modificaron: quedaron aprobados tal como estaban. Las variantes siguen inactivas hasta
              el paso 4.
            </p>
          </div>
        ) : null
      }
    >
      <SelectionSummary selected={selected} />
      <Notice>
        Los SKU que ves son <strong>propuestas generadas por reglas</strong>, no códigos confirmados por el
        negocio. Solo úsalos como definitivos si alguien responsable los revisó; antes de eso sirven únicamente para
        pruebas.
      </Notice>
      <WillWont
        will={['Marca como aprobados los SKU actuales de las variantes listadas (sin cambiar su texto).']}
        wont={[
          'No modifica ningún SKU: si hay que corregir uno, hazlo en el editor antes de aprobar.',
          'No activa variantes, no cambia precios ni existencias, no publica.',
        ]}
      />
      {reviewQuery.isLoading ? <p className="text-sm text-muted-foreground">Cargando propuestas…</p> : null}
      {reviewQuery.isError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {errorText(reviewQuery.error, 'No se pudo cargar la revisión de SKU.')}
        </p>
      ) : null}
      {reviewQuery.data ? (
        rows.length ? (
          <div className="space-y-2">
            <p className="text-sm">
              <strong>{plural(rows.length, 'variante pendiente', 'variantes pendientes')}</strong>
              {changed ? ` · ${plural(changed, 'propuesta difiere', 'propuestas difieren')} del SKU original` : ''}.
            </p>
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead className="sticky top-0 bg-card text-xs text-muted-foreground shadow-sm">
                  <tr>
                    <th scope="col" className="p-2 font-medium">Variante</th>
                    <th scope="col" className="p-2 font-medium">SKU original</th>
                    <th scope="col" className="p-2 font-medium">SKU propuesto</th>
                    <th scope="col" className="p-2 font-medium">Regla</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.variantId} className="border-t border-border align-top">
                      <td className="p-2">
                        <span className="block font-medium">{row.groupName ?? row.groupId}</span>
                        <span className="block text-xs text-muted-foreground">{row.name}</span>
                      </td>
                      <td className="p-2 font-mono text-xs">{row.originalSku ?? <em className="font-sans">sin SKU</em>}</td>
                      <td className="p-2 font-mono text-xs font-semibold">{row.proposedSku ?? '—'}</td>
                      <td className="p-2 text-xs">{skuRuleLabels[row.rule] ?? row.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
            Estos grupos no tienen SKU pendientes de aprobación.
          </p>
        )
      ) : null}
      <CheckLine checked={ack} onChange={setAck}>
        He revisado las propuestas y, como persona responsable, apruebo estos SKU.
      </CheckLine>
    </BulkShell>
  );
}

// ------------------------------------------------------------------ 4. activar

function ActivateDialog({ session, selected, onClose }: DialogProps) {
  const refresh = useRefreshCatalog();
  const [result, setResult] = useState<BulkActivateResult | null>(null);
  const inactive = selected.reduce((sum, item) => sum + (item.preparation?.inactive ?? 0), 0);
  const skuPending = selected.reduce((sum, item) => sum + (item.preparation?.skuPending ?? 0), 0);
  const undecided = selected.reduce((sum, item) => sum + (item.preparation?.undecided ?? 0), 0);

  const mutation = useMutation({
    mutationFn: () => bulkActivateVariants(session.tenantId, session.accessToken, selected.map((item) => item.id)),
    onSuccess: (data) => {
      setResult(data);
      refresh();
    },
  });

  const reasons = new Map<string, number>();
  for (const row of result?.skipped ?? []) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);

  return (
    <BulkShell
      title="Activar variantes"
      description="Activa las variantes inactivas que ya están listas."
      confirmLabel="Activar variantes"
      tone="warning"
      pending={mutation.isPending}
      error={mutation.isError ? errorText(mutation.error, 'No se pudieron activar las variantes.') : null}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
      result={
        result ? (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <ResultStat label="Variantes activadas" value={result.activated.length} />
              <ResultStat label="Variantes omitidas" value={result.skipped.length} tone="warning" />
            </div>
            {reasons.size ? (
              <div className="space-y-1.5">
                <p className="text-sm font-semibold">Motivos de omisión</p>
                <ul className="space-y-1 rounded-md border border-border p-2 text-sm">
                  {[...reasons.entries()].map(([reason, count]) => (
                    <li key={reason}>
                      <strong>{count}</strong> · {describeSkipReason(reason)}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Completa el paso que falta (2 disponibilidad o 3 aprobar SKU) y vuelve a activar.
                </p>
              </div>
            ) : null}
          </div>
        ) : null
      }
    >
      <SelectionSummary selected={selected} />
      <p className="text-sm">
        En la selección hay <strong>{inactive}</strong> variantes inactivas ({undecided} sin política y {skuPending}{' '}
        con SKU sin aprobar).
      </p>
      <WillWont
        will={[
          'Activa solo las variantes inactivas que tienen SKU aprobado, política decidida y precio válido.',
          'Omite el resto y te dice el motivo de cada una.',
        ]}
        wont={[
          'No cambia precios, SKU ni existencias.',
          'No publica el grupo en el e-commerce.',
          'No toca variantes ya activas.',
        ]}
      />
      <Notice>
        Una variante activa pasa a estar <strong>visible para ventas en el ERP</strong>. Activa solo cuando estés
        listo para que se pueda vender.
      </Notice>
    </BulkShell>
  );
}

// ------------------------------------------------------------------ 5. publicar

function PublishDialog({ session, selected, onClose }: DialogProps) {
  const refresh = useRefreshCatalog();
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<BulkPublishResult | null>(null);
  const ids = selected.map((item) => item.id);

  // Datos frescos de cada grupo para decidir con exactitud qué cumple y qué no.
  const detailsQuery = useQuery({
    queryKey: ['web-product', 'publish-check', session.tenantId, ids.join('|')],
    queryFn: () =>
      Promise.all(ids.map((id) => getWebProduct(session.tenantId, session.accessToken, id))),
    staleTime: 0,
  });
  const details: WebProductDetail[] = detailsQuery.data ?? [];
  const ready = details.filter((detail) => detail.publishable && !detail.published);
  const notReady = details.filter((detail) => !detail.publishable && !detail.published);
  const already = details.filter((detail) => detail.published);
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  const variantNameFor = (groupId: string) => (tag: string) => {
    const found = byId.get(groupId)?.variants.find((v) => v.id === tag || v.internalId === tag);
    return found ? (found.webOptions?.title ?? found.sku ?? found.name) : tag;
  };

  const mutation = useMutation({
    mutationFn: () => bulkPublish(session.tenantId, session.accessToken, ids),
    onSuccess: (data) => {
      setResult(data);
      refresh();
    },
  });

  return (
    <BulkShell
      title="Publicar seleccionados"
      description={`Publica solo los grupos que elegiste (máximo ${MAX_PUBLISH}). Los que no cumplan se rechazan.`}
      confirmLabel={ready.length ? `Publicar ${plural(ready.length, 'grupo', 'grupos')}` : 'Publicar'}
      tone="warning"
      pending={mutation.isPending}
      confirmDisabled={!ack || detailsQuery.isLoading || ready.length === 0}
      error={mutation.isError ? errorText(mutation.error, 'No se pudo publicar.') : null}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
      result={
        result ? (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <ResultStat label="Grupos publicados" value={result.published.length} />
              <ResultStat label="Grupos rechazados" value={result.rejected.length} tone="warning" />
            </div>
            {result.published.length ? (
              <p className="flex items-start gap-2 text-sm">
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <span>Publicados: {result.published.join(', ')}.</span>
              </p>
            ) : null}
            {result.rejected.map((entry) => (
              <div key={entry.id} className="space-y-1">
                <p className="text-sm font-semibold">
                  {byId.get(entry.id)?.name ?? entry.id} ({entry.id})
                </p>
                <BlockerList
                  blockers={entry.blockers}
                  variantName={variantNameFor(entry.id)}
                  title="No se publicó: requisitos pendientes"
                />
              </div>
            ))}
          </div>
        ) : null
      }
    >
      <SelectionSummary selected={selected} />
      <WillWont
        will={[
          'Publica en el e-commerce los grupos seleccionados que cumplen todos los requisitos.',
          'Rechaza, sin publicar, los que no cumplen y te muestra qué les falta.',
        ]}
        wont={[
          'No publica nada que no hayas seleccionado: no existe «publicar todo».',
          'No cambia precios ni existencias, ni prepara datos que falten.',
        ]}
      />
      {detailsQuery.isLoading ? <p className="text-sm text-muted-foreground">Comprobando requisitos…</p> : null}
      {detailsQuery.isError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {errorText(detailsQuery.error, 'No se pudieron comprobar los requisitos.')}
        </p>
      ) : null}
      {detailsQuery.data ? (
        <div className="space-y-3">
          <div className="rounded-md border border-border p-3">
            <p className="text-sm font-semibold">
              Cumplen los requisitos ({ready.length})
            </p>
            {ready.length ? (
              <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                {ready.map((detail) => (
                  <li key={detail.id}>
                    {detail.name} ({detail.id})
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Ninguno de los seleccionados está listo.</p>
            )}
          </div>
          {notReady.length ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-amber-900">
                No cumplen y serán rechazados ({notReady.length})
              </p>
              {notReady.map((detail) => (
                <div key={detail.id} className="space-y-1">
                  <p className="text-sm font-medium">
                    {detail.name} ({detail.id})
                  </p>
                  <BlockerList
                    blockers={detail.blockers}
                    variantName={variantNameFor(detail.id)}
                    title="Requisitos pendientes"
                  />
                </div>
              ))}
            </div>
          ) : null}
          {already.length ? (
            <p className="text-xs text-muted-foreground">
              Ya publicados (se ignoran): {already.map((detail) => detail.id).join(', ')}.
            </p>
          ) : null}
        </div>
      ) : null}
      <CheckLine checked={ack} onChange={setAck}>
        Confirmo que quiero publicar en el e-commerce los grupos que cumplen los requisitos.
      </CheckLine>
    </BulkShell>
  );
}
