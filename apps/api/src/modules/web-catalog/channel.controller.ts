import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ChannelAuthGuard, type ChannelRequest } from './channel-auth.guard';
import { ChannelService } from './channel.service';
import { ChannelAvailabilityDto, ChannelCatalogQueryDto } from './web-catalog.dto';

/** API de lectura para el e-commerce. Autenticación HMAC servidor a servidor; solo contenido publicado. */
@Controller('channel')
@UseGuards(ChannelAuthGuard)
export class ChannelController {
  constructor(private readonly channel: ChannelService) {}

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
}
