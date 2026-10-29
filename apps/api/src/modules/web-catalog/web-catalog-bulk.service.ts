import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChannelNotifierService } from './channel-notifier.service';
import { decimalText, publishBlockers, readImages, stableVariantId, type GroupRow, type VariantRow } from './web-catalog.rules';

type Tx = Prisma.TransactionClient;
export const MAX_BULK_IDS = 100;
export const MAX_BULK_PUBLISH = 25;

const VARIANT_SELECT = {
  id: true, sku: true, name: true, price: true, status: true, stock: true, reservedStock: true, trackInventory: true,
  webAvailability: true, webOptions: true, legacyEcommerceVariantId: true, originalSku: true, skuApprovedAt: true, updatedAt: true, webProductId: true,
} as const;

type VariantWithGroup = VariantRow & { originalSku: string | null; webProductId: string | null };

const normalizeSku = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').toUpperCase().slice(0, 80);

export type SkuRuleLabel = 'ORIGINAL' | 'GENERADO_SIN_SKU' | 'NORMALIZADO' | 'DESAMBIGUADO_DUPLICADO';

/** Regla que produjo el SKU actual de una variante importada (deducida de su SKU original). */
export function skuRuleOf(originalSku: string | null, sku: string | null): SkuRuleLabel {
  if (!originalSku) return 'GENERADO_SIN_SKU';
  if (sku === originalSku) return 'ORIGINAL';
  return normalizeSku(originalSku) === sku ? 'NORMALIZADO' : 'DESAMBIGUADO_DUPLICADO';
}

/**
 * Herramientas de preparación masiva del catálogo importado. Principios:
 *  - Solo actúan sobre los grupos que la persona selecciona (máx. 100 IDs por llamada; publicar, máx. 25).
 *  - No cambian precios ni existencias, no inventan stock y no sobrescriben decisiones ya tomadas.
 *  - Cada operación devuelve qué se aplicó y qué se omitió, con el motivo.
 *  - Nada se publica sin pasar por los mismos bloqueos que la publicación individual.
 */
