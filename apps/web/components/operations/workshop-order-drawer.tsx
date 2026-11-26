'use client';

import { ReceptionWhatsappButton } from './reception-whatsapp-button';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ClipboardCheck,
  History,
  ImagePlus,
  Save,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  createWorkshopReception,
  getWorkshopTickets,
  getWorkshopVehicleHistory,
  saveWorkshopInspection,
  updateWorkshopReception,
  updateWorkshopTicket,
  uploadWorkshopReceptionImages,
  type WorkshopMechanic,
  type WorkshopTicket,
  type WorkshopTicketStatus,
} from '@/lib/api';
import { ActionDialog } from '@/components/ui/action-dialog';
import { ReceptionClauses } from './reception-clauses';
import { ReceptionSignatureDialog } from './reception-signature-dialog';
import type { AuthSession } from '@/lib/auth-session';

const statusLabels: Record<WorkshopTicketStatus, string> = {
  RECEIVED: 'Recepción',
  DIAGNOSIS: 'Revisión / diagnóstico',
  AWAITING_APPROVAL: 'Esperando aprobación',
  APPROVED: 'Aprobado · por facturar',
  IN_PROGRESS: 'En reparación',
  READY_FOR_DELIVERY: 'Listo para entrega',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
};

export function WorkshopOrderDrawer({
  session,
  ticket,
  mechanics,
  onClose: closeReception,
}: {
  session: AuthSession;
  ticket: WorkshopTicket | null;
  mechanics: WorkshopMechanic[];
  onClose: () => void;
}) {
  const drafts = useRef(
    new Map<
      string,
      {
        mileage: string;
        fuelLevel: string;
        mechanicId: string;
        exterior: string;
        interior: string;
        accessories: string;
        belongings: string;
        warningLights: string;
        diagnosis: string;
        savedImages: string[];
        newImages: File[];
      }
    >(),
  );
  const onClose = () => {
    if (ticket?.status === 'RECEIVED' && !receptionSaved && !savedTicketId)
      drafts.current.set(ticket.id, {
        mileage,
        fuelLevel,
        mechanicId,
        exterior,
        interior,
        accessories,
        belongings,
        warningLights,
        diagnosis,
        savedImages,
        newImages,
      });
    closeReception();
  };
  const router = useRouter();
  const formId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const queryClient = useQueryClient();
  const [mileage, setMileage] = useState('');
  const [fuelLevel, setFuelLevel] = useState('');
  const [mechanicId, setMechanicId] = useState('');
  const [exterior, setExterior] = useState('');
  const [interior, setInterior] = useState('');
  const [accessories, setAccessories] = useState('');
  const [belongings, setBelongings] = useState('');
  const [warningLights, setWarningLights] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [savedImages, setSavedImages] = useState<string[]>([]);
  const [newImages, setNewImages] = useState<File[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [savedTicketId, setSavedTicketId] = useState<string | null>(null);
  const [receptionSaved, setReceptionSaved] = useState(false);

  const vehicleHistory = useQuery({
    queryKey: ['workshop-vehicle-history', ticket?.vehicle.id],
    queryFn: () =>
      getWorkshopVehicleHistory(session.tenantId, session.accessToken, ticket!.vehicle.id),
    enabled: Boolean(ticket && historyOpen),
  });
  const customerOrders = useQuery({
    queryKey: ['workshop-tickets', session.tenantId],
    queryFn: () => getWorkshopTickets(session.tenantId, session.accessToken),
    enabled: Boolean(ticket && historyOpen),
  });

  useEffect(() => {
    if (!ticket) return;
    setMileage(String(ticket.reception?.mileage ?? ticket.vehicle.mileage ?? ''));
    setFuelLevel(ticket.reception?.fuelLevel ?? '1/2');
    setMechanicId(ticket.assignments[0]?.employee.id ?? ticket.reception?.initialMechanicId ?? '');
    setExterior(ticket.reception?.exteriorCondition ?? '');
    setInterior(ticket.reception?.interiorCondition ?? '');
    setAccessories(ticket.reception?.accessories ?? '');
    setBelongings(ticket.reception?.belongings ?? '');
    setWarningLights(ticket.reception?.warningLights ?? '');
    setDiagnosis(ticket.reception?.observations ?? '');
    setSavedImages(ticket.reception?.imageUrls ?? []);
    setNewImages([]);
    const draft = drafts.current.get(ticket.id);
    if (draft && !ticket.reception) {
      setMileage(draft.mileage);
      setFuelLevel(draft.fuelLevel);
      setMechanicId(draft.mechanicId);
      setExterior(draft.exterior);
      setInterior(draft.interior);
      setAccessories(draft.accessories);
      setBelongings(draft.belongings);
      setWarningLights(draft.warningLights);
      setDiagnosis(draft.diagnosis);
      setSavedImages(draft.savedImages);
      setNewImages(draft.newImages);
    }
    setSignatureOpen(false);
    setReceptionSaved(false);
    // Background refreshes must not erase unsaved fields or selected photos.
  }, [ticket?.id]);

  useEffect(() => {
    if (!ticket || !mounted) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-reception-close]')?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previousFocus?.focus?.();
    };
  }, [ticket?.id, mounted]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workshop-tickets'] }),
      queryClient.invalidateQueries({ queryKey: ['workshop-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['workshop-appointments'] }),
    ]);
  };

  const receptionMutation = useMutation({
    mutationFn: async (signatureDataUrl?: string) => {
      if (!ticket) throw new Error('Selecciona una orden.');
      const currentMileage = Number(mileage);
      if (!Number.isInteger(currentMileage) || currentMileage < 0)
        throw new Error('Indica un kilometraje válido.');
      const uploaded = newImages.length
        ? await uploadWorkshopReceptionImages(session.tenantId, session.accessToken, newImages)
        : { imageUrls: [] };
      const imageUrls = [...savedImages, ...uploaded.imageUrls].slice(0, 3);
      const receptionPayload = {
        mileage: currentMileage,
        fuelLevel: fuelLevel || undefined,
        exteriorCondition: exterior || undefined,
        interiorCondition: interior || undefined,
        accessories: accessories || undefined,
        belongings: belongings || undefined,
        warningLights: warningLights || undefined,
        observations: diagnosis.trim(),
        imageUrls,
        signatureDataUrl,
      };
      setSavedImages(imageUrls);
      setNewImages([]);
      if (!ticket.reception && !receptionSaved)
        await createWorkshopReception(
          session.tenantId,
          session.accessToken,
          ticket.id,
          receptionPayload,
        );
      else
        await updateWorkshopReception(
          session.tenantId,
          session.accessToken,
          ticket.id,
          receptionPayload,
        );
      setReceptionSaved(true);
      await saveWorkshopInspection(session.tenantId, session.accessToken, ticket.id, {
        items: [
          {
            code: 'EXTERIOR',
            label: 'Condición exterior',
            result: exterior.trim() ? 'ATTENTION' : 'GOOD',
            comment: exterior.trim() || undefined,
          },
          {
            code: 'WARNING_LIGHTS',
            label: 'Testigos del tablero',
            result: warningLights.trim() ? 'ATTENTION' : 'GOOD',
            comment: warningLights.trim() || undefined,
          },
          {
            code: 'INITIAL_REVIEW',
            label: 'Revisión inicial',
            result: diagnosis.trim() ? 'ATTENTION' : 'GOOD',
            comment: diagnosis.trim() || undefined,
          },
        ],
      });
      if (ticket.status === 'RECEIVED') {
        await updateWorkshopTicket(session.tenantId, session.accessToken, ticket.id, {
          status: 'DIAGNOSIS',
          diagnosis: diagnosis.trim(),
        });
      } else {
        await updateWorkshopTicket(session.tenantId, session.accessToken, ticket.id, {
          diagnosis: diagnosis.trim(),
        });
      }
    },
    onSuccess: async () => {
      await invalidate();
      if (ticket) drafts.current.delete(ticket.id);
      toast.success('Recepción guardada.');
      setSignatureOpen(false);
      setSavedTicketId(ticket?.id ?? null);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar la recepción.'),
  });

  useEffect(() => {
    if (!ticket || !mounted) return;
    const handleKey = (event: KeyboardEvent) => {
      // The signature and confirmation dialogs manage their own focus and Escape.
      if (signatureOpen || savedTicketId) return;
      if (historyOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setHistoryOpen(false);
        }
        return;
      }
      if (event.key === 'Escape' && !receptionMutation.isPending) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="file"]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
      );
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [ticket?.id, mounted, signatureOpen, savedTicketId, historyOpen, receptionMutation.isPending]);

  if (!ticket || !mounted) return null;
  const pending = receptionMutation.isPending;
  const relatedCustomerOrders = (customerOrders.data ?? []).filter(
    (item) => item.customer.id === ticket.customer.id,
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[105] flex items-center justify-center bg-slate-950/55 p-2 backdrop-blur-sm sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && !pending && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Recepción del vehículo · ${ticket.ticketNumber}`}
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border bg-zinc-50 shadow-2xl sm:max-h-[calc(100dvh-2rem)]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b bg-white px-4 py-3 sm:px-6 sm:py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Wrench className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold">{ticket.ticketNumber}</h2>
              <Badge variant="outline">{statusLabels[ticket.status]}</Badge>
            </div>
            <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">
              {ticket.vehicle.licensePlate ?? 'Sin placa'} · {ticket.vehicle.make}{' '}
              {ticket.vehicle.model}
            </p>
            <p className="line-clamp-2 break-words text-sm text-muted-foreground">
              {ticket.customer.name} · {ticket.complaint}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-12 w-12"
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar recepción"
            data-reception-close
          >
            <X className="h-6 w-6" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3 sm:p-5">
          {ticket.status === 'RECEIVED' ? (
            <form
              id={formId}
              className="rounded-xl border bg-white p-4 shadow-sm sm:p-5"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                if (!Number.isInteger(Number(mileage)) || Number(mileage) < 0 || !mileage.trim()) {
                  toast.error('Indica un kilometraje válido.');
                  return;
                }
                setSignatureOpen(true);
              }}
            >
              <div className="mb-4 flex items-center gap-3">
                <ClipboardCheck className="h-6 w-6 text-primary" />
                <div>
                  <h3 className="text-lg font-semibold">Recepción del vehículo</h3>
                  <p className="text-sm text-muted-foreground">
                    Un solo registro acompaña la orden durante todo el proceso.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TouchField label="Kilometraje" required>
                  <Input
                    className="h-12 text-base"
                    required
                    type="number"
                    min={0}
                    value={mileage}
                    onChange={(event) => setMileage(event.target.value)}
                  />
                </TouchField>
                <TouchField label="Combustible">
                  <select
                    className="h-12 rounded-md border border-input bg-background px-3 text-base"
                    value={fuelLevel}
                    onChange={(event) => setFuelLevel(event.target.value)}
                  >
                    <option value="1/4">1/4</option>
                    <option value="1/2">1/2</option>
                    <option value="3/4">3/4</option>
                    <option value="FULL">Lleno</option>
                  </select>
                </TouchField>
                <TouchField label="Condición exterior">
                  <Input
                    className="h-12 text-base"
                    value={exterior}
                    onChange={(event) => setExterior(event.target.value)}
                    placeholder="Golpes, rayones..."
                  />
                </TouchField>
                <TouchField label="Condición interior">
                  <Input
                    className="h-12 text-base"
                    value={interior}
                    onChange={(event) => setInterior(event.target.value)}
                  />
                </TouchField>
                <TouchField label="Accesorios">
                  <Input
                    className="h-12 text-base"
                    value={accessories}
                    onChange={(event) => setAccessories(event.target.value)}
                  />
                </TouchField>
                <TouchField label="Pertenencias">
                  <Input
                    className="h-12 text-base"
                    value={belongings}
                    onChange={(event) => setBelongings(event.target.value)}
                  />
                </TouchField>
                <TouchField label="Testigos encendidos">
                  <Input
                    className="h-12 text-base"
                    value={warningLights}
                    onChange={(event) => setWarningLights(event.target.value)}
                    placeholder="Ninguno / ABS..."
                  />
                </TouchField>
                <TouchField label="Observaciones de recepción" wide>
                  <textarea
                    className="min-h-28 rounded-md border border-input bg-background p-3 text-base"
                    value={diagnosis}
                    onChange={(event) => setDiagnosis(event.target.value)}
                    placeholder="Estado del vehículo, pertenencias y observaciones de ingreso…"
                  />
                </TouchField>
                <div className="grid gap-3 sm:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label>Evidencias del vehículo</Label>
                    <span className="text-xs text-muted-foreground">Máximo 3 imágenes</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {savedImages.map((url) => (
                      <ImageTile
                        key={url}
                        src={url}
                        onRemove={() =>
                          setSavedImages((items) => items.filter((item) => item !== url))
                        }
                      />
                    ))}
                    {newImages.map((file, index) => (
                      <ImageTile
                        key={`${file.name}-${index}`}
                        file={file}
                        onRemove={() =>
                          setNewImages((items) =>
                            items.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      />
                    ))}
                    {savedImages.length + newImages.length < 3 ? (
                      <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm font-medium text-slate-600">
                        <ImagePlus className="h-6 w-6" />
                        Agregar imagen
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          className="sr-only"
                          disabled={pending}
                          onChange={(event) => {
                            // Snapshot FileList before clearing the input: React may run
                            // the state updater after the native input has been reset.
                            const files = Array.from(event.currentTarget.files ?? []);
                            const available = 3 - savedImages.length - newImages.length;
                            event.currentTarget.value = '';
                            const validFiles = files.filter((file) => {
                              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                                toast.error(`${file.name}: selecciona una imagen JPG, PNG o WEBP.`);
                                return false;
                              }
                              if (file.size > 5 * 1024 * 1024) {
                                toast.error(`${file.name}: el tamaño máximo es 5 MB.`);
                                return false;
                              }
                              return true;
                            });
                            if (validFiles.length > available)
                              toast.warning(
                                'Puedes agregar un máximo de 3 imágenes por recepción.',
                              );
                            const selected = validFiles.slice(0, available);
                            setNewImages((items) => [...items, ...selected]);
                          }}
                        />
                      </label>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    JPG, PNG o WEBP · Hasta 5 MB por imagen. Las fotos se suben al guardar la
                    recepción.
                  </p>
                </div>
              </div>
              <div className="mt-5">
                <ReceptionClauses />
              </div>
            </form>
          ) : null}
          {ticket.status === 'DIAGNOSIS' ? (
            <Button
              className="h-14 w-full"
              onClick={() => {
                onClose();
                router.push(`/workshop?ticket=${encodeURIComponent(ticket.id)}`);
              }}
            >
              Continuar a la orden de trabajo
            </Button>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Button
            type="button"
            variant="outline"
            className="h-12 text-sm"
            onClick={() => setHistoryOpen(true)}
            disabled={pending}
          >
            <History className="h-5 w-5" /> Ver historial del cliente
          </Button>
          {ticket.status === 'RECEIVED' ? (
            <Button
              type="submit"
              form={formId}
              className="h-12 text-sm sm:min-w-64"
              disabled={pending}
            >
              <Save className="h-5 w-5" />{' '}
              {pending ? 'Guardando recepción…' : 'Revisar y guardar recepción'}
            </Button>
          ) : null}
        </footer>
      </div>
      {savedTicketId ? (
        <ActionDialog
          open
          title="Recepción guardada"
          description="Puedes imprimir la copia del cliente o continuar a la orden de trabajo."
          confirmLabel="Continuar a OT"
          cancelLabel="Cerrar"
          onClose={() => {
            setSavedTicketId(null);
            onClose();
          }}
          onConfirm={() => {
            onClose();
            router.push(`/workshop?ticket=${encodeURIComponent(savedTicketId)}`);
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Button type="button" asChild>
              <a
                href={`/workshop/${savedTicketId}/reception/print?autoPrint=1`}
                target="_blank"
                rel="noreferrer"
              >
                Imprimir recepción / Guardar PDF
              </a>
            </Button>
            <ReceptionWhatsappButton ticket={ticket} />
          </div>
        </ActionDialog>
      ) : null}
      {signatureOpen ? (
        <ReceptionSignatureDialog
          customerName={ticket.customer.name}
          pending={pending}
          onClose={() => {
            if (!pending) setSignatureOpen(false);
          }}
          onConfirm={(signature) => receptionMutation.mutate(signature)}
          summary={
            <div className="space-y-1">
              <p className="font-semibold">
                {ticket.ticketNumber} · {ticket.customer.name}
              </p>
              <p>
                {ticket.vehicle.licensePlate} · {ticket.vehicle.make} {ticket.vehicle.model}
              </p>
              <p>
                Kilometraje: {mileage} km · Combustible: {fuelLevel || 'No registrado'}
              </p>
              <p>Condición exterior: {exterior || 'Sin observaciones'}</p>
              <p>
                Interior: {interior || 'Sin observaciones'} · Accesorios:{' '}
                {accessories || 'No registrados'} · Pertenencias: {belongings || 'No registradas'}
              </p>
              <p>Testigos: {warningLights || 'Sin observaciones'}</p>
              <p className="whitespace-pre-wrap">Revisión inicial: {diagnosis}</p>
              <p>Evidencias: {savedImages.length + newImages.length} de 3 imágenes</p>
              <div className="grid grid-cols-3 gap-2">
                {savedImages.map((url) => (
                  <ImageTile key={url} src={url} />
                ))}
                {newImages.map((file, index) => (
                  <ImageTile key={`${file.name}-${index}`} file={file} />
                ))}
              </div>
            </div>
          }
        />
      ) : null}
      {historyOpen ? (
        <div
          className="fixed inset-0 z-[125] grid place-items-center bg-slate-950/60 p-3"
          onMouseDown={(event) => event.target === event.currentTarget && setHistoryOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Historial del cliente"
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <header className="flex items-start gap-3 border-b p-5">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setHistoryOpen(false)}
                aria-label="Regresar"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-bold">Historial del cliente y vehículo</h2>
                <p className="font-semibold">
                  {ticket.customer.name} · {ticket.customer.phone ?? 'Sin teléfono'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {ticket.vehicle.licensePlate ?? 'SIN PLACA'} · {ticket.vehicle.make}{' '}
                  {ticket.vehicle.model}
                  {ticket.vehicle.year ? ` · ${ticket.vehicle.year}` : ''}
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setHistoryOpen(false)}>
                <X className="h-5 w-5" />
              </Button>
            </header>
            <div className="space-y-5 overflow-y-auto p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    Cliente
                  </p>
                  <p className="mt-2 text-lg font-bold">{ticket.customer.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {ticket.customer.phone ?? 'Sin teléfono'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {ticket.customer.email ?? 'Sin correo'}
                  </p>
                </div>
                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    Vehículo
                  </p>
                  <p className="mt-2 text-lg font-black tracking-wide">
                    {ticket.vehicle.licensePlate ?? 'SIN PLACA'}
                  </p>
                  <p className="font-semibold">
                    {ticket.vehicle.make} {ticket.vehicle.model}
                    {ticket.vehicle.year ? ` · ${ticket.vehicle.year}` : ''}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    VIN: {ticket.vehicle.vin ?? 'No registrado'} ·{' '}
                    {ticket.vehicle.mileage === null
                      ? 'Kilometraje no registrado'
                      : `${Number(ticket.vehicle.mileage).toLocaleString('es-DO')} km`}
                  </p>
                </div>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <HistorySection
                  title="Historial del vehículo"
                  subtitle={`${vehicleHistory.data?.tickets.length ?? 0} orden(es) · ${vehicleHistory.data?.appointments.length ?? 0} cita(s)`}
                  tickets={vehicleHistory.data?.tickets ?? []}
                />
                <HistorySection
                  title="Historial del cliente"
                  subtitle={`${relatedCustomerOrders.length} orden(es) en todos sus vehículos`}
                  tickets={relatedCustomerOrders}
                />
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function HistorySection({
  title,
  subtitle,
  tickets,
}: {
  title: string;
  subtitle: string;
  tickets: WorkshopTicket[];
}) {
  return (
    <section>
      <h3 className="font-bold">{title}</h3>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-3 space-y-2">
        {tickets.map((item) => (
          <div key={item.id} className="rounded-xl border bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <strong>{item.ticketNumber}</strong>
              <Badge variant="outline">{statusLabels[item.status]}</Badge>
            </div>
            <p className="mt-1 text-sm font-semibold">
              {item.vehicle.licensePlate ?? 'SIN PLACA'} · {item.vehicle.make} {item.vehicle.model}
            </p>
            <p className="text-sm text-muted-foreground">
              {new Date(item.openedAt).toLocaleDateString('es-DO')} · {item.complaint}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Trabajos:{' '}
              {item.lines.length
                ? item.lines.map((line) => line.description).join(', ')
                : 'Sin trabajos registrados'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Último cambio:{' '}
              {new Date(item.statusEvents[0]?.createdAt ?? item.openedAt).toLocaleString('es-DO')}
            </p>
          </div>
        ))}
        {!tickets.length ? (
          <p className="rounded-xl bg-slate-50 p-4 text-sm text-muted-foreground">
            No hay historial registrado.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ImageTile({ src, file, onRemove }: { src?: string; file?: File; onRemove?: () => void }) {
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="relative overflow-hidden rounded-xl border bg-slate-50">
      {src || preview ? (
        <img
          src={src ?? preview}
          alt="Evidencia de recepción"
          className="h-28 w-full object-cover"
        />
      ) : (
        <div className="h-28" />
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-white text-red-600 shadow"
          aria-label="Quitar imagen"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function TouchField({
  label,
  children,
  wide = false,
  required = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
  required?: boolean;
}) {
  return (
    <label className={`min-w-0 grid gap-2 text-base font-medium ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="text-sm">
        {label}
        {required ? <span className="ml-1 text-red-500">*</span> : null}
      </span>
      {children}
    </label>
  );
}
