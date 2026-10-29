'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AuthSession } from '@/lib/auth-session';
import { getWebProductCategories, listWebProducts } from '@/lib/web-catalog-api';
import { formatQuantity } from '../pos/pos-utils';
import { WebProductEditor } from './web-product-editor';
import { PreparationPanel } from './web-catalog-prep';
import { PriceRange, ProductThumb, selectClassName } from './web-catalog-ui';

const PAGE_SIZE = 25;

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; id: string };
type Section = 'products' | 'prep';

export function WebCatalogPanel({ session }: { session: AuthSession }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  // Sección activa: se conserva al abrir y cerrar el editor.
  const [section, setSection] = useState<Section>('products');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [published, setPublished] = useState<'' | 'true' | 'false'>('');
  const [category, setCategory] = useState('');
  // Pila de cursores: la posición 0 es la primera página.
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setCursors([undefined]);
  }, [debounced, published, category]);

  const cursor = cursors[cursors.length - 1];
  const listQuery = useQuery({
    queryKey: ['web-products', session.tenantId, debounced, published, category, cursor ?? ''],
    queryFn: () =>
      listWebProducts(session.tenantId, session.accessToken, {
        q: debounced || undefined,
        published: published || undefined,
        category: category || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });
  const categoriesQuery = useQuery({
    queryKey: ['web-product-categories', session.tenantId],
    queryFn: () => getWebProductCategories(session.tenantId, session.accessToken),
  });

  if (view.kind !== 'list') {
    return (
      <WebProductEditor
        session={session}
        mode={view}
        onBack={() => setView({ kind: 'list' })}
        onCreated={(id) => setView({ kind: 'edit', id })}
      />
    );
  }

  const categories = (categoriesQuery.data ?? []).filter(
    (entry): entry is { name: string; count: number } => Boolean(entry.name),
  );
  const totalGroups = (categoriesQuery.data ?? []).reduce((sum, entry) => sum + entry.count, 0);
  const items = listQuery.data?.items ?? [];
  const nextCursor = listQuery.data?.nextCursor ?? null;
  const page = cursors.length;
  const filtering = Boolean(debounced || published || category);

  const sectionTabs = (
    <div
      role="group"
      aria-label="Secciones del catálogo web"
      className="inline-flex rounded-md border border-border bg-muted/40 p-1"
    >
      {(
        [
          ['products', 'Productos'],
          ['prep', 'Preparación'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={section === id}
          onClick={() => setSection(id)}
          className={`h-9 rounded px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            section === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (section === 'prep') {
    return (
      <div className="space-y-4">
        {sectionTabs}
        <PreparationPanel session={session} onEdit={(id) => setView({ kind: 'edit', id })} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sectionTabs}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_11rem_14rem]">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="bg-white pl-9"
              placeholder="Buscar nombre, slug, SKU o ID"
              aria-label="Buscar en el catálogo web"
            />
          </div>
          <select
            value={published}
            onChange={(event) => setPublished(event.target.value as '' | 'true' | 'false')}
            className={selectClassName}
            aria-label="Filtrar por estado de publicación"
          >
            <option value="">Todos los estados</option>
            <option value="true">Publicados</option>
            <option value="false">No publicados</option>
          </select>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className={selectClassName}
            aria-label="Filtrar por categoría"
          >
            <option value="">Todas las categorías</option>
            {categories.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} ({entry.count})
              </option>
            ))}
          </select>
        </div>
        <Button type="button" onClick={() => setView({ kind: 'create' })}>
          <Plus className="h-4 w-4" />
          Nuevo producto web
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Catálogo web</CardTitle>
          <CardDescription>
            {categoriesQuery.data
              ? `${totalGroups} grupos de productos en total. `
              : ''}
            Cada grupo reúne las variantes de un mismo producto. Los precios se muestran tal cual,
            sin sumar ni dividir ITBIS.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {listQuery.isError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : 'No se pudo cargar el catálogo web.'}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span>
              {listQuery.isLoading
                ? 'Cargando…'
                : items.length
                  ? `Página ${page} · ${items.length} ${items.length === 1 ? 'grupo' : 'grupos'}${filtering ? ' con los filtros aplicados' : ''}`
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
              <div key={item.id} className="rounded-md border border-border p-3">
                <div className="flex items-start gap-3">
                  <ProductThumb src={item.primaryImage} alt={item.name} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug">{item.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.categoryLabel ?? 'Sin categoría'} · {item.id}
                    </p>
                  </div>
                  <PublicationBadge item={item} />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-semibold">
                    <PriceRange min={item.priceMin} max={item.priceMax} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.variantCount} {item.variantCount === 1 ? 'variante' : 'variantes'}
                  </span>
                </div>
                <AvailabilityBadges item={item} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => setView({ kind: 'edit', id: item.id })}
                  aria-label={`Administrar ${item.name}`}
                >
                  Administrar
                </Button>
              </div>
            ))}
          </div>

          <div className="hidden md:block">
            <Table wrapperClassName="max-h-[65vh] rounded-md border border-border overflow-auto">
              <TableHeader className="sticky top-0 z-10 bg-card shadow-sm">
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead>Categoría</TableHead>
                  <TableHead>Variantes</TableHead>
                  <TableHead>Disponibilidad</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <ProductThumb src={item.primaryImage} alt={item.name} />
                        <div className="min-w-0">
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {item.id} · {item.slug}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{item.categoryLabel ?? <span className="text-muted-foreground">Sin categoría</span>}</TableCell>
                    <TableCell>
                      <div className="font-medium">
                        <PriceRange min={item.priceMin} max={item.priceMax} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {item.variantCount} {item.variantCount === 1 ? 'variante' : 'variantes'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <AvailabilityBadges item={item} />
                    </TableCell>
                    <TableCell>
                      <PublicationBadge item={item} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setView({ kind: 'edit', id: item.id })}
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
    </div>
  );
}

function PublicationBadge({
  item,
}: {
  item: { published: boolean; publishable: boolean; blockers: string[] };
}) {
  if (item.published) return <Badge variant="success">Publicado</Badge>;
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="outline">No publicado</Badge>
      {item.publishable ? (
        <span className="text-xs text-muted-foreground">Listo para publicar</span>
      ) : (
        <span className="text-xs text-amber-800">
          {item.blockers.length} {item.blockers.length === 1 ? 'requisito pendiente' : 'requisitos pendientes'}
        </span>
      )}
    </div>
  );
}

function AvailabilityBadges({
  item,
}: {
  item: {
    availability: { stocked: number; madeToOrder: number; undecided: number };
    availableUnits: number;
  };
}) {
  const { stocked, madeToOrder, undecided } = item.availability;
  return (
    <div className="mt-2 flex flex-wrap gap-1 md:mt-0">
      {stocked ? (
        <Badge variant="success">
          {stocked} con inventario · {formatQuantity(item.availableUnits)} disp.
        </Badge>
      ) : null}
      {madeToOrder ? <Badge variant="info">{madeToOrder} bajo pedido</Badge> : null}
      {undecided ? <Badge variant="warning">{undecided} sin decidir</Badge> : null}
      {!stocked && !madeToOrder && !undecided ? <Badge variant="outline">Sin variantes activas</Badge> : null}
    </div>
  );
}
