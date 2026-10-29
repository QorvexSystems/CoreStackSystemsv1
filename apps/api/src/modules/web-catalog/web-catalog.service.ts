import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@qorvex/database';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChannelNotifierService } from './channel-notifier.service';
import {
  CreateWebProductDto,
  ListWebProductsQueryDto,
  NewImageDto,
  OptionDefinitionDto,
  OptionValueDto,
  UpdateWebProductDto,
  UpdateWebVariantDto,
  WebVariantDto,
} from './web-catalog.dto';
import {
  computeAvailability,
  declaredOptions,
  decimalText,
  isPublicImageUrl,
  isValidSlug,
  publishBlockers,
  readImages,
  slugify,
  stableVariantId,
  type GroupRow,
  type ImageEntry,
  type VariantRow,
} from './web-catalog.rules';

type Tx = Prisma.TransactionClient;

/** Misma regla que normalizeCodeSegment de ProductsService. */
function normalizeSku(value: string) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toUpperCase()
    .slice(0, 80);
}

/**
 * Administración del catálogo web. Escribe directamente WebProduct y Product (sin pasar por ProductsService,
 * que sincroniza con Shopify). Nunca toca existencias, reservas, movimientos ni InventorySyncJob: el inventario
 * sigue administrándose con los flujos actuales del ERP. Invariante: un grupo publicado siempre es publicable.
 */
