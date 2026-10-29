import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ChannelAuthGuard, type ChannelRequest } from './channel-auth.guard';
import { ChannelOrdersService } from './channel-orders.service';
import { ChannelService } from './channel.service';
import { ChannelAvailabilityDto, ChannelCatalogQueryDto, ChannelCreateOrderDto } from './web-catalog.dto';

/** API de lectura para el e-commerce. Autenticación HMAC servidor a servidor; solo contenido publicado. */
@Controller('channel')
@UseGuards(ChannelAuthGuard)
export class ChannelController {
  constructor(
    private readonly channel: ChannelService,
    private readonly channelOrders: ChannelOrdersService,
  ) {}

  @Get('catalog')
  catalog(@Req() request: ChannelRequest, @Res({ passthrough: true }) response: Response, @Query() query: ChannelCatalogQueryDto) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.channel.catalog(request.channelTenantId as string, query);
  }

  @Post('availability')
  @HttpCode(200)
  availability(@Req() request: ChannelRequest, @Res({ passthrough: true }) response: Response, @Body() body: ChannelAvailabilityDto) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.channel.availability(request.channelTenantId as string, body.items);
  }

  /** Solicitud de pedido del e-commerce: queda en Caja y en el tablero de seguimiento. 201 al crear, 200 si ya existía. */
  @Post('orders')
  async createOrder(
    @Req() request: ChannelRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: ChannelCreateOrderDto,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    const result = await this.channelOrders.create(request.channelTenantId as string, body);
    response.status(result.duplicate ? 200 : 201);
    return result;
  }
}
