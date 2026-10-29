import type { QueryClient } from '@tanstack/react-query';
import type { Invoice, SalesOrder } from '@/lib/api';

/** Called only after the server confirms the committed sale. No refetch delays printing. */
export function prepareInvoicePrint(
  queryClient: QueryClient,
  invoice: Invoice,
  orderId?: string,
) {
  const tenantId = invoice.tenantId;
  const affectedQueries = [
    'invoices', 'sales-orders', 'dashboard-summary', 'products', 'pos-products-search',
    'inventory-movements', 'cash-movements', 'employee-logs', 'cash-session-current',
    'cash-sessions', 'production-kanban', 'receivables', 'pos-customers',
  ];
  for (const key of affectedQueries) {
    // Cancel old responses too, so they cannot restore pre-sale balances after invalidation.
    void queryClient.cancelQueries({ queryKey: [key, tenantId] });
    void queryClient.invalidateQueries({ queryKey: [key, tenantId], refetchType: 'none' });
  }
  if (orderId) {
    queryClient.setQueriesData<SalesOrder[]>(
      { queryKey: ['sales-orders', tenantId, 'OPEN'] },
      (orders) => orders?.filter((order) => order.id !== orderId),
    );
    // setQueriesData marks data fresh; keep the remainder stale for the return to Caja.
    void queryClient.invalidateQueries({ queryKey: ['sales-orders', tenantId, 'OPEN'], refetchType: 'none' });
  }
  // Older API versions may omit issuer details. In that case let the print page fetch them.
  if (invoice.tenant) {
    void queryClient.cancelQueries({ queryKey: ['invoice', invoice.id, tenantId], exact: true });
    queryClient.setQueryData(['invoice', invoice.id, tenantId], invoice);
  }
}
