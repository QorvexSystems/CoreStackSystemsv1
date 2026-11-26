'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard,
  FileText,
  PackagePlus,
  Pause,
  Play,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  acceptSalesOrder,
  cancelSalesOrder,
  createSalesOrder,
  createOrderTakingDraft,
  discardOrderTakingDraft,
  getCustomers,
  getOrderTakingDrafts,
  getOrderProduct,
  getOrderProductByBarcode,
  getSalesOrder,
  getSalesOrders,
  searchOrderProducts,
  updateSalesOrder,
  updateOrderTakingDraft,
  type Product,
  type CreditTermOption,
  type Customer,
  type InitialPaymentOption,
  type SalePaymentMode,
  type SalesOrder,
  type SalesOrderPriceLevel,
  type OrderTakingDraft,
} from '@/lib/api';
import { canTakeOrders, isAdminSession } from '@/lib/authorization';
import { getStatusVariant, translateStatus } from '@/lib/display-labels';
import {
  normalizeDominicanDocument,
  validateDominicanCedula,
  validateDominicanRnc,
} from '@/lib/dominican-documents';
import { getOrderClientLabel, getOrderSearchLabel } from '@/lib/order-client';
import { cn, formatCurrency, formatDate } from '@/lib/utils';
import { CancelReasonModal } from './cancel-reason-modal';
import { ModuleHeader } from './module-header';
import { OrderActivityDrawer } from './orders/order-activity-drawer';
import { CartSummaryBar, OrderCheckoutDialog } from './orders/order-checkout-dialog';
import { CommonProductDialog, type CommonProductDraft } from './orders/common-product-dialog';
import { BarcodeInput } from './pos/barcode-input';
import {
  clearCurrencyInput,
  formatCurrencyInput,
  formatCurrencyInputFromNumber,
  parseCurrencyInput,
  sanitizeCurrencyInput,
} from './pos/currency-input';
import { QuickOrderLines } from './orders/quick-order-lines';
import {
  canAddProduct,
  calculateSaleAmounts,
  customerDiscountForLine,
  getAvailableStock,
  isStockLimited,
  getCommonProductUnit,
  getDefaultQuantity,
  getProductPrice,
  getQuantityStep,
  roundQuantity,
} from './pos/pos-utils';
import { playScanFeedback } from './pos/scan-feedback';
import type { CartItem } from './pos/types';
import { SessionRequired, useCurrentSession } from './session-required';

type OrderDestination = 'CASH_SALE' | 'QUOTATION';
type InventorySource = 'SALES_INVENTORY' | 'WAREHOUSE';
type OrderDraftSnapshot = {
  cart: CartItem[];
  destination: OrderDestination;
  inventorySource: InventorySource;
  electronicInvoiceRequested: boolean;
  ecfRecipientEmail: string;
  clientName: string;
  quotationDocumentType: 'RNC' | 'CEDULA';
  quotationDocumentNumber: string;
  customerId: string;
  priceLevel: SalesOrderPriceLevel;
  customDiscountPercent: number | null;
  paymentMode: SalePaymentMode;
  initialPaymentOption: InitialPaymentOption;
  customInitialPaymentAmount: string;
  creditTermOption: CreditTermOption;
  customDueDate: string;
  creditRequestNote: string;
  notes: string;
};
const finalDiscountCustomerId = '__FINAL_DISCOUNT_10__';
const finalPreferredCustomerId = '__FINAL_PREFERRED_18__';

const specialCustomerLabels = [
  'Consumidor final (descuento al por mayor 5%)',
  'Consumidor final (descuento al por mayor 10%)',
  'Consumidor final (descuento 5%)',
  'Consumidor final (cliente preferencial 10%)',
  // Keep recognizing labels stored by drafts created before the rate change.
  'Consumidor final (descuento 10%)',
  'Consumidor final (cliente preferencial 18%)',
];

function getPriceLevelDiscountRate(
  priceLevel: SalesOrderPriceLevel,
  customDiscountPercent?: number | null,
) {
  if (customDiscountPercent !== undefined && customDiscountPercent !== null) {
    return customDiscountPercent / 100;
  }
  if (priceLevel === 'DISCOUNT_10') {
    return 0.05;
  }

  if (priceLevel === 'PREFERRED_18') {
    return 0.1;
  }

  return 0;
}

function getSpecialCustomerPriceLevel(
  customerValue: string,
): Exclude<SalesOrderPriceLevel, 'REGULAR'> | null {
  if (customerValue === finalDiscountCustomerId) {
    return 'DISCOUNT_10';
  }

  if (customerValue === finalPreferredCustomerId) {
    return 'PREFERRED_18';
  }

  return null;
}

function getSpecialCustomerValue(priceLevel?: SalesOrderPriceLevel | null) {
  if (priceLevel === 'DISCOUNT_10') {
    return finalDiscountCustomerId;
  }

  if (priceLevel === 'PREFERRED_18') {
    return finalPreferredCustomerId;
  }

  return '';
}

function getRegisteredCustomerId(customerValue: string) {
  return getSpecialCustomerPriceLevel(customerValue) ? '' : customerValue;
}

function normalizeCustomerSearch(value?: string | null) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es');
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildPricedCartItem(
  product: Product,
  quantity: number,
  priceLevel: SalesOrderPriceLevel,
  reservedQuantity = 0,
  customDiscountPercent?: number | null,
  pricesIncludeTax = false,
): CartItem {
  const regularUnitPrice = getProductPrice(product);
  const discountRate = getPriceLevelDiscountRate(priceLevel, customDiscountPercent);
  const amounts = calculateSaleAmounts(
    regularUnitPrice,
    quantity,
    Number(product.taxRate),
    discountRate,
    pricesIncludeTax,
  );

  return {
    product,
    quantity,
    reservedQuantity,
    unitPrice: amounts.unitPrice,
    regularTotal: amounts.regularTotal,
    discountTotal: amounts.discountTotal,
    subtotal: amounts.subtotal,
    taxTotal: amounts.taxTotal,
    total: amounts.total,
  };
}

function buildCommonCartItem(
  id: string,
  draft: CommonProductDraft,
  priceLevel: SalesOrderPriceLevel,
  customDiscountPercent?: number | null,
): CartItem {
  const product: Product = {
    id,
    name: draft.description,
    sku: null,
    barcode: null,
    barcodeType: null,
    generatedBarcode: false,
    barcodeLabelPrintCount: 0,
    description: 'Producto común agregado únicamente a esta venta',
    imageUrl: null,
    brand: null,
    unit: draft.unit,
    price: String(draft.unitPrice),
    salePrice: String(draft.unitPrice),
    cost: null,
    taxRate: '0.18',
    trackInventory: false,
    inventoryDestination: 'SALES_INVENTORY',
    stock: 0,
    reservedStock: 0,
    minStock: 0,
    status: 'ACTIVE',
    category: null,
  };

  return {
    ...buildPricedCartItem(
      product,
      draft.quantity,
      priceLevel,
      0,
      customDiscountPercent,
      false,
    ),
    commonProduct: {
      description: draft.description,
      unit: draft.unit,
      regularUnitPrice: draft.unitPrice,
    },
  };
}

