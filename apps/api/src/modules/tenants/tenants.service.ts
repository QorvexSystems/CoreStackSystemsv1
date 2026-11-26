import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@qorvex/database';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForUser(user: AuthenticatedUser) {
    const isSuperAdmin = user.memberships.some(
      (membership) => membership.role === Role.QORVEX_SUPER_ADMIN,
    );
    const tenantIds = user.memberships.map((membership) => membership.tenantId);

    return this.prisma.tenant.findMany({
      where: isSuperAdmin
        ? undefined
        : {
            id: {
              in: tenantIds,
            },
          },
      include: {
        branding: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOneForUser(user: AuthenticatedUser, id: string) {
    const isSuperAdmin = user.memberships.some(
      (membership) => membership.role === Role.QORVEX_SUPER_ADMIN,
    );
    const hasMembership = user.memberships.some((membership) => membership.tenantId === id);

    if (!isSuperAdmin && !hasMembership) {
      throw new ForbiddenException('User does not belong to this tenant.');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        branding: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found.');
    }

    return tenant;
  }
}
