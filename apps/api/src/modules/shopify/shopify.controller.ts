import { Controller, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@qorvex/database';
import type { Request } from 'express';
import { ShopifyService } from './shopify.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('integrations/shopify/webhooks')
export class ShopifyWebhookController {
  constructor(private readonly shopify: ShopifyService) {}

  @Post('orders-create')
  receiveOrder(
    @Req() request: RawBodyRequest,
    @Headers('x-shopify-hmac-sha256') hmac?: string,
    @Headers('x-shopify-shop-domain') shopDomain?: string,
    @Headers('x-shopify-webhook-id') webhookId?: string,
  ) {
    return this.shopify.receiveOrder(request.rawBody, request.body, {
      hmac,
      shopDomain,
      webhookId,
    });
  }

  @Post('orders-paid')
  receivePaidOrder(
    @Req() request: RawBodyRequest,
    @Headers('x-shopify-hmac-sha256') hmac?: string,
    @Headers('x-shopify-shop-domain') shopDomain?: string,
    @Headers('x-shopify-webhook-id') webhookId?: string,
  ) {
    return this.shopify.receiveOrderPaid(request.rawBody, request.body, {
      hmac,
      shopDomain,
      webhookId,
    });
  }

  @Post('orders-cancelled')
  receiveCancelledOrder(
    @Req() request: RawBodyRequest,
    @Headers('x-shopify-hmac-sha256') hmac?: string,
    @Headers('x-shopify-shop-domain') shopDomain?: string,
    @Headers('x-shopify-webhook-id') webhookId?: string,
  ) {
    return this.shopify.receiveOrderCancelled(request.rawBody, request.body, {
      hmac,
      shopDomain,
      webhookId,
    });
  }

  @Post('orders-updated')
  receiveUpdated(
    @Req() request: RawBodyRequest,
    @Headers('x-shopify-hmac-sha256') hmac?: string,
    @Headers('x-shopify-shop-domain') shopDomain?: string,
    @Headers('x-shopify-webhook-id') webhookId?: string,
  ) {
    return this.shopify.receiveOrderUpdated(request.rawBody, request.body, {
      hmac,
      shopDomain,
      webhookId,
    });
  }

  @Post('refunds-create')
  receiveRefund(
    @Req() request: RawBodyRequest,
    @Headers('x-shopify-hmac-sha256') hmac?: string,
    @Headers('x-shopify-shop-domain') shopDomain?: string,
    @Headers('x-shopify-webhook-id') webhookId?: string,
  ) {
    return this.shopify.receiveRefund(request.rawBody, request.body, {
      hmac,
      shopDomain,
      webhookId,
    });
  }
}

@Controller('integrations/shopify')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
export class ShopifyAdminController {
  constructor(private readonly shopify: ShopifyService) {}

  @Get('status')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  status(@TenantId() tenantId: string) {
    return this.shopify.integrationStatus(tenantId);
  }

  @Post('retry')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  retry(@TenantId() tenantId: string) {
    return this.shopify.processPending(tenantId);
  }

  @Post('products/:id/sync')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  syncProduct(
    @TenantId() tenantId: string,
    @CurrentUser() _user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.shopify.syncProduct(tenantId, id);
  }
}
