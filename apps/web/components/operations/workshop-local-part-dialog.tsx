'use client';

import { useState } from 'react';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Input } from '@/components/ui/input';

export function WorkshopLocalPartDialog({
  onClose,
  onAdd,
  kind = 'PART',
  initialName = '',
}: {
  kind?: 'PART' | 'SERVICE';
  initialName?: string;
  onClose: () => void;
  onAdd: (name: string, price: string) => void;
}) {
  const noun = kind === 'SERVICE' ? 'servicio' : 'repuesto';
  const [name, setName] = useState(initialName);
  const [price, setPrice] = useState('');
  const valid =
    name.trim().length > 0 &&
    price.trim() !== '' &&
    Number.isFinite(Number(price)) &&
    Number(price) >= 0;
  return (
    <ActionDialog
      open
      title={`Crear ${noun} para esta OT`}
      description={`Este ${noun} solo se agregará a esta orden de trabajo y no se guardará en el catálogo.`}
      confirmLabel={`Agregar ${noun}`}
      cancelLabel="Cancelar"
      confirmDisabled={!valid}
      onClose={onClose}
      onConfirm={() => {
        if (valid) onAdd(name.trim(), Number(price).toFixed(2));
      }}
    >
      <label className="block space-y-2 text-sm font-medium">
        Nombre del {noun}
        <Input
          data-dialog-autofocus
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="block space-y-2 text-sm font-medium">
        Precio (RD$)
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
    </ActionDialog>
  );
}
