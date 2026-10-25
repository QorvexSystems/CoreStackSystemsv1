import { ProductsView } from '@/components/operations/products-view';
import { Suspense } from 'react';

export default function ProductsPage() {
  return <Suspense fallback={null}><ProductsView /></Suspense>;
}
