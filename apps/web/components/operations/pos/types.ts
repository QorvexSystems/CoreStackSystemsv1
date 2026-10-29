import type { Product } from '@/lib/api';

export type CartItem = {
  lineId?: string;
  customUnitPrice?: number;
  product: Product;
  quantity: number;
  unitPrice?: number;
  discountTotal?: number;
  reservedQuantity?: number;
  subtotal?: number;
  taxTotal?: number;
  total?: number;
  personalization?: {
    charms?: number;
    children?: number;
    material?: string;
    instructions?: string;
  };
};

export type PosTotals = {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  requiredPayment: number;
  remainingBalance: number;
  change: number;
  received: number;
};
