'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  PackageSearch,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatQuantity } from '@/components/operations/pos/pos-utils';
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
import { getProductSalesRanking, type ProductSalesMetric } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { translateProductUnit } from '@/lib/display-labels';
import { formatCurrency, formatDate } from '@/lib/utils';

const pageSizes = [25, 50, 100];

export function ProductSalesRankingView() {
  const session = useMemo(() => getSession(), []);
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<'most' | 'least'>('most');
  const [salesState, setSalesState] = useState<'all' | 'sold' | 'unsold'>('all');
  const [category, setCategory] = useState('all');
  const [unit, setUnit] = useState('all');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const rankingQuery = useQuery({
    queryKey: ['product-sales-ranking', session?.tenantId],
    queryFn: () => getProductSalesRanking(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const ranking = rankingQuery.data;
  const categories = useMemo(
    () => Array.from(new Set(ranking?.mostSold.map((product) => product.categoryName) ?? [])).sort(localeSort),
    [ranking],
  );
  const units = useMemo(
    () => Array.from(new Set(ranking?.mostSold.map((product) => product.unit) ?? [])).sort(localeSort),
    [ranking],
  );

  const filteredProducts = useMemo(() => {
    if (!ranking) return [];
    const normalizedSearch = normalize(search);
    const source = order === 'most' ? ranking.mostSold : ranking.leastSold;

    return source.filter((product) => {
      const searchableText = [product.name, product.sku, product.brand, product.categoryName]
        .filter(Boolean)
        .join(' ');
      const matchesSearch = !normalizedSearch || normalize(searchableText).includes(normalizedSearch);
      const matchesSales = salesState === 'all'
        || (salesState === 'sold' && product.quantitySold > 0)
        || (salesState === 'unsold' && product.quantitySold === 0);

      return matchesSearch
        && matchesSales
        && (category === 'all' || product.categoryName === category)
        && (unit === 'all' || product.unit === unit);
    });
  }, [category, order, ranking, salesState, search, unit]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleProducts = filteredProducts.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const rangeStart = filteredProducts.length ? (currentPage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(currentPage * pageSize, filteredProducts.length);
  const hasFilters = Boolean(search || category !== 'all' || unit !== 'all' || salesState !== 'all');

  if (!session) {
    return <MessageCard title="Sesión requerida" detail="Inicia sesión para consultar el ranking de productos." />;
  }

  if (rankingQuery.isLoading) return <ProductSalesSkeleton />;

  if (rankingQuery.isError || !ranking) {
    return (
      <MessageCard
        title="Ranking no disponible"
        detail="No se pudo cargar el ranking. Revisa la conexión con el API."
        action={<Button variant="outline" onClick={() => void rankingQuery.refetch()}>Reintentar</Button>}
      />
    );
  }

  function resetFilters() {
    setSearch('');
    setSalesState('all');
    setCategory('all');
    setUnit('all');
    setPage(1);
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 pb-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-600">Analítica de productos</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Productos vendidos</h1>
          <p className="mt-1 text-sm text-slate-500">
            Ranking de los últimos 12 meses según las facturas emitidas y cobradas.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void rankingQuery.refetch()} disabled={rankingQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${rankingQuery.isFetching ? 'animate-spin' : ''}`} />
            Actualizar
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard"><ArrowLeft className="h-4 w-4" />Volver al panel</Link>
          </Button>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Productos activos" value={ranking.productCount} />
        <MetricCard label="Con ventas" value={ranking.productsWithSales} positive />
        <MetricCard label="Sin ventas" value={ranking.productsWithoutSales} warning />
      </section>

      <Card className="overflow-hidden border-slate-200 shadow-sm">
        <CardHeader className="border-b border-slate-100 pb-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-start gap-3">
              <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${order === 'most' ? 'bg-emerald-50 text-emerald-600' : 'bg-violet-50 text-violet-600'}`}>
                {order === 'most' ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
              </span>
              <div>
                <CardTitle>{order === 'most' ? 'Más vendidos' : 'Menos vendidos'}</CardTitle>
                <CardDescription>Ordenados por cantidad de unidades; el importe se usa como desempate.</CardDescription>
              </div>
            </div>
            <div className="inline-grid grid-cols-2 rounded-lg bg-slate-100 p-1">
              <RankingButton active={order === 'most'} onClick={() => { setOrder('most'); setPage(1); }}>Más vendidos</RankingButton>
              <RankingButton active={order === 'least'} onClick={() => { setOrder('least'); setPage(1); }}>Menos vendidos</RankingButton>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="grid gap-3 border-b border-slate-100 bg-slate-50/60 p-4 md:grid-cols-2 xl:grid-cols-[minmax(260px,1.5fr)_repeat(3,minmax(150px,0.7fr))_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Buscar nombre, SKU, marca o categoría" className="bg-white pl-9" />
            </div>
            <FilterSelect value={salesState} onChange={(value) => { setSalesState(value as typeof salesState); setPage(1); }} label="Estado de venta">
              <option value="all">Todos</option><option value="sold">Con ventas</option><option value="unsold">Sin ventas</option>
            </FilterSelect>
            <FilterSelect value={category} onChange={(value) => { setCategory(value); setPage(1); }} label="Categoría">
              <option value="all">Todas las categorías</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}
            </FilterSelect>
            <FilterSelect value={unit} onChange={(value) => { setUnit(value); setPage(1); }} label="Unidad">
              <option value="all">Todas las unidades</option>{units.map((item) => <option key={item} value={item}>{translateProductUnit(item)}</option>)}
            </FilterSelect>
            <Button variant="outline" onClick={resetFilters} disabled={!hasFilters} className="bg-white"><RefreshCw className="h-4 w-4" />Limpiar</Button>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-16">#</TableHead><TableHead>Producto</TableHead><TableHead>Categoría</TableHead><TableHead>Unidad</TableHead>
                <TableHead className="text-right">Cantidad</TableHead><TableHead className="text-right">Facturas</TableHead><TableHead className="text-right">Total vendido</TableHead><TableHead>Última venta</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {visibleProducts.length ? visibleProducts.map((product, index) => (
                  <ProductRow key={product.productId} product={product} position={(currentPage - 1) * pageSize + index + 1} />
                )) : (
                  <TableRow><TableCell colSpan={8} className="h-40 text-center text-sm text-slate-500">No hay productos que coincidan con los filtros seleccionados.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <footer className="flex flex-col gap-3 border-t border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>Mostrar</span>
              <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-blue-500" aria-label="Productos por página">
                {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
              <span>por página · {rangeStart}-{rangeEnd} de {filteredProducts.length}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Página anterior"><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-20 text-center text-xs font-medium text-slate-600">{currentPage} de {totalPages}</span>
              <Button variant="outline" size="icon" disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label="Página siguiente"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </footer>
        </CardContent>
      </Card>
    </div>
  );
}

function ProductRow({ product, position }: { product: ProductSalesMetric; position: number }) {
  return (
    <TableRow>
      <TableCell className="font-medium text-slate-500">{position}</TableCell>
      <TableCell><Link href={`/products?q=${encodeURIComponent(product.sku ?? product.name)}`} className="font-semibold text-slate-900 hover:text-blue-600">{product.name}</Link><p className="mt-0.5 text-xs text-slate-500">{product.sku ?? 'Sin SKU'}{product.brand ? ` · ${product.brand}` : ''}</p></TableCell>
      <TableCell><Badge variant="outline">{product.categoryName}</Badge></TableCell><TableCell>{translateProductUnit(product.unit)}</TableCell>
      <TableCell className="text-right font-semibold">{formatQuantity(product.quantitySold)}</TableCell><TableCell className="text-right">{product.invoiceCount}</TableCell>
      <TableCell className="text-right font-semibold">{formatCurrency(product.grossAmount)}</TableCell><TableCell>{product.lastSoldAt ? formatDate(product.lastSoldAt) : <span className="text-slate-400">Sin ventas</span>}</TableCell>
    </TableRow>
  );
}

function MetricCard({ label, value, positive = false, warning = false }: { label: string; value: number; positive?: boolean; warning?: boolean }) {
  return <Card className="border-slate-200 shadow-sm"><CardContent className="flex items-center justify-between gap-3 p-4"><div><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-slate-950">{value}</p></div><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${positive ? 'bg-emerald-50 text-emerald-600' : warning ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'}`}><PackageSearch className="h-5 w-5" /></span></CardContent></Card>;
}

function FilterSelect({ value, onChange, label, children }: { value: string; onChange: (value: string) => void; label: string; children: React.ReactNode }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-blue-500" aria-label={label}>{children}</select>;
}

function RankingButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`h-8 rounded-md px-4 text-xs font-medium transition ${active ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{children}</button>;
}

function MessageCard({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{detail}</CardDescription>{action ? <div className="pt-3">{action}</div> : null}</CardHeader></Card>;
}

function ProductSalesSkeleton() {
  return <div className="animate-pulse space-y-4"><div className="h-16 w-full rounded-xl bg-slate-100" /><div className="grid gap-3 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-24 rounded-xl bg-white" />)}</div><div className="h-[520px] rounded-xl bg-white" /></div>;
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
}

function localeSort(first: string, second: string) {
  return first.localeCompare(second, 'es', { sensitivity: 'base' });
}
