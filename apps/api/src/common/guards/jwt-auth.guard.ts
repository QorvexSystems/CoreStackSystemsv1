import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserStatus } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest, AuthenticatedUser } from '../types/authenticated-request';

type JwtPayload = {
  sub: string;
  email: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  // Share short lived lookups across modules while allowing role changes to refresh quickly.
  private static readonly userCache = new Map<
    string,
    { expiresAt: number; value: Promise<AuthenticatedUser | null> }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    let payload: JwtPayload;

    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    const user = await this.getUser(payload.sub);

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active.');
    }

    request.user = user;

    return true;
  }

  private async getUser(userId: string) {
    const cached = JwtAuthGuard.userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = this.prisma
      .$queryRaw<AuthenticatedUser[]>(
        Prisma.sql`
      SELECT u.id, u.email, u.name, u.status,
        COALESCE(
          (SELECT jsonb_agg(jsonb_build_object(
             'id', m.id, 'tenantId', m."tenantId", 'role', m.role, 'status', m.status,
             'canUsePos', m."canUsePos",
             'canOpenCashSession', m."canOpenCashSession",
             'canCloseCashSession', m."canCloseCashSession",
             'canApplyDiscount', m."canApplyDiscount",
             'canCancelInvoice', m."canCancelInvoice",
             'canVoidInvoice', m."canVoidInvoice",
             'canAdjustInventory', m."canAdjustInventory",
             'canManageProducts', m."canManageProducts",
             'canManageEmployees', m."canManageEmployees",
             'canViewReports', m."canViewReports",
             'canManageFiscalSequences', m."canManageFiscalSequences",
             'canViewCashLogs', m."canViewCashLogs",
             'canReprintReceipt', m."canReprintReceipt",
             'canTakeOrders', m."canTakeOrders"
           ))
           FROM "Membership" m
           WHERE m."userId" = u.id AND m.status = 'ACTIVE'),
          '[]'::jsonb
        ) AS memberships
      FROM "User" u
      WHERE u.id = ${userId}
    `,
      )
      .then((rows) => rows[0] ?? null);
    JwtAuthGuard.userCache.set(userId, { expiresAt: Date.now() + 5000, value });
    if (JwtAuthGuard.userCache.size > 1000) {
      JwtAuthGuard.userCache.delete(JwtAuthGuard.userCache.keys().next().value!);
    }
    value.catch(() => JwtAuthGuard.userCache.delete(userId));
    return value;
  }

  private extractBearerToken(request: AuthenticatedRequest) {
    const authorization = request.headers.authorization;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;

    if (!header?.startsWith('Bearer ')) {
      return null;
    }

    return header.slice('Bearer '.length);
  }
}
