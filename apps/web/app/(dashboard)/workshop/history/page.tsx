'use client';

import { WorkshopOrderHistoryView } from '@/components/operations/workshop-order-history-view';
import { SessionRequired, useCurrentSession } from '@/components/operations/session-required';

export default function WorkshopHistoryPage() {
  const session = useCurrentSession();
  if (!session) return <SessionRequired session={session} />;
  return <WorkshopOrderHistoryView session={session} />;
}