@Injectable()
export class WebCatalogBulkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: ChannelNotifierService,
  ) {}

  private async groupsFor(db: Pick<Tx, 'webProduct'>, tenantId: string, ids: string[]) {
    if (new Set(ids).size > MAX_BULK_IDS) throw new BadRequestException(`Máximo ${MAX_BULK_IDS} productos por operación.`);
    const groups = await db.webProduct.findMany({ where: { tenantId, OR: [{ legacyEcommerceId: { in: ids } }, { id: { in: ids } }] } });
    const found = new Set(groups.flatMap((g) => [g.legacyEcommerceId, g.id]));
    return { groups, missing: ids.filter((id) => !found.has(id)) };
  }

  private variantsOf(db: Pick<Tx, 'product'>, tenantId: string, groupIds: string[]) {
    return db.product.findMany({ where: { tenantId, webProductId: { in: groupIds } }, orderBy: { legacyEcommerceVariantId: 'asc' }, select: VARIANT_SELECT }) as unknown as Promise<VariantWithGroup[]>;
  }

  // ---------- Revisión ----------
  async review(tenantId: string) {
    const groups = await this.prisma.webProduct.findMany({ where: { tenantId } });
    const variants = await this.variantsOf(this.prisma, tenantId, groups.map((g) => g.id));
    const byBlocker: Record<string, number> = {};
    let publishable = 0;
    let published = 0;
    for (const g of groups) {
      if (g.published) published += 1;
      const blockers = publishBlockers(g as GroupRow, variants.filter((v) => v.webProductId === g.id));
      if (blockers.length === 0) publishable += 1;
      for (const code of new Set(blockers.map((b) => b.split(':')[0]))) byBlocker[code] = (byBlocker[code] ?? 0) + 1;
    }
    const imageless = groups.filter((g) => !g.imageUrl && readImages(g.imageManifest).length === 0).length;
    return {
      groups: groups.length,
      published,
      publishable,
      variants: variants.length,
      inactiveVariants: variants.filter((v) => v.status !== 'ACTIVE').length,
      undecidedVariants: variants.filter((v) => !v.webAvailability || v.webAvailability === 'UNDECIDED').length,
      skuPendingApproval: variants.filter((v) => !v.skuApprovedAt).length,
      groupsWithoutCategory: groups.filter((g) => !g.categoryLabel?.trim()).length,
      groupsWithoutImage: imageless,
      groupsWithoutDescription: groups.filter((g) => !g.description?.trim()).length,
      byBlocker,
    };
  }

  /** Propuestas de SKU pendientes de aprobación: SKU original, SKU actual (candidato) y la regla que lo produjo. */
  async skuReview(tenantId: string, options: { cursor?: string; limit?: number; groupIds?: string[] }) {
    const limit = options.limit ?? 100;
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId,
        webProductId: { not: null },
        skuApprovedAt: null,
        ...(options.groupIds?.length ? { webProduct: { is: { legacyEcommerceId: { in: options.groupIds } } } } : {}),
        ...(options.cursor ? { legacyEcommerceVariantId: { gt: options.cursor } } : {}),
      },
      orderBy: { legacyEcommerceVariantId: 'asc' },
      take: limit + 1,
      select: { legacyEcommerceVariantId: true, id: true, sku: true, originalSku: true, name: true, webProduct: { select: { legacyEcommerceId: true, name: true } } },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({ variantId: r.legacyEcommerceVariantId ?? r.id, groupId: r.webProduct?.legacyEcommerceId ?? null, groupName: r.webProduct?.name ?? null, name: r.name, originalSku: r.originalSku, proposedSku: r.sku, rule: skuRuleOf(r.originalSku, r.sku) })),
      nextCursor: rows.length > limit ? (page[page.length - 1].legacyEcommerceVariantId ?? null) : null,
    };
  }

  // ---------- Operaciones masivas ----------
  /** Asigna categoría. Por defecto solo a grupos sin categoría; sobrescribir requiere `overwrite: true` explícito. */
  async assignCategory(tenantId: string, userId: string, ids: string[], categoryLabel: string, overwrite: boolean) {
    const label = categoryLabel.trim();
    if (!label) throw new BadRequestException('La categoría no puede estar vacía.');
    const result = await this.prisma.$transaction(async (tx) => {
      const { groups, missing } = await this.groupsFor(tx, tenantId, ids);
      const applied: string[] = [];
      const skipped: { id: string; reason: string }[] = missing.map((id) => ({ id, reason: 'NOT_FOUND' }));
      for (const g of groups) {
        if (g.categoryLabel?.trim() && !overwrite) { skipped.push({ id: g.legacyEcommerceId, reason: 'ALREADY_HAS_CATEGORY' }); continue; }
        if (g.categoryLabel === label) { skipped.push({ id: g.legacyEcommerceId, reason: 'UNCHANGED' }); continue; }
        await tx.webProduct.update({ where: { id: g.id }, data: { categoryLabel: label } });
        applied.push(g.legacyEcommerceId);
      }
      await this.audit.log({ tenantId, userId, action: 'WEB_BULK_CATEGORY', entity: 'WebProduct', metadata: { category: label, applied: applied.length, skipped: skipped.length, overwrite } });
      return { applied, skipped };
    });
    await this.notifier.notify('catalog.changed', result.applied);
    return result;
  }

  /** Aprueba los SKU actuales (candidatos) de las variantes de los grupos seleccionados. No modifica ningún SKU. */
  async approveSkus(tenantId: string, userId: string, ids: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const { groups, missing } = await this.groupsFor(tx, tenantId, ids);
      const variants = await this.variantsOf(tx, tenantId, groups.map((g) => g.id));
      const pending = variants.filter((v) => !v.skuApprovedAt && v.sku);
      const now = new Date();
      if (pending.length) await tx.product.updateMany({ where: { tenantId, id: { in: pending.map((v) => v.id) } }, data: { skuApprovedAt: now } });
      const noSku = variants.filter((v) => !v.sku).map(stableVariantId);
      await this.audit.log({ tenantId, userId, action: 'WEB_BULK_SKU_APPROVED', entity: 'Product', metadata: { groups: groups.length, approved: pending.length, withoutSku: noSku.length } });
      return { approved: pending.map(stableVariantId), withoutSku: noSku, notFound: missing };
    });
  }

  /** Define la política SOLO en variantes sin decidir. Nunca sobrescribe una decisión y nunca toca existencias. */
  async setAvailability(tenantId: string, userId: string, ids: string[], policy: 'STOCKED' | 'MADE_TO_ORDER') {
    return this.prisma.$transaction(async (tx) => {
      const { groups, missing } = await this.groupsFor(tx, tenantId, ids);
      const variants = await this.variantsOf(tx, tenantId, groups.map((g) => g.id));
      const undecided = variants.filter((v) => !v.webAvailability || v.webAvailability === 'UNDECIDED');
      for (const v of undecided) {
        await tx.product.update({ where: { id: v.id }, data: { webAvailability: policy, ...(policy === 'MADE_TO_ORDER' ? { trackInventory: false } : { trackInventory: true }) } });
      }
      await this.audit.log({ tenantId, userId, action: 'WEB_BULK_AVAILABILITY', entity: 'Product', metadata: { policy, updated: undecided.length, alreadyDecided: variants.length - undecided.length } });
      return { updated: undecided.map(stableVariantId), alreadyDecided: variants.filter((v) => !undecided.includes(v)).map(stableVariantId), notFound: missing };
    });
  }

  /** Activa variantes INACTIVAS con SKU aprobado, política decidida y precio válido. Omite el resto con el motivo. */
  async activateVariants(tenantId: string, userId: string, ids: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const { groups, missing } = await this.groupsFor(tx, tenantId, ids);
      const variants = await this.variantsOf(tx, tenantId, groups.map((g) => g.id));
      const activated: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      for (const v of variants.filter((x) => x.status === 'INACTIVE')) {
        const id = stableVariantId(v);
        if (!v.sku || !v.skuApprovedAt) skipped.push({ id, reason: 'SKU_NOT_APPROVED' });
        else if (!v.webAvailability || v.webAvailability === 'UNDECIDED') skipped.push({ id, reason: 'AVAILABILITY_UNDECIDED' });
        else if (!(Number(decimalText(v.price)) > 0)) skipped.push({ id, reason: 'PRICE_INVALID' });
        else {
          await tx.product.update({ where: { id: v.id }, data: { status: 'ACTIVE' } });
          activated.push(id);
        }
      }
      await this.audit.log({ tenantId, userId, action: 'WEB_BULK_ACTIVATE', entity: 'Product', metadata: { activated: activated.length, skipped: skipped.length } });
      return { activated, skipped, notFound: missing };
    });
  }

  /** Publicación acotada: solo los grupos seleccionados (máx. 25) que cumplan TODOS los requisitos; confirmación explícita. */
  async publish(tenantId: string, userId: string, ids: string[], confirm: boolean) {
    if (confirm !== true) throw new BadRequestException('La publicación masiva exige confirm: true.');
    if (new Set(ids).size > MAX_BULK_PUBLISH) throw new BadRequestException(`Máximo ${MAX_BULK_PUBLISH} productos por publicación masiva.`);
    const result = await this.prisma.$transaction(async (tx) => {
      const { groups, missing } = await this.groupsFor(tx, tenantId, ids);
      const variants = await this.variantsOf(tx, tenantId, groups.map((g) => g.id));
      const published: string[] = [];
      const rejected: { id: string; blockers: string[] }[] = [];
      for (const g of groups) {
        const blockers = publishBlockers(g as GroupRow, variants.filter((v) => v.webProductId === g.id));
        if (blockers.length) { rejected.push({ id: g.legacyEcommerceId, blockers }); continue; }
        await tx.webProduct.update({ where: { id: g.id }, data: { published: true, publishedAt: new Date(), publicationIntent: 'active' } });
        published.push(g.legacyEcommerceId);
      }
      await this.audit.log({ tenantId, userId, action: 'WEB_BULK_PUBLISH', entity: 'WebProduct', metadata: { published: published.length, rejected: rejected.length } });
      return { published, rejected, notFound: missing };
    });
    await this.notifier.notify('catalog.changed', result.published);
    return result;
  }
}

