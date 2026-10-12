import type { Product } from '@/lib/api';

export type CartItem = {
  product: Product;
  commonProduct?: {
    description: string;
    unit: string;
    regularUnitPrice: number;
  };
  quantity: number;
  unitPrice?: number;
  discountTotal?: number;
  reservedQuantity?: number;
  subtotal?: number;
  taxTotal?: number;
  total?: number;
};

export type PosTotals = {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  baseRequiredPayment: number;
  storeCreditApplied: number;
  requiredPayment: number;
  remainingBalance: number;
  change: number;
  received: number;
};
