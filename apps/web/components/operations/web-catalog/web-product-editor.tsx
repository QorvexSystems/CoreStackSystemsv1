'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Plus, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { uploadProductImage } from '@/lib/api';
import type { AuthSession } from '@/lib/auth-session';
import {
  addWebVariant,
  createWebProduct,
  getWebProduct,
  getWebProductCategories,
  publishWebProduct,
  unpublishWebProduct,
  updateWebProduct,
  updateWebVariant,
  uploadWebProductImage,
  WEB_IMAGE_MAX_BYTES,
  WEB_IMAGE_TYPES,
  WebCatalogApiError,
  type WebAvailabilityPolicy,
  type WebProductDetail,
  type WebProductOptionDefinition,
  type WebProductVariant,
  type WebVariantInput,
  type WebVariantStatus,
} from '@/lib/web-catalog-api';
import { availabilityLabels, variantStatusLabels } from '@/lib/web-catalog-labels';
import { formatCurrency } from '@/lib/utils';
import { formatQuantity } from '../pos/pos-utils';
import {
  BlockerList,
  ProductThumb,
  selectClassName,
  textareaClassName,
} from './web-catalog-ui';

type Mode = { kind: 'create' } | { kind: 'edit'; id: string };

// ---------------------------------------------------------------- opciones

type OptionDraft = { key: number; name: string; values: string };

let optionKey = 0;
const newOption = (name = '', values = ''): OptionDraft => ({ key: ++optionKey, name, values });

function parseValues(text: string) {
  return [...new Set(text.split(',').map((value) => value.trim()).filter(Boolean))];
}

function toDefinitions(drafts: OptionDraft[]): WebProductOptionDefinition[] {
  return drafts
    .map((draft) => ({ name: draft.name.trim(), values: parseValues(draft.values) }))
    .filter((option) => option.name && option.values.length);
}

function fromDefinitions(options: WebProductOptionDefinition[]) {
  return options.map((option) => newOption(option.name, option.values.join(', ')));
}

