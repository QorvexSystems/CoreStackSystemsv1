import { FiscalItemKind, ProductUnit } from '@qorvex/database';

/**
 * Preserve an explicit catalogue/snapshot classification. Products created
 * before fiscalItemKind existed remain usable: SERVICE units are services and
 * every inventory or sale unit is a good.
 */
export const resolveFiscalItemKind = (item: {
  fiscalItemKind?: FiscalItemKind | null;
  unit: ProductUnit;
}) =>
  item.fiscalItemKind ??
  (item.unit === ProductUnit.SERVICE ? FiscalItemKind.SERVICE : FiscalItemKind.GOOD);
