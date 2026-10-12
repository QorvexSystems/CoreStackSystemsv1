"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CalendarDays,
  CreditCard,
  FilePenLine,
  Mail,
  MapPin,
  Phone,
  Printer,
  UserRound,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getSalesOrder } from "@/lib/api";
import { brand } from "@/lib/brand";
import { formatBusinessRnc } from "@/lib/dominican-documents";
import {
  getStatusVariant,
  translateProductUnit,
  translateStatus,
} from "@/lib/display-labels";
import { getOrderClientLabel } from "@/lib/order-client";
import { formatCurrency, formatDate } from "@/lib/utils";
import { formatQuantity, getCommonProductUnit } from "./pos/pos-utils";
import { SessionRequired, useCurrentSession } from "./session-required";

const navy = "#102f55";
const corporateBlue = "#075fc9";

export function QuotationPrint({
  orderId,
  autoPrint = false,
}: {
  orderId: string;
  autoPrint?: boolean;
}) {
  const session = useCurrentSession();
  const router = useRouter();
  const orderQuery = useQuery({
    queryKey: ["sales-order", orderId, session?.tenantId],
    queryFn: () =>
      getSalesOrder(
        session?.tenantId ?? "",
        session?.accessToken ?? "",
        orderId,
      ),
    enabled: Boolean(session && orderId),
  });

  useEffect(() => {
    if (!autoPrint || !orderQuery.data) return;

    const timeout = window.setTimeout(async () => {
      await Promise.all(
        Array.from(document.images).map(
          (image) =>
            new Promise<void>((resolve) => {
              if (image.complete) {
                resolve();
                return;
              }
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            }),
        ),
      );
      window.print();
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [autoPrint, orderQuery.data]);

  if (!session) return <SessionRequired session={session} />;
  if (orderQuery.isLoading) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Cargando cotización...
      </p>
    );
  }

  const order = orderQuery.data;
  if (!order || !isQuotationRecord(order)) {
    return (
      <div className="p-6">
        <p className="text-sm text-danger">Cotización no encontrada.</p>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => router.push("/quotations")}
        >
          Volver a cotizaciones
        </Button>
      </div>
    );
  }

  const subtotalAfterDiscount = Number(order.subtotal);
  const discountTotal = Number(order.discountTotal ?? 0);
  const grossSubtotal = subtotalAfterDiscount + discountTotal;
  const companyName =
    order.tenant.commercialName ??
    order.tenant.legalName ??
    order.tenant.name ??
    brand.name;
  const paymentMode = order.paymentMode === "CREDIT" ? "Fiado" : "Contado";
  const hasContact = Boolean(order.tenant.phone || order.tenant.email);

  return (
    <>
      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 10mm;
        }
        .quotation-sheet {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .quotation-products thead {
          display: table-header-group;
        }
        .quotation-products tr,
        .quotation-info-card,
        .quotation-summary,
        .quotation-bottom-card,
        .quotation-footer {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        @media print {
          html,
          body {
            background: #ffffff !important;
          }
          body {
            margin: 0 !important;
          }
          .quotation-screen-actions {
            display: none !important;
          }
          .quotation-sheet {
            width: 190mm !important;
            max-width: 190mm !important;
            min-height: 0;
            overflow: visible !important;
            margin: 0 auto !important;
            border: 0 !important;
            border-radius: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
          }
          .quotation-products tbody tr:last-child td {
            border-bottom: 0;
          }
          .quotation-table-shell {
            overflow: visible !important;
          }
        }
      `}</style>

      <div className="quotation-screen-actions mx-auto max-w-[960px] space-y-4 px-3 py-5 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">
              Cotización {order.orderNumber}
            </h1>
            <p className="text-sm text-muted-foreground">
              Documento listo para imprimir o guardar como PDF.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => router.push("/quotations")}
            >
              Volver
            </Button>
            <Button onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Imprimir o guardar PDF
            </Button>
          </div>
        </div>
      </div>

      <article className="quotation-sheet mx-auto mb-8 w-[calc(100%-1.5rem)] max-w-[960px] overflow-hidden rounded-2xl border border-slate-200 bg-white px-7 py-8 text-slate-950 shadow-sm sm:px-10 sm:py-10">
        <header className="flex items-start justify-between gap-8">
          <div className="min-w-0 flex-1">
            <div className="relative h-20 w-48 sm:h-24 sm:w-56">
              <Image
                src={brand.logoPath}
                alt={brand.name}
                fill
                priority
                unoptimized
                className="object-contain object-left"
              />
            </div>
            {companyName !== brand.name ? (
              <p className="mt-2 text-sm font-semibold text-slate-600">
                {companyName}
              </p>
            ) : null}
          </div>
          <div className="w-[46%] max-w-[390px] space-y-2 pt-1 text-sm text-slate-700">
            <p
              className="mb-3 text-xl font-bold"
              style={{ color: corporateBlue }}
            >
              {companyName}
            </p>
            {order.tenant.address ? (
              <CompanyLine icon={MapPin}>{order.tenant.address}</CompanyLine>
            ) : null}
            {order.tenant.rnc ? (
              <CompanyLine icon={Building2}>
                RNC/Cédula: {formatBusinessRnc(order.tenant.rnc)}
              </CompanyLine>
            ) : null}
            {order.tenant.phone ? (
              <CompanyLine icon={Phone}>{order.tenant.phone}</CompanyLine>
            ) : null}
            {order.tenant.email ? (
              <CompanyLine icon={Mail}>{order.tenant.email}</CompanyLine>
            ) : null}
          </div>
        </header>

        <section className="mt-6">
          <p className="text-[13px] font-semibold uppercase tracking-[0.32em] text-slate-500">
            Cotización
          </p>
          <h2 className="mt-2 break-all text-[28px] font-extrabold leading-tight tracking-tight sm:text-[34px]">
            {order.orderNumber}
          </h2>
          <div className="mt-4 flex flex-wrap gap-3">
            <Badge
              variant={getStatusVariant(order.status)}
              className="gap-2 rounded-full px-4 py-2 text-sm font-semibold"
            >
              {translateStatus(order.status)}
            </Badge>
            <Badge
              variant="default"
              className="gap-2 rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700"
            >
              <CreditCard className="h-4 w-4" /> Modalidad:{" "}
              {paymentMode.toLowerCase()}
            </Badge>
          </div>
        </section>

        <section className="mt-5 grid grid-cols-3 gap-3">
          <InfoCard
            icon={UserRound}
            label="Cliente"
            value={getOrderClientLabel(order)}
          />
          <InfoCard
            icon={CalendarDays}
            label="Fecha"
            value={formatDate(order.createdAt)}
          />
          <InfoCard
            icon={FilePenLine}
            label="Elaborada por"
            value={order.createdBy.name}
          />
        </section>

        <section className="quotation-table-shell mt-5 overflow-hidden rounded-xl border border-slate-200">
          <table className="quotation-products w-full table-fixed text-[13px]">
            <thead style={{ backgroundColor: navy }} className="text-white">
              <tr>
                <th className="w-[7%] px-3 py-3 text-center font-semibold">
                  #
                </th>
                <th className="w-[43%] px-3 py-3 text-left font-semibold">
                  Producto
                </th>
                <th className="w-[16%] px-3 py-3 text-right font-semibold">
                  Cant.
                </th>
                <th className="w-[17%] px-3 py-3 text-right font-semibold">
                  Precio unit.
                </th>
                <th className="w-[17%] px-3 py-3 text-right font-semibold">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, index) => (
                <tr
                  key={item.id}
                  className="border-b border-slate-200 bg-white align-middle"
                >
                  <td className="px-3 py-3 text-center text-slate-600">
                    {index + 1}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      {item.product?.imageUrl ? (
                        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={item.product.imageUrl}
                            alt=""
                            className="h-full w-full object-contain"
                          />
                        </div>
                      ) : null}
                      <span className="min-w-0 break-words font-semibold leading-snug text-slate-950">
                        {item.description}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {formatQuantity(item.quantity)}{" "}
                    {translateProductUnit(
                      item.product?.unit ?? getCommonProductUnit(item.sku),
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-700">
                    {formatCurrency(
                      Number(item.quantity) > 0
                        ? Number(item.total) / Number(item.quantity)
                        : 0,
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-bold tabular-nums text-slate-950">
                    {formatCurrency(Number(item.total))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="quotation-summary ml-auto mt-3 w-full max-w-[490px] rounded-xl bg-blue-50 px-5 py-4">
          <AmountLine label="Subtotal bruto" value={grossSubtotal} />
          {discountTotal > 0 ? (
            <AmountLine label="Descuentos" value={discountTotal} negative />
          ) : null}
          <AmountLine
            label="Subtotal después de descuento"
            value={subtotalAfterDiscount}
          />
          <AmountLine label="ITBIS" value={Number(order.taxTotal)} />
          <div className="mt-2 flex items-end justify-between border-t border-blue-200 pt-2">
            <span
              className="text-xl font-bold"
              style={{ color: corporateBlue }}
            >
              Total
            </span>
            <strong
              className="text-2xl font-extrabold tabular-nums"
              style={{ color: corporateBlue }}
            >
              {formatCurrency(Number(order.total))}
            </strong>
          </div>
        </section>

        <section
          className={`mt-4 grid gap-4 ${order.notes?.trim() ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {order.notes?.trim() ? (
            <div className="quotation-bottom-card rounded-xl border border-slate-200 p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-blue-50 p-2.5 text-blue-700">
                  <FilePenLine className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-blue-700">
                    Términos y condiciones
                  </h3>
                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600">
                    {order.notes}
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          <div className="quotation-bottom-card rounded-xl border border-slate-200 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-blue-50 p-2.5 text-blue-700">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-blue-700">
                  Método de pago
                </p>
                <p className="mt-1 inline-flex rounded-full bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-700">
                  {paymentMode}
                </p>
              </div>
            </div>
            {hasContact ? (
              <div className="mt-3 border-t border-slate-200 pt-3 text-sm text-slate-600">
                <p className="font-bold text-slate-900">¿Dudas o consultas?</p>
                {order.tenant.phone ? (
                  <p className="mt-1">Teléfono: {order.tenant.phone}</p>
                ) : null}
                {order.tenant.email ? (
                  <p>Correo: {order.tenant.email}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        {order.paymentMode === "CREDIT" ? (
          <section className="quotation-bottom-card mt-4 rounded-xl border border-blue-200 bg-blue-50/60 px-5 py-4 text-sm">
            <div className="grid grid-cols-3 gap-4">
              <SummaryDatum
                label="Pago inicial"
                value={formatCurrency(Number(order.initialPaymentAmount))}
              />
              <SummaryDatum
                label="Saldo financiado"
                value={formatCurrency(
                  Number(order.total) - Number(order.initialPaymentAmount),
                )}
              />
              {order.dueDate ? (
                <SummaryDatum
                  label="Vencimiento previsto"
                  value={formatDate(order.dueDate)}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        <footer className="quotation-footer mt-5 flex items-end justify-between border-t-2 border-blue-600 pt-4">
          <div>
            <p className="text-lg font-bold" style={{ color: navy }}>
              Gracias por preferir {brand.name}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Estamos para servirte.
            </p>
          </div>
          <div className="relative h-16 w-32">
            <Image
              src={brand.logoPath}
              alt={brand.name}
              fill
              priority
              unoptimized
              className="object-contain object-right"
            />
          </div>
        </footer>
      </article>
    </>
  );
}

function CompanyLine({
  icon: Icon,
  children,
}: {
  icon: typeof MapPin;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: navy }} />
      <span className="leading-snug">{children}</span>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UserRound;
  label: string;
  value: string;
}) {
  return (
    <div className="quotation-info-card flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
      <div className="shrink-0 rounded-full bg-blue-50 p-3 text-blue-700">
        <Icon className="h-6 w-6" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </p>
        <p className="mt-1 break-words text-sm font-bold leading-snug text-slate-950">
          {value}
        </p>
      </div>
    </div>
  );
}

function AmountLine({
  label,
  value,
  negative = false,
}: {
  label: string;
  value: number;
  negative?: boolean;
}) {
  return (
    <div className="flex justify-between gap-6 py-0.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <strong className="tabular-nums text-slate-950">
        {negative ? "-" : ""}
        {formatCurrency(value)}
      </strong>
    </div>
  );
}

function SummaryDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 font-bold text-slate-950">{value}</p>
    </div>
  );
}

function isQuotationRecord(order: {
  destination?: string;
  orderNumber: string;
}) {
  return (
    order.destination === "QUOTATION" || order.orderNumber.startsWith("COT-")
  );
}
