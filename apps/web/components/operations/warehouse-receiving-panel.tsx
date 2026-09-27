'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Minus, PackagePlus, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { receiveWarehouseStockBatch, type Product } from '@/lib/api';
import { BarcodeInput } from './pos/barcode-input';
import { formatQuantity } from './pos/pos-utils';
import { useCurrentSession } from './session-required';

type ReceivingProduct = Product & {
  warehouseStocks: Array<{ quantity: number }>;
};

type ReceivingLine = {
  product: ReceivingProduct;
  quantity: number;
};

export function WarehouseReceivingPanel({
  products,
  loading,
}: {
  products: ReceivingProduct[];
  loading: boolean;
}) {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [barcode, setBarcode] = useState('');
  const [scannerEnabled, setScannerEnabled] = useState(false);
  const [scannerMessage, setScannerMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<ReceivingLine[]>([]);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('Recepción de mercancía');

  const mutation = useMutation({
    mutationFn: () => {
      if (!session) throw new Error('Sesión requerida.');
      if (!lines.length) throw new Error('Escanea al menos un producto.');
      if (!reference.trim()) throw new Error('La referencia de entrada es obligatoria.');
      if (!reason.trim()) throw new Error('El motivo es obligatorio.');
      return receiveWarehouseStockBatch(session.tenantId, session.accessToken, {
        items: lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
        reference: reference.trim(),
        reason: reason.trim(),
      });
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-products'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-stock'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-movements'] }),
      ]);
      setLines([]);
      setReference('');
      setScannerMessage(`${result.receivedProducts} producto(s) recibidos correctamente.`);
      toast.success('Entrada de almacén registrada.');
      window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo registrar la entrada.');
    },
  });

  function scanProduct(value: string) {
    const code = normalizeCode(value);
    if (!code) return;
    const product = products.find((candidate) =>
      [candidate.barcode, candidate.sku].some(
        (candidateCode) => normalizeCode(candidateCode ?? '') === code,
      ),
    );

    if (!product) {
      setScannerMessage('No existe un producto de almacén con ese código.');
      toast.error('Producto no encontrado.');
      resetScanner();
      return;
    }
    if (product.status !== 'ACTIVE') {
      setScannerMessage(`${product.name} está inactivo.`);
      toast.error('El producto está inactivo.');
      resetScanner();
      return;
    }

    setLines((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      return existing
        ? current.map((line) =>
            line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [...current, { product, quantity: 1 }];
    });
    setScannerMessage(`${product.name} agregado a la recepción.`);
    toast.success('Producto agregado', {
      id: 'warehouse-receiving-scan',
      description: product.name,
    });
    resetScanner();
  }

  function resetScanner() {
    setBarcode('');
    window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
  }

  function updateQuantity(productId: string, quantity: number) {
    setLines((current) =>
      current
        .map((line) => (line.product.id === productId ? { ...line, quantity } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Recepción por lector</CardTitle>
          <CardDescription>
            Activa el lector una vez y escanea continuamente. Los productos se acumulan en el lote.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <BarcodeInput
            barcode={barcode}
            scannerEnabled={scannerEnabled}
            cameraActive={false}
            scannerMessage={scannerMessage}
            barcodeInputRef={barcodeInputRef}
            videoRef={videoRef}
            isPending={loading || mutation.isPending}
            keepFocus
            showCamera={false}
            onBarcodeChange={setBarcode}
            onSubmit={scanProduct}
            onEnableScanner={() => {
              setScannerEnabled(true);
              setScannerMessage('Lector activo. Escanea productos de forma continua.');
              window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
            }}
            onDisableScanner={() => {
              setScannerEnabled(false);
              setScannerMessage('Lector desactivado.');
            }}
            onStartCamera={() => undefined}
          />

          <div className="divide-y rounded-lg border">
            {lines.map((line) => (
              <div
                key={line.product.id}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{line.product.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[line.product.sku, line.product.barcode].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => updateQuantity(line.product.id, line.quantity - 1)}
                    aria-label={`Restar ${line.product.name}`}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    type="number"
                    min={allowsFraction(line.product.unit) ? '0.001' : '1'}
                    step={allowsFraction(line.product.unit) ? '0.001' : '1'}
                    value={line.quantity}
                    onChange={(event) =>
                      updateQuantity(line.product.id, Number(event.target.value) || 0)
                    }
                    className="h-9 w-24 text-center"
                    aria-label={`Cantidad de ${line.product.name}`}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => updateQuantity(line.product.id, line.quantity + 1)}
                    aria-label={`Sumar ${line.product.name}`}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-danger"
                    onClick={() => updateQuantity(line.product.id, 0)}
                    aria-label={`Eliminar ${line.product.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {!lines.length ? (
              <div className="grid min-h-36 place-items-center p-6 text-center text-sm text-muted-foreground">
                Activa el lector y escanea el primer producto para iniciar la recepción.
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Confirmar entrada</CardTitle>
          <CardDescription>Completa los datos comunes para todo el lote recibido.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Productos distintos</span>
              <strong>{lines.length}</strong>
            </div>
            <div className="mt-2 flex justify-between gap-3">
              <span className="text-muted-foreground">Unidades del lote</span>
              <strong>{formatQuantity(lines.reduce((sum, line) => sum + line.quantity, 0))}</strong>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="warehouse-batch-reference">Referencia *</Label>
            <Input
              id="warehouse-batch-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Factura, recepción o documento"
              maxLength={160}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="warehouse-batch-reason">Motivo *</Label>
            <Input
              id="warehouse-batch-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
            />
          </div>
          <Button
            type="button"
            className="min-h-11 w-full"
            disabled={!lines.length || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <PackagePlus className="h-4 w-4" />
            {mutation.isPending ? 'Registrando entrada...' : 'Registrar lote recibido'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function normalizeCode(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function allowsFraction(unit: string) {
  return ['METER', 'FOOT', 'YARD', 'POUND'].includes(unit);
}
