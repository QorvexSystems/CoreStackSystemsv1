'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  createWarehouseProduct,
  getWarehouseProducts,
  updateWarehouseProduct,
  type Product,
  type WarehouseProductPayload,
} from '@/lib/api';
import { ModuleHeader } from './module-header';
import { SessionRequired, useCurrentSession } from './session-required';

const emptyForm = (): WarehouseProductPayload => ({
  name: '',
  sku: '',
  barcode: '',
  brand: '',
  description: '',
  unit: 'UNIT',
  cost: undefined,
  salePrice: undefined,
  minStock: 0,
  taxCategory: 'ITBIS_18',
  taxRate: 0.18,
  initialQuantity: 0,
});

export function WarehouseProductForm({
  productId,
  embedded = false,
  onSaved,
  onCancel,
}: {
  productId?: string;
  embedded?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const session = useCurrentSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<WarehouseProductPayload>(emptyForm);
  const [loadedProductId, setLoadedProductId] = useState<string | null>(null);
  const isEditing = Boolean(productId);

  const productsQuery = useQuery({
    queryKey: ['warehouse-products', session?.tenantId],
    queryFn: () => getWarehouseProducts(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session && productId),
  });
  const product = productsQuery.data?.find((item) => item.id === productId) ?? null;

  useEffect(() => {
    if (!product || loadedProductId === product.id) return;
    setLoadedProductId(product.id);
    setForm({
      name: product.name,
      sku: product.sku ?? '',
      barcode: product.barcode ?? '',
      brand: product.brand ?? '',
      description: product.description ?? '',
      unit: product.unit,
      cost: product.cost === null ? undefined : Number(product.cost),
      salePrice: product.salePrice === null ? undefined : Number(product.salePrice),
      minStock: product.minStock,
      taxCategory:
        Number(product.taxRate) === 0
          ? 'EXEMPT'
          : Number(product.taxRate) === 0.16
            ? 'ITBIS_16'
            : 'ITBIS_18',
      taxRate: Number(product.taxRate),
      initialQuantity: 0,
    });
  }, [loadedProductId, product]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!session) throw new Error('Sesión requerida.');
      if (!form.name.trim()) throw new Error('Indica el nombre del producto.');
      if (!form.salePrice || Number(form.salePrice) <= 0) {
        throw new Error('El precio de venta debe ser mayor que cero.');
      }
      const payload: WarehouseProductPayload = {
        ...form,
        name: form.name.trim(),
        sku: form.sku?.trim() || undefined,
        barcode: form.barcode?.trim() || undefined,
        brand: form.brand?.trim() || undefined,
        description: form.description?.trim() || undefined,
        cost: form.cost === undefined ? undefined : Number(form.cost),
        salePrice: form.salePrice === undefined ? undefined : Number(form.salePrice),
        initialQuantity: form.initialQuantity === undefined ? 0 : Number(form.initialQuantity),
      };

      if (productId) {
        const { initialQuantity: _initialQuantity, ...updatePayload } = payload;
        return updateWarehouseProduct(
          session.tenantId,
          session.accessToken,
          productId,
          updatePayload,
        );
      }
      return createWarehouseProduct(session.tenantId, session.accessToken, payload);
    },
    onSuccess: async (savedProduct) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-products'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-stock'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-movements'] }),
      ]);
      toast.success(
        isEditing ? 'Producto de almacén actualizado.' : 'Producto agregado al almacén.',
        {
          description: savedProduct.name,
        },
      );
      if (embedded) {
        onSaved?.();
        return;
      }
      router.push('/warehouse');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar el producto.');
    },
  });

  if (!session) return <SessionRequired session={session} />;

  if (productId && !productsQuery.isLoading && !product) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Producto no encontrado</CardTitle>
          <CardDescription>El producto de almacén no existe o ya fue eliminado.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => router.push('/warehouse')}>Volver a almacén</Button>
        </CardContent>
      </Card>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveMutation.mutate();
  }

  return (
    <div className={embedded ? '' : 'space-y-6'}>
      {!embedded ? (
        <ModuleHeader
          title={isEditing ? 'Editar producto de almacén' : 'Nuevo producto de almacén'}
          description="Productos B2B que se venden desde Toma de órdenes sin alterar el inventario de ventas."
        />
      ) : null}
      <Card className={embedded ? 'border-0 shadow-none' : undefined}>
        {!embedded ? (
          <CardHeader>
            <CardTitle>Ficha del producto</CardTitle>
            <CardDescription>
              Define el precio B2B y, si aplica, la existencia inicial del almacén.
            </CardDescription>
          </CardHeader>
        ) : null}
        <CardContent>
          <form className="grid gap-4 md:grid-cols-3" onSubmit={submit}>
            <Field id="warehouse-product-name" label="Nombre" required>
              <Input
                id="warehouse-product-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                maxLength={160}
                required
              />
            </Field>
            <Field id="warehouse-product-sku" label="SKU / código">
              <Input
                id="warehouse-product-sku"
                value={form.sku ?? ''}
                onChange={(event) => setForm({ ...form, sku: event.target.value })}
                maxLength={80}
              />
            </Field>
            <Field id="warehouse-product-barcode" label="Código de barras">
              <Input
                id="warehouse-product-barcode"
                value={form.barcode ?? ''}
                onChange={(event) => setForm({ ...form, barcode: event.target.value })}
                maxLength={80}
                placeholder="Se generará automáticamente"
              />
              {!product ? (
                <p className="text-xs text-muted-foreground">
                  Si lo dejas vacío, ALLPA creará un código interno único.
                </p>
              ) : null}
            </Field>
            <Field id="warehouse-product-brand" label="Marca">
              <Input
                id="warehouse-product-brand"
                value={form.brand ?? ''}
                onChange={(event) => setForm({ ...form, brand: event.target.value })}
                maxLength={80}
              />
            </Field>
            <Field id="warehouse-product-cost" label="Costo unitario">
              <Input
                id="warehouse-product-cost"
                type="number"
                min="0"
                step="0.01"
                value={form.cost ?? ''}
                onChange={(event) =>
                  setForm({
                    ...form,
                    cost: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field id="warehouse-product-price" label="Precio de venta B2B" required>
              <Input
                id="warehouse-product-price"
                type="number"
                min="0.01"
                step="0.01"
                value={form.salePrice ?? ''}
                onChange={(event) =>
                  setForm({
                    ...form,
                    salePrice: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                required
              />
            </Field>
            <Field id="warehouse-product-unit" label="Unidad">
              <select
                id="warehouse-product-unit"
                value={form.unit ?? 'UNIT'}
                onChange={(event) => setForm({ ...form, unit: event.target.value })}
                className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
              >
                {unitOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="warehouse-product-tax" label="Impuesto">
              <select
                id="warehouse-product-tax"
                value={form.taxCategory ?? 'ITBIS_18'}
                onChange={(event) => {
                  const taxCategory = event.target.value as WarehouseProductPayload['taxCategory'];
                  setForm({
                    ...form,
                    taxCategory,
                    taxRate:
                      taxCategory === 'EXEMPT' ? 0 : taxCategory === 'ITBIS_16' ? 0.16 : 0.18,
                  });
                }}
                className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="ITBIS_18">ITBIS 18%</option>
                <option value="ITBIS_16">ITBIS 16%</option>
                <option value="EXEMPT">Exento</option>
              </select>
            </Field>
            <Field id="warehouse-product-min-stock" label="Existencia mínima">
              <Input
                id="warehouse-product-min-stock"
                type="number"
                min="0"
                step={allowsFraction(form.unit) ? '0.001' : '1'}
                value={form.minStock ?? 0}
                onChange={(event) => setForm({ ...form, minStock: Number(event.target.value) })}
              />
            </Field>
            {!isEditing ? (
              <Field id="warehouse-product-initial-stock" label="Existencia inicial">
                <Input
                  id="warehouse-product-initial-stock"
                  type="number"
                  min="0"
                  step={allowsFraction(form.unit) ? '0.001' : '1'}
                  value={form.initialQuantity ?? 0}
                  onChange={(event) =>
                    setForm({ ...form, initialQuantity: Number(event.target.value) })
                  }
                />
              </Field>
            ) : null}
            <div className="flex items-end gap-2 md:col-span-3">
              <Button
                type="submit"
                disabled={saveMutation.isPending || (isEditing && productsQuery.isLoading)}
              >
                <Save className="h-4 w-4" />
                {saveMutation.isPending ? 'Guardando...' : 'Guardar producto'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => (embedded ? onCancel?.() : router.push('/warehouse'))}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? ' *' : ''}
      </Label>
      {children}
    </div>
  );
}

const unitOptions = [
  ['UNIT', 'Unidad'],
  ['BOX', 'Caja'],
  ['PACK', 'Paquete'],
  ['BAG', 'Bolsa'],
  ['ROLL', 'Rollo'],
  ['METER', 'Metro'],
  ['FOOT', 'Pie'],
  ['YARD', 'Yarda'],
  ['POUND', 'Libra'],
  ['GALLON', 'Galón'],
  ['LITER', 'Litro'],
  ['KILOGRAM', 'Kilogramo'],
] as const;

function allowsFraction(unit: string | undefined) {
  return ['METER', 'FOOT', 'YARD', 'POUND'].includes(unit ?? '');
}
