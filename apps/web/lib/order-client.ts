import type { SalesOrder } from './api';

export function getOrderClientLabel(order: Pick<SalesOrder, 'clientName' | 'customer'>) {
  const trimmedName = order.clientName?.trim();

  if (trimmedName) {
    return trimmedName;
  }

  if (order.customer?.name?.trim()) {
    return order.customer.name.trim();
  }

  return 'Cliente no especificado';
}

export function getOrderSearchLabel(
  order: Pick<SalesOrder, 'orderNumber' | 'clientName' | 'customer'>,
) {
  return `${getOrderClientLabel(order)} - ${order.orderNumber}`;
}
