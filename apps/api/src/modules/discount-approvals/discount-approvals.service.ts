import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditApprovalStatus,
  Prisma,
  Role,
  SalesOrderDestination,
  SalesOrderStatus,
} from '@qorvex/database';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { PrismaService } from '../../prisma/prisma.service';
import { DecideDiscountApprovalDto } from './dto/discount-approval.dto';

const adminRoles: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN];

const approvalInclude = {
  requestedBy: { select: { id: true, name: true, email: true } },
  decidedBy: { select: { id: true, name: true, email: true } },
  salesOrder: {
    include: {
      customer: true,
      createdBy: { select: { id: true, name: true, email: true } },
      creditApproval: true,
      items: {
        include: { product: true },
        orderBy: { description: 'asc' as const },
      },
    },
  },
} satisfies Prisma.DiscountApprovalInclude;

@Injectable()
export class DiscountApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async notifications(tenantId: string, user: AuthenticatedUser) {
    this.requireAdmin(tenantId, user);
    return this.prisma.discountApproval.findMany({
      where: { tenantId, dismissedAt: null },
      include: approvalInclude,
      orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
      take: 50,
    });
  }

  async approve(
    tenantId: string,
    user: AuthenticatedUser,
    id: string,
    dto: DecideDiscountApprovalDto,
  ) {
    this.requireAdmin(tenantId, user);

    return this.prisma.$transaction(
      async (tx) => {
        await this.lockPendingApproval(tx, tenantId, id);
        const approval = await tx.discountApproval.findFirst({
          where: { id, tenantId, status: CreditApprovalStatus.PENDING },
          include: approvalInclude,
        });
        if (!approval) throw new NotFoundException('Pending discount approval not found.');
        if (approval.salesOrder.status !== SalesOrderStatus.CREATED) {
          throw new BadRequestException('Sales order is not waiting for discount approval.');
        }
        if (!approval.salesOrder.discountRate.eq(approval.requestedRate)) {
          throw new ConflictException('Requested discount no longer matches the sales order.');
        }

        const now = new Date();
        await tx.discountApproval.update({
          where: { id },
          data: {
            status: CreditApprovalStatus.APPROVED,
            decidedById: user.id,
            decidedAt: now,
            decisionNote: dto.note?.trim() || null,
          },
        });

        const waitingForCredit =
          approval.salesOrder.creditApproval?.status === CreditApprovalStatus.PENDING;
        if (
          !waitingForCredit &&
          approval.salesOrder.destination === SalesOrderDestination.QUOTATION
        ) {
          await tx.salesOrder.update({
            where: { id: approval.salesOrderId },
            data: { status: SalesOrderStatus.QUOTATION },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            userId: user.id,
            action: 'CUSTOM_DISCOUNT_APPROVED',
            entity: 'DiscountApproval',
            entityId: id,
            metadata: {
              salesOrderId: approval.salesOrderId,
              orderNumber: approval.salesOrder.orderNumber,
              requestedPercent: approval.requestedRate.mul(100).toString(),
              waitingForCredit,
              awaitingManualSend: approval.salesOrder.destination === SalesOrderDestination.CASH_SALE,
            },
          },
        });

        return tx.discountApproval.findUniqueOrThrow({ where: { id }, include: approvalInclude });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async reject(
    tenantId: string,
    user: AuthenticatedUser,
    id: string,
    dto: DecideDiscountApprovalDto,
  ) {
    this.requireAdmin(tenantId, user);

    return this.prisma.$transaction(
      async (tx) => {
        await this.lockPendingApproval(tx, tenantId, id);
        const approval = await tx.discountApproval.findFirst({
          where: { id, tenantId, status: CreditApprovalStatus.PENDING },
          include: approvalInclude,
        });
        if (!approval) throw new NotFoundException('Pending discount approval not found.');
        if (approval.salesOrder.status !== SalesOrderStatus.CREATED) {
          throw new BadRequestException('Sales order is not waiting for discount approval.');
        }

        const now = new Date();
        await tx.discountApproval.update({
          where: { id },
          data: {
            status: CreditApprovalStatus.REJECTED,
            decidedById: user.id,
            decidedAt: now,
            decisionNote: dto.note?.trim() || null,
          },
        });
        await tx.salesOrder.update({
          where: { id: approval.salesOrderId },
          data: {
            status: SalesOrderStatus.CANCELLED,
            cancelledAt: now,
            cancelReason: dto.note?.trim()
              ? `Descuento rechazado: ${dto.note.trim()}`
              : 'Descuento personalizado rechazado',
          },
        });
        if (approval.salesOrder.creditApproval?.status === CreditApprovalStatus.PENDING) {
          await tx.creditSaleApproval.update({
            where: { id: approval.salesOrder.creditApproval.id },
            data: {
              status: CreditApprovalStatus.CANCELLED,
              cancelledById: user.id,
              cancelledAt: now,
              decisionNote: 'Orden cancelada por rechazo del descuento personalizado',
            },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            userId: user.id,
            action: 'CUSTOM_DISCOUNT_REJECTED',
            entity: 'DiscountApproval',
            entityId: id,
            metadata: {
              salesOrderId: approval.salesOrderId,
              orderNumber: approval.salesOrder.orderNumber,
              requestedPercent: approval.requestedRate.mul(100).toString(),
              reason: dto.note?.trim() || null,
            },
          },
        });

        return tx.discountApproval.findUniqueOrThrow({ where: { id }, include: approvalInclude });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async dismiss(tenantId: string, user: AuthenticatedUser, id: string) {
    this.requireAdmin(tenantId, user);
    const result = await this.prisma.discountApproval.updateMany({
      where: {
        id,
        tenantId,
        dismissedAt: null,
        status: { not: CreditApprovalStatus.PENDING },
      },
      data: { dismissedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new BadRequestException('Only resolved discount notifications can be deleted.');
    }
    return { dismissed: true };
  }

  private async lockPendingApproval(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "DiscountApproval"
      WHERE "id" = ${id}
        AND "tenantId" = ${tenantId}
        AND "status" = CAST(${CreditApprovalStatus.PENDING} AS "CreditApprovalStatus")
      FOR UPDATE
    `;
    if (rows.length !== 1) throw new NotFoundException('Pending discount approval not found.');
  }

  private requireAdmin(tenantId: string, user: AuthenticatedUser) {
    const role =
      user.memberships.find((membership) =>
        ([Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN] as Role[]).includes(membership.role),
      )?.role ?? user.memberships.find((membership) => membership.tenantId === tenantId)?.role;
    if (!role || !adminRoles.includes(role)) {
      throw new ForbiddenException('Administrator approval is required.');
    }
  }
}
