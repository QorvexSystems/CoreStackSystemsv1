import { brand } from '@/lib/brand';

export function CompanyDocumentDetails() {
  return (
    <div className="company-document-details mt-1 max-w-lg space-y-0.5 text-xs leading-relaxed text-zinc-600">
      <p>
        RNC: {brand.rnc} · Tel.: {brand.phone}
      </p>
      <p>{brand.address}</p>
    </div>
  );
}