@Injectable()
export class WebCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: ChannelNotifierService,
  ) {}

  // ---------- Lectura ----------
  async list(tenantId: string, query: ListWebProductsQueryDto) {
    const limit = query.limit ?? 50;
    const groups = await this.prisma.webProduct.findMany({
      where: {
        tenantId,
        ...(query.published ? { published: query.published === 'true' } : {}),
        ...(query.category ? { categoryLabel: query.category } : {}),
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { slug: { contains: query.q, mode: 'insensitive' } }, { legacyEcommerceId: { contains: query.q, mode: 'insensitive' } }, { products: { some: { sku: { contains: query.q, mode: 'insensitive' } } } }] } : {}),
        ...(query.cursor ? { legacyEcommerceId: { gt: query.cursor } } : {}),
      },
      orderBy: { legacyEcommerceId: 'asc' },
      take: query.blocker ? 1000 : limit + 1,
    });
    // Con filtro por bloqueo se evalúan todos los grupos del tenant (hasta 1000) y luego se pagina el resultado.
    const page = query.blocker ? groups : groups.slice(0, limit);
    const variants = page.length
      ? await this.prisma.product.findMany({
          where: { tenantId, webProductId: { in: page.map((g) => g.id) } },
          select: { id: true, sku: true, name: true, price: true, status: true, stock: true, reservedStock: true, trackInventory: true, webAvailability: true, webOptions: true, legacyEcommerceVariantId: true, updatedAt: true, webProductId: true, skuApprovedAt: true },
        })
      : [];
    const items = page.map((group) => {
      const own = variants.filter((v) => v.webProductId === group.id) as unknown as VariantRow[];
      const active = own.filter((v) => v.status === 'ACTIVE');
      const prices = active.map((v) => Number(decimalText(v.price)));
      const blockers = publishBlockers(group as GroupRow, own);
      const states = active.map((v) => v.webAvailability);
      const first = readImages(group.imageManifest)[0];
      return {
        id: group.legacyEcommerceId,
        internalId: group.id,
        slug: group.slug,
        name: group.name,
        categoryLabel: group.categoryLabel,
        published: group.published,
        publishedAt: group.publishedAt,
        updatedAt: group.updatedAt,
        primaryImage: group.imageUrl ?? first?.url ?? first?.src ?? null,
        variantCount: own.length,
        activeVariantCount: active.length,
        priceMin: prices.length ? Math.min(...prices).toFixed(2) : null,
        priceMax: prices.length ? Math.max(...prices).toFixed(2) : null,
        availability: {
          stocked: states.filter((s) => s === 'STOCKED').length,
          madeToOrder: states.filter((s) => s === 'MADE_TO_ORDER').length,
          undecided: states.filter((s) => s === null || s === 'UNDECIDED').length,
        },
        availableUnits: active.filter((v) => v.webAvailability === 'STOCKED').reduce((sum, v) => sum + Math.max(0, v.stock - v.reservedStock), 0),
        publishable: blockers.length === 0,
        blockers,
        // Estado de preparación sobre TODAS las variantes (activas o no): los bloqueos solo miran las activas.
        preparation: {
          inactive: own.filter((v) => v.status !== 'ACTIVE').length,
          undecided: own.filter((v) => !v.webAvailability || v.webAvailability === 'UNDECIDED').length,
          skuPending: own.filter((v) => !v.skuApprovedAt).length,
        },
      };
    });
    if (query.blocker) {
      const code = query.blocker;
      // Códigos virtuales de preparación (cualquier variante); el resto filtra por código de bloqueo de publicación.
      const virtual: Record<string, (i: (typeof items)[number]) => boolean> = {
        ANY_VARIANT_INACTIVE: (i) => i.preparation.inactive > 0,
        ANY_VARIANT_UNDECIDED: (i) => i.preparation.undecided > 0,
        ANY_VARIANT_SKU_PENDING: (i) => i.preparation.skuPending > 0,
      };
      const matching = items.filter((i) => (virtual[code] ? virtual[code](i) : code === 'NONE' ? i.blockers.length === 0 : i.blockers.some((b) => b.startsWith(code))));
      const slice = matching.slice(0, limit);
      return { items: slice, nextCursor: matching.length > limit ? slice[slice.length - 1].id : null };
    }
    return { items, nextCursor: groups.length > limit ? page[page.length - 1].legacyEcommerceId : null };
  }

  async categories(tenantId: string) {
    const rows = await this.prisma.webProduct.groupBy({ by: ['categoryLabel'], where: { tenantId }, _count: { _all: true }, orderBy: { categoryLabel: 'asc' } });
    return rows.map((r) => ({ name: r.categoryLabel, count: r._count._all }));
  }

  async get(tenantId: string, ref: string) {
    const group = await this.findGroup(this.prisma, tenantId, ref);
    const variants = await this.variantsOf(this.prisma, tenantId, group.id);
    return this.detail(group, variants);
  }

  private detail(group: GroupRow, variants: VariantRow[]) {
    const blockers = publishBlockers(group, variants);
    return {
      id: group.legacyEcommerceId,
      internalId: group.id,
      slug: group.slug,
      name: group.name,
      description: group.description,
      categoryLabel: group.categoryLabel,
      options: declaredOptions(group.options),
      imageUrl: group.imageUrl,
      images: readImages(group.imageManifest),
      published: group.published,
      publishedAt: group.publishedAt,
      publishable: blockers.length === 0,
      blockers,
      variants: variants.map((v) => ({
        id: stableVariantId(v),
        internalId: v.id,
        sku: v.sku,
        name: v.name,
        price: decimalText(v.price),
        status: v.status,
        trackInventory: v.trackInventory,
        webAvailability: v.webAvailability,
        // Consulta del inventario existente (solo del propio tenant); el canal público expone únicamente el estado.
        commercialAvailability: computeAvailability(v),
        availableUnits: v.stock - v.reservedStock,
        webOptions: v.webOptions,
      })),
    };
  }

  // ---------- Escritura ----------
  async create(tenantId: string, userId: string, dto: CreateWebProductDto) {
    const slug = dto.slug ?? slugify(dto.name);
    if (!isValidSlug(slug)) throw new BadRequestException('No se pudo derivar un slug válido; indícalo explícitamente.');
    this.assertImageUrl(dto.imageUrl);
    this.assertOptionDefinitions(dto.options);
    this.assertVariantsConsistent(dto.options, dto.variants);

    const commercialId = `UP-W-${randomBytes(4).toString('hex')}`;
    const created = await this.write(async (tx) => {
      const images = this.buildImages([], dto.images ?? [], commercialId);
      const group = await tx.webProduct.create({
        data: {
          tenantId,
          legacyEcommerceId: commercialId,
          slug,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          categoryLabel: dto.categoryLabel?.trim() || null,
          imageUrl: dto.imageUrl ?? null,
          options: dto.options as unknown as Prisma.InputJsonValue,
          imageManifest: images as unknown as Prisma.InputJsonValue,
          publicationIntent: 'draft',
          published: false,
        },
      });
      for (const [index, variant] of dto.variants.entries()) {
        await tx.product.create({ data: this.variantData(tenantId, group.id, group.name, commercialId, index + 1, variant) });
      }
      await this.audit.log({ tenantId, userId, action: 'WEB_PRODUCT_CREATED', entity: 'WebProduct', entityId: group.id, metadata: { id: commercialId, variants: dto.variants.length } });
      return group;
    });
    await this.notifier.notify('catalog.changed', [commercialId]);
    return this.get(tenantId, created.id);
  }

  async update(tenantId: string, userId: string, ref: string, dto: UpdateWebProductDto) {
    this.assertImageUrl(dto.imageUrl);
    if (dto.options) this.assertOptionDefinitions(dto.options);
    const id = await this.write(async (tx) => {
      const group = await this.findGroup(tx, tenantId, ref);
      const variants = await this.variantsOf(tx, tenantId, group.id);
      if (dto.options) this.assertVariantsStillDeclared(dto.options, variants);
      const manifest = dto.addImages ? this.buildImages(readImages(group.imageManifest), dto.addImages, group.legacyEcommerceId) : undefined;
      await tx.webProduct.update({
        where: { id: group.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
          ...(dto.categoryLabel !== undefined ? { categoryLabel: dto.categoryLabel.trim() || null } : {}),
          ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
          ...(dto.options ? { options: dto.options as unknown as Prisma.InputJsonValue } : {}),
          ...(manifest ? { imageManifest: manifest as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      await this.assertInvariant(tx, tenantId, group.id);
      await this.audit.log({ tenantId, userId, action: 'WEB_PRODUCT_UPDATED', entity: 'WebProduct', entityId: group.id, metadata: { fields: Object.keys(dto) } });
      return group.id;
    });
    await this.notifier.notify('catalog.changed', [await this.commercialId(tenantId, id)]);
    return this.get(tenantId, id);
  }

  async addVariant(tenantId: string, userId: string, ref: string, dto: WebVariantDto) {
    const id = await this.write(async (tx) => {
      const group = await this.findGroup(tx, tenantId, ref);
      const variants = await this.variantsOf(tx, tenantId, group.id);
      this.assertVariantsConsistent(declaredOptions(group.options), [dto], variants);
      const next = variants.length + 1;
      const created = await tx.product.create({ data: this.variantData(tenantId, group.id, group.name, group.legacyEcommerceId, next, dto) });
      await this.assertInvariant(tx, tenantId, group.id);
      await this.audit.log({ tenantId, userId, action: 'WEB_VARIANT_ADDED', entity: 'Product', entityId: created.id, metadata: { group: group.legacyEcommerceId } });
      return group.id;
    });
    await this.notifier.notify('catalog.changed', [await this.commercialId(tenantId, id)]);
    return this.get(tenantId, id);
  }

  async updateVariant(tenantId: string, userId: string, ref: string, variantRef: string, dto: UpdateWebVariantDto) {
    const id = await this.write(async (tx) => {
      const group = await this.findGroup(tx, tenantId, ref);
      const variants = await this.variantsOf(tx, tenantId, group.id);
      const current = variants.find((v) => stableVariantId(v) === variantRef || v.id === variantRef);
      if (!current) throw new NotFoundException('Variante no encontrada en este producto.');
      if (dto.options) this.assertVariantsConsistent(declaredOptions(group.options), [{ ...dto, options: dto.options } as WebVariantDto], variants.filter((v) => v.id !== current.id));
      const meta = { ...((current.webOptions ?? {}) as Record<string, unknown>) };
      if (dto.title !== undefined) meta.title = dto.title;
      if (dto.options) meta.options = dto.options;
      if (dto.compareAtPrice !== undefined) meta.compareAtPrice = dto.compareAtPrice === null ? null : dto.compareAtPrice.toFixed(2);
      const title = typeof meta.title === 'string' ? meta.title : current.name;
      await tx.product.update({
        where: { id: current.id },
        data: {
          ...(dto.sku !== undefined ? { sku: this.requireSku(dto.sku), skuApprovedAt: new Date() } : {}),
          ...(dto.price !== undefined ? { price: dto.price.toFixed(2) } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.webAvailability !== undefined ? { webAvailability: dto.webAvailability } : {}),
          ...(dto.trackInventory !== undefined ? { trackInventory: dto.trackInventory } : {}),
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.title !== undefined ? { name: `${group.name} - ${title}` } : {}),
          webOptions: meta as Prisma.InputJsonValue,
        },
      });
      await this.assertInvariant(tx, tenantId, group.id);
      await this.audit.log({ tenantId, userId, action: 'WEB_VARIANT_UPDATED', entity: 'Product', entityId: current.id, metadata: { fields: Object.keys(dto), group: group.legacyEcommerceId } });
      return group.id;
    });
    await this.notifier.notify('catalog.changed', [await this.commercialId(tenantId, id)]);
    return this.get(tenantId, id);
  }

  async publish(tenantId: string, userId: string, ref: string) {
    const id = await this.write(async (tx) => {
      const group = await this.findGroup(tx, tenantId, ref);
      const variants = await this.variantsOf(tx, tenantId, group.id);
      const blockers = publishBlockers(group, variants);
      if (blockers.length) throw new ConflictException(['El producto no cumple los requisitos mínimos para publicarse.', ...blockers.map((code) => `BLOCKER:${code}`)]);
      await tx.webProduct.update({ where: { id: group.id }, data: { published: true, publishedAt: new Date(), publicationIntent: 'active' } });
      await this.audit.log({ tenantId, userId, action: 'WEB_PRODUCT_PUBLISHED', entity: 'WebProduct', entityId: group.id, metadata: { id: group.legacyEcommerceId } });
      return group.id;
    });
    await this.notifier.notify('catalog.changed', [await this.commercialId(tenantId, id)]);
    return this.get(tenantId, id);
  }

  async unpublish(tenantId: string, userId: string, ref: string) {
    const id = await this.write(async (tx) => {
      const group = await this.findGroup(tx, tenantId, ref);
      await tx.webProduct.update({ where: { id: group.id }, data: { published: false, publicationIntent: 'draft' } });
      await this.audit.log({ tenantId, userId, action: 'WEB_PRODUCT_UNPUBLISHED', entity: 'WebProduct', entityId: group.id, metadata: { id: group.legacyEcommerceId } });
      return group.id;
    });
    await this.notifier.notify('catalog.changed', [await this.commercialId(tenantId, id)]);
    return this.get(tenantId, id);
  }

  // ---------- Auxiliares ----------
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? (error.meta?.target as string[]).join(', ') : String(error.meta?.target ?? '');
        throw new ConflictException(`Valor duplicado (${target}): SKU, slug o ID ya existen en este tenant.`);
      }
      throw error;
    }
  }

  private async findGroup(db: Pick<Tx, 'webProduct'>, tenantId: string, ref: string): Promise<GroupRow> {
    const group = await db.webProduct.findFirst({ where: { tenantId, OR: [{ legacyEcommerceId: ref }, { id: ref }, { slug: ref }] } });
    if (!group) throw new NotFoundException('Producto web no encontrado.');
    return group as GroupRow;
  }

  private async commercialId(tenantId: string, internalId: string) {
    return (await this.prisma.webProduct.findFirstOrThrow({ where: { tenantId, id: internalId }, select: { legacyEcommerceId: true } })).legacyEcommerceId;
  }

  private async variantsOf(db: Pick<Tx, 'product'>, tenantId: string, groupId: string): Promise<VariantRow[]> {
    const rows = await db.product.findMany({
      where: { tenantId, webProductId: groupId },
      orderBy: { legacyEcommerceVariantId: 'asc' },
      select: { id: true, sku: true, name: true, price: true, status: true, stock: true, reservedStock: true, trackInventory: true, webAvailability: true, webOptions: true, legacyEcommerceVariantId: true, skuApprovedAt: true, updatedAt: true },
    });
    return rows as unknown as VariantRow[];
  }

  /** Un grupo publicado debe seguir cumpliendo los requisitos tras cualquier cambio; si no, se rechaza el cambio completo. */
  private async assertInvariant(tx: Tx, tenantId: string, groupId: string) {
    const group = await tx.webProduct.findFirstOrThrow({ where: { tenantId, id: groupId } });
    if (!group.published) return;
    const blockers = publishBlockers(group as GroupRow, await this.variantsOf(tx, tenantId, groupId));
    if (blockers.length) {
      throw new ConflictException(['El cambio dejaría un producto publicado sin los requisitos mínimos. Despublícalo primero.', ...blockers.map((code) => `BLOCKER:${code}`)]);
    }
  }

  private variantData(tenantId: string, groupId: string, groupName: string, commercialId: string, index: number, dto: WebVariantDto): Prisma.ProductUncheckedCreateInput {
    const policy = dto.webAvailability ?? 'UNDECIDED';
    return {
      tenantId,
      webProductId: groupId,
      name: `${groupName} - ${dto.title}`.slice(0, 160),
      sku: this.requireSku(dto.sku),
      skuApprovedAt: new Date(), // un SKU escrito por una persona en el ERP queda aprobado
      price: dto.price.toFixed(2),
      kind: dto.kind ?? 'STANDARD',
      // Las existencias NO se fijan aquí: nacen en 0 y las gestionan los flujos de inventario del ERP.
      stock: 0,
      reservedStock: 0,
      trackInventory: dto.trackInventory ?? policy !== 'MADE_TO_ORDER',
      status: 'ACTIVE',
      webAvailability: policy,
      legacyEcommerceVariantId: `${commercialId}-V${String(index).padStart(2, '0')}`,
      webOptions: { title: dto.title, options: dto.options, compareAtPrice: dto.compareAtPrice === undefined ? null : dto.compareAtPrice.toFixed(2), primaryImageId: null } as unknown as Prisma.InputJsonValue,
    };
  }

  private requireSku(value: string) {
    const sku = normalizeSku(value);
    if (!sku) throw new BadRequestException('El SKU no es válido.');
    return sku;
  }

  private assertImageUrl(url: string | undefined) {
    if (url !== undefined && !isPublicImageUrl(url)) throw new BadRequestException('La imagen debe ser una URL pública https autorizada.');
  }

  private buildImages(existing: ImageEntry[], added: NewImageDto[], commercialId: string): ImageEntry[] {
    const result = [...existing];
    for (const image of added) {
      if (!isPublicImageUrl(image.url)) throw new BadRequestException('Cada imagen debe ser una URL pública https autorizada.');
      const position = result.length;
      result.push({ id: `${commercialId}-I${String(position + 1).padStart(2, '0')}`, position, url: image.url, src: null, alt: image.alt ?? null, variantIds: image.variantIds ?? [] });
    }
    return result;
  }

  private assertOptionDefinitions(options: OptionDefinitionDto[]) {
    const names = new Set<string>();
    for (const option of options) {
      if (names.has(option.name)) throw new BadRequestException(`Opción repetida: ${option.name}`);
      names.add(option.name);
      if (new Set(option.values).size !== option.values.length) throw new BadRequestException(`Valores repetidos en la opción ${option.name}`);
    }
  }

  private assertVariantsConsistent(declared: { name: string; values: string[] }[], incoming: { sku?: string; options?: OptionValueDto[] }[], existing: VariantRow[] = []) {
    const combos = new Set(existing.map((v) => JSON.stringify(this.comboOf(v.webOptions))));
    const skus = new Set(existing.map((v) => v.sku));
    for (const variant of incoming) {
      for (const o of variant.options ?? []) {
        if (!declared.some((d) => d.name === o.name && d.values.includes(o.value))) {
          throw new BadRequestException(`La opción ${o.name}=${o.value} no está declarada en el producto.`);
        }
      }
      const combo = JSON.stringify((variant.options ?? []).map((o) => [o.name, o.value]).sort());
      if (variant.options && combos.has(combo)) throw new BadRequestException('Dos variantes no pueden tener la misma combinación de opciones.');
      combos.add(combo);
      if (variant.sku) {
        const sku = normalizeSku(variant.sku);
        if (skus.has(sku)) throw new BadRequestException(`SKU repetido dentro del producto: ${sku}`);
        skus.add(sku);
      }
    }
  }

  private assertVariantsStillDeclared(options: OptionDefinitionDto[], variants: VariantRow[]) {
    for (const v of variants) {
      for (const [name, value] of this.comboOf(v.webOptions)) {
        if (!options.some((d) => d.name === name && d.values.includes(value))) {
          throw new BadRequestException(`No se puede quitar ${name}=${value}: lo usa la variante ${stableVariantId(v)}.`);
        }
      }
    }
  }

  private comboOf(webOptions: unknown): [string, string][] {
    const options = (webOptions as { options?: { name: string; value: string }[] } | null)?.options ?? [];
    return options.map((o) => [o.name, o.value] as [string, string]).sort();
  }
}
