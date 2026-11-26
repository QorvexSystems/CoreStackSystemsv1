import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ChannelAuthGuard, type ChannelRequest } from '../web-catalog/channel-auth.guard';
import { HotelChannelService } from './hotel-channel.service';
import {
  ChannelHotelCalendarQueryDto,
  ChannelHotelReservationDto,
  ChannelHotelStayQueryDto,
} from './hotel.dto';

/**
 * API del sitio web del hotel. Misma autenticación HMAC servidor a servidor que el resto de /channel/*:
 * el tenant sale de la credencial y el secreto vive solo en el servidor del sitio, nunca en el navegador.
 */
@Controller('channel/hotel')
@UseGuards(ChannelAuthGuard)
export class HotelChannelController {
  constructor(private readonly service: HotelChannelService) {}

  @Get('catalog')
  catalog(@Req() request: ChannelRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.service.catalog(request.channelTenantId as string);
  }

  @Get('availability')
  availability(
    @Req() request: ChannelRequest,
    @Res({ passthrough: true }) response: Response,
    @Query() query: ChannelHotelStayQueryDto,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.service.availability(request.channelTenantId as string, query);
  }

  @Get('calendar')
  calendar(
    @Req() request: ChannelRequest,
    @Res({ passthrough: true }) response: Response,
    @Query() query: ChannelHotelCalendarQueryDto,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.service.calendar(request.channelTenantId as string, query);
  }

  @Post('reservations')
  async createReservation(
    @Req() request: ChannelRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: ChannelHotelReservationDto,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    const result = await this.service.createReservation(request.channelTenantId as string, body);
    response.status(result.duplicate ? 200 : 201);
    return result;
  }
}
