import { BadGatewayException, BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChannelNotifierService } from './channel-notifier.service';
import { publicObjectUrl, putObject, storageConfigFromEnv, validateImageUpload, webImageObjectPath } from './web-image-storage';
import { isPublicImageUrl, readImages, type ImageEntry } from './web-catalog.rules';

export type UploadedImage = { buffer?: Buffer; size?: number; mimetype?: string; originalname?: string };

const MESSAGES: Record<string, string> = {
  FILE_REQUIRED: 'Adjunta un archivo de imagen.',
  FILE_TOO_LARGE: 'La imagen no puede pesar más de 5 MB.',
  UNSUPPORTED_TYPE: 'La imagen debe ser JPG, PNG o WEBP.',
  TYPE_MISMATCH: 'El contenido del archivo no coincide con su tipo declarado.',
};

/** Subida de imágenes del catálogo web a un bucket público de Supabase Storage (escritura solo desde el backend). */
@Injectable()
export class WebCatalogImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: ChannelNotifierService,
  ) {}

  async upload(tenantId: string, userId: string, ref: string, file: UploadedImage | undefined, options: { alt?: string; variantIds?: string[]; primary?: boolean }) {
    const checked = validateImageUpload(file);
    if (!checked.ok) throw new BadRequestException(MESSAGES[checked.reason] ?? checked.reason);
    const storage = storageConfigFromEnv(process.env);
    if (!storage) {
      throw new ServiceUnavailableException('El almacenamiento de imágenes no está configurado (SUPABASE_URL y clave de servicio). Pega una URL pública https mientras tanto.');
    }
    const group = await this.prisma.webProduct.findFirst({ where: { tenantId, OR: [{ legacyEcommerceId: ref }, { id: ref }] } });
    if (!group) throw new NotFoundException('Producto web no encontrado.');
    const images = readImages(group.imageManifest);
    const imageId = `${group.legacyEcommerceId}-I${String(images.length + 1).padStart(2, '0')}`;
    const objectPath = webImageObjectPath({ tenantId, groupId: group.legacyEcommerceId, imageId, sha256: checked.sha256, extension: checked.extension });
    try {
      await putObject(storage, objectPath, (file as UploadedImage).buffer as Buffer, checked.type);
    } catch {
      throw new BadGatewayException('No se pudo guardar la imagen en el almacenamiento.');
    }
    const url = publicObjectUrl(storage, objectPath);
    if (!isPublicImageUrl(url)) throw new ServiceUnavailableException('La URL pública del almacenamiento debe ser https.');
    const entry: ImageEntry = { id: imageId, position: images.length, url, src: null, sha256: checked.sha256, alt: options.alt ?? null, variantIds: options.variantIds ?? [] };
    await this.prisma.webProduct.update({
      where: { id: group.id },
      data: { imageManifest: [...images, entry] as unknown as Prisma.InputJsonValue, ...(options.primary || !group.imageUrl ? { imageUrl: url } : {}) },
    });
    await this.audit.log({ tenantId, userId, action: 'WEB_IMAGE_UPLOADED', entity: 'WebProduct', entityId: group.id, metadata: { imageId, path: objectPath, bytes: (file as UploadedImage).buffer?.length ?? 0 } });
    await this.notifier.notify('catalog.changed', [group.legacyEcommerceId]);
    return { imageId, url, path: objectPath, bucket: storage.bucket, primary: Boolean(options.primary || !group.imageUrl) };
  }
}
