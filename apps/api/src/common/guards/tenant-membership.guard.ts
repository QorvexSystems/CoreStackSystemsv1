import { CanActivate, ConflictException, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../types/authenticated-request';

@Injectable()
export class TenantMembershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & { method: string }>();
    const headerValue = request.headers['x-tenant-id'];
    const tenantId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!tenantId) {
      throw new ForbiddenException('Missing x-tenant-id header.');
    }

    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authenticated user is required.');
    }

    const hasTenantAccess = user.memberships.some(
      (membership) =>
        membership.tenantId === tenantId ||
        membership.role === Role.SUPER_ADMIN ||
        membership.role === Role.QORVEX_SUPER_ADMIN,
    );

    if (!hasTenantAccess) {
      throw new ForbiddenException('User does not belong to this tenant.');
    }

    request.tenantId = tenantId;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, salePricesIncludeTax: true },
      });
      const expectedAllpaVersion = tenant?.salePricesIncludeTax
        ? 'allpa-inclusive-20261031'
        : 'allpa-net-20261030';
      if (tenant?.slug === 'allpa' && request.headers['x-corestack-ui-version'] !== expectedAllpaVersion) {
        throw new ConflictException('ALLPA cambió su política de precios. Actualiza la página antes de continuar.');
      }
    }
    return true;
  }
}