function OptionsEditor({
  drafts,
  onChange,
}: {
  drafts: OptionDraft[];
  onChange: (next: OptionDraft[]) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Opciones del producto</legend>
      <p className="text-xs text-muted-foreground">
        Por ejemplo Color o Material, con sus valores separados por comas. Las variantes eligen un
        valor de cada opción.
      </p>
      <datalist id="web-option-names">
        <option value="Color" />
        <option value="Material" />
        <option value="Tamaño" />
      </datalist>
      {drafts.map((draft, index) => (
        <div key={draft.key} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
          <Input
            list="web-option-names"
            value={draft.name}
            maxLength={40}
            placeholder="Nombre (Color)"
            aria-label={`Nombre de la opción ${index + 1}`}
            onChange={(event) =>
              onChange(drafts.map((d) => (d.key === draft.key ? { ...d, name: event.target.value } : d)))
            }
          />
          <Input
            value={draft.values}
            placeholder="Valores: Dorado, Plateado"
            aria-label={`Valores de la opción ${index + 1}`}
            onChange={(event) =>
              onChange(drafts.map((d) => (d.key === draft.key ? { ...d, values: event.target.value } : d)))
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Quitar la opción ${index + 1}`}
            onClick={() => onChange(drafts.filter((d) => d.key !== draft.key))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {drafts.length < 5 ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...drafts, newOption()])}>
          <Plus className="h-4 w-4" /> Agregar opción
        </Button>
      ) : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------- imagen

function ImageField({
  session,
  value,
  onChange,
  alt,
}: {
  session: AuthSession;
  value: string;
  onChange: (url: string) => void;
  alt: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadProductImage(session.tenantId, session.accessToken, file),
    onSuccess: (result) => {
      setNote(null);
      onChange(result.imageUrl);
      toast.success('Imagen cargada', { description: 'Guarda el producto para conservarla.' });
    },
    onError: (error) => {
      setNote(
        `No se pudo subir el archivo${error instanceof Error ? ` (${error.message})` : ''}. ` +
          'Si el almacenamiento de imágenes no está configurado, pega una URL pública https.',
      );
    },
  });

  return (
    <div className="space-y-2">
      <Label htmlFor="web-image-url">Imagen principal (URL pública https)</Label>
      <div className="flex items-start gap-3">
        <ProductThumb src={value || null} alt={alt} className="h-16 w-16" />
        <div className="min-w-0 flex-1 space-y-2">
          <Input
            id="web-image-url"
            type="url"
            inputMode="url"
            value={value}
            placeholder="https://…"
            onChange={(event) => onChange(event.target.value)}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-label="Subir imagen desde el equipo"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
              event.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {upload.isPending ? 'Subiendo…' : 'Subir archivo (opcional)'}
          </Button>
          {note ? (
            <p role="status" className="text-xs text-amber-800">
              {note}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- galería y subida de imágenes

function imageSource(image: WebProductDetail['images'][number]) {
  return image.url ?? image.src ?? null;
}

function ImagesCard({
  session,
  product,
  onUploaded,
}: {
  session: AuthSession;
  product: WebProductDetail;
  onUploaded: () => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [alt, setAlt] = useState('');
  const [primary, setPrimary] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [storageOff, setStorageOff] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function clearFile() {
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function chooseFile(next: File | undefined) {
    setStorageOff(false);
    if (!next) {
      clearFile();
      setProblem(null);
      return;
    }
    if (!WEB_IMAGE_TYPES.includes(next.type)) {
      clearFile();
      setProblem('Formato no permitido. Usa una imagen JPG, PNG o WEBP.');
      return;
    }
    if (next.size > WEB_IMAGE_MAX_BYTES) {
      clearFile();
      setProblem(
        `La imagen pesa ${(next.size / 1024 / 1024).toFixed(1)} MB y el máximo es 5 MB. Reduce su tamaño e inténtalo de nuevo.`,
      );
      return;
    }
    setProblem(null);
    setFile(next);
  }

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Elige una imagen primero.');
      return uploadWebProductImage(session.tenantId, session.accessToken, product.id, {
        file,
        alt: alt || product.name,
        primary,
      });
    },
    onSuccess: async (result) => {
      setProblem(null);
      setStorageOff(false);
      clearFile();
      setAlt('');
      setPrimary(false);
      await onUploaded();
      toast.success(result.primary ? 'Imagen subida y marcada como principal' : 'Imagen subida');
    },
    onError: (error) => {
      const status = error instanceof WebCatalogApiError ? error.status : 0;
      if (status === 503) {
        setStorageOff(true);
        setProblem(
          'El almacenamiento de imágenes no está configurado en este entorno. Mientras tanto, pega una URL pública https en el campo «Imagen principal» de arriba.',
        );
      } else if (status === 413) {
        setStorageOff(false);
        setProblem('El archivo supera el tamaño permitido (5 MB). Reduce su tamaño e inténtalo de nuevo.');
      } else if (status === 400) {
        setStorageOff(false);
        setProblem(`El servidor rechazó el archivo: ${error.message}`);
      } else {
        setStorageOff(false);
        setProblem(error instanceof Error ? error.message : 'No se pudo subir la imagen.');
      }
    },
  });

  const primaryUrl = product.imageUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Imágenes</CardTitle>
        <CardDescription>
          Galería del grupo y subida de nuevas fotos (JPG, PNG o WEBP, máximo 5 MB). También puedes pegar una URL https en
          «Datos del producto».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {product.images.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Galería actual del grupo">
            {product.images.map((image, index) => {
              const source = imageSource(image);
              const own = Boolean(source && source.startsWith('/'));
              const isPrimary = Boolean(source && primaryUrl && source === primaryUrl);
              return (
                <li key={image.id ?? index} className="space-y-1.5 rounded-md border border-border p-2">
                  <ProductThumb
                    src={source}
                    alt={image.alt || `${product.name}, imagen ${index + 1}`}
                    className="aspect-square h-auto w-full"
                  />
                  <div className="flex flex-wrap gap-1">
                    {isPrimary ? <Badge variant="success">Principal</Badge> : null}
                    <Badge variant={own ? 'outline' : 'info'}>{own ? 'Importada' : 'Subida'}</Badge>
                  </div>
                  {own ? (
                    <p className="break-all text-[11px] leading-tight text-muted-foreground">Ruta propia: {source}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            Este grupo todavía no tiene imágenes en la galería.
            {primaryUrl ? ' Tiene una imagen principal por URL.' : ''}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Las imágenes importadas con ruta propia (/catalog/…) se sirven desde el e-commerce, por eso aquí pueden
          mostrarse como marcador.
        </p>

        <form
          className="space-y-3 rounded-md border border-border bg-muted/20 p-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (file && !upload.isPending) upload.mutate();
          }}
        >
          <p className="text-sm font-semibold">Subir una imagen</p>
          <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="Vista previa de la imagen elegida"
                className="h-28 w-28 rounded-md border border-border object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-md border border-dashed border-border text-center text-xs text-muted-foreground">
                Sin vista previa
              </div>
            )}
            <div className="min-w-0 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="web-image-file">Archivo de imagen</Label>
                <input
                  ref={fileRef}
                  id="web-image-file"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="block w-full text-sm file:mr-3 file:h-10 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium"
                  onChange={(event) => chooseFile(event.target.files?.[0])}
                  aria-describedby={problem ? 'web-image-problem' : undefined}
                />
                {file ? (
                  <p className="text-xs text-muted-foreground">
                    {file.name} · {(file.size / 1024).toFixed(0)} KB
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="web-image-alt">Texto alternativo (opcional)</Label>
                <Input
                  id="web-image-alt"
                  value={alt}
                  maxLength={200}
                  placeholder={product.name}
                  onChange={(event) => setAlt(event.target.value)}
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer rounded border-input"
                  checked={primary}
                  onChange={(event) => setPrimary(event.target.checked)}
                />
                Usar como imagen principal
              </label>
            </div>
          </div>
          {problem ? (
            <p
              id="web-image-problem"
              role="alert"
              className={`rounded-md border p-3 text-sm ${
                storageOff ? 'border-amber-200 bg-amber-50/80 text-amber-900' : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {problem}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Si marcas «principal», el formulario de datos se recarga: guarda antes cualquier cambio pendiente.
          </p>
          <div className="flex justify-end">
            <Button type="submit" disabled={!file || upload.isPending}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              {upload.isPending ? 'Subiendo…' : 'Subir imagen'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- variantes

type VariantDraft = {
  key: number;
  title: string;
  optionValues: Record<string, string>;
  sku: string;
  price: string;
  availability: WebAvailabilityPolicy;
  status: WebVariantStatus;
};

let variantKey = 0;
const emptyVariant = (): VariantDraft => ({
  key: ++variantKey,
  title: '',
  optionValues: {},
  sku: '',
  price: '',
  availability: 'UNDECIDED',
  status: 'ACTIVE',
});

function draftFromVariant(variant: WebProductVariant): VariantDraft {
  const optionValues: Record<string, string> = {};
  for (const option of variant.webOptions?.options ?? []) optionValues[option.name] = option.value;
  return {
    key: ++variantKey,
    title: variant.webOptions?.title ?? variant.name,
    optionValues,
    sku: variant.sku ?? '',
    price: variant.price,
    availability: variant.webAvailability ?? 'UNDECIDED',
    status: variant.status,
  };
}

function parsePrice(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 ? value : null;
}

function validateVariant(draft: VariantDraft): string | null {
  if (!draft.title.trim()) return 'Cada variante necesita un título.';
  if (!draft.sku.trim()) return `La variante «${draft.title.trim()}» necesita un SKU.`;
  if (parsePrice(draft.price) === null) {
    return `La variante «${draft.title.trim()}» necesita un precio mayor que cero (máximo 2 decimales).`;
  }
  return null;
}

function toVariantInput(draft: VariantDraft, definitions: WebProductOptionDefinition[]): WebVariantInput {
  return {
    title: draft.title.trim(),
    options: definitions
      .filter((definition) => draft.optionValues[definition.name])
      .map((definition) => ({ name: definition.name, value: draft.optionValues[definition.name] })),
    sku: draft.sku.trim(),
    price: parsePrice(draft.price) as number,
    webAvailability: draft.availability,
  };
}

function VariantFields({
  idPrefix,
  draft,
  definitions,
  onChange,
  showStatus,
}: {
  idPrefix: string;
  draft: VariantDraft;
  definitions: WebProductOptionDefinition[];
  onChange: (next: VariantDraft) => void;
  showStatus?: boolean;
}) {
  const set = (patch: Partial<VariantDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-title`}>Título</Label>
        <Input
          id={`${idPrefix}-title`}
          value={draft.title}
          maxLength={60}
          placeholder="Dorado / Mediano"
          onChange={(event) => set({ title: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-sku`}>SKU</Label>
        <Input
          id={`${idPrefix}-sku`}
          value={draft.sku}
          maxLength={80}
          onChange={(event) => set({ sku: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-price`}>Precio final (RD$)</Label>
        <Input
          id={`${idPrefix}-price`}
          inputMode="decimal"
          value={draft.price}
          placeholder="0.00"
          onChange={(event) => set({ price: event.target.value })}
        />
      </div>
      {definitions.map((definition) => (
        <div key={definition.name} className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-opt-${definition.name}`}>{definition.name}</Label>
          <select
            id={`${idPrefix}-opt-${definition.name}`}
            className={selectClassName}
            value={draft.optionValues[definition.name] ?? ''}
            onChange={(event) =>
              set({ optionValues: { ...draft.optionValues, [definition.name]: event.target.value } })
            }
          >
            <option value="">Sin valor</option>
            {definition.values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-availability`}>Disponibilidad</Label>
        <select
          id={`${idPrefix}-availability`}
          className={selectClassName}
          value={draft.availability}
          onChange={(event) => set({ availability: event.target.value as WebAvailabilityPolicy })}
        >
          <option value="STOCKED">{availabilityLabels.STOCKED}</option>
          <option value="MADE_TO_ORDER">{availabilityLabels.MADE_TO_ORDER}</option>
          <option value="UNDECIDED">{availabilityLabels.UNDECIDED}</option>
        </select>
      </div>
      {showStatus ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-status`}>Estado</Label>
          <select
            id={`${idPrefix}-status`}
            className={selectClassName}
            value={draft.status}
            onChange={(event) => set({ status: event.target.value as WebVariantStatus })}
          >
            <option value="ACTIVE">{variantStatusLabels.ACTIVE}</option>
            <option value="INACTIVE">{variantStatusLabels.INACTIVE}</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- editor

export function WebProductEditor({
  session,
  mode,
  onBack,
  onCreated,
}: {
  session: AuthSession;
  mode: Mode;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Volver al catálogo web
      </Button>
      {mode.kind === 'create' ? (
        <CreateForm session={session} onCreated={onCreated} onCancel={onBack} />
      ) : (
        <EditView session={session} id={mode.id} />
      )}
    </div>
  );
}

function CreateForm({
  session,
  onCreated,
  onCancel,
}: {
  session: AuthSession;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [variants, setVariants] = useState<VariantDraft[]>(() => [emptyVariant()]);
  const [error, setError] = useState<string | null>(null);
  const definitions = toDefinitions(options);

  const mutation = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('El nombre es obligatorio.');
      if (imageUrl.trim() && !/^https:\/\//i.test(imageUrl.trim())) {
        throw new Error('La imagen debe ser una URL pública que empiece con https://.');
      }
      for (const variant of variants) {
        const problem = validateVariant(variant);
        if (problem) throw new Error(problem);
      }
      return createWebProduct(session.tenantId, session.accessToken, {
        name: name.trim(),
        description: description.trim() || undefined,
        categoryLabel: category.trim() || undefined,
        imageUrl: imageUrl.trim() || undefined,
        options: definitions,
        variants: variants.map((variant) => toVariantInput(variant, definitions)),
      });
    },
    onSuccess: async (product) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['web-products'] });
      await queryClient.invalidateQueries({ queryKey: ['web-product-categories'] });
      toast.success('Producto web creado', {
        description: 'Queda sin publicar hasta cumplir los requisitos.',
      });
      onCreated(product.id);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'No se pudo crear el producto.'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo producto web</CardTitle>
        <CardDescription>
          Se crea sin publicar. Las existencias no se fijan aquí: se gestionan desde el módulo de
          Productos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
          noValidate
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="web-name">Nombre</Label>
              <Input id="web-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-category">Categoría</Label>
              <CategoryInput session={session} id="web-category" value={category} onChange={setCategory} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="web-description">Descripción</Label>
              <textarea
                id="web-description"
                className={textareaClassName}
                value={description}
                maxLength={5000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <ImageField session={session} value={imageUrl} onChange={setImageUrl} alt={name || 'Producto nuevo'} />
            </div>
          </div>

          <OptionsEditor drafts={options} onChange={setOptions} />

          <div className="space-y-3">
            <h4 className="text-sm font-medium">Variantes</h4>
            {variants.map((variant, index) => (
              <div key={variant.key} className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">Variante {index + 1}</p>
                  {variants.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setVariants(variants.filter((v) => v.key !== variant.key))}
                    >
                      <Trash2 className="h-4 w-4" /> Quitar
                    </Button>
                  ) : null}
                </div>
                <VariantFields
                  idPrefix={`new-variant-${variant.key}`}
                  draft={variant}
                  definitions={definitions}
                  onChange={(next) => setVariants(variants.map((v) => (v.key === variant.key ? next : v)))}
                />
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setVariants([...variants, emptyVariant()])}>
              <Plus className="h-4 w-4" /> Agregar variante
            </Button>
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creando…' : 'Crear producto'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function CategoryInput({
  session,
  id,
  value,
  onChange,
}: {
  session: AuthSession;
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const categories = useQuery({
    queryKey: ['web-product-categories', session.tenantId],
    queryFn: () => getWebProductCategories(session.tenantId, session.accessToken),
  });
  return (
    <>
      <Input id={id} list={`${id}-list`} value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} />
      <datalist id={`${id}-list`}>
        {(categories.data ?? [])
          .filter((entry) => entry.name)
          .map((entry) => (
            <option key={entry.name} value={entry.name as string} />
          ))}
      </datalist>
    </>
  );
}

function EditView({ session, id }: { session: AuthSession; id: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['web-product', session.tenantId, id];
  const productQuery = useQuery({
    queryKey,
    queryFn: () => getWebProduct(session.tenantId, session.accessToken, id),
  });
  const [lastError, setLastError] = useState<{ message: string; blockers: string[] } | null>(null);

  async function applyResult(product: WebProductDetail) {
    queryClient.setQueryData(queryKey, product);
    setLastError(null);
    await queryClient.invalidateQueries({ queryKey: ['web-products'] });
    await queryClient.invalidateQueries({ queryKey: ['web-product-categories'] });
  }
  function handleError(error: unknown) {
    const message = error instanceof Error ? error.message : 'No se pudo completar la acción.';
    setLastError({ message, blockers: error instanceof WebCatalogApiError ? error.blockers : [] });
    toast.error(message);
  }

  const publishMutation = useMutation({
    mutationFn: (publish: boolean) =>
      publish
        ? publishWebProduct(session.tenantId, session.accessToken, id)
        : unpublishWebProduct(session.tenantId, session.accessToken, id),
    onSuccess: async (product) => {
      await applyResult(product);
      toast.success(product.published ? 'Producto publicado' : 'Producto despublicado');
    },
    onError: handleError,
  });

  if (productQuery.isLoading) return <p className="text-sm text-muted-foreground">Cargando producto…</p>;
  if (productQuery.isError || !productQuery.data) {
    return (
      <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        {productQuery.error instanceof Error ? productQuery.error.message : 'No se pudo cargar el producto.'}
      </p>
    );
  }

  const product = productQuery.data;
  const variantName = (tag: string) => {
    const found = product.variants.find((v) => v.id === tag || v.internalId === tag);
    return found ? (found.webOptions?.title ?? found.sku ?? found.name) : tag;
  };
  const blockers = product.blockers.length ? product.blockers : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <ProductThumb src={product.imageUrl} alt={product.name} className="h-16 w-16" />
            <div className="min-w-0">
              <h2 className="text-xl font-semibold leading-tight">{product.name}</h2>
              <p className="truncate text-xs text-muted-foreground">
                {product.id} · {product.slug}
              </p>
              <div className="mt-1">
                {product.published ? (
                  <Badge variant="success">Publicado</Badge>
                ) : (
                  <Badge variant="outline">No publicado</Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            {product.published ? (
              <Button
                type="button"
                variant="outline"
                disabled={publishMutation.isPending}
                onClick={() => publishMutation.mutate(false)}
              >
                Despublicar
              </Button>
            ) : (
              <Button
                type="button"
                disabled={publishMutation.isPending || !product.publishable}
                onClick={() => publishMutation.mutate(true)}
                aria-describedby={blockers.length ? 'web-blockers' : undefined}
              >
                {publishMutation.isPending ? 'Publicando…' : 'Publicar'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!product.published && blockers.length ? (
        <div id="web-blockers">
          <BlockerList blockers={blockers} variantName={variantName} />
        </div>
      ) : null}
      {lastError && !(lastError.blockers.length && blockers.length) ? (
        <div className="space-y-2">
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {lastError.message}
          </p>
          <BlockerList blockers={lastError.blockers} variantName={variantName} title="Requisitos pendientes" />
        </div>
      ) : null}
      {product.published ? (
        <p className="text-xs text-muted-foreground">
          Un producto publicado debe seguir cumpliendo los requisitos: si un cambio lo rompe, el
          sistema lo rechaza y hay que despublicarlo primero.
        </p>
      ) : null}

      <GroupCard
        key={`${product.name}|${product.description}|${product.categoryLabel}|${product.imageUrl}|${product.model3d?.modelId ?? ""}|${JSON.stringify(product.options)}`}
        session={session}
        product={product}
        onSaved={applyResult}
        onError={handleError}
      />
      <ImagesCard
        session={session}
        product={product}
        onUploaded={async () => {
          await queryClient.invalidateQueries({ queryKey });
          await queryClient.invalidateQueries({ queryKey: ['web-products'] });
          await queryClient.invalidateQueries({ queryKey: ['web-catalog-review'] });
        }}
      />
      <VariantsCard
        session={session}
        product={product}
        onSaved={applyResult}
        onError={handleError}
      />
    </div>
  );
}

function GroupCard({
  session,
  product,
  onSaved,
  onError,
}: {
  session: AuthSession;
  product: WebProductDetail;
  onSaved: (product: WebProductDetail) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? '');
  const [category, setCategory] = useState(product.categoryLabel ?? '');
  const [imageUrl, setImageUrl] = useState(product.imageUrl ?? '');
  const [model3dUrl, setModel3dUrl] = useState(product.model3d?.sourceUrl ?? '');
  const [options, setOptions] = useState<OptionDraft[]>(() => fromDefinitions(product.options));
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('El nombre es obligatorio.');
      if (imageUrl.trim() && !/^https:\/\//i.test(imageUrl.trim())) {
        throw new Error('La imagen debe ser una URL pública que empiece con https://.');
      }
      if (model3dUrl.trim() && !/^https:\/\/(www\.)?sketchfab\.com\//i.test(model3dUrl.trim())) {
        throw new Error('El modelo 3D debe ser un enlace de Sketchfab (https://sketchfab.com/3d-models/...).');
      }
      return updateWebProduct(session.tenantId, session.accessToken, product.id, {
        name: name.trim(),
        description: description.trim(),
        categoryLabel: category.trim(),
        // Solo se envía si cambió; vacío elimina el modelo asociado.
        ...(model3dUrl.trim() !== (product.model3d?.sourceUrl ?? '') ? { model3dUrl: model3dUrl.trim() || null } : {}),
        ...(imageUrl.trim() && imageUrl.trim() !== (product.imageUrl ?? '')
          ? { imageUrl: imageUrl.trim() }
          : {}),
        options: toDefinitions(options),
      });
    },
    onSuccess: async (updated) => {
      setLocalError(null);
      await onSaved(updated);
      toast.success('Datos del producto guardados');
    },
    onError: (error) => {
      setLocalError(error instanceof Error ? error.message : 'No se pudo guardar.');
      onError(error);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Datos del producto</CardTitle>
        <CardDescription>Nombre, descripción, categoría, imagen y opciones.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Nombre</Label>
              <Input id="edit-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-category">Categoría</Label>
              <CategoryInput session={session} id="edit-category" value={category} onChange={setCategory} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-description">Descripción</Label>
              <textarea
                id="edit-description"
                className={textareaClassName}
                value={description}
                maxLength={5000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <ImageField session={session} value={imageUrl} onChange={setImageUrl} alt={name} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="edit-model3d">Modelo 3D / Sketchfab (opcional)</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-model3d"
                  inputMode="url"
                  placeholder="https://sketchfab.com/3d-models/nombre-del-modelo-0123abcd…"
                  value={model3dUrl}
                  maxLength={2048}
                  onChange={(e) => setModel3dUrl(e.target.value)}
                />
                {model3dUrl ? (
                  <Button type="button" variant="outline" onClick={() => setModel3dUrl('')}>
                    Quitar
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {product.model3d
                  ? `Este producto tiene un modelo 3D asociado (${product.model3d.modelId.slice(0, 8)}…). Aparece como «Ver en 3D» en la ficha del e-commerce.`
                  : 'Sin modelo 3D. Pega el enlace público del modelo: solo se guarda su identificador y el e-commerce muestra el visor oficial de Sketchfab.'}
              </p>
            </div>
          </div>
          <OptionsEditor drafts={options} onChange={setOptions} />
          {localError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {localError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Guardando…' : 'Guardar datos'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function VariantsCard({
  session,
  product,
  onSaved,
  onError,
}: {
  session: AuthSession;
  product: WebProductDetail;
  onSaved: (product: WebProductDetail) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [adding, setAdding] = useState<VariantDraft | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: (draft: VariantDraft) => {
      const problem = validateVariant(draft);
      if (problem) throw new Error(problem);
      return addWebVariant(session.tenantId, session.accessToken, product.id, toVariantInput(draft, product.options));
    },
    onSuccess: async (updated) => {
      setAddError(null);
      setAdding(null);
      await onSaved(updated);
      toast.success('Variante agregada');
    },
    onError: (error) => {
      setAddError(error instanceof Error ? error.message : 'No se pudo agregar la variante.');
      onError(error);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Variantes ({product.variants.length})</CardTitle>
        <CardDescription>
          Precio, SKU, opciones, estado y política de disponibilidad. Las existencias se ajustan en el
          módulo de Productos, desde el enlace de cada variante.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {product.variants.map((variant) => (
          <VariantCard
            key={`${variant.internalId}|${variant.price}|${variant.sku}|${variant.status}|${variant.webAvailability}|${JSON.stringify(variant.webOptions)}`}
            session={session}
            product={product}
            variant={variant}
            onSaved={onSaved}
            onError={onError}
          />
        ))}

        {adding ? (
          <div className="space-y-3 rounded-md border border-dashed border-border p-3">
            <p className="text-sm font-semibold">Nueva variante</p>
            <VariantFields
              idPrefix="add-variant"
              draft={adding}
              definitions={product.options}
              onChange={setAdding}
            />
            {addError ? (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {addError}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAdding(null);
                  setAddError(null);
                }}
              >
                Cancelar
              </Button>
              <Button type="button" disabled={addMutation.isPending} onClick={() => addMutation.mutate(adding)}>
                {addMutation.isPending ? 'Agregando…' : 'Agregar variante'}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(emptyVariant())}>
            <Plus className="h-4 w-4" /> Agregar variante
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function VariantCard({
  session,
  product,
  variant,
  onSaved,
  onError,
}: {
  session: AuthSession;
  product: WebProductDetail;
  variant: WebProductVariant;
  onSaved: (product: WebProductDetail) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState<VariantDraft>(() => draftFromVariant(variant));
  const [error, setError] = useState<string | null>(null);
  const title = variant.webOptions?.title ?? variant.name;

  const mutation = useMutation({
    mutationFn: () => {
      const problem = validateVariant(draft);
      if (problem) throw new Error(problem);
      const input = toVariantInput(draft, product.options);
      return updateWebVariant(session.tenantId, session.accessToken, product.id, variant.id, {
        title: input.title,
        options: input.options,
        sku: input.sku,
        price: input.price,
        status: draft.status,
        webAvailability: draft.availability,
        // "Inventario controlado" exige controlar existencias; "bajo pedido" no toca el control actual.
        ...(draft.availability === 'STOCKED' ? { trackInventory: true } : {}),
      });
    },
    onSuccess: async (updated) => {
      setError(null);
      await onSaved(updated);
      toast.success('Variante guardada', { description: title });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la variante.');
      onError(err);
    },
  });

  const idPrefix = `variant-${variant.internalId}`;
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">
            {variant.sku ?? 'Sin SKU'} · {formatCurrency(Number(variant.price))} · {variant.id}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {variant.status !== 'ACTIVE' ? <Badge variant="outline">{variantStatusLabels[variant.status]}</Badge> : null}
          <StockBadge variant={variant} />
          <Link
            href={`/products/${variant.internalId}/edit`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-gold-deep underline-offset-2 hover:underline"
            aria-label={`Ajustar inventario de ${title} en Productos`}
          >
            Ajustar inventario <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      </div>
      <VariantFields
        idPrefix={idPrefix}
        draft={draft}
        definitions={product.options}
        onChange={setDraft}
        showStatus
      />
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? 'Guardando…' : 'Guardar variante'}
        </Button>
      </div>
    </div>
  );
}

function StockBadge({ variant }: { variant: WebProductVariant }) {
  if (variant.webAvailability === 'MADE_TO_ORDER') return <Badge variant="info">Bajo pedido</Badge>;
  if (variant.webAvailability === 'STOCKED') {
    const units = variant.availableUnits;
    return (
      <Badge variant={units > 0 ? 'success' : 'danger'}>
        {units > 0 ? `${formatQuantity(units)} disponibles` : 'Sin existencias'}
      </Badge>
    );
  }
  return <Badge variant="warning">Sin decidir · {formatQuantity(variant.availableUnits)} disp.</Badge>;
}