export function OrdersView() {
  const session = useCurrentSession();
  const pricesIncludeTax =
    session?.salePricesIncludeTax ?? (session?.tenantSlug ? session.tenantSlug === 'allpa' : true);
  const canUseOrderTaking = canTakeOrders(session);
  const cashierCreditOnly = session?.role === 'CASHIER';
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const editOrderId = searchParams.get('edit');
  const router = useRouter();
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const loadedEditOrderRef = useRef<string | null>(null);
  const editToastShownRef = useRef<string | null>(null);
  const pauseInProgressRef = useRef(false);
  const clearInProgressRef = useRef(false);

  const [destination, setDestination] = useState<OrderDestination>('CASH_SALE');
  const [inventorySource, setInventorySource] = useState<InventorySource>('SALES_INVENTORY');
  const [electronicInvoiceRequested, setElectronicInvoiceRequested] = useState(false);
  const [ecfRecipientEmail, setEcfRecipientEmail] = useState('');
  const [clientName, setClientName] = useState('');
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [quotationDocumentType, setQuotationDocumentType] = useState<'RNC' | 'CEDULA'>('CEDULA');
  const [quotationDocumentNumber, setQuotationDocumentNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [priceLevel, setPriceLevel] = useState<SalesOrderPriceLevel>('REGULAR');
  const [customDiscountPercent, setCustomDiscountPercent] = useState<number | null>(null);
  const [customDiscountOpen, setCustomDiscountOpen] = useState(false);
  const [customDiscountInput, setCustomDiscountInput] = useState('');
  const [discountRequestOrderId, setDiscountRequestOrderId] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<SalePaymentMode>('CASH');
  const [initialPaymentOption, setInitialPaymentOption] =
    useState<InitialPaymentOption>('PERCENT_30');
  const [customInitialPaymentAmount, setCustomInitialPaymentAmount] =
    useState(clearCurrencyInput());
  const [creditTermOption, setCreditTermOption] = useState<CreditTermOption>('CUSTOMER_DEFAULT');
  const [customDueDate, setCustomDueDate] = useState('');
  const [creditRequestNote, setCreditRequestNote] = useState('');
  const [notes, setNotes] = useState('');
  const [barcode, setBarcode] = useState('');
  const [scannerEnabled, setScannerEnabled] = useState(false);
  const [scannerMessage, setScannerMessage] = useState<string | null>(null);
  const [lastScannedProduct, setLastScannedProduct] = useState<Product | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [orderTab, setOrderTab] = useState<'ACTIVE' | 'PENDING'>('ACTIVE');
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [activeDraftVersion, setActiveDraftVersion] = useState<number | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [commonProductOpen, setCommonProductOpen] = useState(false);
  const [quotationsOpen, setQuotationsOpen] = useState(false);
  const [loadedEditOrderId, setLoadedEditOrderId] = useState<string | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [cancelTargetLabel, setCancelTargetLabel] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const effectiveInventorySource: InventorySource = editOrderId || discountRequestOrderId
    ? inventorySource
    : cart.find((item) => !item.commonProduct)?.product.inventoryDestination ?? inventorySource;
  const hasCatalogProducts = cart.some((item) => !item.commonProduct);

  const customersQuery = useQuery({
    queryKey: ['order-customers', session?.tenantId],
    queryFn: () => getCustomers(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: canUseOrderTaking,
  });
  const productsQuery = useQuery({
    queryKey: ['order-products-search', session?.tenantId, debouncedSearch, effectiveInventorySource],
    queryFn: () =>
      searchOrderProducts(
        session?.tenantId ?? '',
        session?.accessToken ?? '',
        debouncedSearch,
        effectiveInventorySource,
      ),
    enabled: canUseOrderTaking && debouncedSearch.length >= 2,
  });
  const draftsQuery = useQuery({
    queryKey: ['order-taking-drafts', session?.tenantId],
    queryFn: () => getOrderTakingDrafts(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: canUseOrderTaking,
    refetchInterval: 15000,
  });
  const pendingDrafts = (draftsQuery.data ?? []).filter((draft) => draft.id !== activeDraftId);
  const quotationsQuery = useQuery({
    queryKey: ['sales-orders', session?.tenantId, 'QUOTATION'],
    queryFn: () => getSalesOrders(session?.tenantId ?? '', session?.accessToken ?? '', 'QUOTATION'),
    enabled: canUseOrderTaking,
  });
  const discountRequestOrderQuery = useQuery({
    queryKey: ['discount-request-order', session?.tenantId, discountRequestOrderId],
    queryFn: () =>
      getSalesOrder(
        session?.tenantId ?? '',
        session?.accessToken ?? '',
        discountRequestOrderId ?? '',
      ),
    enabled: Boolean(session && discountRequestOrderId),
    refetchInterval: discountRequestOrderId ? 3000 : false,
  });
  const discountRequestOrder = discountRequestOrderQuery.data;
  const discountApproval = discountRequestOrder?.discountApproval ?? null;
  const discountApprovalStatus = discountApproval?.status ?? null;

  useEffect(() => {
    if (scannerEnabled) {
      barcodeInputRef.current?.focus();
    }
  }, [scannerEnabled]);

  useEffect(() => {
    if (!scannerEnabled) return;
    function handleScannerEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setScannerEnabled(false);
      setScannerMessage(null);
    }
    document.addEventListener('keydown', handleScannerEscape);
    return () => document.removeEventListener('keydown', handleScannerEscape);
  }, [scannerEnabled]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (cashierCreditOnly && !editOrderId) {
      setPaymentMode('CREDIT');
    }
  }, [cashierCreditOnly, editOrderId]);

  useEffect(() => {
    setCart((current) =>
      current.map((item) =>
        item.commonProduct
          ? buildCommonCartItem(
              item.product.id,
              {
                description: item.commonProduct.description,
                unit: item.commonProduct.unit,
                unitPrice: item.commonProduct.regularUnitPrice,
                quantity: item.quantity,
              },
              priceLevel,
              customDiscountPercent,
            )
          : buildPricedCartItem(
              item.product,
              item.quantity,
              priceLevel,
              item.reservedQuantity,
              customDiscountPercent,
              pricesIncludeTax,
            ),
      ),
    );
  }, [customDiscountPercent, priceLevel, pricesIncludeTax]);

  // Cargar orden para edición si está el parámetro 'edit'
  useEffect(() => {
    if (!editOrderId) {
      loadedEditOrderRef.current = null;
      editToastShownRef.current = null;
      return;
    }

    if (
      !session ||
      !canUseOrderTaking ||
      loadedEditOrderRef.current === editOrderId ||
      loadedEditOrderId === editOrderId
    ) {
      return;
    }

    let active = true;
    loadedEditOrderRef.current = editOrderId;

    async function loadOrder() {
      try {
        const order = await getSalesOrder(session!.tenantId, session!.accessToken, editOrderId!);
        if (!active) return;

        if (order.status !== 'QUOTATION') {
          toast.error('Solo se pueden modificar cotizaciones.');
          loadedEditOrderRef.current = null;
          router.replace('/orders');
          return;
        }

        // Cargar datos
        setDestination('QUOTATION');
        setInventorySource(order.inventorySource ?? 'SALES_INVENTORY');
        setElectronicInvoiceRequested(order.electronicInvoiceRequested);
        setClientName(order.clientName || '');
        setCustomerId(order.customerId || getSpecialCustomerValue(order.priceLevel));
        setPriceLevel(order.priceLevel ?? 'REGULAR');
        const loadedCustomDiscountPercent =
          order.priceLevel === 'REGULAR' && Number(order.discountRate) > 0
            ? Number(order.discountRate) * 100
            : null;
        setCustomDiscountPercent(loadedCustomDiscountPercent);
        setPaymentMode(order.paymentMode ?? 'CASH');
        setInitialPaymentOption(order.initialPaymentOption ?? 'PERCENT_30');
        setCustomInitialPaymentAmount(
          order.initialPaymentOption === 'CUSTOM'
            ? formatCurrencyInputFromNumber(Number(order.initialPaymentAmount))
            : clearCurrencyInput(),
        );
        setCreditTermOption(order.creditTermOption ?? 'CUSTOMER_DEFAULT');
        setCustomDueDate(
          order.creditTermOption === 'CUSTOM_DATE' && order.dueDate
            ? order.dueDate.slice(0, 10)
            : '',
        );
        setCreditRequestNote(order.creditRequestNote ?? order.creditApproval?.requestNote ?? '');
        setNotes(order.notes || '');
        if (order.quotationDocumentType === 'RNC' || order.quotationDocumentType === 'CEDULA') {
          setQuotationDocumentType(order.quotationDocumentType);
        }
        setQuotationDocumentNumber(order.quotationDocumentNumber || '');

        // Cargar productos en el carrito
        const cartItems = order.items.map((item) => {
          const quantity = Number(item.quantity);
          const discountTotal = Number(item.discountTotal ?? 0);
          const subtotal = Number(item.subtotal);
          if (!item.productId) {
            const regularNetSubtotal = subtotal + discountTotal;
            const regularUnitPrice =
              quantity > 0 ? roundMoney(regularNetSubtotal / quantity) : 0;
            return {
              ...buildCommonCartItem(
                `common:${item.id}`,
                {
                  description: item.description,
                  unit: getCommonProductUnit(item.sku),
                  unitPrice: regularUnitPrice,
                  quantity,
                },
                order.priceLevel,
                loadedCustomDiscountPercent,
              ),
              reservedQuantity: 0,
              unitPrice: Number(item.unitPrice),
              regularTotal: item.regularTotal === null ? null : Number(item.regularTotal),
              discountTotal,
              subtotal,
              taxTotal: Number(item.taxTotal),
              total: Number(item.total),
            };
          }
          if (!item.product) {
            throw new Error('La cotización contiene un producto de inventario no disponible.');
          }
          return {
            product: item.product as Product,
            quantity,
            reservedQuantity: item.reservedQuantity,
            unitPrice: Number(item.unitPrice),
            regularTotal: item.regularTotal === null ? null : Number(item.regularTotal),
            discountTotal,
            subtotal,
            taxTotal: Number(item.taxTotal),
            total: Number(item.total),
          };
        });

        setCart(cartItems);
        setCartDrawerOpen(true);
        setLoadedEditOrderId(editOrderId);
        loadedEditOrderRef.current = null;

        if (editToastShownRef.current !== editOrderId) {
          editToastShownRef.current = editOrderId;
          toast.info(`Editando cotizacion: ${order.orderNumber}`);
        }
      } catch (err) {
        if (!active) return;
        loadedEditOrderRef.current = null;
        toast.error('No se pudo cargar la cotizacion para editar.');
        router.replace('/orders');
      }
    }

    loadOrder();

    return () => {
      active = false;
      if (loadedEditOrderRef.current === editOrderId && loadedEditOrderId !== editOrderId) {
        loadedEditOrderRef.current = null;
      }
    };
  }, [canUseOrderTaking, editOrderId, session, router, loadedEditOrderId]);

  const activeCustomers = (customersQuery.data ?? []).filter(
    (customer) => customer.status === 'ACTIVE',
  );
  const selectedCustomer = activeCustomers.find(
    (customer) => customer.id === getRegisteredCustomerId(customerId),
  );
  const normalizedCustomerSearch = normalizeCustomerSearch(clientName);
  const customerSearchResults = useMemo(() => {
    const matches = normalizedCustomerSearch
      ? activeCustomers.filter((customer) =>
          [customer.name, customer.documentNumber, customer.phone, customer.email].some((value) =>
            normalizeCustomerSearch(value).includes(normalizedCustomerSearch),
          ),
        )
      : activeCustomers.filter((customer) => Number(customer.creditBalance ?? 0) > 0);

    return matches
      .sort((left, right) => {
        const leftStartsWithSearch = normalizeCustomerSearch(left.name).startsWith(
          normalizedCustomerSearch,
        );
        const rightStartsWithSearch = normalizeCustomerSearch(right.name).startsWith(
          normalizedCustomerSearch,
        );
        if (leftStartsWithSearch !== rightStartsWithSearch) {
          return leftStartsWithSearch ? -1 : 1;
        }

        const balanceDifference =
          Number(right.creditBalance ?? 0) - Number(left.creditBalance ?? 0);
        if (balanceDifference) return balanceDifference;
        return left.name.localeCompare(right.name, 'es');
      })
      .slice(0, 8);
  }, [activeCustomers, normalizedCustomerSearch]);
  const sortedProducts = [...(productsQuery.data ?? [])]
    .sort((a, b) => {
      const exact = (product: Product) =>
        Number([product.sku, product.barcode].some((code) => code?.toLowerCase() === debouncedSearch.toLowerCase()));
      const exactDifference = exact(b) - exact(a);
      if (exactDifference) return exactDifference;
      if (cart.some((item) => !item.commonProduct) || editOrderId) {
        const sameSourceDifference =
          Number(b.inventoryDestination === effectiveInventorySource) - Number(a.inventoryDestination === effectiveInventorySource);
        if (sameSourceDifference) return sameSourceDifference;
      }
      const stockDifference = Number(!isStockLimited(b) || getAvailableStock(b) > 0)
        - Number(!isStockLimited(a) || getAvailableStock(a) > 0);
      return stockDifference || a.name.localeCompare(b.name);
    });
  const visibleProducts = sortedProducts.slice(0, 50);
  const quantitiesByProduct = Object.fromEntries(
    cart.map((item) => [item.product.id, item.quantity]),
  );
  const totals = useMemo(() => {
    const lineAmounts = cart.map((item) => {
      if (item.subtotal !== undefined && item.taxTotal !== undefined && item.total !== undefined) {
        return {
          subtotal: item.subtotal,
          taxTotal: item.taxTotal,
          total: item.total,
        };
      }

      return calculateSaleAmounts(
        getProductPrice(item.product),
        item.quantity,
        Number(item.product.taxRate),
        getPriceLevelDiscountRate(priceLevel, customDiscountPercent),
        pricesIncludeTax,
      );
    });
    const subtotal = lineAmounts.reduce((sum, item) => sum + item.subtotal, 0);
    const discount = cart.reduce((sum, item) => sum + customerDiscountForLine(
      { ...item, total: item.total ?? 0, taxRate: item.product.taxRate },
      session?.tenantSlug === 'allpa',
    ), 0);
    const tax = lineAmounts.reduce((sum, item) => sum + item.taxTotal, 0);
    const total = lineAmounts.reduce((sum, item) => sum + item.total, 0);

    return {
      subtotal,
      discount,
      tax,
      total,
    };
  }, [cart, customDiscountPercent, priceLevel, pricesIncludeTax, session?.tenantSlug]);
  const initialPaymentRate =
    initialPaymentOption === 'PERCENT_30'
      ? 0.3
      : initialPaymentOption === 'PERCENT_50'
        ? 0.5
        : initialPaymentOption === 'PERCENT_70'
          ? 0.7
          : 0;
  const initialPaymentAmount =
    initialPaymentOption === 'CUSTOM'
      ? roundMoney(parseCurrencyInput(customInitialPaymentAmount))
      : roundMoney(totals.total * initialPaymentRate);
  const financedAmount = roundMoney(totals.total - initialPaymentAmount);
  const projectedCustomerBalance = roundMoney(
    Number(selectedCustomer?.creditBalance ?? 0) + financedAmount,
  );
  const exceedsCreditLimit = Boolean(
    paymentMode === 'CREDIT' &&
    selectedCustomer &&
    projectedCustomerBalance > Number(selectedCustomer.creditLimit),
  );

  const barcodeMutation = useMutation({
    mutationFn: (code: string) => {
      if (!session) {
        throw new Error('Sesion requerida.');
      }

      return getOrderProductByBarcode(
        session.tenantId, session.accessToken, code, effectiveInventorySource,
      );
    },
    onSuccess: (product) => {
      const added = addProduct(product);
      setBarcode('');
      if (added) {
        const sourceLabel = product.inventoryDestination === 'WAREHOUSE' ? 'Almacén B2B' : 'Inventario';
        playScanFeedback('success');
        setLastScannedProduct(product);
        setScannerMessage(`Producto agregado desde ${sourceLabel}: ${product.name}`);
        toast.success('Producto agregado', { description: `${product.name} · ${sourceLabel}` });
      } else {
        playScanFeedback('error');
      }
    },
    onError: () => {
      setBarcode('');
      playScanFeedback('error');
      setScannerMessage('Producto no encontrado.');
      toast.error('Producto no encontrado.');
    },
  });

  const createOrderMutation = useMutation({
    mutationFn: (discountRequest?: { percent: number; requestApproval: boolean }) => {
      if (!session) {
        throw new Error('Sesion requerida.');
      }

      const trimmedClientName = clientName.trim();

      if (paymentMode === 'CREDIT') {
        if (!selectedCustomer) {
          throw new Error('Una venta fiada requiere seleccionar un cliente registrado.');
        }
        if (!selectedCustomer.creditEnabled || selectedCustomer.creditStatus !== 'ACTIVE') {
          throw new Error('El crédito de este cliente no está habilitado o está bloqueado.');
        }
        if (creditTermOption === 'CUSTOM_DATE' && !customDueDate) {
          throw new Error('Selecciona la fecha de vencimiento del crédito.');
        }
        if (initialPaymentOption === 'CUSTOM') {
          if (initialPaymentAmount <= 0) {
            throw new Error('Indica un pago inicial personalizado mayor que cero.');
          }
          if (initialPaymentAmount > totals.total) {
            throw new Error('El pago inicial personalizado no puede superar el total de la orden.');
          }
        }
      }

      if (destination === 'QUOTATION') {
        const normalizedDocument = normalizeDominicanDocument(quotationDocumentNumber);
        const isValidDocument = normalizedDocument
          ? quotationDocumentType === 'RNC'
            ? validateDominicanRnc(quotationDocumentNumber)
            : validateDominicanCedula(quotationDocumentNumber)
          : true;

        if (!isValidDocument) {
          throw new Error(
            quotationDocumentType === 'RNC' ? 'El RNC no es valido.' : 'La cedula no es valida.',
          );
        }
      }

      const effectiveCustomDiscountPercent =
        discountRequest?.percent ?? customDiscountPercent ?? undefined;
      const payload = {
        ...(!editOrderId && activeDraftId && activeDraftVersion
          ? { draftId: activeDraftId, draftVersion: activeDraftVersion }
          : {}),
        destination,
        inventorySource: effectiveInventorySource,
        electronicInvoiceRequested:
          destination === 'CASH_SALE' ? electronicInvoiceRequested : false,
        ecfRecipientEmail:
          destination === 'CASH_SALE' && electronicInvoiceRequested && ecfRecipientEmail.trim()
            ? ecfRecipientEmail.trim()
            : undefined,
        clientName: trimmedClientName || undefined,
        customerId: getRegisteredCustomerId(customerId) || undefined,
        priceLevel,
        customDiscountPercent: effectiveCustomDiscountPercent,
        requestCustomDiscount: discountRequest?.requestApproval || undefined,
        paymentMode,
        initialPaymentOption: paymentMode === 'CREDIT' ? initialPaymentOption : undefined,
        customInitialPaymentAmount:
          paymentMode === 'CREDIT' && initialPaymentOption === 'CUSTOM'
            ? initialPaymentAmount
            : undefined,
        creditTermOption: paymentMode === 'CREDIT' ? creditTermOption : undefined,
        customDueDate:
          paymentMode === 'CREDIT' && creditTermOption === 'CUSTOM_DATE'
            ? customDueDate
            : undefined,
        creditRequestNote:
          paymentMode === 'CREDIT' ? creditRequestNote.trim() || undefined : undefined,
        quotationDocumentType:
          destination === 'QUOTATION' && normalizeDominicanDocument(quotationDocumentNumber)
            ? quotationDocumentType
            : undefined,
        quotationDocumentNumber:
          destination === 'QUOTATION' && normalizeDominicanDocument(quotationDocumentNumber)
            ? normalizeDominicanDocument(quotationDocumentNumber)
            : undefined,
        notes: notes.trim() || undefined,
        items: cart.map((item) =>
          item.commonProduct
            ? {
                description: item.commonProduct.description,
                unit: item.commonProduct.unit,
                unitPrice: item.commonProduct.regularUnitPrice,
                quantity: item.quantity,
              }
            : {
                productId: item.product.id,
                quantity: item.quantity,
              },
        ),
      };

      if (editOrderId) {
        return updateSalesOrder(session.tenantId, session.accessToken, editOrderId, payload);
      }

      return createSalesOrder(session.tenantId, session.accessToken, payload);
    },
    onSuccess: async (order) => {
      if (activeDraftId && session) {
        try {
          await discardOrderTakingDraft(session.tenantId, session.accessToken, activeDraftId);
        } catch {
          toast.error('La orden se creó, pero no se pudo quitar de En espera. Elimínala allí para evitar duplicarla.');
        }
      }
      setActiveDraftId(null);
      setActiveDraftVersion(null);
      await queryClient.invalidateQueries({ queryKey: ['order-taking-drafts'] });
      if (session?.role === 'ORDER_TAKER' && order.discountApproval) {
        const percent = Number(order.discountRate) * 100;
        setDiscountRequestOrderId(order.id);
        setCustomDiscountPercent(percent);
        setCustomDiscountInput(String(percent));
        setCustomDiscountOpen(false);
        setCartDrawerOpen(true);
        setMessage(
          `Descuento personalizado de ${percent}% pendiente de aprobación administrativa.`,
        );
        queryClient.setQueryData(
          ['discount-request-order', session.tenantId, order.id],
          order,
        );
        await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
        await queryClient.invalidateQueries({ queryKey: ['order-products-search'] });
        toast.success('Descuento enviado para aprobación', {
          description: `${percent}% · ${order.orderNumber}`,
        });
        return;
      }

      const successMessage = editOrderId
        ? `Cotizacion ${order.orderNumber} actualizada correctamente.`
        : order.discountApproval?.status === 'PENDING'
          ? `Solicitud de descuento para ${order.orderNumber} enviada a los administradores.`
          : destination === 'QUOTATION'
            ? `Cotizacion ${order.orderNumber} registrada correctamente.`
            : paymentMode === 'CREDIT'
              ? `Solicitud de crédito ${order.orderNumber} enviada para aprobación administrativa.`
              : `Ticket pendiente ${order.orderNumber} enviado a caja. No es una factura fiscal.`;
      setMessage(successMessage);
      setCart([]);
      setInventorySource('SALES_INVENTORY');
      setElectronicInvoiceRequested(false);
      setEcfRecipientEmail('');
      setNotes('');
      setCustomerId('');
      setPriceLevel('REGULAR');
      setCustomDiscountPercent(null);
      setCustomDiscountInput('');
      setCustomDiscountOpen(false);
      setPaymentMode(cashierCreditOnly ? 'CREDIT' : 'CASH');
      setInitialPaymentOption('PERCENT_30');
      setCustomInitialPaymentAmount(clearCurrencyInput());
      setCreditTermOption('CUSTOMER_DEFAULT');
      setCustomDueDate('');
      setCreditRequestNote('');
      setClientName('');
      setQuotationDocumentNumber('');
      setCartDrawerOpen(false);
      setLoadedEditOrderId(null);
      loadedEditOrderRef.current = editOrderId ? editOrderId : null;
      editToastShownRef.current = null;
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['order-products-search'] });
      toast.success(
        editOrderId
          ? 'Cotizacion actualizada'
          : order.discountApproval?.status === 'PENDING'
            ? 'Descuento enviado para aprobación'
            : destination === 'QUOTATION'
              ? 'Cotizacion creada'
              : paymentMode === 'CREDIT'
                ? 'Crédito enviado para aprobación'
                : 'Ticket enviado a caja',
        { description: order.orderNumber },
      );

      if (editOrderId) {
        router.push('/quotations');
      }
    },
    onError: (error) => {
      const nextMessage = error instanceof Error ? error.message : 'No se pudo enviar la orden.';
      setMessage(nextMessage);
      toast.error(nextMessage);
    },
  });

  const sendApprovedDiscountOrderMutation = useMutation({
    mutationFn: (orderId: string) => {
      if (!session) throw new Error('Sesion requerida.');
      return acceptSalesOrder(session.tenantId, session.accessToken, orderId);
    },
    onSuccess: async (order) => {
      setMessage(`${order.orderNumber} enviado a caja con el descuento aprobado.`);
      setCart([]);
      setInventorySource('SALES_INVENTORY');
      setElectronicInvoiceRequested(false);
      setEcfRecipientEmail('');
      setNotes('');
      setCustomerId('');
      setPriceLevel('REGULAR');
      setCustomDiscountPercent(null);
      setCustomDiscountInput('');
      setCustomDiscountOpen(false);
      setDiscountRequestOrderId(null);
      setPaymentMode(cashierCreditOnly ? 'CREDIT' : 'CASH');
      setInitialPaymentOption('PERCENT_30');
      setCustomInitialPaymentAmount(clearCurrencyInput());
      setCreditTermOption('CUSTOMER_DEFAULT');
      setCustomDueDate('');
      setCreditRequestNote('');
      setClientName('');
      setQuotationDocumentNumber('');
      setCartDrawerOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['order-products-search'] });
      toast.success('Orden enviada a caja', {
        description: `${order.orderNumber} · descuento ${Number(order.discountRate) * 100}%`,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo enviar la orden a caja.');
      setCartDrawerOpen(true);
    },
  });

  const cancelOrderMutation = useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason?: string }) => {
      if (!session) {
        throw new Error('Sesion requerida.');
      }

      return cancelSalesOrder(session.tenantId, session.accessToken, orderId, reason);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['order-products-search'] });
      toast.success('Orden cancelada.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo cancelar la orden.');
    },
  });

  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('Sesión requerida.');
      const snapshot = captureDraftSnapshot();
      const label = clientName.trim() || cart[0]?.product.name || 'Cliente sin especificar';
      if (activeDraftId && activeDraftVersion) {
        return updateOrderTakingDraft(
          session.tenantId, session.accessToken, activeDraftId, activeDraftVersion,
          label, snapshot as unknown as Record<string, unknown>,
        );
      }
      return createOrderTakingDraft(
        session.tenantId, session.accessToken, label,
        snapshot as unknown as Record<string, unknown>,
      );
    },
  });

  const discardDraftMutation = useMutation({
    mutationFn: (draftId: string) => {
      if (!session) throw new Error('Sesión requerida.');
      return discardOrderTakingDraft(session.tenantId, session.accessToken, draftId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['order-taking-drafts'] });
      toast.success('Orden pendiente eliminada.');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'No se pudo eliminar la orden.'),
  });

  if (!session) {
    return <SessionRequired session={session} />;
  }

  if (!canUseOrderTaking) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Toma de ordenes bloqueada</CardTitle>
          <CardDescription>Tu usuario no tiene permiso para crear ordenes.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function addProduct(product: Product) {
    const productSource = product.inventoryDestination;
    if (discountRequestOrderId) {
      toast.error('Espera la aprobación del descuento antes de modificar la orden.');
      return false;
    }
    if (
      (editOrderId && productSource !== effectiveInventorySource) ||
      cart.some((item) => !item.commonProduct && item.product.inventoryDestination !== productSource)
    ) {
      const currentSource = effectiveInventorySource === 'WAREHOUSE' ? 'Almacén B2B' : 'Inventario';
      const error = `Esta orden usa ${currentSource}. Termínala o páusala antes de agregar productos de otro origen.`;
      setMessage(error);
      toast.error(error);
      return false;
    }
    const currentQuantity = quantitiesByProduct[product.id] ?? 0;

    if (!canAddProduct(product, currentQuantity)) {
      setMessage(`No hay stock disponible para ${product.name}.`);
      return false;
    }

    if (productSource !== inventorySource) {
      setInventorySource(productSource);
      setMessage(`Origen de la orden: ${productSource === 'WAREHOUSE' ? 'Almacén B2B' : 'Inventario'}.`);
    } else {
      setMessage(null);
    }
    setCart((current) => {
      const existing = current.find((item) => item.product.id === product.id);

      if (existing) {
        return current.map((item) =>
          item.product.id === product.id
            ? (() => {
                const nextQuantity = item.quantity + getQuantityStep(item.product);
                const cappedQuantity = isStockLimited(item.product)
                  ? Math.min(nextQuantity, getAvailableStock(item.product))
                  : nextQuantity;

                return buildPricedCartItem(
                  item.product,
                  roundQuantity(cappedQuantity),
                  priceLevel,
                  item.reservedQuantity,
                  customDiscountPercent,
                  pricesIncludeTax,
                );
              })()
            : item,
        );
      }

      return [
        ...current,
        buildPricedCartItem(
          product,
          getDefaultQuantity(product),
          priceLevel,
          0,
          customDiscountPercent,
          pricesIncludeTax,
        ),
      ];
    });

    return true;
  }

  function updateQuantity(productId: string, quantity: number) {
    if (quantity <= 0 && activeDraftId && cart.length === 1 && cart[0]?.product.id === productId) {
      void clearCurrentOrder();
      return;
    }
    setCart((current) =>
      current
        .map((item) => {
          if (item.product.id !== productId) {
            return item;
          }

          if (quantity <= 0) {
            return { ...item, quantity: 0 };
          }

          const availableStock = getAvailableStock(item.product);
          const quantityStep = getQuantityStep(item.product);
          const nextQuantity = isStockLimited(item.product)
            ? Math.min(Math.max(quantity, quantityStep), availableStock)
            : Math.max(quantity, quantityStep);

          return {
            ...(item.commonProduct
              ? buildCommonCartItem(
                  item.product.id,
                  {
                    description: item.commonProduct.description,
                    unit: item.commonProduct.unit,
                    unitPrice: item.commonProduct.regularUnitPrice,
                    quantity: roundQuantity(nextQuantity),
                  },
                  priceLevel,
                  customDiscountPercent,
                )
              : buildPricedCartItem(
                  item.product,
                  roundQuantity(nextQuantity),
                  priceLevel,
                  item.reservedQuantity,
                  customDiscountPercent,
                  pricesIncludeTax,
                )),
          };
        })
        .filter((item) => item.quantity > 0),
    );
  }

  function addCommonProduct(draft: CommonProductDraft) {
    const id = `common:${crypto.randomUUID()}`;
    setCart((current) => [
      ...current,
      buildCommonCartItem(
        id,
        draft,
        priceLevel,
        customDiscountPercent,
      ),
    ]);
    setCommonProductOpen(false);
    setMessage(`${draft.description} agregado como producto común.`);
    toast.success('Producto común agregado', {
      description: 'Esta línea existirá solamente en la orden y su factura.',
    });
  }

  function handleCustomerSelection(nextCustomerId: string) {
    const wasSpecialCustomer = Boolean(getSpecialCustomerPriceLevel(customerId));
    const nextPriceLevel = getSpecialCustomerPriceLevel(nextCustomerId);
    const previousCustomer = activeCustomers.find((customer) => customer.id === customerId);
    const clientNameWasAutoFilled =
      specialCustomerLabels.includes(clientName.trim()) ||
      Boolean(previousCustomer && clientName.trim() === previousCustomer.name);

    setCustomerId(nextCustomerId);

    if (nextPriceLevel) {
      setPriceLevel(nextPriceLevel);
      setCustomDiscountPercent(null);
      if (clientNameWasAutoFilled) {
        setClientName('');
      }
      return;
    }

    setPriceLevel('REGULAR');
    setCustomDiscountPercent(null);

    if (!nextCustomerId) {
      if (wasSpecialCustomer) {
        setClientName('');
      }
      return;
    }

    const selectedCustomer = activeCustomers.find((customer) => customer.id === nextCustomerId);
    if (selectedCustomer) {
      setClientName(selectedCustomer.name);
    }
  }

  function handleClientNameChange(nextClientName: string) {
    const registeredCustomerId = getRegisteredCustomerId(customerId);
    const currentCustomer = activeCustomers.find(
      (customer) => customer.id === registeredCustomerId,
    );

    // Al cambiar manualmente el texto, se desasocia el cliente seleccionado
    // para nunca adjudicar una orden a otra persona por coincidencia parcial.
    if (
      currentCustomer &&
      normalizeCustomerSearch(nextClientName) !== normalizeCustomerSearch(currentCustomer.name)
    ) {
      setCustomerId('');
      setPriceLevel('REGULAR');
    }

    setClientName(nextClientName);
  }

  function selectRegisteredCustomer(customer: Customer) {
    handleCustomerSelection(customer.id);
    setCustomerSearchOpen(false);
  }

  function useTemporaryQuotationName() {
    // A quotation can be issued for a one-time customer. Keep only the typed
    // name on the quotation and never create or associate a Customer record.
    setCustomerId('');
    setPriceLevel('REGULAR');
    setCustomerSearchOpen(false);
  }

  function handlePaymentModeChange(nextPaymentMode: SalePaymentMode) {
    setPaymentMode(nextPaymentMode);
    if (nextPaymentMode !== 'CREDIT') {
      return;
    }

    if (!getRegisteredCustomerId(customerId)) {
      setCustomerId('');
      setPriceLevel('REGULAR');
      if (specialCustomerLabels.includes(clientName.trim())) {
        setClientName('');
      }
    }
  }

  function enableScanner() {
    setSearchOpen(false);
    setScannerEnabled(true);
    setScannerMessage('Lector activo. Escanea productos de forma continua; pulsa Desactivar lector al terminar.');
    window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
  }

  function disableScanner() {
    setScannerEnabled(false);
    setScannerMessage(null);
  }

  function captureDraftSnapshot(): OrderDraftSnapshot {
    return {
      cart, destination, inventorySource: effectiveInventorySource, electronicInvoiceRequested, ecfRecipientEmail,
      clientName, quotationDocumentType, quotationDocumentNumber, customerId, priceLevel,
      customDiscountPercent, paymentMode, initialPaymentOption, customInitialPaymentAmount,
      creditTermOption, customDueDate, creditRequestNote, notes,
    };
  }

  function resetForNextCustomer() {
    setCart([]);
    setDestination('CASH_SALE');
    setInventorySource('SALES_INVENTORY');
    setElectronicInvoiceRequested(false);
    setEcfRecipientEmail('');
    setClientName('');
    setQuotationDocumentType('CEDULA');
    setQuotationDocumentNumber('');
    setCustomerId('');
    setPriceLevel('REGULAR');
    setCustomDiscountPercent(null);
    setCustomDiscountInput('');
    setPaymentMode(cashierCreditOnly ? 'CREDIT' : 'CASH');
    setInitialPaymentOption('PERCENT_30');
    setCustomInitialPaymentAmount(clearCurrencyInput());
    setCreditTermOption('CUSTOMER_DEFAULT');
    setCustomDueDate('');
    setCreditRequestNote('');
    setNotes('');
    setSearch('');
    setMessage(null);
    setActiveDraftId(null);
    setActiveDraftVersion(null);
  }

  async function clearCurrentOrder() {
    if (clearInProgressRef.current) return false;
    if (discountRequestOrderId) return false;
    if (!activeDraftId) {
      setCart([]);
      return true;
    }
    clearInProgressRef.current = true;
    try {
      await discardDraftMutation.mutateAsync(activeDraftId);
      resetForNextCustomer();
      setCartDrawerOpen(false);
      return true;
    } catch {
      return false;
    } finally {
      clearInProgressRef.current = false;
    }
  }

  function selectInventorySource(source: InventorySource) {
    if (source === effectiveInventorySource) return;
    if (editOrderId || discountRequestOrderId || hasCatalogProducts) return;
    setInventorySource(source);
    setSearch('');
    setSearchOpen(false);
    setBarcode('');
    setLastScannedProduct(null);
    setScannerMessage(null);
  }

  async function pauseCurrentOrder(nextTab: 'ACTIVE' | 'PENDING' = 'PENDING') {
    if (pauseInProgressRef.current || clearInProgressRef.current) return false;
    if (!cart.length) {
      if (activeDraftId && !(await clearCurrentOrder())) return false;
      setOrderTab(nextTab);
      return true;
    }
    if (editOrderId || discountRequestOrderId) {
      toast.error('Termina la edición o la aprobación antes de pausar esta orden.');
      return false;
    }
    try {
      pauseInProgressRef.current = true;
      await saveDraftMutation.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: ['order-taking-drafts'] });
      resetForNextCustomer();
      setOrderTab(nextTab);
      toast.success('Orden en espera. Puedes atender al siguiente cliente.');
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo pausar la orden.');
      return false;
    } finally {
      pauseInProgressRef.current = false;
    }
  }

  async function resumeDraft(draft: OrderTakingDraft) {
    if (cart.length && !(await pauseCurrentOrder())) return;
    const snapshot = draft.snapshot as OrderDraftSnapshot;
    if (!snapshot || !Array.isArray(snapshot.cart)) {
      toast.error('Esta orden pendiente no tiene datos válidos.');
      return;
    }
    try {
      const refreshedCart = await Promise.all(snapshot.cart.map(async (item) => {
        if (item.commonProduct) {
          return buildCommonCartItem(item.product.id, {
            description: item.commonProduct.description,
            unit: item.commonProduct.unit,
            unitPrice: item.commonProduct.regularUnitPrice,
            quantity: item.quantity,
          }, snapshot.priceLevel, snapshot.customDiscountPercent);
        }
        const product = await getOrderProduct(
          session!.tenantId, session!.accessToken, item.product.id, snapshot.inventorySource,
        );
        return buildPricedCartItem(
          product, item.quantity, snapshot.priceLevel, 0,
          snapshot.customDiscountPercent, pricesIncludeTax,
        );
      }));
      const insufficientStock = refreshedCart.some((item) =>
        !item.commonProduct && isStockLimited(item.product)
          && item.quantity > getAvailableStock(item.product));
      setCart(refreshedCart);
      setDestination(snapshot.destination);
      setInventorySource(snapshot.inventorySource);
      setElectronicInvoiceRequested(snapshot.electronicInvoiceRequested);
      setEcfRecipientEmail(snapshot.ecfRecipientEmail);
      setClientName(snapshot.clientName);
      setQuotationDocumentType(snapshot.quotationDocumentType);
      setQuotationDocumentNumber(snapshot.quotationDocumentNumber);
      setCustomerId(snapshot.customerId);
      setPriceLevel(snapshot.priceLevel);
      setCustomDiscountPercent(snapshot.customDiscountPercent);
      setPaymentMode(snapshot.paymentMode);
      setInitialPaymentOption(snapshot.initialPaymentOption);
      setCustomInitialPaymentAmount(snapshot.customInitialPaymentAmount);
      setCreditTermOption(snapshot.creditTermOption);
      setCustomDueDate(snapshot.customDueDate);
      setCreditRequestNote(snapshot.creditRequestNote);
      setNotes(snapshot.notes);
      setActiveDraftId(draft.id);
      setActiveDraftVersion(draft.version);
      setOrderTab('ACTIVE');
      setMessage(insufficientStock
        ? 'Orden retomada. Revisa las líneas cuya existencia cambió antes de enviarla.'
        : 'Orden retomada. Precios y existencias actualizados.');
      if (insufficientStock) toast.warning('La existencia de uno o más productos cambió. Revisa sus cantidades.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo retomar la orden.');
    }
  }

  return (
    <div
      className="space-y-5 pb-24"
      style={
        {
          '--primary': '217 91% 55%',
          '--ring': '217 91% 55%',
          '--primary-foreground': '0 0% 100%',
          '--success': '142 71% 35%',
          '--warning': '38 92% 45%',
          '--danger': '0 72% 51%',
        } as CSSProperties
      }
    >
      <ModuleHeader
        title="Toma de ordenes"
        description="Escanea o busca, prepara la orden y envíala a caja cuando el cliente esté listo."
      />

      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 pb-3">
      <div role="tablist" aria-label="Órdenes en preparación" className="flex flex-wrap gap-2">
        <button type="button" role="tab" aria-selected={orderTab === 'ACTIVE'}
          className={cn('rounded-lg px-4 py-2.5 text-sm font-semibold transition', orderTab === 'ACTIVE' ? 'bg-zinc-950 text-white' : 'bg-white text-zinc-700 hover:bg-zinc-100')}
          onClick={() => setOrderTab('ACTIVE')}>
          Orden actual {cart.length ? `· ${cart.length}` : ''}
        </button>
        <button type="button" role="tab" aria-selected={orderTab === 'PENDING'}
          className={cn('rounded-lg px-4 py-2.5 text-sm font-semibold transition', orderTab === 'PENDING' ? 'bg-amber-400 text-amber-950' : 'bg-amber-50 text-amber-900 hover:bg-amber-100')}
          onClick={() => void pauseCurrentOrder('PENDING')}>
          En espera · {pendingDrafts.length}
        </button>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {orderTab === 'ACTIVE' ? (
          <div role="group" aria-label="Origen de los productos" className="inline-flex rounded-lg border border-zinc-200 bg-white p-1">
            {([
              ['SALES_INVENTORY', 'Inventario'],
              ['WAREHOUSE', 'Almacén B2B'],
            ] as const).map(([source, label]) => (
              <button key={source} type="button" aria-pressed={effectiveInventorySource === source}
                disabled={Boolean(editOrderId || discountRequestOrderId || (hasCatalogProducts && effectiveInventorySource !== source))}
                title={hasCatalogProducts && effectiveInventorySource !== source ? 'Limpia o pausa esta orden para cambiar de origen' : undefined}
                onClick={() => selectInventorySource(source)}
                className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  effectiveInventorySource === source ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:bg-zinc-100')}
              >{label}</button>
            ))}
          </div>
        ) : null}
        <Button type="button" variant="outline" onClick={() => { setCartDrawerOpen(false); setQuotationsOpen(true); }}>
          <FileText className="h-4 w-4" /> Cotizaciones
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-100 px-1.5 text-xs font-semibold text-zinc-700">
            {quotationsQuery.data?.length ?? 0}
          </span>
        </Button>
        {orderTab === 'ACTIVE' && cart.length && !editOrderId && !discountRequestOrderId ? (
          <Button type="button" variant="outline" className="border-amber-300 text-amber-900 hover:bg-amber-50"
            disabled={saveDraftMutation.isPending || discardDraftMutation.isPending} onClick={() => void pauseCurrentOrder('ACTIVE')}>
            <Pause className="h-4 w-4" /> Pausar y nueva orden
          </Button>
        ) : null}
      </div>
      </div>

      {orderTab === 'PENDING' ? (
        <section className="space-y-3" aria-label="Órdenes en espera">
          {draftsQuery.isLoading ? <p className="text-sm text-zinc-500">Cargando órdenes pendientes...</p> : null}
          {draftsQuery.isError ? <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">No se pudieron cargar las órdenes en espera.</p> : null}
          {!draftsQuery.isLoading && !draftsQuery.isError && !pendingDrafts.length ? (
            <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center text-sm text-amber-900">
              No hay órdenes pausadas. Puedes preparar una en la pestaña Orden actual.
            </div>
          ) : null}
          {pendingDrafts.map((draft) => {
            const saved = draft.snapshot as Partial<OrderDraftSnapshot>;
            const items = Array.isArray(saved?.cart) ? saved.cart : [];
            const amount = items.reduce((sum, item) => sum + Number(item.total ?? 0), 0);
            return (
              <div key={draft.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800"><Pause className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-zinc-950">{draft.label}</p>
                  <p className="text-xs text-zinc-600">{items.length} producto(s) · {formatCurrency(amount)} · Pausada por {draft.createdBy.name}</p>
                </div>
                <Button type="button" onClick={() => void resumeDraft(draft)}><Play className="h-4 w-4" /> Retomar</Button>
                <Button type="button" variant="ghost" className="text-red-600 hover:bg-red-50" disabled={discardDraftMutation.isPending}
                  onClick={() => { if (window.confirm(`¿Eliminar la orden pendiente de ${draft.label}?`)) discardDraftMutation.mutate(draft.id); }}>
                  <Trash2 className="h-4 w-4" /> Eliminar
                </Button>
              </div>
            );
          })}
        </section>
      ) : (
      <section>
        <div className="space-y-4">
          <Card className={cn('relative border-zinc-200 bg-white', searchOpen && 'z-20')}>
            <CardHeader className="border-b border-zinc-100 bg-zinc-50/70 pb-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>Encuentra un producto</CardTitle>
                  <CardDescription>
                    Busca en {effectiveInventorySource === 'WAREHOUSE' ? 'almacén B2B' : 'inventario'} por nombre, SKU o código. Agrégalo con un toque.
                  </CardDescription>
                </div>
                {lastScannedProduct ? (
                  <Badge variant="success">Último escaneo: {lastScannedProduct.name} · {lastScannedProduct.inventoryDestination === 'WAREHOUSE' ? 'Almacén B2B' : 'Inventario'}</Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3 p-3 sm:p-4">
              <div>
                <BarcodeInput
                  barcode={barcode}
                  scannerEnabled={scannerEnabled}
                  scannerMessage={scannerMessage}
                  barcodeInputRef={barcodeInputRef}
                  isPending={barcodeMutation.isPending}
                  keepFocus
                  showCamera={false}
                  onBarcodeChange={setBarcode}
                  onSubmit={(code) => barcodeMutation.mutate(code)}
                  onEnableScanner={enableScanner}
                  onDisableScanner={disableScanner}
                />
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-600" />
                <Input value={search} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setSearchOpen(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setSearchOpen(false);
                    if (event.key === 'Enter' && debouncedSearch === search.trim() && visibleProducts[0]) {
                      event.preventDefault();
                      const firstAvailable = visibleProducts.find((product) =>
                        canAddProduct(product, quantitiesByProduct[product.id] ?? 0));
                      if (firstAvailable && addProduct(firstAvailable)) { setSearch(''); setSearchOpen(false); }
                    }
                  }}
                  role="combobox" aria-autocomplete="list" aria-expanded={searchOpen && search.trim().length >= 2}
                  aria-controls="order-product-results" autoComplete="off"
                  className="h-14 rounded-xl border-blue-200 bg-white pl-12 pr-4 text-base shadow-sm focus-visible:ring-blue-500"
                  placeholder={`Busca en ${effectiveInventorySource === 'WAREHOUSE' ? 'almacén B2B' : 'inventario'} por nombre, SKU o código`} />
                {searchOpen && search.trim().length >= 2 ? (
                  <div id="order-product-results" role="listbox" className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(60vh,32rem)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl">
                    {productsQuery.isLoading || debouncedSearch !== search.trim() ? (
                      <p className="px-4 py-5 text-sm text-zinc-500">Buscando productos...</p>
                    ) : productsQuery.isError ? (
                      <p className="px-4 py-5 text-sm text-red-600">No se pudo buscar en el catálogo. Intenta de nuevo.</p>
                    ) : visibleProducts.length ? visibleProducts.map((product) => {
                      const unitTotal = calculateSaleAmounts(getProductPrice(product), 1, Number(product.taxRate), getPriceLevelDiscountRate(priceLevel, customDiscountPercent), pricesIncludeTax).total;
                      return (
                        <button key={product.id} type="button" role="option" aria-selected={false}
                          disabled={!canAddProduct(product, quantitiesByProduct[product.id] ?? 0)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => { if (addProduct(product)) { setSearch(''); setSearchOpen(false); } }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-blue-50 focus-visible:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50">
                          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-100">
                            {product.imageUrl ? <img src={product.imageUrl} alt="" className="h-full w-full object-cover" /> : <PackagePlus className="h-5 w-5 text-zinc-400" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold leading-snug text-zinc-950">
                              <span>{product.name}</span>
                              <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', product.inventoryDestination === 'WAREHOUSE' ? 'bg-amber-100 text-amber-900' : 'bg-blue-100 text-blue-800')}>
                                {product.inventoryDestination === 'WAREHOUSE' ? 'Almacén B2B' : 'Inventario'}
                              </span>
                            </span>
                            <span className="block text-xs text-zinc-500">{[product.sku || product.barcode, product.category?.name].filter(Boolean).join(' · ')}</span>
                            <span className="block text-xs text-zinc-500">Existencia: {isStockLimited(product) ? getAvailableStock(product) : 'Sin control'}</span>
                          </span>
                          <strong className="shrink-0 text-sm text-blue-700">{formatCurrency(unitTotal)}</strong>
                        </button>
                      );
                    }) : <p className="px-4 py-5 text-sm text-zinc-500">No encontramos productos con esa búsqueda.</p>}
                    {(productsQuery.data?.length ?? 0) > visibleProducts.length ? (
                      <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
                        Mostrando {visibleProducts.length} de {productsQuery.data?.length} coincidencias. Escribe más para afinar la búsqueda.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

        </div>

        <Card className="mt-4 min-w-0 border-zinc-200 bg-white">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100">
              <div><CardTitle>Orden actual</CardTitle><CardDescription>{cart.length} producto(s) · en orden de incorporación</CardDescription></div>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="mr-1 text-lg text-blue-700">{formatCurrency(totals.total)}</strong>
                <Button
                  type="button"
                  variant="outline"
                  className="border-dashed"
                  onClick={() => setCommonProductOpen(true)}
                  disabled={Boolean(discountRequestOrderId)}
                >
                  <PackagePlus className="h-4 w-4" /> Producto común
                </Button>
                <Button type="button" onClick={() => setCartDrawerOpen(true)}>
                  <Send className="h-4 w-4" /> Revisar y enviar
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 p-3 sm:p-4">
              <QuickOrderLines items={cart} disabled={Boolean(discountRequestOrderId)} onUpdateQuantity={updateQuantity} />
              {cart.length && !discountRequestOrderId ? <Button type="button" variant="ghost" size="sm" className="text-red-600" disabled={discardDraftMutation.isPending} onClick={() => void clearCurrentOrder()}>Limpiar productos</Button> : null}
            </CardContent>
        </Card>
        <CartSummaryBar itemCount={cart.length} total={totals.total} onOpen={() => setCartDrawerOpen(true)} />
        <OrderCheckoutDialog
          open={cartDrawerOpen}
          itemCount={cart.length}
          total={totals.total}
          onClose={() => setCartDrawerOpen(false)}
          onClear={() => void clearCurrentOrder()}
          clearDisabled={Boolean(discountRequestOrderId || discardDraftMutation.isPending)}
          footer={
            <Button
              type="submit"
              form="order-checkout-form"
              className="h-12 w-full text-base font-bold"
              disabled={
                !cart.length ||
                createOrderMutation.isPending ||
                sendApprovedDiscountOrderMutation.isPending ||
                (Boolean(discountRequestOrderId) && discountApprovalStatus !== 'APPROVED')
              }
            >
              {discountRequestOrderId ? (
                discountApprovalStatus === 'APPROVED' ? (
                  <><Send className="h-5 w-5" />{sendApprovedDiscountOrderMutation.isPending ? 'Enviando a caja...' : 'Enviar a caja'}</>
                ) : (
                  <><FileText className="h-5 w-5" />{discountApprovalStatus === 'REJECTED' ? 'Descuento rechazado' : 'Aprobación pendiente'}</>
                )
              ) : editOrderId ? (
                <><FileText className="h-5 w-5" />Actualizar cotización</>
              ) : destination === 'QUOTATION' ? (
                <><FileText className="h-5 w-5" />Guardar cotización</>
              ) : paymentMode === 'CREDIT' ? (
                <><CreditCard className="h-5 w-5" />Solicitar aprobación de crédito</>
              ) : (
                <><Send className="h-5 w-5" />Enviar a caja</>
              )}
            </Button>
          }
        >
          <Card className="border-zinc-200 bg-white">
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>
                    {editOrderId
                      ? 'Modificar cotizacion'
                      : destination === 'QUOTATION'
                        ? 'Registrar cotizacion'
                        : paymentMode === 'CREDIT'
                          ? 'Solicitar venta fiada'
                          : 'Enviar a caja'}
                  </CardTitle>
                  <CardDescription>
                    {editOrderId
                      ? 'Actualiza los productos o datos de la cotización existente.'
                      : destination === 'QUOTATION'
                        ? 'Genera una cotizacion sin enviarla a caja ni emitir factura.'
                        : paymentMode === 'CREDIT'
                          ? 'La solicitud se enviará al administrador; el inventario se reservará al aprobar.'
                          : 'Esto crea una preventa/ticket pendiente para caja. No emite factura fiscal.'}
                  </CardDescription>
                </div>
                {editOrderId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:bg-danger/5 hover:text-danger"
                    onClick={() => {
                      setCart([]);
                      setElectronicInvoiceRequested(false);
                      setNotes('');
                      setCustomerId('');
                      setPriceLevel('REGULAR');
                      setCustomDiscountPercent(null);
                      setCustomDiscountInput('');
                      setPaymentMode(cashierCreditOnly ? 'CREDIT' : 'CASH');
                      setInitialPaymentOption('PERCENT_30');
                      setCustomInitialPaymentAmount(clearCurrencyInput());
                      setCreditTermOption('CUSTOMER_DEFAULT');
                      setCustomDueDate('');
                      setCreditRequestNote('');
                      setClientName('');
                      setQuotationDocumentNumber('');
                      setCartDrawerOpen(false);
                      setLoadedEditOrderId(null);
                      loadedEditOrderRef.current = editOrderId;
                      editToastShownRef.current = null;
                      router.replace('/orders');
                    }}
                  >
                    Cancelar edicion
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <form
                id="order-checkout-form"
                className="space-y-4 [&_input]:min-h-11 [&_select]:h-11"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (discountRequestOrderId) {
                    if (discountApprovalStatus === 'APPROVED') {
                      sendApprovedDiscountOrderMutation.mutate(discountRequestOrderId);
                    }
                    return;
                  }
                  createOrderMutation.mutate(undefined);
                }}
              >
                <div className="space-y-2">
                  <Label>Destino de la orden</Label>
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-200 bg-white p-1">
                    <button
                      type="button"
                      className={`min-h-11 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        destination === 'CASH_SALE'
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-zinc-600 hover:bg-zinc-50'
                      }`}
                      onClick={() => setDestination('CASH_SALE')}
                    >
                      Venta de caja
                    </button>
                    <button
                      type="button"
                      className={`min-h-11 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        destination === 'QUOTATION'
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-zinc-600 hover:bg-zinc-50'
                      }`}
                      onClick={() => setDestination('QUOTATION')}
                    >
                      Cotizacion
                    </button>
                  </div>
                </div>

                {destination === 'CASH_SALE' ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="orderReceiptType">Comprobante</Label>
                      <select
                        id="orderReceiptType"
                        value={electronicInvoiceRequested ? 'ECF' : 'FINAL'}
                        onChange={(event) => {
                          const wantsElectronicInvoice = event.target.value === 'ECF';
                          setElectronicInvoiceRequested(wantsElectronicInvoice);
                          if (!wantsElectronicInvoice) setEcfRecipientEmail('');
                        }}
                        className="h-11 w-full rounded-md border border-input bg-white px-3 text-sm"
                      >
                        <option value="FINAL">Facturación local (NCF)</option>
                        <option value="ECF">Factura electrónica (e-CF)</option>
                      </select>
                    </div>
                    {electronicInvoiceRequested ? (
                      <div className="space-y-2 rounded-md border border-zinc-200 bg-white p-3">
                        <Label htmlFor="ecfRecipientEmail">
                          Correo del cliente para la copia e-CF
                        </Label>
                        <Input
                          id="ecfRecipientEmail"
                          type="email"
                          value={ecfRecipientEmail}
                          onChange={(event) => setEcfRecipientEmail(event.target.value)}
                          placeholder="cliente@correo.com"
                          maxLength={320}
                        />
                        <p className="text-xs text-muted-foreground">
                          Opcional. Si lo indicas, se enviará una copia individual a este correo;
                          facturacion@corestack-systems.com también recibirá la factura.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="orderPaymentMode">Modalidad de pago</Label>
                  <select
                    id="orderPaymentMode"
                    value={paymentMode}
                    disabled={Boolean(editOrderId) || cashierCreditOnly}
                    onChange={(event) =>
                      handlePaymentModeChange(event.target.value as SalePaymentMode)
                    }
                    className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm disabled:bg-zinc-100"
                  >
                    {!cashierCreditOnly ? <option value="CASH">Contado</option> : null}
                    <option value="CREDIT">Fiado / crédito</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {cashierCreditOnly
                      ? 'Como cajero puedes crear solicitudes fiadas; el administrador deberá aprobarlas.'
                      : 'La modalidad se fija al crear la orden y no se podrá cambiar al llegar a caja.'}
                  </p>
                </div>

                {destination === 'QUOTATION' ? (
                  <div className="space-y-1 border-l-2 border-primary pl-3">
                    <p className="text-sm font-semibold text-foreground">Datos de cotización</p>
                    <p className="text-xs text-muted-foreground">
                      El nombre del cliente, la cédula y el RNC son opcionales.
                    </p>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="orderClientName">
                    Nombre del cliente <span className="text-muted-foreground">(opcional)</span>
                  </Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="orderClientName"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="orderCustomerSearchResults"
                      aria-expanded={customerSearchOpen}
                      value={clientName}
                      onFocus={() => setCustomerSearchOpen(true)}
                      onBlur={() => window.setTimeout(() => setCustomerSearchOpen(false), 150)}
                      onChange={(event) => {
                        handleClientNameChange(event.target.value);
                        setCustomerSearchOpen(true);
                      }}
                      placeholder="Busca por nombre, cedula, telefono o correo"
                      className="bg-white pl-9"
                      autoComplete="off"
                    />
                    {customerSearchOpen ? (
                      <div
                        id="orderCustomerSearchResults"
                        role="listbox"
                        className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
                      >
                        <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                          {normalizedCustomerSearch
                            ? 'Clientes registrados coincidentes'
                            : 'Clientes con saldo pendiente'}
                        </div>
                        {destination === 'QUOTATION' && clientName.trim() ? (
                          paymentMode === 'CASH' ? (
                            <button
                              type="button"
                              role="option"
                              className="mb-1 flex w-full flex-col rounded-md border border-primary/25 bg-primary/[0.045] px-3 py-2.5 text-left transition-colors hover:bg-primary/[0.09] focus-visible:bg-primary/[0.09]"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={useTemporaryQuotationName}
                            >
                              <span className="text-sm font-semibold text-foreground">
                                Usar “{clientName.trim()}” solo para esta cotización
                              </span>
                              <span className="mt-0.5 text-xs text-muted-foreground">
                                No se creará ni se vinculará un cliente registrado.
                              </span>
                            </button>
                          ) : (
                            <p className="mb-1 rounded-md border border-warning/25 bg-warning/[0.05] px-3 py-2 text-xs text-muted-foreground">
                              Las cotizaciones fiadas requieren un cliente registrado con crédito
                              habilitado.
                            </p>
                          )
                        ) : null}
                        {customerSearchResults.length ? (
                          customerSearchResults.map((customer) => {
                            const balance = Number(customer.creditBalance ?? 0);
                            const creditUnavailable =
                              paymentMode === 'CREDIT' &&
                              (!customer.creditEnabled || customer.creditStatus !== 'ACTIVE');

                            return (
                              <button
                                key={customer.id}
                                type="button"
                                role="option"
                                aria-selected={customer.id === selectedCustomer?.id}
                                disabled={creditUnavailable}
                                className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => selectRegisteredCustomer(customer)}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">
                                    {customer.name}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {[customer.documentNumber, customer.phone, customer.email]
                                      .filter(Boolean)
                                      .join(' · ') || 'Sin documento ni contacto'}
                                  </span>
                                </span>
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full px-2 py-1 text-xs font-semibold',
                                    balance > 0
                                      ? 'bg-danger/10 text-danger'
                                      : 'bg-success/10 text-success',
                                  )}
                                >
                                  {balance > 0 ? `Debe ${formatCurrency(balance)}` : 'Al dia'}
                                </span>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-3 py-3 text-sm text-muted-foreground">
                            {normalizedCustomerSearch
                              ? 'No encontramos clientes registrados con esa busqueda.'
                              : 'No hay clientes con saldo pendiente.'}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {destination === 'QUOTATION'
                      ? 'Puedes usar un cliente registrado o un nombre temporal. El nombre temporal queda solo en esta cotización.'
                      : 'Busca y selecciona un cliente para consultar su saldo. Para contado tambien puedes escribir un cliente no registrado.'}
                  </p>
                  {selectedCustomer ? (
                    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{selectedCustomer.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {selectedCustomer.documentNumber ?? 'Sin documento'}
                          {selectedCustomer.creditEnabled
                            ? ` · Limite ${formatCurrency(Number(selectedCustomer.creditLimit ?? 0))}`
                            : ' · Credito no habilitado'}
                        </p>
                      </div>
                      <div className="text-left sm:text-right">
                        <p className="text-xs text-muted-foreground">Saldo pendiente</p>
                        <p
                          className={cn(
                            'text-sm font-bold',
                            Number(selectedCustomer.creditBalance ?? 0) > 0
                              ? 'text-danger'
                              : 'text-success',
                          )}
                        >
                          {formatCurrency(Number(selectedCustomer.creditBalance ?? 0))}
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>

                {destination === 'QUOTATION' ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="quotationDocumentNumber">Cédula o RNC (opcional)</Label>
                      <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-2">
                        <select
                          id="quotationDocumentType"
                          aria-label="Tipo de documento"
                          value={quotationDocumentType}
                          onChange={(event) =>
                            setQuotationDocumentType(event.target.value as 'RNC' | 'CEDULA')
                          }
                          className="h-10 rounded-md border border-input bg-white px-3 text-sm"
                        >
                          <option value="CEDULA">Cédula</option>
                          <option value="RNC">RNC</option>
                        </select>
                        <Input
                          id="quotationDocumentNumber"
                          value={quotationDocumentNumber}
                          onChange={(event) => setQuotationDocumentNumber(event.target.value)}
                          placeholder={
                            quotationDocumentType === 'RNC' ? '123456789' : '00123456789'
                          }
                          inputMode="numeric"
                        />
                      </div>
                      {quotationDocumentNumber ? (
                        <p
                          className={
                            (
                              quotationDocumentType === 'RNC'
                                ? validateDominicanRnc(quotationDocumentNumber)
                                : validateDominicanCedula(quotationDocumentNumber)
                            )
                              ? 'text-xs text-success'
                              : 'text-xs text-danger'
                          }
                        >
                          {(
                            quotationDocumentType === 'RNC'
                              ? validateDominicanRnc(quotationDocumentNumber)
                              : validateDominicanCedula(quotationDocumentNumber)
                          )
                            ? 'Documento válido.'
                            : 'Verifica el dígito verificador dominicano.'}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Puedes dejarlo vacío. Si lo indicas, validaremos la cédula o el RNC antes
                          de guardar.
                        </p>
                      )}
                    </div>
                  </>
                ) : null}

                <div className="hidden">
                  <Label htmlFor="orderCustomer">
                    Cliente registrado
                    {paymentMode === 'CREDIT' ? (
                      <span className="text-danger"> *</span>
                    ) : (
                      ' (opcional)'
                    )}
                  </Label>
                  <select
                    id="orderCustomer"
                    value={customerId}
                    onChange={(event) => handleCustomerSelection(event.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                  >
                    <option value="">
                      {paymentMode === 'CREDIT' ? 'Selecciona un cliente' : 'Consumidor final'}
                    </option>
                    {paymentMode === 'CASH' ? (
                      <>
                        <option value={finalDiscountCustomerId}>
                          Consumidor Final (Descuento al por mayor 5%)
                        </option>
                        <option value={finalPreferredCustomerId}>
                          Consumidor Final (Descuento al por mayor 10%)
                        </option>
                      </>
                    ) : null}
                    {activeCustomers.map((customer) => (
                      <option
                        key={customer.id}
                        value={customer.id}
                        disabled={
                          paymentMode === 'CREDIT' &&
                          (!customer.creditEnabled || customer.creditStatus !== 'ACTIVE')
                        }
                      >
                        {customer.name}
                        {paymentMode === 'CREDIT' && !customer.creditEnabled
                          ? ' — crédito no habilitado'
                          : paymentMode === 'CREDIT' && customer.creditStatus !== 'ACTIVE'
                            ? ' — crédito bloqueado'
                            : ''}
                      </option>
                    ))}
                  </select>
                  {priceLevel !== 'REGULAR' || customDiscountPercent !== null ? (
                    <p className="text-xs font-medium text-emerald-700">
                      Se aplicará un descuento de{' '}
                      {getPriceLevelDiscountRate(priceLevel, customDiscountPercent) * 100}% al{' '}
                      {session?.tenantSlug === 'allpa' ? 'precio final de los productos' : 'subtotal de los productos'} de esta orden.
                    </p>
                  ) : null}
                </div>

                {paymentMode === 'CASH' ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Accesos rapidos para consumidor final
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={customerId === finalDiscountCustomerId ? 'default' : 'outline'}
                        disabled={Boolean(discountRequestOrderId)}
                        onClick={() =>
                          handleCustomerSelection(
                            customerId === finalDiscountCustomerId ? '' : finalDiscountCustomerId,
                          )
                        }
                      >
                        Descuento al por mayor 5%
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={customerId === finalPreferredCustomerId ? 'default' : 'outline'}
                        disabled={Boolean(discountRequestOrderId)}
                        onClick={() =>
                          handleCustomerSelection(
                            customerId === finalPreferredCustomerId ? '' : finalPreferredCustomerId,
                          )
                        }
                      >
                        Descuento al por mayor 10%
                      </Button>
                      {session?.role === 'ORDER_TAKER' || isAdminSession(session) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant={customDiscountPercent !== null ? 'default' : 'outline'}
                          disabled={
                            discountApprovalStatus === 'PENDING' ||
                            discountApprovalStatus === 'APPROVED'
                          }
                          onClick={() => {
                            setCartDrawerOpen(true);
                            setCustomDiscountInput(
                              customDiscountPercent === null ? '' : String(customDiscountPercent),
                            );
                            setCustomDiscountOpen(true);
                          }}
                        >
                          <FileText className="h-4 w-4" />
                          {session?.role === 'ORDER_TAKER'
                            ? 'Solicitar descuento personalizado'
                            : 'Descuento personalizado'}
                        </Button>
                      ) : null}
                    </div>
                    {discountApproval ? (
                      <div
                        className={cn(
                          'rounded-md border px-3 py-2 text-sm',
                          discountApproval.status === 'APPROVED'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                            : discountApproval.status === 'REJECTED'
                              ? 'border-red-200 bg-red-50 text-red-950'
                              : 'border-amber-200 bg-amber-50 text-amber-950',
                        )}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            Descuento personalizado{' '}
                            {Number(discountApproval.requestedRate) * 100}%
                          </span>
                          <Badge
                            variant={
                              discountApproval.status === 'APPROVED'
                                ? 'success'
                                : discountApproval.status === 'REJECTED'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {discountApproval.status === 'APPROVED'
                              ? 'Aprobado'
                              : discountApproval.status === 'REJECTED'
                                ? 'Rechazado'
                                : 'Pendiente'}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs">
                          {discountApproval.status === 'APPROVED'
                            ? 'Revisa la orden y pulsa Enviar a caja cuando estés listo.'
                            : discountApproval.status === 'REJECTED'
                              ? discountApproval.decisionNote ||
                                'El administrador rechazó este descuento.'
                              : 'Esperando la decisión de un administrador. El carrito permanece abierto.'}
                        </p>
                        {discountApproval.status === 'REJECTED' ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-2"
                            onClick={() => {
                              setDiscountRequestOrderId(null);
                              setCustomDiscountPercent(null);
                              setCustomDiscountInput('');
                              setMessage('Puedes ajustar la orden y solicitar otro descuento.');
                            }}
                          >
                            Preparar otra solicitud
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {priceLevel !== 'REGULAR' || customDiscountPercent !== null ? (
                  <p className="text-xs font-medium text-emerald-700">
                    Se aplicara un descuento de{' '}
                    {getPriceLevelDiscountRate(priceLevel, customDiscountPercent) * 100}% a los
                    productos de esta orden.
                  </p>
                ) : null}

                {paymentMode === 'CREDIT' ? (
                  <div className="space-y-4 rounded-md border border-sky-200 bg-sky-50/60 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-sky-950">
                      <CreditCard className="h-4 w-4" />
                      Condiciones de la venta fiada
                    </div>
                    {selectedCustomer ? (
                      <div className="grid gap-2 text-xs sm:grid-cols-3">
                        <div className="rounded-md bg-white p-2">
                          <span className="text-muted-foreground">Balance</span>
                          <p className="font-semibold">
                            {formatCurrency(Number(selectedCustomer.creditBalance ?? 0))}
                          </p>
                        </div>
                        <div className="rounded-md bg-white p-2">
                          <span className="text-muted-foreground">Límite</span>
                          <p className="font-semibold">
                            {formatCurrency(Number(selectedCustomer.creditLimit ?? 0))}
                          </p>
                        </div>
                        <div className="rounded-md bg-white p-2">
                          <span className="text-muted-foreground">Plazo recomendado</span>
                          <p className="font-semibold">{selectedCustomer.creditTermDays} días</p>
                        </div>
                      </div>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="initialPaymentOption">Pago inicial</Label>
                        <select
                          id="initialPaymentOption"
                          value={initialPaymentOption}
                          disabled={Boolean(editOrderId)}
                          onChange={(event) =>
                            setInitialPaymentOption(event.target.value as InitialPaymentOption)
                          }
                          className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm disabled:bg-zinc-100"
                        >
                          <option value="NONE">Sin pago inicial</option>
                          <option value="PERCENT_30">30 %</option>
                          <option value="PERCENT_50">50 %</option>
                          <option value="PERCENT_70">70 %</option>
                          <option value="CUSTOM">Monto personalizado</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="creditTermOption">Vencimiento</Label>
                        <select
                          id="creditTermOption"
                          value={creditTermOption}
                          disabled={Boolean(editOrderId)}
                          onChange={(event) =>
                            setCreditTermOption(event.target.value as CreditTermOption)
                          }
                          className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm disabled:bg-zinc-100"
                        >
                          <option value="CUSTOMER_DEFAULT">
                            Plazo del cliente
                            {selectedCustomer ? ` (${selectedCustomer.creditTermDays} días)` : ''}
                          </option>
                          <option value="DAYS_15">15 días</option>
                          <option value="DAYS_30">30 días</option>
                          <option value="DAYS_45">45 días</option>
                          <option value="CUSTOM_DATE">Fecha personalizada</option>
                        </select>
                      </div>
                    </div>
                    {initialPaymentOption === 'CUSTOM' ? (
                      <div className="space-y-2">
                        <Label htmlFor="customInitialPaymentAmount">Monto del pago inicial</Label>
                        <Input
                          id="customInitialPaymentAmount"
                          inputMode="decimal"
                          value={customInitialPaymentAmount}
                          disabled={Boolean(editOrderId)}
                          onChange={(event) =>
                            setCustomInitialPaymentAmount(sanitizeCurrencyInput(event.target.value))
                          }
                          onBlur={(event) =>
                            setCustomInitialPaymentAmount(formatCurrencyInput(event.target.value))
                          }
                          required
                        />
                        <p className="text-xs text-muted-foreground">
                          Debe ser mayor que cero y no puede superar el total de la orden.
                        </p>
                      </div>
                    ) : null}
                    {creditTermOption === 'CUSTOM_DATE' ? (
                      <div className="space-y-2">
                        <Label htmlFor="customDueDate">Fecha de vencimiento</Label>
                        <Input
                          id="customDueDate"
                          type="date"
                          min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                          value={customDueDate}
                          disabled={Boolean(editOrderId)}
                          onChange={(event) => setCustomDueDate(event.target.value)}
                          required
                        />
                      </div>
                    ) : null}
                    <div className="grid gap-2 rounded-md bg-white p-3 text-sm">
                      <div className="flex justify-between">
                        <span>Pago inicial</span>
                        <strong>{formatCurrency(initialPaymentAmount)}</strong>
                      </div>
                      <div className="flex justify-between">
                        <span>Saldo a financiar</span>
                        <strong>{formatCurrency(financedAmount)}</strong>
                      </div>
                      <div className="flex justify-between border-t pt-2">
                        <span>Balance proyectado del cliente</span>
                        <strong className={exceedsCreditLimit ? 'text-danger' : ''}>
                          {formatCurrency(projectedCustomerBalance)}
                        </strong>
                      </div>
                    </div>
                    {exceedsCreditLimit ? (
                      <p className="rounded-md bg-amber-100 px-3 py-2 text-xs font-medium text-amber-900">
                        Supera el límite de crédito. El administrador deberá autorizar
                        explícitamente el exceso y dejar una nota.
                      </p>
                    ) : null}
                    <div className="space-y-2">
                      <Label htmlFor="creditRequestNote">Nota para aprobación (opcional)</Label>
                      <textarea
                        id="creditRequestNote"
                        value={creditRequestNote}
                        onChange={(event) => setCreditRequestNote(event.target.value)}
                        className="min-h-16 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"
                        maxLength={500}
                        placeholder="Contexto para el administrador"
                      />
                    </div>
                  </div>
                ) : null}

                {paymentMode === 'CREDIT' || notes ? (
                  <div className="space-y-2">
                    <Label htmlFor="orderNotes">Notas</Label>
                    <textarea
                      id="orderNotes"
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      className="min-h-20 w-full rounded-md border border-input bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      maxLength={500}
                      placeholder="Referencia del cliente o comentario interno"
                    />
                  </div>
                ) : null}

                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
                  {session?.tenantSlug === 'allpa' && totals.discount > 0 ? (
                    <>
                      <div className="flex justify-between">
                        <span>Precio antes de descuento (con ITBIS)</span>
                        <strong>{formatCurrency(totals.total + totals.discount)}</strong>
                      </div>
                      <div className="mt-2 flex justify-between text-emerald-700">
                        <span>Descuento sobre precio final</span>
                        <strong>-{formatCurrency(totals.discount)}</strong>
                      </div>
                    </>
                  ) : null}
                  <div className="mt-2 flex justify-between">
                    <span>{session?.tenantSlug === 'allpa' ? 'Subtotal sin ITBIS' : 'Subtotal'}</span>
                    <strong>{formatCurrency(totals.subtotal)}</strong>
                  </div>
                  {session?.tenantSlug !== 'allpa' && totals.discount > 0 ? (
                    <div className="mt-2 flex justify-between text-emerald-700">
                      <span>Descuento</span>
                      <strong>-{formatCurrency(totals.discount)}</strong>
                    </div>
                  ) : null}
                  <div className="mt-2 flex justify-between">
                    <span>ITBIS</span>
                    <strong>{formatCurrency(totals.tax)}</strong>
                  </div>
                  <div className="mt-3 flex justify-between border-t border-zinc-200 pt-3 text-base">
                    <span>Total</span>
                    <strong>{formatCurrency(totals.total)}</strong>
                  </div>
                </div>

                {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}

              </form>
            </CardContent>
          </Card>
        </OrderCheckoutDialog>
        <CommonProductDialog
          open={commonProductOpen}
          onClose={() => setCommonProductOpen(false)}
          onAdd={addCommonProduct}
        />
        <CustomDiscountDialog
          open={customDiscountOpen}
          isAllpa={session?.tenantSlug === 'allpa'}
          mode={session?.role === 'ORDER_TAKER' ? 'REQUEST' : 'APPLY'}
          value={customDiscountInput}
          busy={createOrderMutation.isPending}
          onChange={setCustomDiscountInput}
          onClose={() => {
            setCustomDiscountOpen(false);
            setCartDrawerOpen(true);
          }}
          onConfirm={(percent) => {
            if (session?.role === 'ORDER_TAKER') {
              createOrderMutation.mutate({ percent, requestApproval: true });
              return;
            }
            setCustomerId('');
            setPriceLevel('REGULAR');
            setCustomDiscountPercent(percent);
            setCustomDiscountOpen(false);
            setCartDrawerOpen(true);
            toast.success(`Descuento personalizado de ${percent}% aplicado a la orden.`);
          }}
        />
      </section>
      )}

      <OrderActivityDrawer
        open={quotationsOpen}
        title="Cotizaciones"
        description="Cotizaciones registradas sin cobro. Puedes imprimirlas o cancelarlas si aplica."
        onClose={() => setQuotationsOpen(false)}
      >
        <QuotationsPanel
          orders={quotationsQuery.data ?? []}
          loading={quotationsQuery.isLoading}
          showManagement={Boolean(isAdminSession(session) || canTakeOrders(session))}
          cancellingId={cancelOrderMutation.variables?.orderId}
          embedded
          onCancel={(order) => {
            setQuotationsOpen(false);
            setCancelTargetId(order.id);
            setCancelTargetLabel(order.orderNumber);
            setCancelReason('');
            setCancelModalOpen(true);
          }}
        />
      </OrderActivityDrawer>

      <CancelReasonModal
        open={cancelModalOpen}
        title="Cancelar cotización"
        description={
          cancelTargetLabel
            ? `Indica por que se cancela ${cancelTargetLabel}.`
            : 'Indica por que se cancela esta cotización.'
        }
        reason={cancelReason}
        isPending={cancelOrderMutation.isPending}
        onReasonChange={setCancelReason}
        onClose={() => {
          setCancelModalOpen(false);
          setCancelTargetId(null);
          setCancelTargetLabel('');
          setCancelReason('');
        }}
        onConfirm={() => {
          const trimmedReason = cancelReason.trim();
          if (!trimmedReason) {
            toast.error('El motivo de cancelacion es requerido.');
            return;
          }
          if (cancelTargetId) {
            cancelOrderMutation.mutate({ orderId: cancelTargetId, reason: trimmedReason });
          }
          setCancelModalOpen(false);
          setCancelTargetId(null);
          setCancelTargetLabel('');
          setCancelReason('');
        }}
      />
    </div>
  );
}
function CustomDiscountDialog({
  open,
  isAllpa,
  mode,
  value,
  busy,
  onChange,
  onClose,
  onConfirm,
}: {
  open: boolean;
  isAllpa: boolean;
  mode: 'REQUEST' | 'APPLY';
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: (percent: number) => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted || !open) return null;

  const percent = Number(value);
  const valid = Number.isFinite(percent) && percent > 0 && percent <= 100;

  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-200 p-5">
          <div>
            <h2 className="text-lg font-bold">
              {mode === 'REQUEST' ? 'Solicitar descuento personalizado' : 'Descuento personalizado'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Digita el porcentaje que se aplicará al {isAllpa ? 'precio final' : 'subtotal'} de los productos.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <Label htmlFor="customDiscountPercent">Porcentaje de descuento</Label>
            <div className="relative">
              <Input
                id="customDiscountPercent"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                inputMode="decimal"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                autoFocus
                className="pr-10"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
          </div>
          {mode === 'REQUEST' ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              La orden quedará pendiente hasta que un administrador apruebe o rechace el descuento.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="button" disabled={!valid || busy} onClick={() => onConfirm(percent)}>
              {mode === 'REQUEST' ? 'Solicitar' : 'Aplicar descuento'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function QuotationsPanel({
  orders,
  loading,
  showManagement,
  cancellingId,
  embedded = false,
  onCancel,
}: {
  orders: SalesOrder[];
  loading: boolean;
  showManagement: boolean;
  cancellingId?: string;
  embedded?: boolean;
  onCancel: (order: SalesOrder) => void;
}) {
  if (!showManagement) {
    return null;
  }

  return (
    <Card className={cn(embedded && 'border-0 bg-transparent shadow-none')}>
      {!embedded ? (
        <CardHeader>
          <CardTitle>Cotizaciones</CardTitle>
          <CardDescription>
            Cotizaciones registradas sin cobro. Puedes imprimirlas o cancelarlas si aplica.
          </CardDescription>
        </CardHeader>
      ) : null}
      <CardContent className={cn('space-y-2', embedded && 'p-0')}>
        {loading ? (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-muted-foreground">
            Cargando cotizaciones...
          </p>
        ) : orders.length ? (
          orders.map((order) => (
            <div key={order.id} className="rounded-md border border-zinc-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-zinc-950">{getOrderSearchLabel(order)}</p>
                    <Badge variant={getStatusVariant(order.status)}>
                      {translateStatus(order.status)}
                    </Badge>
                    {order.paymentMode === 'CREDIT' ? (
                      <Badge variant="outline">Cotización fiada</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Cliente: {getOrderClientLabel(order)}
                  </p>
                  {order.quotationDocumentType && order.quotationDocumentNumber ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {order.quotationDocumentType}: {order.quotationDocumentNumber}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Creada por {order.createdBy.name} - {formatDate(order.createdAt)}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-bold">{formatCurrency(Number(order.total))}</p>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{order.items.length} producto(s)</p>
                <div className="flex items-center gap-2">
                  <Button asChild type="button" variant="outline" size="sm">
                    <Link href={`/orders/${order.id}/print`}>Ver / imprimir</Link>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onCancel(order)}
                    disabled={cancellingId === order.id}
                  >
                    <X className="h-4 w-4" />
                    Cancelar
                  </Button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center">
            <FileText className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">No hay cotizaciones registradas.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
